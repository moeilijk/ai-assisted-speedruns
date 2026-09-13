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

export interface GamePlugin {
  /** `^[a-z][a-z0-9_]*$`; becomes the tool-name prefix. */
  id: string;
  name?: string;
  version?: string;
  capabilities: GameCapabilities;
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
   * end, the goal when none is given). The harness declares the victory when the goal's milestone goes by.
   */
  ends?: { id: string; label: string; split?: string; final?: boolean }[];
  /** Default first prompt for the agent (the goal); `aas configure --prompt` overrides it. */
  goalPrompt?: string;
  /** Optional extra checks for `aas check-connection --exercise`. */
  exercise?: { label: string; code: string; verify?: (value: unknown) => void }[];
  /** Files or directories published as `game-config/` (cvars, patches, upstream references). */
  gameConfig?: string[];
  /** Connect to the game and return the controller. Called lazily, once per broker process. */
  connect(): Promise<Controller>;
  /** Game events for the recorder and the log (optional; requires an out-of-broker harness process). */
  events?(): AsyncIterable<RunEvent>;
  /** `aas run`: start the game side (new game, in-game recording, pause) after the recorder started; resolves when the game is ready for the agent. */
  prepareRun?(ctx: { runDir: string; log?: (text: string) => void; seed?: string | null; goal?: string | null; resume?: boolean; save?: string }): Promise<{ readyAt: Date } | void>;
  /** `aas run`: copy the game's save under this name (autosave every ten minutes, at chapter milestones, at the end). */
  saveState?(ctx: { name: string }): Promise<unknown>;
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
}

export interface RunOutcome {
  status: "completed" | "stopped" | "failed";
  completedAt?: string;
  endedAt: string;
  /** Path to the runtime's private log (e.g. a Codex rollout), if any. */
  privateLog?: string;
  notes?: string;
}

/** A plan's stand, from the runtime that runs on it. */
export interface BudgetVerdict { ok: boolean; percent: number | null; max: number; detail: string; data?: Record<string, unknown> }
/** One row of `aas doctor`. */
export interface DoctorRow { ok: boolean; what: string; detail?: string }

export interface RuntimePlugin {
  id: string;
  version?: string;
  /** Write the hardened configuration into the run directory. Must refuse to overwrite. */
  configure(runDir: string, broker: BrokerSpec, brief: RunBrief): Promise<void>;
  /** Rewrite the configuration after the run directory moved (a resume). */
  reconfigure?(runDir: string, broker: BrokerSpec, brief: RunBrief): Promise<void>;
  /** The published copy of the configuration (paths and the game's variables as placeholders); `aas publish` calls it. */
  writePublicConfig?(runDir: string, broker: BrokerSpec): Promise<void>;
  /** Start the agent and wait until it stops. */
  start(runDir: string, brief: RunBrief): Promise<RunOutcome>;
  /** The harness asks the session to end (game over, a budget). */
  interrupt?(reason: string): void;
  /** The plan's stand: `aas run`/`resume` refuse to start when `ok` is false; `aas budget` and `aas doctor` show it. */
  budget?(): Promise<BudgetVerdict>;
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
  version?: string;
  /** Process name of the program, for the close step's measurement. */
  processName?: string;
  /** Read-only checks for `aas doctor`. */
  doctor?(ctx: { runDir?: string | null }): Promise<DoctorRow[]>;
  /** Close the program the way a user would; the end of a run calls it. */
  close?(): Promise<string | void>;
  preflight?(brief: RunBrief, game: GamePlugin): Promise<void>;
  start(brief: RunBrief): Promise<void>;
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
  /** Throw to abort the run before it starts. */
  preflight(brief: RunBrief, game: GamePlugin): Promise<void>;
  start(brief: RunBrief): Promise<{ t0: Date }>;
  onEvent(event: RunEvent): Promise<void>;
  screenshot?(): Promise<Image>;
  stop(): Promise<RecordingResult>;
}
