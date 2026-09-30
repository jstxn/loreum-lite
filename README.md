# Loreum Lite

See the context, skills, tools, plugins, and hooks stored for your Codex setup in one searchable dashboard.

**Early beta · 0.3.5 · Codex desktop on macOS.** The interface has been used in Codex locally. A fresh installation on another machine has not been verified. Windows, Linux desktop, ChatGPT web/mobile, and Codex cloud are unverified.

## Install

The plugin runs locally and needs `node` available to the desktop app. Node 24.15.0 is the tested version. No account, API key, hosted backend, or `npm install` is needed. The commands below require the Codex CLI; packaging was checked with CLI 0.159.0.

```sh
codex plugin marketplace add jstxn/loreum-lite --ref v0.3.5
codex plugin add loreum-lite@loreum-lite
```

Restart Codex, open a fresh local chat, select **Loreum Lite**, and ask **“Open my context dashboard.”** Its sidebar entry opens the same viewer when the host supports that entrypoint.

If you downloaded the marketplace ZIP, extract it and replace `jstxn/loreum-lite --ref v0.3.5` in the first command with the extracted folder's absolute path.

## What you can see

- Search across saved context, instructions, skills, configured MCP servers, installed plugins, and hook definitions.
- Browse each category and preview memory, instruction, and skill excerpts with their original locations.
- Include a project folder, or stay in personal scope. Source files remain unchanged.
- Inspect sampled token counters from local Codex session logs, with their coverage and timestamps.

This is an inventory of stored and configured sources. It does not show the exact context loaded in a chat. Hook trust and execution are unknown. Managed, remote, and session overrides are not reconstructed. ChatGPT saved memory and account quotas are unavailable.

Installed plugin discovery uses `codex plugin list --json` when available. If that lookup is unavailable, the viewer still shows personal/project files and explicit configuration, with a coverage notice; cached plugin copies are excluded.

## Privacy

Loreum Lite has no publisher analytics, hosted storage, or external assets. It reads local source metadata and bounded excerpts. Some metadata is returned through Codex tools; selected excerpts enter the host's processing environment when read or attached to a chat. Common secret formats are redacted, but ordinary private text is not anonymized.

Do not include private context, credentials, or raw session logs in public bug reports. Details of discovery limits and source handling are in [the plugin README](plugins/loreum-lite/README.md).

## Feedback

Open an issue in this repository with your operating system, Codex version, plugin version, and the action that failed. For missing sources, describe the expected source type and location pattern. Redact usernames, project names, excerpts, and access tokens from screenshots and errors.

If the viewer does not start, check that the desktop process can find `node`, then restart Codex and try a fresh chat. If a category is incomplete, check the coverage message and try **Refresh sources**. Reopen the viewer after updates; an existing panel can retain older UI.

## Checks

The package includes 18 plugin tests covering discovery, safety, standalone startup, UI messaging, and usage accounting. Run them with Node:

```sh
node --test --test-concurrency=1 plugins/loreum-lite/*.test.mjs
```

CI runs these tests on macOS and Linux. Passing CI does not establish desktop host compatibility or a fresh-machine installation.
