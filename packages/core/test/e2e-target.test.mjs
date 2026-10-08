// End-to-end tests never reach the live Archive by accident: without AAS_PROOF_URL, or with the live address, they
// refuse, unless the maintainer said so for the run (AAS_E2E_LIVE=1). The Archive's bug 18, 2026-10-08.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requireTestArchive } from "../e2e/target.mjs";

test("an end-to-end test runs only against another archive, or against the live one on the maintainer's word", () => {
  assert.throws(() => requireTestArchive({}), /not the live one .*AAS_PROOF_URL=.*\(it is not set\)/);
  assert.throws(() => requireTestArchive({ AAS_PROOF_URL: "https://ai-assisted-speedruns.org/" }), /not the live one/);
  assert.equal(requireTestArchive({ AAS_PROOF_URL: "https://dev.example.org/" }), "https://dev.example.org");
  assert.equal(requireTestArchive({ AAS_PROOF_URL: "http://127.0.0.1:3001" }), "http://127.0.0.1:3001");
  assert.equal(requireTestArchive({ AAS_E2E_LIVE: "1" }), "https://ai-assisted-speedruns.org");
});
