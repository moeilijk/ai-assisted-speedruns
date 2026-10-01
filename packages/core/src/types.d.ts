// Plugin contracts for ai-assisted-speedruns. Plain JavaScript implements
// these; the file exists for editors, documentation and (later) checks.

// --- Common ----------------------------------------------------------------

export interface Endpoint {
  host: string;
  port: number;
}

/** An image as a data URL, or as mime type plus base64 payload. */
export type Image = string | { mimeType: string; data: string };

export interface RunBrief {
  /** Run id, also used in file names. */
  id: string;
  /** Instructions / system prompt given to the agent, published verbatim as AGENTS.md. */
  instructions: string;
  /** The first prompt (the goal) the runtime gives the agent when it starts. */
  goalPrompt?: string;
  category: Category;
  /** Model identifier as reported by the runtime, e.g. "claude-fable-5-1". */
  model?: string;
  reasoningEffort?: string;
  budget?: { toolCalls?: number; wallClockSeconds?: number; tokens?: number };
  /** Run the agent non-interactively (claude -p / codex exec) with the goal prompt. */
  headless?: boolean;
}

export interface Category {
  game: string;
  build: string;
  goal: string;
  observation: "vision" | "state" | "full";
  input: "input" | "api";
  timing: "paused-think" | "realtime";
  human: "none" | "restart-only" | "assisted";
  humanNotes?: string | null;
}

// --- Events ----------------------------------------------------------------

export type RunEventName =
  | "game.playback"
  | "run.started"
  | "run.ended"
  | "run.wait"
  | "run.error"
  | "run.human"
  | "game.phase"
  | "game.turn"
  | "game.milestone"
  | "game.highlight"
  | "recording.started"
  | "recording.chapter"
  | "recording.highlight_saved"
  | (string & {});

export interface RunEvent {
  /** ISO 8601 with UTC offset. */
  timestamp: string;
  kind: "event";
  event: RunEventName;
  data?: Record<string, unknown>;
  source?: string;
}

export type GamePhase = "menu" | "hub" | "mission" | "cinematic" | "loading" | (string & {});

// --- Game plugin -----------------------------------------------------------

export interface GameCapabilities {
  turnBased: boolean;
  canPause: boolean;
  stateAccess: "none" | "read" | "full";
  inputRoute: "input" | "api";
  igt: boolean;
}

/**
 * The object in scope as `game` inside `<id>_exec`. Its API is game-specific
 * and documented by `GamePlugin.documentation`; the members below are the
 * minimum the standard requires.
 */
export interface Controller {
  /** Compact structured observation; for `vision` games at least pose. */
  observe(fields?: string[]): Promise<unknown>;
  /**
   * Full-resolution screenshot. May return `{ screenshots: [{ url }] }`
   * (portal-agent shape), a data URL, `{ mimeType, data }`, or a Buffer.
   */
  screenshot(options?: { fullRes?: boolean }): Promise<unknown>;
  /** Release the connection to the game. */
  close?(): void;
}

/** A game's set-up for `aas gui`. Scripts are Node modules run with the repository's .env loaded. */
export interface GameSetup {
  /** Folder name under the output location: runs go to `<output>/<folder>/<run>/`. */
  folder: string;
  /** Machine settings the game needs, written to .env. `expect` names a file the folder must contain; `find` says where
   *  the GUI looks for it first (a Steam app id, an Epic display name, a GOG game id). */
  settings: {
    env: string;
    label: string;
    /** The plain answer to "which folder?" (or file), shown in the empty box and under the heading. */
    what?: string;
    kind: "dir" | "file" | "select";
    expect?: string;
    find?: { steam?: number; epic?: string; gog?: string };
    /** `kind: "select"`: the choices (a list, or a function that makes it) and the default. */
    options?: { value: string; label: string }[] | (() => { value: string; label: string }[]);
    value?: string;
  }[];
  /** The recorders this game fits, in the order the GUI offers them (the GUI adds `null`, no recording, last). */
  recorders?: string[];
  /** Per check id, a script of the plugin's own that puts that step of the set-up right, with the label its button carries. */
  fixes?: Record<string, { script: string; label: string }>;
  /** Installs what the plugin adds to the game (mods, config); may be run again. */
  install?: string;
  /** Starts the game and whatever bridge it needs; leaves a game that is already up alone. */
  launch: string;
  /** Closes what the harness started for this game. */
  stop?: string;
  /** LiveSplit splits file per end id. */
  splits?: Record<string, string>;
  /** A bot module for the `scripted` runtime (a mock run). */
  bot?: string;
  /** The game's launcher starts Steam (windows/steam.mjs): the Setup tab then lists the Steam setting. */
  steam?: boolean;
  /** Only for a game whose run has a seed: the GUI then asks for one, with this placeholder. */
  seed?: { placeholder?: string };
  /** The variable the launcher reads for the display to play on ("X,Y"), and for the window size ("WxH"). */
  displayEnv?: string;
  resolutionEnv?: string;
}

