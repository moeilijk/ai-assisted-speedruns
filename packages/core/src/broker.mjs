#!/usr/bin/env node
// AAS broker: a self-contained stdio MCP server that exposes ONE game plugin
// to an agent through exactly three tools:
//
//   <game>_documentation  Return the controller API reference.
//   <game>_screenshot     Capture a full-resolution screenshot.
//   <game>_exec           Run a snippet of JavaScript against the live `game` controller.
//
// Derived from cozyblaze's portal-agent, controller/mcp/portal-mcp-server.mjs
// (MIT, Copyright (c) 2026 cozyblaze; license text in packages/core/vendor/portal-agent/LICENSE; see packages/core/NOTICE). Changes: the game plugin is loaded from
// AAS_GAME_MODULE, tool names derive from the plugin id, tool calls and
// results are appended to <AAS_RUN_DIR>/run.jsonl (screenshots saved to
// <AAS_RUN_DIR>/screenshots/), and tools.json + documentation.md are written
// into the run directory on startup.
//
// Speaks JSON-RPC 2.0 over newline-delimited stdin/stdout (the MCP stdio
// transport) with zero external dependencies. It holds ONE persistent
// controller for the life of the process, so the game connection survives
// between tool invocations.
//
// All diagnostics go to stderr; stdout carries ONLY framed JSON-RPC.
//
// Environment (all survive the hardening scrub):
//   AAS_GAME_MODULE        path to an ES module whose default export is a GamePlugin (required)
//   AAS_ALLOWED_ENDPOINTS  host:port[,host:port] the broker may connect to (read by hardening.mjs)
//   AAS_RUN_DIR            run directory for run.jsonl, screenshots/, tools.json, documentation.md (optional)
//   AAS_TIME_ZONE          IANA zone for log timestamps (optional, default: system)

// Must come first: locks down networking and scrubs the environment before
// any other module loads or any snippet can run.
import { ALLOWED_ENDPOINTS } from "./hardening.mjs";

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultTimeZone, localTimestamp } from "./timestamp.mjs";

const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const ID_RE = /^[a-z][a-z0-9_]*$/;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const DATA_IMAGE_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const EXACT_DATA_IMAGE_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;

// --- Game plugin -----------------------------------------------------------

function fail(message) {
  process.stderr.write(`[aas-broker] ${message}\n`);
  throw new Error(message);
}

const GAME_MODULE = process.env.AAS_GAME_MODULE;
if (!GAME_MODULE) {
  fail("AAS_GAME_MODULE is required (path to the game plugin module).");
}

const loaded = await import(pathToFileURL(resolve(GAME_MODULE)).href);
const plugin = loaded.default ?? loaded;

if (!plugin || typeof plugin !== "object") fail(`${GAME_MODULE} does not export a plugin object.`);
if (typeof plugin.id !== "string" || !ID_RE.test(plugin.id)) {
  fail(`plugin.id must match ${ID_RE} (got ${JSON.stringify(plugin.id)}).`);
}
if (typeof plugin.connect !== "function") fail("plugin.connect() is required.");
if (plugin.documentation === undefined) fail("plugin.documentation is required.");

const ID = plugin.id;
const NAME = typeof plugin.name === "string" ? plugin.name : ID;
// The controller is always in scope as `game`; a plugin may add a second name
// (portal-agent's controller and documentation use `portal`).
const SCOPE = typeof plugin.scopeName === "string" && ID_RE.test(plugin.scopeName) && plugin.scopeName !== "game"
  ? plugin.scopeName
  : null;
const TOOL = {
  exec: `${ID}_exec`,
  documentation: `${ID}_documentation`,
  screenshot: `${ID}_screenshot`,
};
const DOCUMENTATION =
  typeof plugin.documentation === "function" ? String(await plugin.documentation()) : String(plugin.documentation);

for (const endpoint of plugin.endpoints ?? []) {
  const covered = ALLOWED_ENDPOINTS.some((e) => e.host === endpoint.host && e.port === endpoint.port);
  if (!covered) {
    process.stderr.write(
      `[aas-broker] warning: plugin endpoint ${endpoint.host}:${endpoint.port} is not in AAS_ALLOWED_ENDPOINTS; connections to it will be blocked\n`,
    );
  }
}

// --- Run directory: log, screenshots, published tool definitions -----------

const RUN_DIR = process.env.AAS_RUN_DIR ? resolve(process.env.AAS_RUN_DIR) : null;
const TIME_ZONE = defaultTimeZone();
let screenshotDirReady = false;

