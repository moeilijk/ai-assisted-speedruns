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
