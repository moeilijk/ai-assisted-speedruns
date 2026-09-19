# AI Assisted Speedruns (AAS) — Specification, draft 0.40

Status: draft 0.40, 2026-09-19. Every change to this text is a new draft with the next number, listed under [Drafts](#drafts) at the end; a bundle names the draft it follows in `spec_version`. This document defines what an AI Assisted Speedrun is, what a published run must contain, and how runs may be compared. It does not prescribe how a harness works internally.

Inspired by cozyblaze's Portal run. The tool interface and the log format follow his design, and the broker, the process hardening, the log sanitising and the privacy scan build on his code from [portal-agent](https://github.com/cozyblaze/portal-agent). The session log he published there (`evidence/`) serves as the worked example where this text needs one.

## 1. Definitions

- **Run**: one continuous attempt by one agent to reach a stated goal in one game, from `run.started` to `run.ended`.
- **Agent**: a language model plus the runtime that drives it (Codex, Claude Code, a custom loop).
- **Harness**: everything between the agent and the game: broker, tools, recorder, logger.
- **Controller**: the object the agent's code runs against inside the `exec` tool.
- **t0**: the instant the recording starts. All elapsed times are relative to t0.

## 2. The tool interface

A conforming harness exposes to the agent exactly three tools per game, named with the game id as prefix:

| Tool | Purpose |
|---|---|
| `<game>_documentation` | returns the complete API reference of the controller |
| `<game>_screenshot` | returns a full-resolution screenshot of the game |
| `<game>_exec` | runs agent-supplied code against the controller; returns text and/or images |

The agent MUST NOT have any other tool that reaches the game, the network, a shell, or the file system outside the run directory. Runtime-internal tools (notes, context management, goal tracking) are allowed and MUST be listed in `tools.json`.

Every `exec` call returns only when the game is paused again or waiting for input. Game time may advance during a call; it MUST NOT advance between calls in the `paused-think` timing category.

## 3. Category

Every run declares one value on each axis. Runs are comparable only when they agree on every axis except `agent`.

| Axis | Values | Meaning |
|---|---|---|
| `game` | game id | e.g. `portal`, `slay_the_spire` |
| `build` | free text | game version or build identifier, e.g. `CL196320`, a Source Unpack version |
| `goal` | `any%`, `100%`, `credits`, `mission:<id>`, an earlier end of the game, or a documented custom goal | what "done" means |
| `observation` | `vision`, `state`, `full` | `vision`: screenshots plus pose (position, view direction); `state`: structured game state readable; `full`: state readable and actions possible outside the game's UI |
| `input` | `input`, `api` | `input`: simulated keys/mouse/ticks; `api`: game functions called directly |
| `timing` | `paused-think`, `realtime` | `paused-think`: the game is stopped while the agent thinks, only playback advances time; `realtime`: thinking time counts |
| `human` | `none`, `restart-only`, `assisted` | `none`: no human input between start and end; `restart-only`: a human only resumed the agent after runtime errors, gave no game information; `assisted`: anything else, described in `summary.json` |

cozyblaze's Portal run is: `portal · credits · vision · input · paused-think · restart-only · gpt-6-astra/codex/max`.

**Chapters.** A game may be played to an end short of its own ending: the boss of act 1 rather than the whole
game, one mission rather than the campaign. Such an end is a goal like any other and is declared on the `goal`
axis; a game plugin lists the ends it offers and the harness declares the victory when the goal's end is
reached. Runs are comparable only within the same goal, so a chapter never competes with a full run: this is how
a long game is published in parts instead of as one all-or-nothing attempt. Every game plugin declares its ends, each
with an id and a label and exactly one of them final (the game's own end, the goal when none is given), so goals work
the same for every game. A resume may extend the goal to a later end; a victory reaches only the goal that held at
that moment. The extended goal is published only once it is reached: until then a bundle keeps the last goal that was
reached, and what came after is post-completion time on the timeline (§6).

**A run no model played is not an entry, and an archive refuses it.** The harness can play a run with a script
instead of a model, to test a machine without spending tokens (a mock run). Such a bundle may be complete, signed
and witnessed, and it is still not a run of an AI: an archive does not publish it, rank it or keep it as an entry.

**A bundle is a mock unless it shows that a model played it.** `mock` is one word in a file the publisher signs
with their own key, so a bundle that is trusted on that word is trusted on nothing: changing it is an edit and a
second signature. The word therefore states what the harness knew, and an archive derives its own answer from
three things instead, none of which is the publisher's to write afterwards:

1. **Which runtime ran.** Whether a model plays is a property of the runtime, not of the run: `scripted` never
   drives one and `claude-code` always does. A bundle names its runtime in `harness.plugins.runtime` with `id`,
   `version`, the `ai` that runtime declares, and `sha256`, the runtime plugin as it ran (§6). An archive keeps
   its own list of the runtimes it knows with the `ai` each one has, and reads that list rather than the bundle;
   a runtime it does not know, or one whose hash does not match the one it knows, is read as a mock.
2. **What the timeline holds.** `ai_evidence` counts what a model leaves behind and a script does not: messages
   the model wrote, tool calls it made, the models that answered and the output tokens they were billed for.
   All four are countable from `session.sanitized.jsonl` itself, so a reader recounts them.
3. **What was witnessed before the run.** The start statement of every segment names the runtime and its hash and
   is counter-signed by the archive before a tick is played (§8.9). A run whose runtime changed between the start
   and the publication is a run that was rewritten afterwards.

Missing, unreadable or contradictory evidence makes a bundle a mock; only all three together make it a run of an
AI. This is the safe way round: a mock that is read as a run is the forgery worth making, and a run that is read
as a mock costs its publisher one republication. A bundle of schema 15 carries `mock` and `ai` and is read on
them; one of schema 14 or earlier, which has neither, is read as `false`.

**A model that is told what to do is a model that publishes what it was told.** Nothing above stops a publisher
from running the model for real and dictating its play, and no flag can: the run would be genuine in every
countable way. What the standard does instead is fix, before the run, everything that determined it, and publish
it in full. `AGENTS.md` is the instructions verbatim, `category.goal_prompt` is the first prompt verbatim, and
the hashes of both are in the start statement the archive counter-signed before the run began (§8.9, §8.10). A
publisher who writes the route into the prompt publishes that route, in the bundle, for every reader to see, and
cannot put an innocent prompt in its place afterwards. Dictating is then a visible choice about the run, which an
archive judges like any other, and not a hidden one.

**A run that did not reach its goal is not an entry.** A session that was stopped (a budget, a limit, a
runtime error) is a valid recording of an attempt and may be published as such, but it is not comparable: an archive
may receive and keep it, and does not rank it or compare it with runs. In the bundle this is visible without reading the log: `completed_at` is
null and no `game.over` with `victory: true` is on the timeline.

## 4. The run directory and the published bundle

A **run directory** is private: the complete log, the save states, the game's own records and the recording as they were made. A **published bundle** is the sanitised, checkable copy of that run, and the only form in which a run is shared; "public" in a path or a file name means exactly that, made for upload. The two are never the same directory.

A published run is a directory with these files. Names are fixed.

| File | Required | Content |
|---|---|---|
| `session.sanitized.jsonl` | yes | the public timeline, see §5 |
| `summary.json` | yes | see §6 |
| `tools.json` | yes | the exact tool definitions the agent received: `name`, `description`, `inputSchema`, for every tool including runtime-internal ones |
| `AGENTS.md` | yes | the instructions / system prompt, verbatim |
| `documentation.md` | yes | what `<game>_documentation` returned |
| `manifest.json` | yes | sha256 of every published file, see §7 |
| `recording` in `summary.json` | yes | the recording's length, the fingerprint that binds it to this bundle, and the timings that place the timeline in it. The recording is continuous from t0 to `run.ended`. The video is not part of the bundle (a run is hours of 1080p60 and nobody ships that around), and neither is where it is published: video links come from the archive the run is submitted to. |
| `chapters.txt` | if the recording has chapters | `HH:MM:SS Label` per line, relative to t0 (YouTube format) |
| `runtime-config/` | yes | the runtime's configuration with machine paths replaced (portal-agent: `config.template.toml`) |
| `game-config/` | if applicable | game settings changed for the run (cvars, mods, patches, with upstream references) |
| `timeline.json` | when a video of one segment or of the cut is published | timers and sections derived from the playbacks (`aas timeline`): RTA, IGT, thinking time, per-section splits, the segments with their lengths, the cut list |
| `splits.lss` | no | LiveSplit splits file with the same sections |
| `run.jsonl` | no | the private, complete log; it stays in the run directory and is never part of a bundle |

## 5. Timeline format (`session.sanitized.jsonl`)

One JSON object per line. Common fields:

| Field | Type | Meaning |
|---|---|---|
| `sequence` | integer, from 1 | position in the published file |
| `timestamp` | string | ISO 8601 with explicit UTC offset |
| `elapsed_seconds` | integer | seconds since t0 (schema 2: since the first record) |
| `kind` | string | `message`, `tool_call`, `tool_result`, `event` |

Per kind:

- `message`: `role` (`user` or `assistant`), `channel` (string or null), `text`.
- `tool_call`: `call` (sequential id `call-00001`), `name`, `input` (string or object).
- `tool_result`: `call`, `output`: an array of content parts `{type: "text", text}` (schema 2 also `input_text`, Codex's name) or `{type: "image_omitted"}`; schema 2 also allows a plain string.
- `event`: `event` (name), `data` (object). Reserved names: `run.started`, `run.ended`, `run.wait`, `run.error`, `run.human`, `run.witnessed`, `run.unwitnessed`, `game.phase`, `game.playback`, `game.turn`, `game.milestone`, `game.over`, `game.attempt`, `game.goal`, `game.highlight`, `recording.started`, `recording.stopped`, `recording.chapter`, `recording.highlight_saved`.

`run.started` carries the `goal` that holds for that segment, and `tooling`: the `version` of the harness that ran the segment, its `commit` (null outside a git clone) and whether its tracked files were `modified` (null when unknown); `allowed_breaking` lists the breaking releases the runner chose to go past on that resume; `overlay` says whether the harness's overlay was in the picture. A resumed run may have segments from different releases: never from an older release than an earlier segment. `game.goal` (`from`, `to`) marks a resume that extended the goal to a later end. `game.over` (`victory`, `label`, `deaths`, plus game-specific fields) marks the end of an attempt inside the game. With `victory: true` the goal is reached: the harness ends the agent session, the timer stops (the milestone before it did the final split) and the run's status is `completed`. With `victory: false` the agent died: that run is over, but not the session (no ironman rule). The game plugin offers a restart from the beginning (a new game with the same seed where the game has one), and the next run begins with `game.attempt` (`phase: start`, `attempt` N, `seed`). Every run is its own attempt: the timer resets and takes its own splits, and `timeline.json` lists the runs under `attempts` (start, end, outcome `death`/`victory`/`stopped`, IGT). The session's RTA keeps running over all runs; `aas render --attempt last` cuts the last run on its own. Deaths are counted in the outcome. A session that ends without a victory is `stopped` and may be resumed.

`game.playback` marks the only intervals in which game time advances in the `paused-think` category: `data.phase` is `start` (with `steps`, the exact inputs about to be played) or `end` (with `ticks` played, `aborted`, `reason`). In-game time (IGT) is the sum of played ticks times the tick interval; everything between playbacks is thinking time.

Sanitisation removes: images, reasoning payloads, host/system/developer context, machine paths, e-mail addresses, credentials, IP addresses other than loopback, URLs other than loopback, original call and session identifiers. Every removal is counted in `summary.json.redactions`.

## 6. `summary.json`

Three version numbers, because three things change at their own pace and a reader must tell them apart:
`spec_version` (the standard this run claims to follow), `schema_version` (the shape of this summary) and
`bundle.bundle_version` (the packaging: which files a bundle holds and how they are named). `bundle.revision`
counts publications of the same run and `bundle.published_at` orders them, so a store keyed on
(`run_id`, `revision`) can tell an update of a run it already holds from a new one. A series may start above 1
and may have gaps: the counter belongs to the run, and earlier publications may have carried another `run_id`.

`bundle` repeats what `manifest.json` says about the packaging (§7): `kind` is the marker `aas-public`,
`bundle_version`, `run_id`, `run_uid`, `revision` and `published_at`. `run_id` and `run_uid` also stand at the top
level, next to `spec_version`.

`run_uid` is that run's identifier, written once when the run is configured and never changed. A name can change
where the identifier cannot, so a reader can see that two bundles under different names are the same run.
Seeing is not deciding: whether a newer publication supersedes an entry already held is a judgement, and the
standard leaves it to whoever keeps the archive rather than merging anything on a matching field. `harness` names the
framework and every plugin with its own version, each as `{id, version}` rather than as a sentence; the runtime also
with its `name` for people (`Claude Code` for `claude-code`), which every runtime plugin declares.

Where a recording is published is not in the bundle. A run may be published in more than one place, and a stream VOD
expires where an upload keeps; the links, their platforms and when each was last confirmed are kept by the archive,
supplied by whoever submits the run. A bundle is therefore never judged on a missing link.

Schema version 2 is portal-agent's format and remains valid. Schema version 3 adds `category`, `recording` and `harness`. Schema version 4 adds the identifiers and versions a reader keys on (`run_uid`, `bundle` with its `revision`, `spec_version`) and the list forms: `recordings`, `game` with its build and mods, `harness` with its plugins. Schema version 5 drops `recordings` and `recording.url`: video links come from the archive, not from the bundle. Schema version 6 adds the goal by name: `ends`, `category.goal_end`, `goals` and `harness.plugins.runtime.name`. Schema version 7 drops `recording.black_intervals`: whether the recording shows the game is checked at the start of the run (§8), and what a published video shows is for the archive to judge. Schema version 8 adds `recording.videos`: the videos a runner may upload. Schema version 9 adds a suggested `title` and `description` to each of them. Schema version 10 adds what the runtime reported about each model (`context_window`, `max_output_tokens`, `provider`) and `harness.plugins.runtime.cli_versions`. Schema version 11 adds `parts` to each model. Schema version 12 adds `details` to each mod in `game.mods`. Schema version 13 adds `recording.overlay`. Schema version 14 is a video's code `aas<32 hex>`. Schema version 15 adds `mock` and `harness.plugins.runtime.ai`: a run a script played instead of a model, which is never an entry (§3). Schema version 16, what `aas publish` writes, is what makes that answer checkable instead of declared: `harness.plugins.runtime.sha256` (the runtime plugin as it ran), `ai_evidence` (what a model left behind in this timeline), `category.goal_prompt` (the first prompt verbatim) and `brief` (the sha256 of the instructions and of that prompt, both recomputable from this bundle and both counter-signed by the archive before the run began, §8.9). From schema 16 `mock` is `true` unless the runtime says a model plays, so a runtime a reader cannot place is a mock.

```json
{
  "schema_version": 13,
  "spec_version": "0.37",
  "run_id": "sts-claude-code-01", "run_uid": "e56f4879...32 hex characters...",
  "bundle": {"kind": "aas-public", "bundle_version": 1, "run_id": "sts-claude-code-01", "run_uid": "e56f4879...",
             "revision": 10, "published_at": "..."},
  "time_zone": "Europe/Amsterdam",
  "run_dates": "2026-09-20 to 2026-09-20",
  "started_at": "...", "completed_at": "...", "ended_at": "...",
  "models": [{"model": "claude-fable-5-1", "parts": {"name": "claude", "variant": "fable", "version": "5.1", "snapshot": null}, "reasoning_effort": "high", "context_window": 1000000, "max_output_tokens": 64000, "provider": "firstParty"}],
  "requested": {"model": "claude-fable-5-1", "reasoning_effort": null, "note": null},
  "synthetic_records": 0, "harness_events": 0,
  "source_records": 0, "exported_records": 0, "omitted_records": 0, "removed_images": 0,
  "redactions": {},
  "elapsed_to_completion_seconds": 0,
  "elapsed_including_post_completion_seconds": 0,
  "last_reported_thread_token_usage": {
    "input_tokens": 0, "cached_input_tokens": 0, "cache_write_input_tokens": 0,
    "output_tokens": 0, "reasoning_output_tokens": 0, "total_tokens": 0
  },
  "tool_methods_in_exec": {},
  "export_notes": [],
  "seed": "ATGY4CVU47AK",
  "attempts": [{"attempt": 1, "seed": "ATGY4CVU47AK", "outcome": "death", "rta": 205.2, "igt": 200.9}, {"attempt": 2, "seed": "ATGY4CVU47AK", "outcome": "victory", "rta": 0, "igt": 0}],
  "mock": false,
  "ai_evidence": {"assistant_records": 412, "tool_calls": 396, "output_tokens": 128433, "models": 1, "human_turns": 0},
  "brief": {"instructions_sha256": "<sha256 of AGENTS.md>", "goal_prompt_sha256": "<sha256 of category.goal_prompt>"},
  "category": {
    "game": "slay_the_spire", "build": "V2.3.4 + Communication Mod 1.2.1", "goal": "act3",
    "goal_end": {"id": "act3", "label": "Act 3 boss", "final": true},
    "goal_prompt": "You are controlling Slay the Spire. Your goal is to defeat the Act 3 boss. ...",
    "observation": "state", "input": "api", "timing": "paused-think", "human": "restart-only",
    "human_notes": "resumed after completed; goal extended from act1 to act3"
  },
  "ends": [{"id": "act1", "label": "Act 1 boss", "final": false}, {"id": "act2", "label": "Act 2 boss", "final": false},
           {"id": "act3", "label": "Act 3 boss", "final": true}, {"id": "heart", "label": "Heart", "final": false}],
  "goals": [{"id": "act1", "label": "Act 1 boss", "final": false, "declared_at": "...", "reached_at": "..."},
            {"id": "act3", "label": "Act 3 boss", "final": true, "declared_at": "...", "reached_at": "..."}],
  "recording": {
    "recorder": "obs", "t0": "...",
    "duration_seconds": 0, "fingerprint": "sha256 of session.sanitized.jsonl",
    "files": ["recording/AAS_sts-claude-code-01_2026-09-20_10-51-17.mp4", "recording/AAS_sts-claude-code-01_2026-09-20_15-42-18.mp4"],
    "videos": [
      {"kind": "segment", "part": 1, "parts": 2, "file": "recording/AAS_sts-claude-code-01_2026-09-20_10-51-17.mp4", "seconds": 1368.498,
       "line": "aas36d633208676bfdb5e1c0a47b93f2d8e", "chapters": [{"at": 0, "label": "Start"}, {"at": 1362.6, "label": "Act 1 boss"}]},
      {"kind": "segment", "part": 2, "parts": 2, "file": "recording/AAS_sts-claude-code-01_2026-09-20_15-42-18.mp4", "seconds": 190.949,
       "line": "aas36d633208676bfdb5e1c0a47b93f2d8e", "chapters": [{"at": 4.5, "label": "Human: resumed after completed"}]},
      {"kind": "cut", "part": null, "parts": null, "file": "recording/AAS_sts-claude-code-01_2026-09-20_10-51-17.cut.mp4", "seconds": 769.134,
       "line": "aas36d633208676bfdb5e1c0a47b93f2d8e", "chapters": [{"at": 0, "label": "Start"}, {"at": 675.2, "label": "Act 1 boss"}],
       "title": "Claude Sonnet 5 plays Slay the Spire (cut): reached the Act 1 boss in 00:02:57.4",
       "description": "Claude Sonnet 5, a language model, plays Slay the Spire by itself. Goal: the Act 1 boss. The run reached the Act 1 boss after 00\u2060:02\u2060:57.4 of game time and 00\u2060:22\u2060:42 of real time.\n\nThis cut leaves out the pauses while the model was thinking: 00\u2060:25\u2060:59 of recording in 00\u2060:12\u2060:49.\n\nTop left: LiveSplit, the speedrun timer. Bottom left: …\n\n11:15 The run reaches the Act 1 boss. …\n\nAn AI Assisted Speedrun (AAS): …\n\nVerification code for the AAS Archive:\naas36d633208676bfdb5e1c0a47b93f2d8e"}
    ],
    "overlay": {"shown": true, "keys": false},
    "chapters": "chapters.txt",
    "igt_seconds": null, "wall_clock_seconds": 0, "thinking_seconds": 0
  },
  "totals_to_completion": {"rta_seconds": 0, "igt_seconds": 0, "thinking_seconds": 0, "playbacks": 0, "tool_calls": 0},
  "game": {
    "game": "Slay the Spire", "version": "build 2022-12-18", "platform": "Steam",
    "mods": [{"name": "CommunicationMod", "details": null, "version": "1.2.1", "source": "https://...jar", "sha256": "..."}],
    "settings": {"character": "IRONCLAD", "ascension": 0, "seed": "23M", "fast_mode": true}
  },
  "harness": {
    "name": "ai-assisted-speedruns", "version": "0.1.0", "framework": "ai-assisted-speedruns 0.1.0",
    "plugins": {"game": {"id": "slay_the_spire", "version": "0.1.0"}, "runtime": {"id": "claude-code", "name": "Claude Code", "version": "0.1.0", "ai": true, "sha256": "789ba830...64 hex...", "cli_versions": ["2.1.270"]},
                "recorder": {"id": "obs", "version": "0.1.0"}, "timer": {"id": "livesplit", "version": "0.1.0"}}
  }
}
```

`models` lists every model the API actually answered with, one entry per model seen in the session log, and `requested` is what the run asked for when it started (the runtime passes `--model`; it sets no reasoning effort, so `reasoning_effort` is null and `note` says why). The two are separate on purpose: a provider may answer with another model than the one requested — a fallback — and that must be visible in the bundle instead of hidden. `aas check` reports it when a session used a model that was not requested, or more than one model. The effort in `models[]` comes from the session log itself (a runtime that records the effort per assistant message reports it; one that does not reports null), so it is what the provider actually used, not what was asked for. Each entry also carries what the runtime reported about that model, exactly as reported and null where it reported nothing: `context_window` and `max_output_tokens` in tokens, and `provider` (Claude Code reports these in the result record of each invocation, from 2.1.270 on with `provider`; Codex reports the context window and the provider in its rollout, and no maximum output). A model name alone does not say how it was used: the same model under two different reports is listed as two entries. `parts` splits the model id the way its maker names its models: `name`, `variant`, `version` and `snapshot` (claude-sonnet-5 is claude, sonnet, 5, no snapshot; gpt-5.6-luna is gpt, luna, 5.6; claude-haiku-4-5-20251001 is claude, haiku, 4.5, 20251001). The split follows only the naming patterns the tooling knows (`packages/core/src/models.mjs`); an id it does not know has `parts` null, never a guess. Nothing else, such as a provider, is derived from a model id. `harness.plugins.runtime.version` is the version of the runtime plugin; `harness.plugins.runtime.cli_versions` lists the versions of the runtime's own CLI that the session log records, in order of first appearance (a resumed session may have continued under a newer CLI). `synthetic_records`, where the runtime's session log has them (Claude Code does, Codex does not), counts records the runtime wrote itself (an API error, an interrupt); they carry no model and are never listed as one. `harness_events` counts the events of the harness, the game plugin and the recorder that were merged into the timeline next to the session log; they are counted in `source_records` and `exported_records` as well.

`mock`, `ai_evidence`, `harness.plugins.runtime.sha256`, `category.goal_prompt` and `brief` are the bundle's answer to
"did a model play this, and what was it told" (§3). `ai_evidence` counts, in this bundle's own timeline:
`assistant_records` (messages the model wrote), `tool_calls`, `models` (how many answered) and `output_tokens` as the
runtime reported them, plus `human_turns`. The harness sends one prompt per segment, the one in `category.goal_prompt`;
every further message from a user in the timeline is someone typing into a running session, which is help whatever it
said, so `human_turns` above zero forces `human` to `assisted` (§8.3). `brief.instructions_sha256` is the sha256 of the
published `AGENTS.md` and `brief.goal_prompt_sha256` the sha256 of `category.goal_prompt` in UTF-8: a reader recomputes
both from the bundle and finds the same two in the witnessed start of every segment. `harness.plugins.runtime.sha256`
is the runtime plugin as it ran, null when the publisher's tooling could not read it, which an archive reads as a
runtime it cannot place.

`ends` lists the game's ends as its plugin declares them, in order, each `{id, label, final}`; exactly one is final, the game's own end. `category.goal` is the published goal, and `category.goal_end` is that end with its label. `goals` lists the goals up to the published one, in order: the goal at the start and each extension by a resume that was reached, each with `declared_at` and `reached_at` (the victory while that goal held). Only the last may be unreached, when the run reached no goal at all. An extension is published once it is reached; until then the bundle keeps the goal that was reached, `completed_at` is its victory, the resume that extended it does not count on the human axis, and the extension's play is post-completion time. A run that won act 1 and was then extended to act 3 without reaching it is published as an act 1 run.

`totals_to_completion` gives the run's times to its published goal, on the recording's clock from t0: `rta_seconds`, `igt_seconds`, `thinking_seconds`, `playbacks` and `tool_calls` up to `completed_at`, or null when the run was not completed. `recording.igt_seconds`, `recording.thinking_seconds` and `timeline.json` `totals` stay the whole recording, which includes post-completion time (credits, or a goal extension that is not published). In `timeline.json` the same figures are `totals_to_completion`, `completed_rta` is the completion on the recording's clock, and every section carries `post_completion`; `splits.lss` splits only up to completion. Sections after completion stay in `chapters.txt`, because they are in the recording.

`game` is what it takes to play the same thing again: the game's own build, every mod that was loaded with the version and the pin it was installed from, and the settings of the run. A mod's `name` is the mod's own name; `details` says what was done to it beyond that name (for Portal, SourcePauseTool with portal-agent's IPC patch), or is null. A game plugin reports it; where the game itself records these (a run-history file, a save), those are the words the bundle carries.

`recording.duration_seconds` is the length of the recording and `recording.fingerprint` the sha256 of `session.sanitized.jsonl`. `recording.files` names the recording's files in the run directory, one per segment, which the bundle does not carry; `recording.chapters` is `chapters.txt`, or null when the recording has no chapters. The fingerprint is unique to a bundle, so an archive treats a fingerprint it already holds as a resubmission of that run and not as a new entry. A platform re-encodes an upload, so the file's own hash says nothing about the video anyone can watch: the publisher puts the run id and the fingerprint in the video's description, and a verifier matches those, the duration, and a few tool calls at their `elapsed_seconds`.

**Which videos.** The runner chooses what to upload: the full recording, the cut, or both. The full recording of a run that was resumed is one file per segment, and each file may be its own video; the cut is one video of the kept intervals (`timeline.json` `keep`, the thinking pauses removed), in order, across the segments. Every uploaded video carries its code in its description (or its title, where a platform has no description): from schema 14 `aas<32 hex>`, `aas` and the first 32 hex digits of the fingerprint in lowercase (128 bits: a bundle whose fingerprint starts the same takes about 2^128 hashes to make), one word, the same for every video of a revision, and `recording.videos[].line` holds it. It stands as a word of its own: no letter or digit directly before or after it. A bundle of schema 8 to 13 has the line `AAS <run_id> · fingerprint <16 hex> · <n> s` instead, with `n` the length of that video in whole seconds, and a video carrying that line stays bound to it. A verifier measures the video's length itself and matches it against one of the lengths the bundle states: `recording.duration_seconds` for the whole recording, `timeline.json` `segments[].seconds` for one segment, the sum of `timeline.json` `keep` for the cut. In a cut, a tool call's place is its `elapsed_seconds` mapped through `keep`.

`recording.videos` lists those videos so that a reader need not derive them: for a run in one file `whole` (its length `recording.duration_seconds`), for a resumed run one `segment` per file with `part` and `parts` (its length `timeline.json` `segments[part-1].seconds`), and the `cut` (its length `timeline.json` `totals.cut_video`, the sum of `keep`; `file` is the name `aas render` gives it, whether or not it has been made yet). Each has `file` (relative to the run directory, which the bundle does not carry), `seconds`, `line`, exactly the line its description carries with `seconds` rounded, and `chapters`, `{at, label}` on that video's own clock, the labels without the harness's details (a save's name, a resumed session's exit code, turns and cost), which `chapters.txt` and the log keep. `recording.overlay` is `{shown, keys}`: whether the picture shows the harness's overlay (the current section, RTA and IGT, and the model's last command) in every segment, and whether it showed the keys being played; null when a segment did not record it. Each video also has `title` and `description`: examples, generated by the publisher's tooling from this summary (`packages/core/src/youtube-text.mjs`), which the runner may use, change or leave out. Durations for people are written in ISO 8601's extended format, hh:mm:ss with two digits each (game time with tenths, 00:02:02.0; real time in whole seconds, 00:10:32; hours past 24 go on counting); a place in a video is written as YouTube writes it (11:15). In a description a word joiner (U+2060) stands before each colon of a duration (`00\u2060:02\u2060:02.0`), because YouTube makes every `m:ss` and `h:mm:ss` within the video's length a link to that place; the text looks the same. A plain `m:ss` in a description is only a place in that video, at the start of its own line and within its length. The description tells a viewer, in plain sentences, the run's result, what the picture shows, what happens in that video and nothing it does not show, where the run is in the archive (as text), and ends on the line. The line is the only requirement: nothing else in a video's title or description is checked. An archive that suggests a title and description shows these, as they are.

Binding a recording to a bundle is two claims, and they are established differently. **This recording is mine**: only the owner of a recording can write its description, so a line in it that a stranger could not have put there says the channel is the publisher's. An archive that is connected to the publisher's channel through that platform can ask the platform instead, which settles ownership without the publisher editing anything. **This recording is of this bundle**: that is what the fingerprint says, and no platform connection can answer it, because the platform knows nothing about the run. A reader who does not trust the archive can only check the second claim where the fingerprint is readable, so the line stays the route for anyone whose channel an archive cannot ask, and the better practice for everyone else: an archive may accept a connected channel without it, and then carries the binding on its own word.

`seed` is the game's seed of the last run in the game's own notation (Slay the Spire: the seed code the game shows, accepted by its START), null for games without one; `attempts` lists every run of the session with its seed and outcome, so a run can be reproduced. `completed_at` is the timestamp of the `game.over` event with `victory: true`, else of the record in which the goal was reached (completion marker), or null. `elapsed_to_completion_seconds` is the run's headline real time (RTA). `recording.igt_seconds` is the in-game time (sum of played ticks); for `paused-think` runs both are reported and the IGT is the comparable one.

## 7. `manifest.json`

```json
{"version": 1, "bundle": "aas-public", "bundle_version": 1, "spec_version": "0.1",
 "run_id": "sts-codex-01", "run_uid": "9f1c...32 hex characters...", "revision": 3, "generated_at": "...",
 "files": [{"path": "session.sanitized.jsonl", "bytes": 0, "sha256": "..."}]}
```

Every file in the bundle except `manifest.json` itself and `run.jsonl` is listed. A verifier recomputes the hashes.

Two files are deliberately absent from `files[]`: the manifest cannot list its own hash, and `signature.json`
(§7b) signs the manifest's bytes and so cannot be inside what it signs. A verifier that also checks the other
direction — every file in the bundle is in the manifest — must exempt both, or it reports a correctly signed
bundle as carrying a stray file.

`bundle: "aas-public"` is the marker that this directory is a published bundle and not a run directory or some other folder: a reader that accepts uploads checks it first, together with the absence of `run.jsonl`. `run_id` is the run's identity and the name of its directory.

## 7a. The upload

A bundle is offered as one **zip**, named `<run_id>.zip`, with every file under a single top-level directory `<run_id>/`. It is small: a timeline, a summary, the tool definitions, the instructions, the configuration, the chapters and the splits. The recording is not in it and never was, and where it can be watched is kept by the archive, not by the bundle.

## 7b. `signature.json` (optional)

A bundle may be signed. What is signed is the exact bytes of `manifest.json` and nothing else: the manifest
carries a sha256 of every other file, so one signature covers the whole bundle, and it keeps covering it in the
upload zip, which carries the same manifest. The signature sits next to it in `signature.json`, which the
manifest therefore does not list, the way it does not list itself or `run.jsonl`.

```json
{"version": 1, "algorithm": "ed25519",
 "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
 "key_fingerprint": "SHA256:...",
 "manifest_sha256": "<hex of the bytes that were signed>",
 "signature": "<base64 of the ed25519 signature over those bytes>",
 "signed_at": "..."}
```

The key is ed25519 and its public half is written in the one-line OpenSSH form: short enough to paste into a
profile, and already published for an account by some code hosts. ed25519 verifies in a browser and in a plain
runtime without any dependency. The key is the publisher's own — made by their tooling, needing no account
anywhere — and this standard requires no account to produce a bundle, signed or not.

**Signing is optional, and this standard does not require it.** A verifier can say that a signature is valid for
the key in the file, and no more: a signature says that two bundles came from one key, and nothing about whose
key that is. Who published a run is a question an archive answers from its own accounts, where the publisher is
already signed in. A key that gates nothing and authorises nothing would be one more thing to install, run and
register for no effect the publisher can see — a barrier without a benefit, and the first run somebody publishes
is exactly the one that must not have those. What a signature does earn, for a publisher who wants it: their
publications are tied to one key, inside an archive and outside it, which is worth having in a dispute and
little before there is one. A signature that is present must verify: a broken one is worse than none.

**An archive that records keys records them per account.** A publisher has more than one key over a lifetime — a
second machine, a replacement — so the account is the identity and a key is only evidence, and nothing is keyed
on a fingerprint. Retiring a key means "accept no new publications signed with this one", never "the older ones
become doubtful": which key signed a publication is a fact about that publication and stays true after the key is
gone. A key an archive has not seen before does not make a bundle less publishable; it is simply a signature whose
publisher is not established, and it gains its match if that publisher registers the line later.

This standard names no place to record a key. The public line is one line of text, so anywhere a publisher can
publish text and an archive can read it will do, and the ordinary place is the archive itself: a key list per
account, kept where the publisher is already signed in. A publisher who wants their key to mean something beyond
one archive can also publish a claim — the key, the identities it claims and a date, signed with that key, in
plain text so it survives being wrapped in a profile, a page or another signature. A claim says what the holder
of the key asserts; the place it is published is what makes the identities agree. Which of these an archive
accepts is its own policy, and an archive that offers several ways to sign in cannot lean on any single host's
key list, because most identity providers publish no keys at all.

The signature covers the bundle, not where the recording is published. Publication links are mutable by design
(a VOD expires, a run may be re-uploaded), so they stay outside what is signed; the recording is bound to the
bundle by the fingerprint in its description instead.

## 8. Verifiability

A run is verifiable when all of the following hold:

1. The full recording of this run, where the archive holds its link, is continuous from `run.started` to `run.ended`, one file per segment. Pauses are `run.wait` events in the timeline and visible in the recording. A cut video keeps exactly the intervals of `timeline.json` `keep`, in order.
2. Every `tool_call` can be located in the full recording at its `elapsed_seconds`, and in a cut through `keep`; `chapters.txt` names the sections at the same offsets, so a reader can jump to any of them.
3. `human: none` implies no `run.human` record in the published run. Any such record forces `restart-only` or `assisted`. A `run.human` record after `completed_at` that is followed by a `game.goal` belongs to a goal extension that is not published yet (§6) and does not count. It also implies that the timeline holds no message from a user beyond the goal prompt of each segment: the harness sends exactly one, so the number of `message` records with `role: user` may not exceed the number of `run.started` records. Every further one is a human typing into a running session, counted in `ai_evidence.human_turns`, and it forces `assisted` rather than `restart-only`: a resume is a restart, and a message is help, whatever it said.
4. `tools.json`, `AGENTS.md`, `documentation.md` and `runtime-config/` are published; the agent had no tool outside `tools.json`. Every session of a resumed run served exactly these tools and this documentation: the harness does not resume a run when the installed tooling or game plugin would serve others.
5. The hashes in `manifest.json` match.
6. The bundle says what was played: `game.version` and every mod that was loaded, with the pin each was installed from, so the run can be set up again.
7. The run reached its declared goal: the timeline carries a `game.over` with `victory: true` and `summary.completed_at` names that moment. A stopped session fails this point and is not an entry.
8. The recording was checked when the run started: the harness confirmed that the recording is being written and that the game capture shows a picture, and a run whose check fails does not start. A failed recording is found while the run can still be stopped, not after a run that has no evidence. What the published video shows is for the archive to judge.
9. The archive witnessed when each segment ran. Once the game is up, and again when the segment's recording has stopped, the harness sends the archive a statement signed with the publisher's key, and logs the archive's answer as `run.witnessed`: the statement, the archive's `received_at`, the statement's `statement_sha256` and the `receipt`, the archive's ed25519 signature over `aas-witness-receipt v1`, `statement: <sha256>` and `received: <received_at>` on three lines. Which rules apply to a segment follows from the archive's clock, not from the tooling version the statement names. Without a network, a publisher key or an answer, the run goes on and the harness logs `run.unwitnessed` with the reason; a statement is never sent afterwards.

The statement is plain text, one field per line, in this order: `aas-witness v2`, `phase: start|end`, `run_uid: <32 hex>`, `segment: <n>`, `tooling: <version> <commit or -> <clean|modified|unknown>`, `at: <the machine's time>`, then for a start `t0: <recording start>`, `runtime: <id> <version> <ai|no-ai|ai-unknown> <sha256 of the runtime plugin>`, `instructions: <sha256 of AGENTS.md>` and `goal: <id> <sha256 of the goal prompt>`, or for an end `ended_at: <recording end>`, `seconds: <segment length>` and `log: <sha256 of the run log> <its number of records>`, then `key: <the publisher's public key, OpenSSH form>`, and `signature: <base64 ed25519 over the lines before it, joined with newlines>`. A field this machine cannot fill is `-`. The archive's witness keys are published at `/.well-known/aas-witness.txt`; a checker trusts those, never a key in an answer. A statement of the earlier kind `aas-witness v1`, which carries neither the runtime nor the prompt, stays valid in the bundles that hold it.

The two extra fields of a start are what make §3 and §8.10 checkable rather than declared: which runtime drove the segment, and what the model was told, both fixed on the archive's clock before the recording ran. The `log` field of an end fixes what the segment produced. A reader cannot recompute it — the run log is private (§4) and never published — and it is not meant to be recomputed: it says that this log existed, in these bytes, at a time the archive saw. A timeline assembled afterwards has no such moment, so what a bundle publishes either derives from a witnessed log or from one that was never witnessed.

10. The bundle says what the model was told, and it says what was witnessed. `AGENTS.md` is the instructions verbatim and `category.goal_prompt` the first prompt verbatim; `brief.instructions_sha256` and `brief.goal_prompt_sha256` are their sha256 and are recomputed from the bundle; the start statement of every segment carries the same two, and its `runtime` field names the runtime the bundle names, with the same hash. A bundle whose prompt, instructions or runtime differ from what was witnessed was changed after the run and fails this point.
11. Every input the game received came from a tool call. Game time advances only inside `game.playback`, and every playback in the timeline stands between a `tool_call` and its `tool_result`: input that no tool call produced was played by something other than the agent. Where a game records its own inputs (a demo, a replay, the mod's command log), a harness compares the two and the bundle carries the result; where it does not, the timeline's own accounting is what this point checks.

A run that fails any point may still be published but MUST NOT be labelled as conforming.

## Drafts

Every change to this text is a draft of its own. A bundle's `spec_version` names the draft it was published under.

| Draft | Date | Change |
|---|---|---|
| 0.1 | 2026-09-09 – 09-13 | First draft: definitions, tool interface, category, bundle, timeline format, summary, manifest, verifiability |
| 0.2 | 2026-09-13 | The manifest does not list `signature.json`, and a verifier exempts it; the upload is one zip |
| 0.3 | 2026-09-13 | An archive that matches keys to accounts reads every key list a host offers |
| 0.4 | 2026-09-13 | A bundle says who published it by being signed; signing required |
| 0.5 | 2026-09-13 | Verifiability point on the publisher's key reworded |
| 0.6 | 2026-09-13 | The publisher makes their own key; no code-hosting account needed |
| 0.7 | 2026-09-13 | Binding a recording to a bundle is two claims: the recording is mine, and it is of this bundle |
| 0.8 | 2026-09-13 | A publisher has several keys over time; retiring one does not un-publish what it signed |
| 0.9 | 2026-09-14 | Signing is optional: a marker for whoever wants one |
| 0.10 | 2026-09-14 | The standard names no place to record a key |
| 0.11 | 2026-09-14 | The ordinary place for a key is the archive; a publisher may also publish a signed claim |
| 0.12 | 2026-09-14 | Schema 4: identifiers, versions, `bundle` with its revision, recordings as a list |
| 0.13 | 2026-09-14 | Schema 5: video links come from the archive, not from the bundle |
| 0.14 | 2026-09-14 | Black frames are part of the recording and declared, never a failure |
| 0.15 | 2026-09-14 | Schema 6: every game plugin declares its ends; goals by name, with every goal the run had |
| 0.16 | 2026-09-14 | An extended goal is published once it is reached |
| 0.17 | 2026-09-14 | `totals_to_completion`; post-completion sections are marked |
| 0.18 | 2026-09-14 | §8.3 carries the human-axis exception for a goal extension |
| 0.19 | 2026-09-14 | Credit to portal-agent reworded |
| 0.20 | 2026-09-14 | Credit to portal-agent for the idea |
| 0.21 | 2026-09-14 | Credit to cozyblaze for the run, the design and the code |
| 0.22 | 2026-09-15 | §6 describes `summary.json` as schema 6 writes it: `bundle`, identifiers, `harness_events`, `recording.files` |
| 0.23 | 2026-09-15 | Schema 7 drops `recording.black_intervals`; §8.8: the recording is checked when the run starts; drafts are numbered |
| 0.24 | 2026-09-15 | §3: an archive may receive and keep a run that did not reach its goal, and does not rank or compare it |
| 0.25 | 2026-09-15 | §6: the runner uploads the full recording (one video per segment), the cut, or both; each video's line carries its own length; §4: `timeline.json` is required for a segment or cut video; §8.1–8.2 cover the cut |
| 0.26 | 2026-09-15 | Schema 8: `recording.videos`, each video a runner may upload with its kind, file, length, line and chapters on its own clock |
| 0.27 | 2026-09-15 | Schema 9: each video in `recording.videos` has a suggested `title` and `description`, examples that end on the line; the line stays the only requirement |
| 0.28 | 2026-09-15 | Schema 10: each entry of `models` carries `context_window`, `max_output_tokens` and `provider` as the runtime reported them; `harness.plugins.runtime.cli_versions` lists the runtime CLI's versions from the session log |
| 0.29 | 2026-09-15 | Schema 11: each entry of `models` carries `parts`, the model id split into `name`, `variant`, `version` and `snapshot` by its maker's naming; null for an id the tooling does not know |
| 0.30 | 2026-09-16 | Schema 12: each mod in `game.mods` carries `details`, what was done to it beyond its own `name` (a patch), or null |
| 0.31 | 2026-09-16 | §8.4: every session of a resumed run serves the tools and documentation the run started with |
| 0.32 | 2026-09-16 | §5: `run.started` names the tooling that ran each segment |
| 0.33 | 2026-09-16 | §8.9: the archive witnesses the start and end of every segment; `run.witnessed`, `run.unwitnessed` |
| 0.34 | 2026-09-16 | Schema 13: `recording.overlay`; `run.started` says whether the overlay was in the picture; the example video texts are written for viewers |
| 0.35 | 2026-09-16 | §6: durations for people in ISO 8601 hh:mm:ss |
| 0.36 | 2026-09-16 | Schema 14: a video carries the code `aas<32 hex>`, one word and the same for every video of a revision, instead of the line with run id, fingerprint and length |
| 0.37 | 2026-09-16 | §6: the example video description in the wording the owner approved (goal, which video, what the picture shows, moments as `m:ss`, verification code) |
| 0.38 | 2026-09-17 | §6: in a description a word joiner (U+2060) before each colon of a duration, so a platform does not link it as a place in the video; plain `m:ss` only for places, on their own line and within the video |
| 0.39 | 2026-09-19 | Schema 15: `mock` and `harness.plugins.runtime.ai`; §3: a run no model played is not an entry and an archive refuses it |
| 0.40 | 2026-09-19 | §3: a bundle is a mock unless it shows a model played it, and an archive derives that from the runtime's own hash, the timeline's evidence and the witnessed start, not from `mock`; a dictated run publishes its prompt. Schema 16: `harness.plugins.runtime.sha256`, `ai_evidence`, `category.goal_prompt`, `brief`. §8.3: a user message beyond the goal prompt of a segment forces `assisted`. §8.9: `aas-witness v2` carries the runtime and the prompt at a start and the run log at an end. §8.10, §8.11: what was witnessed matches the bundle, and every input came from a tool call |