function appendLog(record) {
  if (!RUN_DIR) return;
  const line = JSON.stringify({ timestamp: localTimestamp(Date.now(), TIME_ZONE), source: "broker", ...record });
  try {
    appendFileSync(join(RUN_DIR, "run.jsonl"), `${line}\n`);
  } catch (error) {
    process.stderr.write(`[aas-broker] failed to append run.jsonl: ${error?.message ?? error}\n`);
  }
}

function writeOnce(name, text) {
  if (!RUN_DIR) return;
  try {
    writeFileSync(join(RUN_DIR, name), text, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      process.stderr.write(`[aas-broker] failed to write ${name}: ${error?.message ?? error}\n`);
    }
  }
}

// Replace image parts by references to files under <run>/screenshots so the
// private log stays small but complete.
function persistImagesForLog(callId, content) {
  if (!RUN_DIR) return content.map((part) => (part.type === "image" ? { type: "image_omitted" } : part));
  let n = 0;
  return content.map((part) => {
    if (part.type !== "image") return part;
    n += 1;
    const ext = part.mimeType === "image/png" ? "png" : part.mimeType === "image/webp" ? "webp" : "jpg";
    const relative = join("screenshots", `${callId}-${n}.${ext}`);
    try {
      if (!screenshotDirReady) {
        mkdirSync(join(RUN_DIR, "screenshots"), { recursive: true });
        screenshotDirReady = true;
      }
      writeFileSync(join(RUN_DIR, relative), Buffer.from(part.data, "base64"));
      return { type: "image", mimeType: part.mimeType, path: relative.replaceAll("\\", "/") };
    } catch (error) {
      process.stderr.write(`[aas-broker] failed to save ${relative}: ${error?.message ?? error}\n`);
      return { type: "image_omitted" };
    }
  });
}

// --- Persistent controller -------------------------------------------------

let controller = null;
let connecting = null;

async function getController() {
  if (controller) {
    return controller;
  }
  if (!connecting) {
    connecting = Promise.resolve(plugin.connect())
      .then((created) => {
        controller = created;
        connecting = null;
        return created;
      })
      .catch((error) => {
        connecting = null;
        throw error;
      });
  }
  return connecting;
}

function dropController() {
  if (controller) {
    try {
      controller.close?.();
    } catch {
      // ignore
    }
  }
  controller = null;
}

// --- Image capture hook ----------------------------------------------------
// A controller's screenshot() may auto-emit by calling globalThis.aas.emitImage(url)
// (portal-agent's controller calls globalThis.nodeRepl.emitImage; the alias
// below keeps it working unchanged). Screenshots taken from inside <game>_exec
// are captured and returned as MCP image content. `capturedImages` is safe as
// a module-global because tool calls are serialized through `callQueue`.

let capturedImages = [];

globalThis.aas = {
  emitImage(url) {
    if (typeof url === "string") {
      capturedImages.push(url);
    }
  },
  // Game plugins report run events (game.playback, game.milestone, ...) here;
  // they land in run.jsonl next to the tool calls, on the same clock.
  event(name, data = {}) {
    if (typeof name !== "string" || !name) return;
    appendLog({ kind: "event", event: name, data, source: ID });
  },
  write(text) {
    process.stderr.write(`[${TOOL.exec}] ${text}\n`);
  },
};
globalThis.nodeRepl = globalThis.aas;

function dataUrlToImageContent(url) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!match) {
    return null;
  }
  return { type: "image", mimeType: match[1], data: match[2] };
}

// Accept the shapes a controller may return from screenshot():
//   { screenshots: [{ url }] }  (portal-agent)  |  "data:image/..."  |  { mimeType, data }  |  Buffer
function screenshotToDataUrls(result) {
  if (!result) return [];
  if (typeof result === "string") return EXACT_DATA_IMAGE_URL_RE.test(result) ? [result] : [];
  if (Buffer.isBuffer(result)) return [`data:image/jpeg;base64,${result.toString("base64")}`];
  if (Array.isArray(result.screenshots)) {
    return result.screenshots.map((s) => s?.url).filter((u) => typeof u === "string" && EXACT_DATA_IMAGE_URL_RE.test(u));
  }
  if (typeof result.mimeType === "string" && typeof result.data === "string") {
    return [`data:${result.mimeType};base64,${result.data}`];
  }
  return [];
}

