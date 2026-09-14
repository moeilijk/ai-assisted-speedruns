// Workspace trust for a run directory. Claude Code applies the `permissions.allow` rules of a project's
// .claude/settings.json only in a directory whose trust dialog was accepted; a directory it has never seen
// is untrusted, and in a headless session (`claude -p`) there is no dialog. The documented way to trust a
// directory without the dialog is `projects["<dir>"].hasTrustDialogAccepted: true` in Claude Code's config
// file (~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json). Every run directory is new, so the runtime sets
// the flag when it configures the directory and refuses to start when it is missing: a run whose allow rules
// were ignored is not a valid run, whatever else happened.
//
// The same settings file is also passed with --settings, which Claude Code applies as a command-line override
// outside the trust check (, measured: the broker's tools worked in an untrusted directory, and the
// deny rules held too), so the flag makes no difference to what the agent can do; it makes the difference
// between a session that starts with "Ignoring 3 permissions.allow entries" on stderr and one that does not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Claude Code's config file: $CLAUDE_CONFIG_DIR/.claude.json when that is set, else ~/.claude.json. */
export function claudeConfigFile(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || env.HOME || os.homedir(), ".claude.json");
}

function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); not touching it`);
  }
}

/**
 * The directory whose trust Claude Code checks for a session started in `runDir`: the root of the git repository
 * the directory is in, else the directory itself. Measured with Claude Code 2.1.270: a session in
 * <repo>/runs/claude-smoke, trusted under its own path, still printed "Ignoring 3 permissions.allow entries" and
 * named projects["<repo>"] as the entry to set.
 */
export function trustDir(runDir) {
  const dir = path.resolve(runDir);
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return dir;
  }
}

/** Whether Claude Code trusts `runDir` (the trust dialog accepted, or the flag set by `trustRunDir`). */
export function isTrusted(runDir, { file = claudeConfigFile() } = {}) {
  const dir = trustDir(runDir);
  try {
    return readConfig(file).projects?.[dir]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

/**
 * Marks `runDir` trusted in Claude Code's config file, keeping everything else in it as it is.
 * Returns what changed: `{ file, dir, changed }`.
 */
export function trustRunDir(runDir, { file = claudeConfigFile() } = {}) {
  const dir = trustDir(runDir);
  const config = readConfig(file);
  if (config.projects?.[dir]?.hasTrustDialogAccepted === true) return { file, dir, changed: false };
  config.projects = config.projects ?? {};
  config.projects[dir] = { ...(config.projects[dir] ?? {}), hasTrustDialogAccepted: true };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written next to the file and renamed into place: a crash halfway must not leave Claude Code's config truncated.
  const tmp = `${file}.aas-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { file, dir, changed: true };
}

/** The stderr line with which Claude Code reports rules it did not apply; one of these in a session voids the run. */
export const IGNORED_RULES = /Ignoring \d+ permissions\.(allow|deny|additionalDirectories)[^\n]*/;