export interface GamePlugin {
  /** `^[a-z][a-z0-9_]*$`; becomes the tool-name prefix. */
  id: string;
  name?: string;
  version?: string;
  capabilities: GameCapabilities;
  /** Variable names whose values the run keeps (`brief.gameEnv`): `aas resume` and `aas publish` apply them again. */
  runEnv?: string[];
  /** The plugin saves at its own milestones (in the broker, right after the playback) and writes `game.saved` itself. */
  savesAtMilestones?: boolean;
  /** Process name for the recorder (window match, application audio capture). */
  processName?: string;
  /** The only network destinations the broker may reach. */
  endpoints: Endpoint[];
  /** Names of the environment variables the controller reads inside the broker; only these are passed through (never a password or a path the harness uses). */
  env?: string[];
  /** Complete API reference of the controller, returned by `<id>_documentation`. */
  documentation: string | (() => string | Promise<string>);
  /**
   * Second name under which the controller is in scope inside `<id>_exec`,
   * next to `game` (portal-agent: `portal`). Same charset as `id`.
   */
  scopeName?: string;
  /** Optional override of the `<id>_exec` tool description. */
  execDescription?: string;
  /** Directories the broker process must be able to read besides core (e.g. a vendored controller). */
  readable?: string[];
  /** Default agent instructions for a run (published as AGENTS.md / CLAUDE.md). */
  instructions?: string | (() => string | Promise<string>);
  /** Default category values; `game` is always the plugin id (`goal` comes from `ends`). */
  category?: Partial<Category>;
  /**
   * The game's ends, in order: the milestone `split` (or `data.end` = id) that marks each, one `final` (the game's own
   * end, the goal when none is given). The harness declares the victory when the goal's milestone goes by. Required:
   * every game declares at least its own end, so goals, their labels and their history work the same for every game.
   */
  ends: { id: string; label: string; split?: string; final?: boolean }[];
  /** A planned plugin that is not implemented: it loads and declares its ends, and `aas configure` refuses it. */
  stub?: boolean;
  /** What `aas gui` needs to set the game up and start it. A game without it does not appear in the GUI. */
  setup?: GameSetup;
  /** Default first prompt for the agent (the goal), or a function of the run's end that gives it; `aas configure --prompt` overrides it. */
  goalPrompt?: string | ((end: { id: string; label: string; final?: boolean }) => string);
  /** Optional extra checks for `aas check-connection --exercise`. */
  exercise?: { label: string; code: string; verify?: (value: unknown) => void }[];
  /** Files or directories published as `game-config/` (cvars, patches, upstream references). */
  gameConfig?: string[];
  /** Connect to the game and return the controller. Called lazily, once per broker process. */
  connect(): Promise<Controller>;
  /** Game events for the recorder and the log (optional; requires an out-of-broker harness process). */
  events?(): AsyncIterable<RunEvent>;
  /** `aas run`: start the game side (new game, in-game recording, pause) after the recorder started; resolves when the game is ready for the agent. */
  /** `reached`: milestones (with `end`) of ends the game already shows when it is ready; the goal among them starts no agent session. */
  prepareRun?(ctx: { runDir: string; log?: (text: string) => void; seed?: string | null; goal?: string | null; resume?: boolean; save?: string }): Promise<{ readyAt: Date; reached?: Array<Record<string, unknown>> } | void>;
  /** `aas run`: copy the game's save under this name (autosave every ten minutes, at chapter milestones, at the end). */
  saveState?(ctx: { name: string; log?: (text: string) => void }): Promise<{ name?: string; file?: string | null } | unknown>;
  /** `aas resume`: restore the game to that save; `seed` when a new game has to be started instead. */
  loadState?(ctx: { name: string; log?: (text: string) => void; runDir?: string | null; seed?: string | null }): Promise<unknown>;
  /** End of a run: close the game the way a user would and undo what the launcher set up. */
  close?(ctx: { log?: (text: string) => void }): Promise<string | void>;
  /** Read-only checks for `aas doctor` (game files, launcher settings). */
  doctor?(ctx: { runDir?: string | null }): Promise<DoctorRow[]>;
  /** `aas run`: end the game side (stop in-game recording) after the agent stopped, before the recorder stops. */
  endRun?(ctx: { runDir: string }): Promise<void>;
}

// --- Runtime plugin --------------------------------------------------------

