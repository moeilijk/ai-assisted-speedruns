# AI Assisted Speedruns (AAS) — Specification, draft 0.1

Status: draft, 2026-09-09. This document defines what an AI Assisted Speedrun is, what a published run must contain, and how runs may be compared. It does not prescribe how a harness works internally.

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

**A run that did not reach its goal is not an entry.** A session that was stopped (a budget, a limit, a
runtime error) is a valid recording of an attempt and may be published as such, but it is not comparable and an
archive does not accept it as a run. In the bundle this is visible without reading the log: `completed_at` is
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
| `timeline.json` | no | timers and sections derived from the playbacks (`aas timeline`): RTA, IGT, thinking time, per-section splits, the cut list |
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
- `event`: `event` (name), `data` (object). Reserved names: `run.started`, `run.ended`, `run.wait`, `run.error`, `run.human`, `game.phase`, `game.playback`, `game.turn`, `game.milestone`, `game.over`, `game.attempt`, `game.goal`, `game.highlight`, `recording.started`, `recording.stopped`, `recording.chapter`, `recording.highlight_saved`.

`run.started` carries the `goal` that holds for that segment. `game.goal` (`from`, `to`) marks a resume that extended the goal to a later end. `game.over` (`victory`, `label`, `deaths`, plus game-specific fields) marks the end of an attempt inside the game. With `victory: true` the goal is reached: the harness ends the agent session, the timer stops (the milestone before it did the final split) and the run's status is `completed`. With `victory: false` the agent died: that run is over, but not the session (no ironman rule). The game plugin offers a restart from the beginning (a new game with the same seed where the game has one), and the next run begins with `game.attempt` (`phase: start`, `attempt` N, `seed`). Every run is its own attempt: the timer resets and takes its own splits, and `timeline.json` lists the runs under `attempts` (start, end, outcome `death`/`victory`/`stopped`, IGT). The session's RTA keeps running over all runs; `aas render --attempt last` cuts the last run on its own. Deaths are counted in the outcome. A session that ends without a victory is `stopped` and may be resumed.

`game.playback` marks the only intervals in which game time advances in the `paused-think` category: `data.phase` is `start` (with `steps`, the exact inputs about to be played) or `end` (with `ticks` played, `aborted`, `reason`). In-game time (IGT) is the sum of played ticks times the tick interval; everything between playbacks is thinking time.

Sanitisation removes: images, reasoning payloads, host/system/developer context, machine paths, e-mail addresses, credentials, IP addresses other than loopback, URLs other than loopback, original call and session identifiers. Every removal is counted in `summary.json.redactions`.

## 6. `summary.json`

Three version numbers, because three things change at their own pace and a reader must tell them apart:
`spec_version` (the standard this run claims to follow), `schema_version` (the shape of this summary) and
`bundle.bundle_version` (the packaging: which files a bundle holds and how they are named). `bundle.revision`
counts publications of the same run and `bundle.published_at` orders them, so a store keyed on
(`run_id`, `revision`) can tell an update of a run it already holds from a new one. A series may start above 1
and may have gaps: the counter belongs to the run, and earlier publications may have carried another `run_id`.

`run_uid` is that run's identifier, written once when the run is configured and never changed. A name can change
where the identifier cannot, so a reader can see that two bundles under different names are the same run.
Seeing is not deciding: whether a newer publication supersedes an entry already held is a judgement, and the
standard leaves it to whoever keeps the archive rather than merging anything on a matching field. `harness` names the
framework and every plugin with its own version, each as `{id, version}` rather than as a sentence; the runtime also
with its `name` for people (`Claude Code` for `claude-code`), which every runtime plugin declares.

Where a recording is published is not in the bundle. A run may be published in more than one place, and a stream VOD
expires where an upload keeps; the links, their platforms and when each was last confirmed are kept by the archive,
supplied by whoever submits the run. A bundle is therefore never judged on a missing link.

Schema version 2 is portal-agent's format and remains valid. Schema version 3 adds `category`, `recording` and `harness`. Schema version 4 adds the identifiers and versions a reader keys on (`run_uid`, `bundle` with its `revision`, `spec_version`) and the list forms: `recordings`, `game` with its build and mods, `harness` with its plugins. Schema version 5 drops `recordings` and `recording.url`: video links come from the archive, not from the bundle. Schema version 6, what `aas publish` writes, adds the goal by name: `ends`, `category.goal_end`, `goals` and `harness.plugins.runtime.name`.

