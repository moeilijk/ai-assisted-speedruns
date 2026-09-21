// `aas publish` takes no --game, so the CLI cannot load the game's own settings for it: publish has to do that
// itself from the run's brief. Without it a plugin cannot find its game folder and reports no build and no mods,
// and the bundle is "not conforming" for a reason that has nothing to do with the run. Measured on Balatro on
// 2026-09-21: published from a bare shell it said version null and mods [], while three mods had run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aas-publish-settings-"));
const envDir = join(dir, "game-env");
mkdirSync(envDir, { recursive: true });
process.env.AAS_GAME_ENV_DIR = envDir;
process.env.AAS_ENV_FILE = join(dir, "machine.env");
writeFileSync(process.env.AAS_ENV_FILE, "");
delete process.env.AAS_TEST_GAME_ROOT;

// A game whose build() can only answer when its own setting is loaded, which is exactly the case this is about.
const gameDir = join(dir, "settings-game");
mkdirSync(gameDir, { recursive: true });
const game = join(gameDir, "plugin.mjs");
writeFileSync(game, `export default {
  id: "settings_game",
  name: "Settings Game",
  ends: [{ id: "end", label: "The end", final: true }],
  capabilities: { turnBased: true, canPause: true, stateAccess: "full", inputRoute: "api", igt: false },
  documentation: "# Settings Game\\n",
  async build() {
    return { game: "Settings Game", version: process.env.AAS_TEST_GAME_ROOT ?? null, platform: "Test", mods: [] };
  },
};
`);
writeFileSync(join(envDir, "settings-game.env"), "AAS_TEST_GAME_ROOT=1.2.3-from-the-game-settings\n");

const { configure } = await import("../src/configure.mjs");
const { publish } = await import("../src/publish.mjs");

test("publish loads the game's own settings, so the bundle says which build was played", async () => {
  const runDir = join(dir, "run");
  await configure({ runtime: join(import.meta.dirname, "stub-runtime.mjs"), game, "run-dir": runDir, instructions: game }, { log() {} });
  writeFileSync(join(runDir, "run.jsonl"), `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000+01:00", kind: "event", event: "run.started", data: {} })}\n`);
  writeFileSync(join(runDir, "session.jsonl"), `${JSON.stringify({ type: "assistant", message: { role: "assistant", model: "m", content: [{ type: "text", text: "hello" }] }, timestamp: "2026-01-01T00:00:00.000Z", uuid: "u1", sessionId: "s" })}\n`);
  assert.equal(process.env.AAS_TEST_GAME_ROOT, undefined, "the shell that publishes knows nothing about the game");

  const { summary } = await publish(runDir, join(dir, "out"), { log() {} });
  assert.equal(summary.game?.version, "1.2.3-from-the-game-settings", "the version comes out of the game's own settings file");
});
