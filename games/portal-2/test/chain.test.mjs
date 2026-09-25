// Portal 2 through the whole harness against the fake SAR: a first segment on sp_a1_intro1 that ends when the player is
// done (stopped), a resume from the engine's save after which the console log shows sp_a1_intro2, the goal, then the
// bundle and its check (packages/core/test/chain.mjs says what every game must do).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeSar } from "./fake-sar.mjs";
import { chainThroughHarness } from "../../../packages/core/test/chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Portal 2: a stopped first segment, resumed from the engine's save to sp_a1_intro2, published and checked", { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-chain-portal2-"));
  const gameRoot = path.join(dir, "Portal 2");
  const log = path.join(gameRoot, "portal2", "console.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'Loading map "sp_a1_intro1"\n');
  const sar = await startFakeSar({ gameRoot });
  Object.assign(process.env, { AAS_PORTAL2_GAME_ROOT: gameRoot, AAS_PORTAL2_PORT: String(sar.port) });
  try {
    const r = await chainThroughHarness({
      game: path.join(here, "..", "plugin.mjs"), dir, goal: "sp_a1_intro2", bot: path.join(here, "chain-bot.mjs"), expectFirst: "stopped",
      beforeResume: () => fs.appendFileSync(log, 'Loading map "sp_a1_intro2"\n'),
    });
    const segment2 = r.events.slice(r.events.findLastIndex((e) => e.event === "run.started"));
    assert.ok(segment2.some((e) => e.event === "game.over" && e.data.victory && e.data.goal === "sp_a1_intro2"), "the second segment reached the goal");
  } finally {
    await sar.close();
  }
});
