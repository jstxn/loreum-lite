import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export const FILE_BYTES = 512 * 1024;
export const PAGE_CHARS = 12_000;

export function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function redact(value) {
  return String(value ?? "")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g,
      "[REDACTED TOKEN]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*)["']?[^\s"',;]+/gi,
      "$1[REDACTED]",
    );
}

export const label = (value, length = 180) =>
  redact(value)
    .replace(/\p{Cc}/gu, " ")
    .slice(0, length);
export const fileId = (path) =>
  createHash("sha256").update(path).digest("hex").slice(0, 24);

export async function canonical(path, roots) {
  const resolved = await realpath(path);
  if (!roots.some((root) => inside(root, resolved)))
    throw new Error("Source is outside the approved roots.");
  return resolved;
}

export async function readBounded(path, roots, maxBytes = FILE_BYTES) {
  const resolved = await canonical(path, roots);
  const handle = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Source is not a regular file.");
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      size: info.size,
      truncated: info.size > bytesRead,
      modifiedAt: info.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

export async function existingRoots(paths) {
  const roots = [];
  for (const path of paths) {
    try {
      const root = await realpath(path);
      if ((await stat(root)).isDirectory() && !roots.includes(root))
        roots.push(root);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return roots;
}

export async function walk(
  roots,
  accepts,
  { depth = 9, limit = 1200, visitedLimit = 8000 } = {},
) {
  const paths = [];
  const visited = new Set();
  let partial = false;
  async function visit(path, level) {
    if (paths.length >= limit || visited.size >= visitedLimit) {
      partial = true;
      return;
    }
    let resolved;
    try {
      resolved = await canonical(path, roots);
    } catch {
      return;
    }
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const entries = await readdir(resolved, { withFileTypes: true });
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (["node_modules", ".git", ".turbo"].includes(entry.name)) continue;
      const child = join(resolved, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (level < depth) {
          try {
            const target = await canonical(child, roots);
            if ((await stat(target)).isDirectory())
              await visit(target, level + 1);
            else if (accepts(entry.name)) paths.push(target);
          } catch {
            /* Missing or out-of-root aliases are not readable sources. */
          }
        }
      } else if (entry.isFile() && accepts(entry.name)) paths.push(child);
      if (paths.length >= limit || visited.size >= visitedLimit) {
        partial = true;
        break;
      }
    }
  }
  for (const root of roots) await visit(root, 0);
  return { paths: [...new Set(paths)].slice(0, limit), partial };
}

export async function sourceRecord(path, kind, roots) {
  const data = await readBounded(path, roots, 4096);
  const frontmatter = data.text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const field = (key) =>
    frontmatter?.[1]
      .match(new RegExp(`^${key}:\\s*["']?([^\\r\\n]+)`, "m"))?.[1]
      .replace(/["']$/, "");
  const heading = data.text.match(/^#\s+(.+)$/m)?.[1];
  return {
    id: fileId(path),
    kind,
    name: label(
      kind === "skill"
        ? field("name") || basename(resolve(path, ".."))
        : heading || basename(path),
    ),
    description: label(field("description") || ""),
    path,
    modifiedAt: data.modifiedAt,
    bytes: data.size,
    state: "available",
  };
}

// This inventory intentionally reads only headers and enabled/type flags, never
// commands, arguments, URLs, environment values, or credentials. It is not TOML validation.
export function configInventory(text, path) {
  const records = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      const match = line.match(
        /^\s*\[(mcp_servers|plugins)\.(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([\w-]+))\]\s*(?:#.*)?$/,
      );
      current = null;
      if (match) {
        let name = match[3] || match[4];
        try {
          name ||= JSON.parse(`"${match[2]}"`);
        } catch {
          continue;
        }
        current = {
          id: fileId(`${path}:${match[1]}:${name}`),
          kind: match[1] === "plugins" ? "plugin" : "tool",
          name: label(name),
          path,
          state: "availability unknown",
          enabled: null,
          runtime: "unverified",
        };
        records.push(current);
      }
    } else if (current) {
      const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
      if (enabled) {
        current.enabled = enabled[1] === "true";
        current.state = current.enabled ? "enabled" : "disabled";
      }
    }
  }
  return records;
}
