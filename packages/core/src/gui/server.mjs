// `aas gui`: a local web page (only on 127.0.0.1) for setting up and starting runs without a shell. It is a front end
// to the CLI: the settings are the .env the CLI reads, and every action runs the same commands (the log shows them).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setupModel, guiGames } from "./checks.mjs";
import { readEnv, writeEnv, ENV_FILE } from "./env-file.mjs";
import { createSession, RUNTIMES } from "./session.mjs";
import { drives, IS_WSL, toLocal, toWindows } from "./windows-paths.mjs";
import { FRAMEWORK_VERSION } from "../plugins.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

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
  const session = createSession();
  const clients = new Set();
  session.subscribe((type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); });
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
      } else if (req.method === "GET" && url.pathname === "/api/setup") {
        send(res, 200, { ...(await setupModel()), envFile: toWindows(ENV_FILE) });
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
        writeEnv(changes);
        send(res, 200, { ok: true });
      } else if (req.method === "GET" && url.pathname === "/api/browse") {
        send(res, 200, listDir(url.searchParams.get("path") ?? ""));
      } else if (req.method === "GET" && url.pathname === "/api/games") {
        const env = readEnv();
        const games = (await guiGames()).map(({ plugin }) => ({
          id: plugin.id, name: plugin.name, folder: plugin.setup.folder,
          ends: plugin.ends.map((e) => ({ id: e.id, label: e.label, final: Boolean(e.final) })),
          mock: Boolean(plugin.setup.bot),
          ready: Boolean(env[plugin.setup.settings[0]?.env]),
          next: Object.fromEntries(RUNTIMES.map((r) => [r.id, session.nextRunName(plugin.setup.folder, r.prefix)])),
        }));
        send(res, 200, { games, runtimes: RUNTIMES, output: toWindows(toLocal(env.AAS_OUTPUT_DIR ?? "")) });
      } else if (req.method === "GET" && url.pathname === "/api/plan") {
        const o = Object.fromEntries(url.searchParams);
        const p = await session.plan(o);
        send(res, 200, { run: p.run, runDir: toWindows(p.runDir), bundle: toWindows(p.pub), steps: p.steps.map(({ id, title, shown }) => ({ id, title, shown })), stop: p.stop?.shown ?? null });
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
        await session.fix((await body(req)).id);
        send(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/api/open") {
        // Opens a folder or file from the page in Windows Explorer / the default program.
        const p = toLocal((await body(req)).path ?? "");
        if (!p || !fs.existsSync(p)) { send(res, 404, { error: "not found" }); return; }
        if (IS_WSL) spawn("explorer.exe", [toWindows(p)], { detached: true, stdio: "ignore" }).unref();
        else if (process.platform === "win32") spawn("explorer.exe", [p], { detached: true, stdio: "ignore" }).unref();
        else spawn("xdg-open", [p], { detached: true, stdio: "ignore" }).unref();
        send(res, 200, { ok: true });
      } else {
        send(res, 404, { error: "not found" });
      }
    } catch (error) {
      send(res, 400, { error: String(error?.message ?? error) });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = `http://127.0.0.1:${server.address().port}/`;
  log(`aas gui: ${address}  (Ctrl-C ends the GUI; a running session is stopped first)`);
  if (open) {
    if (IS_WSL || process.platform === "win32") spawn(IS_WSL ? "cmd.exe" : "cmd", ["/c", "start", "", address], { detached: true, stdio: "ignore", cwd: IS_WSL ? "/mnt/c" : undefined }).unref();
    else spawn("xdg-open", [address], { detached: true, stdio: "ignore" }).unref();
  }
  const shutdown = async () => {
    if (session.state.phase !== "idle") { log("stopping the session first"); await session.stop(); }
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { url: address, server, session };
}
