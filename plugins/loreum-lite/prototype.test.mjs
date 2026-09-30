import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCatalog } from "./catalog.mjs";
import { configInventory, fileId } from "./files.mjs";
import { createHandler, serveWeb, UI_URI } from "./server.mjs";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const usage = (total) => ({
  input_tokens: total - 10,
  cached_input_tokens: total - 20,
  output_tokens: 10,
  reasoning_output_tokens: 4,
  total_tokens: total,
});
const event = (type, payload) =>
  JSON.stringify({ type, timestamp: "2026-09-29T22:00:00Z", payload });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "loreum-lite-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const codexHome = join(home, ".codex");
  const file = async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await file(
    join(codexHome, "memories", "memory.md"),
    `# Testing memory\nCredential: ${secret}\n${"A".repeat(25_000)}`,
  );
  await file(join(project, "AGENTS.md"), "# Project guidance\nRun checks.");
  await file(join(codexHome, "AGENTS.md"), "# Global guidance\nUser defaults.");
  await file(
    join(home, ".agents", "skills", "sample", "SKILL.md"),
    "---\nname: sample\ndescription: A test skill\n---\n# Sample\nInspect sources.",
  );
  await mkdir(join(codexHome, "skills"), { recursive: true });
  await symlink(
    join(home, ".agents", "skills", "sample"),
    join(codexHome, "skills", "sample"),
  );
  await file(
    join(codexHome, "config.toml"),
    `[mcp_servers."sample"]\ncommand = "node"\nenabled = true\n[mcp_servers.sample.env]\nAPI_KEY = "${secret}"\n[plugins."sample@local"]\nenabled = false\n`,
  );
  const folder = join(codexHome, "sessions", "2026", "09", "29");
  const log = [
    event("session_meta", {
      id: "one",
      cwd: project,
      base_instructions: { text: "ignored instruction text ".repeat(1000) },
    }),
    event("event_msg", {
      type: "token_count",
      info: { total_token_usage: usage(100) },
    }),
    event("response_item", {
      type: "function_call",
      name: "read_file",
      arguments: `secret=${secret}`,
    }),
    event("token_usage_record", {
      usage: usage(30),
      thread_token_usage: usage(500),
    }),
    "malformed line",
  ].join("\n");
  await file(join(folder, "rollout-2026-09-29T01-00-00-one.jsonl"), log);
  await file(
    join(folder, "rollout-2026-09-29T02-00-00-two.jsonl"),
    [
      event("session_meta", { id: "two", cwd: project }),
      event("event_msg", {
        type: "token_count",
        info: { total_token_usage: usage(200) },
      }),
    ].join("\n"),
  );
  await file(
    join(folder, "rollout-2026-09-29T03-00-00-three.jsonl"),
    event("session_meta", { id: "three", cwd: project }),
  );
  return {
    root,
    home,
    project,
    codexHome,
    file,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("real file readers deduplicate skills, count latest cumulative tokens, and redact secrets", async () => {
  const f = await fixture();
  try {
    const catalog = createCatalog(f);
    const data = await catalog.dashboard();
    assert.equal(data.records.filter((row) => row.kind === "skill").length, 1);
    assert.ok(data.records.some((row) => row.name === "Global guidance"));
    assert.equal(data.usage.totals.total_tokens, 700);
    assert.equal(
      data.usage.sessions.find((row) => row.sessionId === "one").malformed,
      1,
    );
    assert.equal(
      data.usage.sessions.find((row) => row.sessionId === "three").usage,
      null,
    );
    assert.equal(data.tools.length, 2);
    assert.equal(data.tools[1].state, "disabled");
    assert.equal(JSON.stringify(data).includes(secret), false);
    const found = await catalog.browse("memory", "Testing memory");
    assert.equal(found.total, 1);
    const first = await catalog.read(found.records[0].id);
    assert.equal(first.redacted, true);
    assert.equal(first.text.includes(secret), false);
    assert.equal(first.nextOffset, 12_000);
    const second = await catalog.read(first.id, first.nextOffset);
    assert.equal(second.offset, 12_000);
    await assert.rejects(() => catalog.read(first.id, -1), /Offset/);
    await assert.rejects(() => catalog.browse("nope"), /category/);
  } finally {
    await f.cleanup();
  }
});

test("only indexed sources are readable, including after a source is replaced by an escaping symlink", async () => {
  const f = await fixture();
  try {
    const secretPath = join(f.root, "private.md");
    await f.file(secretPath, "DO NOT READ");
    const escapingSource = join(f.codexHome, "memories", "escape.md");
    await symlink(secretPath, escapingSource);
    const catalog = createCatalog(f);
    const data = await catalog.dashboard();
    assert.equal(
      data.records.some((row) => row.path === escapingSource),
      false,
    );
    await assert.rejects(
      () => catalog.read(fileId(secretPath)),
      /Unknown source/,
    );
    const chosen = data.records.find((row) => row.name === "Testing memory");
    await rm(chosen.path);
    await symlink(secretPath, chosen.path);
    await assert.rejects(() => catalog.read(chosen.id), /approved roots/);
    await rm(chosen.path);
    await symlink(join(f.codexHome, "config.toml"), chosen.path);
    await assert.rejects(() => catalog.read(chosen.id), /approved roots/);
    const globalGuidance = join(f.codexHome, "AGENTS.md");
    await rm(globalGuidance);
    await symlink(join(f.codexHome, "config.toml"), globalGuidance);
    const refreshed = await catalog.dashboard(true);
    assert.equal(
      refreshed.records.some(
        (row) => row.path === join(f.codexHome, "config.toml"),
      ),
      false,
    );
    const handler = createHandler(catalog);
    assert.equal(
      (
        await handler.dispatch("tools/call", {
          name: "loreum_lite_read",
          arguments: { id: "../../private.md" },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await handler.dispatch("tools/call", {
          name: "loreum_lite_open",
          arguments: { project: "/" },
        })
      ).isError,
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("missing stores remain unavailable and unknown token totals remain null", async () => {
  const root = await mkdtemp(join(tmpdir(), "loreum-lite-empty-"));
  try {
    const catalog = createCatalog({
      home: root,
      project: root,
      codexHome: join(root, ".codex"),
    });
    const data = await catalog.dashboard();
    assert.deepEqual(data.records, []);
    assert.equal(data.usage.totals.total_tokens, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration inventory reads only allowed header and enabled metadata", () => {
  const result = configInventory(
    `[mcp_servers.'with.dot'] # comment\ncommand='secret'\nenabled = false # comment\n[mcp_servers.'with.dot'.env]\nSECRET='sensitive'\n[plugins."quoted\\"name@local"]\nenabled=true`,
    "/test/config.toml",
  );
  assert.equal(result[0].name, "with.dot");
  assert.equal(result[0].state, "disabled");
  assert.equal(result[1].name, 'quoted"name@local');
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
  assert.equal(JSON.stringify(result).includes("command"), false);
});

test("loopback preview requires its capability token and rejects foreign origins, malformed JSON, and arbitrary paths", async () => {
  const f = await fixture();
  const preview = await serveWeb(createHandler(createCatalog(f)), 0);
  const origin = new URL(preview.url).origin;
  try {
    assert.equal((await fetch(origin)).status, 401);
    assert.equal(
      (
        await fetch(preview.url, {
          headers: { Origin: "https://foreign.example" },
        })
      ).status,
      403,
    );
    const page = await fetch(preview.url);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.match(await page.text(), /Loreum Lite/);
    const call = (body) =>
      fetch(`${origin}/api/tool`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${preview.token}`,
          "Content-Type": "application/json",
        },
        body,
      });
    assert.equal((await call("bad json")).status, 400);
    assert.equal(
      (
        await call(
          JSON.stringify({
            name: "loreum_lite_read",
            arguments: { id: "/etc/passwd" },
          }),
        )
      ).status,
      400,
    );
    const data = await (
      await call(JSON.stringify({ name: "loreum_lite_open", arguments: {} }))
    ).json();
    assert.equal(data.structuredContent.recordedTokens, 700);
    assert.equal(data._meta.dashboard.usage.sessions.length, 3);
    assert.equal(data.content[0].text.includes("Testing memory"), false);
  } finally {
    await new Promise((done) => preview.server.close(done));
    await f.cleanup();
  }
});

test("actual stdio server handles initialization, discovery, UI resource, reads, and malformed requests", async () => {
  const f = await fixture();
  const child = spawn(
    process.execPath,
    [join(pluginRoot, "server.mjs"), "--project", f.project],
    {
      env: {
        ...process.env,
        LOREUM_LITE_HOME: f.home,
        LOREUM_LITE_CODEX_HOME: f.codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  let id = 0;
  const call = (method, params = {}) =>
    new Promise((resolveReply, reject) => {
      const current = ++id;
      const timer = setTimeout(() => {
        waiting.delete(current);
        reject(new Error("MCP response timed out."));
      }, 10_000);
      waiting.set(current, (reply) => {
        clearTimeout(timer);
        resolveReply(reply);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`,
      );
    });
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  child.stderr.resume();
  try {
    assert.equal(
      (await call("initialize", { protocolVersion: "2025-06-18" })).result
        .protocolVersion,
      "2025-06-18",
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    assert.equal((await call("tools/list")).result.tools.length, 5);
    const resource = (await call("resources/read", { uri: UI_URI })).result
      .contents[0];
    assert.equal(resource.mimeType, "text/html;profile=mcp-app");
    assert.equal(
      resource._meta["openai/ui"].preferredDisplayMode,
      "fullscreen",
    );
    assert.match(resource.text, /ui\/initialize/);
    const open = (await call("tools/call", { name: "loreum_lite_open" }))
      .result;
    assert.equal(open.structuredContent.recordedTokens, 700);
    assert.equal((await call("missing")).error.code, -32601);
    assert.equal(
      (await call("tools/call", { name: "missing" })).result.isError,
      true,
    );
    assert.equal(
      (await call("initialize", { protocolVersion: "unknown" })).result
        .protocolVersion,
      "2025-11-25",
    );
  } finally {
    lines.close();
    child.stdin.end();
    if (child.exitCode == null) await once(child, "exit");
    await f.cleanup();
  }
});
