// save-track decodes the game's obfuscated autosave and plain run history, keeps the
// profile name out, and lines the saves up with the harness's own IGT and splits.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeSave, saveSummary, saveFiles, historyFiles, harnessTrack } from "../save-track.mjs";

const encode = (obj) => { const key = Buffer.from("key"); const plain = Buffer.from(JSON.stringify(obj)); return Buffer.from(plain.map((b, i) => b ^ key[i % 3])).toString("base64"); };

test("autosave and run history decode; the profile name is not in the summary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-sts-"));
  fs.mkdirSync(path.join(dir, "saves")); fs.mkdirSync(path.join(dir, "history"));
  fs.writeFileSync(path.join(dir, "saves", "aas_x_001.autosave"), encode({ name: "someone", seed: 42, floor_num: 3, act_num: 1, play_time: 37, metric_path_per_floor: ["M", "M"], current_health: 67, max_health: 80, save_date: 1789081725440, level_name: "Exordium", boss: "Slime Boss" }));
  fs.writeFileSync(path.join(dir, "history", "1789081725.run"), JSON.stringify({ name: "someone", seed_played: "42", floor_reached: 5, playtime: 120, path_per_floor: ["M", "M", "?", "M", "BOSS"], victory: false, killed_by: "Slime Boss", timestamp: 1789081800 }));
  fs.writeFileSync(path.join(dir, "run.jsonl"), [
    { timestamp: "2026-09-11T01:08:07.000+02:00", kind: "event", event: "game.playback", data: { phase: "end", index: 1, seconds: 0.5, floor: 1, act: 1 } },
    { timestamp: "2026-09-11T01:08:09.000+02:00", kind: "event", event: "game.playback", data: { phase: "end", index: 2, seconds: 1.5, floor: 3, act: 1 } },
    { timestamp: "2026-09-11T01:08:10.000+02:00", kind: "event", event: "game.saved", data: { name: "aas_x_001", index: 1, reason: "milestone", file: "saves/aas_x_001.autosave" } },
    { timestamp: "2026-09-11T01:08:11.000+02:00", kind: "event", event: "game.milestone", data: { label: "Act 1 boss", split: "Act 1 boss", floor: 17, chapter: true } },
  ].map((e) => JSON.stringify(e)).join("\n"));
  const s = saveSummary(decodeSave(saveFiles(dir)[0]));
  assert.equal(s.floor, 3); assert.equal(s.playTime, 37); assert.deepEqual(s.pathPerFloor, ["M", "M"]); assert.equal(s.seed, 42);
  assert.ok(!JSON.stringify(s).includes("someone"), "profile name must not appear");
  const h = saveSummary(decodeSave(historyFiles(dir)[0]));
  assert.equal(h.floorReached, 5); assert.equal(h.victory, false); assert.equal(h.killedBy, "Slime Boss"); assert.equal(h.playTime, 120);
  const track = harnessTrack(dir);
  assert.equal(track.igt, 2);
  assert.deepEqual(track.saves.map((x) => [x.name, x.igt, x.floor]), [["aas_x_001", 2, 3]]);
  assert.deepEqual(track.splits.map((x) => x.split), ["Act 1 boss"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
