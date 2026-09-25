// Slay the Spire through the whole harness against its fake: the scripted player to the Act 1 boss, a resume on to
// Act 2, the bundle and its check (packages/core/test/chain.mjs says what every game must do).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeSts } from "./fake-sts.mjs";
import { chainThroughHarness } from "../../../packages/core/test/chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Slay the Spire: run to act1, resume to act2, publish, check", { timeout: 180000 }, async () => {
  const fake = await startFakeSts({ floorsPerAct: 2, acts: 3, monsterHp: 10, cardDamage: 6 });
  Object.assign(process.env, { AAS_STS_PORT: String(fake.port), AAS_STS_CLASS: "ironclad", AAS_STS_SEED: "" });
  delete process.env.AAS_STS_GAME_ROOT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-chain-sts-"));
  try {
    const r = await chainThroughHarness({ game: path.join(here, "..", "plugin.mjs"), dir, goal: "act1", resumeGoal: "act2" });
    const goals = r.events.filter((e) => e.event === "game.over" && e.data.victory).map((e) => e.data.goal);
    assert.deepEqual(goals, ["act1", "act2"], "each segment ended at its own goal");
  } finally {
    await fake.close();
  }
});
