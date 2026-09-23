// End to end against the live archive (ai-assisted-speedruns.org), while it is in test: an account of its own, signed
// in through the archive's own pages the way a person does in the browser, a run recorded with proof on that
// account's tickets, and the upload. `npm run e2e:archive`; not part of `npm test`, because it needs the network and
// leaves an account and refused submissions behind (the archive wipes its test data at launch).
//
// The run is the Portal chain against the fake SPT (no game, no model, no tokens): a scripted run is a mock and the
// archive refuses it as an entry (SPEC §3), but only after it checked the proof, and that check is what this asserts.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeSpt } from "../../../games/portal/test/fake-spt.mjs";
import { login, accessToken } from "../src/auth.mjs";
import { configure } from "../src/configure.mjs";
import { packBundle, publish, writeManifest } from "../src/publish.mjs";
import { privateEntries, proofUrl, readState } from "../src/proof.mjs";
import { resume } from "../src/resume.mjs";
import { run } from "../src/run.mjs";
import { uploadBundle } from "../src/upload.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const portalAgentDir = resolve(process.env.AAS_PORTAL_AGENT_DIR || join(root, ".local", "portal-agent"));
const available = fs.existsSync(join(portalAgentDir, "controller", "index.mjs"));
const stub = join(root, "packages", "core", "test", "stub-runtime.mjs");
const game = join(root, "games", "portal", "plugin.mjs");
const at = () => new Date().toTimeString().slice(0, 8);
const log = (t) => process.stdout.write(`# ${at()} ${t}\n`);

/** A browser with cookies: what a person's browser does on the archive's pages. */
function browser(base) {
  const jar = new Map();
  const req = async (url, { method = "GET", form = null } = {}) => {
    const res = await fetch(url.startsWith("http") ? url : base + url, { method, redirect: "manual", headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(20000) });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return { status: res.status, location: res.headers.get("location"), text: await res.text() };
  };
  const csrf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];
  return {
    async register(email, password) {
      const page = await req("/signin/");
      const r = await req("/register/", { method: "POST", form: { csrf: csrf(page.text), next: "/", new_email: email, display_name: "", new_password: password, new_password_confirm: password } });
      assert.equal(r.status, 303, `register answered ${r.status}`);
      assert.ok(jar.has("aas_session"), "signed in after registering");
    },
    async signin(email, password) {
      const page = await req("/signin/");
      const r = await req("/signin/", { method: "POST", form: { csrf: csrf(page.text), next: "/", email, password } });
      assert.equal(r.status, 303, `sign-in answered ${r.status}`);
    },
    /** `open` for aas login: the authorize page, Allow, and the page that sends the code back to the tooling. */
    async open(url) {
      let r = await req(url);
      if (r.status >= 300 && r.status < 400) r = await req(new URL(r.location, url).toString());
      const form = r.text.match(/<form[^>]*action="\/auth\/oauth\/authorize\/"[\s\S]*?<\/form>/)?.[0];
      assert.ok(form, "the archive asks whether to allow the tooling");
      const fields = Object.fromEntries([...form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&")]));
      const hop = await req("/auth/oauth/authorize/", { method: "POST", form: { ...fields, answer: "allow" } });
      const back = hop.text.match(/url=(http:\/\/127\.0\.0\.1:\d+\/callback\?[^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
      assert.ok(back, "the archive sends the code back to the tooling");
      await fetch(back);
    },
  };
}

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

const ticketInfo = async (t) => {
  const res = await fetch(`${proofUrl()}/api/v1/tickets/${t}`, { headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  assert.equal(res.status, 200, `GET ticket answered ${res.status}`);
  return res.json();
};

test("the live archive: an account, a run with proof on its tickets, and the upload", { skip: !available && "portal-agent not checked out", timeout: 600000 }, async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "aas-e2e-"));
  // One fake SPT for every run: the Portal plugin reads its port once.
  const gameRoot = fs.mkdtempSync(join(tmpdir(), "aas-e2e-game-"));
  const spt = await startFakeSpt({ gameRoot, readyDelayMs: 300, transitionAfterTicks: 150 });
  Object.assign(process.env, { AAS_PORTAL_SPT_PORT: String(spt.port), AAS_PORTAL_AGENT_DIR: portalAgentDir, AAS_PORTAL_GAME_ROOT: gameRoot, AAS_TIME_ZONE: "Europe/Amsterdam" });
  const saved = Object.fromEntries(["AAS_PROOF", "XDG_CONFIG_HOME"].map((k) => [k, process.env[k]]));
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  delete process.env.AAS_PROOF;
  try {
    const b = browser(proofUrl());
    // One account for every e2e run, kept in a gitignored file: the archive lets an address sign up five times an
    // hour, and every account is one more to wipe at launch.
    const accountFile = join(root, ".local", "e2e-account.json");
    let account = null;
    try { account = JSON.parse(fs.readFileSync(accountFile, "utf8")); } catch { /* the first run makes it */ }
    if (account) await b.signin(account.email, account.password);
    else {
      account = { email: `e2e+${Date.now()}@example.org`, password: `e2e-${crypto.randomUUID()}`, archive: proofUrl(), created_at: new Date().toISOString() };
      await b.register(account.email, account.password);
      fs.mkdirSync(dirname(accountFile), { recursive: true });
      fs.writeFileSync(accountFile, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
    }
    log(`account ${account.email}`);
    await login({ open: (url) => b.open(url), log: () => {} });
    assert.ok(await accessToken(), "signed in: the tooling has an access token");
    log("signed in through the archive's own pages (authorization code with PKCE)");

    // 1. A run with proof: every head signed; the upload's proof checks out; the ticket is marked submitted.
    const good = await provenRun(dir, "e2e-signed");
    assert.equal(good.state.tickets.length, 2);
    assert.ok(good.state.tickets.every((t) => t.account === true), "tickets on the account");
    assert.equal(good.state.receipts.length, good.state.heads.length);
    assert.equal(good.check.results.find((r) => r.requirement === "proof").status, "met");
    const a1 = await uploadBundle(good.zip);
    log(`signed: tickets ${good.state.tickets.map((t) => t.ticket).join(", ")}; submission ${a1.submission}; status ${a1.status}; proof ${a1.proof}; ${(a1.reasons ?? []).join("; ")}`);
    assert.equal(a1.proof, "signed", JSON.stringify(a1));
    assert.equal(a1.status, "rejected", "a scripted run is a mock and never an entry");
    const t1 = await ticketInfo(good.state.tickets[0].ticket);
    assert.ok(t1.submitted_at, "the ticket is marked submitted");

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
    const res = await fetch(`${proofUrl()}/api/v1/tickets/${t.ticket}/heads`, { method: "POST", headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ seq: 1, kind: "start", segment: 1, head: "f".repeat(64) }), signal: AbortSignal.timeout(15000) });
    assert.equal(res.status, 409, "the archive refuses a second head for a seq");
    const a3 = await uploadBundle(forked.zip);
    log(`fork: tickets ${forked.state.tickets.map((x) => x.ticket).join(", ")}; submission ${a3.submission}; proof ${a3.proof}; ${(a3.reasons ?? []).join("; ")}`);
    assert.equal(a3.proof, "review", JSON.stringify(a3));
  } finally {
    await spt.close?.();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
