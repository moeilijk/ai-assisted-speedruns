# ai-assisted-speedruns

A plugin framework and an open standard for **AI Assisted Speedruns**: an LLM agent plays a game through a small, hardened tool interface, every decision is logged on one timeline, the run is recorded, and the result is published in a form anyone can verify and compare.

Three kinds of plugins, one core:

| Plugin | Role | First implementations |
|---|---|---|
| **game** | exposes one game as a controller object plus API documentation | Portal (via cozyblaze/portal-agent), Slay the Spire (via Communication Mod); Kerbal Space Program (kRPC) planned |
| **runtime** | starts the agent against the broker with a hardened config | Codex, Claude Code, scripted (a bot module, for baselines) |
| **recorder** | records the run and reacts to run events | OBS (obs-websocket v5), source-demo (in-game demo via SPT), null |
| **timer** | speedrun timer on screen and splits | LiveSplit (LiveSplit Server) |

The agent only ever sees three tools per game: `<game>_documentation`, `<game>_screenshot`, `<game>_exec`. That shape, the broker, the process hardening and the log/export format come from [cozyblaze/portal-agent](https://github.com/cozyblaze/portal-agent) (MIT), whose Portal run gave this project its idea; this project is maintained separately.

## What the tooling does

- **Runs an agent against a game, hardened.** The broker is an MCP server with exactly those three tools, running under `node --permission`: it may read the core and the game plugin, write only the run directory, and open a socket only to the endpoints the game plugin declares. Shell, web and everything else is denied in the agent's own configuration, and a runtime whose permission rules were ignored stops the run.
- **Records the run and proves there is a picture.** The recorder builds its own OBS scene collection (the game window, the game's audio, the timer, a live overlay), refuses a microphone, and checks OBS's own rendering of the game source at the start; at publish time every recording is measured for black intervals, which the bundle declares; black frames are part of the recording and do not fail a run.
- **Keeps one timeline.** Tool calls, agent messages and events from the harness, the game plugin and the recorder all land in one append-only log on one clock: `aas timeline` derives RTA, in-game time, thinking time, sections, attempts and the cut list from it, and writes subtitles and a chapter list.
- **Owns the goal.** The game plugin declares the game's ends in order (one of them the game's own); the harness resolves the goal, declares the victory when that end's milestone goes by, and `aas resume --goal` can only extend a goal to a later end, logged as a human intervention.
- **Times the run.** In the `paused-think` model game time advances only while the game is actually playing, so an agent's thinking costs wall clock but not in-game time; the timer and the video follow the same intervals.
- **Survives an interruption.** The game is saved every ten minutes, at every chapter and at the end; `aas resume` restores the save, resumes the agent's own session, records a new segment and records that a human intervened.
- **Stays inside a budget.** Every runtime reports its own plan's stand; a run refuses to start above the limit and a running session is interrupted with a save when it crosses it.
- **Closes what it opened.** At the end of a run the game, the timer, the recorder and a Steam the launcher started are closed the way a user would, and what stays open is reported.
- **Cuts the video.** `aas render` removes the thinking pauses with ffmpeg, concatenates the segments of a resumed run, and can burn in the timers and the keys being played.
- **Publishes a checkable bundle.** `aas publish` turns the private run directory into the public bundle: the sanitised timeline with the harness's events merged in, a machine-readable summary (identifiers, versions, category, the game's build and mods, the recording's platform and fingerprint), the agent's instructions and tool definitions, the hardened configuration with machine paths replaced, chapters, splits, and a manifest with a hash per file — plus one zip to upload. It refuses to publish anything the privacy scan flags, and can sign the bundle with the publisher's own ed25519 key (`aas key` makes one) for anyone who wants their publications tied to one key — a marker, not a requirement: who published a run is what an archive's account says.
- **Checks it, and lets anyone else check it.** `aas check` verifies the bundle marker, the files, the timeline format, the summary schema, every hash, the signature, whether the run reached its declared goal, whether a recording was made and carries the fingerprint that binds it to this bundle, and which black intervals it declares.

## Disclaimer: anti-cheat, bans, your own risk

This framework drives a game with injected tooling (for Portal: SourcePauseTool's DLL and an IPC patch, with the game started outside the normal launcher). Anti-cheat and monitoring systems such as VAC, EAC or BattlEye can treat that as cheating and **ban the account, possibly permanently**. Use it only with games and builds that have no anti-cheat and no online component, never with online or competitive games, and preferably with a separate offline copy of the game (Portal here runs from Source Unpack, not from the Steam install). Do your own research on the game's terms and anti-cheat before you connect anything, use common sense, and accept that everything you do with this repository is at your own risk: the authors take no responsibility for bans, lost accounts or other damage.

## Install

Prerequisites, step by step, and how to verify each layer: **[docs/install.md](docs/install.md)**. The short version:

```bash
git clone https://github.com/moeilijk/ai-assisted-speedruns.git && cd ai-assisted-speedruns
node -v && npm test          # Node 22+; the whole suite runs against fakes, no game needed
cp .env.example .env         # machine settings (OBS password, game folders, budgets)
npm run claude:smoke         # the agent runtime and its permissions, against a fake game
```

Then the game's own side ([Slay the Spire](games/slay-the-spire/README.md), [Portal](games/portal/README.md)), OBS, and a first run:

```bash
aas doctor --game games/slay-the-spire/plugin.mjs --recorder obs --timer livesplit --runtime claude-code
aas check-connection --game games/slay-the-spire/plugin.mjs --run-dir <runs>/check --exercise
aas run --runtime claude-code --game games/slay-the-spire/plugin.mjs --run-dir <runs>/sts-claude-code-01 \
        --recorder obs --timer livesplit --overlay-port 8765 --goal act1 --headless --max-minutes 60
aas timeline <runs>/sts-claude-code-01
aas render   <runs>/sts-claude-code-01
aas publish  <runs>/sts-claude-code-01 <runs>/public/sts-claude-code-01
aas check --strict <runs>/public/sts-claude-code-01
```

`aas` commands: `configure`, `run`, `resume`, `start`, `doctor`, `check-connection`, `budget`, `timeline`, `render`, `publish`, `check`, `scan`, `key`. Every command works the same whatever game, agent, recorder or timer is loaded; what each one does and leaves behind is in [docs/reference.md](docs/reference.md).

## Documentation

| Document | What is in it |
|---|---|
| [docs/install.md](docs/install.md) | prerequisites and the installation, step by step, per level; troubleshooting |
| [docs/reference.md](docs/reference.md) | every command, the settings, the run directory, the bundle, the events |
| [docs/plugins.md](docs/plugins.md) | how to write a game, runtime, recorder or timer plugin |
| [docs/design.md](docs/design.md) | the architecture and the decisions behind it |
| [packages/spec/SPEC.md](packages/spec/SPEC.md) | the standard: what a published run must contain and how it is checked |

## Layout

```
packages/
  core/                 broker, hardening, run log, run/resume/timeline/render/publish/check, exporters, `aas` CLI
  spec/                 the AAS standard + JSON Schemas (later)
  recorder-source-demo/ in-game Source demo via SPT IPC (start_run / stop_run)
  recorder-obs/         obs-websocket v5 recorder: scenes per phase, chapters, replay buffer, no mic
  recorder-null/        no recording; development only, never a valid run
  timer-livesplit/      LiveSplit Server client + .lss export
  runtime-codex/        Codex config generator, launcher, plan budget, rollout export
  runtime-claude-code/  Claude Code config generator, launcher, trust, plan budget, session export
  runtime-scripted/     a bot module through the same broker (baselines, chain tests)
games/
  slay-the-spire/       turn-based, through Communication Mod (bridge, install, launch, splits per act)
  portal/               adapter around portal-agent's controller
docs/                   install, reference, plugins, design
```

## Rules that apply to every game in this repository

- A game gets only what its plugin needs for the run: the original tooling the plugin is built on, installed as its authors publish it, and the settings the recording needs. No cheats, mods or settings beyond that original tooling. Each game's README lists what is added to the game and what is changed.
- The agent gets no web access, no shell, and can write only inside the run directory.
- A run without a recording is not a valid run.

## License

MIT, see [LICENSE](LICENSE). Code derived from [cozyblaze/portal-agent](https://github.com/cozyblaze/portal-agent) (MIT) is listed in [packages/core/NOTICE](packages/core/NOTICE).

The archive of published runs is at [ai-assisted-speedruns.org](https://ai-assisted-speedruns.org); a run is uploaded there as the zip `aas publish` writes next to the bundle (see [docs/reference.md](docs/reference.md)).
