// The Slay the Spire plugin against the fake game: prepareRun starts the run,
// commands are playbacks with the game's processing time as IGT, act changes
// and the victory are chapter milestones (the splits).
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeSts } from "./fake-sts.mjs";
import { seedString } from "../plugin.mjs";

test("the seed code is the game's own: the HUD of the runs of 2026-09-11 11:11 and 11:20 showed these for these seeds", () => {
  assert.equal(seedString("1176032047771697386"), "C6BALI3FF8KB");
  assert.equal(seedString("1044066542771276695"), "ATGY4CVU47AK");
  assert.equal(seedString("AAS-FAKE"), "AAS-FAKE");
  assert.equal(seedString(""), "");
});

test("prepareRun starts the run; commands, milestones and the victory are reported", async () => {
  const fake = await startFakeSts({ floorsPerAct: 1, acts: 2 });
  process.env.AAS_STS_PORT = String(fake.port);
  process.env.AAS_STS_CLASS = "silent";
  process.env.AAS_STS_SEED = "TESTSEED";
  const { default: plugin } = await import(`../plugin.mjs?port=${fake.port}`);
  const events = [];
  globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage() {} };
  let sts;
  try {
    const ready = await plugin.prepareRun({ log() {} });
    assert.equal(ready.seed, "TESTSEED");
    assert.deepEqual(fake.state.commands, ["START SILENT 0 TESTSEED"]);
    sts = await plugin.connect();
    const s0 = await sts.state();
    assert.equal(s0.in_game, true);
    assert.equal(s0.game_state.floor, 1);
    // fight 1 (act 1): two strikes kill the monster, proceed -> act 2 (split "Act 1 boss")
    await sts.play(1, 0);
    const afterKill = await sts.play(1, 0);
    assert.equal(afterKill.game_state.screen_type, "COMBAT_REWARD");
    const act2 = await sts.proceed();
    assert.equal(act2.game_state.act, 2);
    await sts.play(1, 0); await sts.play(1, 0);
    const end = await sts.proceed();
    assert.equal(end.game_state.screen_type, "GAME_OVER");
    await assert.rejects(sts.end(), /run is over \(Victory\)/);
    const shot = await sts.screenshot();
    assert.match(shot.screenshots[0].url, /^data:image\/png;base64,/);
  } finally {
    sts?.close();
    await fake.close();
  }
  const playbacks = events.filter((e) => e.event === "game.playback");
  assert.equal(playbacks.filter((e) => e.data.phase === "start").length, 6, "every command sent is a playback; the one refused after game over was never sent");
  const ends = playbacks.filter((e) => e.data.phase === "end");
  assert.ok(ends.every((e) => typeof e.data.seconds === "number" || e.data.error), "IGT per command");
  const chapters = events.filter((e) => e.event === "game.milestone" && e.data.chapter).map((e) => e.data.label);
  assert.deepEqual(chapters, ["Act 1 boss", "Victory"]);
  const over = events.filter((e) => e.event === "game.over");
  assert.equal(over.length, 1); assert.equal(over[0].data.victory, true); assert.equal(over[0].data.label, "Victory");
  assert.equal(events.find((e) => e.event === "game.milestone" && e.data.label === "Victory").data.split, "Act 2 boss");
  assert.ok(events.some((e) => e.event === "game.milestone" && e.data.label === "Floor 2" && e.data.chapter === false));
});

test("prepareRun leaves a game-over screen behind and starts a new run", async () => {
  const fake = await startFakeSts({ floorsPerAct: 1, acts: 3, monsterHp: 1000 });
  process.env.AAS_STS_PORT = String(fake.port);
  process.env.AAS_STS_CLASS = "ironclad";
  process.env.AAS_STS_SEED = "";
  const { default: plugin } = await import(`../plugin.mjs?port=${fake.port}&gameover=1`);
  globalThis.aas = { event() {}, emitImage() {} };
  let sts;
  try {
    await plugin.prepareRun({ log() {} });
    sts = await plugin.connect();
    let s = await sts.state();
    while (s.game_state.screen_type !== "GAME_OVER") s = await sts.end();
    sts.close(); sts = null;
    const logs = [];
    const ready = await plugin.prepareRun({ log: (m) => logs.push(m) });
    assert.ok(logs.some((m) => /finished run \(death at floor 1\); leaving it/.test(m)), logs.join(" | "));
    assert.ok(logs.some((m) => /^run started/.test(m)));
    assert.equal(fake.state.inGame, true); assert.equal(fake.state.floor, 1);
    assert.equal(fake.state.commands.filter((c) => c.startsWith("START")).length, 2);
    assert.equal(ready.seed_code, "AAS-FAKE");
  } finally {
    sts?.close();
    await fake.close();
  }
});

