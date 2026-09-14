// Process hardening for the AAS broker. MUST be imported before any other
// module so the patches are in place before agent-supplied code can run.
//
// Derived from cozyblaze's portal-agent, controller/mcp/hardening.mjs
// (MIT, Copyright (c) 2026 cozyblaze; license text in packages/core/vendor/portal-agent/LICENSE; see packages/core/NOTICE). Changes: the allowed network destinations come from
// AAS_ALLOWED_ENDPOINTS (or AAS_GAME_HOST/AAS_GAME_PORT) instead of the SPT
// port, and every AAS_* environment variable survives the scrub.
//
// <game>_exec evaluates agent-supplied JavaScript in this process, so a
// snippet has whatever the process has. Node's --permission flag already
// removes filesystem writes, child processes, workers, and native addons; it
// has no network permission and does not hide environment variables. This
// module closes those two gaps:
//
//   1. Outbound sockets are restricted to the game endpoint(s). Every Node
//      networking API (fetch/undici, http, https, http2, tls, ws) ultimately
//      calls net.Socket.prototype.connect, so gating that one method plus
//      dgram covers them all.
//   2. Inherited environment variables are deleted, leaving only what this
//      broker needs. Deleting from process.env unsets them in the real
//      process environment, so no recoverable copy is left behind.
//   3. Process termination APIs are replaced with immutable throwing stubs so
//      evaluated code cannot kill this broker or another process.
//
// This is defense in depth layered on --permission, not a substitute for it.

import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";

// --- Configuration (read before the environment is scrubbed) ---------------

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function parseEndpoints() {
  const list = [];
  const raw = process.env.AAS_ALLOWED_ENDPOINTS;
  if (raw) {
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const at = trimmed.lastIndexOf(":");
      if (at <= 0) throw new Error(`AAS_ALLOWED_ENDPOINTS entry "${trimmed}" must be host:port`);
      const host = trimmed.slice(0, at);
      const port = Number(trimmed.slice(at + 1));
      if (!Number.isInteger(port) || port <= 0) throw new Error(`AAS_ALLOWED_ENDPOINTS entry "${trimmed}" has an invalid port`);
      list.push({ host, port });
    }
  } else if (process.env.AAS_GAME_HOST || process.env.AAS_GAME_PORT) {
    list.push({
      host: process.env.AAS_GAME_HOST || "127.0.0.1",
      port: Number(process.env.AAS_GAME_PORT),
    });
  }
  return list;
}

/** The only destinations this process may open a TCP connection to. */
export const ALLOWED_ENDPOINTS = Object.freeze(parseEndpoints().map((e) => Object.freeze(e)));

function describeAllowed() {
  return ALLOWED_ENDPOINTS.length
    ? ALLOWED_ENDPOINTS.map((e) => `${e.host}:${e.port}`).join(", ")
    : "nothing";
}

class NetworkBlockedError extends Error {
  constructor(detail) {
    super(
      `Network access is blocked in the AAS broker sandbox (${detail}). ` +
        `Only the game endpoint(s) ${describeAllowed()} are reachable.`,
    );
    this.name = "NetworkBlockedError";
    this.code = "ERR_NETWORK_BLOCKED";
  }
}

class ProcessTerminationBlockedError extends Error {
  constructor(method) {
    super(`Process termination is blocked in the AAS broker sandbox (process.${method}).`);
    this.name = "ProcessTerminationBlockedError";
    this.code = "ERR_PROCESS_TERMINATION_BLOCKED";
  }
}

// --- Target extraction -----------------------------------------------------

// Mirrors the argument shapes net.Socket.prototype.connect accepts:
//   connect(options[, cb]) | connect(port[, host][, cb]) | connect(path[, cb])
function targetOf(args) {
  const first = args[0];
  // net.connect/createConnection pre-normalize to [options, callback] and pass
  // that array as the single argument to Socket.prototype.connect.
  if (Array.isArray(first)) {
    return targetOf(first);
  }
  if (first && typeof first === "object") {
    if (first.path) {
      return { kind: "ipc", detail: `IPC path ${first.path}` };
    }
    return { kind: "tcp", port: Number(first.port), host: first.host ?? "localhost" };
  }
  const asPort = typeof first === "number" ? first : Number(first);
  if (Number.isInteger(asPort) && asPort >= 0) {
    return { kind: "tcp", port: asPort, host: typeof args[1] === "string" ? args[1] : "localhost" };
  }
  if (typeof first === "string") {
    return { kind: "ipc", detail: `IPC path ${first}` };
  }
  return { kind: "unknown", detail: "unrecognized connect target" };
}

