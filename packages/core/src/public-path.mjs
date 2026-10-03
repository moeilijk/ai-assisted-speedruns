// Replace machine-specific path prefixes for publication: the run directory,
// the repository checkout and the home directory, in both slash styles.
import os from "node:os";
import path from "node:path";
import { CORE_DIR } from "./mcp-client.mjs";

const REPO_ROOT = path.resolve(CORE_DIR, "..", "..");
const variants = (p) => [...new Set([p, p.replaceAll("\\", "/"), p.replaceAll("/", "\\")])].filter(Boolean);

/** The variables the harness sets for the broker; every other variable is the plugin's own setting. */
export const HARNESS_ENV = new Set(["AAS_GAME_MODULE", "AAS_RUN_DIR", "AAS_ALLOWED_ENDPOINTS", "AAS_TIME_ZONE"]);

/**
 * `env` is the broker's environment: a plugin setting that is a path on this machine (a game folder) is `__ENV__` in
 * published text too, as its value is in the published `env` itself. A path built from it, such as a file the broker
 * may read, otherwise carried the machine's path into the bundle and the bundle was refused for it (2026-10-04: the
 * game folder in Portal's --allow-fs-read).
 */
export function publicPath(text, { runDir, env } = {}) {
  let out = text;
  for (const [k, v] of Object.entries(env ?? {})) {
    if (HARNESS_ENV.has(k) || typeof v !== "string" || v.length < 4 || !(path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v))) continue;
    if (v === runDir || v === REPO_ROOT) continue;
    for (const x of variants(v.replace(/[\\/]+$/, ""))) out = out.replaceAll(x, "__ENV__");
  }
  const rules = [
    [runDir, "__RUN_DIR__"],
    [REPO_ROOT, "__REPO__"],
    [os.homedir(), "__HOME__"],
  ];
  for (const [prefix, token] of rules) {
    if (!prefix) continue;
    for (const v of variants(prefix)) out = out.replaceAll(v, token);
  }
  return out;
}