test("the act boss is an end the harness can take as the goal; the plugin itself declares no victory before the game's own", async () => {
  const fake = await startFakeSts({ floorsPerAct: 1, acts: 3 });
  process.env.AAS_STS_PORT = String(fake.port);
  process.env.AAS_STS_CLASS = "ironclad";
  process.env.AAS_STS_SEED = "";
  const { default: plugin } = await import(`../plugin.mjs?port=${fake.port}&ends=1`);
  const events = [];
  globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage() {} };
  let sts;
  try {
    assert.deepEqual(plugin.ends.map((e) => e.id), ["act1", "act2", "act3", "heart"]);
    assert.equal(plugin.ends.find((e) => e.final).id, "act3");
    assert.equal(plugin.category.goal, undefined, "the goal is the harness's, from the ends list");
    assert.deepEqual(plugin.segments, ["Act 1 boss", "Act 2 boss", "Act 3 boss", "Heart"]);
    await plugin.prepareRun({ log() {} });
    sts = await plugin.connect();
    await sts.play(1, 0); await sts.play(1, 0);
    const act2 = await sts.proceed();
    assert.equal(act2.game_state.act, 2);
    const boss = events.find((e) => e.event === "game.milestone" && e.data.split === "Act 1 boss");
    assert.ok(boss, "the act 1 boss milestone");
    assert.equal(boss.data.end, "act1");
    assert.equal(events.filter((e) => e.event === "game.over").length, 0, "no game.over from the plugin before the game's own end");
    await sts.end(); // the game goes on
  } finally {
    sts?.close();
    await fake.close();
  }
});

test("the Secret Portal may be left, never entered", async () => {
  const fake = await startFakeSts({ floorsPerAct: 3, acts: 3 });
  process.env.AAS_STS_PORT = String(fake.port);
  process.env.AAS_STS_CLASS = "ironclad";
  const { default: plugin } = await import(`../plugin.mjs?port=${fake.port}&portal=1`);
  const events = [];
  globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage() {} };
  let sts;
  try {
    await plugin.prepareRun({ log() {} });
    sts = await plugin.connect();
    fake.portal();
    const s = await sts.state();
    assert.equal(s.game_state.screen_state.event_id, "SecretPortal");
    await assert.rejects(sts.choose(0), /Secret Portal: entering the portal is not allowed/);
    await assert.rejects(sts.choose("enter"), /not allowed/);
    const after = await sts.choose("leave");
    assert.equal(after.game_state.screen_type, "COMBAT_REWARD");
    assert.equal(fake.state.commands.filter((c) => c.startsWith("CHOOSE")).length, 1, "only the leave was sent to the game");
  } finally {
    sts?.close();
    await fake.close();
  }
  assert.equal(events.filter((e) => e.event === "game.milestone" && /Secret Portal offered/.test(e.data.label)).length, 1);
});

