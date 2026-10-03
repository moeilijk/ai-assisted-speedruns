// Claude Code runtime plugin: writes .mcp.json (only the broker), a project
// settings file that denies every non-broker tool, and CLAUDE.md with the run
// instructions, then starts `claude` in the run directory with strict MCP config.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicPath } from "../core/src/public-path.mjs";
import { checkBudget, weeklyMax } from "./budget.mjs";
import { IGNORED_RULES, claudeConfigFile, isTrusted, trustRunDir } from "./trust.mjs";
import { exportClaudeSession, claudeProjectDir } from "../core/src/export-claude-session.mjs";
import { execFile, spawnSync } from "node:child_process";

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

/**
 * What Claude Code reported about each model at the end of its invocations (the result record's modelUsage): the
 * context window, the maximum output and, from 2.1.270 on, the provider. Every invocation's result is kept in
 * claude-results.jsonl; a run from before that kept only the last one, in claude-result.json.
 * @returns {Map<string, {context_window: number|null, max_output_tokens: number|null, provider: string|null}[]>}
 */
export function claudeModelReports(runDir) {
  const all = path.join(runDir, "claude-results.jsonl");
  const last = path.join(runDir, "claude-result.json");
  const results = fs.existsSync(all)
    ? fs.readFileSync(all, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : fs.existsSync(last) ? [JSON.parse(fs.readFileSync(last, "utf8"))] : [];
  const reports = new Map();
  for (const r of results) {
    for (const [model, u] of Object.entries(r.modelUsage ?? {})) {
      const report = { context_window: Number.isInteger(u?.contextWindow) ? u.contextWindow : null, max_output_tokens: Number.isInteger(u?.maxOutputTokens) ? u.maxOutputTokens : null, provider: typeof u?.provider === "string" ? u.provider : null };
      const list = reports.get(model) ?? [];
      if (!list.some((x) => JSON.stringify(x) === JSON.stringify(report))) list.push(report);
      reports.set(model, list);
    }
  }
  return reports;
}

/**
 * What the CLI itself offers, read from `claude --help`: the effort levels in the `--effort` line and the model
 * aliases in the `--model` paragraph (the help names a few as examples; the client takes any full model id too).
 */
export function parseClaudeHelp(text) {
  const efforts = (text.match(/--effort <level>[^\n]*\n?[^(]*\(([^)]+)\)/)?.[1] ?? "").split(",").map((x) => x.trim()).filter((x) => /^[a-z]+$/.test(x));
  const paragraph = text.match(/--model <model>([\s\S]*?)\n\s+-/)?.[1] ?? "";
  const quoted = [...paragraph.matchAll(/'([A-Za-z0-9][A-Za-z0-9._-]*)'/g)].map((m) => m[1]);
  const aliases = quoted.filter((x) => !/\d/.test(x));
  const example = quoted.find((x) => /\d/.test(x)) ?? null;
  return { efforts, aliases, example };
}

/** Claude Code's own folder ($CLAUDE_CONFIG_DIR, else ~/.claude): its caches live there. */
const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
const versionParts = (v) => String(v ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/)?.slice(1).map((n) => Number(n ?? 0)) ?? null;
const atLeast = (v, min) => { const a = versionParts(v), b = versionParts(min); if (!a || !b) return true; for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); return true; };

/**
 * The model menu of Claude Code, as the client keeps it: `<claude dir>/cache/model-catalog/*.json` is the catalog
 * the client fetched from Anthropic for this account (what `/model` shows: every model with its name, the efforts it
 * takes, and the Claude Code version it needs), with the model in use. Read as the client wrote it; the newest file
 * counts. Null when the client has not fetched one yet on this machine.
 */
