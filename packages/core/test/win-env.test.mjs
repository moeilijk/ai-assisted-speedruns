// winExec tells a call that never reached Windows apart from a program that ran and answered with an error: the
// first is made again, the second is passed on as it is. Node itself stands in for the Windows program here, so this
// test runs anywhere; the real calls are exercised by the launchers in `npm run e2e:real`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { winExec } from "../src/windows/win-env.mjs";

const node = process.execPath;
const cwd = process.cwd();

test("a program that answers is read, without its carriage returns", () => {
  const out = winExec(node, ["-e", "process.stdout.write('C:\\\\Users\\\\x\\r\\n')"], { cwd });
  assert.equal(out, "C:\\Users\\x\n");
});

test("a program that ran and answered with an error is not asked twice", () => {
  const tries = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aas-winexec-")), "tries");
  fs.writeFileSync(tries, "");
  assert.throws(() => winExec(node, ["-e", `require("fs").appendFileSync(${JSON.stringify(tries)}, "x"); console.error("the program says no"); process.exit(2)`], { cwd, tries: 3, waitMs: 1 }), /exit 2: the program says no/);
  assert.equal(fs.readFileSync(tries, "utf8"), "x", "called once");
});

test("a call that never reached Windows is made again, and the answer of the next try is the answer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-winexec-"));
  const tries = path.join(dir, "tries");
  fs.writeFileSync(tries, "");
  // The first call fails the way WSL's interop fails; the second answers.
  const script = `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(tries)}, "x");
if (fs.readFileSync(${JSON.stringify(tries)}, "utf8").length === 1) { console.error("<3>WSL (1256952 - ) ERROR: UtilAcceptVsock:271: accept4 failed 110"); process.exit(1); }
console.log("answered");`;
  const lines = [];
  assert.equal(winExec(node, ["-e", script], { cwd, tries: 3, waitMs: 1, log: (l) => lines.push(l) }), "answered\n");
  assert.equal(fs.readFileSync(tries, "utf8"), "xx", "called twice");
  assert.match(lines.join("\n"), /did not reach Windows \(attempt 1 of 3\)/);
  assert.match(lines.join("\n"), /came back on attempt 2 of 3/);
});

test("a call that never reaches Windows at all says so, with what WSL reported", () => {
  const script = `console.error("<3>WSL (1) ERROR: UtilAcceptVsock:271: accept4 failed 110"); process.exit(1);`;
  assert.throws(() => winExec(node, ["-e", script], { cwd, tries: 2, waitMs: 1 }), /did not reach Windows in 2 attempts \(WSL interop\).*accept4 failed 110/s);
});