test("a death is not the end: restart() gives a new run with the same seed, the act split is not repeated", async () => {
  const fake = await startFakeSts({ floorsPerAct: 1, acts: 3, monsterHp: 1000 });
  process.env.AAS_STS_PORT = String(fake.port);
  process.env.AAS_STS_SEED = "";
  process.env.AAS_STS_CLASS = "ironclad";
  const { default: plugin } = await import(`../plugin.mjs?port=${fake.port}&death=1`);
  const events = [];
  globalThis.aas = { event: (event, data) => events.push({ event, data }), emitImage() {} };
  let sts;
  try {
    await plugin.prepareRun({ log() {} });
    sts = await plugin.connect();
    let s = await sts.state();
    while (s.game_state.screen_type !== "GAME_OVER") s = await sts.end(); // 6 damage per turn: dead after 14 turns
    assert.equal(s.game_state.screen_state.victory, false);
    await assert.rejects(sts.end(), /you died \(death 1\); call sts.restart\(\)/);
    const again = await sts.restart();
    assert.equal(again.in_game, true); assert.equal(again.game_state.floor, 1); assert.equal(again.game_state.seed, "AAS-FAKE");
    assert.ok(fake.state.commands.filter((c) => c.startsWith("START")).length === 2 && fake.state.commands.at(-1) === "START IRONCLAD 0 AAS-FAKE", fake.state.commands.filter((c) => c.startsWith("START")).join(" | "));
  } finally {
    sts?.close();
    await fake.close();
  }
  const labels = events.filter((e) => e.event === "game.milestone").map((e) => e.data.label);
  assert.ok(labels.includes("Death 1") && labels.includes("Attempt 2"), labels.join(","));
  const attempt = events.find((e) => e.event === "game.attempt");
  assert.deepEqual({ phase: attempt.data.phase, attempt: attempt.data.attempt, seed: attempt.data.seed }, { phase: "start", attempt: 2, seed: "AAS-FAKE" });
  const over = events.filter((e) => e.event === "game.over");
  assert.equal(over.length, 1); assert.equal(over[0].data.victory, false); assert.equal(over[0].data.deaths, 1);
  const restart = events.filter((e) => e.event === "game.playback" && e.data.command === "RESTART");
  assert.equal(restart.length, 2, "the restart is one playback (start + end)");
  assert.equal(events.filter((e) => e.event === "game.milestone" && e.data.chapter).length, 0, "no split for a death or a new attempt");
});

test("loadState continues the saved run through a click on Continue at the main menu", async () => {
  const fake = await startFakeSts({ floorsPerAct: 3, acts: 3 });
  process.env.AAS_STS_PORT = String(fake.port);
  const { default: plugin } = await import(`../plugin.mjs?resume=${fake.port}`);
  globalThis.aas = { event() {}, emitImage() {} };
  try {
    await plugin.prepareRun({ log() {} });
    const sts = await plugin.connect();
    await sts.play(1, 0); await sts.play(1, 0); await sts.proceed(); // floor 2
    sts.close();
    fake.toMenu();
    const r = await plugin.prepareRun({ log() {}, resume: true });
    assert.equal(r.floor, 2);
    assert.equal(fake.state.commands.filter((c) => c.startsWith("START")).length, 1, "no second START on resume");
  } finally {
    await fake.close();
  }
});

test("loadState puts the named save in place as the game's autosave and refuses a game that continues another floor", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const encode = (obj) => { const raw = Buffer.from(JSON.stringify(obj)); const key = Buffer.from("key"); const out = Buffer.alloc(raw.length); for (let i = 0; i < raw.length; i += 1) out[i] = raw[i] ^ key[i % key.length]; return out.toString("base64"); };
  const fake = await startFakeSts({ floorsPerAct: 3, acts: 3 });
  const gameRoot = mkdtempSync(join(tmpdir(), "aas-sts-root-"));
  const runDir = mkdtempSync(join(tmpdir(), "aas-sts-run-"));
  mkdirSync(join(gameRoot, "saves"), { recursive: true });
  mkdirSync(join(runDir, "saves"), { recursive: true });
  writeFileSync(join(gameRoot, "saves", "IRONCLAD.autosave"), encode({ floor_num: 7 })); // another run's autosave
  writeFileSync(join(runDir, "saves", "mine_002.autosave"), encode({ floor_num: 2 }));
  writeFileSync(join(runDir, "saves", "mine_005.autosave"), encode({ floor_num: 5 }));
  process.env.AAS_STS_PORT = String(fake.port);
  process.env.AAS_STS_GAME_ROOT = gameRoot;
  const { default: plugin } = await import(`../plugin.mjs?restore=${fake.port}`);
  delete process.env.AAS_STS_GAME_ROOT;
  globalThis.aas = { event() {}, emitImage() {} };
  try {
    await plugin.prepareRun({ log() {} });
    const sts = await plugin.connect();
    await sts.play(1, 0); await sts.play(1, 0); await sts.proceed(); // the fake is at floor 2
    sts.close();
    fake.toMenu();
    const r = await plugin.loadState({ name: "mine_002", runDir, log() {} });
    assert.equal(r.floor, 2);
    assert.equal(readFileSync(join(gameRoot, "saves", "IRONCLAD.autosave"), "utf8"), encode({ floor_num: 2 }), "the named save replaced the other run's autosave");
    fake.toMenu();
    await assert.rejects(plugin.loadState({ name: "mine_005", runDir, log() {} }), /continued at floor 2, but save mine_005 is floor 5/);
  } finally {
    await fake.close();
  }
});