export function readClaudeCatalog({ env = process.env, installed = null } = {}) {
  const dir = path.join(claudeDir(env), "cache", "model-catalog");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)); } catch { return null; }
  const read = files.map((f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }).filter((j) => j?.catalog?.config?.models);
  const j = read.sort((a, b) => (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0))[0];
  if (!j) return null;
  const models = j.catalog.config.models.filter((m) => typeof m.id === "string").map((m) => {
    const options = m.thinking?.type === "effort" ? (m.thinking.effort_options ?? []) : [];
    const needs = m.min_claude_code_version && installed && !atLeast(installed, m.min_claude_code_version) ? m.min_claude_code_version : null;
    return {
      id: m.id,
      label: m.name ? `${m.id} (${m.name}${needs ? `, needs Claude Code ${needs}` : ""})` : m.id,
      efforts: options.map((o) => o.id).filter((e) => typeof e === "string"),
      // The effort the client uses for this model: the person's own choice for it, else the one the menu recommends.
      defaultEffort: (j.catalog.state?.thinking_by_model ?? []).find((t) => t.id === m.id)?.thinking?.effort ?? options.find((o) => o.badge)?.id ?? null,
      // A model whose thinking is not an effort setting (Haiku 4.5) takes no --effort at all.
      thinking: m.thinking?.type === "effort" ? "effort" : "none",
      section: m.section ?? null,
      ...(needs ? { needs } : {}),
    };
  });
  // The model in use is the account's setting; the client cannot run one that needs a newer version than installed,
  // and which it takes instead is its own choice, so that setting is reported as unusable rather than as the default.
  const setting = j.catalog.state?.model ?? null;
  const needs = setting ? models.find((m) => m.id === setting)?.needs ?? null : null;
  return { models, defaultModel: setting && !needs ? setting : null, defaultNote: needs ? `its setting ${setting} needs Claude Code ${needs}, so the client chooses` : null, fetchedAt: j.fetchedAt ? new Date(j.fetchedAt).toISOString() : null, stale: typeof j.staleAt === "number" && j.staleAt < Date.now() };
}

/**
 * The client's own answer to one of its commands, asked in print mode: `/model` and `/effort` are answered by the
 * client itself (measured 2026-09-29 with 2.1.284: no turn, no tokens, cost 0). An answer that did reach a model is
 * not used, so asking can never cost anything.
 */
export function askClaude(command, { bin = "claude", model = null } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, [...(model ? ["--model", model] : []), "-p", command, "--output-format", "json", "--tools", "", "--no-session-persistence"], { encoding: "utf8", timeout: 60000, cwd: os.tmpdir() }, (_e, stdout, stderr) => {
      let j = null;
      try { j = JSON.parse(stdout); } catch { /* not an answer */ }
      if (!j || typeof j.result !== "string") return reject(new Error(`claude -p ${command} did not answer${stderr?.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`));
      if ((j.num_turns ?? 0) !== 0 || (j.total_cost_usd ?? 0) !== 0) return reject(new Error(`claude answered ${command} through the model (${j.num_turns} turns), so its answer is not used`));
      resolve(j.result);
    });
  });
}

