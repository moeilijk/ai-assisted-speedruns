// Portal through the whole harness against the fake SourcePauseTool: the scripted player until the fake's map
// change (chamber02), a resume that plays on until the player has nothing left, the bundle and its check.
// Needs portal-agent's controller in .local/portal-agent (npm run portal:fetch); skipped without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeSpt } from "./fake-spt.mjs";
import { chainThroughHarness } from "../../../packages/core/test/chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(process.env.AAS_PORTAL_AGENT_DIR || path.join(here, "..", "..", "..", ".local", "portal-agent"));
const skip = fs.existsSync(path.join(agentDir, "controller", "index.mjs")) ? false : "portal-agent not checked out (npm run portal:fetch)";

test("Portal: run to chamber02, resume until the player is done, publish, check", { skip, timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-chain-portal-"));
  const gameRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aas-chain-portal-game-"));
  const spt = await startFakeSpt({ gameRoot, readyDelayMs: 300, transitionAfterTicks: 150 });
  Object.assign(process.env, { AAS_PORTAL_SPT_PORT: String(spt.port), AAS_PORTAL_AGENT_DIR: agentDir, AAS_PORTAL_GAME_ROOT: gameRoot, AAS_TIME_ZONE: "Europe/Amsterdam", AAS_BOT_PORTAL_STEPS: "40" });
  try {
    const r = await chainThroughHarness({ game: path.join(here, "..", "plugin.mjs"), dir, goal: "chamber02", resumeGoal: "chamber03", expectSecond: "stopped" });
    const goals = r.events.filter((e) => e.event === "game.over" && e.data.victory).map((e) => e.data.goal);
    assert.deepEqual(goals, ["chamber02"], "the first segment ended at its goal");
  } finally {
    await spt.close();
  }
});
