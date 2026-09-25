// Hostile and wrong input at every edge of the tooling: the command line (as a real process), the GUI's routes, a
// zip from elsewhere, a proof that points outside itself, and the game plugins that pass a value on to a console or a
// line protocol. Every case must be refused, with a reason that names what is wrong, and must leave nothing behind.
// This file is also the example for plugin writers: a value from outside is checked where it enters.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { crc32 } from "../src/zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-hostile-"));
// The GUI in this file uses its own settings, results and output location, never the machine's.
Object.assign(process.env, {
  AAS_ENV_FILE: path.join(dir, ".env"), AAS_GAME_ENV_DIR: path.join(dir, "games"), AAS_GUI_NOTE: path.join(dir, "gui.json"),
  AAS_GUI_CHECKS: path.join(dir, "gui-checks.json"), XDG_CONFIG_HOME: path.join(dir, "config"),
});
const output = path.join(dir, "output");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(process.env.AAS_ENV_FILE, `AAS_OUTPUT_DIR=${output}\n`);

/** `aas <args>` as a real process: { code, out, err }. */
const aas = (...args) => new Promise((resolve) => execFile(process.execPath, [CLI, ...args], { env: process.env, encoding: "utf8" }, (e, out, err) => resolve({ code: e?.code ?? 0, out, err })));

test("the command line refuses unknown, empty, doubled and non-numeric options, and says which", async () => {
  const cases = [
    [["run", "--seeds", "x"], /unknown option --seeds/],
    [["run", "--run-dir"], /--run-dir needs a value/],
    [["run", "--run-dir", "a", "--run-dir", "b"], /--run-dir is given more than once/],
    [["run", "--max-minutes", "abc", "--run-dir", "a"], /--max-minutes "abc" is not allowed: a number/],
    [["run", "--max-turns", "1.5", "--run-dir", "a"], /--max-turns "1.5" is not allowed: a whole number/],
    [["run", "--overlay-port", "70000", "--run-dir", "a"], /--overlay-port "70000" is not allowed/],
    // A seed that is really an option is never read as one: the flag before it has no value.
    [["run", "--seed", "--ignore-budget", "--run-dir", "a"], /--seed needs a value/],
    [["budget", "--max", "150"], /--max "150" is not allowed/],
  ];
  for (const [args, reason] of cases) {
    const r = await aas(...args);
    assert.equal(r.code, 1, `${args.join(" ")} exits 1`);
    assert.match(r.err, reason, `${args.join(" ")}: ${r.err}`);
  }
});

