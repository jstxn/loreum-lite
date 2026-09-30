# Loreum Lite

A personal, read-only inventory of the memories, instructions, skills, tools, plugins, and hooks stored for Codex. **All sources** searches across categories; dedicated tabs keep each category easy to browse. Overview shows context, skill, tool, and hook counts, with recorded usage as a secondary view. It reads existing sources rather than creating a new memory store. The package runs independently of the Loreum team application, without a backend, API key, recorder, or dependency installation. Node **24.15.0** is the tested runtime; the host must be able to run `node`.

## Install and open

Install **Loreum Lite** from a marketplace that distributes this package. Open its sidebar entry, or select it in a fresh local Codex chat and ask “Open my context dashboard.” Personal context loads automatically. No repository path or account setup is required.

The initial view shows animated accent dots while local sources load. If startup fails, it shows the error and a **Retry** button. The loader respects reduced-motion settings, and refreshes keep the existing dashboard visible.

For a local source checkout, register its marketplace and install:

```sh
codex plugin marketplace add /path/to/marketplace
codex plugin add loreum-lite@loreum-lite
```

Reload/restart the host after a local update and test in a fresh chat. Installed plugins use a copy; editing source does not update an already running MCP process. The portable `plugin.json` and `mcp.json` are the package entrypoints; `.codex-plugin/plugin.json` supports older hosts. The beta marketplace is `.agents/plugins/marketplace.json` at the standalone repository root. There is no public directory listing yet.

The dashboard, app entrypoint, and composer share `assets/icon.svg`, the outlined L with the pink dot. The opener registers global/thread MCP App entrypoints and a fullscreen preference. Hosts without MCP Apps can use `loreum_lite_browse` and `loreum_lite_read`. Native rendering and context attachment need separate host verification; protocol tests do not establish desktop compatibility.

## Personal and project scope

Loreum Lite respects `CODEX_HOME`, otherwise using `~/.codex`. It opens in **Personal** scope even when the plugin runs from an installation/cache folder.

- **Memory:** Markdown under the Codex home's `memories` directory. Empty stores are supported. Memory settings remain under Codex's own controls; native ChatGPT saved memory is separate and unavailable here.
- **Instructions:** The first non-empty global `AGENTS.override.md` or `AGENTS.md`. A selected project adds the instruction chain from the Git root to the selected working folder, honoring overrides, configured fallback filenames, and the instruction byte limit. Full source previews remain readable; metadata identifies where the instruction limit truncates a source.
- **Skills:** User `.agents/skills`, the Codex home's skill directory for compatibility/built-ins, admin `/etc/codex/skills`, and project `.agents/skills` directories along the repository chain. Canonical aliases deduplicate; independent definitions with the same name remain separate.
- **Hooks:** Personal and selected-project `hooks.json`, ordinary inline hook array tables in `config.toml`, and hooks from selected installed plugin versions. Plugin manifest overrides support relative paths and inline objects; an explicit value replaces default `hooks/hooks.json` discovery. Hook rows show event, matcher, handler type, status message, background setting, and timeout. Commands and MCP inputs are never exposed or executed. The scan includes at most 400 handlers; unreadable, oversized, or unsupported sources mark coverage partial.

Use **Choose project** to optionally enter a repository or working-folder path. Invalid selections leave the current scope intact. **Personal only** clears the project. The choice lasts for the MCP viewer session and writes no configuration. The MCP App interface currently provides no verified active-project path, so Loreum Lite does not guess from another chat, session log, or its installation directory. Files such as `TODO.md`, `CLAUDE.md`, and `PROJECT_CONTEXT.md` are not automatically treated as Codex instructions; an explicitly configured fallback can be included.

See official [memory storage](https://learn.chatgpt.com/docs/customization/memories), [instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [skill discovery](https://learn.chatgpt.com/docs/build-skills), and [hook configuration](https://learn.chatgpt.com/docs/hooks).

## Origin and status

Rows distinguish **Personal**, **Project**, **Plugin**, **Built-in**, and **Admin** sources. **Installed** identifies a source from a plugin Codex reports installed. **Enabled/Disabled** reflects a reported or explicit setting; **Availability unknown** is used when no enablement information is available. Availability and loading in the current chat remain unknown in every case.

Hooks are marked **Configured · Trust unknown**, or **Disabled** when their parent plugin or the inspected hook feature setting is off. Installing a plugin does not establish hook trust. This viewer does not read hook trust hashes, change approvals, or reconstruct managed, remote, or session overrides. Review hooks using Codex's own hook controls. Unsupported handler types remain visible as definitions without implying Codex can execute them.

When `codex plugin list --json` is available, Loreum Lite uses the installed plugin identity and version, and selects that version's skills. It never scans every cached version. The CLI lookup is optional and bounded: if unavailable, personal/project sources and explicit configuration remain usable, and the dashboard explains that cached plugin copies are excluded. No extra CLI installation is required to open the viewer.

Disabled entries are hidden by default in both source lists and overview counts. **Show disabled** includes them. Search matches names, descriptions, paths, and metadata, not full source bodies. The configuration reader inspects only discovery settings, skill enablement, MCP/plugin headers, and enabled flags. It is a bounded parser, not full TOML validation or reconstruction of managed/trusted configuration precedence. Commands, arguments, connection URLs, environment values, and credential files are not exposed.

## Usage, reading, and privacy

Usage is a sample of at most 24 newest rollout filenames, inspecting up to the last 8 MiB of each log. It counts each session's latest saved token counters once, shows how many files and sessions contribute, and lists the original log path and counter timestamp. Search filters the session list; aggregate cards still cover the whole sample. Missing counters are labeled **Not recorded**, never zero. Generic tool-call rankings and counts are omitted. Account quotas, invoices, spend, full prompts, and per-tool token cost are unavailable. Cache and reasoning counters remain subsets and are not added twice.

Source reads accept catalog IDs, never arbitrary file paths. They reject symlink escapes and special files, redact common secret formats, and return up to 12,000 characters per excerpt from the first 512 KiB. Redaction does not make arbitrary private prose safe to share. The optional browser preview binds to `127.0.0.1`, requires its generated token, rejects foreign origins, and loads no external assets. Choosing a project changes approved discovery scope; source files are never modified.

**Use in this chat** appears only when the host advertises text context updates. It supplies the selected excerpt without sending a message or editing persistent memory. Selected text then enters the host's processing environment. This viewer describes stored sources, not the exact context loaded in a chat.

## Development and verification

From this plugin directory, `node server.mjs --web` opens a personal-scope loopback preview. Add `--project /path/to/project` to explicitly select a project. Stop it with Ctrl+C. `LOREUM_LITE_HOME` and `LOREUM_LITE_CODEX_HOME` isolate test fixtures; they are not installation requirements.

```sh
node --test --test-concurrency=1 *.test.mjs
```

Checks cover personal defaults, instruction chains and limits, safe project switching, installed-version selection, hook definitions and overrides, unified browsing, disabled filters, independent same-name skills, redaction, source-ID restrictions, symlink escapes, missing stores, session accounting, loopback access controls, host styling, and an isolated standalone stdio package. They do not replace native host or fresh-machine installation testing.