export interface BrokerSpec {
  /** Absolute path to packages/core/src/broker.mjs. */
  brokerPath: string;
  /** Absolute path to the game plugin module. */
  gameModule: string;
  gameId: string;
  allowedEndpoints: Endpoint[];
  /** Directories the broker process may read (core, game plugin). */
  readable: string[];
  /** The variable names of `GamePlugin.env`: what the broker's environment carries besides the harness's own variables. */
  envNames?: string[];
  runDir: string;
  timeZone?: string;
  /** The `node --permission ...` command line that starts the broker. */
  nodeArgs?: string[];
  /** The broker's environment: the harness's variables plus the ones `envNames` names. */
  env?: Record<string, string>;
}

export interface RunOutcome {
  status: "completed" | "stopped" | "failed";
  completedAt?: string;
  endedAt: string;
  /** Path to the runtime's private log (e.g. a Codex rollout), if any. */
  privateLog?: string;
  /** The runtime's own session id, for a resume. */
  sessionId?: string;
  notes?: string;
}

/** A plan's stand, from the runtime that runs on it. */
export interface BudgetVerdict { ok: boolean; percent: number | null; max: number; detail: string; data?: Record<string, unknown> }
/** One row of `aas doctor`. */
/**
 * One row of `aas doctor`. `fix` names the plugin's own action that puts it right (`setup.fixes`); `level: "missing"`
 * says the thing is not installed, which is not a fault (a timer or an AI one does not use); `when: "run"` marks a
 * condition only a running program establishes (an endpoint, a server), so the Setup tab lists it without judging it.
 */
export interface DoctorRow { ok: boolean; what: string; detail?: string; fix?: string; level?: "missing" | "warn"; when?: "run" }

/** A machine setting a plugin needs, as the GUI's Setup tab shows and saves it (in `.env`). */
export interface PluginSetting {
  env: string;
  label: string;
  /** The plain answer to "which folder?" (or file), shown in the empty box and under the heading. */
  what?: string;
  kind: "dir" | "file" | "select" | "text";
  expect?: string;
  find?: { steam?: number; epic?: string; gog?: string };
  /** The folder or file the plugin uses when the setting is empty. */
  default?: () => string | null;
  options?: { value: string; label: string }[] | (() => { value: string; label: string }[]);
  value?: string;
}

/**
 * A button of the Setup tab that one of the plugin's checks names (`DoctorRow.fix`): a script of the plugin's own
 * (run with node) or a program of the machine (`command`), with the label the button carries. `args` gives the
 * script its arguments; `sets` the settings the GUI saves once it succeeded (an install that put a program somewhere).
 */
export interface PluginAction {
  label: string;
  script?: string;
  command?: string[];
  args?: () => string[];
  sets?: () => Record<string, string>;
}

/** What `aas gui` needs from a runtime, recorder or timer: its settings and its buttons. Its checks are its `doctor()`. */
export interface ToolSetup {
  /** The group of the Setup tab it is listed in ("Agents", "Windows tools"). */
  group?: string;
  settings?: PluginSetting[];
  fixes?: Record<string, PluginAction>;
}

/** What an AI's CLI offers (`aas options`): its models, each with the efforts it takes when the CLI says so per model. */
export interface RuntimeOptions {
  /** Where the list came from ("claude --help", "codex debug models"). */
  source: string;
  models: { id: string; label?: string; efforts?: string[]; defaultEffort?: string | null }[];
  /** The efforts the CLI names (all models together). */
  efforts: string[];
  /** When a model outside the list is accepted too: the sentence that says so ("or a model's full name"). */
  freeModel?: string | null;
}

