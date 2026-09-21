// The Balatro plugin against a fake balatrobot behind the real bridge: the bridge refuses the cheats and the
// harness's methods to the agent, prepareRun starts the run, actions are playbacks, antes are splits, the win
// ends the run, a game over is followed by a restart, saves go through the harness's token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBalatrobot } from "./fake-balatrobot.mjs";
import { jsonRpcClient } from "../../../packages/core/src/json-rpc-http.mjs";

const dir = mkdtempSync(join(tmpdir(), "aas-balatro-"));
process.env.AAS_BALATRO_BRIDGE_STATE = join(dir, "bridge.json");
process.env.AAS_BALATRO_PATHS = "native";
process.env.AAS_BALATRO_TOOLS_DIR = join(dir, "tools");
process.env.AAS_BALATRO_DECK = "blue";
process.env.AAS_BALATRO_STAKE = "white";
const { startBridge } = await import("../bridge.mjs");

async function setup(opts) {
  const bot = await startFakeBalatrobot(opts);
  const bridge = await startBridge({ port: 0, botPort: bot.port, shotDir: dir });
  process.env.AAS_BALATRO_PORT = String(bridge.port);
  const { default: plugin } = await import(`../plugin.mjs?port=${bridge.port}`);
  const events = [];
  globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage() {} };
  return { bot, bridge, plugin, events, close: async () => { await bridge.close(); await bot.close(); } };
}

test("the bridge refuses the cheats to everyone and the harness's methods to the agent", async () => {
  const t = await setup();
  try {
    const agent = jsonRpcClient({ port: t.bridge.port });
    const harness = jsonRpcClient({ port: t.bridge.port, headers: { "X-AAS-Token": t.bridge.token } });
    for (const m of ["set", "add"]) {
      await assert.rejects(agent.call(m, { money: 999 }), /not available in an AI Assisted Speedrun/);
      await assert.rejects(harness.call(m, { money: 999 }), /not available in an AI Assisted Speedrun/);
    }
    for (const m of ["start", "menu", "save", "load", "screenshot", "rpc.discover"]) await assert.rejects(agent.call(m, {}), /not available to the agent/, m);
    await assert.rejects(agent.call("aas.restart"), /only possible after a game over/);
    assert.equal((await harness.call("start", { deck: "RED", stake: "WHITE" })).state, "BLIND_SELECT");
    assert.equal((await agent.call("gamestate")).state, "BLIND_SELECT");
    assert.ok(!t.bot.state.calls.some((c) => ["set", "add"].includes(c.method)), "no cheat reached the game");
    assert.equal(t.bot.state.money, 4);
  } finally { await t.close(); }
});

test("prepareRun starts the run; actions, splits and the win are reported", async () => {
  const t = await setup({ winAnte: 2 });
  let bal;
  try {
    t.bot.state.state = "SHOP"; // a game left in a run: prepareRun goes back to the menu first
    const logs = [];
    const ready = await t.plugin.prepareRun({ log: (m) => logs.push(m) });
    assert.equal(ready.seed, "RND0");
    assert.ok(logs.some((m) => /going back to it/.test(m)), logs.join(" | "));
    assert.deepEqual(t.bot.state.calls.filter((c) => c.method === "start").map((c) => c.params), [{ deck: "BLUE", stake: "WHITE" }]);
    bal = await t.plugin.connect();
    let s = await bal.state();
    assert.equal(s.state, "BLIND_SELECT");
    assert.ok(!("shop" in s), "empty shop area left out");
    await assert.rejects(bal.play([0]), /Balatro refused play: requires SELECTING_HAND/);
    while (!s.won) {
      if (s.state === "BLIND_SELECT") s = await bal.select();
      else if (s.state === "SELECTING_HAND") s = await bal.play([0, 1, 2, 3, 4]);
      else if (s.state === "ROUND_EVAL") s = await bal.cashOut();
      else if (s.state === "SHOP") s = await bal.nextRound();
      else assert.fail(`unexpected ${s.state}`);
    }
    await assert.rejects(bal.cashOut(), /the run is won/);
    const shot = await bal.screenshot();
    assert.match(shot.screenshots[0].url, /^data:image\/png;base64,iVBOR/);
  } finally { bal?.close(); await t.close(); }
  const chapters = t.events.filter((e) => e.event === "game.milestone" && e.data.chapter).map((e) => [e.data.label, e.data.split]);
  assert.deepEqual(chapters, [["Ante 1", "Ante 1"], ["Ante 2", "Ante 2"], ["Win", "Ante 8"]]);
  assert.equal(t.events.find((e) => e.data.label === "Win").data.end, "win");
  // Every ante is an end of its own: the harness declares the victory when the goal's milestone goes by.
  const { resolveGoal, goalReached } = await import("../../../packages/core/src/goal.mjs");
  const ante1 = t.events.find((e) => e.event === "game.milestone" && e.data.label === "Ante 1");
  assert.ok(goalReached(resolveGoal(t.plugin, "ante1").end, ante1));
  assert.ok(!goalReached(resolveGoal(t.plugin, "ante2").end, ante1));
  assert.equal(resolveGoal(t.plugin, null).id, "win");
  assert.deepEqual(t.plugin.ends.map((e) => e.id), ["ante1", "ante2", "ante3", "ante4", "ante5", "ante6", "ante7", "win"]);
  for (const file of Object.values(t.plugin.setup.splits)) assert.ok((await import("node:fs")).existsSync(file), file);
  const over = t.events.filter((e) => e.event === "game.over");
  assert.equal(over.length, 1);
  assert.equal(over[0].data.victory, true);
  const playbacks = t.events.filter((e) => e.event === "game.playback");
  const starts = playbacks.filter((e) => e.data.phase === "start");
  assert.equal(starts.length, playbacks.length / 2, "every action has a start and an end");
  assert.ok(playbacks.filter((e) => e.data.phase === "end" && !e.data.error).every((e) => typeof e.data.seconds === "number"));
  assert.ok(t.events.some((e) => e.event === "game.milestone" && e.data.label === "Round 1" && e.data.chapter === false));
});

