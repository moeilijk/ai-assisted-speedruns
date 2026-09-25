// Every command of `aas` as a real process, the way a person types it: without what it needs it says what is missing
// and exits 1; with what it needs it does its work and says so in words. Commands that reach the network or start a
// program on Windows (budget, doctor, check-agent, login, render, gui) are run here only as far as their refusals go.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-cli-"));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, "config"), AAS_ENV_FILE: path.join(dir, ".env"), AAS_GAME_ENV_DIR: path.join(dir, "games"), AAS_PROOF: "off" };
const aas = (...args) => new Promise((resolve) => execFile(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 120000 }, (e, out, err) => resolve({ code: e?.code ?? 0, out, err })));

test("every command without what it needs says what is missing and exits 1", async () => {
  const cases = [
    [["no-such-command"], /unknown command: no-such-command/],
    [["configure"], /--runtime is required/],
    [["start"], /--runtime is required/],
    [["check-connection"], /required|Usage/],
    [["check"], /Usage/],
    [["run"], /--runtime is required/],
    [["resume"], /--run-dir is required/],
    [["publish"], /Usage/],
    [["upload"], /Usage: aas upload/],
    [["upload", path.join(dir, "missing.zip")], /missing\.zip is not there: upload the \.zip that aas publish made/],
    [["stop"], /Usage: aas stop/],
    [["tickets", "extend"], /Usage: aas tickets/],
    [["tickets", "wipe", "0".repeat(32)], /Usage: aas tickets/],
    [["timeline"], /Usage: aas timeline/],
    [["render"], /Usage|required/],
    [["upload-sheet"], /Usage|required/],
    [["scan"], /Usage: aas scan/],
    [["check-agent"], /required|Usage/],
    [["gui", "--port", "abc"], /--port "abc" is not allowed/],
    [["key", "--claim"], /identity/i],
  ];
  for (const [args, reason] of cases) {
    const r = await aas(...args);
    assert.equal(r.code, 1, `aas ${args.join(" ")} exits 1 (got ${r.code}): ${r.out}${r.err}`);
    assert.match(`${r.out}${r.err}`, reason, `aas ${args.join(" ")}: ${r.out}${r.err}`);
  }
});

test("aas without a command, and aas help, show the help and exit 0", async () => {
  for (const args of [[], ["help"]]) {
    const r = await aas(...args);
    assert.equal(r.code, 0, `aas ${args.join(" ")}`);
    assert.match(`${r.out}${r.err}`, /Usage:/);
  }
});

test("the commands that work on files do their work and say so in words", { timeout: 180000 }, async () => {
  // A real run of the tests' game, published, is what the file commands work on.
  const fake = path.join(here, "gui-game", "fake");
  const runDir = path.join(dir, "cli-run");
  let r = await aas("run", "--runtime", "scripted", "--game", path.join(fake, "plugin.mjs"), "--run-dir", runDir, "--bot", path.join(fake, "bot.mjs"), "--recorder", "null", "--keep-open", "--proof", "off");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^run stopped after \d\d:\d\d:\d\d; no recording$/m, "aas run ends with a sentence");

  r = await aas("timeline", runDir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /written to .*timeline/);

  const out = path.join(dir, "public", "cli-run");
  r = await aas("publish", runDir, out);
  // The bundle is made, and publish says it is not conforming (a mock, no recording) and exits 1 for that reason.
  assert.ok(fs.existsSync(`${out}.zip`), r.err);
  assert.equal(r.code, 1);
  assert.match(r.out, /Result: .* Not conforming\./);

  r = await aas("scan", out);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /nothing found that may not be published/);
  fs.writeFileSync(path.join(out, "notes.txt"), "found at /home/someone/secret\n");
  r = await aas("scan", out);
  assert.equal(r.code, 1);
  assert.match(r.out, /1 file in .* may not be published:\n  notes\.txt: private Unix home path/);

  r = await aas("check", `${out}.zip`);
  assert.equal(r.code, 1, "a mock without a recording is not a valid entry, and check says why");
  assert.match(r.out, /a model played|recording/);

  r = await aas("stop", "--run-dir", runDir);
  assert.equal(r.code, 0);
  assert.match(r.out, /no session is running in this run directory/);

  r = await aas("tickets");
  assert.equal(r.code, 0);
  assert.match(r.out, /no tickets on this machine/);

  r = await aas("logout");
  assert.equal(r.code, 0);
  assert.match(r.out, /not signed in/);

  r = await aas("key", "--key", path.join(dir, "key.pem"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /created: .*key\.pem/);
  r = await aas("key", "--key", path.join(dir, "key.pem"));
  assert.match(r.out, /already there: .*key\.pem/);
});
