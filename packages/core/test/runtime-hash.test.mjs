// A bundle names the runtime that played the run by its hash, and an archive goes on that hash. Publishing a run again
// with a later tooling named the later code: balatro-codex-01, played on runtime-codex 0.35.0 (043099be…), was
// republished with 1.0.6 naming 1.0.5's 846c7a16… beside version 0.35.0 (2026-10-16).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PACKAGES, pluginDigest, pluginDigestAt, runtimeIdentity } from "../src/plugins.mjs";
import { runtimeHashAsRan } from "../src/publish.mjs";

const repo = path.dirname(PACKAGES);
const head = (() => { try { return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } })();

test("the digest of a runtime read from git at a commit is the digest of the same files on disk", { skip: !head && "no git history" }, () => {
  for (const id of ["claude-code", "codex", "mistral-vibe", "scripted"]) {
    const file = path.join(PACKAGES, `runtime-${id}`, "index.mjs");
    // HEAD's tree and the disk agree for a runtime this checkout has not changed since its last commit.
    const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain", "--", path.dirname(file)], { encoding: "utf8" }).trim();
    if (dirty) continue;
    assert.equal(pluginDigestAt(file, "HEAD"), pluginDigest(file), id);
  }
  assert.equal(pluginDigestAt(path.join(PACKAGES, "runtime-codex", "index.mjs"), "no-such-commit"), null, "a commit git does not know gives no hash");
});

function runDir(starts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-runtime-hash-"));
  fs.writeFileSync(path.join(dir, "run.jsonl"), starts.map((data) => JSON.stringify({ kind: "event", event: "run.started", source: "harness", timestamp: "2026-10-16T02:05:33.000+02:00", data })).join("\n") + "\n");
  return dir;
}
const brief = { runtime: "codex" };
const rt = { id: "codex", version: "x", ai: true };

test("the hash a segment recorded at its start is the one published", () => {
  const logs = [];
  assert.equal(runtimeHashAsRan(runDir([{ runtime: "codex", runtime_sha256: "a".repeat(64) }]), brief, rt, (m) => logs.push(m)), "a".repeat(64));
  assert.deepEqual(logs, []);
});

test("segments that ran on two builds publish the first, and the log says so", () => {
  const logs = [];
  const got = runtimeHashAsRan(runDir([{ runtime_sha256: "a".repeat(64) }, { runtime_sha256: "b".repeat(64) }]), brief, rt, (m) => logs.push(m));
  assert.equal(got, "a".repeat(64));
  assert.match(logs.join(" "), /2 builds of the runtime/);
});

test("a run from before the record has it from the tooling commit its start recorded, when that tree was clean", { skip: !head && "no git history" }, () => {
  const file = path.join(PACKAGES, "runtime-codex", "index.mjs");
  assert.equal(runtimeHashAsRan(runDir([{ runtime: "codex", tooling: { version: "1.0.4", commit: head, modified: false } }]), brief, rt), pluginDigestAt(file, head));
});

test("with neither, it is the runtime on disk now, and the log says that it is", () => {
  const logs = [];
  const got = runtimeHashAsRan(runDir([{ runtime: "codex", tooling: { version: "1.0.4", commit: "deadbeef", modified: true } }]), brief, rt, (m) => logs.push(m));
  assert.equal(got, runtimeIdentity(rt, "codex").sha256);
  assert.match(logs.join(" "), /names the runtime on disk now/);
});
