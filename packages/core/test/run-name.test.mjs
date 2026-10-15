// A run's name is its address on the Archive, so it is unique among all of a publisher's runs, not only among one
// game's. On 2026-10-15 three games each had an "opus-01": one address for three runs on the Archive, and two
// recordings filed under the wrong run because all six files began AAS_opus-01_.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runNameOf, runNameTakenElsewhere } from "../src/run-name.mjs";

const output = () => fs.mkdtempSync(path.join(os.tmpdir(), "aas-names-"));
const run = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "brief.json"), "{}\n"); };
const bundle = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "manifest.json"), "{}\n"); };

test("a proposed name carries the game, so two games never propose the same one", () => {
  assert.equal(runNameOf("balatro", "codex", 1), "balatro-codex-01");
  assert.equal(runNameOf("slay_the_spire", "opus", 12), "slay-the-spire-opus-12");
  assert.notEqual(runNameOf("portal", "codex", 1), runNameOf("balatro", "codex", 1));
});

test("a name another game's run or bundle already has is found; this game's own runs and other folders are not", () => {
  const out = output();
  run(path.join(out, "Portal", "opus-01"));
  bundle(path.join(out, "SlayTheSpire", "public", "sts-01"));
  fs.mkdirSync(path.join(out, "Notes", "codex-01"), { recursive: true }); // a folder that only shares the name
  run(path.join(out, "Balatro", "balatro-01"));

  assert.equal(runNameTakenElsewhere(path.join(out, "Balatro"), "opus-01", out), path.join(out, "Portal", "opus-01"));
  assert.equal(runNameTakenElsewhere(path.join(out, "Balatro"), "sts-01", out), path.join(out, "SlayTheSpire", "public", "sts-01"));
  assert.equal(runNameTakenElsewhere(path.join(out, "Balatro"), "codex-01", out), null, "not a run, so not taken");
  assert.equal(runNameTakenElsewhere(path.join(out, "Balatro"), "balatro-01", out), null, "this game's own run is not another game's");
  assert.equal(runNameTakenElsewhere(path.join(out, "Portal"), "opus-01", out), null, "a run is not taken by itself");
  assert.equal(runNameTakenElsewhere(path.join(out, "Nowhere", "deeper"), "x", out), null, "a folder that is not there finds nothing");
  assert.equal(runNameTakenElsewhere(path.join(out, "Balatro"), "opus-01", path.join(out, "Balatro")), null, "outside the output location nothing is taken");
});

test("aas configure refuses a new run whose name another game's run has, and says which one", async () => {
  const { configure } = await import("../src/configure.mjs");
  const out = output();
  run(path.join(out, "Portal", "opus-01"));
  const here = path.dirname(new URL(import.meta.url).pathname);
  const instructions = path.join(out, "AGENTS.md");
  const before = process.env.AAS_OUTPUT_DIR;
  process.env.AAS_OUTPUT_DIR = out;
  fs.writeFileSync(instructions, "Play the fake game.\n");
  await assert.rejects(
    configure({ runtime: path.join(here, "stub-runtime.mjs"), game: path.join(here, "fake-game.mjs"), "run-dir": path.join(out, "Balatro", "opus-01"), instructions }),
    (e) => /already used by another game's run/.test(e.message) && e.message.includes(path.join(out, "Portal", "opus-01")),
  );
  assert.equal(fs.existsSync(path.join(out, "Balatro", "opus-01")), false, "nothing was made for the refused run");
  if (before === undefined) delete process.env.AAS_OUTPUT_DIR; else process.env.AAS_OUTPUT_DIR = before;
});