```json
{
  "schema_version": 6,
  "time_zone": "Europe/Amsterdam",
  "run_dates": "2026-09-20 to 2026-09-20",
  "started_at": "...", "completed_at": "...", "ended_at": "...",
  "models": [{"model": "claude-fable-5-1", "reasoning_effort": "high"}],
  "requested": {"model": "claude-fable-5-1", "reasoning_effort": null, "note": null},
  "synthetic_records": 0,
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
  "category": {
    "game": "slay_the_spire", "build": "V2.3.4 + Communication Mod 1.2.1", "goal": "act3",
    "goal_end": {"id": "act3", "label": "Act 3 boss", "final": true},
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
    "black_intervals": [], "chapters": "chapters.txt",
    "igt_seconds": null, "wall_clock_seconds": 0, "thinking_seconds": 0
  },
  "totals_to_completion": {"rta_seconds": 0, "igt_seconds": 0, "thinking_seconds": 0, "playbacks": 0, "tool_calls": 0},
  "game": {
    "game": "Slay the Spire", "version": "build 2022-12-18", "platform": "Steam",
    "mods": [{"name": "CommunicationMod", "version": "1.2.1", "source": "https://...jar", "sha256": "..."}],
    "settings": {"character": "IRONCLAD", "ascension": 0, "seed": "23M", "fast_mode": true}
  },
  "harness": {
    "name": "ai-assisted-speedruns", "version": "0.1.0", "framework": "ai-assisted-speedruns 0.1.0",
    "plugins": {"game": {"id": "slay_the_spire", "version": "0.1.0"}, "runtime": {"id": "claude-code", "name": "Claude Code", "version": "0.1.0"},
                "recorder": {"id": "obs", "version": "0.1.0"}, "timer": {"id": "livesplit", "version": "0.1.0"}}
  }
}
```

`models` lists every model the API actually answered with, one entry per model seen in the session log, and `requested` is what the run asked for when it started (the runtime passes `--model`; it sets no reasoning effort, so `reasoning_effort` is null and `note` says why). The two are separate on purpose: a provider may answer with another model than the one requested — a fallback — and that must be visible in the bundle instead of hidden. `aas check` reports it when a session used a model that was not requested, or more than one model. The effort in `models[]` comes from the session log itself (a runtime that records the effort per assistant message reports it; one that does not reports null), so it is what the provider actually used, not what was asked for. `synthetic_records` counts records the runtime wrote itself (an API error, an interrupt); they carry no model and are never listed as one.

`ends` lists the game's ends as its plugin declares them, in order, each `{id, label, final}`; exactly one is final, the game's own end. `category.goal` is the published goal, and `category.goal_end` is that end with its label. `goals` lists the goals up to the published one, in order: the goal at the start and each extension by a resume that was reached, each with `declared_at` and `reached_at` (the victory while that goal held). Only the last may be unreached, when the run reached no goal at all. An extension is published once it is reached; until then the bundle keeps the goal that was reached, `completed_at` is its victory, the resume that extended it does not count on the human axis, and the extension's play is post-completion time. A run that won act 1 and was then extended to act 3 without reaching it is published as an act 1 run.

`totals_to_completion` gives the run's times to its published goal, on the recording's clock from t0: `rta_seconds`, `igt_seconds`, `thinking_seconds`, `playbacks` and `tool_calls` up to `completed_at`, or null when the run was not completed. `recording.igt_seconds`, `recording.thinking_seconds` and `timeline.json` `totals` stay the whole recording, which includes post-completion time (credits, or a goal extension that is not published). In `timeline.json` the same figures are `totals_to_completion`, `completed_rta` is the completion on the recording's clock, and every section carries `post_completion`; `splits.lss` splits only up to completion. Sections after completion stay in `chapters.txt`, because they are in the recording.

`game` is what it takes to play the same thing again: the game's own build, every mod that was loaded with the version and the pin it was installed from, and the settings of the run. A game plugin reports it; where the game itself records these (a run-history file, a save), those are the words the bundle carries.

`recording.duration_seconds` is the length of the recording and `recording.fingerprint` the sha256 of `session.sanitized.jsonl`. The fingerprint is unique to a bundle, so an archive treats a fingerprint it already holds as a resubmission of that run and not as a new entry. A platform re-encodes an upload, so the file's own hash says nothing about the video anyone can watch: the publisher puts the run id and the fingerprint in the video's description, and a verifier matches those, the duration, and a few tool calls at their `elapsed_seconds`.

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

1. The recording of this run, where the archive holds its link, is continuous from `run.started` to `run.ended`. Pauses are `run.wait` events in the timeline and visible in the recording.
2. Every `tool_call` can be located in that recording at its `elapsed_seconds`; `chapters.txt` names the sections at the same offsets, so a reader can jump to any of them.
3. `human: none` implies no `run.human` record in the published run. Any such record forces `restart-only` or `assisted`. A `run.human` record after `completed_at` that is followed by a `game.goal` belongs to a goal extension that is not published yet (§6) and does not count.
4. `tools.json`, `AGENTS.md`, `documentation.md` and `runtime-config/` are published; the agent had no tool outside `tools.json`.
5. The hashes in `manifest.json` match.
6. The bundle says what was played: `game.version` and every mod that was loaded, with the pin each was installed from, so the run can be set up again.
7. The run reached its declared goal: the timeline carries a `game.over` with `victory: true` and `summary.completed_at` names that moment. A stopped session fails this point and is not an entry.
8. The publisher measures the black intervals of the recording it made and uploaded and declares them in `summary.recording.black_intervals`, each marked when it falls in a phase the game plugin reports as `loading` or `cinematic`. Black frames are part of the recording: they are declared so a reader knows where to look, and they do not fail a run.

A run that fails any point may still be published but MUST NOT be labelled as conforming.

