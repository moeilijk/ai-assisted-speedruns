// The archive's witness keys and the check of its receipts, with no dependency beyond sign.mjs, so that the checker
// (and an archive that carries it) can verify the receipts in a bundle. What the witness is: witness.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import { publicInfo, publicKeyFromLine } from "./sign.mjs";

/** The statement this tooling writes. v2 adds what a start and an end are about (witness.mjs, SPEC §8.9). */
export const STATEMENT_KIND = "aas-witness v2";
/** Every statement kind a reader accepts: a bundle from before draft 0.40 carries v1, and stays valid. */
export const STATEMENT_KINDS = Object.freeze(["aas-witness v1", "aas-witness v2"]);
export const RECEIPT_KIND = "aas-witness-receipt v1";

/** The archive's witness keys, as published at /.well-known/aas-witness.txt. A key in an answer is never trusted. */
export const WITNESS_KEYS = Object.freeze([
  Object.freeze({
    key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ/yFQQVkSwBPbr5GwCrV8dTGWtRZjdfkNr7rvOBQ/no",
    fingerprint: "SHA256:dOR2nOzveMw84iDxkGxnJqsf4+p4X/YT8T9uqKLXQ2s",
    since: "2026-09-16T19:17:10.066Z",
  }),
]);

/** The keys in a published aas-witness.txt: blocks of `aas-witness-key v1`, `key:`, `fingerprint:`, `since:`. */
export function parseWitnessKeys(text) {
  return String(text).split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n").map((l) => l.trim());
    if (lines[0] !== "aas-witness-key v1") return null;
    const value = (name) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
    return value("key") ? { key: value("key"), fingerprint: value("fingerprint"), since: value("since") } : null;
  }).filter(Boolean);
}

/**
 * The witness keys this tooling trusts: the archive's, plus those of another witness in the file AAS_WITNESS_KEYS
 * names (its aas-witness.txt), for a runner who submits to another archive or tests against a witness of their own.
 */
export function trustedWitnessKeys() {
  const extra = process.env.AAS_WITNESS_KEYS;
  if (!extra) return WITNESS_KEYS;
  try { return [...WITNESS_KEYS, ...parseWitnessKeys(fs.readFileSync(extra, "utf8"))]; } catch { return WITNESS_KEYS; }
}

/** `{ valid, fingerprint, problem }`: is the receipt the archive's signature over this statement and time? */
export function verifyReceipt({ statement, received_at: receivedAt, statement_sha256: sha, receipt }, keys = trustedWitnessKeys()) {
  const own = crypto.createHash("sha256").update(String(statement ?? ""), "utf8").digest("hex");
  if (sha !== own) return { valid: false, fingerprint: null, problem: "statement_sha256 is not the sha256 of the statement" };
  const signed = Buffer.from(`${RECEIPT_KIND}\nstatement: ${sha}\nreceived: ${receivedAt}`, "utf8");
  for (const k of keys) {
    try {
      if (crypto.verify(null, signed, publicKeyFromLine(k.key), Buffer.from(String(receipt ?? ""), "base64"))) return { valid: true, fingerprint: publicInfo(publicKeyFromLine(k.key)).fingerprint, problem: null };
    } catch { /* not this key */ }
  }
  return { valid: false, fingerprint: null, problem: "the receipt is not signed by a witness key of the archive" };
}
