// Codex runtime plugin: writes a hardened .codex/config.toml plus AGENTS.md
// into the run directory (refusing to overwrite), then starts `codex` there.
// Derived from cozyblaze's portal-agent, tools/configure-run.mjs
// (MIT, Copyright (c) 2026 cozyblaze; license text in packages/core/vendor/portal-agent/LICENSE; see packages/core/NOTICE).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { publicPath } from "../core/src/public-path.mjs";
import { checkCodexBudget, codexMax, codexVerdict, readCodexUsage, rolloutFiles } from "./budget.mjs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The template is derived from cozyblaze's portal-agent: its license text is published next to it in runtime-config/. */
const PORTAL_AGENT_LICENSE = path.join(here, "..", "core", "vendor", "portal-agent", "LICENSE");
let interruptChild = null;

/** Codex's user config file: $CODEX_HOME/config.toml, else ~/.codex/config.toml. */
export function codexConfigFile(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(env.HOME ?? "", ".codex"), "config.toml");
}
/**
 * Codex loads a project's .codex/config.toml (the run's hardened configuration: only the broker as MCP server,
 * no shell, no web) only for a project it trusts, and trust is an exact entry for that directory in its user
 * config: `[projects."<dir>"] trust_level = "trusted"`., measured: with `codex doctor` (0.154.0): a
 * wildcard entry for "/" or a git repository in the directory does not count; the exact entry does. Every run
 * directory is new, so configure writes the entry; nothing else in the file is touched.
 */
