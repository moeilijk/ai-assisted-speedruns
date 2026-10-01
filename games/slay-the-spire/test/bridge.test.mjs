// The bridge between Communication Mod and the plugin keeps every client: a check that connects while a session runs
// (aas doctor, the GUI's game check) no longer drops the agent's connection (2026-10-02, found by reading the flow:
// every command of the agent then waited 90 s and failed). Every game state goes to each client.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function lines(sock) {
  const got = [];
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) !== -1) { got.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  return got;
}
const until = async (ok, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

test("a second client does not drop the first, and both get the game's states", async (t) => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const bridge = spawn(process.execPath, [join(here, "..", "bridge.mjs"), String(port)], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => bridge.kill());
  const ready = await new Promise((r) => bridge.stdout.once("data", (d) => r(String(d))));
  assert.match(ready, /ready/);
  const a = net.connect(port, "127.0.0.1"); const ga = lines(a);
  await until(() => ga.length > 0);
  const b = net.connect(port, "127.0.0.1"); const gb = lines(b);
  await until(() => gb.length > 0);
  let aClosed = false; a.on("close", () => { aClosed = true; });
  bridge.stdin.write('{"ready_for_command":true,"in_game":false}\n');
  assert.ok(await until(() => ga.includes('{"ready_for_command":true,"in_game":false}') && gb.includes('{"ready_for_command":true,"in_game":false}')), `both got the state: a ${ga.join("|")}, b ${gb.join("|")}`);
  assert.equal(aClosed, false, "the first client is still connected");
  a.destroy(); b.destroy();
});

test("the bridge runs as the copy install-mod puts next to the game, outside this repository", async (t) => {
  // A relative import of the core does not resolve there; since 0.22.0 a fresh install's bridge did not start.
  const { mkdtempSync, copyFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "aas-sts-tools-"));
  copyFileSync(join(here, "..", "bridge.mjs"), join(dir, "bridge.mjs"));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const copy = spawn(process.execPath, [join(dir, "bridge.mjs"), String(port)], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => copy.kill());
  const first = await new Promise((r) => { copy.stdout.once("data", (d) => r(String(d))); copy.once("exit", (code) => r(`exited ${code}`)); });
  assert.match(first, /ready/);
});
