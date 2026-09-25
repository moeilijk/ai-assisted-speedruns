// `aas configure`: build the run directory for a runtime plugin. Lives in
// its own module so that run.mjs and cli.mjs can both import it (cli.mjs
// has a top-level await; a module importing cli.mjs from a dynamic import
// inside it would deadlock).
import { checkEffort, checkModel, checkName, checkProofMode, checkSeed } from "./validate.mjs";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { resolveGoal } from "./goal.mjs";
import path from "node:path";
import { CORE_DIR, brokerEnv, brokerNodeArgs, loadGamePlugin } from "./mcp-client.mjs";
import { loadRuntime } from "./plugins.mjs";

/** BrokerSpec (types.d.ts) plus the exact node args and env a runtime writes into its config. */
export async function brokerSpec({ gameModule, runDir, timeZone }) {
  const plugin = await loadGamePlugin(gameModule);
  const readable = plugin.readable ?? [];
  return {
    plugin,
    gameId: plugin.id,
    gameModule: path.resolve(gameModule),
    brokerPath: path.join(CORE_DIR, "src", "broker.mjs"),
    allowedEndpoints: plugin.endpoints ?? [],
    readable: [CORE_DIR, path.dirname(path.resolve(gameModule)), ...readable],
    runDir: path.resolve(runDir),
    timeZone,
    nodeArgs: brokerNodeArgs({ gameModule, readable, runDir }),
    env: brokerEnv({ gameModule, runDir, endpoints: plugin.endpoints ?? [], timeZone, passThrough: plugin.env ?? [] }),
    envNames: plugin.env ?? [],
  };
}

export async function configure(opts) {
  for (const k of ["runtime", "game", "run-dir"]) if (!opts[k]) throw new Error(`--${k} is required`);
  // What goes into the brief goes on into command lines, file names and a game's console: checked here, once.
  checkModel(opts.model); checkEffort(opts.effort); checkSeed(opts.seed); checkProofMode(opts.proof);
  checkName("the run's id (--id, or the run directory's name)", opts.id ?? path.basename(path.resolve(opts["run-dir"])));
  const runDir = path.resolve(opts["run-dir"]);
  const runtime = await loadRuntime(opts.runtime);
  const spec = await brokerSpec({ gameModule: opts.game, runDir, timeZone: process.env.AAS_TIME_ZONE });
  const plugin = spec.plugin;
  if (plugin.stub) throw new Error(`${plugin.id} is a stub game plugin: nothing is implemented yet, so no run can be configured with it.`);
  const instructions = opts.instructions
    ? fs.readFileSync(opts.instructions, "utf8")
    : typeof plugin.instructions === "function"
      ? await plugin.instructions()
      : plugin.instructions;
  if (!instructions) throw new Error("No instructions: the game plugin has none; pass --instructions <file>.");
  const category = { game: plugin.id, build: "", goal: "", observation: "vision", input: "input", timing: "paused-think", human: "none", ...(plugin.category ?? {}) };
  // The goal: one of the game's ends, checked against the plugin's list. Without one it follows who plays: the
  // game's own end for a model, its first end for a run no model plays, which is a test and not an attempt.
  const goal = resolveGoal(plugin, opts.goal, { ai: runtime.ai });
  category.goal = goal.id;
  if (opts.build) category.build = opts.build;
  // The first prompt names the run's own goal: a plugin may give it per end.
  const goalPrompt = opts.prompt ?? (typeof plugin.goalPrompt === "function" ? plugin.goalPrompt(goal.end) : plugin.goalPrompt) ?? null;
  const brief = { id: opts.id ?? path.basename(runDir), run_uid: randomBytes(16).toString("hex"), instructions, goalPrompt, category, model: opts.model, reasoningEffort: opts.effort ?? null, runtime: runtime.id, runtimeVersion: runtime.version, runtimeModule: /\.m?js$/.test(opts.runtime) ? path.resolve(opts.runtime) : null, game: { id: plugin.id, version: plugin.version }, gameModule: spec.gameModule, gameEnv: Object.fromEntries((plugin.runEnv ?? []).filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) };
  if (opts.headless) brief.headless = true;
  // The seed, for games that have one: configuration of the run, handed to the plugin's prepareRun.
  if (opts.seed) brief.seed = String(opts.seed);
  // Scripted runtime: the bot module is part of the run's set-up; the "model" is the bot.
  if (opts.bot ?? process.env.AAS_BOT) brief.bot = path.resolve(opts.bot ?? process.env.AAS_BOT);
  if (!brief.model && runtime.id === "scripted") brief.model = `scripted:${path.basename(brief.bot ?? "bot")}`;
  if (plugin.cutDefaults) brief.cut = { ...plugin.cutDefaults };
  if (opts["max-turns"] || opts["max-minutes"]) brief.budget = { ...(opts["max-turns"] ? { toolCalls: Number(opts["max-turns"]) } : {}), ...(opts["max-minutes"] ? { minutes: Number(opts["max-minutes"]) } : {}) };
  fs.mkdirSync(runDir, { recursive: true });
  const briefFile = path.join(runDir, "brief.json");
  if (fs.existsSync(briefFile)) throw new Error(`Refusing to overwrite ${briefFile}`);
  const result = await runtime.configure(runDir, spec, brief);
  fs.writeFileSync(briefFile, `${JSON.stringify(brief, null, 2)}\n`, { flag: "wx" });
  return { runDir, brief, ...result };
}