/** `/model`: the model the client would use now (with its effort) and the names it takes besides a full model id. */
export function parseModelUsage(text) {
  // "(effort: high)" follows only when an effort is set; `default` answers without one.
  const current = text.match(/Current model:\s*`([^`\n]+)`(?:\s*\(effort:\s*([a-z]+)\))?/) ?? text.match(/Current model:\s*([^\n(]+?)\s*(?:\(effort:\s*([a-z]+)\))?\s*$/m);
  const available = (text.match(/Available:\s*([^\n]*?)(?:,?\s*or a full model ID)/)?.[1] ?? "").split(",").map((x) => x.trim()).filter((x) => /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/.test(x));
  return { current: current ? { model: current[1].trim(), effort: current[2] ?? null } : null, aliases: available, fullId: /or a full model ID/.test(text) };
}

/** `/effort`: every level the client offers (`ultracode [on|off]` is the level ultracode). */
export function parseEffortUsage(text) {
  const inner = text.match(/\/effort\s*<(.+)>/)?.[1] ?? "";
  return inner.split("|").map((x) => x.trim().split(/\s+/)[0].replace(/[[\]]/g, "")).filter((x) => /^[a-z]+$/.test(x) && !["on", "off"].includes(x));
}

/**
 * `aas options`: the models and efforts as Claude Code on this machine offers them, asked of the client itself:
 * `/model` (the model it uses now and the names it takes), `/effort` (its levels), and its model menu on disk for the
 * exact ids with the efforts each one takes. `auto` is the client's own choice, which is what leaving Effort empty
 * does: the `--effort` flag ignores the word itself (measured: "Unknown --effort value 'auto'"). Nothing here names a
 * model or a level.
 */
export async function claudeOptions() {
  const v = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 20000 });
  if (v.status !== 0) throw new Error("claude --version did not answer (is Claude Code installed?)");
  const installed = versionParts(v.stdout)?.join(".") ?? null;
  let usage = null, levels = null;
  try { [usage, levels] = await Promise.all([askClaude("/model").then(parseModelUsage), askClaude("/effort").then(parseEffortUsage)]); } catch { /* an older client: its --help below */ }
  const help = (() => { const r = spawnSync("claude", ["--help"], { encoding: "utf8", timeout: 20000 }); return parseClaudeHelp(`${r.stdout}${r.stderr}`); })();
  const efforts = (levels?.length ? levels : help.efforts).filter((e) => e !== "auto");
  const extraLevels = efforts.filter((e) => !help.efforts.includes(e));
  const catalog = readClaudeCatalog({ installed });
  // A model of the menu takes the levels its entry lists, and the client's levels beyond those it lists for every model.
  const models = (catalog?.models ?? []).map((m) => (m.thinking === "effort" ? { ...m, efforts: [...m.efforts, ...extraLevels.filter((e) => !m.efforts.includes(e))] } : m));
  // The names the client takes (default, best, opus, …): each asked of the client itself, which model it points at now.
  const names = (usage?.aliases ?? help.aliases).filter((a) => !models.some((m) => m.id === a));
  const resolved = await Promise.all(names.map((n) => askClaude("/model", { model: n }).then((t) => parseModelUsage(t).current).catch(() => null)));
  // The menu entry of the model the client names: the one whose name its answer starts with ("Opus 5.5 (1M context)" is Opus 5.5).
  const menuEntry = (name) => (name ? models.filter((m) => m.section !== "name").find((m) => { const n = m.label?.match(/\(([^,)]+)/)?.[1]; return n && (name === n || name.startsWith(`${n} `)); }) ?? null : null);
  const inUse = menuEntry(usage?.current?.model);
  names.forEach((id, i) => {
    const to = resolved[i];
    const byName = to && menuEntry(to.model);
    models.push({ id, label: `${id}${to ? ` → ${to.model}${id === "default" ? ", the recommended model" : ""}` : ""}`, efforts: byName?.efforts ?? [], defaultEffort: to?.effort ?? byName?.defaultEffort ?? null, thinking: byName?.thinking ?? "effort", section: "name" });
  });
  return {
    source: `Claude Code ${installed} itself (/model, /effort${catalog ? `, its model menu fetched ${catalog.fetchedAt?.slice(0, 16).replace("T", " ")} UTC` : ""})`,
    models,
    // What a run gets without --model and --effort: the client as it is set on this machine. The model is the one its
    // /model names. The effort is the one /model adds when a setting applies; without one the client runs the model
    // at the effort its menu keeps for it (Claude Code's docs: a top-level effortLevel does not count for Opus 5.5 and
    // later, which start at their own default), so /model then names none and the menu says which.
    current: usage?.current?.model ?? null,
    currentEffort: usage?.current?.effort ?? inUse?.defaultEffort ?? null,
    freeModel: usage?.fullId === false ? null : "or a full model id",
    efforts,
  };
}

/** The installed client and the newest Claude Code version its own menu asks for (a model it cannot run yet). */
export function claudeVersionNeed() {
  const v = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 20000 });
  const installed = v.status === 0 ? versionParts(v.stdout)?.join(".") ?? null : null;
  const needs = (readClaudeCatalog({ installed })?.models ?? []).filter((m) => m.needs);
  return { installed, needs: needs.map((m) => ({ id: m.id, version: m.needs })) };
}

export default {
  id: "claude-code",
  /** a model plays. */
  ai: true,
  name: "Claude Code",
  /** Its CLI: `aas gui` offers the runtime when this is on the PATH. */
  cli: "claude",
  /** The Setup tab's button: Claude Code's own updater, for the version its checks and its model menu ask for. */
  setup: { group: "Agents", fixes: { update: { label: "Update Claude Code", command: ["claude", "update"] } } },
  /** The models and efforts the CLI names (`aas options`); the GUI offers these and takes a full name too. */
  async options() { return claudeOptions(); },
  /** The Claude plan's stand: runs stay under AAS_BUDGET_WEEKLY_MAX percent of the week. */
  async budget() { const b = await checkBudget(); return { ok: b.ok, percent: b.percent, max: b.max, detail: b.detail, data: { five_hour_percent: b.usage.fiveHour.percent } }; },
  /** Read-only checks for `aas doctor`: claude on the PATH, its config file writable, the run directory trusted (a resume). */
  async doctor({ runDir = null } = {}) {
    const rows = [];
    const v = spawnSync("claude", ["--version"], { encoding: "utf8" });
    rows.push({ ok: v.status === 0, what: "Claude Code on PATH", detail: v.status === 0 ? v.stdout.trim() : "claude not found (npm install -g @anthropic-ai/claude-code)", level: "missing" });
    if (v.status !== 0) return rows;
    rows.push({ ok: atLeast(v.stdout, "2.1.207"), what: "Claude Code 2.1.207 or newer", detail: v.stdout.trim(), fix: "update" });
    // Its own model menu may list models this version cannot run yet: those cannot be chosen for a run.
    const need = claudeVersionNeed();
    const top = need.needs.map((n) => n.version).sort((a, b) => (atLeast(a, b) ? -1 : 1))[0];
    rows.push({ ok: !top, what: "it can run every model its own menu lists", detail: top ? `${need.needs.map((n) => n.id).join(", ")} need${need.needs.length === 1 ? "s" : ""} Claude Code ${top}; this is ${need.installed}` : need.installed ?? "", fix: "update", level: "warn" });
    const file = claudeConfigFile();
    let writable = false;
    try { fs.accessSync(file, fs.constants.W_OK); writable = true; } catch { /* missing or read-only */ }
    rows.push({ ok: writable, what: "Claude Code config writable (trust flag per run directory)", detail: writable ? file : `${file} missing or not writable; start Claude Code once, or set CLAUDE_CONFIG_DIR` });
    if (runDir && fs.existsSync(runDir)) rows.push({ ok: isTrusted(runDir), what: "Claude Code trusts the run directory", detail: isTrusted(runDir) ? path.resolve(runDir) : `projects["${path.resolve(runDir)}"].hasTrustDialogAccepted is not true in ${file}; aas resume sets it` });
    // The plan's stand decides whether a run may start now, not whether the machine is set up.
    try { const b = await checkBudget(); rows.push({ ok: b.ok, what: `Claude plan budget for runs (AAS_BUDGET_WEEKLY_MAX ${b.max}%)`, detail: b.detail, when: "run" }); } catch (e) { rows.push({ ok: false, what: "Claude plan budget", detail: e.message, when: "run" }); }
    return rows;
  },
  /**
   * Does the agent's own CLI reach the broker? `claude mcp list` starts the run's MCP server and health-checks it
   * without asking the model anything, so it costs no tokens: it proves the configuration, the trust flag and the
   * broker work together before a run is played for real.
   */
  async connectCheck(runDir, { gameId } = {}) {
    if (!isTrusted(runDir)) return { ok: false, detail: `Claude Code does not trust ${path.resolve(runDir)} yet (aas configure sets it).` };
    const r = spawnSync("claude", ["mcp", "list"], { cwd: path.resolve(runDir), encoding: "utf8", timeout: 120000 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const line = out.split("\n").find((l) => l.startsWith(`${gameId}:`)) ?? "";
    if (/✔|Connected/.test(line)) return { ok: true, detail: `claude mcp list: ${gameId} connected` };
    return { ok: false, detail: line ? `claude mcp list: ${line.trim().slice(-120)}` : `claude mcp list did not report the ${gameId} server${out.trim() ? `: ${out.trim().split("\n").at(-1)}` : ""}` };
  },
  /** The private session log of a run, for `aas publish`. */
  findSession(runDir) { return findClaudeSession(runDir); },
  /** Every session log Claude Code wrote for this run directory, oldest first: what the run's proof covers. */
  sessionLogs(runDir) {
    const dir = claudeProjectDir(runDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(a).birthtimeMs - fs.statSync(b).birthtimeMs || (a < b ? -1 : 1));
  },
  modelReports(runDir) { return claudeModelReports(runDir); },
  /** Exports the private log into the public timeline and summary (schema 2; publish adds schema 3). */
  async exportSession(session, outDir, opts) { return exportClaudeSession(session, outDir, opts); },
  /** The harness ends the session (game over): interrupted like Ctrl-C, the same way as the budgets. */
  interrupt(reason) { interruptChild?.(reason); },
  version: "0.35.0",
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
  async start(runDir, brief, { stopRequested = null } = {}) {
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
    if (brief.reasoningEffort) {
      // The client ignores an effort it does not know and plays on with its default (measured: "Unknown --effort
      // value … ignoring it"), so a run would not be what it asked for: such an effort is refused here, before the start.
      let offered = null;
      try { offered = await claudeOptions(); } catch { /* no answer: the client's own warning stands */ }
      const known = offered?.models.find((m) => m.id === brief.model && m.section !== "name");
      const allowed = known ? known.efforts : offered?.efforts;
      if (allowed && !allowed.includes(String(brief.reasoningEffort))) throw new Error(`effort ${brief.reasoningEffort} is not one ${known ? brief.model : "Claude Code"} takes: ${allowed.join(", ") || "none (this model takes no effort setting)"} (claude /effort and its model menu)`);
      args.push("--effort", String(brief.reasoningEffort));
    }
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
      // Interactive, a SIGINT only cancels the turn the person sees: the session ends with SIGTERM soon after.
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, headless ? 60000 : 5000).unref();
    };
    // A stop that came before this session existed (the harness asks; 2026-10-02: it was lost and a whole session ran).
    { const early = stopRequested?.(); if (early) interruptChild(early); }
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
    if (last) {
      fs.writeFileSync(path.join(runDir, "claude-result.json"), `${JSON.stringify(last, null, 2)}\n`);
      fs.appendFileSync(path.join(runDir, "claude-results.jsonl"), `${JSON.stringify(last)}\n`);
    }
    const notesBase = headless ? `claude -p exited with ${code}; ${turns} assistant turns; cost $${last?.total_cost_usd?.toFixed(2) ?? "?"}; ${last?.subtype ?? ""}` : `claude exited with ${code}`;
    // A turn or time budget that ran out, or Claude's usage/session limit, is a stop, not a
    // failure: the session and the game state survive, so the run can be resumed later.
    const resultText = typeof last?.result === "string" ? last.result : "";
    const limitHit = last?.is_error === true && /limit|rate|overloaded|429|quota/i.test(resultText);
    const stopped = timedOut || Boolean(budgetHit) || Boolean(gameOver) || last?.subtype === "error_max_turns" || limitHit;
    const status = ignoredRules ? "failed" : code === 0 && !stopped ? "completed" : stopped ? "stopped" : "failed";
    const notes = `${notesBase}${ignoredRules ? `; Claude Code ignored permission rules: ${ignoredRules}` : ""}${timedOut ? `; time budget of ${minutes} min reached` : ""}${budgetHit ? `; weekly budget ${weeklyMax()}% reached` : ""}${gameOver ? `; ${gameOver}` : ""}${limitHit ? `; ${resultText.split("\n")[0].slice(0, 120)}` : ""}`;
    return { status, endedAt: new Date().toISOString(), notes, sessionId: last?.session_id ?? null, privateLog: null, turns };
  },
};
