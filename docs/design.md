# Design: one harness for every game

Source and inspiration: [cozyblaze/portal-agent](https://github.com/cozyblaze/portal-agent), commit `31311b8` of 2026-09-06 (controller MIT; file and field names below are quoted from that repository).

## Goal

A generic framework with plugins for three kinds of communication, plus a standard:

1. **Runtime** (the agent: Codex via MCP, Claude Code via MCP, later an in-process loop against the Messages API)
2. **Game** (the bridge into the game: SourcePauseTool for Portal, Communication Mod for Slay the Spire, kRPC for Kerbal Space Program, ...)
3. **Recorder** (OBS via obs-websocket, in-game demo, none)

The **standard** ([packages/spec/SPEC.md](../packages/spec/SPEC.md)) says what an "AI Assisted Speedrun" is, how it is recorded and logged, and how someone else can check and compare it. Every plugin combination produces the same run directory, the same log format, the same timeline and the same publication export. Portal-agent's published `evidence/` is used as a format fixture.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Repository name | `ai-assisted-speedruns`, CLI and package `aas` | uses the term itself; spec and reference implementation fit in one repo for now |
| Language | Node.js, plain ESM JavaScript with `.d.ts` type contracts, no build step, no dependencies in core | broker, hardening, configure-run and export from portal-agent are reusable almost verbatim; Node is already required by both Codex and Claude Code, so it is on every machine that runs an agent; obs-websocket, MCP and the Anthropic SDK all have first-class Node libraries; runs unchanged on Windows, WSL, macOS |
| First runtimes | Codex and Claude Code | both are only a config generator plus launcher around the same broker |
| First games | Portal (adapter around portal-agent, validates the model against the original run) and Slay the Spire (turn-based, through Communication Mod). Zero Company was dropped before the first release; its research is not published; Kerbal Space Program (kRPC, Mun landing) is the next candidate |
| Language of the repository | English everywhere | a standard others can adopt |
| `paused-think` for turn-based games | applies automatically; enemy turns and cinematics keep running but the agent does not act then; wall-clock time is reported separately | |

## What portal-agent is (the layers we generalise)

```
Codex (agent)                          run/config.template.toml + run/AGENTS.md
  │  MCP stdio, 3 tools
controller/mcp/portal-mcp-server.mjs   generic JSON-RPC server, zero dependencies; imports hardening.mjs first
controller/mcp/hardening.mjs           net.Socket.connect only to 127.0.0.1:27182, no listen, no dgram, env scrubbed, process.exit blocked
controller/index.mjs                   game-specific: the `portal` object (tas/hold/fire/look/observe/screenshot)
  │  TCP 127.0.0.1:27182
spt/portal-agent.patch                 in-game plugin (SourcePauseTool): plays ticks, pauses, returns screenshot + position
```

Also: `tools/configure-run.mjs` (creates a run directory with `.codex/config.toml` and `AGENTS.md`, refuses to overwrite), `tools/export-session.mjs` (private rollout → `session.sanitized.jsonl` + `summary.json`), `release-manifest.json` (sha256 per file), `game-config/` (cvars, `start_run`/`stop_run` for the in-game demo recording).

Game-specific there: `index.mjs`, `portal-documentation.md`, the SPT patch, `game-config/`, the tool names (`portal_*`) and the port. Everything else is already generic and is taken over.

In this repository those layers are split along that line: the broker and the hardening are core and contain no game code at all (the broker loads the plugin module it is given, derives the tool names from the plugin's id, and knows nothing else), while everything Portal-specific sits in the Portal game plugin, which loads portal-agent's controller unchanged. The broker accepts portal-agent's return shapes for screenshots and images so that a controller written for it needs no changes; that is compatibility, not game knowledge.

## Architecture

```
aas run --game games/slay-the-spire/plugin.mjs --run-dir <runs>/sts-01
 │
 ├─ core (generic; from portal-agent where possible)
 │   ├─ broker      stdio MCP server with exactly three tools: <game>_documentation, <game>_screenshot, <game>_exec
 │   ├─ hardening   portal-agent hardening.mjs, parameterised on the game plugin's endpoint(s)
 │   ├─ run log     run.jsonl (private, append-only), summary.json, manifest.json
 │   ├─ export      sanitise (portal-agent export-session.mjs) + chapters.txt
 │   └─ check       conformance check of a run directory against the spec
 │
 ├─ plugin: game      controller object (the `portal` role) + documentation + in-game side + transport
 ├─ plugin: runtime   writes the hardened config for the agent CLI and starts it
 └─ plugin: recorder  preflight / start / onEvent / stop
```

The core knows no game and no model. The game plugin provides the object that is in scope inside `<game>_exec` and the text that `<game>_documentation` returns. The runtime plugin only knows the broker. The recorder only reacts to events.

## Plugin contracts

The full contracts are in [packages/core/src/types.d.ts](../packages/core/src/types.d.ts) and the guide to writing one is [plugins.md](plugins.md). In short, per kind:

- **Game**: `id`, `capabilities`, `endpoints` (the only addresses the broker may reach), `env` (the only environment variables it reads), `documentation`, `instructions`, `segments` and `ends` (the game's ends, one of them the game's own; the harness picks the goal from that list), `connect()` for the controller, and the game side: `prepareRun`, `saveState`, `loadState`, `endRun`, `close`, `doctor`.
- **Runtime**: `configure`/`reconfigure` (the hardened configuration, refusing to overwrite), `writePublicConfig` (the published copy, with placeholders), `start`, `interrupt`, and what only the runtime knows: `budget()` (its plan's stand), `doctor()`, `findSession()` and `exportSession()`.
- **Recorder**: `preflight`, `start` (which returns t0), `onEvent`, `stop`, plus `doctor()` and `close()` for its own program.
- **Timer**: `start`, `onEvent`, `stop`, plus `doctor()` and `close()`.

The core calls these and nothing else: it knows no game, no agent and no recorder by name, so every command works the same whatever combination is loaded.

## Run log

### run.jsonl (private, complete)

Append-only. Several writers (broker, harness, recorder) may append; the export sorts by timestamp and assigns `sequence`. Record shapes are those of portal-agent's `session.sanitized.jsonl` so that their export and viewers work unchanged:

```json
{"timestamp": "2026-09-04T17:00:43.590-07:00", "kind": "tool_call", "call": "call-00001", "name": "portal_exec", "input": "return await game.observe()"}
{"timestamp": "...", "kind": "tool_result", "call": "call-00001", "output": [{"type": "text", "text": "..."}]}
{"timestamp": "...", "kind": "message", "role": "assistant", "channel": null, "text": "..."}
{"timestamp": "...", "kind": "event", "event": "game.milestone", "data": {"label": "M03 Bespin", "chapter": true}}
```

`kind: event` is our one addition. Event names:

| event | Source | Reacts |
|---|---|---|
| `run.started`, `run.ended` | core | recorder (start/stop), log |
| `game.phase` (menu, hub, mission, cinematic, loading) | game | recorder (scene), log |
| `game.turn` | game (turn-based) | overlay, optional chapter |
| `game.playback` (start with steps, end with ticks) | game | timer (game time), timeline (IGT, cut list, inputs) |
| `game.milestone` (mission/level/checkpoint) | game | chapter, highlight, split |
| `game.highlight` (crit, kill, death) | game | replay buffer |
| `recording.started`, `recording.chapter`, `recording.highlight_saved` | recorder | log (file paths) |
| `run.wait`, `run.error`, `run.human` | core | pause scene, log; `run.human` = every human intervention |

Screenshots returned to the agent are saved under `screenshots/` in the run directory and referenced from the log, so `run.jsonl` stays small.

### summary.json, manifest.json, exported files

See the spec. Portal-agent's `summary.json` (`schema_version: 2`) stays valid; we add `category` and `recording` blocks as `schema_version: 3`. `manifest.json` equals portal-agent's `release-manifest.json` plus a `versions` block.

## Repository layout

```
ai-assisted-speedruns/
  README.md
  package.json                  npm workspaces
  packages/
    core/                       broker, hardening, run log, run/resume/timeline/render/publish/check, `aas` CLI
    spec/                       the AAS standard
    recorder-obs/               OBS through obs-websocket v5
    recorder-source-demo/       in-game Source demos through SPT IPC
    recorder-null/              no recording; development only
    timer-livesplit/            LiveSplit Server client + .lss export
    runtime-claude-code/        Claude Code config generator, launcher, plan budget, session export
    runtime-codex/              Codex config generator, launcher, plan budget, rollout export
    runtime-scripted/           a bot module through the same broker, for baselines and chain tests
  games/
    portal/                     adapter around portal-agent's controller
    slay-the-spire/             through Communication Mod: bridge, install, launch, splits, scripted bot
  docs/
    design.md                   this document
    reference.md                every command, the run directory, the bundle, the events
    plugins.md                  how to write a game, runtime, recorder or timer plugin
```

Game plugins may also live outside the repository as separate packages; the CLI loads a plugin by id or by module path.

