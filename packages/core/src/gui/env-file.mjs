// The repository's .env as the GUI edits it: the same file the CLI loads, so a setting made in the GUI is the setting
// every command uses. Comments, order and unknown lines are kept; a changed key is replaced where it stands (the
// last uncommented occurrence), a new key is appended under a marker comment, an empty value removes the line.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_FILE = process.env.AAS_ENV_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env");
const MARK = "# set with aas gui";

export function readEnv(file = ENV_FILE) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** Applies `{ KEY: value | "" }` to the file and to this process's environment. */
export function writeEnv(changes, file = ENV_FILE) {
  let lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  if (lines.length && lines.at(-1) === "") lines.pop();
  for (const [key, raw] of Object.entries(changes)) {
    if (!/^[A-Z0-9_]+$/.test(key)) throw new Error(`not a setting name: ${key}`);
    const value = String(raw ?? "").replace(/[\r\n]/g, "").trim();
    const at = lines.map((l, i) => (new RegExp(`^\\s*${key}\\s*=`).test(l) ? i : -1)).filter((i) => i >= 0);
    if (!value) {
      lines = lines.filter((_, i) => !at.includes(i));
      delete process.env[key];
      continue;
    }
    if (at.length) {
      lines[at.at(-1)] = `${key}=${value}`;
      lines = lines.filter((_, i) => !at.slice(0, -1).includes(i));
    } else {
      if (!lines.includes(MARK)) lines.push("", MARK);
      lines.push(`${key}=${value}`);
    }
    process.env[key] = value;
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}
