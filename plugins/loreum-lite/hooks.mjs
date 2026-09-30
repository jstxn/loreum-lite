import { join, resolve } from "node:path";
import { stringValue } from "./codex.mjs";
import { existingRoots, fileId, inside, label, readBounded } from "./files.mjs";

const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

function closingQuote(text, quote, start = 0) {
  for (
    let index = text.indexOf(quote, start);
    index >= 0;
    index = text.indexOf(quote, index + 1)
  ) {
    let escapes = 0;
    if (quote === '"""')
      for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) escapes++;
    if (!(escapes % 2)) return index;
  }
  return -1;
}

// ponytail: inspect ordinary hook array tables; flag other TOML forms instead of implementing TOML.
function tomlHooks(text) {
  const hooks = Object.create(null);
  let group;
  let handler;
  let event;
  let section = "";
  let multiline = "";
  let partial = false;
  const features = {};
  for (const line of text.split(/\r?\n/)) {
    if (multiline) {
      if (closingQuote(line, multiline) >= 0) multiline = "";
      continue;
    }
    const field = line.match(/^\s*([\w-]+)\s*=\s*(.*)$/);
    if (field && /^(?:"""|''')/.test(field[2])) {
      const quote = field[2].slice(0, 3);
      if (closingQuote(field[2], quote, 3) < 0) multiline = quote;
      if (["matcher", "type", "statusMessage"].includes(field[1]) && group)
        partial = true;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      section = line.trim();
      handler = null;
      const header = section.match(
        /^\[\[hooks\.([A-Za-z][\w]{0,79})(\.hooks)?\]\]\s*(?:#.*)?$/,
      );
      if (!header) {
        group = null;
        event = null;
        const metadata =
          /^\[hooks\.state(?:\.|\])/.test(section) ||
          /^\[hooks\.[A-Za-z]\w*\.hooks\.input(?:\.[\w.-]+)?\]\s*(?:#.*)?$/.test(
            section,
          );
        if (/^\[\[?hooks\./.test(section) && !metadata) partial = true;
        continue;
      }
      if (!header[2]) {
        event = header[1];
        group = { hooks: [] };
        hooks[event] ||= [];
        hooks[event].push(group);
      } else if (hooks[header[1]]?.length) {
        group = hooks[header[1]].at(-1);
        event = header[1];
        handler = {};
        group.hooks.push(handler);
      } else {
        group = null;
        event = null;
        partial = true;
      }
      continue;
    }
    if (!field) continue;
    const [, key, value] = field;
    if (
      /^\[features\]\s*(?:#.*)?$/.test(section) &&
      ["hooks", "codex_hooks"].includes(key)
    ) {
      const flag = value.match(/^(true|false)\s*(?:#.*)?$/);
      if (flag) features[key] = flag[1] === "true";
    }
    if (group && key === "hooks") partial = true;
    const target = key === "matcher" ? group : handler;
    if (target && ["matcher", "type", "statusMessage"].includes(key)) {
      const parsed = stringValue(value);
      if (parsed !== null) target[key] = parsed;
      else partial = true;
    }
    if (handler && key === "async" && /^(true|false)\s*(?:#.*)?$/.test(value))
      handler.async = value.startsWith("true");
    if (
      handler &&
      key === "timeout" &&
      /^\d+(?:\.\d+)?\s*(?:#.*)?$/.test(value)
    )
      handler.timeout = Number.parseFloat(value);
    if (!section && key === "hooks") partial = true;
  }
  return { hooks, partial, enabled: features.hooks ?? features.codex_hooks };
}

export async function hookInventory(codexHome, directories, plugins, issues) {
  const records = [];
  const seen = new Set();
  let partial = false;
  let enabled;
  async function read(path, roots) {
    try {
      const data = await readBounded(path, roots);
      if (data.truncated) {
        partial = true;
        issues.push("A hook source exceeded the read limit and was skipped.");
        return null;
      }
      return data.text;
    } catch (error) {
      if (error.code !== "ENOENT") {
        partial = true;
        issues.push("A hook source could not be read safely.");
      }
      return null;
    }
  }
  async function json(path, roots) {
    const text = await read(path, roots);
    if (text === null) return null;
    try {
      const data = JSON.parse(text);
      if (!object(data)) throw new Error();
      return data;
    } catch {
      partial = true;
      issues.push("A hook source or plugin manifest contains invalid JSON.");
      return null;
    }
  }
  function add(data, path, extra, entry = 0) {
    if (!object(data?.hooks)) return;
    for (const [event, groups] of Object.entries(data.hooks)) {
      if (!/^[A-Za-z][\w]{0,79}$/.test(event) || !Array.isArray(groups)) {
        partial = true;
        continue;
      }
      for (const [groupIndex, group] of groups.entries()) {
        if (!Array.isArray(group?.hooks)) {
          partial = true;
          continue;
        }
        for (const [index, handler] of group.hooks.entries()) {
          if (!object(handler) || typeof handler.type !== "string") {
            partial = true;
            continue;
          }
          const id = fileId(`${path}:${entry}:${event}:${groupIndex}:${index}`);
          if (seen.has(id)) continue;
          if (records.length >= 400) {
            partial = true;
            return;
          }
          seen.add(id);
          const handlerType = label(handler.type, 40);
          records.push({
            id,
            kind: "hook",
            name: `${event} · ${handlerType}`,
            event,
            handlerType,
            path,
            matcher:
              typeof group.matcher === "string" ? label(group.matcher) : "",
            description:
              typeof handler.statusMessage === "string"
                ? label(handler.statusMessage)
                : "",
            async: typeof handler.async === "boolean" ? handler.async : null,
            timeout:
              Number.isFinite(handler.timeout) && handler.timeout >= 0
                ? handler.timeout
                : null,
            ...extra,
            enabled: extra.enabled === false ? false : null,
            runtime: "unverified",
            trust: "unknown",
          });
        }
      }
    }
  }
  for (const [index, directory] of [
    codexHome,
    ...directories.map((path) => join(path, ".codex")),
  ].entries()) {
    const roots = await existingRoots([directory]);
    const extra = { origin: index ? "Project" : "Personal" };
    const config = join(directory, "config.toml");
    const text = await read(config, roots);
    if (text !== null) {
      const data = tomlHooks(text);
      partial ||= data.partial;
      enabled = data.enabled ?? enabled;
      add(data, config, extra);
    }
    const path = join(directory, "hooks.json");
    add(await json(path, roots), path, extra);
  }
  for (const plugin of plugins) {
    for (const root of plugin.roots) {
      const roots = [root];
      const manifestPath = join(root, "plugin.json");
      const manifest = await json(manifestPath, roots);
      const extension = manifest?.extensions?.["com.openai"];
      const legacyPath = join(root, ".codex-plugin", "plugin.json");
      const overlay = object(extension)
        ? extension
        : await json(legacyPath, roots);
      const source = object(extension) ? manifestPath : legacyPath;
      const entries =
        overlay && Object.hasOwn(overlay, "hooks")
          ? Array.isArray(overlay.hooks)
            ? overlay.hooks
            : [overlay.hooks]
          : ["./hooks/hooks.json"];
      const extra = {
        origin: plugin.origin,
        plugin: plugin.name,
        version: plugin.version,
        installed: true,
        enabled: plugin.enabled,
      };
      for (const [index, entry] of entries.entries()) {
        if (typeof entry === "string") {
          const path = resolve(root, entry);
          if (!entry.startsWith("./") || !inside(root, path)) {
            partial = true;
            issues.push("An unsafe plugin hook path was skipped.");
            continue;
          }
          add(await json(path, roots), path, extra);
        } else if (object(entry)) add(entry, source, extra, index);
        else {
          partial = true;
          issues.push("An unsupported plugin hook entry was skipped.");
        }
      }
    }
  }
  if (enabled === false) for (const record of records) record.enabled = false;
  return { records, partial };
}
