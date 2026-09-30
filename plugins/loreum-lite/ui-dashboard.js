globalThis.renderLoreumDashboard = ({
  el,
  fmt,
  date,
  data,
  counts,
  navigate,
  showDetail,
  sourceRow,
  content,
}) => {
  const context = data.records.filter((row) => row.kind !== "skill");
  const instructions = context.filter(
    (row) => row.kind === "guidance" || row.path.includes("/instructions/"),
  ).length;
  const pluginSkills = data.records.filter(
    (row) => row.kind === "skill" && row.installed,
  ).length;
  const servers = data.tools.filter((row) => row.kind === "tool").length;
  const sessions = data.usage.sessions;
  const cards = el("div", null, "dashboard-cards");
  for (const [key, name, value, description, note] of [
    [
      "memory",
      "Context",
      counts.memory,
      "stored sources",
      `${fmt(instructions)} instruction files · ${fmt(context.length - instructions)} saved context`,
    ],
    [
      "skills",
      "Skills",
      counts.skills,
      "skill sources",
      `${fmt(counts.skills - pluginSkills)} personal or project · ${fmt(pluginSkills)} from plugins`,
    ],
    [
      "tools",
      "Tools",
      counts.tools,
      "servers & plugins",
      `${fmt(servers)} MCP servers · ${fmt(counts.tools - servers)} plugins`,
    ],
    [
      "hooks",
      "Hooks",
      counts.hooks ?? 0,
      "configured handlers",
      "Lifecycle events · trust and execution unknown",
    ],
  ]) {
    const card = el("button", null, `dashboard-card ${key}`);
    card.type = "button";
    card.onclick = () => navigate(key);
    const label = el("span", null, "card-label");
    label.append(
      el("span", null, `color-dot ${key}`),
      el("span", name),
      el("span", "↗", "card-arrow"),
    );
    card.append(
      label,
      el("span", fmt(value), "card-value"),
      el("span", description, "card-description"),
      el("span", note, "card-note"),
    );
    cards.append(card);
  }
  content.append(cards);

  function panel(title, action, view) {
    const node = el("section", null, "dashboard-panel");
    const header = el("div", null, "panel-heading");
    header.append(el("h2", title));
    if (action) {
      const button = el("button", `${action} ↗`, "text-button");
      button.type = "button";
      button.onclick = () => navigate(view);
      header.append(button);
    }
    node.append(header);
    return node;
  }

  const columns = el("div", null, "dashboard-columns");
  const recent = panel("Recently updated context", "View all", "memory");
  recent.append(
    el(
      "p",
      "The latest changes to your memory and instructions.",
      "panel-description",
    ),
  );
  const rows = [...context]
    .sort((a, b) => (b.modifiedAt || "").localeCompare(a.modifiedAt || ""))
    .slice(0, 5);
  for (const row of rows) {
    const button = sourceRow(row);
    button.classList.add("recent-row");
    button.onclick = () => {
      navigate("memory");
      showDetail(row);
    };
    const updated = el("time", date(row.modifiedAt), "source-updated");
    if (row.modifiedAt) updated.dateTime = row.modifiedAt;
    button.append(updated);
    recent.append(button);
  }
  if (!rows.length)
    recent.append(el("p", "No local context files found yet.", "empty"));
  recent.append(
    el(
      "p",
      "Open a file to preview its contents and original location.",
      "panel-footnote",
    ),
  );

  const side = el("div", null, "dashboard-side");
  const library = panel("Your local library", "Browse all sources", "all");
  const total = el("p", null, "library-total");
  total.append(
    el("strong", fmt(data.records.length)),
    el("span", " source files"),
  );
  library.append(total);
  const breakdown = [
    ["Instructions", instructions, "memory"],
    ["Saved context", context.length - instructions, "usage"],
    ["Skills", counts.skills, "skills"],
  ];
  const track = el("div", null, "library-track");
  track.setAttribute("aria-hidden", "true");
  library.append(track);
  for (const [name, count, key] of breakdown) {
    const segment = el("span", null, `library-segment ${key}`);
    segment.style.width = `${(count / Math.max(1, data.records.length)) * 100}%`;
    track.append(segment);
    const legend = el("div", null, "library-legend");
    const label = el("span", null, "legend-label");
    label.append(el("span", null, `color-dot ${key}`), el("span", name));
    legend.append(label, el("span", fmt(count)));
    library.append(legend);
  }

  const activity = panel("Recorded sessions", "View usage", "usage");
  activity.append(
    el(
      "p",
      `${fmt(sessions.length)} sessions found in the local log sample.`,
      "panel-description",
    ),
  );
  for (const row of sessions.slice(0, 3)) {
    const item = el("div", null, "session-row");
    const name = el("div", row.name);
    name.append(el("div", date(row.usageAt || row.modifiedAt), "source-path"));
    item.append(
      name,
      el(
        "span",
        row.usage?.total_tokens == null
          ? "Not recorded"
          : `${fmt(row.usage.total_tokens)} tokens`,
      ),
    );
    activity.append(item);
  }
  if (!sessions.length)
    activity.append(el("p", "No recent session records found yet.", "empty"));
  side.append(library, activity);
  columns.append(recent, side);
  content.append(columns);
  const note = el("div", null, "dashboard-note");
  note.append(
    el("span", null, "color-dot tools"),
    el(
      "p",
      "These sources live on your machine. What your agent loads depends on the chat and task.",
    ),
  );
  content.append(note);
};
