// Balatro through the whole harness against its fake behind the real bridge: the scripted player to the end of ante 1,
// a resume on to ante 2, the bundle and its check (packages/core/test/chain.mjs says what every game must do).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeBalatrobot } from "./fake-balatrobot.mjs";
import { chainThroughHarness } from "../../../packages/core/test/chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-chain-balatro-"));
Object.assign(process.env, { AAS_BALATRO_BRIDGE_STATE: path.join(dir, "bridge.json"), AAS_BALATRO_PATHS: "native", AAS_BALATRO_TOOLS_DIR: path.join(dir, "tools"), AAS_BALATRO_DECK: "blue", AAS_BALATRO_STAKE: "white" });
const { startBridge } = await import("../bridge.mjs");

test("Balatro: run to ante1, resume to ante2, publish, check", { timeout: 180000 }, async () => {
  const bot = await startFakeBalatrobot({ winAnte: 3 });
  const bridge = await startBridge({ port: 0, botPort: bot.port, shotDir: dir });
  process.env.AAS_BALATRO_PORT = String(bridge.port);
  try {
    const r = await chainThroughHarness({ game: path.join(here, "..", "plugin.mjs"), dir, goal: "ante1", resumeGoal: "ante2" });
    const goals = r.events.filter((e) => e.event === "game.over" && e.data.victory).map((e) => e.data.goal);
    assert.deepEqual(goals, ["ante1", "ante2"], "each segment ended at its own goal");
  } finally {
    await bridge.close();
    await bot.close();
  }
});
