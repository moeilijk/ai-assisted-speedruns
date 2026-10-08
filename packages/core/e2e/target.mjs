// The archive an end-to-end test talks to. Since the freeze (2026-09-27) the end-to-end tests run against another
// archive (the Archive's dev instance), and the live Archive changes only on the maintainer's word. Without
// AAS_PROOF_URL the tooling talks to the live Archive (proof.mjs), and an e2e:real started that way on 2026-10-08
// uploaded two mock bundles there as the e2e account (wiped by the test at its end; the Archive's bug 18). So every
// e2e test file starts with this: it refuses to run unless AAS_PROOF_URL names another archive, or the maintainer
// said so for this run (AAS_E2E_LIVE=1 on the command line).
import { ARCHIVE_URL } from "../src/versions.mjs";

export function requireTestArchive(env = process.env) {
  const target = (env.AAS_PROOF_URL ?? "").trim().replace(/\/+$/, "");
  const live = new URL(ARCHIVE_URL).host;
  const isLive = !target || (() => { try { return new URL(target).host === live; } catch { return false; } })();
  if (isLive && env.AAS_E2E_LIVE !== "1") {
    throw new Error(`end-to-end tests run against another archive, not the live one (${ARCHIVE_URL}): put AAS_PROOF_URL=<that archive> and AAS_PROOF_KEYS=<its proof keys> on the command line${target ? "" : " (it is not set)"}; the live Archive only on the maintainer's word, with AAS_E2E_LIVE=1`);
  }
  return target || ARCHIVE_URL;
}
