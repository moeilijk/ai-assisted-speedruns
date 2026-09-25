// What a person or a page may hand the tooling, checked once, at the edge, the same way for the command line and the
// GUI. Every value here ends up in a command line, a file name, a game's console or another program's settings, so
// each is held to what it is for; a refusal names the option and says what is expected.

/** The efforts a runtime can be given (`--effort`). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** The proof modes (`--proof`, AAS_PROOF). */
export const PROOF_MODES = ["off", "anonymous", "account"];

const fail = (what, value, expected) => {
  throw new Error(`${what} ${JSON.stringify(String(value)).slice(0, 80)} is not allowed: ${expected}`);
};

/** A model id as its maker writes it (claude-opus-5-5, gpt-5.6-luna, provider/model:tag): no spaces, no quotes. */
export function checkModel(v) {
  if (v === undefined || v === null || v === "") return v;
  if (typeof v !== "string" || v.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/.test(v)) fail("--model", v, "a model id: letters, digits and . _ : / [ ] -");
  return v;
}

export function checkEffort(v) {
  if (v === undefined || v === null || v === "") return v;
  if (!EFFORTS.includes(v)) fail("--effort", v, `one of ${EFFORTS.join(", ")}`);
  return v;
}

/** A game's seed (Balatro YLNKMKFJ, Slay the Spire 23M): letters, digits, _ and -, never starting with - or _, so it
 *  can never be read as an option, break a game's line protocol or reach a console as a second command. */
export function checkSeed(v) {
  if (v === undefined || v === null || v === "") return v;
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(v)) fail("--seed", v, "letters and digits (and _ or - after the first), at most 32");
  return v;
}

/** A name that becomes a folder or a file (a run, a save): no path, no spaces, no leading dot or dash. */
export function checkName(what, v, { max = 64 } = {}) {
  if (typeof v !== "string" || !new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${max - 1}}$`).test(v)) fail(what, v, `letters, digits, _ and -, starting with a letter or digit, at most ${max}`);
  return v;
}

export function checkProofMode(v) {
  if (v === undefined || v === null || v === "") return v;
  if (!PROOF_MODES.includes(v)) fail("--proof", v, `one of ${PROOF_MODES.join(", ")}`);
  return v;
}

/** An agent session id (Claude Code and Codex use UUIDs), handed to `--resume`. */
export function checkSessionId(v) {
  if (v === undefined || v === null || v === "") return v;
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(v)) fail("--session", v, "a session id: letters, digits and -");
  return v;
}

/** A ticket id as the Archive issues it. */
export function checkTicket(v) {
  if (typeof v !== "string" || !/^[0-9a-f]{32}$/.test(v)) fail("ticket", v, "32 lowercase hex characters, as `aas tickets` lists them");
  return v;
}

/** A path that has to lie inside `dir` (after resolving `..` and symlinks of the part that exists). */
export async function checkInside(what, p, dir) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const base = real(dir);
  const rel = path.relative(base, real(p));
  if (!dir || !p || rel.startsWith("..") || path.isAbsolute(rel)) fail(what, p, `a path inside ${dir || "the output location"}`);
  return p;
}

/** A positive number of something (minutes, turns, a port); `integer` when a fraction makes no sense. */
export function checkNumber(what, v, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (v === undefined || v === null || v === "") return v;
  const n = Number(v);
  if (typeof v === "boolean" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) fail(what, v, `${integer ? "a whole number" : "a number"} from ${min} to ${max}`);
  return n;
}
