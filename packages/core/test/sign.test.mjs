// Signing a bundle: the signature covers manifest.json and therefore the whole bundle; the key is read in the
// form a code-hosting account publishes; tampering is caught; an unsigned bundle is readable but not an entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKey, readKey, signBundle, verifyBundle } from "../src/sign.mjs";
import { checkRun } from "../src/check-run.mjs";
import { AAS_KEY_FILE, resolveSignKey } from "../src/publish.mjs";
import { generateKeyPairSync } from "node:crypto";
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

test("--sign without a path finds the publisher's own key, and says so when there is none", () => {
  const home = mkdtempSync(join(tmpdir(), "aas-home-"));
  const env = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AAS_SIGN_KEY: process.env.AAS_SIGN_KEY };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  delete process.env.AAS_SIGN_KEY;
  try {
    // Nothing yet: a publisher without an SSH key and without an account is the normal case, so say what to run.
    assert.throws(() => resolveSignKey(true), /aas key/);
    // An SSH key they happen to have is used rather than asking them to make a second one.
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_ed25519"), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    assert.equal(resolveSignKey(true), join(home, ".ssh", "id_ed25519"));
    // The key this tooling makes wins: it is the one the publisher registered with an archive.
    const made = createKey(AAS_KEY_FILE());
    assert.equal(made.created, true);
    assert.equal(resolveSignKey(true), AAS_KEY_FILE());
    assert.match(made.publicLine, /^ssh-ed25519 /);
    assert.match(made.fingerprint, /^SHA256:/);
    assert.equal(createKey(AAS_KEY_FILE()).created, false, "never overwritten: a new key would be a new publisher");
    assert.equal(createKey(AAS_KEY_FILE()).publicLine, made.publicLine);
    // The key it writes is one the signer can actually use.
    const { out } = bundleWithKey();
    signBundle(out, resolveSignKey(true));
    assert.equal(verifyBundle(out).valid, true);
    assert.equal(resolveSignKey("/elsewhere/key"), "/elsewhere/key", "a path still wins");
  } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
