// The shared fixtures (packages/spec/fixtures): made fresh from a real mock run, and `aas check` must say for each
// class what verdicts.json says the tooling says. The Archive asserts its own column of the same table.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const make = path.join(here, "..", "fixtures", "make-fixtures.mjs");

test("every fixture class gets the verdict the table gives it from `aas check`", { timeout: 180000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "aas-fixtures-test-"));
  await new Promise((resolve, reject) => execFile(process.execPath, [make, "--out", out], { env: process.env }, (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve())));
  const { checkBundle } = await import("../../core/src/check-run.mjs");
  const table = JSON.parse(fs.readFileSync(path.join(out, "verdicts.json"), "utf8"));
  assert.ok(table.classes.length >= 16);
  for (const c of table.classes) {
    const zip = path.join(out, c.fixture);
    if (c.tooling.throws) {
      assert.throws(() => checkBundle(zip), new RegExp(c.tooling.throws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), c.class);
      continue;
    }
    const r = checkBundle(zip).results.find((x) => x.requirement === c.tooling.requirement);
    assert.ok(r, `${c.class}: a "${c.tooling.requirement}" result`);
    assert.equal(r.status, c.tooling.status, `${c.class}: ${r.detail}`);
    assert.ok(String(r.detail).includes(c.tooling.match), `${c.class}: ${r.detail}`);
  }
  // The committed table is the one the generator writes (the Archive imports it).
  const committed = JSON.parse(fs.readFileSync(path.join(here, "..", "fixtures", "verdicts.json"), "utf8"));
  assert.deepEqual(committed, table, "packages/spec/fixtures/verdicts.json is out of date: node packages/spec/fixtures/make-fixtures.mjs");
});
