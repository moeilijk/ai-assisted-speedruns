# @aas/timer-livesplit

Timer plugin for [LiveSplit](https://livesplit.org/) through the LiveSplit Server component (TCP `127.0.0.1:16834`; in LiveSplit: right-click → Control → Start Server). LiveSplit shows RTA and Game Time on screen, the OBS recorder captures it, and LiveSplit keeps the splits.

Mapping (paused-think model: game time only advances during playback):

| Run event | LiveSplit command |
|---|---|
| `run.started` | `reset`, `initgametime`, `starttimer`, `pausegametime`, `setgametime 0` |
| `game.playback` start | `unpausegametime` |
| `game.playback` end | `setgametime <IGT from ticks>`, `pausegametime` |
| `game.milestone` (chapter) | `split` |
| `run.ended` | `split` |

Use with `aas run ... --timer livesplit`. `aas publish` also writes `splits.lss` (a LiveSplit splits file with the sections, RTA and game time per segment) from the timeline, so the splits are published even without LiveSplit running. Env: `AAS_LIVESPLIT_HOST`, `AAS_LIVESPLIT_PORT`.

## Install and start

- `node packages/timer-livesplit/install-livesplit.mjs <folder>` installs LiveSplit 1.8.37 (MIT, pinned with its sha256 in [UPSTREAM.json](UPSTREAM.json)) into a folder on a Windows drive, with LiveSplit's own default settings and its server starting with it ([settings.template.cfg](settings.template.cfg); a settings file without LiveSplit's other elements is ignored by it). The GUI installs it into `%LOCALAPPDATA%\aas\LiveSplit` and sets `AAS_LIVESPLIT_EXE`. On its first start a new LiveSplit may ask whether to update its components (measured 2026-09-17: therun.gg); answer as you like, the harness does not need them.
- `npm run livesplit:launch -- <splits.lss>` starts LiveSplit with those splits (a LiveSplit that has other splits open is closed first, "Save Splits?" answered with No), waits for its server and moves its window to `AAS_LIVESPLIT_POS`.
