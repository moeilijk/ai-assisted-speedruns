// An interactive session (a person at the terminal, no --headless) is ended by the goal or a stop too, and a resume
// continues the session it names (2026-10-02, found by reading the flow: Codex and Mistral Vibe never ended an
// interactive session, and Codex started a new one on a resume). The CLIs are stand-ins on PATH that write down
// their arguments and wait for a signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function standIn(name) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "aas-bin-"));
  const args = path.join(bin, "args.json");
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));
process.on("SIGINT", () => {}); // the CLI only cancels its turn on SIGINT; SIGTERM ends it
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return { bin, args };
}

async function interactive(t, fn) {
  const saved = { isTTY: process.stdin.isTTY, PATH: process.env.PATH };
  process.stdin.isTTY = true;
  t.after(() => { process.stdin.isTTY = saved.isTTY; process.env.PATH = saved.PATH; });
  await fn();
}

test("Codex, interactive: a resume continues the named session, and a stop ends it", async (t) => {
  const s = standIn("codex");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-run-"));
  process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aas-codex-home-"));
  const { default: codex, trustRunDir } = await import("../../runtime-codex/index.mjs");
  trustRunDir(runDir);
  await interactive(t, async () => {
    process.env.PATH = `${s.bin}${path.delimiter}${process.env.PATH}`;
    const started = Date.now();
    setTimeout(() => codex.interrupt("stopped by the user (SIGINT)"), 1000);
    const out = await codex.start(runDir, { resume: { sessionId: "3f2a", prompt: "go on" } }, { stopRequested: () => null });
    assert.deepEqual(JSON.parse(fs.readFileSync(s.args, "utf8")), ["resume", "3f2a", "go on"]);
    assert.ok(Date.now() - started < 15000, "ended by the stop, not left running");
    assert.equal(out.sessionId, "3f2a");
  });
});

test("Mistral Vibe, interactive: a resume continues the named session, and a stop ends it", async (t) => {
  const s = standIn("vibe");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-run-"));
  const { default: vibe } = await import("../../runtime-mistral-vibe/index.mjs");
  await interactive(t, async () => {
    process.env.PATH = `${s.bin}${path.delimiter}${process.env.PATH}`;
    const started = Date.now();
    setTimeout(() => vibe.interrupt("game over: Victory"), 1000);
    await vibe.start(runDir, { category: { game: "x" }, resume: { sessionId: "s-1", prompt: "go on" } }, { stopRequested: () => null });
    assert.deepEqual(JSON.parse(fs.readFileSync(s.args, "utf8")), ["--trust", "--resume", "s-1", "go on"]);
    assert.ok(Date.now() - started < 15000);
  });
});