function isAllowed(host, port) {
  const h = String(host);
  for (const endpoint of ALLOWED_ENDPOINTS) {
    if (endpoint.port !== port) continue;
    // Hostname aliases are accepted only when the configured host is itself
    // loopback; otherwise the host string must match exactly.
    if (LOOPBACK.has(endpoint.host) ? LOOPBACK.has(h) : endpoint.host === h) {
      return true;
    }
  }
  return false;
}

function assertAllowed(args) {
  const target = targetOf(args);
  if (target.kind !== "tcp") {
    throw new NetworkBlockedError(target.detail);
  }
  if (!isAllowed(target.host, target.port)) {
    throw new NetworkBlockedError(`connect to ${target.host}:${target.port}`);
  }
}

// Replace a method so snippet code cannot restore the original: the property
// is left non-writable and non-configurable.
function lockMethod(target, name, factory) {
  const original = target[name];
  if (typeof original !== "function") {
    return;
  }
  const replacement = factory(original);
  Object.defineProperty(replacement, "name", { value: name, configurable: true });
  Object.defineProperty(target, name, {
    value: replacement,
    writable: false,
    configurable: false,
    enumerable: Object.prototype.propertyIsEnumerable.call(target, name),
  });
}

// --- Outbound TCP/TLS ------------------------------------------------------

// Every stream-socket path funnels through this one method, including the
// net.connect / net.createConnection helpers and tls.connect.
lockMethod(net.Socket.prototype, "connect", (original) =>
  function connect(...args) {
    assertAllowed(args);
    return original.apply(this, args);
  },
);

lockMethod(tls, "connect", (original) =>
  function connect(...args) {
    assertAllowed(args);
    return original.apply(this, args);
  },
);

// --- Inbound listeners -----------------------------------------------------
// The broker never listens; a snippet opening one would be a backdoor.

lockMethod(net.Server.prototype, "listen", () =>
  function listen() {
    throw new NetworkBlockedError("listening for inbound connections");
  },
);

// --- UDP -------------------------------------------------------------------
// dgram bypasses net entirely, so it needs its own gate. Blocked outright:
// game endpoints are TCP, so nothing here has a legitimate use.

for (const method of ["send", "connect", "bind"]) {
  lockMethod(dgram.Socket.prototype, method, () =>
    function blocked() {
      throw new NetworkBlockedError(`dgram.${method}`);
    },
  );
}

// --- fetch -----------------------------------------------------------------
// Gating net.Socket.connect already stops fetch, but it surfaces as an opaque
// failure from deep inside undici; this gives a clear error instead.

if (typeof globalThis.fetch === "function") {
  Object.defineProperty(globalThis, "fetch", {
    value: function fetch(resource) {
      throw new NetworkBlockedError(`fetch ${typeof resource === "string" ? resource : "request"}`);
    },
    writable: false,
    configurable: false,
  });
}

// --- Process termination ---------------------------------------------------
// <game>_exec runs inside this process, so Node's process object is reachable
// even though child-process creation is denied by --permission. Lock every
// public and legacy termination entry point before agent code can run. The
// broker shuts down naturally after closing its handles instead of calling
// process.exit(), so it does not need an exception to this rule.

for (const method of ["kill", "exit", "abort", "reallyExit", "_kill"]) {
  lockMethod(process, method, () =>
    function blocked() {
      throw new ProcessTerminationBlockedError(method);
    },
  );
}

// --- Legacy internals ------------------------------------------------------
// process.binding can hand out raw bindings (tcp_wrap, fs) that sidestep the
// patched module surface.

delete process.binding;
delete process._linkedBinding;

// --- Environment -----------------------------------------------------------
// Deleting keys unsets them in the real process environment. Only what the
// broker and the Node runtime need on Windows is kept, plus every AAS_*
// variable; secrets in the inherited environment are the main thing a snippet
// could exfiltrate.

const KEEP_ENV = new Set([
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
]);

for (const key of Object.keys(process.env)) {
  if (!KEEP_ENV.has(key) && !key.startsWith("AAS_")) {
    delete process.env[key];
  }
}

process.stderr.write(
  `[aas-broker] hardening active: network limited to ${describeAllowed()}, ` +
    `environment scrubbed, process termination blocked\n`,
);
