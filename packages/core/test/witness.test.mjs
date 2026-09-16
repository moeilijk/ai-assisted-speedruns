// The archive as a witness: statements, receipts, and a run that goes on whatever the witness does.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStatement, parseWitnessKeys, toolingField, verifyReceipt, witnessKeyStatus, witnessSegment } from "../src/witness.mjs";
import { readKey } from "../src/sign.mjs";
import { startFakeWitness } from "./fake-witness.mjs";

const dir = mkdtempSync(join(tmpdir(), "aas-witness-"));
const keyFile = join(dir, "publisher.pem");
writeFileSync(keyFile, crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
const tooling = { version: "0.14.0", commit: "a".repeat(40), modified: false };
const start = { phase: "start", runUid: "0123456789abcdef0123456789abcdef", segment: 1, tooling, t0: "2026-09-16T20:00:00.000Z" };

test("the tooling field names version, commit and state, also outside a clone", () => {
  assert.equal(toolingField(tooling), `0.14.0 ${"a".repeat(40)} clean`);
  assert.equal(toolingField({ version: "0.14.0", commit: null, modified: null }), "0.14.0 - unknown");
});

test("a witnessed start carries the statement and a receipt by a trusted key", async () => {
  const w = await startFakeWitness(mkdtempSync(join(tmpdir(), "aas-witness-srv-")));
  try {
    const keys = parseWitnessKeys(readFileSync(w.keysFile, "utf8"));
    const r = await witnessSegment(start, { url: w.url, keyFile, keys });
    assert.equal(r.event, "run.witnessed");
    assert.equal(r.data.witness_key, w.fingerprint);
    assert.equal(verifyReceipt(r.data, keys).valid, true);
    assert.equal(verifyReceipt({ ...r.data, received_at: "2020-01-01T00:00:00.000Z" }, keys).valid, false, "the time is part of the receipt");
    assert.equal(verifyReceipt(r.data).valid, false, "the archive's own keys did not sign it");
    const again = await witnessSegment(start, { url: w.url, keyFile, keys });
    assert.deepEqual(again, { event: "run.unwitnessed", data: { phase: "start", segment: 1, reason: "the witness answered 409: already witnessed" } });
    const untrusted = await witnessSegment({ ...start, segment: 2 }, { url: w.url, keyFile });
    assert.equal(untrusted.event, "run.unwitnessed");
    assert.match(untrusted.data.reason, /not signed by a witness key of the archive/);
  } finally {
    await w.close();
  }
});

test("without a witness, a key or a network the run goes on unwitnessed", async () => {
  assert.match((await witnessSegment(start, { url: null, keyFile })).data.reason, /AAS_WITNESS_URL=off/);
  assert.match((await witnessSegment({ ...start, runUid: null }, { url: "http://127.0.0.1:9/", keyFile })).data.reason, /no run_uid/);
  assert.match((await witnessSegment(start, { url: "http://127.0.0.1:9/", keyFile: join(dir, "missing.pem") })).data.reason, /^no publisher key/);
  const down = await witnessSegment(start, { url: "http://127.0.0.1:9/witness/", keyFile });
  assert.equal(down.event, "run.unwitnessed");
  assert.match(down.data.reason, /could not be reached/);
  const slow = await witnessSegment(start, { url: "http://127.0.0.1:9/", keyFile, timeoutMs: 50, fetchImpl: (u, o) => new Promise((_, no) => {
    const late = setTimeout(() => no(new Error("the timeout did not fire")), 2000); // keeps the event loop alive
    o.signal.addEventListener("abort", () => { clearTimeout(late); no(o.signal.reason); });
  }) });
  assert.match(slow.data.reason, /no answer in 0\.05 s/);
});

test("a statement is signed text in a fixed order", () => {
  const text = makeStatement({ ...start, at: "2026-09-16T20:00:01.000Z" }, keyFile);
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, 7), ["aas-witness v1", "phase: start", `run_uid: ${start.runUid}`, "segment: 1", `tooling: 0.14.0 ${"a".repeat(40)} clean`, "at: 2026-09-16T20:00:01.000Z", "t0: 2026-09-16T20:00:00.000Z"]);
  assert.match(lines[7], /^key: ssh-ed25519 /);
  assert.match(lines[8], /^signature: /);
  assert.equal(lines.length, 9);
  const end = makeStatement({ ...start, phase: "end", endedAt: "2026-09-16T20:05:00.000Z", seconds: 300.5 }, keyFile).split("\n");
  assert.deepEqual(end.slice(6, 8), ["ended_at: 2026-09-16T20:05:00.000Z", "seconds: 300.5"]);
});

test("doctor says whether the witness knows the publisher key", async () => {
  const w = await startFakeWitness(mkdtempSync(join(tmpdir(), "aas-witness-doc-")), { registered: [readKey(keyFile).fingerprint] });
  try {
    assert.deepEqual(await witnessKeyStatus({ url: w.url, keyFile }), { ok: true, detail: `${readKey(keyFile).fingerprint} is registered with an account` });
    const other = join(dir, "other.pem");
    writeFileSync(other, crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    const unknown = await witnessKeyStatus({ url: w.url, keyFile: other });
    assert.equal(unknown.ok, false);
    assert.match(unknown.detail, /not registered with an account: record its public line/);
  } finally {
    await w.close();
  }
  assert.equal((await witnessKeyStatus({ url: null, keyFile })).ok, false);
});
