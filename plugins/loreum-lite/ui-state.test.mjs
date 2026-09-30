import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Script } from "node:vm";

test("a retained snapshot without hook data stays loading until current data arrives", async () => {
  const nodes = new Map();
  const messages = [];
  const timers = [];
  const rendered = [];
  const listeners = new Map();
  const node = () => ({
    setAttribute() {},
    addEventListener() {},
    classList: { add() {}, remove() {} },
  });
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const parent = { postMessage: (message) => messages.push(message) };
  new Script(
    await readFile(new URL("./ui.js", import.meta.url), "utf8"),
  ).runInNewContext({
    LOREUM_LITE: { web: false },
    location: { hash: "#hooks" },
    document: { getElementById: byId, documentElement: { style: {} } },
    window: {
      parent,
      addEventListener: (name, callback) => listeners.set(name, callback),
    },
    setTimeout(callback, delay) {
      if (delay === 1500) timers.push(callback);
      return 0;
    },
    clearTimeout() {},
    renderLoreumLite: (state) => rendered.push(state.data),
  });
  const deliver = (message) =>
    listeners.get("message")({ source: parent, data: message });
  deliver({
    jsonrpc: "2.0",
    id: messages[0].id,
    result: { hostCapabilities: { serverTools: {} } },
  });
  await new Promise((done) => setImmediate(done));
  const old = { version: "0.2.0", project: null, issues: [] };
  const notify = (dashboard) =>
    deliver({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { _meta: { dashboard } },
    });
  notify(old);
  assert.equal(
    rendered.length,
    0,
    "missing hook data must not be rendered as zero hooks",
  );
  assert.equal(byId("workspace").hidden, true);
  timers[0]();
  const refresh = messages.at(-1);
  assert.equal(refresh.params.name, "loreum_lite_dashboard");
  const current = {
    ...old,
    version: "0.3.2",
    hooks: [{ kind: "hook", name: "SessionStart" }],
  };
  deliver({
    jsonrpc: "2.0",
    id: refresh.id,
    result: { _meta: { dashboard: current } },
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].hooks.length, 1);
  assert.equal(byId("workspace").hidden, false);
  notify(old);
  assert.equal(
    rendered.length,
    1,
    "a late old result must not overwrite current data",
  );
  notify({ ...current, hooks: [] });
  assert.equal(
    rendered.at(-1).hooks.length,
    0,
    "a current empty hook inventory is valid",
  );
});

test("usage explains the sample, identifies source logs, and distinguishes missing counters from zero", async () => {
  const elements = [];
  const nodes = new Map();
  const el = (tag, text, className) => {
    const node = {
      tag,
      textContent: text,
      className,
      style: {},
      children: [],
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      setAttribute() {},
    };
    elements.push(node);
    return node;
  };
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, el("div"));
    return nodes.get(id);
  };
  byId("search").value = "";
  const sandbox = {};
  new Script(
    await readFile(new URL("./ui-views.js", import.meta.url), "utf8"),
  ).runInNewContext(sandbox);
  const state = {
    el,
    byId,
    fmt: (value) => (value == null ? "—" : String(value)),
    date: String,
    views: { dashboard: "Overview", usage: "Usage" },
    descriptions: {},
    view: "usage",
    navigate() {},
    showDetail() {},
    data: {
      project: null,
      records: [],
      tools: [],
      hooks: [],
      coverage: {},
      usage: {
        totals: {
          total_tokens: 1000,
          input_tokens: 900,
          cached_input_tokens: null,
          output_tokens: 100,
        },
        coverage: { selectedFiles: 3, sessionsWithCounters: 2, partial: true },
        sessions: [
          {
            name: "Recorded",
            path: "/home/user/.codex/sessions/recorded.jsonl",
            usageAt: "counter timestamp",
            modifiedAt: "file timestamp",
            usage: { total_tokens: 1000 },
            tools: [{ name: "exec", count: 100 }],
            toolCalls: 100,
          },
          {
            name: "Missing",
            path: "/home/user/.codex/sessions/missing.jsonl",
            modifiedAt: "file timestamp",
            usage: null,
          },
          {
            name: "Zero",
            path: "/home/user/.codex/sessions/zero.jsonl",
            modifiedAt: "file timestamp",
            usage: { total_tokens: 0 },
          },
        ],
      },
    },
  };
  sandbox.renderLoreumLite(state);
  const text = elements.map((node) => node.textContent || "").join("\n");
  assert.doesNotMatch(text, /Most called tools|\bexec\b|100 calls/);
  assert.match(text, /3 files inspected, 2 sessions with saved token counters/);
  assert.match(text, /Some history is omitted/);
  assert.match(text, /not your account usage, remaining quota, or spend/);
  assert.match(text, /Counters saved counter timestamp/);
  assert.match(text, /~\/\.codex\/sessions\/recorded\.jsonl/);
  assert.match(text, /0 tokens/);
  assert.equal(
    elements.filter((node) => node.textContent === "Not recorded").length,
    2,
  );
  assert.equal(byId("list-summary").textContent, "3 recorded sessions");
  byId("search").value = "missing";
  elements.length = 0;
  sandbox.renderLoreumLite(state);
  assert.equal(byId("list-summary").textContent, "1 of 3 recorded sessions");
  assert.equal(
    elements.filter((node) => node.className === "session-row").length,
    1,
  );
  assert.equal(
    elements.find((node) => node.className === "metric-value").textContent,
    "1000",
  );
  new Script(
    await readFile(new URL("./ui-dashboard.js", import.meta.url), "utf8"),
  ).runInNewContext(sandbox);
  elements.length = 0;
  sandbox.renderLoreumLite({ ...state, view: "dashboard" });
  const overview = elements.map((node) => node.textContent || "").join("\n");
  assert.doesNotMatch(overview, /observed tool calls|\bexec\b|100 calls/);
  assert.match(overview, /3 sessions found in the local log sample/);
  state.data.usage.sessions = [];
  state.data.usage.totals.total_tokens = null;
  elements.length = 0;
  sandbox.renderLoreumLite(state);
  assert.equal(
    elements.find((node) => node.className === "metric-value").textContent,
    "Not recorded",
  );
});
