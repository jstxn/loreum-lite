import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { configInventory, existingRoots, readBounded } from "./files.mjs";

const exec = promisify(execFile);
export const stringValue = (value) => {
  const literal = value.match(/^\s*('([^']*)'|"(?:\\.|[^"\\])*")/);
  if (!literal) return null;
  try {
    return literal[2] ?? JSON.parse(literal[1]);
  } catch {
    return null;
  }
};

export async function projectChain(project) {
  if (!project) return [];
  const chain = [];
  for (let path = project; ; path = dirname(path)) {
    chain.unshift(path);
    try {
      await stat(join(path, ".git"));
      return chain;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname(path) === path) return [project];
  }
}

// Read only discovery settings and explicit enablement, never connection secrets.
export function discoverySettings(text, path) {
  const settings = { entries: configInventory(text, path), skills: [] };
  let section = "";
  let skill;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      section = line.trim();
      skill = null;
      if (/^\[\[skills\.config\]\]/.test(section)) {
        skill = {};
        settings.skills.push(skill);
      }
      continue;
    }
    if (skill) {
      const value = line.match(/^\s*path\s*=\s*(.*)$/);
      if (value) skill.path = stringValue(value[1]);
      const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
      if (enabled) skill.enabled = enabled[1] === "true";
    }
    if (!section) {
      const size = line.match(
        /^\s*project_doc_max_bytes\s*=\s*(\d+)\s*(?:#.*)?$/,
      );
      if (size) settings.maxBytes = Number(size[1]);
    }
  }
  const top = text.split(/^\s*\[/m)[0];
  const fallback = top.match(
    /project_doc_fallback_filenames\s*=\s*\[([\s\S]*?)\]/,
  );
  if (fallback) {
    settings.fallbacks = [
      ...fallback[1].matchAll(/'(?:[^']*)'|"(?:\\.|[^"\\])*"/g),
    ]
      .map((match) => stringValue(match[0]))
      .filter(
        (name) => name && basename(name) === name && !name.includes("\\"),
      );
  }
  return settings;
}

export async function configuration(codexHome, directories, issues) {
  const entries = new Map();
  const skills = new Map();
  let fallbacks = [];
  let maxBytes = 32 * 1024;
  for (const path of [
    join(codexHome, "config.toml"),
    ...directories.map((directory) => join(directory, ".codex", "config.toml")),
  ]) {
    try {
      const roots = await existingRoots([dirname(path)]);
      const data = await readBounded(path, roots);
      const settings = discoverySettings(data.text, path);
      for (const entry of settings.entries) {
        const key = `${entry.kind}:${entry.name}`;
        const enabled = entry.enabled ?? entries.get(key)?.enabled ?? null;
        entries.set(key, {
          ...entry,
          enabled,
          state:
            enabled === false
              ? "disabled"
              : enabled === true
                ? "enabled"
                : "availability unknown",
          origin:
            path === join(codexHome, "config.toml") ? "Personal" : "Project",
        });
      }
      for (const skill of settings.skills) {
        if (
          skill.path &&
          isAbsolute(skill.path) &&
          typeof skill.enabled === "boolean"
        )
          skills.set(
            await realpath(skill.path).catch(() => resolve(skill.path)),
            skill.enabled,
          );
      }
      fallbacks = settings.fallbacks ?? fallbacks;
      maxBytes = settings.maxBytes ?? maxBytes;
      if (data.truncated)
        issues.push("A configuration inventory was truncated.");
    } catch (error) {
      if (error.code !== "ENOENT")
        issues.push("A configuration inventory could not be read.");
    }
  }
  return { entries: [...entries.values()], skills, fallbacks, maxBytes };
}

export async function installedPlugins(home, codexHome, project) {
  // Never query the real user's CLI profile from an isolated/custom fixture home.
  if (
    resolve(home) !== resolve(homedir()) ||
    resolve(codexHome) !==
      resolve(process.env.CODEX_HOME || join(homedir(), ".codex"))
  )
    return null;
  try {
    const { stdout } = await exec("codex", ["plugin", "list", "--json"], {
      cwd: project || home,
      timeout: 4000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const data = JSON.parse(stdout);
    return Array.isArray(data.installed) ? data.installed : null;
  } catch {
    return null;
  }
}

export async function pluginSources(plugins, codexHome, configEntries) {
  const sources = [];
  for (const plugin of plugins || []) {
    if (
      !plugin.installed ||
      !/^[a-zA-Z0-9][\w.-]*$/.test(plugin.name || "") ||
      !/^[a-zA-Z0-9][\w.-]*$/.test(plugin.marketplaceName || "") ||
      !/^[a-zA-Z0-9][\w.+-]*$/.test(plugin.version || "")
    )
      continue;
    const id = `${plugin.name}@${plugin.marketplaceName}`;
    const cache = join(
      codexHome,
      "plugins",
      "cache",
      plugin.marketplaceName,
      plugin.name,
      plugin.version,
    );
    const roots = await existingRoots([cache]);
    if (
      !roots.length &&
      plugin.source?.source === "local" &&
      isAbsolute(plugin.source.path || "")
    )
      roots.push(...(await existingRoots([plugin.source.path])));
    const configured = configEntries.find(
      (entry) => entry.kind === "plugin" && entry.name === id,
    );
    sources.push({
      name: id,
      version: plugin.version,
      roots,
      enabled:
        typeof plugin.enabled === "boolean"
          ? plugin.enabled
          : (configured?.enabled ?? null),
      origin: ["openai-bundled", "openai-primary-runtime"].includes(
        plugin.marketplaceName,
      )
        ? "Built-in"
        : "Plugin",
    });
  }
  return sources;
}