test("configure refuses a model, effort, seed, id or proof mode that would break a command line or a game's console", async () => {
  const { configure } = await import("../src/configure.mjs");
  const game = path.join(here, "fake-game.mjs");
  const base = { runtime: "scripted", game, bot: path.join(here, "fake-game.mjs") };
  const cases = [
    [{ model: "claude opus" }, /--model "claude opus" is not allowed/],
    [{ model: 'x"; rm -rf /' }, /--model .* is not allowed/],
    [{ effort: 'high" sandbox="danger-full-access' }, /--effort .* is not allowed: one of low, medium, high, xhigh, max/],
    [{ seed: "23M\nSTART WATCHER" }, /--seed .* is not allowed: letters and digits/],
    [{ seed: "--ignore-budget" }, /--seed .* is not allowed/],
    [{ seed: "a;b" }, /--seed .* is not allowed/],
    [{ proof: "maybe" }, /--proof "maybe" is not allowed: one of off, anonymous, account/],
    [{ id: "../escape" }, /run's id .* is not allowed/],
    [{ id: "-rf" }, /run's id .* is not allowed/],
  ];
  for (const [extra, reason] of cases) {
    const runDir = path.join(dir, `configure-${Math.random().toString(36).slice(2)}`);
    await assert.rejects(configure({ ...base, "run-dir": runDir, ...extra }), reason, JSON.stringify(extra));
    assert.equal(fs.existsSync(runDir), false, `nothing was written for ${JSON.stringify(extra)}`);
  }
  await assert.rejects(configure({ ...base, "run-dir": path.join(dir, "has space") }), /run's id \(--id, or the run directory's name\) "has space" is not allowed/);
});

test("resume refuses a save name or session id that would reach a console or --resume as something else", async () => {
  const { resume } = await import("../src/resume.mjs");
  const runDir = path.join(dir, "resume-run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "brief.json"), JSON.stringify({ id: "resume-run", runtime: "scripted", category: { game: "fake" } }));
  fs.writeFileSync(path.join(runDir, "run.jsonl"), `${JSON.stringify({ kind: "event", event: "game.saved", data: { name: "ok_1" } })}\n`);
  await assert.rejects(resume({ "run-dir": runDir, save: "quick; quit", game: path.join(here, "fake-game.mjs") }, { log() {} }), /--save "quick; quit" is not allowed/);
  await assert.rejects(resume({ "run-dir": runDir, session: "abc --dangerously-skip-permissions", game: path.join(here, "fake-game.mjs") }, { log() {} }), /--session .* is not allowed/);
  await assert.rejects(resume({ "run-dir": runDir, proof: "all" }, { log() {} }), /--proof "all" is not allowed/);
  // A save name in the run's own log is checked as well: the log is a file anyone can edit.
  fs.writeFileSync(path.join(runDir, "run.jsonl"), `${JSON.stringify({ kind: "event", event: "game.saved", data: { name: "x\nquit" } })}\n`);
  await assert.rejects(resume({ "run-dir": runDir, game: path.join(here, "fake-game.mjs") }, { log() {} }), /--save .* is not allowed/);
});

test("aas tickets and aas stop refuse a ticket id or a pid that is not what it claims", async () => {
  let r = await aas("tickets", "extend", "../../admin");
  assert.equal(r.code, 1);
  assert.match(r.err, /ticket "\.\.\/\.\.\/admin" is not allowed: 32 lowercase hex characters/);
  const runDir = path.join(dir, "stop-run");
  fs.mkdirSync(runDir, { recursive: true });
  for (const pid of [0, -1, 1, "123", process.pid + 0.5]) {
    fs.writeFileSync(path.join(runDir, "run.pid"), JSON.stringify({ pid }));
    r = await aas("stop", "--run-dir", runDir);
    assert.equal(r.code, 1, `pid ${pid}`);
    assert.match(r.err, /which is not a session's process; nothing was signalled/, `pid ${pid}: ${r.err}`);
  }
});

test("the GUI refuses settings it does not show, values over more than one line, and paths outside the output location", async () => {
  const { startGui } = await import("../src/gui/server.mjs");
  const gui = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  const base = `http://127.0.0.1:${gui.server.address().port}`;
  const post = async (p, body) => { const res = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json() }; };
  const get = async (p) => { const res = await fetch(base + p); return { status: res.status, json: await res.json() }; };
  const envBefore = fs.readFileSync(process.env.AAS_ENV_FILE, "utf8");
  try {
    for (const [values, reason] of [
      [{ NODE_OPTIONS: "--require /tmp/x.js" }, /NODE_OPTIONS is not a setting this page sets/],
      [{ PATH: "/tmp" }, /PATH is not a setting this page sets/],
      [{ AAS_ARCHIVE_FETCH: "/tmp/evil.mjs" }, /AAS_ARCHIVE_FETCH is not a setting this page sets/],
      [{ AAS_OUTPUT_DIR: "/tmp\nNODE_OPTIONS=--require /tmp/x.js" }, /one line of text/],
      [{ AAS_OUTPUT_DIR: 5 }, /one line of text/],
    ]) {
      const r = await post("/api/settings", { values });
      assert.equal(r.status, 400, JSON.stringify(values));
      assert.match(r.json.error, reason);
    }
    assert.equal((await post("/api/settings", { display: "0,0;rm", displaySize: "" })).status, 400);
    assert.equal((await post("/api/settings", { display: "0,0", displaySize: "big" })).status, 400);
    assert.equal(fs.readFileSync(process.env.AAS_ENV_FILE, "utf8"), envBefore, "the settings file is unchanged");
    assert.equal(process.env.NODE_OPTIONS, undefined, "nothing reached the GUI's own environment");

    for (const [q, reason] of [
      [{ game: "balatro", runtime: "scripted", run: "../escape" }, /Run name "\.\.\/escape" is not allowed/],
      [{ game: "balatro", runtime: "scripted", goal: "credits;rm" }, /Goal "credits;rm" is not one of Balatro's ends/],
      [{ game: "balatro", runtime: "scripted", seed: "A B" }, /--seed "A B" is not allowed/],
      [{ game: "balatro", runtime: "claude-code", maxMinutes: "abc" }, /Time limit \(minutes\) "abc" is not allowed/],
      [{ game: "nope", runtime: "scripted" }, /Unknown game: nope/],
      [{ game: "balatro", runtime: "../../evil" }, /Unknown run type/],
    ]) {
      const r = await get(`/api/plan?${new URLSearchParams(q)}`);
      assert.equal(r.status, 400, JSON.stringify(q));
      assert.match(r.json.error, reason);
    }

    const outside = path.join(dir, "outside.zip");
    fs.writeFileSync(outside, "not a bundle");
    const notZip = path.join(output, "notes.txt");
    fs.writeFileSync(notZip, "x");
    for (const [route, body, reason] of [
      ["/api/open", { path: os.homedir() }, /Path .* is not allowed: a path inside/],
      ["/api/open", { path: path.join(output, "..", "..") }, /Path .* is not allowed: a path inside/],
      ["/api/archive", { action: "upload", arg: outside }, /Bundle .* is not allowed: a path inside/],
      ["/api/archive", { action: "upload", arg: notZip }, /Only a bundle \(\.zip\) can be uploaded/],
      ["/api/archive", { action: "extend", arg: "zz" }, /Not a ticket/],
      ["/api/archive", { action: "format-disk" }, /Unknown action/],
      ["/api/continue", { runDir: dir }, /Run folder .* is not allowed: a path inside/],
      ["/api/fix", { id: "install:../../evil" }, /Nothing to install|Unknown fix/],
    ]) {
      const r = await post(route, body);
      assert.equal(r.status, 400, `${route} ${JSON.stringify(body)}: ${r.status}`);
      assert.match(r.json.error, reason, route);
    }
    const lines = (await get("/api/state")).json.lines.map((l) => `${l.kind} ${l.text}`);
    assert.ok(lines.some((l) => /^err Failed: settings: NODE_OPTIONS is not a setting/.test(l)), "every refusal stands in the log with its reason");
  } finally {
    gui.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
});

/** A zip built by hand, so each field can be made wrong on purpose. */
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = e.data;
    const crc = e.crc ?? crc32(e.method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }) : data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(e.method ?? 0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(e.size ?? data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(e.method ?? 0, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(e.size ?? data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(e.localAt ?? offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test("a zip that is broken or built to harm is refused with its reason, and a zip bomb never fills the memory", async () => {
  const { readZipEntries } = await import("../src/zip-read.mjs");
  const write = (name, buf) => { const f = path.join(dir, name); fs.writeFileSync(f, buf); return f; };
  assert.deepEqual(readZipEntries(write("good.zip", zipOf([{ name: "a.txt", data: Buffer.from("hi") }]))).map((e) => e.data.toString()), ["hi"]);
  const bomb = zlib.deflateRawSync(Buffer.alloc(50 * 1024 * 1024));
  for (const [name, buf, reason] of [
    ["bomb.zip", zipOf([{ name: "big.txt", data: bomb, method: 8, size: 10 }]), /does not inflate to its declared 10 bytes/],
    ["twice.zip", zipOf([{ name: "a.txt", data: Buffer.from("1") }, { name: "a.txt", data: Buffer.from("2") }]), /"a\.txt" is in it twice/],
    ["method.zip", zipOf([{ name: "a.txt", data: Buffer.from("x"), method: 12 }]), /compression method 12/],
    ["offset.zip", zipOf([{ name: "a.txt", data: Buffer.from("x"), localAt: 999999 }]), /runs past the end of the file|points at no local header/],
    ["size.zip", zipOf([{ name: "a.txt", data: Buffer.from("abc"), size: 2 }]), /holds 3 bytes but declares 2/],
    ["crc.zip", zipOf([{ name: "a.txt", data: Buffer.from("abc"), crc: 12345 }]), /"a\.txt": its CRC-32 does not match its data/],
  ]) assert.throws(() => readZipEntries(write(name, buf)), reason, name);
  const good = zipOf([{ name: "a.txt", data: Buffer.from("hello") }]);
  assert.throws(() => readZipEntries(write("cut.zip", Buffer.concat([good.subarray(0, 20), good.subarray(good.length - 22)]))), /not a zip that can be read safely/);
  assert.equal(readZipEntries(write("text.zip", Buffer.from("just text"))), null, "not a zip at all is null, as before");
});

test("a proof that names a session log outside its private part is refused, not read", async () => {
  const { regenerate } = await import("../src/proof-check.mjs");
  const bundle = path.join(dir, "bundle");
  const priv = path.join(dir, "private");
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(priv, { recursive: true });
  fs.writeFileSync(path.join(bundle, "summary.json"), "{}");
  for (const label of ["session:../../etc/passwd", "session:1/../../x", "rollout:1"]) {
    fs.writeFileSync(path.join(bundle, "proof.json"), JSON.stringify({ export: { session: label } }));
    const r = await regenerate(bundle, priv);
    assert.equal(r.equal, false);
    assert.match(r.differences[0], /which is not a label of the private part/, label);
  }
});

test("game plugins refuse a seed or save name that would reach their console or protocol as another command", async () => {
  const { seedString } = await import("../../../games/slay-the-spire/plugin.mjs");
  assert.equal(seedString("23M"), "23M");
  for (const seed of ["23M\nSTART", "a b", "x;y"]) assert.throws(() => seedString(seed), /is not a seed code/, JSON.stringify(seed));
  for (const file of ["portal", "portal-2"]) {
    const plugin = (await import(`../../../games/${file}/plugin.mjs`)).default;
    for (const name of ["quick; quit", "a\nexec evil", 'x"y']) {
      await assert.rejects(plugin.saveState({ name, log() {} }), /is not a plain name/, `${file} saveState ${JSON.stringify(name)}`);
      await assert.rejects(plugin.loadState({ name, log() {} }), /is not a plain name/, `${file} loadState ${JSON.stringify(name)}`);
    }
  }
});

test("a manifest that points outside its bundle, at a device or through a link is refused unread (found by the site)", async () => {
  const { checkRun } = await import("../src/check-run.mjs");
  const bundle = path.join(dir, "manifest-bundle");
  fs.mkdirSync(path.join(bundle, "runtime-config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "secret.txt"), "not yours");
  fs.symlinkSync(path.join(dir, "secret.txt"), path.join(bundle, "runtime-config", "link.txt"));
  const hostile = ["runtime-config/../../secret.txt", "/etc/hostname", "../../dev/zero", "runtime-config\\..\\..\\secret.txt", ".hidden", "runtime-config/./x", "a\u0000b", "runtime-config/link.txt"];
  fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({ bundle: "aas-public", files: hostile.map((p) => ({ path: p, sha256: "0".repeat(64), bytes: 9 })) }));
  const started = Date.now();
  const report = checkRun(bundle);
  assert.ok(Date.now() - started < 10000, "no read of a device: the check does not hang");
  const detail = report.results.map((r) => r.detail).join("\n");
  for (const p of hostile.slice(0, 7)) assert.ok(detail.includes(`${JSON.stringify(p).slice(0, 80)}: not a plain path inside the bundle; not read`), `${JSON.stringify(p)} refused:\n${detail}`);
  assert.match(detail, /runtime-config\/link\.txt: not a plain file \(a link or a device\); not read/);
  assert.doesNotMatch(detail, /bytes 9 != 9|not yours/, "nothing about the file outside leaks into the report");
});
