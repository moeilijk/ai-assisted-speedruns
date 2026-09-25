# Writing a plugin

Four kinds of plugins, one core. A plugin is a plain Node ES module whose default export is an object with the members below; the contracts are in [`packages/core/src/types.d.ts`](../packages/core/src/types.d.ts) and every existing plugin is an example. Plugins are loaded by id (`packages/<kind>-<id>/index.mjs`) or by module path (`--game games/<id>/plugin.mjs`, `--runtime path/to/index.mjs`), so a plugin can live outside this repository.

The core knows no game, no model and no recorder by name: every `aas` command works through the plugin contracts alone, and a plugin brings its own route, settings and checks for each command (`doctor()` rows for `aas doctor`, `budget()` for `aas budget` and the start of a run, `close()` for the end of a run, `findSession()`/`exportSession()` for `aas publish`). A game plugin never talks to the agent, a runtime plugin never talks to the game, and a recorder only reacts to events. Keep it that way: the published run must be explainable from three tool definitions, one instructions file and one timeline.

## Game plugin

The game plugin is two things: the **controller** the agent's code runs against inside `<id>_exec`, and the **game side** the harness drives (launch, prepare, save, close). Examples: [`games/slay-the-spire/plugin.mjs`](../games/slay-the-spire/plugin.mjs) (turn-based, `api` input through a mod), [`games/balatro/plugin.mjs`](../games/balatro/plugin.mjs) (turn-based, a mod that speaks JSON-RPC over HTTP, behind a bridge that refuses its debug methods), [`games/portal/plugin.mjs`](../games/portal/plugin.mjs) (real-time, `input` through a TAS tool).

```js
export default {
  id: "my_game",                 // ^[a-z][a-z0-9_]*$ ; the tools become my_game_documentation, my_game_screenshot, my_game_exec
  name: "My Game",
  version: "0.1.0",
  capabilities: { turnBased: true, canPause: true, stateAccess: "full", inputRoute: "api", igt: true },
  processName: "mygame.exe",     // the recorder captures this window and this process's audio
  endpoints: [{ host: "127.0.0.1", port: 27000 }],   // the only network destinations the broker may reach
  env: ["AAS_MY_GAME_HOST", "AAS_MY_GAME_PORT"],     // the variables the controller reads inside the broker; nothing else reaches it
  readable: [here],              // directories the broker process may read besides core
  segments: ["Level 1", "Level 2"],                  // the splits (chapter milestones), in order
  ends: [{ id: "level1", label: "Level 1", split: "Level 1" }, { id: "end", label: "The end", split: "Level 2", final: true }],   // required: the game's ends, each with a label, exactly one `final` (the default goal)
  stub: false,                   // true for a planned plugin that is not implemented: it loads, and `aas configure` refuses it
  setup: {                       // optional: what `aas gui` needs to offer the game (see below)
    folder: "MyGame",            // runs go to <output>/MyGame/<run>/
    settings: [{ env: "AAS_MY_GAME_ROOT", label: "My Game folder", kind: "dir", expect: "mygame.exe", find: { steam: 123450 } }],
    install: join(here, "install-mod.mjs"), launch: join(here, "launch-game.mjs"), stop: join(here, "stop-all.mjs"),
    splits: { end: join(here, "splits", "mygame.lss") }, bot: join(here, "bot.mjs"), displayEnv: "AAS_MY_GAME_WINDOW_POS",
    recorders: ["obs"],          // the recorders this game fits, in the order the GUI offers them (default: ["obs"])
    seed: { placeholder: "the game picks one" },   // only for a game whose run has a seed; without it the GUI does not ask
  },
  documentation: readFileSync(join(here, "documentation.md"), "utf8"),   // what <id>_documentation returns; complete
  instructions: readFileSync(join(here, "AGENTS.md"), "utf8"),           // default agent instructions, published verbatim
  goalPrompt: (end) => `Play the run that has been started for you until ${end.label}.`, // the first prompt: a string, or a function of the run's end
  scopeName: "mg",               // second name of the controller inside <id>_exec, next to `game`
  execDescription: "...",        // optional: the <id>_exec tool description
  category: { build: "...", goal: "any%", observation: "state", input: "api", timing: "paused-think", human: "none" },
  gameConfig: [join(here, "UPSTREAM.json")],         // published as game-config/
  exercise: [{ label: "state", code: "return await game.observe()", verify: (v) => { if (!v) throw new Error("no state"); } }],
  async connect() { /* ... */ return controller; },
  async prepareRun({ runDir, log, resume, save }) { /* new game; resolves when the agent may act */ return { readyAt: new Date(), seed }; },
  async saveState({ name }) { /* copy the game's save under this name */ return { file }; },
  async loadState({ name, log, runDir }) { /* restore it; the game paused or waiting */ },
  async endRun({ runDir }) { /* stop in-game recording, copy ground truth */ },
  async close({ log }) { /* close the game the way a user would; undo what the launcher set up */ return "closed"; },
};
```

