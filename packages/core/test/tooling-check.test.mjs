import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, resumeToolingCheck } from "../src/tooling-check.mjs";

test("versions compare by number, not by text", () => {
  assert.ok(compareVersions("0.10.0", "0.9.1") > 0);
  assert.equal(compareVersions("0.12.0", "0.12"), 0);
  assert.ok(compareVersions("0.12.0", "1.0.0") < 0);
});

test("a run goes on with newer tooling in its line, never with older, and past a breaking release only when allowed", () => {
  assert.equal(resumeToolingCheck({ earlier: ["0.13.0"], installed: "0.13.2", breaking: [] }).ok, true);
  const older = resumeToolingCheck({ earlier: ["0.13.0", "0.14.0"], installed: "0.13.5", breaking: [] });
  assert.equal(older.ok, false);
  assert.match(older.problem, /ran tooling 0\.14\.0, and the installed tooling 0\.13\.5 is older/);
  const crossed = resumeToolingCheck({ earlier: ["0.13.0"], installed: "0.16.0", breaking: ["0.15.0", "0.17.0"] });
  assert.equal(crossed.ok, false);
  assert.deepEqual(crossed.breaking, ["0.15.0"]);
  assert.match(crossed.problem, /--allow-breaking/);
  assert.deepEqual(resumeToolingCheck({ earlier: ["0.13.0"], installed: "0.16.0", breaking: ["0.15.0"], allowBreaking: true }), { ok: true, breaking: ["0.15.0"], problem: null });
  // A session from before 0.13.0 names no version: every breaking release up to the installed one lies after it.
  assert.equal(resumeToolingCheck({ earlier: [null], installed: "0.16.0", breaking: ["0.15.0"] }).ok, false);
  assert.equal(resumeToolingCheck({ earlier: [null], installed: "0.13.0", breaking: [] }).ok, true);
});