test("a game over refuses everything but restart, which starts a new run with the same deck and stake", async () => {
  const t = await setup({ chipsPerCard: 1 });
  let bal;
  try {
    await t.plugin.prepareRun({ log() {} });
    bal = await t.plugin.connect();
    let s = await bal.select();
    while (s.state !== "GAME_OVER") s = await bal.play([0]);
    await assert.rejects(bal.select(), /game over \(1\); call bal.restart\(\)/);
    s = await bal.restart();
    assert.equal(s.state, "BLIND_SELECT");
    assert.equal(s.deck, "BLUE");
    assert.equal(s.seed, "RND1", "a new random seed");
    await assert.rejects(bal.restart(), /only for after a game over/);
  } finally { bal?.close(); await t.close(); }
  assert.deepEqual(t.bot.state.calls.filter((c) => c.method === "start").map((c) => c.params), [{ deck: "BLUE", stake: "WHITE" }, { deck: "BLUE", stake: "WHITE" }]);
  const over = t.events.filter((e) => e.event === "game.over");
  assert.equal(over.length, 1); assert.equal(over[0].data.victory, false);
  assert.equal(t.events.filter((e) => e.event === "game.attempt").length, 1);
});

test("a set seed is passed to the game and kept by restart", async () => {
  const t = await setup({ chipsPerCard: 1, hands: 1 });
  let bal;
  try {
    const ready = await t.plugin.prepareRun({ log() {}, seed: "SETSEED1" });
    assert.equal(ready.seed, "SETSEED1");
    bal = await t.plugin.connect();
    await bal.select();
    await bal.play([0]);
    const s = await bal.restart();
    assert.equal(s.seed, "SETSEED1");
  } finally { bal?.close(); await t.close(); }
});

test("saveState and loadState go through the harness's token", async () => {
  const t = await setup();
  try {
    await t.plugin.prepareRun({ log() {} });
    const saved = await t.plugin.saveState({ name: "aas_test_001" });
    assert.ok(existsSync(saved.file), saved.file);
    const bal = await t.plugin.connect();
    await bal.select();
    assert.equal((await bal.state()).state, "SELECTING_HAND");
    const logs = [];
    await t.plugin.loadState({ name: "aas_test_001", log: (m) => logs.push(m) });
    assert.equal((await bal.state()).state, "BLIND_SELECT");
    assert.ok(logs.some((m) => /save aas_test_001 loaded: BLIND_SELECT, ante 1/.test(m)), logs.join(" | "));
  } finally { await t.close(); }
});

test("through the sandboxed broker: three tools, the controller works, balatrobot itself is out of reach", async () => {
  const { startBroker } = await import("../../../packages/core/src/mcp-client.mjs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const pluginPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "plugin.mjs");
  const t = await setup();
  const runDir = mkdtempSync(join(tmpdir(), "aas-balatro-run-"));
  const client = startBroker({
    gameModule: pluginPath,
    runDir,
    readable: [dirname(pluginPath)],
    endpoints: [{ host: "127.0.0.1", port: t.bridge.port }],
    timeZone: "Europe/Amsterdam",
    env: { AAS_BALATRO_PORT: String(t.bridge.port) },
    timeoutMs: 20000,
  });
  try {
    await t.plugin.prepareRun({ log() {} });
    await client.initialize();
    const tools = (await client.request("tools/list")).tools.map((x) => x.name).sort();
    assert.deepEqual(tools, ["balatro_documentation", "balatro_exec", "balatro_screenshot"]);
    const exec = async (code) => { const r = await client.call("balatro_exec", { code }); return r.content.find((c) => c.type === "text")?.text; };
    assert.match(await exec("const s = await bal.select(); return s.state;"), /SELECTING_HAND/);
    // node:http connects synchronously through the locked net.Socket.prototype.connect: the call fails.
    await assert.rejects(exec(`const http = await import("node:http"); const req = http.request({ host: "127.0.0.1", port: ${t.bot.port}, method: "POST" }); req.end('{"jsonrpc":"2.0","method":"set","params":{"money":999},"id":1}'); return "sent";`), /Network access is blocked/);
    const token = await exec(`try { const fs = await import("node:fs"); return fs.readFileSync(${JSON.stringify(process.env.AAS_BALATRO_BRIDGE_STATE)}, "utf8"); } catch (e) { return "refused: " + e.code; }`);
    assert.match(token, /refused: ERR_ACCESS_DENIED/);
    const shot = await client.call("balatro_screenshot");
    assert.ok(shot.content.some((c) => c.type === "image"));
  } finally {
    client.close();
    await t.close();
  }
  assert.equal(t.bot.state.money, 4, "the direct `set` never reached the game");
});

test("the scripted player plays the hand that scores most, not the biggest group", async () => {
  const { bestHand } = await import("../bot.mjs");
  const cards = ["2", "K", "7", "K", "A", "3", "K", "9"].map((rank, i) => ({ key: `${"HSCDHSCD"[i]}_${rank}`, value: { rank } }));
  const best = bestHand(cards);
  assert.equal(best.type, "Three of a Kind");
  assert.deepEqual(best.indices, [1, 3, 6], "the three kings, and nothing that does not score");
});