// --- Tool implementations --------------------------------------------------

async function runExec({ code }) {
  if (typeof code !== "string" || !code.trim()) {
    throw new Error(`${TOOL.exec} requires a non-empty \`code\` string.`);
  }

  const game = await getController();
  globalThis.game = game;
  if (SCOPE) globalThis[SCOPE] = game;
  capturedImages = [];

  const fn = SCOPE
    ? new AsyncFunction("game", SCOPE, `"use strict";\n${code}`)
    : new AsyncFunction("game", `"use strict";\n${code}`);
  const value = await fn(game, game);

  const content = [];
  const imageUrls = capturedImages.slice();
  if (value !== undefined) {
    const text = stringifyResult(value, imageUrls);
    if (text !== null) {
      content.push({ type: "text", text });
    }
  }
  for (const url of imageUrls) {
    const image = dataUrlToImageContent(url);
    if (image) {
      content.push(image);
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "ok" });
  }
  return { content };
}

async function runScreenshot({ savePath } = {}) {
  if (savePath !== undefined && (typeof savePath !== "string" || !savePath.trim())) {
    throw new Error(`${TOOL.screenshot} \`savePath\` must be a non-empty string.`);
  }

  const game = await getController();
  if (typeof game.screenshot !== "function") {
    throw new Error(`The ${NAME} controller has no screenshot() method.`);
  }
  capturedImages = [];
  // Explicit captures return the native resolution; only the automatic
  // screenshots that ride along with exec results may be downscaled.
  const urls = screenshotToDataUrls(await game.screenshot({ fullRes: true }));
  const content = [];

  if (savePath !== undefined) {
    const image = urls[0] ? dataUrlToImageContent(urls[0]) : null;
    if (!image) {
      throw new Error("Screenshot captured but no image data returned.");
    }

    const absolutePath = resolve(savePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, Buffer.from(image.data, "base64"));
    return {
      content: [{ type: "text", text: `Screenshot saved to ${absolutePath}` }],
    };
  }

  for (const url of urls) {
    const image = dataUrlToImageContent(url);
    if (image) {
      content.push(image);
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "Screenshot captured but no image data returned." });
  }
  return { content };
}

function runDocumentation() {
  return { content: [{ type: "text", text: DOCUMENTATION }] };
}

function stringifyResult(value, imageUrls = []) {
  if (typeof value === "string") {
    if (EXACT_DATA_IMAGE_URL_RE.test(value)) {
      addImageUrl(imageUrls, value);
      return null;
    }
    return sanitizeImageDataUrls(value, imageUrls) || null;
  }

  let text;
  try {
    // JSON.stringify natively honors toJSON, prints shared (non-circular)
    // references, and throws only on true cycles; the replacer just diverts
    // image data URLs into `imageUrls` and keeps BigInt from throwing.
    text = JSON.stringify(value, imageStrippingReplacer(imageUrls), 2);
  } catch {
    text = sanitizeImageDataUrls(String(value), imageUrls);
  }

  if (text == null || text === "") {
    return null;
  }
  if (isScreenshotOnlyResult(value) && imageUrls.length > 0) {
    return null;
  }
  return text;
}

function imageStrippingReplacer(imageUrls) {
  return (key, value) => {
    // Screenshot entries carry nothing the agent needs beyond the image
    // itself, so once the urls are diverted into image content the whole
    // array is dropped instead of leaving `{ width, height }` residue.
    if (key === "screenshots" && isScreenshotEntryArray(value)) {
      for (const entry of value) {
        addImageUrl(imageUrls, entry.url);
      }
      return undefined;
    }
    if (typeof value === "string") {
      if (EXACT_DATA_IMAGE_URL_RE.test(value)) {
        addImageUrl(imageUrls, value);
        return undefined; // drops the key in objects; arrays get null
      }
      return sanitizeImageDataUrls(value, imageUrls);
    }
    if (typeof value === "bigint") {
      return `${value}n`;
    }
    return value;
  };
}

function sanitizeImageDataUrls(text, imageUrls) {
  return text.replace(DATA_IMAGE_URL_RE, (url) => {
    addImageUrl(imageUrls, url);
    return "";
  });
}

function addImageUrl(imageUrls, url) {
  if (dataUrlToImageContent(url) && !imageUrls.includes(url)) {
    imageUrls.push(url);
  }
}

function isScreenshotEntryArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.url === "string" &&
        EXACT_DATA_IMAGE_URL_RE.test(entry.url),
    )
  );
}

