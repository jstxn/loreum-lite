import { constants, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { canonical, fileId, label, readBounded, walk } from "./files.mjs";

const TAIL_BYTES = 8 * 1024 * 1024;
const TOKEN_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function tokens(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !TOKEN_KEYS.some((key) => typeof value[key] === "number")
  )
    return null;
  return Object.fromEntries(
    TOKEN_KEYS.map((key) => [
      key,
      Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null,
    ]),
  );
}

export async function readSession(path, roots) {
  const resolved = await canonical(path, roots);
  const info = await stat(resolved);
  const header = await readBounded(resolved, roots);
  let meta = {};
  try {
    const first = JSON.parse(header.text.split("\n")[0]);
    if (first.type === "session_meta") meta = first.payload ?? {};
  } catch {
    /* A malformed metadata line does not hide recorded counters. */
  }
  const start = Math.max(0, info.size - TAIL_BYTES);
  const stream = createReadStream(resolved, {
    start,
    end: Math.max(0, info.size - 1),
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  });
  const lines = createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let skipPartial = start > 0;
  let usage = null;
  let timestamp = null;
  let malformed = 0;
  const modelNames = new Set();
  try {
    for await (const line of lines) {
      if (skipPartial) {
        skipPartial = false;
        continue;
      }
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      const payload = event?.payload ?? {};
      if (event.type === "token_usage_record") {
        const next = tokens(payload.thread_token_usage);
        if (next) {
          usage = next;
          timestamp = label(event.timestamp, 80);
        }
      } else if (event.type === "event_msg" && payload.type === "token_count") {
        const next = tokens(payload.info?.total_token_usage);
        if (next) {
          usage = next;
          timestamp = label(event.timestamp, 80);
        }
      }
      if (event.type === "turn_context" && typeof payload.model === "string")
        modelNames.add(label(payload.model));
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return {
    id: fileId(resolved),
    sessionId: label(meta.id || basename(path, ".jsonl")),
    name: label(meta.cwd ? basename(meta.cwd) : basename(path, ".jsonl")),
    project: label(meta.cwd || ""),
    path: resolved,
    modifiedAt: info.mtime.toISOString(),
    startedAt: label(meta.timestamp || "", 80),
    models: [...modelNames],
    usage,
    usageAt: timestamp,
    sampled: start > 0,
    malformed,
    state: usage ? "recorded" : "no counters",
  };
}

export async function sessionInventory(roots, cache) {
  const scan = await walk(roots, (name) => name.endsWith(".jsonl"), {
    depth: 4,
    limit: 4000,
    visitedLimit: 8000,
  });
  const paths = scan.paths.sort().reverse().slice(0, 24);
  const sessions = [];
  const issues = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      const key = `${info.mtimeMs}:${info.size}`;
      let entry = cache.get(path);
      if (entry?.key !== key) {
        entry = { key, data: await readSession(path, roots) };
        cache.set(path, entry);
      }
      sessions.push(entry.data);
    } catch {
      issues.push("One session file could not be read.");
    }
  }
  for (const path of cache.keys())
    if (!paths.includes(path)) cache.delete(path);
  const unique = new Map();
  for (const session of sessions) {
    const prior = unique.get(session.sessionId);
    if (!prior || session.modifiedAt > prior.modifiedAt)
      unique.set(session.sessionId, session);
  }
  const rows = [...unique.values()].sort((a, b) =>
    b.modifiedAt.localeCompare(a.modifiedAt),
  );
  const totals = Object.fromEntries(TOKEN_KEYS.map((key) => [key, null]));
  for (const row of rows) {
    for (const key of TOKEN_KEYS)
      if (row.usage?.[key] != null)
        totals[key] = (totals[key] || 0) + row.usage[key];
  }
  return {
    sessions: rows,
    totals,
    issues,
    coverage: {
      selectedFiles: paths.length,
      sessionsWithCounters: rows.filter((row) => row.usage).length,
      policy:
        "24 newest rollout filenames; latest cumulative counter per session",
      partial:
        issues.length > 0 ||
        scan.partial ||
        scan.paths.length > paths.length ||
        rows.some((row) => row.sampled),
    },
    accountUsage: "unavailable",
  };
}