**The controller** (what `connect()` returns) is the object in scope as `game` and as `scopeName`. Its API is yours, and `documentation` must describe all of it: the agent has nothing else. Two members are required by the standard: `observe()` (a compact structured state) and `screenshot()` (a full-resolution image: a data URL, `{ mimeType, data }`, or a Buffer). Every action must return only when the game is paused again or waiting for input.

**Events from inside the controller.** The controller runs inside the broker process; `globalThis.aas.event(name, data)` puts an event on the run log on the same clock as the tool calls. The one the timing model depends on is `game.playback`: emit `phase: "start"` with the steps about to be played before the game advances, and `phase: "end"` with what was played (`ticks` or `seconds`) after it settled. In the `paused-think` category game time advances only inside these intervals; `aas timeline` sums them into IGT and cuts everything between them out of the video, and the timer runs game time only then. Emit `game.milestone` with `chapter: true` and a `split` from `segments` at every section boundary, and `game.over` (`victory: true` or `false`, plus a `label`) when the attempt ends inside the game. **The goal is not the plugin's business:** declare the game's ends in `ends` (each with the `split` of the milestone that marks it, one `final`: the game's own end) and the harness declares the victory when the goal's milestone goes by; a shorter category (`--goal act1`) needs nothing in the plugin. After a death the controller may offer a restart and then emits `game.attempt` (`phase: "start"`, `attempt`, `seed`).

**Hardening.** The broker process runs under `node --permission` with reads limited to core plus `readable` and writes to the run directory, and `hardening.mjs` limits sockets to `endpoints`. Its environment holds the harness's own variables and the names in `env`, nothing else (a password or a machine path the harness uses never reaches the broker or the published configuration). A variable that decides what the run plays (BizHawk's `AAS_BIZHAWK_PROFILE`) is also named in `runEnv`: the run records its value in `brief.json`, and `aas publish` and `aas resume` set it again before they load the plugin, whatever the shell holds then. Design the game side so that this is enough: the controller connects to a local bridge or mod, nothing else. `fetch` is blocked; a bridge that speaks HTTP is reached with [`json-rpc-http.mjs`](../packages/core/src/json-rpc-http.mjs) (`node:http`, one call at a time, a deadline that covers connecting). When the upstream bridge also offers what the agent must not use (debug or cheat methods, starting and loading runs), declare a filtering bridge of your own as the endpoint instead, as Balatro does, so the broker cannot reach the upstream port at all.

**The game side.** `prepareRun` runs after the recorder started and before the agent starts (t0 is the recording start); it starts the new game and resolves when the agent may act, returning the seed when the game has one. `saveState`/`loadState` make `aas resume` possible: the harness calls `saveState` every ten minutes, at chapter milestones and at the end of the session, and `loadState` with the chosen save at a resume. The harness reads a milestone from the run log up to half a second after the plugin emitted it, and the agent's next move may reach the game first; a plugin that can save from inside the broker sets `savesAtMilestones: true`, saves right after the playback that reached a milestone (into `<run>/saves/`) and emits `game.saved` itself with `{ name, index, reason, file }`, and the harness then leaves those milestones to it (FCEUX). `endRun` runs after the agent stopped and before the recorder stops. `close` runs at the end of `aas run` and `aas resume` (and from the manual stop command) and closes the game the way a user would; nothing is killed, what does not close is reported. Launch is a script of your own (`launch-game.mjs`) wired as an npm script; the doctor checks the endpoints it leaves behind. On Windows, [`packages/core/src/windows/`](../packages/core/src/windows/) has what every launcher needs: `ensureSteam()`, `listDisplays()`/`displayAt()`, and `beforeGameStart()`/`afterGameClose()` for the per-machine options (quiet audio device, displays kept awake).

