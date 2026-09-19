// `aas gui`: a local web page (only on 127.0.0.1) for setting up and starting runs without a shell. It is a front end
// to the CLI: the settings are the .env the CLI reads, and every action runs the same commands (the log shows them).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { affectedBy, allGames, configItems, guiGames, settingOwners } from "./checks.mjs";
import { gameEnvFile } from "../settings.mjs";
import { writeEnv, ENV_FILE } from "./env-file.mjs";
import { readSettings as readEnv } from "../settings.mjs";
import { agentsPresent, createSession, recorderOptions, RUNTIMES } from "./session.mjs";
import { drives, IS_WSL, toLocal, toWindows } from "./windows-paths.mjs";
import { FRAMEWORK_VERSION } from "../plugins.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Only one GUI at a time: it starts games, OBS and runs, so a second one would fight the first over the same run
// directory. The note below points at the page that is already up; a second start opens that page instead of failing.
const NOTE_FILE = process.env.AAS_GUI_NOTE || path.join(here, "..", "..", "..", "..", ".local", "gui.json");

// Does an AAS GUI answer here? Under WSL a connection to a closed port hangs for minutes, so the probe has a deadline.
function probe(url, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${url}api/gui`, { timeout }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => { try { const j = JSON.parse(text); resolve(j?.gui === "aas" ? j : null); } catch { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function openBrowser(address) {
  if (IS_WSL || process.platform === "win32") spawn(IS_WSL ? "cmd.exe" : "cmd", ["/c", "start", "", address], { detached: true, stdio: "ignore", cwd: IS_WSL ? "/mnt/c" : undefined }).unref();
  else spawn("xdg-open", [address], { detached: true, stdio: "ignore" }).unref();
}

function listDir(p) {
  if (!p) return { path: "", parent: null, entries: drives().map((d) => ({ name: toWindows(d), path: toWindows(d), dir: true })) };
  const local = toLocal(p);
  let ents = [];
  try { ents = fs.readdirSync(local, { withFileTypes: true }); } catch (e) { return { path: toWindows(local), parent: null, error: e.code ?? e.message, entries: [] }; }
  const parentLocal = path.dirname(local);
  const isRoot = parentLocal === local || (IS_WSL && /^\/mnt\/[a-z]$/.test(local));
  return {
    path: toWindows(local),
    parent: isRoot ? "" : toWindows(parentLocal),
    entries: ents
      .filter((e) => !e.name.startsWith("$") && e.name !== "System Volume Information")
      .map((e) => ({ name: e.name, path: toWindows(path.join(local, e.name)), dir: e.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1)),
  };
}

export async function startGui({ port = 8770, open = true, log = console.log } = {}) {
  let note = null;
  try { note = JSON.parse(fs.readFileSync(NOTE_FILE, "utf8")); } catch { /* no GUI has run yet, or the note is gone */ }
  const live = note?.url ? await probe(note.url) : null;
  if (live) {
    log(`aas gui is already running: ${live.url}  (that page is opened again; close its own window to end it)`);
    if (open) openBrowser(live.url);
    return { url: live.url, already: true };
  }
  const session = createSession();
  // Check results per row, kept in <repo>/.local/gui-checks.json so a restart keeps them; a row whose value changed
  // since its check shows as not checked.
  const cacheFile = path.join(here, "..", "..", "..", "..", ".local", "gui-checks.json");
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* no results yet */ }
  const saveCache = () => { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2)); } catch { /* not kept */ } };
  const pending = new Set();
  const withResult = (item) => {
    if (item.check === false) return item;
    if (pending.has(item.id)) return { ...item, status: "pending", detail: "" };
    const c = cache[item.id];
    if (!c || c.value !== item.value) return { ...item, status: "unchecked", detail: "" };
    return { ...item, ...c.result, value: item.value, options: c.result.options ?? item.options, at: c.at };
  };
  // Every check is a child process (checks.mjs <id>), a few at a time; each result is pushed to the page when it is in.
  const checkScript = path.join(here, "checks.mjs");
  const queue = [];
  let running = 0;
  const pump = () => {
    while (running < 4 && queue.length) {
      const id = queue.shift();
      running += 1;
      const child = spawn(process.execPath, [checkScript, id], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", async () => {
        running -= 1;
        pending.delete(id);
        let result;
        try { result = JSON.parse(out); } catch { result = { status: "fail", detail: "The check did not answer." }; }
        const item = (await configItems()).find((i) => i.id === id);
        if (item) {
          cache[id] = { value: item.value, result, at: new Date().toTimeString().slice(0, 8) };
          saveCache();
          emitAll("check", withResult(item));
        }
        pump();
      });
    }
  };
  const startChecks = async (ids) => {
    const all = (await configItems()).filter((i) => i.check !== false).map((i) => i.id);
    for (const id of ids ?? all) {
      if (!all.includes(id) || pending.has(id)) continue;
      pending.add(id);
      queue.push(id);
      emitAll("check", withResult((await configItems()).find((i) => i.id === id)));
    }
    pump();
  };
  const clients = new Set();
  const emitAll = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  session.subscribe(emitAll);
  const body = (req) => new Promise((resolve, reject) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { try { resolve(c.length ? JSON.parse(Buffer.concat(c).toString("utf8")) : {}); } catch (e) { reject(e); } }); });
  const send = (res, code, data) => { const t = JSON.stringify(data); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(t); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // Only this machine's browser, only same-origin requests: the page changes settings and starts programs, and a
    // Host other than the loopback address is refused (DNS rebinding).
    const port = server.address().port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { send(res, 403, { error: "forbidden" }); return; }
    if (req.method !== "GET" && req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}` && req.headers.origin !== `http://localhost:${server.address().port}`) { send(res, 403, { error: "forbidden" }); return; }
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(fs.readFileSync(path.join(here, "page.html"), "utf8").replace("%VERSION%", FRAMEWORK_VERSION));
      } else if (req.method === "GET" && url.pathname === "/api/gui") {
        send(res, 200, { gui: "aas", version: FRAMEWORK_VERSION, url: `http://127.0.0.1:${port}/`, pid: process.pid });
      } else if (req.method === "GET" && url.pathname === "/api/setup") {
        const items = (await configItems()).map(withResult);
        send(res, 200, { items, envFile: toWindows(ENV_FILE), checked: Object.keys(cache).length > 0, configured: Object.keys(readEnv()).some((k) => k.startsWith("AAS_")) });
      } else if (req.method === "POST" && url.pathname === "/api/check") {
        const b = await body(req);
        await startChecks(b.ids ?? null);
        send(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/api/settings") {
        const b = await body(req);
        const changes = {};
        for (const [k, v] of Object.entries(b.values ?? {})) changes[k] = b.paths?.includes(k) && v ? toLocal(v) : v;
        if (b.display !== undefined) {
          const games = await guiGames();
          const [x, y] = String(b.display || "").split(",").map(Number);
          for (const { plugin } of games) {
            if (plugin.setup.displayEnv) changes[plugin.setup.displayEnv] = b.display || "";
            if (plugin.setup.resolutionEnv && b.displaySize) changes[plugin.setup.resolutionEnv] = b.display ? b.displaySize : "";
          }
          changes.AAS_LIVESPLIT_POS = b.display ? `${x + 20},${y + 40}` : "";
        }
        // A setting of a game goes into that game's own file, the rest into the machine's .env (settings.mjs).
        const owners = await settingOwners();
        const perFile = new Map();
        for (const [k, v] of Object.entries(changes)) {
          const file = owners[k] ? gameEnvFile(owners[k]) : ENV_FILE;
          if (!perFile.has(file)) perFile.set(file, {});
          perFile.get(file)[k] = v;
        }
        for (const [file, values] of perFile) { fs.mkdirSync(path.dirname(file), { recursive: true }); writeEnv(values, file); }
        // What was saved is checked at once.
        await startChecks(await affectedBy(Object.keys(changes)));
        send(res, 200, { ok: true });
      } else if (req.method === "GET" && url.pathname === "/api/browse") {
        send(res, 200, listDir(url.searchParams.get("path") ?? ""));
      } else if (req.method === "GET" && url.pathname === "/api/games") {
        const env = readEnv();
        const games = await Promise.all((await guiGames()).map(async ({ plugin }) => ({
          id: plugin.id, name: plugin.name, folder: plugin.setup.folder,
          recorders: await recorderOptions(plugin.setup),
          seed: plugin.setup.seed ? { placeholder: plugin.setup.seed.placeholder ?? "" } : null,
          ends: plugin.ends.map((e) => ({ id: e.id, label: e.label, final: Boolean(e.final) })),
          mock: Boolean(plugin.setup.bot),
          ready: Boolean(env[plugin.setup.settings[0]?.env]),
          next: Object.fromEntries(RUNTIMES.map((r) => [r.id, session.nextRunName(plugin.setup.folder, r.prefix)])),
        })));
        send(res, 200, { games, runtimes: RUNTIMES, agents: agentsPresent().map((r) => ({ id: r.id, name: r.label.replace(" (AI run)", "") })), output: toWindows(toLocal(env.AAS_OUTPUT_DIR ?? "")) });
      } else if (req.method === "GET" && url.pathname === "/api/plan") {
        const o = Object.fromEntries(url.searchParams);
        const p = await session.plan(o);
        send(res, 200, { run: p.run, runDir: toWindows(p.runDir), bundle: toWindows(p.pub), recorder: p.recorder, steps: p.steps.map(({ id, title, shown }) => ({ id, title, shown })), stop: p.stop?.shown ?? null });
      } else if (req.method === "GET" && url.pathname === "/api/state") {
        send(res, 200, { state: session.state, lines: session.lines.slice(-500) });
      } else if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(session.state)}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
      } else if (req.method === "POST" && url.pathname === "/api/start") {
        send(res, 200, { state: await session.start(await body(req)) });
      } else if (req.method === "POST" && url.pathname === "/api/stop") {
        send(res, 200, { state: await session.stop((await body(req)).game) });
      } else if (req.method === "POST" && url.pathname === "/api/fix") {
        const fixId = (await body(req)).id;
        await session.fix(fixId);
        const fixed = { "obs-password": ["obs"], "install-livesplit": ["livesplit"], "livesplit-server": ["livesplit"], "livesplit-windows": ["livesplit"], "install-svv": ["svv", "quiet"] }[fixId] ?? (fixId.startsWith("install:") ? [`game-${fixId.slice(8)}`] : []);
        await startChecks(fixed);
        send(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/api/open") {
        // Opens a folder or file from the page in Windows Explorer / the default program.
        const p = toLocal((await body(req)).path ?? "");
        if (!p || !fs.existsSync(p)) { send(res, 404, { error: "not found" }); return; }
        // A folder is opened; a file is shown selected in its folder, so it can be dragged, copied or uploaded.
        const file = fs.statSync(p).isFile();
        if (IS_WSL || process.platform === "win32") {
          const win = IS_WSL ? toWindows(p) : p;
          // "/select," and the path as two arguments: as one argument Explorer reads a path with a space in it as
          // the whole switch and opens Documents instead (measured 19-09).
          spawn("explorer.exe", file ? ["/select,", win] : [win], { detached: true, stdio: "ignore" }).unref();
        } else spawn("xdg-open", [file ? path.dirname(p) : p], { detached: true, stdio: "ignore" }).unref();
        send(res, 200, { ok: true });
      } else {
        send(res, 404, { error: "not found" });
      }
    } catch (error) {
      send(res, 400, { error: String(error?.message ?? error) });
    }
  });
  const listened = await new Promise((resolve) => { server.once("error", resolve); server.listen(port, "127.0.0.1", () => resolve(null)); });
  if (listened) {
    if (listened.code !== "EADDRINUSE") throw listened;
    // The note was missing or stale (a GUI that was killed, or one started from another copy of the repository).
    const other = await probe(`http://127.0.0.1:${port}/`);
    if (other) {
      log(`aas gui is already running: ${other.url}  (that page is opened again; close its own window to end it)`);
      if (open) openBrowser(other.url);
      return { url: other.url, already: true };
    }
    throw new Error(`Port ${port} is in use by something that is not the AAS GUI. Start the GUI on another port: aas gui --port ${port + 1}`);
  }
  const address = `http://127.0.0.1:${server.address().port}/`;
  try { fs.mkdirSync(path.dirname(NOTE_FILE), { recursive: true }); fs.writeFileSync(NOTE_FILE, `${JSON.stringify({ url: address, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`); } catch { /* the port itself stays the lock */ }
  const forget = () => { try { if (JSON.parse(fs.readFileSync(NOTE_FILE, "utf8")).pid === process.pid) fs.rmSync(NOTE_FILE); } catch { /* already gone, or another GUI's note */ } };
  process.once("exit", forget);
  log(`aas gui: ${address}  (Ctrl-C ends the GUI: a running session is stopped first, saved, with its recording)`);
  if (open) openBrowser(address);
  const shutdown = async () => {
    if (session.state.phase !== "idle") { log("stopping the session first"); await session.stop(); }
    forget();
    server.close();
    process.exit(0);
  };
  // Ctrl-C, a stop signal, and the window that ends the shell the GUI runs in.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, shutdown);
  return { url: address, server, session };
}
