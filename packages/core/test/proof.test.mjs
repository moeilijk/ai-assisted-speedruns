// The proof of a run (SPEC §8.11) against an archive of its own: signing in, tickets, heads at the start, every hour
// and at the end, what happens when the archive cannot be reached, and what a bundle's proof says afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeSite } from "./fake-site.mjs";
import { accessToken, credentialsFile, loggedIn, login, logout, readCredentials } from "../src/auth.mjs";
import { checkProof, proofClient, publicProof, readState, readTicketIndex, segmentProof } from "../src/proof.mjs";
import { startSegmentProof } from "../src/proof-run.mjs";

async function setup(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "aas-proof-"));
  const site = await startFakeSite(dir);
  const saved = Object.fromEntries(["AAS_PROOF", "AAS_PROOF_URL", "AAS_PROOF_KEYS", "XDG_CONFIG_HOME", "AAS_PROOF_HOUR_MS"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { AAS_PROOF_URL: site.url, AAS_PROOF_KEYS: site.keysFile, XDG_CONFIG_HOME: join(dir, "config") });
  delete process.env.AAS_PROOF;
  t.after(async () => { await site.close(); for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const runDir = join(dir, "run");
  fs.mkdirSync(runDir);
  fs.writeFileSync(join(runDir, "run.jsonl"), "");
  const session = join(runDir, "session.jsonl");
  const runtime = { sessionLogs: () => (fs.existsSync(session) ? [session] : []) };
  const events = { list: [], append(event, data) { this.list.push({ event, data }); fs.appendFileSync(join(runDir, "run.jsonl"), `${JSON.stringify({ kind: "event", event, data })}\n`); } };
  return { dir, site, runDir, session, runtime, events };
}
// The browser, in a test: follow the archive's redirect to the loopback like a browser would.
const browser = (url) => { fetch(url).catch(() => {}); };

test("signing in is the authorization code with PKCE, and the refresh token rotates", async (t) => {
  const { site } = await setup(t);
  assert.equal(await loggedIn(), false);
  const c = await login({ open: browser, log: () => {} });
  assert.equal(c.archive, site.url);
  assert.equal((fs.statSync(credentialsFile()).mode & 0o777).toString(8), "600", "only this user can read the tokens");
  const authorize = site.requests.find((r) => r.path === "/auth/oauth/authorize");
  assert.ok(authorize, "the browser went to the archive's own page");
  assert.ok(!site.requests.some((r) => /password/i.test(r.body)), "no password passes through the tooling");
  // An access token about to expire is refreshed, and the new refresh token replaces the old one.
  const before = readCredentials();
  fs.writeFileSync(credentialsFile(), JSON.stringify({ ...before, expires_at: new Date(Date.now() - 1000).toISOString() }));
  const token = await accessToken();
  assert.notEqual(token, before.access_token);
  assert.notEqual(readCredentials().refresh_token, before.refresh_token);
  // An account's ticket belongs to the account.
  const ticket = await proofClient({ token: () => accessToken() }).ticket();
  assert.equal(ticket.account, true);
  assert.equal(await logout(), true);
  assert.equal(fs.existsSync(credentialsFile()), false);
  assert.ok(site.requests.some((r) => r.path === "/auth/oauth/revoke"));
});

test("a segment with proof: a ticket first, then heads at the start, every hour and at the end, chained", async (t) => {
  const { runDir, session, runtime, events, site } = await setup(t);
  process.env.AAS_PROOF_HOUR_MS = "40";
  const p = segmentProof({ runDir, segment: 1, mode: "anonymous", runtime, client: proofClient(), events });
  await p.begin();
  await p.start();
  fs.writeFileSync(session, '{"type":"user"}\n');
  await new Promise((r) => setTimeout(r, 130));
  await p.end();
  const state = readState(runDir);
  const kinds = state.heads.map((h) => h.kind);
  assert.equal(kinds[0], "start");
  assert.equal(kinds.at(-1), "end");
  assert.ok(kinds.filter((k) => k === "hour").length >= 2, kinds.join(","));
  assert.deepEqual(state.heads.map((h) => h.seq), kinds.map((_, i) => i + 1));
  assert.equal(state.receipts.length, state.heads.length);
  assert.ok(state.heads.at(-1).files.some((f) => f.label === "session:1" && f.length > 0), "the runtime's session log is covered once it exists");
  // Only a ticket and a hash went to the archive: no file content, no path of this machine.
  const heads = site.requests.filter((r) => r.path.endsWith("/heads"));
  for (const r of heads) assert.deepEqual(Object.keys(JSON.parse(r.body)).sort(), ["head", "kind", "segment", "seq"]);
  assert.equal(readTicketIndex().length, 1, "the ticket is listed on this machine, so it can be seen and managed");
  // The bundle's proof checks without the private part, and with it.
  const bundle = join(runDir, "..", "bundle");
  fs.mkdirSync(bundle);
  fs.writeFileSync(join(bundle, "proof.json"), JSON.stringify(publicProof(runDir, { session })));
  assert.equal(checkProof(bundle).status, "signed");
  const priv = join(runDir, "..", "private");
  fs.mkdirSync(priv);
  fs.copyFileSync(join(runDir, "run.jsonl"), join(priv, "run.jsonl"));
  fs.copyFileSync(session, join(priv, "session-1.jsonl"));
  assert.equal(checkProof(bundle, { privateDir: priv }).status, "signed");
  fs.writeFileSync(join(priv, "session-1.jsonl"), '{"type":"user","edited":true}\n');
  assert.equal(checkProof(bundle, { privateDir: priv }).status, "invalid");
});

test("no ticket, no start: a run that wants proof does not start without it", async (t) => {
  const { runDir, runtime, events, site } = await setup(t);
  process.env.AAS_PROOF = "anonymous";
  site.down = true;
  await assert.rejects(startSegmentProof({ runDir, segment: 1, runtime, events }), /no ticket from the archive .*Not starting/);
});

test("without an account or a yes, a run is unsigned and says so; --proof off overrides both", async (t) => {
  const { runDir, runtime, events, site } = await setup(t);
  const lines = [];
  const p = await startSegmentProof({ runDir, segment: 1, runtime, events, log: (l) => lines.push(l) });
  assert.equal(p.mode, "off");
  assert.match(lines.join("\n"), /unsigned: .*accepts it and marks it unsigned/);
  assert.equal(site.requests.length, 0, "nothing went over the line");
  process.env.AAS_PROOF = "anonymous";
  assert.equal((await startSegmentProof({ runDir, segment: 1, runtime, events, opts: { proof: "off" }, log: () => {} })).mode, "off");
});

test("a head the archive does not receive is logged, the run goes on, and a reviewer sees the gap", async (t) => {
  const { runDir, runtime, events, site } = await setup(t);
  const p = segmentProof({ runDir, segment: 1, mode: "anonymous", runtime, client: proofClient(), events, log: () => {} });
  await p.begin();
  await p.start();
  site.down = true;
  await p.end();
  assert.equal(readState(runDir).missed.length, 1);
  assert.ok(events.list.some((e) => e.event === "proof.missed"));
  const bundle = join(runDir, "..", "bundle");
  fs.mkdirSync(bundle);
  fs.writeFileSync(join(bundle, "proof.json"), JSON.stringify(publicProof(runDir)));
  const c = checkProof(bundle);
  assert.equal(c.status, "review");
  assert.match(c.detail, /never reached the archive/);
});
