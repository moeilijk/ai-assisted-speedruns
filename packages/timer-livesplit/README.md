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

- `node packages/timer-livesplit/install-livesplit.mjs <folder>` installs LiveSplit 1.8.37 (MIT, pinned with its sha256 in [UPSTREAM.json](UPSTREAM.json)) into a folder on a Windows drive, with LiveSplit's own default settings and its server starting with it ([settings.template.cfg](settings.template.cfg); a settings file without LiveSplit's other elements is ignored by it). The GUI installs it into `%LOCALAPPDATA%\aas\LiveSplit` and sets `AAS_LIVESPLIT_EXE`. LiveSplit checks for updates of itself and of every component at every start, and asks (measured 2026-09-17: therun.gg 0.4.5, newer than the one in the 1.8.37 zip); it has no setting for that. It also asks for administrator rights at every start while the `.lss`/`.lsl` file types point at another LiveSplit. `node packages/timer-livesplit/windows-setup.mjs <LiveSplit.exe>` (the GUI does it after the install) asks Windows for permission once and then blocks this LiveSplit's outbound network (its update check fails quietly; the harness needs the pinned version, not updates) and registers the file types with LiveSplit's own `LiveSplit.Register.exe`. Its server keeps working: the harness connects over 127.0.0.1, measured after the rule. Windows' own question about the server's inbound network access is left to you.
- `npm run livesplit:launch -- <splits.lss>` starts LiveSplit with those splits (a LiveSplit that has other splits open is closed first, "Save Splits?" answered with No), waits for its server and moves its window to `AAS_LIVESPLIT_POS`.
