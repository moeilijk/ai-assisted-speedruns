# ai-assisted-speedruns

A plugin framework and an open standard for **AI Assisted Speedruns**: an LLM agent plays a game through a small, hardened tool interface, every decision is logged on one timeline, the run is recorded, and the result is published in a form anyone can verify and compare.

Three kinds of plugins, one core:

| Plugin | Role | First implementations |
|---|---|---|
| **game** | exposes one game as a controller object plus API documentation | Portal (via cozyblaze/portal-agent), Slay the Spire (via Communication Mod); Kerbal Space Program (kRPC) planned |
| **runtime** | starts the agent against the broker with a hardened config | Codex, Claude Code |
| **recorder** | records the run and reacts to run events | OBS (obs-websocket v5), source-demo (in-game demo via SPT), null |
| **timer** | speedrun timer on screen and splits | LiveSplit (LiveSplit Server) |

The agent only ever sees three tools per game: `<game>_documentation`, `<game>_screenshot`, `<game>_exec`. That shape, the broker, the process hardening and the log/export format come from [cozyblaze/portal-agent](https://github.com/cozyblaze/portal-agent) (MIT), which is credited as their origin and is not affiliated with this project.

## Disclaimer: anti-cheat, bans, your own risk

This framework drives a game with injected tooling (for Portal: SourcePauseTool's DLL and an IPC patch, with the game started outside the normal launcher). Anti-cheat and monitoring systems such as VAC, EAC or BattlEye can treat that as cheating and **ban the account, possibly permanently**. Use it only with games and builds that have no anti-cheat and no online component, never with online or competitive games, and preferably with a separate offline copy of the game (Portal here runs from Source Unpack, not from the Steam install). Do your own research on the game's terms and anti-cheat before you connect anything, use common sense, and accept that everything you do with this repository is at your own risk: the authors take no responsibility for bans, lost accounts or other damage.

## Quick start (Portal)

Machine settings (OBS password, game folders, optional window positions) live in `.env` in the repository root: copy `.env.example`, fill it in. Every `npm run` script and the `aas` CLI load it themselves (a variable already set in the shell wins). `aas doctor` shows what is missing.

```bash
npm test                                   # everything against a fake SPT and a fake LiveSplit
npm run portal:fetch                       # clone portal-agent at the pinned commit into .local/
npm run portal:install -- --game-root <Source_Unpack dir>   # Windows: spt.dll + cfgs into the unpack
npm run portal:doctor                      # game files, SPT / OBS / LiveSplit reachable, OBS auth
npm run portal:check                       # game running: connection check through the broker
npm run portal:run -- <runs>/portal-01       # OBS recording, LiveSplit, overlay, Claude Code; closes the game, LiveSplit, OBS and a Steam it started when the run ends (--keep-open leaves them)
node packages/core/src/cli.mjs timeline <runs>/portal-01     # RTA / IGT / sections / cut list
node packages/core/src/cli.mjs render <runs>/portal-01       # ffmpeg: the video without the thinking pauses
node packages/core/src/cli.mjs publish <runs>/portal-claude-code-01 <runs>/public/portal-claude-code-01   # the bundle for the archive, plus the upload zip (the video is linked, not packed)
```

`aas` subcommands: `configure`, `run`, `resume`, `start`, `doctor`, `check-connection`, `timeline`, `render`, `publish`, `check`, `scan`, `export-claude-session`, `export-codex-rollout`.

See [games/portal/README.md](games/portal/README.md) for the game-side setup and the Windows/WSL note.

## Layout

```
packages/
  core/                 broker, hardening, run log, run/timeline/publish/check, exporters, `aas` CLI
  spec/                 AAS-spec 0.1 + JSON Schemas (later)
  recorder-source-demo/ in-game Source demo via SPT IPC (start_run / stop_run)
  recorder-obs/         obs-websocket v5 recorder: scenes per phase, chapters, replay buffer, no mic
  recorder-null/        no recording; development only, never a valid run
  timer-livesplit/      LiveSplit Server client + .lss export
  runtime-codex/        Codex config generator + launcher
  runtime-claude-code/  Claude Code config generator + launcher
  runtime-scripted/     a bot module through the same broker (baselines, chain tests)
games/
  slay-the-spire/       second game plugin: turn-based, through Communication Mod (bridge, install, launch, splits per act)
  portal/               adapter around portal-agent's controller
docs/
  design.md
```

## Requirements

Node.js 22 or newer (24+ recommended, matching portal-agent). No `npm install` is needed for the core.

For runs with the Claude Code runtime: Claude Code 2.1.207 or newer, started once interactively on the machine (that creates its config file). `aas run` marks every run directory as trusted in that file, because Claude Code applies the allow rules of a run's settings only in a trusted directory; `aas doctor --runtime claude-code` and `npm run claude:smoke` check that this works, and a run in which Claude Code reports ignored rules is stopped and not valid (see [packages/runtime-claude-code/README.md](packages/runtime-claude-code/README.md)).

## Rules that apply to every game in this repository

- Games are bought and installed legally. The game installation is never modified; anything that needs editing is copied to a work directory first.
- The agent gets no web access, no shell, and can write only inside the run directory.
- A run without a recording is not a valid run.

## License

MIT, see [LICENSE](LICENSE). Code derived from [cozyblaze/portal-agent](https://github.com/cozyblaze/portal-agent) (MIT) is listed in [packages/core/NOTICE](packages/core/NOTICE).

The archive of published runs is at [ai-assisted-speedruns.org](https://ai-assisted-speedruns.org); a run is uploaded there as the bundle `aas publish` writes (see [docs/reference.md](docs/reference.md)).
