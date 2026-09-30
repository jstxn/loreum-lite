globalThis.renderLoreumLite = ({
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
}) => {
  const query = byId("search").value.toLowerCase();
  const showDisabled = byId("show-disabled").checked;
  const stored = data;
  data = {
    ...data,
    records: data.records.filter(
      (row) => showDisabled || row.enabled !== false,
    ),
    tools: data.tools.filter((row) => showDisabled || row.enabled !== false),
    hooks: (data.hooks || []).filter(
      (row) => showDisabled || row.enabled !== false,
    ),
  };
  byId("disabled-option").hidden = ![
    "all",
    "skills",
    "tools",
    "hooks",
  ].includes(view);
  const matches = (row) =>
    !query || JSON.stringify(row).toLowerCase().includes(query);
  const counts = {
    memory: data.records.filter((row) => row.kind !== "skill").length,
    skills: data.records.filter((row) => row.kind === "skill").length,
    tools: data.tools.length,
    hooks: data.hooks.length,
    all: data.records.length + data.tools.length + data.hooks.length,
  };

  function icon(kind) {
    const paths = {
      memory:
        "M4 5h6a3 3 0 0 1 3 3v12a4 4 0 0 0-4-2H4z M13 8a3 3 0 0 1 3-3h4v13h-4a3 3 0 0 0-3 2",
      guidance: "M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h5",
      skill: "m13 2-8 12h6l-1 8 9-13h-7z",
      tool: "M8 3v5 M16 3v5 M6 8h12v4a6 6 0 0 1-12 0z M12 18v4",
      plugin: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
      hook: "M8 3v10a5 5 0 0 0 10 0V9 M15 12l3-3 3 3 M5 3h6",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[kind] || paths.guidance);
    svg.append(path);
    return svg;
  }

  function shortPath(path) {
    if (!path) return "";
    if (data.project && path.startsWith(`${data.project}/`))
      return `${data.project.split("/").at(-1)}/${path.slice(data.project.length + 1)}`;
    return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  }

  function sourceRow(row) {
    const button = el("button", null, "source-row");
    button.type = "button";
    button.dataset.sourceId = row.id;
    button.dataset.kind = row.kind;
    button.setAttribute("aria-pressed", String(selected?.id === row.id));
    button.onclick = () => showDetail(row);
    const copy = el("span", null, "source-copy");
    const name =
      row.kind === "guidance" ? row.path.split("/").at(-1) : row.name;
    copy.append(el("span", name, "source-name"));
    const description =
      row.description ||
      (row.kind === "guidance" && row.name !== name ? row.name : "");
    if (description) copy.append(el("span", description, "source-description"));
    const path = el("span", shortPath(row.path), "source-path");
    path.title = row.path;
    const meta = el("span", null, "source-meta");
    if (row.origin) meta.append(el("span", row.origin, "source-badge"));
    if (row.version) meta.append(el("span", row.version, "source-badge"));
    if (row.installed) meta.append(el("span", "Installed", "source-badge"));
    if (row.kind === "hook")
      meta.append(el("span", "Trust unknown", "source-badge"));
    else if (
      row.enabled == null &&
      ["skill", "tool", "plugin"].includes(row.kind)
    )
      meta.append(el("span", "Availability unknown", "source-badge"));
    meta.append(path);
    copy.append(meta);
    const mark = el("span", null, "source-icon");
    mark.append(icon(row.kind));
    button.append(mark, copy);
    if (row.enabled != null)
      button.append(el("span", row.enabled ? "Enabled" : "Disabled", "state"));
    const arrow = el("span", "›", "source-arrow");
    arrow.setAttribute("aria-hidden", "true");
    button.append(arrow);
    return button;
  }

  function sourceGroups(content) {
    const all = [...data.records, ...data.tools, ...data.hooks];
    const kindGroup = {
      guidance: "Instructions",
      memory: "Saved context",
      skill: "Skills",
      tool: "MCP servers",
      plugin: "Plugins",
      hook: "Hooks",
    };
    const groups = new Map(
      view === "all"
        ? Object.values(kindGroup).map((name) => [name, []])
        : view === "hooks"
          ? [...new Set(data.hooks.map((row) => row.event))].map((name) => [
              name,
              [],
            ])
          : view === "memory"
            ? [
                ["Personal instructions", []],
                ["Project guidance", []],
                ["Saved context", []],
              ]
            : view === "skills"
              ? [
                  ["Your skills", []],
                  ["Project skills", []],
                  ["Plugin skills", []],
                  ["Built-in skills", []],
                  ["Admin skills", []],
                ]
              : [
                  ["MCP servers", []],
                  ["Plugins", []],
                ],
    );
    const rows = (
      view === "all"
        ? all
        : view === "hooks"
          ? data.hooks
          : view === "tools"
            ? data.tools
            : data.records.filter(
                (row) => (row.kind === "skill") === (view === "skills"),
              )
    ).filter(matches);
    for (const row of rows) {
      const project = row.origin === "Project";
      let group;
      if (view === "all") group = kindGroup[row.kind];
      else if (view === "hooks") group = row.event;
      else if (view === "tools")
        group = row.kind === "tool" ? "MCP servers" : "Plugins";
      else if (view === "skills") {
        group = "Your skills";
        if (project) group = "Project skills";
        else if (row.origin === "Built-in") group = "Built-in skills";
        else if (row.origin === "Admin") group = "Admin skills";
        else if (row.origin === "Plugin") group = "Plugin skills";
      } else if (project) group = "Project guidance";
      else
        group =
          row.kind === "guidance" || row.path.includes("/instructions/")
            ? "Personal instructions"
            : "Saved context";
      groups.get(group).push(row);
    }
    const noun = view === "tools" ? "configured item" : "source";
    byId("list-summary").textContent =
      `${fmt(rows.length)} ${query ? "matching " : ""}${noun}${rows.length === 1 ? "" : "s"}`;
    for (const [name, sources] of groups) {
      if (!sources.length) continue;
      const group = el("section", null, "source-group");
      group.dataset.kind = sources[0].kind;
      const heading = el("h2", null, "group-heading");
      heading.append(el("span", name), el("span", fmt(sources.length)));
      group.append(heading);
      for (const row of sources) group.append(sourceRow(row));
      content.append(group);
    }
    if (!rows.length)
      content.append(
        el(
          "p",
          query
            ? "No sources match. Try a name, description, or file path."
            : "No sources found in this view. Refresh after adding a local source.",
          "empty",
        ),
      );
    const disabled = [
      ...stored.records,
      ...stored.tools,
      ...(stored.hooks || []),
    ].filter((row) => row.enabled === false).length;
    if (
      disabled &&
      !showDisabled &&
      ["all", "skills", "tools", "hooks"].includes(view)
    )
      content.append(
        el(
          "p",
          "Disabled sources are hidden. Select Show disabled to include them.",
          "note",
        ),
      );
    if (
      ["all", "skills", "tools", "hooks"].includes(view) &&
      data.coverage.pluginInventory === "unavailable"
    )
      content.append(
        el(
          "p",
          "Codex plugin inventory is unavailable. Cached plugin copies are excluded; known configuration and local sources remain visible.",
          "note",
        ),
      );
    if (["all", "hooks"].includes(view))
      content.append(
        el(
          "p",
          "Hook definitions are configured sources. Trust, project trust, and execution are not verified. Managed, remote, and session overrides are not included.",
          "note",
        ),
      );
  }

  function section(title) {
    const node = el("section", null, "section");
    node.append(el("h2", title));
    return node;
  }

  function usageView(content) {
    const u = data.usage;
    const metrics = el("div", null, "metrics");
    for (const [name, value, note] of [
      [
        "Tokens in this sample",
        u.totals.total_tokens,
        "Latest saved totals per session",
      ],
      [
        "Input tokens",
        u.totals.input_tokens,
        "Sent to the model, including cached input",
      ],
      [
        "Cached input",
        u.totals.cached_input_tokens,
        "Reused input; already included in input tokens",
      ],
      [
        "Output tokens",
        u.totals.output_tokens,
        "Generated by the model, including reasoning",
      ],
    ]) {
      const metric = el("div", null, "metric");
      const number = el(
        "div",
        value >= 1_000_000
          ? Intl.NumberFormat(undefined, {
              notation: "compact",
              maximumFractionDigits: 1,
            }).format(value)
          : value == null
            ? "Not recorded"
            : fmt(value),
        "metric-value",
      );
      number.title = fmt(value);
      metric.append(
        el("div", name, "metric-label"),
        number,
        el("div", note, "metric-note"),
      );
      metrics.append(metric);
    }
    content.append(
      metrics,
      el(
        "p",
        `Read from local Codex session logs: ${fmt(u.coverage.selectedFiles)} files inspected, ${fmt(u.coverage.sessionsWithCounters)} sessions with saved token counters. Totals cover the whole sample; search filters only the session list. This is not your account usage, remaining quota, or spend.`,
        "note",
      ),
      el(
        "p",
        `Up to 24 files, selected by newest session filename; up to the last 8 MiB of each file is read. Each session contributes its latest saved counters once. ${u.coverage.partial ? "Some history is omitted from this sample. " : ""}Missing counters are shown as Not recorded, not zero.`,
        "note",
      ),
    );
    const sessions = section("Recorded sessions");
    const rows = u.sessions.filter(matches);
    for (const row of rows) {
      const item = el("div", null, "session-row");
      const name = el("div", row.name);
      const path = el("div", shortPath(row.path), "source-path");
      path.title = row.path;
      name.append(
        el(
          "div",
          `${row.usageAt ? "Counters saved" : "Log updated"} ${date(row.usageAt || row.modifiedAt)}`,
          "source-path",
        ),
        path,
      );
      item.append(
        name,
        el(
          "span",
          row.usage?.total_tokens == null
            ? "Not recorded"
            : `${fmt(row.usage.total_tokens)} tokens`,
        ),
      );
      sessions.append(item);
    }
    if (!rows.length)
      sessions.append(
        el(
          "p",
          query
            ? "No recorded sessions match your search."
            : "No recent Codex session records found.",
          "empty",
        ),
      );
    content.append(sessions);
    byId("list-summary").textContent =
      `${fmt(rows.length)}${query ? ` of ${fmt(u.sessions.length)}` : ""} recorded sessions`;
  }

  byId("subtitle").textContent = descriptions[view];
  byId("page-title").className = view;
  byId("page-title").textContent = {
    dashboard: "Your Codex setup",
    all: "All your sources",
    memory: "Your context",
    skills: "Your skills",
    tools: "Tools & plugins",
    hooks: "Your hooks",
    usage: "Recorded token usage",
  }[view];
  byId("search").placeholder =
    view === "usage"
      ? "Search recorded sessions…"
      : `Search ${views[view].toLowerCase()}…`;
  byId("workspace").className =
    `workspace ${view}${selected ? " has-selection" : ""}`;
  const nav = byId("nav");
  nav.replaceChildren();
  for (const [key, name] of Object.entries(views)) {
    const button = el("button");
    button.className = key;
    button.type = "button";
    if (key !== "dashboard")
      button.append(el("span", null, `color-dot ${key}`));
    button.append(el("span", name));
    if (key === view) button.setAttribute("aria-current", "page");
    if (counts[key] != null)
      button.append(el("span", fmt(counts[key]), "nav-count"));
    button.onclick = () => navigate(key);
    nav.append(button);
  }
  const content = byId("content");
  content.replaceChildren();
  if (view === "dashboard")
    globalThis.renderLoreumDashboard({
      el,
      fmt,
      date,
      data,
      counts,
      navigate,
      showDetail,
      sourceRow,
      content,
    });
  else if (view === "usage") usageView(content);
  else sourceGroups(content);
  byId("coverage").textContent =
    view === "usage"
      ? `${data.usage.coverage.selectedFiles} local session logs${data.usage.coverage.partial ? " · Some history omitted" : ""}`
      : `${data.coverage.memoryPartial || data.coverage.skillsPartial || data.coverage.hooksPartial ? "Some sources omitted · " : ""}Stored on disk · Read only`;
};
