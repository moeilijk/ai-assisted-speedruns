// Smoke test: start the broker under node --permission with the fake game,
// drive it over stdio like an MCP client, and check tools, sandbox and run log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = resolve(here, "..");
const broker = join(core, "src", "broker.mjs");
const fakeGame = join(here, "fake-game.mjs");

function rpc(id, method, params) {
  return JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
}
function call(id, name, args = {}) {
  return rpc(id, "tools/call", { name, arguments: args });
}

async function runBroker(lines, runDir) {
  const child = spawn(
    process.execPath,
    ["--permission", `--allow-fs-read=${core}`, `--allow-fs-write=${runDir}`, broker],
    {
      env: {
        SECRET_TOKEN: "must-not-leak",
        AAS_GAME_MODULE: fakeGame,
        AAS_RUN_DIR: runDir,
        AAS_TIME_ZONE: "Europe/Amsterdam",
        AAS_ALLOWED_ENDPOINTS: "127.0.0.1:27182",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(lines.map((l) => `${l}\n`).join(""));
  const code = await new Promise((res) => child.on("close", res));
  const responses = new Map();
  for (const line of stdout.split("\n").filter((l) => l.trim())) {
    const msg = JSON.parse(line);
    responses.set(msg.id, msg);
  }
  return { code, responses, stderr };
}

test("broker exposes three tools, sandboxes exec, and logs to the run directory", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aas-broker-test-"));
  const { code, responses, stderr } = await runBroker(
    [
      rpc(1, "initialize", { protocolVersion: "2025-06-18" }),
      rpc(null, "notifications/initialized"),
      rpc(2, "tools/list"),
      call(3, "fake_game_exec", { code: "return await game.observe()" }),
      call(4, "fake_game_exec", { code: 'await game.act("shoot"); return await game.screenshot()' }),
      call(5, "fake_game_screenshot"),
      call(6, "fake_game_documentation"),
      call(7, "fake_game_exec", {
        code: 'const net = await import("node:net"); return await new Promise((res) => { const s = net.connect(80, "example.com"); s.on("error", (e) => res("err:" + e.message)); })',
      }),
      call(8, "fake_game_exec", { code: "return Object.keys(process.env)" }),
      call(9, "fake_game_exec", { code: "process.exit(3)" }),
      call(10, "fake_game_exec", { code: 'const fs = await import("node:fs"); fs.writeFileSync("/etc/aas-should-fail", "x"); return "wrote"' }),
    ],
    runDir,
  );

  assert.equal(code, 0, stderr);
  assert.equal(responses.get(1).result.serverInfo.name, "fake_game");
  assert.deepEqual(
    responses.get(2).result.tools.map((t) => t.name).sort(),
    ["fake_game_documentation", "fake_game_exec", "fake_game_screenshot"],
  );
  assert.deepEqual(JSON.parse(responses.get(3).result.content[0].text), { turn: 1, hp: 100 });
  assert.equal(responses.get(4).result.content[0].type, "image");
  assert.equal(responses.get(5).result.content[0].type, "image");
  assert.match(responses.get(6).result.content[0].text, /Fake Game API/);
  assert.equal(responses.get(7).result.isError, true);
  assert.match(responses.get(7).result.content[0].text, /Network access is blocked/);
  const env = JSON.parse(responses.get(8).result.content[0].text);
  assert.ok(env.every((k) => k.startsWith("AAS_")), `leaked env: ${env}`);
  assert.match(responses.get(9).result.content[0].text, /Process termination is blocked/);
  assert.equal(responses.get(10).result.isError, true, "write outside the run dir must fail");

  assert.ok(existsSync(join(runDir, "tools.json")));
  assert.ok(existsSync(join(runDir, "documentation.md")));
  const log = readFileSync(join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.filter((r) => r.kind === "tool_call").length, 8);
  assert.equal(log.filter((r) => r.kind === "tool_result").length, 8);
  assert.ok(log.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(r.timestamp)));
  assert.deepEqual(readdirSync(join(runDir, "screenshots")).sort(), ["call-00002-1.png", "call-00003-1.png"]);
  assert.ok(log.some((r) => r.kind === "tool_result" && r.output[0].path === "screenshots/call-00002-1.png"));
});
