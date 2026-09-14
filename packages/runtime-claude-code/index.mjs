// Claude Code runtime plugin: writes .mcp.json (only the broker), a project
// settings file that denies every non-broker tool, and CLAUDE.md with the run
// instructions, then starts `claude` in the run directory with strict MCP config.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { publicPath } from "../core/src/public-path.mjs";
import { checkBudget, weeklyMax } from "./budget.mjs";
import { IGNORED_RULES, claudeConfigFile, isTrusted, trustRunDir } from "./trust.mjs";
import { exportClaudeSession, claudeProjectDir } from "../core/src/export-claude-session.mjs";
import { spawnSync } from "node:child_process";

const DENIED_TOOLS = ["Bash", "WebFetch", "WebSearch", "Agent", "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep", "Skill", "TodoWrite"];

export function renderSettings(broker) {
  const tools = ["documentation", "screenshot", "exec"].map((t) => `mcp__${broker.gameId}__${broker.gameId}_${t}`);
  return {
    permissions: { allow: tools, deny: DENIED_TOOLS, defaultMode: "acceptEdits" },
    enableAllProjectMcpServers: true,
    enabledMcpjsonServers: [broker.gameId],
  };
}

/** The variables the harness sets itself; every other variable is the game plugin's and is published as `__ENV__`. */
export const HARNESS_ENV = new Set(["AAS_GAME_MODULE", "AAS_RUN_DIR", "AAS_ALLOWED_ENDPOINTS", "AAS_TIME_ZONE"]);
export function publicEnv(env, broker) {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, HARNESS_ENV.has(k) ? publicPath(String(v), broker) : "__ENV__"]));
}
export function renderMcpConfig(broker, { placeholders = false } = {}) {
  const sub = (v) => (placeholders ? publicPath(String(v), broker) : v);
  return {
    mcpServers: {
      [broker.gameId]: {
        command: "node",
        args: broker.nodeArgs.map(sub),
        // Published: the machine's paths as __RUN_DIR__/__REPO__/__HOME__, the plugin's variables as __ENV__ (their
        // values come from the reader's own.env). Until the values were published as they were.
        env: placeholders ? publicEnv(broker.env, broker) : { ...broker.env },
      },
    },
  };
}

