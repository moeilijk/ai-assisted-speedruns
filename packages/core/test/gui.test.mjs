// The GUI's plumbing: the .env it edits keeps what it does not touch, paths are shown the Windows way and used the
// harness way, and the page server only answers this machine's own origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-gui-"));
process.env.AAS_ENV_FILE = path.join(dir, ".env");
const { readEnv, writeEnv } = await import("../src/gui/env-file.mjs");
const { toLocal, toWindows, IS_WSL } = await import("../src/gui/windows-paths.mjs");

test("writeEnv changes a setting in place, appends a new one, removes an emptied one, keeps comments", () => {
  fs.writeFileSync(process.env.AAS_ENV_FILE, "# machine settings\nAAS_OBS_URL=ws://127.0.0.1:4455\n# a comment\nAAS_STS_SEED=23M\n");
  writeEnv({ AAS_OBS_URL: "ws://127.0.0.1:4460", AAS_OUTPUT_DIR: "/mnt/g/OBS", AAS_STS_SEED: "" });
  const text = fs.readFileSync(process.env.AAS_ENV_FILE, "utf8");
  assert.equal(text, "# machine settings\nAAS_OBS_URL=ws://127.0.0.1:4460\n# a comment\n\n# set with aas gui\nAAS_OUTPUT_DIR=/mnt/g/OBS\n");
  assert.deepEqual(readEnv(), { AAS_OBS_URL: "ws://127.0.0.1:4460", AAS_OUTPUT_DIR: "/mnt/g/OBS" });
  assert.equal(process.env.AAS_OUTPUT_DIR, "/mnt/g/OBS");
  assert.throws(() => writeEnv({ "BAD NAME": "x" }), /not a setting name/);
  writeEnv({ AAS_OUTPUT_DIR: "/mnt/h/runs\nAAS_EVIL=1" });
  assert.equal(readEnv().AAS_EVIL, undefined, "a value cannot add a line");
});

test("paths: Windows form for people, local form for the harness", { skip: !IS_WSL && "only under WSL" }, () => {
  assert.equal(toLocal("G:\\OBS\\Balatro"), "/mnt/g/OBS/Balatro");
  assert.equal(toLocal("g:/OBS"), "/mnt/g/OBS");
  assert.equal(toLocal("C:\\"), "/mnt/c");
  assert.equal(toWindows("/mnt/g/OBS/Balatro"), "G:\\OBS\\Balatro");
  assert.equal(toWindows("/mnt/c"), "C:\\");
  assert.equal(toLocal("/mnt/g/OBS"), "/mnt/g/OBS");
});

test("the page server refuses other hosts and cross-origin changes", async () => {
  const { startGui } = await import("../src/gui/server.mjs");
  const gui = await startGui({ port: 0, open: false, log() {} });
  const port = gui.server.address().port;
  const http = await import("node:http");
  const call = (method, p, headers, body) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end(body);
  });
  try {
    assert.equal(await call("GET", "/", { Host: `127.0.0.1:${port}` }), 200);
    assert.equal(await call("GET", "/api/state", { Host: `evil.example:${port}` }), 403);
    assert.equal(await call("POST", "/api/settings", { Host: `127.0.0.1:${port}`, Origin: "http://evil.example", "Content-Type": "application/json" }, "{}"), 403);
  } finally {
    gui.server.close();
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
});
