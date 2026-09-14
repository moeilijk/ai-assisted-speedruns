# @aas/recorder-obs

Recorder plugin for OBS Studio through obs-websocket v5, on Node's built-in WebSocket client (no dependencies). Game-independent: the game plugin's `processName` drives the game capture and the application audio capture; run events drive scenes, chapters and the replay buffer. It is the earlier, unpublished Zero Company OBS design made generic.

## What it builds (idempotently, through the API)

Scene collection `AAS-<game>` with scenes `<Game>-Game` and `<Game>-Game-Clean` and inputs:

| Input | Kind | Scenes |
|---|---|---|
| `<Game> Game Capture` | `game_capture`, window match `::<processName>`, audio off | Game, Game-Clean |
| `<Game> Game Audio` | `wasapi_process_output_capture` of `<processName>` (only the game is heard) | Game, Game-Clean |
| `<Game> LiveSplit` | `window_capture` of the LiveSplit window | Game |
| `<Game> Overlay` | `browser_source` with the `aas run --overlay-port` page (timers, keys, agent action) | Game |

**Hard rule: no microphone.** In its own collection the plugin removes the Mic/Aux that OBS adds by default; a microphone anywhere else aborts the run.

## Run events → OBS

| Event | Call |
|---|---|
| preflight | `GetVersion`, build/verify the collection, no mic, not already recording |
| start | `SetRecordDirectory` (the run's `recording/` when it is on a Windows drive), `FilenameFormatting AAS_<run>_…`, Game scene, `StartRecord`, t0 = `RecordStateChanged STARTED`, `StartReplayBuffer`, Game scene after `introSeconds` |
| `game.phase` cinematic/loading | Game-Clean scene; otherwise Game |
| `game.playback` start | Game scene |
| `game.milestone` (chapter) / `game.attempt` | `CreateRecordChapter` + chapter list |
| `game.highlight` | `SaveReplayBuffer` |
| stop | after `outroSeconds`: `StopRecord` (output path), `StopReplayBuffer` |

**The recording is checked, not assumed, at the start of the run.** Right after `StartRecord` the recorder reads `GetRecordStatus` until the output is active and its size grows; a recording OBS says it started but does not write (a full disk, a failing encoder) stops the run within ten seconds. Then it asks OBS for its own rendering of the game window source (`GetSourceScreenshot`, 320x180 PNG, decoded to pixels by [png-luma.mjs](png-luma.mjs)) every two seconds. Black for ten seconds: the capture is rebound once and checked for ten seconds more; still black: `start` throws, and `aas run` stops and discards the recording, logs `run.error` and closes everything. A window capture can bind to a window that is gone and then deliver a frozen or empty picture while the game plays on, and OBS's log says nothing about it. A source OBS cannot render at all fails the same way: no picture is no evidence. Nothing about black frames is measured after the run: what the published video shows is for the archive to judge.

Env: `AAS_OBS_URL` (default `ws://127.0.0.1:4455`), `AAS_OBS_PASSWORD` (OBS → Tools → WebSocket Server Settings). Under WSL, Windows paths from OBS are translated with `wslpath`, so `aas run` can copy the file into `recording/`.
