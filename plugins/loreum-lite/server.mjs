import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createCatalog } from "./catalog.mjs";

export const UI_URI = "ui://loreum-lite/dashboard-0.3.5.html";
const root = dirname(fileURLToPath(import.meta.url));
const iconSvg = await readFile(resolve(root, "assets/icon.svg"), "utf8");
const schema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};
export const tools = [
  {
    name: "loreum_lite_open",
    title: "Loreum Lite",
    icons: [
      {
        src: `data:image/svg+xml,${encodeURIComponent(iconSvg)}`,
        mimeType: "image/svg+xml",
        sizes: ["64x64"],
      },
    ],
    description:
      "Open the personal local inventory for memories, guidance, skills, configured tools, plugins, and hooks. Optional usage details come from existing Codex session files. This does not reconstruct hidden model context.",
    inputSchema: schema(),
    annotations,
    _meta: {
      ui: { resourceUri: UI_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": UI_URI,
      "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
    },
  },
  {
    name: "loreum_lite_dashboard",
    title: "Refresh personal dashboard",
    description:
      "Refresh the dashboard's bounded local inventory. Full dashboard data is returned in component metadata.",
    inputSchema: schema(),
    annotations,
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "loreum_lite_browse",
    title: "Find local context",
    description:
      "Search local source metadata or recorded Codex session metadata. Returns source IDs for explicit reads; does not load source text.",
    inputSchema: schema({
      category: {
        type: "string",
        enum: ["all", "memory", "skills", "tools", "hooks", "sessions"],
      },
      query: { type: "string", maxLength: 200 },
      includeDisabled: { type: "boolean" },
    }),
    annotations,
  },
  {
    name: "loreum_lite_read",
    title: "Read a chosen source",
    description:
      "Read a bounded, redacted excerpt from a memory, guidance, or skill ID returned by browse. Only choose text relevant to the user's request. nextOffset allows another excerpt; arbitrary filesystem paths are rejected.",
    inputSchema: schema(
      {
        id: { type: "string", pattern: "^[a-f0-9]{24}$" },
        offset: { type: "integer", minimum: 0 },
      },
      ["id"],
    ),
    annotations,
  },
  {
    name: "loreum_lite_project",
    title: "Choose project scope",
    description:
      "Choose a project folder from the dashboard, or return to personal context. Changes only this viewer's scope; no source files are written.",
    inputSchema: schema(
      { project: { type: ["string", "null"], maxLength: 4096 } },
      ["project"],
    ),
    annotations,
    _meta: { ui: { visibility: ["app"] } },
  },
];

export async function renderHtml(bootstrap = { web: false }, nonce = "") {
  const [html, css, panels, sources, loading, dashboard, views, script] =
    await Promise.all([
      readFile(resolve(root, "ui.html"), "utf8"),
      readFile(resolve(root, "ui.css"), "utf8"),
      readFile(resolve(root, "ui-views.css"), "utf8"),
      readFile(resolve(root, "ui-sources.css"), "utf8"),
      readFile(resolve(root, "ui-loading.css"), "utf8"),
      readFile(resolve(root, "ui-dashboard.js"), "utf8"),
      readFile(resolve(root, "ui-views.js"), "utf8"),
      readFile(resolve(root, "ui.js"), "utf8"),
    ]);
  return html
    .replaceAll("__NONCE__", nonce)
    .replace("__BRAND_ICON__", iconSvg)
    .replace("/*__STYLE__*/", `${panels}\n${css}\n${sources}\n${loading}`)
    .replace(
      "__BOOTSTRAP__",
      JSON.stringify(bootstrap).replaceAll("<", "\\u003c"),
    )
    .replace(
      "__SCRIPT__",
      `${dashboard}\n${views}\n${script}`.replaceAll("</script", "<\\/script"),
    );
}

function validateArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Arguments must be an object.");
  const definition = tools.find((tool) => tool.name === name);
  if (!definition) throw new Error("Unknown tool.");
  if (
    Object.keys(args).some(
      (key) => !Object.hasOwn(definition.inputSchema.properties, key),
    )
  )
    throw new Error("Unknown argument.");
  if (
    name === "loreum_lite_read" &&
    (typeof args.id !== "string" || !/^[a-f0-9]{24}$/.test(args.id))
  )
    throw new Error("A source ID from browse is required.");
  if (args.category != null && typeof args.category !== "string")
    throw new Error("Category must be a string.");
  if (args.query != null && typeof args.query !== "string")
    throw new Error("Query must be a string.");
}

