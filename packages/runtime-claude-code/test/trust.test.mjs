// Trusting a run directory in Claude Code's config file: the flag is set, nothing else in the file changes,
// a second call changes nothing, an unreadable file is left alone, and `start` refuses an untrusted directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IGNORED_RULES, claudeConfigFile, isTrusted, trustDir, trustRunDir } from "../trust.mjs";
import runtime from "../index.mjs";

test("trustRunDir sets the flag for that directory and keeps the rest of the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-trust-"));
  const file = join(dir, ".claude.json");
  writeFileSync(file, JSON.stringify({ numStartups: 7, projects: { "/elsewhere": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] }, "/run": { allowedTools: [] } } }));
  assert.equal(isTrusted("/run", { file }), false);
  assert.deepEqual(trustRunDir("/run", { file }), { file, dir: "/run", changed: true });
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.numStartups, 7);
  assert.deepEqual(after.projects["/elsewhere"], { hasTrustDialogAccepted: true, allowedTools: ["Bash"] });
  assert.deepEqual(after.projects["/run"], { allowedTools: [], hasTrustDialogAccepted: true });
  assert.equal(isTrusted("/run", { file }), true);
  assert.deepEqual(trustRunDir("/run", { file }), { file, dir: "/run", changed: false });
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(after, null, 2) + "\n");
});

test("a missing config file is created; a broken one is not touched", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-trust-"));
  const fresh = join(dir, "new", ".claude.json");
  assert.equal(trustRunDir("/run", { file: fresh }).changed, true);
  assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), { projects: { "/run": { hasTrustDialogAccepted: true } } });
  const broken = join(dir, ".claude.json");
  writeFileSync(broken, "{not json");
  assert.throws(() => trustRunDir("/run", { file: broken }), /not valid JSON/);
  assert.equal(readFileSync(broken, "utf8"), "{not json");
  assert.equal(isTrusted("/run", { file: broken }), false);
});

test("inside a git repository the trust entry is the repository's root, as Claude Code checks it", () => {
  const repo = mkdtempSync(join(tmpdir(), "aas-trust-repo-"));
  mkdirSync(join(repo, ".git"));
  const run = join(repo, "runs", "smoke");
  mkdirSync(run, { recursive: true });
  assert.equal(trustDir(run), repo);
  const plain = mkdtempSync(join(tmpdir(), "aas-trust-plain-"));
  assert.equal(trustDir(plain), plain);
  const file = join(mkdtempSync(join(tmpdir(), "aas-trust-cfg-")), ".claude.json");
  assert.deepEqual(trustRunDir(run, { file }), { file, dir: repo, changed: true });
  assert.equal(isTrusted(run, { file }), true);
});

test("the config file follows CLAUDE_CONFIG_DIR, else HOME", () => {
  assert.equal(claudeConfigFile({ CLAUDE_CONFIG_DIR: "/cfg", HOME: "/home/x" }), "/cfg/.claude.json");
  assert.equal(claudeConfigFile({ HOME: "/home/x" }), "/home/x/.claude.json");
});

test("start refuses a run directory Claude Code does not trust", async () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aas-trust-cfg-"));
  const runDir = mkdtempSync(join(tmpdir(), "aas-trust-run-"));
  await assert.rejects(() => runtime.start(runDir, { headless: true, goalPrompt: "x" }), /does not trust .*hasTrustDialogAccepted/);
});

test("the stderr line Claude Code prints for ignored rules is recognised", () => {
  const line = 'Ignoring 3 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/x"].hasTrustDialogAccepted: true in /home/u/.claude.json.';
  assert.match(line, IGNORED_RULES);
  assert.doesNotMatch("[agent] → mcp__x__x_exec", IGNORED_RULES);
});
