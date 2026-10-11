// A Setup row that is not ready carries the fix of its first unmet condition, so the page shows that button; a row
// that is ready offers the install again. On 2026-10-08 the game rows of Portal and Slay the Spire were "Not ready"
// without a button: the game check wrote `fix: undefined` over the fix of the condition.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("a game row that is not ready keeps its condition's fix; a ready one offers the install again", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aas-fix-button-"));
  const games = path.join(root, "games"), folder = path.join(root, "game");
  fs.mkdirSync(path.join(games, "fixgame"), { recursive: true });
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "game.exe"), "");
  const flag = path.join(root, "ready");
  fs.writeFileSync(path.join(games, "fixgame", "install.mjs"), "");
  fs.writeFileSync(path.join(games, "fixgame", "plugin.mjs"), `import fs from "node:fs";
export default { id: "fixgame", name: "Fix Game", version: "0.0.0", ends: [{ id: "end", label: "End", final: true }], endpoints: [],
  documentation: "x", instructions: "x", capabilities: {}, category: {},
  setup: { folder: "FixGame", install: ${JSON.stringify(path.join(games, "fixgame", "install.mjs"))}, installs: "Put the mod next to the game",
    settings: [{ env: "AAS_FIXGAME_DIR", label: "the Fix Game folder", kind: "dir", expect: "game.exe", what: "The folder with game.exe in it, the game's own install folder" }] },
  async doctor() { return [{ ok: fs.existsSync(${JSON.stringify(flag)}), what: "the mod is installed", detail: "the mod is not there" }]; } };
`);
  const envDir = path.join(root, "env");
  fs.mkdirSync(envDir);
  fs.writeFileSync(path.join(envDir, "fixgame.env"), `AAS_FIXGAME_DIR=${folder}\n`);
  const saved = { AAS_GAMES_DIR: process.env.AAS_GAMES_DIR, AAS_GAME_ENV_DIR: process.env.AAS_GAME_ENV_DIR };
  process.env.AAS_GAMES_DIR = games;
  process.env.AAS_GAME_ENV_DIR = envDir;
  try {
    const { checkItem } = await import("../src/gui/checks.mjs");
    const notReady = await checkItem("game-fixgame");
    assert.equal(notReady.status, "warn");
    assert.deepEqual(notReady.fix && [notReady.fix.id, notReady.fix.label], ["install:fixgame", "Put the mod next to the game"], "the row's button is the fix of its unmet condition");
    fs.writeFileSync(flag, "");
    const ready = await checkItem("game-fixgame");
    assert.equal(ready.status, "ok");
    assert.equal(ready.fix?.label, "Put the mod next to the game (again)");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
