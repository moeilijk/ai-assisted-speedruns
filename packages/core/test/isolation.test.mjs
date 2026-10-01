// The tests never touch the machine's own sign-in or a real archive (2026-10-01: tests without their own config
// directory ran with the maintainer's credentials and asked the live Archive for 287 tickets under that account).
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { credentialsFile } from "../src/auth.mjs";
import { proofMode, proofUrl, ticketIndexFile } from "../src/proof.mjs";
import { ARCHIVE_URL } from "../src/versions.mjs";

test("every test runs with its own config directory and settings, without proof, against no real archive or open GUI", async () => {
  const own = path.join(os.homedir(), ".config");
  for (const f of [credentialsFile(), ticketIndexFile()]) {
    assert.ok(!f.startsWith(`${own}${path.sep}`), `${f} is the machine's own: run the tests with npm test, which loads test/isolate.mjs`);
    assert.ok(f.startsWith(os.tmpdir()), `${f} is not a test's own directory`);
  }
  const repoLocal = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
  for (const k of ["AAS_ENV_FILE", "AAS_GAME_ENV_DIR", "AAS_GUI_NOTE", "AAS_GUI_CHECKS"]) {
    assert.ok(process.env[k]?.startsWith(os.tmpdir()), `${k} must point into the test's own directory, not at ${process.env[k] ?? path.join(repoLocal, ".local")}`);
  }
  assert.notEqual(proofUrl(), ARCHIVE_URL.replace(/\/+$/, ""), "a test must never reach the live Archive");
  assert.match(proofUrl(), /\.invalid$/, "an address that cannot exist, unless a test sets its own");
  assert.equal(await proofMode({ loggedIn: async () => true }), "off", "no proof unless a test asks for it");
});