let interruptChild = null;
/** The newest Claude Code session log for a run directory (Claude Code keeps it under ~/.claude/projects/<mangled run dir>/). */
export function findClaudeSession(runDir) {
  const dir = claudeProjectDir(runDir);
  if (!fs.existsSync(dir)) return null;
  const logs = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  return logs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

export default {
  id: "claude-code",
  /** The Claude plan's stand: runs stay under AAS_BUDGET_WEEKLY_MAX percent of the week. */
  async budget() { const b = await checkBudget(); return { ok: b.ok, percent: b.percent, max: b.max, detail: b.detail, data: { five_hour_percent: b.usage.fiveHour.percent } }; },
  /** Read-only checks for `aas doctor`: claude on the PATH, its config file writable, the run directory trusted (a resume). */
  async doctor({ runDir = null } = {}) {
    const rows = [];
    const v = spawnSync("claude", ["--version"], { encoding: "utf8" });
    rows.push({ ok: v.status === 0, what: "Claude Code on PATH", detail: v.status === 0 ? v.stdout.trim() : "claude not found (npm install -g @anthropic-ai/claude-code)" });
    const file = claudeConfigFile();
    let writable = false;
    try { fs.accessSync(file, fs.constants.W_OK); writable = true; } catch { /* missing or read-only */ }
    rows.push({ ok: writable, what: "Claude Code config writable (trust flag per run directory)", detail: writable ? file : `${file} missing or not writable; start Claude Code once, or set CLAUDE_CONFIG_DIR` });
    if (runDir && fs.existsSync(runDir)) rows.push({ ok: isTrusted(runDir), what: "Claude Code trusts the run directory", detail: isTrusted(runDir) ? path.resolve(runDir) : `projects["${path.resolve(runDir)}"].hasTrustDialogAccepted is not true in ${file}; aas resume sets it` });
    try { const b = await checkBudget(); rows.push({ ok: b.ok, what: `Claude plan budget for runs (AAS_BUDGET_WEEKLY_MAX ${b.max}%)`, detail: b.detail }); } catch (e) { rows.push({ ok: false, what: "Claude plan budget", detail: e.message }); }
    return rows;
  },
  /** The private session log of a run, for `aas publish`. */
  findSession(runDir) { return findClaudeSession(runDir); },
  /** Exports the private log into the public timeline and summary (schema 2; publish adds schema 3). */
  async exportSession(session, outDir, opts) { return exportClaudeSession(session, outDir, opts); },
  /** The harness ends the session (game over): interrupted like Ctrl-C, the same way as the budgets. */
  interrupt(reason) { interruptChild?.(reason); },
  version: "0.1.0",
  async configure(runDir, broker, brief) {
    const mcp = path.join(runDir, ".mcp.json");
    const settings = path.join(runDir, ".claude", "settings.json");
    const instructions = path.join(runDir, "CLAUDE.md");
    for (const f of [mcp, settings, instructions]) if (fs.existsSync(f)) throw new Error(`Refusing to overwrite ${f}`);
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.mkdirSync(path.join(runDir, "runtime-config"), { recursive: true });
    fs.writeFileSync(mcp, `${JSON.stringify(renderMcpConfig(broker), null, 2)}\n`, { flag: "wx" });
    fs.writeFileSync(settings, `${JSON.stringify(renderSettings(broker), null, 2)}\n`, { flag: "wx" });
    fs.writeFileSync(instructions, brief.instructions, { flag: "wx" });
    // Published copies: AGENTS.md is the spec's name for the instructions.
    fs.writeFileSync(path.join(runDir, "AGENTS.md"), brief.instructions, { flag: "wx" });
    fs.writeFileSync(path.join(runDir, "runtime-config", "mcp.template.json"), `${JSON.stringify(renderMcpConfig(broker, { placeholders: true }), null, 2)}\n`, { flag: "wx" });
    fs.writeFileSync(path.join(runDir, "runtime-config", "settings.json"), `${JSON.stringify(renderSettings(broker), null, 2)}\n`, { flag: "wx" });
    // A new directory is untrusted, and Claude Code then ignores the allow rules of its settings file (see trust.mjs).
    const trust = trustRunDir(runDir);
    return { files: [mcp, settings, instructions], trust, hint: `Run: aas start --runtime claude-code --run-dir ${runDir}` };
  },
  // Interactive by default (a terminal is needed). `brief.headless` (aas run
  // --headless) runs `claude -p` with the goal prompt and an optional
  // --max-turns budget, streaming progress to stderr; the private session
  // log is still written under ~/.claude/projects/<run dir>/.
  /** The published copy of the configuration, regenerated from the current rules; `aas publish` calls this. */
  async writePublicConfig(runDir, broker) {
    fs.mkdirSync(path.join(runDir, "runtime-config"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "runtime-config", "mcp.template.json"), `${JSON.stringify(renderMcpConfig(broker, { placeholders: true }), null, 2)}\n`);
    fs.writeFileSync(path.join(runDir, "runtime-config", "settings.json"), `${JSON.stringify(renderSettings(broker), null, 2)}\n`);
  },
  /** Rewrite .mcp.json and settings.json (absolute paths) when the run directory moved; instructions are kept. */
  async reconfigure(runDir, broker) {
    fs.mkdirSync(path.join(runDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(runDir, ".mcp.json"), `${JSON.stringify(renderMcpConfig(broker), null, 2)}\n`);
    fs.writeFileSync(path.join(runDir, ".claude", "settings.json"), `${JSON.stringify(renderSettings(broker), null, 2)}\n`);
    trustRunDir(runDir);
  },
  async start(runDir, brief) {
    if (!isTrusted(runDir)) {
      throw new Error(`Claude Code does not trust ${runDir}, so it would ignore the allow rules of .claude/settings.json and the run would not be valid. ` +
        `aas run/resume set this when they configure the directory; to set it by hand: projects["${path.resolve(runDir)}"].hasTrustDialogAccepted: true in ${claudeConfigFile()}.`);
    }
    // `--tools ""` removes every built-in tool (shell, web, files, subagents) from the session, so the agent has only
    // the broker's three; the deny rules in settings.json stay as a second line should a tool slip through.
    const args = ["--tools", "", "--mcp-config", ".mcp.json", "--strict-mcp-config", "--settings", path.join(".claude", "settings.json")];
    if (brief.model) args.push("--model", brief.model);
    // Effort level for the session (low, medium, high, xhigh, max). Passed only when the run asked for one;
    // the CLI writes it on every assistant record, so the published summary reports what was actually used.
    if (brief.reasoningEffort) args.push("--effort", String(brief.reasoningEffort));
    const headless = brief.headless === true || !process.stdin.isTTY;
    // Resuming: continue the same Claude Code session (its context and the
    // tool history survive), with a short harness notice as the next prompt.
    const prompt = brief.resume ? brief.resume.prompt : brief.goalPrompt;
    if (brief.resume?.sessionId) args.push("--resume", brief.resume.sessionId);
    if (headless) {
      if (!prompt) throw new Error("Headless runs need a goal prompt (aas configure --prompt, or goalPrompt in the game plugin).");
      args.push("-p", prompt, "--output-format", "stream-json", "--verbose");
      if (brief.budget?.toolCalls) args.push("--max-turns", String(brief.budget.toolCalls));
    } else if (prompt) args.push(prompt); // initial prompt; the session stays interactive
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k]; // allow starting from inside a Claude Code session
    const child = spawn("claude", args, { cwd: runDir, env, stdio: headless ? ["ignore", "pipe", "pipe"] : "inherit" });
    let last = null;
    let turns = 0;
    // Claude Code's stderr passes through, and is read: the line with which it reports permission rules it did
    // not apply ends the session at once, because a run played with other rules than the published ones is
    // not a valid run. With the trust flag set above this line cannot appear; this is the check that it did not.
    let ignoredRules = null;
    if (headless) {
      let errBuf = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => {
        process.stderr.write(d);
        errBuf = (errBuf + d).slice(-4000);
        const m = errBuf.match(IGNORED_RULES);
        if (m && !ignoredRules) {
          ignoredRules = m[0];
          process.stderr.write(`[runtime-claude-code] Claude Code ignored permission rules (${ignoredRules}); interrupting the session, this run is not valid\n`);
          child.kill("SIGINT");
          setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 60000).unref();
        }
      });
    }
    // Wall-clock budget (brief.budget.minutes, aas run --max-minutes): the session is
    // interrupted like Ctrl-C; it stays resumable and the harness saves the game after it.
    const minutes = Number(brief.budget?.minutes) || 0;
    let timedOut = false;
    // Weekly plan budget (AAS_BUDGET_WEEKLY_MAX): polled every 3 minutes; crossing it interrupts
    // the session the same way, so the rest of the week stays available for other work.
    let budgetHit = null;
    let gameOver = null;
    interruptChild = (reason) => {
      if (gameOver || child.exitCode !== null) return;
      gameOver = reason;
      process.stderr.write(`[runtime-claude-code] ${reason}; interrupting the session\n`);
      child.kill("SIGINT");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 60000).unref();
    };
    const budgetPoll = headless && !brief.ignoreBudget ? setInterval(async () => {
      try {
        const b = await checkBudget();
        if (!b.ok && !budgetHit) {
          budgetHit = b.detail;
          process.stderr.write(`[runtime-claude-code] weekly budget reached (${b.detail}); interrupting the session\n`);
          child.kill("SIGINT");
          setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 60000).unref();
        }
      } catch (e) {
        process.stderr.write(`[runtime-claude-code] budget check failed: ${e.message}\n`);
      }
    }, 180000) : null;
    const deadline = minutes ? setTimeout(() => {
      timedOut = true;
      process.stderr.write(`[runtime-claude-code] time budget of ${minutes} min reached; interrupting the session\n`);
      child.kill("SIGINT");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 60000).unref();
    }, minutes * 60000) : null;
    if (headless) {
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        buf += d;
        let at;
        while ((at = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, at);
          buf = buf.slice(at + 1);
          if (!line.trim()) continue;
          try {
            const m = JSON.parse(line);
            if (m.type === "assistant") {
              turns += 1;
              for (const part of m.message?.content ?? []) {
                if (part.type === "text" && part.text?.trim()) process.stderr.write(`[agent] ${part.text.trim().split("\n")[0].slice(0, 160)}\n`);
                if (part.type === "tool_use") process.stderr.write(`[agent] → ${part.name}${part.input?.code ? ": " + String(part.input.code).replace(/\s+/g, " ").slice(0, 120) : ""}\n`);
              }
            } else if (m.type === "result") last = m;
          } catch {
            // not JSON
          }
        }
      });
    }
    const code = await new Promise((res, rej) => {
      child.on("error", (e) => rej(new Error(`Could not start claude: ${e.message}. Install Claude Code first.`)));
      child.on("close", res);
    });
    if (deadline) clearTimeout(deadline);
    if (budgetPoll) clearInterval(budgetPoll);
    interruptChild = null;
    if (last) fs.writeFileSync(path.join(runDir, "claude-result.json"), `${JSON.stringify(last, null, 2)}\n`);
    const notesBase = headless ? `claude -p exited with ${code}; ${turns} assistant turns; cost $${last?.total_cost_usd?.toFixed(2) ?? "?"}; ${last?.subtype ?? ""}` : `claude exited with ${code}`;
    // A turn or time budget that ran out, or Claude's usage/session limit, is a stop, not a
    // failure: the session and the game state survive, so the run can be resumed later.
    const resultText = typeof last?.result === "string" ? last.result : "";
    const limitHit = last?.is_error === true && /limit|rate|overloaded|429|quota/i.test(resultText);
    const stopped = timedOut || Boolean(budgetHit) || Boolean(gameOver) || last?.subtype === "error_max_turns" || limitHit;
    const status = ignoredRules ? "failed" : code === 0 && !stopped ? "completed" : stopped ? "stopped" : "failed";
    const notes = `${notesBase}${ignoredRules ? `; Claude Code ignored permission rules: ${ignoredRules}` : ""}${timedOut ? `; time budget of ${minutes} min reached` : ""}${budgetHit ? `; weekly budget ${weeklyMax()}% reached` : ""}${gameOver ? `; ${gameOver}` : ""}${limitHit ? `; ${resultText.split("\n")[0].slice(0, 120)}` : ""}`;
    return { status, endedAt: new Date().toISOString(), notes, sessionId: last?.session_id ?? null, privateLog: null };
  },
};
