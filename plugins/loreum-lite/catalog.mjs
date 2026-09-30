import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  configuration,
  installedPlugins,
  pluginSources,
  projectChain,
} from "./codex.mjs";
import {
  canonical,
  existingRoots,
  fileId,
  label,
  PAGE_CHARS,
  readBounded,
  redact,
  sourceRecord,
  walk,
} from "./files.mjs";
import { hookInventory } from "./hooks.mjs";
import { sessionInventory } from "./sessions.mjs";

export function createCatalog({
  home = process.env.LOREUM_LITE_HOME || homedir(),
  project = null,
  codexHome = process.env.LOREUM_LITE_CODEX_HOME ||
    process.env.CODEX_HOME ||
    join(home, ".codex"),
  plugins,
} = {}) {
  let selectedProject = project ? resolve(project) : null;
  const sessionCache = new Map();
  const sources = new Map();
  let snapshot = null;
  let pending = null;

  async function collect() {
    const issues = [];
    if (selectedProject) {
      try {
        if (!(await stat(selectedProject)).isDirectory()) throw new Error();
        selectedProject = await realpath(selectedProject);
      } catch {
        issues.push(
          "The selected project is unavailable. Choose another folder or return to personal context.",
        );
      }
    }
    const directories = await projectChain(selectedProject);
    const config = await configuration(codexHome, directories, issues);
    const inventory =
      plugins === undefined
        ? await installedPlugins(home, codexHome, selectedProject)
        : plugins;
    const installed = await pluginSources(inventory, codexHome, config.entries);
    const hooks = await hookInventory(
      codexHome,
      directories,
      installed,
      issues,
    );
    const memoryRoots = await existingRoots([join(codexHome, "memories")]);
    const skillGroups = [
      {
        paths: [join(home, ".agents", "skills"), join(codexHome, "skills")],
        origin: "Personal",
        enabled: null,
      },
      {
        paths:
          resolve(home) === resolve(homedir()) ? ["/etc/codex/skills"] : [],
        origin: "Admin",
        enabled: null,
      },
      {
        paths: directories.map((path) => join(path, ".agents", "skills")),
        origin: "Project",
        enabled: null,
      },
      ...installed.map((plugin) => ({
        ...plugin,
        paths: plugin.roots.map((root) => join(root, "skills")),
        plugin: plugin.name,
      })),
    ];
    const records = [];
    const seen = new Set();
    async function add(path, kind, roots, extra) {
      try {
        const resolved = await canonical(path, roots);
        if (seen.has(resolved)) return;
        const record = await sourceRecord(resolved, kind, roots);
        records.push({ ...record, ...extra, availability: "unknown" });
        seen.add(resolved);
      } catch (error) {
        if (error.code !== "ENOENT")
          issues.push(`A ${kind} source was skipped.`);
      }
    }
    const memoryScan = await walk(memoryRoots, (name) => name.endsWith(".md"), {
      depth: 3,
      limit: 400,
    });
    for (const path of memoryScan.paths)
      await add(path, "memory", memoryRoots, {
        origin: "Personal",
        enabled: null,
      });
    let skillsPartial = false;
    for (const group of skillGroups) {
      const limit = 1200 - records.filter((row) => row.kind === "skill").length;
      if (!limit) {
        skillsPartial = true;
        break;
      }
      const roots = await existingRoots(group.paths);
      const scan = await walk(roots, (name) => name === "SKILL.md", { limit });
      skillsPartial ||= scan.partial;
      for (const path of scan.paths) {
        const configured =
          config.skills.get(path) ?? config.skills.get(resolve(path));
        const enabled = configured ?? group.enabled;
        await add(path, "skill", roots, {
          origin: path.includes(`${join("skills", ".system")}/`)
            ? "Built-in"
            : group.origin,
          enabled,
          state:
            enabled === false
              ? "disabled"
              : enabled === true
                ? "enabled"
                : "availability unknown",
          installed: Boolean(group.plugin),
          ...(group.plugin
            ? { plugin: group.plugin, version: group.version }
            : {}),
        });
      }
    }
    let remaining = Math.min(config.maxBytes, 512 * 1024);
    for (const [index, directory] of [codexHome, ...directories].entries()) {
      const directoryRoots = await existingRoots([directory]);
      if (!remaining) break;
      const candidates = [
        "AGENTS.override.md",
        "AGENTS.md",
        ...(index ? config.fallbacks : []),
      ];
      for (const name of candidates) {
        const path = join(directory, name);
        const roots = directoryRoots.map((root) => join(root, name));
        try {
          const data = await readBounded(path, roots);
          if (!data.text.trim()) continue;
          const includedBytes = Math.min(remaining, data.size);
          await add(path, "guidance", roots, {
            origin: index ? "Project" : "Personal",
            enabled: null,
            instructionOrder: index,
            includedBytes,
            instructionTruncated: data.size > remaining,
          });
          remaining -= includedBytes;
          break;
        } catch (error) {
          if (error.code !== "ENOENT")
            issues.push("A guidance source was skipped.");
        }
      }
    }
    const tools = new Map(
      config.entries.map((entry) => [`${entry.kind}:${entry.name}`, entry]),
    );
    for (const plugin of installed) {
      tools.set(`plugin:${plugin.name}`, {
        id: fileId(`plugin:${plugin.name}`),
        kind: "plugin",
        name: plugin.name,
        path: plugin.roots[0] || "",
        version: plugin.version,
        installed: true,
        enabled: plugin.enabled,
        origin: plugin.origin,
        state:
          plugin.enabled === false
            ? "disabled"
            : plugin.enabled === true
              ? "enabled"
              : "availability unknown",
        runtime: "unverified",
        availability: "unknown",
      });
    }
    const usage = await sessionInventory(
      await existingRoots([join(codexHome, "sessions")]),
      sessionCache,
    );
    sources.clear();
    for (const record of records) sources.set(record.id, record);
    snapshot = {
      version: "0.3.5",
      capturedAt: new Date().toISOString(),
      project: selectedProject,
      records: records.sort((a, b) => a.name.localeCompare(b.name)),
      tools: [...tools.values()],
      hooks: hooks.records,
      usage,
      issues: [...new Set([...issues, ...usage.issues])],
      coverage: {
        memoryPartial: memoryScan.partial,
        skillsPartial,
        hooksPartial: hooks.partial,
        pluginInventory:
          inventory === null ? "unavailable" : "reported by Codex",
        inventory:
          "Stored sources and known configuration; availability in this chat is unknown.",
      },
    };
    return snapshot;
  }

  async function dashboard(force = false) {
    if (pending) return pending;
    if (
      !force &&
      snapshot &&
      Date.now() - Date.parse(snapshot.capturedAt) < 15_000
    )
      return snapshot;
    pending = collect();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  async function setProject(value) {
    let nextProject = null;
    if (value !== null) {
      if (typeof value !== "string" || !value.trim() || value.length > 4096)
        throw new Error("Choose a project folder or personal context.");
      const path = value.trim().replace(/^~(?=$|\/)/, home);
      if (!isAbsolute(path))
        throw new Error("Enter an absolute project folder path.");
      let resolved;
      try {
        resolved = await realpath(path);
      } catch {
        throw new Error("That project folder does not exist.");
      }
      if (!(await stat(resolved)).isDirectory())
        throw new Error("Choose a folder, not a file.");
      nextProject = resolved;
    }
    while (pending) await pending;
    selectedProject = nextProject;
    snapshot = null;
    sources.clear();
    return dashboard(true);
  }

  async function read(id, offset = 0) {
    await dashboard();
    const source = sources.get(id);
    if (!source)
      throw new Error("Unknown source ID. Browse the current catalog first.");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Offset must be a nonnegative integer.");
    const data = await readBounded(source.path, [source.path]);
    const text = redact(data.text);
    if (offset > text.length)
      throw new Error("Offset exceeds the readable source.");
    const end = Math.min(offset + PAGE_CHARS, text.length);
    return {
      ...source,
      modifiedAt: data.modifiedAt,
      text: text.slice(offset, end),
      offset,
      nextOffset: end < text.length ? end : null,
      truncated: data.truncated,
      redacted: text !== data.text,
    };
  }

  async function browse(category = "all", query = "", includeDisabled = false) {
    const data = await dashboard();
    const collections = {
      memory: data.records.filter((row) => row.kind !== "skill"),
      skills: data.records.filter((row) => row.kind === "skill"),
      tools: data.tools,
      hooks: data.hooks,
      sessions: data.usage.sessions,
    };
    if (category !== "all" && !Object.hasOwn(collections, category))
      throw new Error("Unknown category.");
    if (typeof query !== "string" || query.length > 200)
      throw new Error("Query must be at most 200 characters.");
    if (typeof includeDisabled !== "boolean")
      throw new Error("includeDisabled must be a boolean.");
    const rows =
      category === "all"
        ? [...data.records, ...data.tools, ...data.hooks]
        : collections[category];
    const matches = rows.filter(
      (row) =>
        (includeDisabled || row.enabled !== false) &&
        JSON.stringify(row).toLowerCase().includes(query.toLowerCase()),
    );
    return {
      capturedAt: data.capturedAt,
      category,
      query: label(query),
      total: matches.length,
      records: matches.slice(0, 60),
      partial: matches.length > 60,
      coverage: data.coverage,
    };
  }
  return { dashboard, read, browse, setProject };
}