export function trustRunDir(runDir, { file = codexConfigFile() } = {}) {
  const dir = path.resolve(runDir);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const header = `[projects."${dir}"]`;
  const i = text.indexOf(header);
  if (i >= 0) {
    const rest = text.slice(i + header.length).split(/^\[/m)[0];
    if (/^\s*trust_level\s*=\s*"trusted"/m.test(rest)) return { file, dir, changed: false };
    throw new Error(`${file} already has an entry for ${dir} without trust_level = "trusted"; not touching it`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${text.length && !text.endsWith("\n") ? "\n" : ""}\n${header}\ntrust_level = "trusted"\n`);
  return { file, dir, changed: true };
}
export function isTrusted(runDir, { file = codexConfigFile() } = {}) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  const header = `[projects."${path.resolve(runDir)}"]`;
  const i = text.indexOf(header);
  return i >= 0 && /^\s*trust_level\s*=\s*"trusted"/m.test(text.slice(i + header.length).split(/^\[/m)[0]);
}

/** The rollout file of a thread: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<...>-<thread id>.jsonl, written during the session. */
export function findRollout(threadId, since = 0, home = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex")) {
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return null;
  const hits = [];
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.includes(threadId) && e.name.endsWith(".jsonl") && fs.statSync(p).mtimeMs >= since - 60000) hits.push(p);
    }
  };
  walk(root, 0);
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

const tomlPath = (p) => {
  const v = p.replaceAll("\\", "/");
  if (/[\r\n']/.test(v)) throw new Error("Choose a path without quotes or newlines.");
  return v;
};

export function renderConfig(broker, { placeholders = false } = {}) {
  const template = fs.readFileSync(path.join(here, "config.template.toml"), "utf8");
  const pub = (v) => (placeholders ? publicPath(tomlPath(String(v)), broker) : v);
  const runDir = pub(broker.runDir);
  const nodeArgs = broker.nodeArgs.map(pub);
  const HARNESS_ENV = new Set(["AAS_GAME_MODULE", "AAS_RUN_DIR", "AAS_ALLOWED_ENDPOINTS", "AAS_TIME_ZONE"]);
  // Published: the plugin's variables as __ENV__ (their values come from the reader's own .env), the harness's with path placeholders.
  const env = Object.entries(broker.env).map(([k, v]) => `${k} = "${placeholders && !HARNESS_ENV.has(k) ? "__ENV__" : pub(v)}"`);
  return template
    .replaceAll("__GAME_ID__", broker.gameId)
    .replaceAll("__RUN_DIR__", runDir)
    .replace("__BROKER_ARGS__", nodeArgs.map((a) => `  '${tomlPath(a)}',`).join("\n"))
    .replace("__BROKER_ENV__", env.join("\n"));
}

export default {
  id: "codex",
  /** a model plays. */
  ai: true,
  name: "Codex",
  version: "0.32.1",
  /** The ChatGPT plan's stand as Codex last recorded it: runs stay under AAS_CODEX_BUDGET_MAX percent of the window. */
  /** Every rollout Codex wrote with this run directory as its working directory, oldest first: what the proof covers. */
  sessionLogs(runDir) {
    const want = path.resolve(runDir);
    return rolloutFiles().filter((f) => {
      try { const fd = fs.openSync(f, "r"); const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); const first = buf.subarray(0, n).toString("utf8").split("\n")[0]; return path.resolve(JSON.parse(first)?.payload?.cwd ?? "") === want; } catch { return false; }
    }).reverse();
  },
  async budget() { const b = checkCodexBudget(); return { ok: b.ok, percent: b.percent, max: b.max, detail: b.detail, data: { window_minutes: b.usage.windowMinutes, plan_type: b.usage.planType } }; },
  /** Read-only checks for `aas doctor`: codex on the PATH, the run directory trusted (a resume), the plan's stand. */
  async doctor({ runDir = null } = {}) {
    const rows = [];
    const v = spawnSync("codex", ["--version"], { encoding: "utf8" });
    rows.push({ ok: v.status === 0, what: "Codex on PATH", detail: v.status === 0 ? v.stdout.trim() : "codex not found (npm install -g @openai/codex)" });
    if (runDir && fs.existsSync(runDir)) rows.push({ ok: isTrusted(runDir), what: "Codex trusts the run directory", detail: isTrusted(runDir) ? path.resolve(runDir) : `no [projects."${path.resolve(runDir)}"] trust_level = "trusted" in ${codexConfigFile()}; aas resume sets it` });
    const c = checkCodexBudget();
    rows.push({ ok: c.ok, what: `Codex plan budget for runs (AAS_CODEX_BUDGET_MAX ${c.max}%)`, detail: c.detail });
    return rows;
  },
  /**
   * Does the agent's own CLI reach the broker? `codex mcp list` reads the run's configuration and lists its MCP
   * servers without asking the model anything, so it costs no tokens.
   */
  async connectCheck(runDir, { gameId } = {}) {
    const r = spawnSync("codex", ["mcp", "list"], { cwd: path.resolve(runDir), encoding: "utf8", timeout: 120000, env: { ...process.env, CODEX_HOME: path.join(path.resolve(runDir), ".codex") } });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (new RegExp(`\\b${gameId}\\b`).test(out)) return { ok: true, detail: `codex mcp list: ${gameId} configured` };
    return { ok: false, detail: `codex mcp list did not name the ${gameId} server${out.trim() ? `: ${out.trim().split("\n").at(-1)}` : ""}` };
  },
  /** Exports a rollout into the public timeline and summary (schema 2). */
  async exportSession(session, outDir, { completionMarker } = {}) {
    const r = spawnSync(process.execPath, [path.join(here, "export-rollout.mjs"), session, outDir], { env: { ...process.env, AAS_COMPLETION_MARKER: completionMarker ?? process.env.AAS_COMPLETION_MARKER ?? "" }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Codex export failed: ${r.stderr}`);
  },
  async configure(runDir, broker, brief) {
    const config = path.join(runDir, ".codex", "config.toml");
    const instructions = path.join(runDir, "AGENTS.md");
    for (const f of [config, instructions]) if (fs.existsSync(f)) throw new Error(`Refusing to overwrite ${f}`);
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, renderConfig(broker), { flag: "wx" });
    fs.writeFileSync(instructions, brief.instructions, { flag: "wx" });
    fs.mkdirSync(path.join(runDir, "runtime-config"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "runtime-config", "config.template.toml"), renderConfig(broker, { placeholders: true }), { flag: "wx" });
    fs.copyFileSync(PORTAL_AGENT_LICENSE, path.join(runDir, "runtime-config", "LICENSE"));
    const trust = trustRunDir(runDir);
    return { files: [config, instructions], trust, hint: `Open ${runDir} as a project in Codex, trust it, and start a new task; or run: aas start --runtime codex --run-dir ${runDir}` };
  },
  /** The published copy of the configuration, regenerated from the current rules; `aas publish` calls this. */
  async writePublicConfig(runDir, broker) {
    fs.mkdirSync(path.join(runDir, "runtime-config"), { recursive: true });
    fs.writeFileSync(path.join(runDir, "runtime-config", "config.template.toml"), renderConfig(broker, { placeholders: true }));
    fs.copyFileSync(PORTAL_AGENT_LICENSE, path.join(runDir, "runtime-config", "LICENSE"));
  },
  /** Rewrite the configuration (absolute paths) when the run directory moved; the instructions are kept. */
  async reconfigure(runDir, broker) {
    fs.mkdirSync(path.join(runDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(runDir, ".codex", "config.toml"), renderConfig(broker));
    trustRunDir(runDir);
  },
  interrupt(reason) { interruptChild?.(reason); },
  /**
   * Interactive by default (the Codex TUI in the run directory). Headless (`brief.headless`, aas run --headless):
   * `codex exec --json` with the goal prompt (or `codex exec resume <thread>` at a resume), the events streamed to
   * stderr as progress, the thread's rollout file located under $CODEX_HOME/sessions for `aas publish`.
   */
  async start(runDir, brief) {
    if (!isTrusted(runDir)) throw new Error(`Codex does not trust ${runDir}, so it would not load the run's .codex/config.toml (the broker, no shell, no web). aas run/resume set this when they configure the directory; by hand: [projects."${path.resolve(runDir)}"] trust_level = "trusted" in ${codexConfigFile()}.`);
    const headless = brief.headless === true || !process.stdin.isTTY;
    const model = brief.model ? ["--model", brief.model] : [];
    if (!headless) {
      const args = [...model];
      if (brief.goalPrompt) args.push(brief.goalPrompt);
      const child = spawn("codex", args, { cwd: runDir, stdio: "inherit" });
      const code = await new Promise((res, rej) => {
        child.on("error", (e) => rej(new Error(`Could not start codex: ${e.message}. Install the Codex CLI (npm install -g @openai/codex) or open ${runDir} in the Codex app.`)));
        child.on("close", res);
      });
      return { status: code === 0 ? "completed" : "failed", endedAt: new Date().toISOString(), notes: `codex exited with ${code}` };
    }
    const prompt = brief.resume ? brief.resume.prompt : brief.goalPrompt;
    if (!prompt) throw new Error("Headless runs need a goal prompt (aas configure --prompt, or goalPrompt in the game plugin).");
    const args = ["exec", ...(brief.resume?.sessionId ? ["resume", brief.resume.sessionId] : []), "--json", "--skip-git-repo-check", "--cd", runDir, "--sandbox", "read-only", ...model];
    if (brief.reasoningEffort) args.push("-c", `model_reasoning_effort="${brief.reasoningEffort}"`);
    args.push("-o", path.join(runDir, "codex-last-message.txt"), prompt);
    const env = { ...process.env };
    const startedAt = Date.now();
    const child = spawn("codex", args, { cwd: runDir, env, stdio: ["ignore", "pipe", "inherit"] });
    let threadId = null, turns = 0, usage = null, lastError = null, gameOver = null, timedOut = false;
    interruptChild = (reason) => { gameOver = reason; process.stderr.write(`[runtime-codex] ${reason}; interrupting the session\n`); child.kill("SIGINT"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 60000).unref(); };
    const minutes = Number(brief.budget?.minutes) || 0;
    const deadline = minutes ? setTimeout(() => { timedOut = true; process.stderr.write(`[runtime-codex] time budget of ${minutes} min reached; interrupting the session\n`); child.kill("SIGINT"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 60000).unref(); }, minutes * 60000) : null;
    // The plan's stand, as Codex writes it into this thread's rollout after every turn: over the limit, the session is
    // interrupted (resumable), like the Claude runtime does with its usage endpoint.
    let budgetHit = null;
    const budgetPoll = !brief.ignoreBudget ? setInterval(() => {
      try {
        const file = threadId ? findRollout(threadId, startedAt) : null;
        if (!file) return;
        const b = codexVerdict(readCodexUsage({ files: [file] }));
        if (!b.ok && !budgetHit) { budgetHit = b.detail; process.stderr.write(`[runtime-codex] Codex plan budget reached (${b.detail}); interrupting the session\n`); child.kill("SIGINT"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 60000).unref(); }
      } catch (e) { process.stderr.write(`[runtime-codex] budget check failed: ${e.message}\n`); }
    }, 180000) : null;
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let at;
      while ((at = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "thread.started" && m.thread_id) threadId = m.thread_id;
        if (m.type === "item.completed" && m.item) {
          const it = m.item;
          if (it.type === "agent_message") { turns += 1; process.stderr.write(`[agent] ${String(it.text ?? "").trim().split("\n")[0].slice(0, 160)}\n`); }
          if (it.type === "mcp_tool_call") process.stderr.write(`[agent] → ${it.server}/${it.tool}${it.arguments?.code ? ": " + String(it.arguments.code).replace(/\s+/g, " ").slice(0, 120) : ""}\n`);
          if (it.type === "command_execution") process.stderr.write(`[agent] → shell: ${String(it.command ?? "").slice(0, 120)}\n`);
        }
        if (m.type === "turn.completed" && m.usage) usage = m.usage;
        if (m.type === "error" || m.type === "turn.failed") lastError = m.message ?? m.error?.message ?? line.slice(0, 200);
      }
    });
    const code = await new Promise((res, rej) => {
      child.on("error", (e) => rej(new Error(`Could not start codex: ${e.message}. Install the Codex CLI (npm install -g @openai/codex).`)));
      child.on("close", res);
    });
    if (deadline) clearTimeout(deadline);
    if (budgetPoll) clearInterval(budgetPoll);
    interruptChild = null;
    const privateLog = threadId ? findRollout(threadId, startedAt) : null;
    const notesBase = `codex exec exited with ${code}; ${turns} agent messages${usage ? `; tokens in ${usage.input_tokens ?? "?"} out ${usage.output_tokens ?? "?"}` : ""}${lastError ? `; ${lastError}` : ""}`;
    const stopped = timedOut || Boolean(gameOver) || Boolean(budgetHit);
    const status = code === 0 && !stopped ? "completed" : stopped ? "stopped" : "failed";
    const notes = `${notesBase}${timedOut ? `; time budget of ${minutes} min reached` : ""}${budgetHit ? `; Codex plan budget ${codexMax()}% reached` : ""}${gameOver ? `; ${gameOver}` : ""}`;
    return { status, endedAt: new Date().toISOString(), notes, sessionId: threadId, privateLog };
  },
};
