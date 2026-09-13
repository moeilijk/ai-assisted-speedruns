// Signing a bundle: the signature covers manifest.json and therefore the whole bundle; the key is read in the
// form a code-hosting account publishes; tampering is caught; an unsigned bundle is readable but not an entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKey, signBundle, verifyBundle } from "../src/sign.mjs";
import { checkRun } from "../src/check-run.mjs";
import { writeManifest } from "../src/publish.mjs";

const hasSshKeygen = (() => { try { execFileSync("ssh-keygen", ["-A", "-h"], { stdio: "ignore" }); return true; } catch { return true; } })();

function bundleWithKey() {
  const dir = mkdtempSync(join(tmpdir(), "aas-sign-"));
  const out = join(dir, "run-01");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "summary.json"), '{"run_id":"run-01"}\n');
  writeFileSync(join(out, "session.sanitized.jsonl"), "{}\n");
  writeManifest(out, { runId: "run-01" });
  const key = join(dir, "id_ed25519");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "test", "-f", key, "-q"]);
  return { dir, out, key };
}

test("the public key and fingerprint are the ones ssh-keygen prints", { skip: !hasSshKeygen && "ssh-keygen not installed" }, () => {
  const { out, key } = bundleWithKey();
  const read = readKey(key);
  const [type, body] = readFileSync(`${key}.pub`, "utf8").split(/\s+/);
  assert.equal(read.publicLine, `${type} ${body}`);
  assert.equal(read.fingerprint, execFileSync("ssh-keygen", ["-lf", `${key}.pub`], { encoding: "utf8" }).split(/\s+/)[1]);
  const sig = signBundle(out, key);
  assert.equal(sig.algorithm, "ed25519");
  assert.equal(sig.public_key, read.publicLine);
  assert.deepEqual(verifyBundle(out), { signed: true, valid: true, fingerprint: read.fingerprint, problem: null });
});

test("a changed file breaks the signature, because the manifest hashes it", { skip: !hasSshKeygen && "ssh-keygen not installed" }, () => {
  const { out, key } = bundleWithKey();
  signBundle(out, key);
  writeFileSync(join(out, "summary.json"), '{"run_id":"someone else"}\n');
  writeManifest(out, { runId: "run-01" }); // the manifest follows the file, so the signature no longer matches it
  const v = verifyBundle(out);
  assert.equal(v.valid, false);
  assert.match(v.problem, /manifest_sha256 does not match|does not verify/);
});

test("a signature from another key is refused, and an unsigned bundle is simply unsigned", { skip: !hasSshKeygen && "ssh-keygen not installed" }, () => {
  const a = bundleWithKey();
  const b = bundleWithKey();
  signBundle(a.out, a.key);
  const sig = JSON.parse(readFileSync(join(a.out, "signature.json"), "utf8"));
  sig.public_key = readKey(b.key).publicLine; // someone else's key, the signature left as it was
  writeFileSync(join(a.out, "signature.json"), JSON.stringify(sig));
  const v = verifyBundle(a.out);
  assert.equal(v.valid, false);
  assert.deepEqual(verifyBundle(b.out), { signed: false, valid: false, fingerprint: null, problem: null });
});

test("an unsigned bundle is readable but not an entry: aas check reports the signature as unmet", { skip: !hasSshKeygen && "ssh-keygen not installed" }, () => {
  const { out, key } = bundleWithKey();
  const row = (dir) => checkRun(dir).results.find((r) => r.requirement === "signature");
  assert.equal(row(out).status, "unmet");
  signBundle(out, key);
  const signed = row(out);
  assert.equal(signed.status, "met");
  assert.match(signed.detail, /^valid for SHA256:/);
});
