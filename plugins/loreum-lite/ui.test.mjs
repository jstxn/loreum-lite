import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { renderHtml, tools } from "./server.mjs";

const pluginRoot = dirname(fileURLToPath(import.meta.url));

test("embedded UI shows startup and retry states, adopts host styling, and keeps rapid previews consistent", async () => {
  const html = await renderHtml();
  assert.ok(
    /<section\b[^>]*id="loading"[^>]*>/.test(html),
    "the initial HTML must show a loader before host data arrives",
  );
  assert.ok(/<nav\b[^>]*id="nav"[^>]*hidden/.test(html));
  assert.ok(/<div\b[^>]*id="workspace"[^>]*hidden/.test(html));
  const messages = [];
  const listeners = new Map();
  const properties = new Map();
  const nodes = new Map();
  const startupTimers = [];
  let rendered;
  const parent = { postMessage: (message) => messages.push(message) };
  const window = {
    parent,
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  const rootStyle = {
    setProperty: (name, value) => properties.set(name, value),
  };
  const node = () => ({
    children: [],
    listeners: {},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    classList: { add() {}, remove() {} },
    querySelectorAll: () => [],
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
  });
  const document = {
    documentElement: { style: rootStyle },
    createElement: node,
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
  };
  new Script(await readFile(join(pluginRoot, "ui.js"), "utf8")).runInNewContext(
    {
      LOREUM_LITE: { web: false },
      location: { hash: "#memory" },
      window,
      document,
      setTimeout: (callback, delay) => {
        if (delay === 1500) startupTimers.push(callback);
        return 0;
      },
      clearTimeout() {},
      renderLoreumLite: (state) => {
        rendered = state;
      },
    },
  );
  const deliver = (message) =>
    listeners.get("message")({ source: parent, data: message });
  assert.equal(messages[0].method, "ui/initialize");
  assert.equal(nodes.get("loading").hidden, false);
  assert.equal(nodes.get("workspace").hidden, true);
  assert.equal(nodes.get("nav").hidden, true);
  deliver({
    jsonrpc: "2.0",
    id: messages[0].id,
    error: { message: "The host did not respond." },
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(
    nodes.get("loading-title").textContent,
    "Couldn't load your context",
  );
  assert.equal(
    nodes.get("loading-message").textContent,
    "The host did not respond.",
  );
  assert.equal(nodes.get("retry").hidden, false);
  assert.equal(nodes.get("loading").attributes["aria-busy"], "false");
  nodes.get("retry").onclick();
  assert.equal(nodes.get("retry").hidden, true);
  assert.equal(nodes.get("loading-indicator").hidden, false);
  assert.equal(nodes.get("loading").attributes["aria-busy"], "true");
  const initialization = messages.at(-1);
  assert.equal(initialization.method, "ui/initialize");
  deliver({
    jsonrpc: "2.0",
    id: initialization.id,
    result: {
      hostCapabilities: { serverTools: {} },
      hostContext: {
        theme: "light",
        styles: { variables: { "--color-text-primary": "#202020" } },
      },
    },
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(rootStyle.colorScheme, "light");
  assert.equal(properties.get("--color-text-primary"), "#202020");
  deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: {
      theme: "dark",
      styles: { variables: { "--color-text-primary": "#eeeeee" } },
    },
  });
  assert.equal(rootStyle.colorScheme, "dark");
  assert.equal(properties.get("--color-text-primary"), "#eeeeee");
  startupTimers[0]();
  const failedDashboard = messages.at(-1);
  assert.equal(failedDashboard.params.name, "loreum_lite_dashboard");
  deliver({
    jsonrpc: "2.0",
    id: failedDashboard.id,
    error: { message: "The local reader is unavailable." },
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(nodes.get("retry").hidden, false);
  nodes.get("retry").onclick();
  const dashboardRetry = messages.at(-1);
  assert.equal(dashboardRetry.params.name, "loreum_lite_dashboard");
  assert.equal(
    messages.filter((message) => message.method === "ui/initialize").length,
    2,
  );
  deliver({
    jsonrpc: "2.0",
    id: dashboardRetry.id,
    result: {
      _meta: {
        dashboard: {
          project: null,
          issues: [],
          hooks: [],
        },
      },
    },
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(rendered.view, "memory");
  assert.equal(nodes.get("loading").hidden, true);
  assert.equal(nodes.get("workspace").hidden, false);
  assert.equal(nodes.get("nav").hidden, false);
  assert.equal(nodes.get("project").textContent, "Personal · Choose project");
  nodes.get("project").onclick();
  assert.equal(nodes.get("project-dialog").open, true);
  nodes.get("project-path").value = "/missing";
  nodes.get("project-form").listeners.submit({ preventDefault() {} });
  const missingRequest = messages.at(-1);
  assert.equal(missingRequest.params.name, "loreum_lite_project");
  deliver({
    jsonrpc: "2.0",
    id: missingRequest.id,
    result: {
      isError: true,
      content: [{ type: "text", text: "That project folder does not exist." }],
    },
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(nodes.get("project-dialog").open, true);
  assert.equal(
    nodes.get("project-error").textContent,
    "That project folder does not exist.",
  );
  nodes.get("project-path").value = "/chosen";
  nodes.get("project-form").listeners.submit({ preventDefault() {} });
  const projectRequest = messages.at(-1);
  assert.equal(projectRequest.params.arguments.project, "/chosen");
  deliver({
    jsonrpc: "2.0",
    id: projectRequest.id,
    result: {
      _meta: { dashboard: { project: "/chosen", issues: [], hooks: [] } },
    },
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(nodes.get("project-dialog").open, false);
  assert.equal(nodes.get("project").textContent, "chosen · Change project");
  nodes.get("personal-scope").onclick();
  const personalRequest = messages.at(-1);
  assert.equal(personalRequest.params.arguments.project, null);
  deliver({
    jsonrpc: "2.0",
    id: personalRequest.id,
    result: { _meta: { dashboard: { project: null, issues: [], hooks: [] } } },
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(nodes.get("project").textContent, "Personal · Choose project");
  const first = rendered.showDetail({
    id: "first",
    kind: "memory",
    name: "First",
    path: "/first.md",
  });
  const firstRequest = messages.at(-1);
  const second = rendered.showDetail({
    id: "second",
    kind: "skill",
    name: "Second",
    path: "/second.md",
  });
  const secondRequest = messages.at(-1);
  assert.equal(nodes.get("detail").hidden, false);
  deliver({
    jsonrpc: "2.0",
    id: secondRequest.id,
    result: {
      structuredContent: {
        text: "Chosen excerpt",
        offset: 0,
        nextOffset: null,
      },
    },
  });
  await second;
  assert.equal(
    nodes.get("detail-body").children[0].textContent,
    "Chosen excerpt",
  );
  nodes.get("close-detail").onclick();
  deliver({
    jsonrpc: "2.0",
    id: firstRequest.id,
    result: {
      structuredContent: { text: "Stale excerpt", offset: 0, nextOffset: null },
    },
  });
  await first;
  assert.equal(nodes.get("detail").hidden, true);
  assert.equal(
    nodes.get("detail-body").children[0].textContent,
    "Chosen excerpt",
  );
});

test("plugin manifests and self-contained UI are consistent and browser script parses", async () => {
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, "plugin.json"), "utf8"),
  );
  const compatibility = JSON.parse(
    await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const mcp = JSON.parse(await readFile(join(pluginRoot, "mcp.json"), "utf8"));
  assert.equal(manifest.name, compatibility.name);
  assert.equal(manifest.version, compatibility.version);
  const logo = await readFile(join(pluginRoot, "assets/icon.svg"), "utf8");
  const opener = tools.find((tool) => tool.name === "loreum_lite_open");
  assert.equal(
    opener.title,
    manifest.extensions["com.openai"].interface.displayName,
  );
  assert.equal(decodeURIComponent(opener.icons[0].src.split(",")[1]), logo);
  assert.ok(
    manifest.extensions["com.openai"].interface.shortDescription.length <= 30,
  );
  assert.deepEqual(mcp.mcpServers[manifest.name].args, [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin host expands this portable placeholder.
    "${PLUGIN_ROOT}/server.mjs",
  ]);
  assert.equal(mcp.mcpServers[manifest.name].env, undefined);
  const html = await renderHtml();
  assert.equal(
    /__(?:STYLE|SCRIPT|BOOTSTRAP|NONCE|BRAND_ICON)__/.test(html),
    false,
  );
  assert.ok(
    html.includes(logo),
    "the dashboard and plugin entrypoint share one logo",
  );
  new Script(await readFile(join(pluginRoot, "ui.js"), "utf8"));
  new Script(await readFile(join(pluginRoot, "ui-views.js"), "utf8"));
  new Script(await readFile(join(pluginRoot, "ui-dashboard.js"), "utf8"));
});

test("overview uses stored counts and opens recent context in the reader view", async () => {
  const elements = [];
  const actions = [];
  const el = (tag, text, className) => {
    const node = {
      tag,
      textContent: text,
      className,
      children: [],
      style: {},
      classList: { add() {} },
      append(...children) {
        this.children.push(...children);
      },
      setAttribute() {},
    };
    elements.push(node);
    return node;
  };
  const sandbox = {};
  new Script(
    await readFile(join(pluginRoot, "ui-dashboard.js"), "utf8"),
  ).runInNewContext(sandbox);
  const records = [
    {
      id: "memory",
      kind: "memory",
      path: "/memories/a.md",
      modifiedAt: "2026-01-01",
    },
    {
      id: "instruction",
      kind: "memory",
      path: "/instructions/a.md",
      modifiedAt: "2026-01-03",
    },
    {
      id: "project",
      kind: "guidance",
      path: "/project/AGENTS.md",
      modifiedAt: "2026-01-02",
    },
    { id: "skill", kind: "skill", path: "/skills/SKILL.md" },
  ];
  sandbox.renderLoreumDashboard({
    el,
    fmt: String,
    date: String,
    data: { records, tools: [], usage: { sessions: [] } },
    counts: { memory: 3, skills: 1, tools: 0 },
    navigate: (view) => actions.push(view),
    showDetail: (row) => actions.push(row.id),
    sourceRow: (row) => el("button", row.id, "source-row"),
    content: el("div"),
  });
  assert.deepEqual(
    elements
      .filter((node) => node.className === "card-value")
      .map((node) => node.textContent),
    ["3", "1", "0", "0"],
  );
  const legends = elements.filter(
    (node) => node.className === "library-legend",
  );
  assert.deepEqual(
    legends.map((node) => node.children[1].textContent),
    ["2", "1", "1"],
  );
  const recent = elements.filter((node) => node.className === "source-row");
  assert.equal(recent[0].textContent, "instruction");
  recent[0].onclick();
  assert.deepEqual(actions, ["memory", "instruction"]);
  assert.equal(
    records[0].id,
    "memory",
    "rendering must not reorder the inventory",
  );
  assert.ok(
    elements.some(
      (node) => node.textContent === "No recent session records found yet.",
    ),
  );
});

test("source lists and overview counts hide disabled entries until explicitly included", async () => {
  const elements = [];
  const nodes = new Map();
  const el = (tag, text, className) => {
    const node = {
      tag,
      textContent: text,
      className,
      children: [],
      style: {},
      classList: { add() {} },
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      setAttribute() {},
      dataset: {},
    };
    elements.push(node);
    return node;
  };
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, el("div"));
    return nodes.get(id);
  };
  byId("search").value = "";
  byId("show-disabled").checked = false;
  const sandbox = { document: { createElementNS: () => el("svg") } };
  new Script(
    await readFile(join(pluginRoot, "ui-views.js"), "utf8"),
  ).runInNewContext(sandbox);
  new Script(
    await readFile(join(pluginRoot, "ui-dashboard.js"), "utf8"),
  ).runInNewContext(sandbox);
  const data = {
    project: null,
    coverage: {},
    records: [
      {
        id: "personal",
        kind: "skill",
        name: "Personal",
        path: "/skills/a/SKILL.md",
        origin: "Personal",
        enabled: null,
      },
      {
        id: "enabled",
        kind: "skill",
        name: "Enabled",
        path: "/plugins/a/SKILL.md",
        origin: "Plugin",
        enabled: true,
        installed: true,
      },
      {
        id: "disabled",
        kind: "skill",
        name: "Disabled",
        path: "/plugins/b/SKILL.md",
        origin: "Plugin",
        enabled: false,
        installed: true,
      },
    ],
    tools: [
      {
        id: "off",
        kind: "tool",
        name: "Off",
        path: "/config.toml",
        enabled: false,
        origin: "Personal",
      },
    ],
    usage: { sessions: [] },
  };
  const state = {
    el,
    fmt: String,
    date: String,
    byId,
    data,
    view: "skills",
    views: { dashboard: "Overview", skills: "Skills", tools: "Tools" },
    descriptions: {},
    navigate() {},
    showDetail() {},
  };
  sandbox.renderLoreumLite(state);
  assert.equal(byId("list-summary").textContent, "2 sources");
  assert.equal(
    elements.filter((node) => node.className === "source-row").length,
    2,
  );
  assert.ok(
    elements.some(
      (node) =>
        node.textContent === "Availability unknown" &&
        node.className === "source-badge",
    ),
  );
  byId("show-disabled").checked = true;
  sandbox.renderLoreumLite(state);
  assert.equal(byId("list-summary").textContent, "3 sources");
  byId("show-disabled").checked = false;
  elements.length = 0;
  sandbox.renderLoreumLite({ ...state, view: "dashboard" });
  assert.deepEqual(
    elements
      .filter((node) => node.className === "card-value")
      .map((node) => node.textContent),
    ["0", "2", "0", "0"],
  );
  assert.equal(data.records.length, 3);
});
