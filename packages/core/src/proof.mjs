// Proof that a run's logs were not changed after they were written (SPEC §8.11).
//
// The harness chains what a run produces: at the start of every segment, every hour and at its end it takes the
// run log and the runtime's own session log as they stand, hashes them into a head that also covers the head
// before it, and sends that head to the archive with the segment's ticket. The archive signs each head with its own
// clock and keeps it. At submission the private part of the upload carries the logs themselves, the archive
// recomputes every head from them and regenerates the public timeline, so a log that was edited after a head was
// signed no longer matches what the archive received. Only the ticket and a hash go over the line.
//
// Who asked for it: a person who logged in (`aas login`), or who answered yes to recording proof anonymously
// (AAS_PROOF=anonymous). Anything else is an unsigned run: it is published and marked unsigned.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE_URL } from "./versions.mjs";
import { publicInfo, publicKeyFromLine } from "./sign.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** The archive's API. AAS_PROOF_URL points the tooling at another archive (the tests use a local one). */
export const proofUrl = () => (process.env.AAS_PROOF_URL || ARCHIVE_URL).replace(/\/+$/, "");
/**
 * Proof keys from the archive's own format (/.well-known/aas-proof.txt): its `key: ssh-ed25519 …` lines; other lines,
 * such as `fingerprint:`, say what the key is. A bare `ssh-ed25519 …` line is read too.
 */
export function parseProofKeys(text) {
  return String(text).split("\n").map((l) => l.trim()).filter((l) => /^(key: )?ssh-ed25519 /.test(l)).map((l) => l.replace(/^key: /, ""))
    .map((line) => { try { const key = publicKeyFromLine(line); return { key, fingerprint: publicInfo(key).fingerprint }; } catch { return null; } })
    .filter(Boolean);
}
/** The keys a check uses: the ones given (an archive passes its own), else those pinned in this repository. */
const keysOf = (given) => (given === undefined || given === null ? trustedProofKeys() : typeof given === "string" ? parseProofKeys(given) : Array.isArray(given) && typeof given[0] === "string" ? parseProofKeys(given.join("\n")) : given);
/** The archive's proof keys, pinned in this repository; AAS_PROOF_KEYS names a file with others (the tests). */
export const SITE_KEYS_FILE = path.resolve(here, "../../spec/site-keys.txt");
export function trustedProofKeys() {
  return [SITE_KEYS_FILE, process.env.AAS_PROOF_KEYS].filter((f) => f && fs.existsSync(f)).flatMap((f) => parseProofKeys(fs.readFileSync(f, "utf8")));
}

/** Where the harness keeps a run's tickets and receipts. Never published: it holds each ticket's control secret. */
export const stateFile = (runDir) => path.join(runDir, "proof", "state.json");
export const readState = (runDir) => { try { return JSON.parse(fs.readFileSync(stateFile(runDir), "utf8")); } catch { return null; } };
const writeState = (runDir, state) => { fs.mkdirSync(path.dirname(stateFile(runDir)), { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile(runDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); };

/** The lines a ticket's signature covers. */
export const ticketMessage = (t) => `aas-ticket v1\nticket: ${t.ticket}\nissued: ${t.issued_at}`;
/** The lines a head receipt's signature covers. */
export const receiptMessage = (r) => `aas-head v1\nticket: ${r.ticket}\nseq: ${r.seq}\nkind: ${r.kind}\nsegment: ${r.segment}\nhead: ${r.head}\nreceived: ${r.received_at}`;

/**
 * One file as it stands: its length and the sha256 of exactly those bytes. A log only grows, so every later
 * snapshot of it starts with the same bytes, and anyone who has the file checks each snapshot on its prefix.
 */
export function snapshotFile(file) {
  const data = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  return { length: data.length, sha256: sha256(data) };
}
/** The text a head is the sha256 of: the head before it, then every evidence file by label. */
export const headInput = (prev, files) => ["aas-head-input v1", `prev: ${prev}`, ...[...files].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)).map((f) => `${f.label} ${f.length} ${f.sha256}`)].join("\n");
export const computeHead = (prev, files) => sha256(Buffer.from(headInput(prev, files), "utf8"));

/**
 * The files a head covers: the harness's run log and every session log the runtime wrote for this run, each under
 * a label that says nothing about the machine (`run`, `session:1`, `session:2`, … in the order they first appeared).
 */
