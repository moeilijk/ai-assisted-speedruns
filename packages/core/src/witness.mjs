// The archive as a witness of when a session ran. At the start and at the end of every segment the harness sends
// the archive a short statement signed with the publisher's key; the archive answers with its own clock, signed with
// its key. The receipts go into the timeline (`run.witnessed`), so a bundle shows when each segment really ran, by a
// clock the runner does not control. Which rules apply to a segment follows from that clock, not from the version
// the tooling reports. Without a network, a key or a witness the run goes on: the segment is `run.unwitnessed`.
// Nothing is sent afterwards, because a late statement proves nothing about when a segment ran.
import crypto from "node:crypto";
import { ARCHIVE_URL } from "./plugins.mjs";
import { readKey } from "./sign.mjs";
import { STATEMENT_KIND, trustedWitnessKeys, verifyReceipt } from "./witness-receipt.mjs";
import { resolveSignKey } from "./publish.mjs";

export { RECEIPT_KIND, STATEMENT_KIND, STATEMENT_KINDS, WITNESS_KEYS, parseWitnessKeys, trustedWitnessKeys, verifyReceipt } from "./witness-receipt.mjs";

/** Where statements go: AAS_WITNESS_URL, `off` for none (the test suite), else the archive's own witness. */
export function witnessUrl() {
  const url = process.env.AAS_WITNESS_URL;
  if (url === "off") return null;
  return url || `${ARCHIVE_URL}/witness/`;
}

/** "<version> <commit> <clean|modified>", with `-` for no commit (not a git clone) and `unknown` when unreadable. */
export const toolingField = (t) => `${t.version} ${t.commit ?? "-"} ${t.modified === null || t.modified === undefined ? "unknown" : t.modified ? "modified" : "clean"}`;

/** "<id> <version> <ai|no-ai|ai-unknown> <sha256 of the plugin>", `-` for anything this machine cannot say. */
export const runtimeField = (r) => `${r?.id ?? "-"} ${r?.version ?? "-"} ${r?.ai === true ? "ai" : r?.ai === false ? "no-ai" : "ai-unknown"} ${r?.sha256 ?? "-"}`;

/**
 * The signed statement for one phase of one segment.
 *
 * A start says what the segment is about to run under: the runtime with its own hash (what drove the run is then
 * not the publisher's word afterwards), the hash of the instructions the model is given, and the goal with the
 * hash of the prompt that names it. All three are fixed before a tick is played, and the archive counter-signs
 * them, so a run whose route was dictated in its prompt publishes that prompt or nothing.
 *
 * An end says what the segment produced: the run log's hash and its number of records at that moment. A reader
 * cannot recompute it (the run log is private, SPEC §4) and it is not meant to be recomputed: it fixes the log at
 * a time on the archive's clock, so what is published later either derives from that log or from one that never
 * existed when the archive was looking.
 */
export function makeStatement({ phase, runUid, segment, tooling, at = new Date().toISOString(), t0, endedAt, seconds, runtime, instructionsSha256, goal, goalPromptSha256, logSha256, records }, keyFile) {
  const { privateKey, publicLine } = readKey(keyFile);
  const lines = [
    STATEMENT_KIND,
    `phase: ${phase}`,
    `run_uid: ${runUid}`,
    `segment: ${segment}`,
    `tooling: ${toolingField(tooling)}`,
    `at: ${at}`,
    ...(phase === "start"
      ? [`t0: ${t0}`, `runtime: ${runtimeField(runtime)}`, `instructions: ${instructionsSha256 ?? "-"}`, `goal: ${goal ?? "-"} ${goalPromptSha256 ?? "-"}`]
      : [`ended_at: ${endedAt}`, `seconds: ${seconds}`, `log: ${logSha256 ?? "-"} ${Number.isInteger(records) ? records : "-"}`]),
    `key: ${publicLine}`,
  ];
  const body = lines.join("\n");
  return `${body}\nsignature: ${crypto.sign(null, Buffer.from(body, "utf8"), privateKey).toString("base64")}`;
}

/**
 * `{ ok, detail }` for `aas doctor`: is there a publisher key, and does the witness know it (registered with an
 * account)? A run without it is not witnessed.
 */
export async function witnessKeyStatus({ url = witnessUrl(), keyFile, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!url) return { ok: false, detail: "no witness (AAS_WITNESS_URL=off): segments are not witnessed" };
  let info;
  try { info = readKey(keyFile ?? resolveSignKey()); } catch (e) { return { ok: false, detail: `no publisher key: ${e.message}` }; }
  try {
    const res = await fetchImpl(`${url.replace(/\/?$/, "/")}key/?fingerprint=${encodeURIComponent(info.fingerprint)}`, { signal: AbortSignal.timeout(timeoutMs) });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, detail: `the witness answered ${res.status}` };
    return answer.registered
      ? { ok: true, detail: `${info.fingerprint} is registered with an account` }
      : { ok: false, detail: `${info.fingerprint} is not registered with an account: record its public line on the archive's account page, or runs are not witnessed (${info.publicLine})` };
  } catch (e) {
    return { ok: false, detail: `the witness could not be reached (${e.message})` };
  }
}

/**
 * Sends one statement and returns the event to log: `run.witnessed` with the statement and the archive's receipt, or
 * `run.unwitnessed` with the reason. Never throws: a run does not stop for its witness.
 */
export async function witnessSegment(fields, { url = witnessUrl(), keyFile, keys = trustedWitnessKeys(), timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const base = { phase: fields.phase, segment: fields.segment };
  if (!url) return { event: "run.unwitnessed", data: { ...base, reason: "no witness (AAS_WITNESS_URL=off)" } };
  if (!fields.runUid) return { event: "run.unwitnessed", data: { ...base, reason: "the run has no run_uid" } };
  let statement;
  try {
    statement = makeStatement(fields, keyFile ?? resolveSignKey());
  } catch (e) {
    return { event: "run.unwitnessed", data: { ...base, reason: `no publisher key: ${e.message}` } };
  }
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: statement, signal: AbortSignal.timeout(timeoutMs) });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) return { event: "run.unwitnessed", data: { ...base, reason: `the witness answered ${res.status}${answer.error ? `: ${answer.error}` : ""}` } };
    const data = { ...base, statement, received_at: answer.received_at, statement_sha256: answer.statement_sha256, receipt: answer.receipt };
    const check = verifyReceipt(data, keys);
    if (!check.valid) return { event: "run.unwitnessed", data: { ...base, reason: `the witness answered, but ${check.problem}` } };
    return { event: "run.witnessed", data: { ...data, witness_key: check.fingerprint } };
  } catch (e) {
    return { event: "run.unwitnessed", data: { ...base, reason: `the witness could not be reached (${e.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000} s` : e.message})` } };
  }
}