**The GUI.** A game with `setup` appears in `aas gui`. `settings` are the machine settings the game needs; `what` is the plain answer to "which folder?", shown in the empty box and under the heading in the Setup tab (a box that says only `folder` asks the question instead of answering it), and it names the file a person recognises the folder by; `find` names where the GUI looks for the folder first (a Steam app id, an Epic display name, a GOG game id); `expect` is a file the folder must contain; `default` is a function that returns the folder or file the plugin uses when the setting is empty (BizHawk and FCEUX install into `%LOCALAPPDATA%\aas\<emulator>` and find the profile's ROM in `.local/roms`); the Setup tab shows it in the empty box and checks it, and the game counts as set up when the first setting's default holds the `expect` file. `install`, `launch` and `stop` are the game's own scripts, run as they are, and `installs` is the one sentence the Setup tab's button carries, saying what `install` puts where ("Install" on its own can mean the game, the mod, the tooling or the harness; the command it runs is shown under the button); `splits` maps an end id to a LiveSplit file; `bot` makes a mock run possible with the `scripted` runtime; `displayEnv` (and `resolutionEnv`) is the variable the launcher reads for the display to play on, set from the GUI's display choice.

**Ground truth.** Keep the game's own records (save files, run history, demo files) in the run directory under a folder that is never published, and provide a way to read them next to the harness's timeline (Slay the Spire: `save-track.mjs`, Portal: `demo-track.mjs`). That is what the splits are checked against.

**Test.** A plugin test drives the real broker and the real controller against a fake of the game side (`games/*/test/fake-*.mjs`): the handshake, the three tools, a milestone, the victory. `aas check-connection --exercise` does the same against the real game.

## Runtime plugin

A runtime writes the agent's hardened configuration into the run directory and starts the agent. Examples: [`packages/runtime-claude-code`](../packages/runtime-claude-code/index.mjs) (Claude Code: `.mcp.json`, `.claude/settings.json`, `CLAUDE.md`, workspace trust), [`packages/runtime-codex`](../packages/runtime-codex/index.mjs) (Codex: `.codex/config.toml`, `AGENTS.md`), [`packages/runtime-scripted`](../packages/runtime-scripted/index.mjs) (a bot module instead of a model, through the same broker), and the test stub [`packages/core/test/stub-runtime.mjs`](../packages/core/test/stub-runtime.mjs).

```js
export default {
  id: "my-runtime",
  name: "My Runtime",            // required: the name people know it by; a bundle carries it next to the id
  version: "0.1.0",
  ai: true,                      // required: does a model play through this runtime? `scripted` says false, and a
                                 // run of a runtime that does not say true is a mock: not an entry (SPEC §3).
                                 // The bundle also carries the plugin's own sha256, so an archive reads which
                                 // runtime this was instead of believing the flag.
  async configure(runDir, broker, brief) { /* write the config; refuse to overwrite; return { files, hint } */ },
  async reconfigure(runDir, broker, brief) { /* rewrite machine paths after a move (resume) */ },
  async start(runDir, brief) { /* start the agent, wait; return { status, endedAt, notes, sessionId, privateLog } */ },
  interrupt(reason) { /* the harness asks the session to end (game over, budget) */ },
  async budget() { /* the plan's stand: { ok, percent, max, detail }; aas run refuses when ok is false */ },
  async connectCheck(runDir, { gameId }) { /* does the agent's CLI reach the broker, without asking the model? aas check-agent */ },
  async doctor({ runDir }) { /* [{ ok, what, detail }]: the CLI on the PATH, trust of the run directory, the plan */ },
  findSession(runDir) { /* the private log when it lives outside the run directory */ },
  async exportSession(session, outDir, { completionMarker, completionTime }) { /* session.sanitized.jsonl + summary.json (schema 2) */ },
  async writePublicConfig(runDir, broker) { /* runtime-config/ with placeholders; publish calls it */ },
};
```

`broker` (`BrokerSpec`) tells the runtime how to start the broker: `nodeArgs` (the `node --permission ...` command line), `env`, `gameId`, `runDir`. The configuration must give the agent exactly the three tools `mcp__<game>__<game>_documentation|screenshot|exec` (or the runtime's equivalent naming) and deny everything else: shell, web, file reads and writes outside the run directory, sub-agents. Write a second copy of the configuration with machine paths replaced (`publicPath`) into `runtime-config/`; that copy is published.

`start` returns a `RunOutcome`: `completed` (the agent finished), `stopped` (a budget, a limit, or an interrupt; resumable), `failed`. In headless mode (`brief.headless`, with `brief.budget.toolCalls` and `brief.budget.minutes`) the runtime runs the agent non-interactively with `brief.goalPrompt`, or with `brief.resume.prompt` and `brief.resume.sessionId` at a resume. The runtime's private log is what `aas publish` exports: say where it is (`privateLog`), or write it as `session.jsonl` in the run directory, and provide an exporter (`export-claude-session.mjs`, `runtime-codex/export-rollout.mjs` are the two so far) that turns it into the timeline format of the spec.

`ai` is the one thing about a runtime that an archive does not take on trust. It is a property of the runtime, not of a run — a runtime either drives a model or it does not — so the harness writes it into every bundle together with `sha256`, the plugin as it ran (`pluginDigest`: every `.mjs`, `.json` and `.md` of the package directory, `test/` left out). A runtime whose hash an archive cannot place is read as a mock.

`connectCheck` is the cheap half of that verification: it has the agent's own CLI list and health-check the MCP server of a configured run directory (`claude mcp list`, `codex mcp list`), which asks the model nothing and so costs no tokens. `aas check-agent` and the GUI's mock run use it.

Verify a runtime the way `smoke.mjs` does for Claude Code: a real headless session against the fake game, asking the agent to use the three tools and to try a shell command and a file read, and checking in the broker log that only the three tools were used and in the agent's reply that the rest was refused.

## Recorder plugin

A recorder records the run and reacts to events. Examples: [`packages/recorder-obs`](../packages/recorder-obs/index.mjs) (OBS through obs-websocket: the game window and its audio only, LiveSplit and the overlay page as sources, scenes per phase, chapter marks), [`packages/recorder-source-demo`](../packages/recorder-source-demo/index.mjs) (the in-game demo of a Source game), [`packages/recorder-null`](../packages/recorder-null/index.mjs) (nothing; never a valid run). A game plugin's `setup.recorders` says which of them fit it, and the GUI offers exactly those; the run is recorded with the one chosen.

```js
export default {
  id: "my-recorder",
  name: "My recorder (video)",  // how the GUI names it in the run's Recording choice
  version: "0.1.0",
  launch: join(here, "launch.mjs"),  // optional: a program to start before the run; the GUI makes it a step of its own
  async preflight(brief, game) { /* throw = the run does not start (no mic, not already recording, ...) */ },
  async start(brief, ctx) { /* start recording; return { t0 } */ },
  async onEvent(event) { /* scene, chapter, highlight, pause */ },
  async stop() { /* return { files, t0, chapters } */ },
  async doctor() { /* [{ ok, what, detail }]: the program reachable, authenticated, not already recording */ },
  async close() { /* close the program the way a user would; the end of a run calls it */ },
  processName: "obs64",   // for the close step's measurement of what is still running
};
```

t0 is the moment the recording really started (OBS: the `RecordStateChanged STARTED` event), not the moment `start` was called; every elapsed time in the published run is relative to it. `files` are the recording files as the harness can reach them (under WSL, Windows paths translated); `aas run` copies them into `<run>/recording/`. `ctx.overlayUrl` is the live overlay page (`aas run --overlay-port`) with timers and the agent's last action, for a browser source. The recording must show the game and nothing the harness made up: no title cards, no overlays that hide the game's own screens. The OBS recorder's hard rule, no microphone, belongs in `preflight`.

## Timer plugin

A timer shows the speedrun clock on screen (the recorder captures it) and keeps the splits. Example: [`packages/timer-livesplit`](../packages/timer-livesplit/index.mjs).

```js
export default {
  id: "my-timer",
  version: "0.1.0",
  async preflight(brief, game) {},
  async start(brief) { /* reset, start real time, pause game time */ },
  async onEvent(event) { /* game.playback start/end: game time runs/pauses; chapter milestone: split; game.attempt: reset */ },
  async stop() { /* return { igt, times } */ },
  async doctor() { /* [{ ok, what, detail }]: the timer's server reachable */ },
  async close() { /* close the program the way a user would */ },
  processName: "LiveSplit",
};
```

In the `paused-think` model real time runs from `run.started` to `run.ended` and game time only inside `game.playback`; a chapter milestone is a split; `game.over` with victory pauses the timer (the milestone before it did the final split); `game.attempt` resets for the next attempt. `aas publish` writes `splits.lss` from the timeline, so the splits are published even without the timer running.

## Registering

An in-repository plugin is a workspace in `package.json` (`packages/<kind>-<id>`) and, for a game, a folder under `games/` with its README, `plugin.mjs`, `documentation.md`, `AGENTS.md`, splits, launch and stop scripts, and a test. Add the game's commands to the `scripts` of `package.json` the way `sts:*` and `portal:*` are, and its settings to `.env.example`. Nothing else is needed: the CLI finds plugins by id or path.

## Checklist for a game plugin

Before a new game plugin goes into a pull request:

- Everything the setup downloads or builds is pinned in the plugin's `UPSTREAM.json`: version, commit or release, URL, sha256 and license. Each gets a row in the license table of the [README](../README.md#license).
- The plugin brings the original tooling as published, and only the settings the recording needs ([rules for every game](../README.md#rules-for-every-game)). Its README says what is added or changed in the game.
- `doctor()` has a row for each thing a run needs: the game, its tooling, the endpoint.
- The tests run against a stand-in for the game's endpoint, the way `games/*/test/fake-*.mjs` do, so `npm test` needs no game installed. The stand-in answers as the real program measured does, writes save files where the real one does, and listens on the port the test gives it.
- The game goes through the whole harness in a test: `chainThroughHarness` from `packages/core/test/chain.mjs` runs it with its scripted player through `aas run` to its first end, `aas resume` from its save to a later end (or, for a game with one end, a first segment that stops and a resume that reaches it), `aas publish` and `aas check`, and asserts what every game must do. `games/*/test/chain.test.mjs` are the examples, one per game.
- Every value that reaches the game from outside is checked where the plugin passes it on: a seed or a save name that goes into a console or a line protocol is a plain name (letters, digits, `_` and `-`), never a second command; an address the agent may reach (`endpoints`) comes from the same setting as the plugin's own client. A test gives each such value a hostile form (a newline, `;`, a quote, `--an-option`) and asserts the refusal with its reason, as `packages/core/test/hostile-input.test.mjs` does for the plugins in this repository.
- `documentation.md` and `AGENTS.md` tell the agent what it can do and what the goal is; the splits in `splits/` match the plugin's ends.
- Options that depend on the machine, such as a quiet audio device, a second display or a window position, are read from `.env`, are off by default, and are listed in `.env.example` and [docs/reference.md](reference.md).
- A mock replays a route from a published source (a TASVideos movie, a speedrun community's route) under a license that allows it, named in the plugin's README; the plugin's own code does not invent the route.
- The plugin's `version` is the release it goes into, and `packages/spec/plugins.json` is regenerated (`node packages/spec/make-plugins.mjs --write`).
- The README's Contents list and [docs/install.md](install.md) name the new game.
