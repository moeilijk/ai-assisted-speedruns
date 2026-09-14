// `aas configure` with both runtimes against the fake game: files are written
// once, contain only the broker as tool source, and refuse to overwrite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configure } from "../src/configure.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fakeGame = join(here, "fake-game.mjs");
// The claude-code runtime marks the run directory trusted in Claude Code's config file; the test must not touch the real one.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aas-claude-config-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "aas-codex-home-"));
// Machine variables that must never reach the broker or the published configuration.
process.env.AAS_OBS_PASSWORD = "not-for-the-bundle";
process.env.AAS_LIVESPLIT_EXE = "/mnt/d/somewhere/LiveSplit.exe";

test("codex configure writes config.toml, AGENTS.md, runtime-config and brief.json once", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aas-cfg-codex-"));
  const instructions = join(runDir, "..", `instr-${Date.now()}.md`);
  writeFileSync(instructions, "# Play\n");
  const r = await configure({ runtime: "codex", game: fakeGame, "run-dir": runDir, instructions, goal: "end", model: "gpt-6" });
  const toml = readFileSync(join(runDir, ".codex", "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\.fake_game\]/);
  assert.match(toml, /"fake_game_exec"/);
  assert.match(toml, /--permission/);
  assert.match(toml, /web_search = false/);
  assert.match(toml, /shell_tool = false/);
  const published = readFileSync(join(runDir, "runtime-config", "config.template.toml"), "utf8");
  assert.doesNotMatch(published, new RegExp(runDir.replaceAll("\\", "/")));
  assert.doesNotMatch(published, /\/home\/|[A-Z]:[\\/]+Users/);
  assert.match(published, /__REPO__/);
  assert.equal(readFileSync(join(runDir, "AGENTS.md"), "utf8"), "# Play\n");
  const brief = JSON.parse(readFileSync(join(runDir, "brief.json"), "utf8"));
  assert.equal(brief.category.goal, "end");
  assert.equal(brief.category.game, "fake_game");
  assert.equal(brief.model, "gpt-6");
  assert.equal(brief.goalPrompt, null);
  assert.match(r.hint, /Codex/);
  await assert.rejects(() => configure({ runtime: "codex", game: fakeGame, "run-dir": runDir, instructions }), /Refusing to overwrite/);
});

test("claude-code configure writes .mcp.json with only the broker and denies other tools", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aas-cfg-claude-"));
  const instructions = join(runDir, "..", `instr-${Date.now()}.md`);
  writeFileSync(instructions, "# Play\n");
  const r = await configure({ runtime: "claude-code", game: fakeGame, "run-dir": runDir, instructions, prompt: "Reach the credits." });
  assert.equal(r.brief.goalPrompt, "Reach the credits.");
  const mcp = JSON.parse(readFileSync(join(runDir, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["fake_game"]);
  assert.equal(mcp.mcpServers.fake_game.command, "node");
  assert.ok(mcp.mcpServers.fake_game.args.includes("--permission"));
  assert.equal(mcp.mcpServers.fake_game.env.AAS_GAME_MODULE, fakeGame);
  const settings = JSON.parse(readFileSync(join(runDir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["mcp__fake_game__fake_game_documentation", "mcp__fake_game__fake_game_screenshot", "mcp__fake_game__fake_game_exec"]);
  for (const t of ["Bash", "WebFetch", "WebSearch", "Write"]) assert.ok(settings.permissions.deny.includes(t), t);
  assert.ok(existsSync(join(runDir, "CLAUDE.md")) && existsSync(join(runDir, "AGENTS.md")));
  const publishedMcp = readFileSync(join(runDir, "runtime-config", "mcp.template.json"), "utf8");
  assert.doesNotMatch(publishedMcp, /\/home\/|[A-Z]:[\\/]+Users/);
  assert.match(publishedMcp, /__REPO__\/packages\/core/);
  // The broker gets the harness's variables and what the plugin declares, nothing else of the machine's environment;
  // the published copy shows the plugin's variables as __ENV__ (the whole.env, OBS password included, was published).
  const privateEnv = mcp.mcpServers.fake_game.env;
  assert.ok(!("AAS_OBS_PASSWORD" in privateEnv) && !("AAS_LIVESPLIT_EXE" in privateEnv), Object.keys(privateEnv).join(","));
  const publishedEnv = JSON.parse(publishedMcp).mcpServers.fake_game.env;
  for (const [k, v] of Object.entries(publishedEnv)) assert.ok(["AAS_GAME_MODULE", "AAS_RUN_DIR", "AAS_ALLOWED_ENDPOINTS", "AAS_TIME_ZONE"].includes(k) ? /^(__|127\.0\.0\.1|$)/.test(v) || v === "" : v === "__ENV__", `${k}=${v}`);
  // Claude Code applies the allow rules only in a trusted directory: configure marks the run directory trusted.
  assert.deepEqual(r.trust, { file: join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), dir: runDir, changed: true });
  const claudeConfig = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8"));
  assert.equal(claudeConfig.projects[runDir].hasTrustDialogAccepted, true);
});