export function evidenceFiles(runDir, runtime, state) {
  const sessions = (() => { try { return runtime?.sessionLogs?.(runDir) ?? []; } catch { return []; } })();
  state.sessions ??= [];
  for (const f of sessions) if (!state.sessions.includes(path.resolve(f))) state.sessions.push(path.resolve(f));
  return [{ label: "run", file: path.join(runDir, "run.jsonl") }, ...state.sessions.map((file, i) => ({ label: `session:${i + 1}`, file }))];
}

/** How this machine records proof: `account` (logged in), `anonymous` (AAS_PROOF=anonymous) or `off`. */
export async function proofMode({ override = null, loggedIn } = {}) {
  const want = override ?? process.env.AAS_PROOF ?? null;
  if (want === "off") return "off";
  if (await loggedIn()) return "account";
  if (want === "anonymous") return "anonymous";
  return "off";
}

async function call(method, url, { headers = {}, body = null, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  // The deadline covers the connection too: a closed port under WSL otherwise hangs for minutes.
  const res = await fetchImpl(url, { method, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${new URL(url).pathname} answered ${res.status}${json?.error ? `: ${json.error}` : ""}`);
  return json;
}

/**
 * How the tooling reaches the archive: `fetch`, unless a caller sets another (a test that authenticates its requests
 * in its own way). Every call to the archive's API goes through it.
 */
let archiveFetch = null;
export const useArchiveFetch = (f) => { archiveFetch = f; };
export const currentArchiveFetch = () => archiveFetch ?? fetch;

/** The archive's ticket API. `token()` gives the account's access token, or null for an anonymous ticket. */
export function proofClient({ baseUrl = proofUrl(), token = async () => null, fetchImpl = currentArchiveFetch(), timeoutMs = 15000 } = {}) {
  const api = `${baseUrl}/api/v1/tickets`;
  const auth = async (control) => { const t = await token(); return t ? { Authorization: `Bearer ${t}` } : control ? { Authorization: `Ticket ${control}` } : {}; };
  return {
    async ticket() { return call("POST", api, { headers: await auth(null), fetchImpl, timeoutMs }); },
    async head(t, body) {
      // An account ticket answers to the account; its control secret is the fallback when the token is gone.
      try { return await call("POST", `${api}/${t.ticket}/heads`, { headers: await auth(t.control), body, fetchImpl, timeoutMs }); }
      catch (e) { if (!/answered 401/.test(e.message) || !t.control) throw e; return call("POST", `${api}/${t.ticket}/heads`, { headers: { Authorization: `Ticket ${t.control}` }, body, fetchImpl, timeoutMs }); }
    },
    async manage(t, action) {
      const headers = await auth(t.control);
      if (action === "delete") return call("DELETE", `${api}/${t.ticket}`, { headers, fetchImpl, timeoutMs });
      return call("POST", `${api}/${t.ticket}/${action}`, { headers, fetchImpl, timeoutMs });
    },
  };
}

/** Is this signature the archive's? `{ valid, fingerprint, problem }`. */
export function verifySigned(message, signature, given = null) {
  const keys = keysOf(given);
  if (!keys.length) return { valid: false, fingerprint: null, problem: "no archive proof key is known to this tooling" };
  for (const k of keys) {
    try { if (crypto.verify(null, Buffer.from(message, "utf8"), k.key, Buffer.from(String(signature), "base64"))) return { valid: true, fingerprint: k.fingerprint, problem: null }; } catch { /* next key */ }
  }
  return { valid: false, fingerprint: null, problem: "not signed by a proof key of the archive" };
}

/** A local list of this machine's tickets, so the tool can show and manage them (AAS GUI, `aas tickets`). */
export const ticketIndexFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "aas", "tickets.json");
export const readTicketIndex = () => { try { return JSON.parse(fs.readFileSync(ticketIndexFile(), "utf8")); } catch { return []; } };
function addToTicketIndex(entry) {
  const list = readTicketIndex().filter((e) => e.ticket !== entry.ticket);
  list.push(entry);
  fs.mkdirSync(path.dirname(ticketIndexFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ticketIndexFile(), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Proof for one segment. `begin()` fetches the segment's ticket before anything is recorded (a run that wants
 * proof and cannot get a ticket does not start); `start()` sends the first head once the segment is under way,
 * an hourly timer sends the next ones, and `end()` sends the last after the recording stopped. A head that
 * cannot be sent is logged and the run goes on: the archive sees the gap and a reviewer decides.
 */
export function segmentProof({ runDir, segment, mode, runtime, client, events, log = () => {}, hourMs = Number(process.env.AAS_PROOF_HOUR_MS) || 3600000 }) {
  if (mode === "off") return { mode, async begin() {}, async start() {}, async end() {} };
  const state = readState(runDir) ?? { version: 1, tickets: [], receipts: [], heads: [], missed: [], sessions: [] };
  let ticket = null;
  let timer = null;
  // One head at a time: the hourly timer and the end must not number two heads the same.
  let queue = Promise.resolve();
  const send = (kind) => (queue = queue.then(() => sendNow(kind)));
  const sendNow = async (kind) => {
    const files = evidenceFiles(runDir, runtime, state).map((f) => ({ label: f.label, ...snapshotFile(f.file) }));
    const prev = state.heads.at(-1)?.head ?? ticket.ticket;
    const head = computeHead(prev, files);
    const seq = state.heads.length + 1;
    state.heads.push({ seq, kind, segment, head, prev, files, at: new Date().toISOString() });
    writeState(runDir, state);
    try {
      const receipt = await client.head(ticket, { seq, kind, segment, head });
      if (receipt?.head !== head || receipt?.seq !== seq) throw new Error("the receipt names another head");
      state.receipts.push(receipt);
    } catch (e) {
      state.missed.push({ seq, kind, segment, at: new Date().toISOString(), reason: e.message });
      events?.append("proof.missed", { seq, kind, segment, reason: e.message });
      log(`proof: the ${kind} head of segment ${segment} was not received (${e.message}); the run goes on`);
    }
    writeState(runDir, state);
  };
  return {
    mode,
    async begin() {
      const t = await client.ticket();
      if (!/^[0-9a-f]{32}$/.test(String(t?.ticket))) throw new Error("the archive answered without a ticket");
      const v = verifySigned(ticketMessage(t), t.signature);
      if (!v.valid) throw new Error(`the ticket is not the archive's (${v.problem})`);
      ticket = { ...t, segment };
      state.tickets.push(ticket);
      writeState(runDir, state);
      addToTicketIndex({ ticket: t.ticket, control: t.control ?? null, account: Boolean(t.account), run_dir: path.resolve(runDir), segment, issued_at: t.issued_at, expires_at: t.expires_at ?? null });
      log(`proof: ticket for segment ${segment} (${mode}), issued ${t.issued_at}`);
    },
    async start() {
      events?.append("proof.ticket", { ticket: ticket.ticket, issued_at: ticket.issued_at, segment, account: Boolean(ticket.account) });
      await send("start");
      timer = setInterval(() => { send("hour").catch(() => {}); }, hourMs);
      timer.unref?.();
    },
    async end() {
      if (timer) clearInterval(timer);
      if (ticket) await send("end");
    },
  };
}

/**
 * What the public bundle carries (proof.json): the tickets without their control secret, every receipt and every
 * head with the (label, length, sha256) of the files it covered. Null for a run without proof: an unsigned run.
 */
export function publicProof(runDir, { completionMarker = null, session = null } = {}) {
  const state = readState(runDir);
  if (!state?.tickets?.length) return null;
  const label = session ? state.sessions?.findIndex((f) => f === path.resolve(session)) : -1;
  return {
    version: 1,
    tickets: state.tickets.map(({ control, ...t }) => t),
    heads: state.heads.map(({ seq, kind, segment, head, prev, files }) => ({ seq, kind, segment, head, prev, files })),
    receipts: state.receipts,
    missed: state.missed,
    export: { session: label >= 0 ? `session:${label + 1}` : null, completion_marker: completionMarker },
  };
}

/** The private part of the upload: the evidence files under their labels, plus what the timeline is made from. */
export function privateEntries(runDir) {
  const state = readState(runDir);
  if (!state?.tickets?.length) return [];
  const out = [{ name: "run.jsonl", file: path.join(runDir, "run.jsonl") }];
  state.sessions.forEach((file, i) => out.push({ name: `session-${i + 1}.jsonl`, file }));
  for (const f of ["recording.json", "brief.json"]) out.push({ name: f, file: path.join(runDir, f) });
  return out.filter((e) => fs.existsSync(e.file));
}

/**
 * The proof of a bundle, checked as far as the public part allows: every ticket and receipt signed by the archive,
 * the heads in order and chained, every receipt for the head this bundle says was sent. With the private files
 * (`privateDir`), every head is recomputed from them as well.
 * Returns `{ status: "signed" | "unsigned" | "invalid" | "review", detail, problems, review }`.
 */
export function checkProof(bundleDir, { privateDir = null, keys = null } = {}) {
  keys = keysOf(keys);
  const file = path.join(bundleDir, "proof.json");
  if (!fs.existsSync(file)) return { status: "unsigned", detail: "no proof.json: the run was recorded without proof", problems: [], review: [] };
  let proof;
  try { proof = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return { status: "invalid", detail: `proof.json: ${e.message}`, problems: [e.message], review: [] }; }
  const problems = [], review = [];
  const tickets = new Map();
  for (const t of proof.tickets ?? []) {
    const v = verifySigned(ticketMessage(t), t.signature, keys);
    if (!v.valid) problems.push(`ticket of segment ${t.segment}: ${v.problem}`);
    tickets.set(t.segment, t);
  }
  const heads = proof.heads ?? [];
  heads.forEach((h, i) => {
    if (h.seq !== i + 1) problems.push(`head ${i + 1} has seq ${h.seq}`);
    const prev = i ? heads[i - 1].head : tickets.get(h.segment)?.ticket;
    if (h.prev !== prev) problems.push(`head ${h.seq} does not follow on the one before it`);
    if (computeHead(h.prev, h.files ?? []) !== h.head) problems.push(`head ${h.seq} is not the hash of what it says it covers`);
  });
  const bySeq = new Map(heads.map((h) => [h.seq, h]));
  for (const r of proof.receipts ?? []) {
    const h = bySeq.get(r.seq);
    const t = tickets.get(r.segment);
    const v = verifySigned(receiptMessage(r), r.signature, keys);
    if (!v.valid) problems.push(`receipt ${r.seq}: ${v.problem}`);
    else if (!h || h.head !== r.head || h.kind !== r.kind || h.segment !== r.segment) problems.push(`receipt ${r.seq} is for another head than the bundle's`);
    else if (!t || r.ticket !== t.ticket) problems.push(`receipt ${r.seq} is for another ticket than segment ${r.segment}'s`);
  }
  const received = new Set((proof.receipts ?? []).map((r) => r.seq));
  const missing = heads.filter((h) => !received.has(h.seq));
  if (missing.length) review.push(`${missing.length} head(s) never reached the archive (${missing.map((h) => `${h.kind} of segment ${h.segment}`).join(", ")})`);
  for (const s of new Set(heads.map((h) => h.segment))) if (!heads.some((h) => h.segment === s && h.kind === "end" && received.has(h.seq))) review.push(`segment ${s} has no received end head`);
  // Every segment of the run has its own ticket: a resume without proof leaves a segment nobody fixed.
  const timeline = path.join(bundleDir, "session.sanitized.jsonl");
  if (fs.existsSync(timeline)) {
    const segments = fs.readFileSync(timeline, "utf8").split("\n").filter((l) => l.includes('"run.started"')).length;
    for (let s = 1; s <= segments; s += 1) if (!tickets.has(s)) review.push(`segment ${s} was recorded without proof`);
  }
  // An edit to a log leaves every snapshot before it wrong: each (length, sha256) is checked on the file's prefix.
  if (privateDir) {
    const files = new Map([["run", path.join(privateDir, "run.jsonl")], ...fs.readdirSync(privateDir).filter((f) => /^session-\d+\.jsonl$/.test(f)).map((f) => [`session:${f.match(/\d+/)[0]}`, path.join(privateDir, f)])]);
    const data = new Map([...files].map(([k, f]) => [k, fs.readFileSync(f)]));
    for (const h of heads) for (const f of h.files ?? []) {
      const d = data.get(f.label);
      if (!d) { if (f.length) problems.push(`head ${h.seq}: ${f.label} is not in the private part`); continue; }
      if (d.length < f.length || sha256(d.subarray(0, f.length)) !== f.sha256) problems.push(`head ${h.seq}: ${f.label} differs from what was hashed at ${h.kind} of segment ${h.segment}`);
    }
  }
  const status = problems.length ? "invalid" : review.length ? "review" : "signed";
  const detail = problems.length ? problems.join("; ") : review.length ? review.join("; ") : `${heads.length} head(s) over ${tickets.size} segment(s), every one signed by the archive${privateDir ? " and recomputed from the private logs" : ""}`;
  return { status, detail, problems, review };
}
