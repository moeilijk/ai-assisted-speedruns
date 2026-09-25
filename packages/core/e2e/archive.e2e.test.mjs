// End to end against the live archive (ai-assisted-speedruns.org): a run recorded with proof on the archive's tickets,
// and the upload with the archive's check of that proof. `npm run e2e:archive`; not part of `npm test`, because it
// needs the network and an account the archive lets submit test uploads. That account is reached through a local
// module, .local/e2e-archive.mjs, which exports `archiveFetch` (a fetch that authenticates as that account); without
// it this test is skipped. The archive refuses every test upload after its checks, so nothing is kept or published.
//
// The run is the Portal chain against the fake SPT (no game, no model, no tokens): a scripted run is a mock and the
// archive refuses it as an entry (SPEC §3), but only after it checked the proof, and that check is what this asserts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeSpt } from "../../../games/portal/test/fake-spt.mjs";
import { configure } from "../src/configure.mjs";
import { packBundle, publish, writeManifest } from "../src/publish.mjs";
import { privateEntries, proofUrl, readState, useArchiveFetch } from "../src/proof.mjs";
import { resume } from "../src/resume.mjs";
import { run } from "../src/run.mjs";
import { uploadBundle } from "../src/upload.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const portalAgentDir = resolve(process.env.AAS_PORTAL_AGENT_DIR || join(root, ".local", "portal-agent"));
const available = fs.existsSync(join(portalAgentDir, "controller", "index.mjs"));
const hook = join(root, ".local", "e2e-archive.mjs");
const skip = !available ? "portal-agent not checked out" : !fs.existsSync(hook) ? "no .local/e2e-archive.mjs: no account the archive lets submit test uploads" : false;
const stub = join(root, "packages", "core", "test", "stub-runtime.mjs");
const game = join(root, "games", "portal", "plugin.mjs");
const at = () => new Date().toTimeString().slice(0, 8);
const log = (t) => process.stdout.write(`# ${at()} ${t}\n`);

/** One run with proof: segment 1 stops, a resume completes it as segment 2; then the bundle and its zip. */
async function provenRun(dir, name) {
  const runDir = join(dir, name);
  {
    await configure({ runtime: stub, game, "run-dir": runDir, model: "stub-model", goal: "credits" });
    fs.writeFileSync(join(runDir, "stub-codes.json"), JSON.stringify(["return await portal.observe()", "const t = portal.tas(); t.hold(67, { forward: true }); const r = await t.run(); return r.ticks"]));
    await run({ runtime: stub, game, "run-dir": runDir, recorder: "source-demo", "autosave-minutes": "0.01", "keep-open": true }, { log: () => {} });
    fs.writeFileSync(join(runDir, "stub-codes-resume.json"), JSON.stringify(["const t = portal.tas(); t.hold(33, { forward: true }); return (await t.run()).ticks"]));
    await resume({ "run-dir": runDir, recorder: "source-demo", "no-autosave": true, "keep-open": true }, { log: () => {} });
  }
  const outDir = join(dir, "public", name);
  const p = await publish(runDir, outDir, { completionMarker: "Reached the end credits", log: () => {} });
  return { runDir, outDir, zip: p.zip.file, state: readState(runDir), check: p.check };
}

