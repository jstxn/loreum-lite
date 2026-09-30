(() => {
  const config = globalThis.LOREUM_LITE;
  const embedded = !config.web;
  const byId = (id) => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const fmt = (value) =>
    value == null ? "—" : Intl.NumberFormat().format(value);
  const date = (value) =>
    value
      ? new Date(value).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";
  const views = {
    dashboard: "Overview",
    all: "All sources",
    memory: "Context",
    skills: "Skills",
    tools: "Tools",
    hooks: "Hooks",
    usage: "Usage",
  };
  const descriptions = {
    dashboard:
      "Your Codex context, skills, tools, and hooks. All in one place.",
    all: "Search across your local Codex setup, with every source's origin and location.",
    memory: "Explore the memory and instructions stored for Codex.",
    skills: "Find the workflows and capabilities available on your machine.",
    tools: "See the servers and plugins configured for Codex.",
    hooks:
      "Explore configured lifecycle hooks and when they are intended to run.",
    usage: "A sample of saved token counters from local Codex session logs.",
  };
  let data;
  let view = Object.hasOwn(views, location.hash.slice(1))
    ? location.hash.slice(1)
    : "dashboard";
  let selected;
  let excerpt;
  let detailGeneration = 0;
  let hostCapabilities = {};
  let requestId = 0;
  let initialized = false;
  const pending = new Map();

  function showLoading() {
    if (data) return;
    byId("loading").hidden = false;
    byId("loading").setAttribute("aria-busy", "true");
    byId("loading-title").textContent = "Loading your context";
    byId("loading-message").textContent =
      "Reading your local sources. This can take a moment.";
    byId("loading-indicator").hidden = false;
    byId("retry").hidden = true;
    byId("workspace").hidden = true;
    byId("nav").hidden = true;
  }

  function loadError(error) {
    byId("status").textContent = error.message;
    if (data) return;
    byId("loading").setAttribute("aria-busy", "false");
    byId("loading-title").textContent = "Couldn't load your context";
    byId("loading-message").textContent = error.message;
    byId("loading-indicator").hidden = true;
    byId("retry").hidden = false;
  }

  function applyHostContext(context = {}) {
    const root = document.documentElement;
    if (["light", "dark"].includes(context.theme))
      root.style.colorScheme = context.theme;
    for (const name of [
      "--color-background-primary",
      "--color-background-secondary",
      "--color-text-primary",
      "--color-text-secondary",
      "--color-border-primary",
      "--font-sans",
      "--font-mono",
    ]) {
      const value = context.styles?.variables?.[name];
      if (typeof value === "string") root.style.setProperty(name, value);
    }
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            "The host did not respond. Reopen the panel or use the local preview.",
          ),
        );
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  }

  async function tool(name, args = {}) {
    if (embedded) {
      const result = await request("tools/call", { name, arguments: args });
      if (result.isError)
        throw new Error(
          result.content?.[0]?.text || "The source could not be read.",
        );
      return result;
    }
    const response = await fetch("/api/tool", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ name, arguments: args }),
    });
    const result = await response.json();
    if (!response.ok || result.isError)
      throw new Error(
        result.error ||
          result.content?.[0]?.text ||
          "The local reader is unavailable.",
      );
    return result;
  }

  function accept(result) {
    const next = result?._meta?.dashboard;
    // Older saved tool results have no hook inventory; the startup query fetches current data.
    if (!next || !Array.isArray(next.hooks)) return;
    data = next;
    byId("project").textContent = data.project
      ? `${data.project.split("/").at(-1)} · Change project`
      : "Personal · Choose project";
    byId("project").title =
      data.project || "Personal Codex context. Add a project optionally.";
    byId("status").textContent =
      `Updated ${date(data.capturedAt)}${data.issues.length ? ` · ${data.issues.join(" ")}` : ""}`;
    render();
    byId("loading").setAttribute("aria-busy", "false");
    byId("loading").hidden = true;
    byId("workspace").hidden = false;
    byId("nav").hidden = false;
    byId("project").disabled = false;
    byId("refresh").disabled = false;
  }

  window.addEventListener("message", (event) => {
    if (!embedded || event.source !== window.parent) return;
    const message = event.data;
    if (message?.jsonrpc !== "2.0") return;
    if (pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error)
        item.reject(new Error(message.error.message || "Host request failed."));
      else item.resolve(message.result);
    } else if (message.method === "ui/notifications/tool-result")
      accept(message.params);
    else if (message.method === "ui/notifications/host-context-changed")
      applyHostContext(message.params);
    else if (message.method === "ping" && message.id != null)
      window.parent.postMessage(
        { jsonrpc: "2.0", id: message.id, result: {} },
        "*",
      );
  });

  function navigate(next) {
    clearPreview();
    view = next;
    location.hash = next;
    byId("search").value = "";
    render();
    byId("nav")
      .querySelector('[aria-current="page"]')
      .focus({ preventScroll: true });
  }

  function render() {
    if (data)
      globalThis.renderLoreumLite({
        el,
        fmt,
        date,
        byId,
        views,
        descriptions,
        data,
        view,
        selected,
        navigate,
        showDetail,
      });
  }

  async function loadExcerpt(offset = 0) {
    const generation = ++detailGeneration;
    const source = selected;
    byId("detail-status").textContent = "Reading source…";
    byId("copy").disabled = true;
    byId("attach").disabled = true;
    try {
      const result = await tool("loreum_lite_read", { id: source.id, offset });
      if (generation !== detailGeneration) return;
      excerpt = result.structuredContent;
      byId("detail-body").replaceChildren(el("pre", excerpt.text));
      byId("more").hidden = excerpt.nextOffset == null;
      byId("copy").disabled = false;
      byId("attach").disabled = false;
      byId("detail-status").textContent =
        `Characters ${fmt(excerpt.offset + 1)}–${fmt(excerpt.offset + excerpt.text.length)}${excerpt.redacted ? " · secret-like strings redacted" : ""}${excerpt.truncated ? " · source exceeds the preview byte limit" : ""}${excerpt.instructionTruncated ? " · Codex instruction limit truncates this file" : ""}`;
    } catch (error) {
      if (generation === detailGeneration)
        byId("detail-status").textContent = error.message;
    }
  }

  async function showDetail(row) {
    detailGeneration++;
    selected = row;
    excerpt = null;
    byId("detail-title").textContent = row.name || row.id;
    byId("detail-type").textContent = row.path?.includes("/instructions/")
      ? "Instructions"
      : {
          memory: "Saved context",
          guidance: "Instructions",
          skill: "Skill",
          tool: "MCP server",
          plugin: "Plugin",
          hook: "Hook",
        }[row.kind] || "Source";
    byId("detail-description").textContent =
      row.description ||
      (row.kind === "tool" || row.kind === "plugin"
        ? "Configured on disk. Availability in this chat is determined by Codex."
        : "A local source available to your agent.");
    byId("detail-description").textContent +=
      ` ${row.origin || "Personal"} · ${row.enabled === false ? "Disabled" : row.kind === "hook" ? "Configured · Trust unknown" : row.enabled === true ? "Enabled" : "Availability unknown"}${row.installed ? " · Installed" : ""}${row.version ? ` · ${row.version}` : ""}. Availability in this chat is unknown.`;
    byId("detail-path").textContent =
      row.path || row.sessionId || "Recorded metadata";
    byId("detail-body").replaceChildren();
    byId("detail-status").textContent = "";
    byId("more").hidden = true;
    const source = ["memory", "guidance", "skill"].includes(row.kind);
    byId("copy").hidden = !source;
    byId("attach").hidden =
      !source || !hostCapabilities.updateModelContext?.text;
    byId("detail").hidden = false;
    byId("workspace").classList.add("has-selection");
    for (const button of byId("content").querySelectorAll(".source-row"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.sourceId === row.id),
      );
    if (source) await loadExcerpt();
    else {
      const list = el("dl", null, "detail-meta");
      for (const [name, value] of [
        ...(row.kind === "hook"
          ? [
              ["Event", row.event],
              ["Matcher", row.matcher || "All occurrences"],
              ["Handler", row.handlerType],
              ["Trust / execution", "Unknown; review in Codex's hook controls"],
              [
                "Background",
                row.async == null ? "Not specified" : row.async ? "Yes" : "No",
              ],
              [
                "Timeout",
                row.timeout == null
                  ? "Codex default"
                  : `${row.timeout} seconds`,
              ],
            ]
          : []),
        [
          "Configuration",
          row.enabled == null
            ? row.kind === "hook"
              ? "Configured"
              : "Availability unknown"
            : row.enabled
              ? "Enabled"
              : "Disabled",
        ],
        ["Available in this chat", "Unknown"],
        ["Origin", row.origin || "Personal"],
        ["Installation", row.installed ? "Installed" : "Not confirmed"],
        ["Source", row.path],
      ]) {
        const item = el("div");
        item.append(el("dt", name), el("dd", value));
        list.append(item);
      }
      byId("detail-body").append(list);
    }
  }

  function clearPreview() {
    detailGeneration++;
    selected = null;
    excerpt = null;
    byId("detail").hidden = true;
    byId("workspace").classList.remove("has-selection");
    for (const button of byId("content").querySelectorAll(".source-row"))
      button.setAttribute("aria-pressed", "false");
  }

  byId("search").addEventListener("input", render);
  byId("show-disabled").addEventListener("change", () => {
    clearPreview();
    render();
  });
  byId("project").onclick = () => {
    byId("project-path").value = data?.project || "";
    byId("project-error").textContent = "";
    byId("project-dialog").showModal();
  };
  byId("cancel-project").onclick = () => byId("project-dialog").close();
  async function chooseProject(project) {
    byId("select-project").disabled = true;
    byId("personal-scope").disabled = true;
    byId("project-error").textContent = "";
    try {
      const result = await tool("loreum_lite_project", { project });
      clearPreview();
      accept(result);
      byId("project-dialog").close();
    } catch (error) {
      byId("project-error").textContent = error.message;
    } finally {
      byId("select-project").disabled = false;
      byId("personal-scope").disabled = false;
    }
  }
  byId("project-form").addEventListener("submit", (event) => {
    event.preventDefault();
    chooseProject(byId("project-path").value);
  });
  byId("personal-scope").onclick = () => chooseProject(null);
  byId("close-detail").onclick = clearPreview;
  byId("more").onclick = () => {
    if (excerpt?.nextOffset != null) loadExcerpt(excerpt.nextOffset);
  };
  byId("copy").onclick = async () => {
    if (!excerpt) return;
    try {
      await navigator.clipboard.writeText(`${excerpt.path}\n\n${excerpt.text}`);
      byId("detail-status").textContent = "Excerpt copied.";
    } catch {
      byId("detail-status").textContent =
        "Clipboard unavailable. Select the excerpt and copy it.";
    }
  };
  byId("attach").onclick = async () => {
    if (!excerpt) return;
    try {
      await request("ui/update-model-context", {
        content: [
          {
            type: "text",
            text: `Source: ${excerpt.path}\n\n${excerpt.text}`,
            _meta: { "openai/title": excerpt.name },
          },
        ],
      });
      byId("detail-status").textContent =
        "This excerpt was supplied as context for this chat. A new selection replaces it.";
    } catch (error) {
      byId("detail-status").textContent = error.message;
    }
  };
  byId("refresh").onclick = async () => {
    byId("refresh").disabled = true;
    byId("status").textContent = "Reading local sources…";
    try {
      accept(await tool("loreum_lite_dashboard"));
    } catch (error) {
      byId("status").textContent = error.message;
    } finally {
      byId("refresh").disabled = false;
    }
  };
  window.addEventListener("hashchange", () => {
    const next = location.hash.slice(1);
    if (Object.hasOwn(views, next) && next !== view) {
      clearPreview();
      view = next;
      byId("search").value = "";
      render();
    }
  });

  async function start() {
    showLoading();
    if (!embedded || initialized) {
      accept(await tool("loreum_lite_dashboard"));
      return;
    }
    const result = await request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "Loreum Lite", version: "0.3.5" },
      appCapabilities: { availableDisplayModes: ["fullscreen"] },
    });
    initialized = true;
    hostCapabilities = result.hostCapabilities || {};
    applyHostContext(result.hostContext);
    window.parent.postMessage(
      { jsonrpc: "2.0", method: "ui/notifications/initialized" },
      "*",
    );
    if (
      result.hostContext?.displayMode === "inline" &&
      result.hostContext?.availableDisplayModes?.includes("fullscreen")
    ) {
      request("ui/request-display-mode", { mode: "fullscreen" }).catch(
        () => {},
      );
    }
    // ponytail: the opener supplies the first snapshot; query only for an empty remount.
    setTimeout(() => {
      if (!data && hostCapabilities.serverTools)
        tool("loreum_lite_dashboard").then(accept).catch(loadError);
    }, 1500);
  }
  byId("retry").onclick = () => start().catch(loadError);
  start().catch(loadError);
})();
