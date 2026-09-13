// Replace machine-specific path prefixes for publication: the run directory,
// the repository checkout and the home directory, in both slash styles.
import os from "node:os";
import path from "node:path";
import { CORE_DIR } from "./mcp-client.mjs";

const REPO_ROOT = path.resolve(CORE_DIR, "..", "..");
const variants = (p) => [...new Set([p, p.replaceAll("\\", "/"), p.replaceAll("/", "\\")])].filter(Boolean);

export function publicPath(text, { runDir } = {}) {
  let out = text;
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