let archiveFetch = null;
const ticketInfo = async (t) => {
  const res = await archiveFetch(`${proofUrl()}/api/v1/tickets/${t}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  assert.equal(res.status, 200, `GET ticket answered ${res.status}`);
  return res.json();
};

test("the live archive: a run with proof on its tickets, and the upload", { skip, timeout: 600000 }, async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "aas-e2e-"));
  // One fake SPT for every run: the Portal plugin reads its port once.
  const gameRoot = fs.mkdtempSync(join(tmpdir(), "aas-e2e-game-"));
  const spt = await startFakeSpt({ gameRoot, readyDelayMs: 300, transitionAfterTicks: 150 });
  Object.assign(process.env, { AAS_PORTAL_SPT_PORT: String(spt.port), AAS_PORTAL_AGENT_DIR: portalAgentDir, AAS_PORTAL_GAME_ROOT: gameRoot, AAS_TIME_ZONE: "Europe/Amsterdam" });
  const saved = Object.fromEntries(["AAS_PROOF", "XDG_CONFIG_HOME"].map((k) => [k, process.env[k]]));
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  try {
    ({ archiveFetch } = await import(pathToFileURL(hook).href));
    useArchiveFetch(archiveFetch);
    process.env.AAS_PROOF = "anonymous";

    // 1. A run with proof: every head signed; the upload's proof checks out; the ticket is marked submitted.
    const good = await provenRun(dir, "e2e-signed");
    assert.equal(good.state.tickets.length, 2);
    assert.ok(good.state.tickets.every((t) => t.account === true), "the tickets are the test account's");
    assert.equal(good.state.receipts.length, good.state.heads.length);
    assert.equal(good.check.results.find((r) => r.requirement === "proof").status, "met");
    const a1 = await uploadBundle(good.zip);
    log(`signed: tickets ${good.state.tickets.map((t) => t.ticket).join(", ")}; submission ${a1.submission}; status ${a1.status}; proof ${a1.proof}; ${(a1.reasons ?? []).join("; ")}`);
    assert.equal(a1.proof, "signed", JSON.stringify(a1));
    // Since 2026-09-25 the Archive takes an e2e upload in as a test (hidden, wiped within 24 h) instead of refusing it.
    assert.equal(a1.status, "review", "a test upload is taken in for review, as a test");
    assert.equal(a1.test, true);
    // The archive received every head it signed.
    for (const t of good.state.tickets) {
      const info = await ticketInfo(t.ticket);
      assert.equal(info.heads, good.state.heads.filter((h) => h.segment === t.segment).length);
      assert.equal(info.forks, 0);
    }

    // 2. The public timeline edited after it was made, manifest made again so the bundle is consistent: invalid.
    const edited = await provenRun(dir, "e2e-edited");
    const f = join(edited.outDir, "session.sanitized.jsonl");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"Reached the end credits"', '"Reached the end credits!"').replace(/("tool_call".*?)"ticks"/, '$1"tick"'));
    fs.appendFileSync(f, `${JSON.stringify({ sequence: 99999, timestamp: "2026-09-23T12:00:00+02:00", elapsed_seconds: 0, kind: "message", role: "assistant", text: "added afterwards" })}\n`);
    writeManifest(edited.outDir, { runId: "e2e-edited", runUid: JSON.parse(fs.readFileSync(join(edited.runDir, "brief.json"), "utf8")).run_uid });
    fs.rmSync(edited.zip);
    packBundle(edited.outDir, { privateFiles: privateEntries(edited.runDir) });
    const a2 = await uploadBundle(edited.zip);
    log(`edited: tickets ${edited.state.tickets.map((t) => t.ticket).join(", ")}; submission ${a2.submission}; proof ${a2.proof}; ${(a2.reasons ?? []).join("; ")}`);
    assert.equal(a2.proof, "invalid", JSON.stringify(a2));
    assert.ok((a2.reasons ?? []).some((r) => /not what the private logs make/.test(r)), JSON.stringify(a2.reasons));

    // 3. A fork: a second head for a seq the archive already signed, then the upload: for a reviewer.
    const forked = await provenRun(dir, "e2e-fork");
    const t = forked.state.tickets[0];
    const res = await archiveFetch(`${proofUrl()}/api/v1/tickets/${t.ticket}/heads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seq: 1, kind: "start", segment: 1, head: "f".repeat(64) }), signal: AbortSignal.timeout(15000) });
    assert.equal(res.status, 409, "the archive refuses a second head for a seq");
    const a3 = await uploadBundle(forked.zip);
    log(`fork: tickets ${forked.state.tickets.map((x) => x.ticket).join(", ")}; submission ${a3.submission}; proof ${a3.proof}; ${(a3.reasons ?? []).join("; ")}`);
    assert.equal(a3.proof, "review", JSON.stringify(a3));
    // What this test made at the archive, removed again: the e2e account's own wipe (tickets, submissions, files).
    const d = await archiveFetch(`${proofUrl()}/api/v1/e2e/`, { method: "DELETE", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    assert.equal(d.status, 200, `the wipe answered ${d.status}`);
    log(`the test's objects are wiped at the archive: ${JSON.stringify((await d.json()).removed)}`);
  } finally {
    useArchiveFetch(null);
    await spt.close?.();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
