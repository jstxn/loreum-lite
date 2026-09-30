import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { createCatalog } from "./catalog.mjs";
import { createHandler } from "./server.mjs";

test("unified inventory discovers safe hook metadata, honors plugin overrides, and filters disabled hooks", async () => {
  const home = await mkdtemp(join(tmpdir(), "loreum-lite-inventory-"));
  const codexHome = join(home, ".codex");
  const project = join(home, "repo");
  const file = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  const definition = (event, type = "command") => ({
    hooks: {
      [event]: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type,
              command: "NEVER_EXECUTE_OR_EXPOSE",
              input: { secret: "PRIVATE_INPUT" },
              statusMessage: "Loading notes",
              async: true,
              timeout: 3,
            },
          ],
        },
      ],
    },
  });
  const plugins = [];
  const plugin = async (
    name,
    overlay,
    { legacy = false, enabled = true } = {},
  ) => {
    const root = join(codexHome, "plugins/cache/local", name, "1.0.0");
    plugins.push({
      name,
      marketplaceName: "local",
      version: "1.0.0",
      installed: true,
      enabled,
    });
    await file(
      join(root, legacy ? ".codex-plugin/plugin.json" : "plugin.json"),
      legacy ? overlay : { extensions: { "com.openai": overlay } },
    );
    return root;
  };
  try {
    await mkdir(join(project, ".git"), { recursive: true });
    await file(join(codexHome, "memories/notes.md"), "# Personal notes");
    await file(
      join(home, ".agents/skills/example/SKILL.md"),
      "# Example skill",
    );
    await file(join(codexHome, "hooks.json"), definition("SessionStart"));
    await file(
      join(codexHome, "config.toml"),
      `[mcp_servers.example]\nenabled = true\n[[hooks.PreToolUse]]\nmatcher = 'Bash'\n[[hooks.PreToolUse.hooks]]\ntype = 'mcp_tool'\nstatusMessage = 'Reviewing changes'\ntimeout = 30\ncommand = '''\n[[hooks.FakeEvent]]\n[[hooks.FakeEvent.hooks]]\ntype = 'command'\n'''\n[hooks.PreToolUse.hooks.input]\nsecret = 'PRIVATE_INPUT'\n[[hooks.PreToolUse.hooks]]\ntype = 'command'\n[hooks.state]\n[hooks.state."private-source-id"]\ntrusted_hash = 'PRIVATE_TRUST_HASH'\n`,
    );
    await file(join(project, ".codex/hooks.json"), definition("Stop"));
    const defaultRoot = await plugin("default", {});
    await file(
      join(defaultRoot, "hooks/hooks.json"),
      definition("PostToolUse"),
    );
    const customRoot = await plugin("custom", { hooks: "./custom.json" });
    await file(join(customRoot, "custom.json"), definition("PreCompact"));
    await file(
      join(customRoot, "hooks/hooks.json"),
      definition("WrongDefault"),
    );
    await file(join(customRoot, ".codex-plugin/plugin.json"), {
      hooks: definition("WrongLegacy"),
    });
    const emptyRoot = await plugin("empty", { hooks: [] });
    await file(join(emptyRoot, "hooks/hooks.json"), definition("WrongEmpty"));
    await plugin("inline", {
      hooks: [definition("SessionEnd"), definition("Interrupt")],
    });
    await plugin(
      "legacy",
      { hooks: definition("UserPromptSubmit") },
      { legacy: true },
    );
    await plugin(
      "disabled",
      { hooks: definition("DisabledEvent") },
      { enabled: false },
    );
    assert.equal(
      (await createCatalog({ home, codexHome, project, plugins }).dashboard())
        .coverage.hooksPartial,
      false,
    );
    const outside = join(home, "private-hooks.json");
    await file(outside, definition("OutsideEvent"));
    await plugin("traversal", { hooks: "./../../../../../private-hooks.json" });
    const escapeRoot = await plugin("escape", { hooks: "./escape.json" });
    await symlink(outside, join(escapeRoot, "escape.json"));
    const badRoot = await plugin("bad", { hooks: "./bad.json" });
    await file(join(badRoot, "bad.json"), "bad json");
    const catalog = createCatalog({ home, codexHome, project, plugins });
    const data = await catalog.dashboard();
    assert.deepEqual(data.hooks.map((row) => row.event).sort(), [
      "DisabledEvent",
      "Interrupt",
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    assert.equal(data.coverage.hooksPartial, true);
    const personal = data.hooks.find((row) => row.event === "SessionStart");
    assert.equal(personal.origin, "Personal");
    assert.equal(personal.trust, "unknown");
    assert.equal(personal.enabled, null);
    assert.equal(personal.async, true);
    assert.equal(personal.timeout, 3);
    assert.equal(
      data.hooks.find((row) => row.event === "Stop").origin,
      "Project",
    );
    assert.equal(
      data.hooks.find((row) => row.event === "PreCompact").plugin,
      "custom@local",
    );
    assert.equal(
      JSON.stringify(data).includes("NEVER_EXECUTE_OR_EXPOSE"),
      false,
    );
    assert.equal(JSON.stringify(data).includes("PRIVATE_INPUT"), false);
    assert.equal(JSON.stringify(data).includes("PRIVATE_TRUST_HASH"), false);
    await assert.rejects(() => catalog.read(personal.id), /Unknown source/);
    assert.equal((await catalog.browse("hooks")).total, 9);
    assert.equal((await catalog.browse("hooks", "", true)).total, 10);
    assert.equal(
      (await catalog.browse("all", "SessionStart")).records[0].kind,
      "hook",
    );
    for (const kind of ["memory", "skill", "tool", "plugin", "hook"])
      assert.ok(
        (await catalog.browse()).records.some((row) => row.kind === kind),
      );
    assert.equal(
      (await createHandler(catalog).call("loreum_lite_open", {}))
        .structuredContent.configuredHooks,
      9,
    );
    await file(join(codexHome, "config.toml"), "[features]\nhooks = false\n");
    await catalog.dashboard(true);
    assert.equal((await catalog.browse("hooks")).total, 0);
    assert.equal((await catalog.browse("hooks", "", true)).total, 8);
    await file(
      join(codexHome, "config.toml"),
      "[[hooks.SessionStart]]\nhooks = [{ type = 'command', command = 'private' }]\n",
    );
    assert.equal((await catalog.dashboard(true)).coverage.hooksPartial, true);
    const big = definition("LimitedEvent");
    big.hooks.LimitedEvent[0].hooks = Array.from({ length: 410 }, () => ({
      type: "command",
    }));
    await file(join(codexHome, "hooks.json"), big);
    const limited = await catalog.dashboard(true);
    assert.equal(limited.hooks.length, 400);
    assert.equal(limited.coverage.hooksPartial, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("All sources searches every category and Hooks groups events with disabled sources hidden", async () => {
  const elements = [];
  const nodes = new Map();
  const el = (tag, text, className) => {
    const node = {
      tag,
      textContent: text,
      className,
      children: [],
      style: {},
      dataset: {},
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      setAttribute() {},
      classList: { add() {} },
    };
    elements.push(node);
    return node;
  };
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, el("div"));
    return nodes.get(id);
  };
  const sandbox = { document: { createElementNS: () => el("svg") } };
  const pluginRoot = dirname(fileURLToPath(import.meta.url));
  for (const script of ["ui-views.js", "ui-dashboard.js"])
    new Script(
      await readFile(join(pluginRoot, script), "utf8"),
    ).runInNewContext(sandbox);
  const rows = ["guidance", "memory", "skill", "tool", "plugin", "hook"].map(
    (kind) => ({
      id: kind,
      kind,
      name: `Example ${kind}`,
      origin: "Personal",
      path: `/local/${kind}`,
      ...(kind === "hook" ? { event: "SessionStart" } : {}),
      enabled: null,
    }),
  );
  const data = {
    coverage: {},
    records: rows.slice(0, 3),
    tools: rows.slice(3, 5),
    hooks: [
      rows[5],
      { ...rows[5], id: "disabled", event: "Stop", enabled: false },
    ],
    usage: { sessions: [] },
  };
  let selected;
  const state = {
    el,
    byId,
    fmt: String,
    date: String,
    data,
    view: "all",
    views: { dashboard: "Overview", all: "All sources", hooks: "Hooks" },
    descriptions: {},
    navigate() {},
    showDetail(row) {
      selected = row;
    },
  };
  byId("search").value = "";
  byId("show-disabled").checked = false;
  sandbox.renderLoreumLite(state);
  assert.equal(byId("list-summary").textContent, "6 sources");
  assert.equal(byId("disabled-option").hidden, false);
  assert.deepEqual(
    elements
      .filter((node) => node.className === "group-heading")
      .map((node) => node.children[0].textContent),
    [
      "Instructions",
      "Saved context",
      "Skills",
      "MCP servers",
      "Plugins",
      "Hooks",
    ],
  );
  byId("search").value = "sessionstart";
  sandbox.renderLoreumLite(state);
  assert.equal(byId("list-summary").textContent, "1 matching source");
  for (const kind of [
    "guidance",
    "memory",
    "skill",
    "tool",
    "plugin",
    "hook",
  ]) {
    byId("search").value = `example ${kind}`;
    sandbox.renderLoreumLite(state);
    assert.equal(byId("list-summary").textContent, "1 matching source");
  }
  byId("search").value = "example hook";
  elements.length = 0;
  sandbox.renderLoreumLite(state);
  assert.equal(byId("list-summary").textContent, "1 matching source");
  elements.find((node) => node.className === "source-row").onclick();
  assert.equal(selected.kind, "hook");
  byId("search").value = "";
  byId("show-disabled").checked = true;
  elements.length = 0;
  sandbox.renderLoreumLite({ ...state, view: "hooks" });
  assert.equal(byId("list-summary").textContent, "2 sources");
  assert.deepEqual(
    elements
      .filter((node) => node.className === "group-heading")
      .map((node) => node.children[0].textContent),
    ["SessionStart", "Stop"],
  );
  byId("show-disabled").checked = false;
  elements.length = 0;
  sandbox.renderLoreumLite({ ...state, view: "dashboard" });
  assert.deepEqual(
    elements
      .filter((node) => node.className === "card-value")
      .map((node) => node.textContent),
    ["2", "1", "2", "1"],
  );
  assert.equal(data.hooks.length, 2);
});