export function createHandler(catalog = createCatalog()) {
  async function call(name, args = {}) {
    validateArgs(name, args);
    if (
      [
        "loreum_lite_open",
        "loreum_lite_dashboard",
        "loreum_lite_project",
      ].includes(name)
    ) {
      const dashboard =
        name === "loreum_lite_project"
          ? await catalog.setProject(args.project)
          : await catalog.dashboard(name === "loreum_lite_dashboard");
      const summary = {
        capturedAt: dashboard.capturedAt,
        sources: dashboard.records.filter((row) => row.enabled !== false)
          .length,
        configuredEntries: dashboard.tools.filter(
          (row) => row.enabled !== false,
        ).length,
        configuredHooks: dashboard.hooks.filter((row) => row.enabled !== false)
          .length,
        recentSessions: dashboard.usage.sessions.length,
        recordedTokens: dashboard.usage.totals.total_tokens,
        readOnly: true,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        structuredContent: summary,
        _meta: { dashboard },
      };
    }
    const result =
      name === "loreum_lite_read"
        ? await catalog.read(args.id, args.offset ?? 0)
        : await catalog.browse(
            args.category ?? "all",
            args.query ?? "",
            args.includeDisabled ?? false,
          );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }
  async function dispatch(method, params = {}) {
    if (method === "initialize") {
      const supported = [
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
      ];
      return {
        protocolVersion: supported.includes(params.protocolVersion)
          ? params.protocolVersion
          : supported[0],
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
        },
        serverInfo: { name: "loreum-lite", version: "0.3.5" },
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") return { tools };
    if (method === "resources/list")
      return {
        resources: [
          {
            uri: UI_URI,
            name: "Loreum Lite",
            mimeType: "text/html;profile=mcp-app",
          },
        ],
      };
    if (method === "resources/templates/list") return { resourceTemplates: [] };
    if (method === "resources/read") {
      if (params.uri !== UI_URI)
        throw Object.assign(new Error("Unknown resource."), {
          rpcCode: -32602,
        });
      return {
        contents: [
          {
            uri: UI_URI,
            mimeType: "text/html;profile=mcp-app",
            text: await renderHtml(),
            _meta: {
              ui: {
                prefersBorder: false,
                csp: { connectDomains: [], resourceDomains: [] },
              },
              "openai/ui": {
                availableDisplayModes: ["fullscreen"],
                preferredDisplayMode: "fullscreen",
              },
            },
          },
        ],
      };
    }
    if (method === "tools/call") {
      try {
        return await call(params.name, params.arguments ?? {});
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error.message || "The local source could not be read.",
            },
          ],
        };
      }
    }
    throw Object.assign(new Error("Method not found."), { rpcCode: -32601 });
  }
  return { call, dispatch };
}

export async function serveStdio(
  handler,
  input = process.stdin,
  output = process.stdout,
) {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error." },
      });
      continue;
    }
    const valid =
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      message.jsonrpc === "2.0" &&
      typeof message.method === "string";
    if (!valid) {
      send({
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid request." },
      });
      continue;
    }
    if (message.id == null) continue;
    if (
      !["string", "number"].includes(typeof message.id) ||
      (message.params != null &&
        (typeof message.params !== "object" || Array.isArray(message.params)))
    ) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request." },
      });
      continue;
    }
    try {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: await handler.dispatch(message.method, message.params ?? {}),
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: error.rpcCode || -32603,
          message: error.rpcCode ? error.message : "Local reader failed.",
        },
      });
    }
  }
}

export async function serveWeb(handler, port = 4175) {
  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(16).toString("base64");
  let origin;
  const server = createServer(async (request, response) => {
    const send = (status, value, type = "application/json") => {
      response.writeHead(status, {
        "Content-Type": `${type}; charset=utf-8`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      });
      response.end(typeof value === "string" ? value : JSON.stringify(value));
    };
    try {
      if (
        `http://${request.headers.host}` !== origin ||
        (request.headers.origin && request.headers.origin !== origin)
      ) {
        send(403, { error: "Origin is not allowed." });
        return;
      }
      const url = new URL(request.url, origin);
      const provided =
        request.headers.authorization?.replace(/^Bearer /, "") ||
        url.searchParams.get("key") ||
        "";
      if (
        provided.length !== token.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
      ) {
        send(401, { error: "Open the URL printed by the local reader." });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        send(200, await renderHtml({ web: true, token }, nonce), "text/html");
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/api/tool") {
        send(404, { error: "Not found." });
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        send(415, { error: "JSON required." });
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 16_384) {
          send(413, { error: "Request too large." });
          return;
        }
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        send(400, { error: "Invalid JSON." });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        send(400, { error: "Invalid request." });
        return;
      }
      const result = await handler.dispatch("tools/call", parsed);
      send(result.isError ? 400 : 200, result);
    } catch {
      send(500, { error: "The local reader could not complete this request." });
    }
  });
  server.requestTimeout = 15_000;
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveReady);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${origin}/?key=${token}`, token };
}

async function main() {
  const { values } = parseArgs({
    options: {
      web: { type: "boolean", default: false },
      port: { type: "string", default: "4175" },
      project: { type: "string" },
    },
  });
  const handler = createHandler(
    createCatalog(values.project ? { project: values.project } : {}),
  );
  if (!values.web) {
    await serveStdio(handler);
    return;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be between 0 and 65535.");
  const { server, url } = await serveWeb(handler, port);
  console.log(`Loreum Lite: ${url}`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
