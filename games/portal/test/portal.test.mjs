// Functional test: the real AAS broker (under node --permission) loads the
// Portal plugin, which loads portal-agent's real controller, which talks to
// a fake SPT over TCP. Skipped when portal-agent is not checked out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBroker } from "../../../packages/core/src/mcp-client.mjs";
import { checkConnection } from "../../../packages/core/src/check-connection.mjs";
import { startFakeSpt } from "./fake-spt.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginPath = resolve(here, "..", "plugin.mjs");
const portalAgentDir = resolve(process.env.AAS_PORTAL_AGENT_DIR || join(here, "..", "..", "..", ".local", "portal-agent"));
const available = existsSync(join(portalAgentDir, "controller", "index.mjs"));

test("portal plugin drives portal-agent's controller through the broker", { skip: !available && "portal-agent not checked out" }, async () => {
  const spt = await startFakeSpt();
  const runDir = mkdtempSync(join(tmpdir(), "aas-portal-test-"));
  const client = startBroker({
    gameModule: pluginPath,
    runDir,
    readable: [portalAgentDir],
    endpoints: [{ host: "127.0.0.1", port: spt.port }],
    timeZone: "Europe/Amsterdam",
    env: { AAS_PORTAL_SPT_PORT: String(spt.port), AAS_PORTAL_AGENT_DIR: portalAgentDir },
    timeoutMs: 20000,
  });
  try {
    const init = await client.initialize();
    assert.equal(init.serverInfo.name, "portal");
    const tools = (await client.request("tools/list")).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["portal_documentation", "portal_exec", "portal_screenshot"]);
    assert.match(tools.find((t) => t.name === "portal_exec").description, /`portal` is in scope/);

    const doc = await client.call("portal_documentation");
    assert.match(doc.content[0].text, /Portal JavaScript API Reference/);

    // Default observe() (AAS contract) and portal-agent's explicit fields both work.
    const obs = JSON.parse((await client.call("portal_exec", { code: "return await portal.observe();" })).content[0].text);
    assert.deepEqual(obs, { facing: { pitch: 0, yaw: 90, roll: 0 }, position: { x: -544, y: -368, z: 128 } });
    const facing = JSON.parse((await client.call("portal_exec", { code: 'return await game.observe(["facing"]);' })).content[0].text);
    assert.deepEqual(Object.keys(facing), ["facing"]);

    // A TAS plan exactly as in portal-agent's AGENTS.md; the run returns a screenshot image.
    const run = await client.call("portal_exec", {
      code: 'const t = portal.tas(); t.hold(67, { forward: true }); t.hold(33, { forward: true }, { left: 45 }); const r = await t.run(); return { ticks: r.ticks, facing: r.facing, position: r.position };',
    });
    const text = JSON.parse(run.content.find((c) => c.type === "text").text);
    assert.equal(text.ticks, 100);
    assert.equal(text.facing.yaw, 135);
    assert.equal(text.position.x, -544 + 100 * 4);
    const image = run.content.find((c) => c.type === "image");
    assert.equal(image.mimeType, "image/jpeg");
    assert.equal(Buffer.from(image.data, "base64")[0], 0xff);

    const shot = await client.call("portal_screenshot");
    assert.equal(shot.content[0].type, "image");

    // Hardening: only the SPT endpoint is reachable, env is scrubbed.
    const blocked = await client.request("tools/call", {
      name: "portal_exec",
      arguments: { code: 'const net = await import("node:net"); return await new Promise((res) => { const s = net.connect(443, "example.com"); s.on("error", (e) => res(e.message)); });' },
    });
    assert.match(blocked.content[0].text, /Network access is blocked/);
    const env = JSON.parse((await client.call("portal_exec", { code: "return Object.keys(process.env)" })).content[0].text);
    assert.ok(env.every((k) => k.startsWith("AAS_")), `leaked env: ${env}`);
  } finally {
    client.close();
    await client.exited();
    await spt.close();
  }

  // The private log has portal-agent's record shapes and the screenshots on disk.
  const log = readFileSync(join(runDir, "run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.some((r) => r.kind === "tool_call" && r.name === "portal_exec" && /portal\.tas\(\)/.test(r.input.code)));
  assert.ok(readdirSync(join(runDir, "screenshots")).some((f) => f.endsWith(".jpg")));
  assert.ok(existsSync(join(runDir, "tools.json")) && existsSync(join(runDir, "documentation.md")));
  assert.equal(spt.seen.filter((m) => m.type === "tas_run").length, 1);
});

test("aas check-connection passes against the fake SPT, including --exercise", { skip: !available && "portal-agent not checked out" }, async () => {
  const spt = await startFakeSpt();
  const runDir = mkdtempSync(join(tmpdir(), "aas-portal-check-"));
  process.env.AAS_PORTAL_SPT_PORT = String(spt.port);
  process.env.AAS_PORTAL_AGENT_DIR = portalAgentDir;
  const lines = [];
  try {
    assert.equal(await checkConnection({ gameModule: pluginPath, runDir, exercise: true, log: (l) => lines.push(l) }), true);
  } finally {
    delete process.env.AAS_PORTAL_SPT_PORT;
    await spt.close();
  }
  assert.ok(lines.some((l) => /camera turn and restore/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /ten simulation ticks/.test(l)), lines.join("\n"));
});
