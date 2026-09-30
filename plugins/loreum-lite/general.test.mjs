import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCatalog } from "./catalog.mjs";
import { createHandler, UI_URI } from "./server.mjs";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const skill = (name) =>
  `---\nname: ${name}\ndescription: A useful workflow\n---\n# Workflow\n`;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lite-general-")));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const file = async (path, body) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  };
  await file(
    join(codexHome, "memories", "memory.md"),
    "# Remembered context\n",
  );
  await file(join(codexHome, "AGENTS.md"), "# Base global\n");
  await file(join(codexHome, "AGENTS.override.md"), "# Global override\n");
  await file(
    join(home, ".agents", "skills", "sample", "SKILL.md"),
    skill("same-name"),
  );
  return {
    root,
    home,
    codexHome,
    file,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("general installation opens personal Codex context without a project or machine-specific sources", async () => {
  const f = await fixture();
  try {
    await f.file(
      join(f.codexHome, "instructions", "custom.md"),
      "# Custom layout\n",
    );
    const catalog = createCatalog({ ...f, plugins: [] });
    const data = await catalog.dashboard();
    assert.equal(data.project, null);
    assert.deepEqual(
      data.records.map((r) => r.name).sort(),
      ["Global override", "Remembered context", "same-name"].sort(),
    );
    assert.ok(data.records.every((r) => r.origin === "Personal"));
    assert.ok(
      !data.records.some((r) => r.path.includes("/Development/loreum")),
    );
    const handler = createHandler(catalog);
    const selection = (await handler.dispatch("tools/list")).tools.find(
      (t) => t.name === "loreum_lite_project",
    );
    assert.deepEqual(selection._meta.ui.visibility, ["app"]);
    assert.equal(
      (await handler.call("loreum_lite_open")).structuredContent.sources,
      3,
    );
  } finally {
    await f.cleanup();
  }
});

test("optional project follows the repository instruction chain, fallbacks, overrides, and resets safely", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "repo");
    const working = join(project, "service");
    await mkdir(join(project, ".git"), { recursive: true });
    await f.file(join(project, "TEAM.md"), "# Team instructions\n");
    await f.file(join(project, "TODO.md"), "# Unrelated document\n");
    await f.file(join(working, "AGENTS.md"), "# Unused base\n");
    await f.file(join(working, "AGENTS.override.md"), "# Service override\n");
    await f.file(
      join(project, ".agents", "skills", "root", "SKILL.md"),
      skill("root-skill"),
    );
    await f.file(
      join(working, ".agents", "skills", "nested", "SKILL.md"),
      skill("nested-skill"),
    );
    await f.file(
      join(f.codexHome, "config.toml"),
      'project_doc_fallback_filenames = ["TEAM.md"]\n',
    );
    const catalog = createCatalog({ ...f, plugins: [] });
    const projectData = await catalog.setProject(working);
    assert.equal(projectData.project, working);
    assert.deepEqual(
      projectData.records
        .filter((r) => r.kind === "guidance")
        .sort((a, b) => a.instructionOrder - b.instructionOrder)
        .map((r) => r.name),
      ["Global override", "Team instructions", "Service override"],
    );
    assert.deepEqual(
      projectData.records
        .filter((r) => r.origin === "Project" && r.kind === "skill")
        .map((r) => r.name)
        .sort(),
      ["nested-skill", "root-skill"],
    );
    const chosen = projectData.records.find(
      (r) => r.name === "Service override",
    );
    await assert.rejects(
      () => catalog.setProject(join(f.root, "absent")),
      /does not exist/,
    );
    assert.equal((await catalog.dashboard()).project, working);
    await assert.rejects(
      () => catalog.setProject("relative/project"),
      /absolute/,
    );
    await assert.rejects(() => catalog.setProject(chosen.path), /folder/);
    const personal = await catalog.setProject(null);
    assert.equal(personal.project, null);
    assert.ok(personal.records.every((r) => r.origin !== "Project"));
    await assert.rejects(() => catalog.read(chosen.id), /Unknown source/);
    await f.file(
      join(f.codexHome, "config.toml"),
      "project_doc_max_bytes = 8\n",
    );
    const bounded = await createCatalog({
      ...f,
      project: working,
      plugins: [],
    }).dashboard();
    assert.equal(
      bounded.records.filter((r) => r.kind === "guidance").length,
      1,
    );
    assert.equal(
      bounded.records.find((r) => r.kind === "guidance").instructionTruncated,
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("installed versions and enablement exclude stale copies while preserving independent same-name skills", async () => {
  const f = await fixture();
  try {
    const cached = (name, version) =>
      join(
        f.codexHome,
        "plugins",
        "cache",
        "local",
        name,
        version,
        "skills",
        "sample",
        "SKILL.md",
      );
    await f.file(cached("helper", "1.0.0"), skill("stale-copy"));
    await f.file(cached("helper", "2.0.0"), skill("same-name"));
    await f.file(cached("disabled", "1.0.0"), skill("disabled-skill"));
    await f.file(cached("uninstalled", "9.0.0"), skill("uninstalled-skill"));
    const personalPath = join(
      f.home,
      ".agents",
      "skills",
      "sample",
      "SKILL.md",
    );
    await mkdir(join(f.codexHome, "skills"), { recursive: true });
    await symlink(dirname(personalPath), join(f.codexHome, "skills", "alias"));
    await f.file(
      join(f.codexHome, "config.toml"),
      `[[skills.config]]\npath = "${personalPath}"\nenabled = false\n[mcp_servers.off]\nenabled = false\n[plugins."helper@local"]\nenabled = false\n`,
    );
    const plugins = [
      {
        name: "helper",
        marketplaceName: "local",
        version: "2.0.0",
        installed: true,
        enabled: true,
      },
      {
        name: "disabled",
        marketplaceName: "local",
        version: "1.0.0",
        installed: true,
        enabled: false,
      },
    ];
    const catalog = createCatalog({ ...f, plugins });
    const data = await catalog.dashboard();
    const definitions = data.records.filter((r) => r.kind === "skill");
    assert.equal(definitions.length, 3);
    assert.equal(definitions.filter((r) => r.name === "same-name").length, 2);
    assert.equal(
      definitions.find((r) => r.origin === "Personal").enabled,
      false,
    );
    assert.equal(
      definitions.find((r) => r.plugin === "helper@local").enabled,
      true,
    );
    assert.equal(
      definitions.find((r) => r.plugin === "helper@local").version,
      "2.0.0",
    );
    assert.equal((await catalog.browse("skills")).total, 1);
    assert.equal((await catalog.browse("skills", "", true)).total, 3);
    assert.equal((await catalog.browse("tools")).total, 1);
    assert.ok(definitions.every((r) => r.availability === "unknown"));
    const unavailable = await createCatalog({
      ...f,
      plugins: null,
    }).dashboard();
    assert.equal(unavailable.coverage.pluginInventory, "unavailable");
    assert.equal(
      unavailable.records.filter((r) => r.kind === "skill").length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("a standalone package starts from its installed directory without repository configuration", async () => {
  const f = await fixture();
  try {
    const installed = join(f.root, "installed");
    await cp(pluginRoot, installed, { recursive: true });
    const mcp = JSON.parse(await readFile(join(installed, "mcp.json"), "utf8"))
      .mcpServers["loreum-lite"];
    assert.equal(mcp.env, undefined);
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "loreum_lite_open" },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: UI_URI },
      },
    ];
    const child = spawnSync(process.execPath, [join(installed, "server.mjs")], {
      cwd: installed,
      env: {
        ...process.env,
        LOREUM_LITE_HOME: f.home,
        LOREUM_LITE_CODEX_HOME: f.codexHome,
      },
      input: `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr);
    const replies = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(replies[1].result.tools.length, 5);
    assert.equal(replies[2].result._meta.dashboard.project, null);
    assert.equal(replies[2].result.structuredContent.sources, 3);
    assert.ok(
      replies[3].result.contents[0].text.includes("Choose project context"),
    );
  } finally {
    await f.cleanup();
  }
});