export interface RuntimePlugin {
  id: string;
  /** The name people know the runtime by ("Claude Code"); required, a bundle carries it next to the id. */
  name: string;
  version?: string;
  /** Whether a model plays through this runtime. A bundle carries it with the plugin's sha256; a runtime without it makes mocks. */
  ai?: boolean;
  /** The agent's own command: the GUI offers the runtime when it is on the PATH. None for a runtime that needs no program (scripted). */
  cli?: string;
  /** Its settings and buttons in `aas gui` (an install or an update of its CLI). */
  setup?: ToolSetup;
  /** `aas check-agent`: does the agent's CLI reach the broker (no model call). */
  connectCheck?(runDir: string, ctx: { gameId: string }): Promise<unknown>;
  /** Write the hardened configuration into the run directory. Must refuse to overwrite. */
  configure(runDir: string, broker: BrokerSpec, brief: RunBrief): Promise<void>;
  /** Rewrite the configuration after the run directory moved (a resume). */
  reconfigure?(runDir: string, broker: BrokerSpec, brief: RunBrief): Promise<void>;
  /** The published copy of the configuration (paths and the game's variables as placeholders); `aas publish` calls it. */
  writePublicConfig?(runDir: string, broker: BrokerSpec): Promise<void>;
  /** Start the agent and wait until it stops. `checkpoint()` after every step lets a goal or a stop reached by that step end the session. */
  start(runDir: string, brief: RunBrief, ctx?: { checkpoint?: () => Promise<void> }): Promise<RunOutcome>;
  /** The harness asks the session to end (game over, a budget). */
  interrupt?(reason: string): void;
  /** The plan's stand: `aas run`/`resume` refuse to start when `ok` is false; `aas budget` and `aas doctor` show it. */
  /** Does the agent's own CLI reach the broker (`claude mcp list`, `codex mcp list`)? No model call, so no tokens; `aas check-agent`. */
  connectCheck?(runDir: string, ctx: { gameId: string }): Promise<{ ok: boolean; detail: string }>;
  budget?(): Promise<BudgetVerdict>;
  /** The models and efforts the agent's own CLI names today (`aas options`, the GUI's Model and Effort). Read from the CLI, never kept in the plugin. */
  options?(): Promise<RuntimeOptions>;
  /** Read-only checks for `aas doctor`. */
  doctor?(ctx: { runDir?: string | null }): Promise<DoctorRow[]>;
  /** The private session log of a run (when the runtime keeps it outside the run directory). */
  findSession?(runDir: string): string | null;
  /** Export the private log into `session.sanitized.jsonl` and `summary.json` (schema 2) in `outDir`. */
  exportSession?(session: string, outDir: string, opts: { completionMarker?: string | null; completionTime?: string | null }): Promise<unknown>;
}

// --- Inside the broker ------------------------------------------------------

/**
 * `globalThis.aas` inside the broker process. Controllers call `event()` to
 * put game events into run.jsonl on the same clock as the tool calls;
 * `game.playback` (phase start with the plan's steps, phase end with ticks)
 * is what `aas timeline` and the timer plugin work from.
 */
export interface BrokerGlobals {
  emitImage(dataUrl: string): void;
  event(name: RunEventName, data?: Record<string, unknown>): void;
  write(text: string): void;
}

// --- Timer plugin ----------------------------------------------------------

/** Speedrun timer (LiveSplit, ...): reacts to the same events as the recorder. */
export interface TimerPlugin {
  id: string;
  /** The name people know the program by; the GUI's Timing choice. */
  name?: string;
  version?: string;
  /** The script that starts the program; the GUI makes it a step of its own and passes the game's splits file for the goal. */
  launch?: string;
  /** Its settings and buttons in `aas gui`; the timer is offered once its first setting is set. */
  setup?: ToolSetup;
  /** Process name of the program, for the close step's measurement. */
  processName?: string;
  /** Read-only checks for `aas doctor`. */
  doctor?(ctx: { runDir?: string | null }): Promise<DoctorRow[]>;
  /** Close the program the way a user would; the end of a run calls it. */
  close?(): Promise<string | void>;
  preflight?(brief: RunBrief, game: GamePlugin): Promise<void>;
  /** `igt`: the game time a resumed run continues from. */
  start(brief: RunBrief, ctx?: { igt?: number }): Promise<void>;
  onEvent(event: RunEvent): Promise<void>;
  stop(): Promise<{ igt?: number; times?: unknown }>;
}

// --- Recorder plugin -------------------------------------------------------

export interface Chapter {
  /** Seconds since t0. */
  at: number;
  label: string;
}

export interface RecordingResult {
  files: string[];
  t0: Date;
  chapters: Chapter[];
}

export interface RecorderPlugin {
  id: string;
  version?: string;
  processName?: string;
  doctor?(ctx: { runDir?: string | null }): Promise<DoctorRow[]>;
  /** Close the program the way a user would; the end of a run calls it. */
  close?(): Promise<string | void>;
  /** The name people know the program by, and the script that starts it (the GUI's launch step). */
  name?: string;
  launch?: string;
  /** Its settings and buttons in `aas gui`. */
  setup?: ToolSetup;
  /** Throw to abort the run before it starts. */
  preflight(brief: RunBrief, game: GamePlugin): Promise<void>;
  /** `runDir` for the recording folder; `overlayUrl` when the run has an overlay page. */
  start(brief: RunBrief, ctx?: { runDir?: string; overlayUrl?: string | null }): Promise<{ t0: Date }>;
  onEvent(event: RunEvent): Promise<void>;
  screenshot?(): Promise<Image>;
  stop(): Promise<RecordingResult>;
}