function isScreenshotOnlyResult(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.screenshots)
  );
}

// --- Tool definitions ------------------------------------------------------

const EXEC_DESCRIPTION =
  typeof plugin.execDescription === "string"
    ? plugin.execDescription
    : `Run async JavaScript against ${NAME}; \`${SCOPE ?? "game"}\` is in scope. Use \`return <value>\` for text results. ` +
      `Screenshots are returned as images. The call returns when the game is paused or waiting for input again. ` +
      `Call ${TOOL.documentation} for the exact methods, arguments and result types of \`game\`.`;

const TOOLS = [
  {
    name: TOOL.exec,
    description: EXEC_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: `JavaScript executed as an async function body with \`${SCOPE ?? "game"}\` in scope.`,
        },
      },
      required: ["code"],
    },
  },
  {
    name: TOOL.documentation,
    description:
      `Return the complete supported JavaScript API reference for the \`${SCOPE ?? "game"}\` object used inside ` +
      `${TOOL.exec}. Call this when exact methods, arguments, option fields, or result types are needed.`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: TOOL.screenshot,
    description:
      `Capture a full-resolution screenshot of ${NAME}. By default it is returned as an image. ` +
      `Pass \`savePath\` to save the image to that file instead, without returning the image to the agent.`,
    inputSchema: {
      type: "object",
      properties: {
        savePath: {
          type: "string",
          description:
            "Optional file path where the image should be saved instead of returned; " +
            "relative paths use the broker's working directory, missing parent directories are " +
            "created, and existing files are overwritten.",
        },
      },
    },
  },
];

writeOnce("tools.json", `${JSON.stringify(TOOLS, null, 2)}\n`);
writeOnce("documentation.md", DOCUMENTATION.endsWith("\n") ? DOCUMENTATION : `${DOCUMENTATION}\n`);

async function callTool(name, args) {
  switch (name) {
    case TOOL.exec:
      return runExec(args ?? {});
    case TOOL.documentation:
      return runDocumentation();
    case TOOL.screenshot:
      return runScreenshot(args ?? {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- JSON-RPC plumbing -----------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// Serialize tool calls so capturedImages never interleaves between requests.
let callQueue = Promise.resolve();
let callCounter = 0;

async function handleMessage(msg) {
  if (msg === null || typeof msg !== "object") {
    return;
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize": {
      const protocolVersion = params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
      sendResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: ID, version: SERVER_VERSION },
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return; // notification, no response
    case "ping":
      if (isRequest) sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments;
      callQueue = callQueue.then(async () => {
        callCounter += 1;
        const callId = `call-${String(callCounter).padStart(5, "0")}`;
        appendLog({ kind: "tool_call", call: callId, name, input: args ?? {} });
        try {
          const result = await callTool(name, args);
          appendLog({ kind: "tool_result", call: callId, output: persistImagesForLog(callId, result.content) });
          sendResult(id, result);
        } catch (error) {
          // Drop a potentially-dead controller so the next call reconnects.
          if (/socket|connect|closed|ECONN|timed out/i.test(String(error?.message))) {
            dropController();
          }
          const content = [{ type: "text", text: `Error: ${error?.message ?? String(error)}` }];
          appendLog({ kind: "tool_result", call: callId, output: content, is_error: true });
          sendResult(id, { content, isError: true });
        }
      });
      return;
    }
    default:
      if (isRequest) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      return;
  }
}

// --- stdin line framing ----------------------------------------------------

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`[aas-broker] failed to parse line: ${error}\n`);
      continue;
    }
    Promise.resolve(handleMessage(parsed)).catch((error) => {
      process.stderr.write(`[aas-broker] handler error: ${error}\n`);
    });
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // stdin usually ends before the queued tool calls have run; let them finish
  // (their results still go to stdout), then release the game connection so
  // the event loop can drain. A connection still being set up is closed as
  // soon as it exists.
  callQueue.then(() => {
    dropController();
    connecting?.then((created) => {
      try {
        created.close?.();
      } catch {
        // ignore
      }
    }, () => {});
  });
}

process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

process.stderr.write(
  `[aas-broker] ${ID} v${SERVER_VERSION} ready (tools ${TOOL.documentation}, ${TOOL.screenshot}, ${TOOL.exec}` +
    `${RUN_DIR ? `; logging to ${RUN_DIR}` : ""})\n`,
);
