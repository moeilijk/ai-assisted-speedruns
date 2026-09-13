# Portal (via cozyblaze/portal-agent)

A thin adapter that loads [portal-agent](https://github.com/cozyblaze/portal-agent)'s controller (MIT) as an AAS `GamePlugin`. Portal-agent's published `evidence/` serves as a format fixture for the spec (it is not an entry and they are not affiliated with this project), and their SourcePauseTool (SPT) patch is the in-game side. Nothing of theirs is vendored: [fetch-portal-agent.mjs](fetch-portal-agent.mjs) clones the commit pinned in [UPSTREAM.json](UPSTREAM.json) into `.local/portal-agent`.

| | |
|---|---|
| id / scope | `portal`; inside `portal_exec` the controller is in scope as `portal` (and `game`) |
| category | `portal · credits · vision · input · paused-think · none` (build: Source Unpack 2.6, build 5135, SPT patch `31311b8`) |
| endpoint | SPT IPC at `127.0.0.1:27182` (`AAS_PORTAL_SPT_HOST` / `AAS_PORTAL_SPT_PORT`) |
| recorder | `obs` (video with LiveSplit and the live overlay; the YouTube source) or `source-demo` (the in-game demo that `start_run` / `stop_run` drive) |
| process | `hl2.exe` |

## 1. Game side (Windows, unchanged from portal-agent)

Follow portal-agent's [setup guide](https://github.com/cozyblaze/portal-agent/blob/main/docs/setup.md) steps 1 and 2: Source Unpack 2.6, Visual Studio with C++ tools, then from **their** checkout (`.local/portal-agent` after `npm run portal:fetch`) in PowerShell:

```powershell
cd .local\portal-agent
powershell -NoProfile -ExecutionPolicy Bypass -File tools/prepare-spt.ps1   # clones SPT into .local/SourcePauseTool and applies their patch
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-spt.ps1
cd ..\..
npm run portal:install -- --game-root <Source_Unpack dir>                  # spt.dll, spt.vdf, agent_run.cfg, portal_agent.cfg, exec line
```

Start the game with `npm run portal:launch` (hl2.exe with the Portal.bat arguments plus `-w 1920 -h 1080` from `AAS_PORTAL_RESOLUTION`, default 1920x1080, so the borderless window matches the recording canvas; Portal.bat itself leaves the size to the engine and may span two screens). Everything machine-specific (window position, quiet audio device, keeping displays awake) is off unless set in `.env`; see `.env.example`. **Steam must be running and logged in** with Portal in the library, or hl2.exe fails with "CFileSystem_Steam::Init() failed". The autoexec runs `exec portal_agent`, which enables the SPT IPC. `start_run` (a new game **plus the demo recording**, then TAS-pause) is sent by the source-demo recorder when `aas run` starts; `stop_run` when the agent is done. Both still work by hand in the console.

## 1b. Windows tools

| Tool | Where | Note |
|---|---|---|
| Source Unpack 2.6 | any folder, `AAS_PORTAL_GAME_ROOT` | downloaded from the Source Unpack site; requires owning Portal on Steam |
| LiveSplit 1.8.37 | any folder, `AAS_LIVESPLIT_EXE` | `settings.cfg` has `ServerStartup=1`, so its TCP server (port 16834) starts with LiveSplit. Open [splits/portal-credits.lss](splits/portal-credits.lss) in it: one split per test chamber (00 … 19, e00, e01, e02). The community preset splits per map ("00/01", …) because its autosplitter only sees level changes; here the chamber comes from the player's position against the maps' own markers (the chamber's number sign at its entrance, or the top of the in-map elevator; `chambers.json`, generated from the map files by `extract-chambers.mjs`), so a fast run stays measurable per chamber. Every playback result and observation feeds the tracker; a new chamber is a `game.milestone` and a split. `demo-track.mjs <run-dir>` reads the run's demos (`<run>/demos/`, copied after the run) for the exact per-tick position track and prints the chamber entries with their in-game time, the ground truth to check the live splits against, so the sections show on screen. Without a splits file LiveSplit shows only the timer |
| OBS 32.2.2 | installed; WebSocket server enabled in `plugin_config/obs-websocket/config.json`, password in `.env` | the recorder builds scene collection `AAS-portal` itself |
| VS Build Tools 2022 + CMake | `C:\BuildTools` | enough for portal-agent's `build-spt.ps1` |

## 2. Harness side

```bash
npm run portal:fetch                                   # clone portal-agent at the pinned commit
npm run portal:doctor                                  # read-only: game files, SPT port, OBS, LiveSplit
npm run portal:check                                   # broker → controller → SPT: handshake, observe, screenshot, camera turn, 10 ticks
export AAS_PORTAL_GAME_ROOT=/mnt/<drive>/<path>/Source_Unpack   # where portal/agent_runs/ is (or in .env)
npm run portal:run -- <runs>/portal-01                   # = aas run --runtime claude-code --recorder obs --timer livesplit --overlay-port 8765; closes the game, LiveSplit, OBS and a Steam it started when the run ends (--keep-open leaves them)
```

With `--recorder obs` the video comes from OBS (game capture of `hl2.exe`, game audio only, LiveSplit window and the overlay page in the scene). In both cases the Portal plugin sends `start_run` itself after the recorder started (`prepareRun`: new game, in-game demo recording, wait until TAS-paused) and `stop_run` after the agent stopped (`endRun`). portal-agent's SPT patch refuses console commands over IPC on purpose, so the harness uses the Source engine's `hl2.exe -game portal -hijack +start_run`, which hands the command to the running instance; `--recorder source-demo` collects those `.dem` files as the recording instead of a video. Run directories live under the OBS recording folder, `<recording drive>\<Game>\<run-id>` (`<runs>/portal-01` below), so OBS records straight into `<run>/recording/`; nothing else is created on that drive.

`--overlay-port 8765` serves the live overlay (RTA, IGT, section, keys being played, last agent action) at `http://127.0.0.1:8765/`; the OBS recorder adds it as a browser source. `aas run` configures the run directory (hardened `.mcp.json` + `.claude/settings.json`, portal-agent's `run/AGENTS.md` verbatim as CLAUDE.md, `brief.json` with the category), starts the OBS recording (t0), sends `start_run` and waits for the game to be TAS-ready, starts LiveSplit's timer, starts Claude Code in the run directory, forwards `game.playback`/`game.milestone` events to OBS (scenes, chapters) and the timer, and after Claude Code exits sends `stop_run`, stops OBS and copies the video into `runs/portal-01/recording/`.

Runs on the Claude plan may only use part of the weekly limit: `aas budget` shows the stand (the same endpoint as Claude Code's `/usage`, with the OAuth token from `~/.claude/.credentials.json`, which only goes to api.anthropic.com); `aas run`/`aas resume` refuse to start when the week is at or above `AAS_BUDGET_WEEKLY_MAX` (percent, default 50), a running session is interrupted (with a save, resumable) when it crosses it, and `aas doctor` shows the row. `--ignore-budget` skips the guard.

`aas run` starts Claude Code interactively in your terminal. From a non-interactive shell, or for a bounded test, add `--headless --max-turns 40` (turn budget) and/or `--max-minutes 300` (wall-clock budget; the session is interrupted like Ctrl-C, the game is saved, and `aas resume` continues it): `claude -p` gets the goal prompt, progress is streamed to stderr, and the result lands in `claude-result.json`.

Before the run: Portal running with `exec portal_agent` done in its console; OBS running (the recorder builds its scene collection); LiveSplit running (its server starts automatically, see 1b). The agent gets portal-agent's original goal as its first prompt (`goalPrompt` in the plugin; `aas configure --prompt` overrides it). Leave out `--timer livesplit` if LiveSplit is not running; use `--runtime codex` for Codex. `--instructions <file>` and `--goal` override the defaults.

The broker runs under `node --permission`: it may read only `packages/core`, `games/portal` and the portal-agent checkout, write only the run directory, and connect only to the SPT endpoint. Every tool call lands in `<run>/run.jsonl`, screenshots under `<run>/screenshots/`.

Give the agent the original goal:

> You are controlling Portal. Your goal is to progress through the game and reach the end credits. Do not cheat/look up information about the game online.

### Contained: the run must not touch the desktop you work on

- **Capture**: the OBS recorder captures only the game window and the LiveSplit window (Windows Graphics Capture), plus its own overlay page. Nothing else on screen is recorded. OBS's game-capture hook shows nothing on this machine (antivirus), which is why window capture is used.
- **Displays** (optional): start the game on a secondary display and put LiveSplit next to it with `AAS_PORTAL_WINDOW_POS=X,Y`, `AAS_PORTAL_RESOLUTION=1920x1080` and `AAS_LIVESPLIT_POS=X,Y` in `.env` (coordinates of that display on the Windows desktop), then `npm run portal:launch` and `node games/portal/place-windows.mjs`. WGC captures the window there even when it has no focus. Without these the game opens where Windows puts it.
- **Sound** (optional): `AAS_QUIET_AUDIO_DEVICE=<playback device name>` with `AAS_SOUNDVOLUMEVIEW=<path to SoundVolumeView.exe>` makes the launcher switch the Windows default playback device to that device only while the game opens its audio, then restores it; the recording captures the game's audio session either way. `AAS_KEEP_DISPLAYS_AWAKE=1` keeps the displays on during a run (an HDMI audio device vanishes when its display sleeps).
- **Focus**: `start_run`, `stop_run` and saves go through `hl2.exe -hijack`, which was verified not to bring the game to the foreground. The agent (Claude Code) runs headless in WSL; OBS sits in the tray.
- **Not contained yet**: the game window is borderless and grabs the mouse while it has focus; click on your own display to give focus back. Sound: only the game's audio is captured (application audio capture), so your own audio never lands in the recording.

### Where does the harness run?

SPT listens on `127.0.0.1:27182` **inside Windows**, and so will LiveSplit Server (16834) and obs-websocket (4455). From WSL 2 in the default NAT mode, `127.0.0.1` is WSL's own loopback, so the broker cannot reach any of them.

**Decision 2026-09-09: harness in WSL with mirrored networking.** `%USERPROFILE%\.wslconfig` contains

```
[wsl2]
networkingMode=mirrored
```

and after `wsl --shutdown` (from PowerShell) Windows loopback is shared with WSL, so all three services are reachable at `127.0.0.1`. Needs Windows 11 22H2 or newer (this machine: build 26200, WSL 2.6.1). The alternative, the harness natively on Windows, needs nothing else than Node 22+ and the agent CLI on Windows; the scripts are plain Node and run there unchanged.

`AAS_PORTAL_SPT_HOST` exists for other topologies, but SPT binds to loopback, so a different host only works with a port forward.

**Runtime for the first run: Claude Code** (installed under the active Node version; the generated config is verified headless against the fake SPT, see [runtime-claude-code](../../packages/runtime-claude-code/README.md)). Codex is the second run: it is portal-agent's own reference setup, but needs `npm install -g @openai/codex@latest` first (0.153.4+; installed here is 0.101.0 under other nvm Node versions).

### Save states and resuming

`aas run` writes a save state (`hl2.exe -hijack +save aas_<run>_NNN`, copied into `<run>/saves/`) after every map transition, every 10 minutes while no playback is running (`--autosave-minutes`), and when the session ends; each is a `game.saved` event. When the agent's turn budget or your time runs out:

```bash
node packages/core/src/cli.mjs resume --run-dir <runs>/portal-02 --recorder obs --timer livesplit --overlay-port 8765 --headless --max-turns 40
```

`resume` starts a new recording segment, sends `start_run`, loads the last save (`--save` picks another), waits until the game is TAS-paused, and continues the same Claude Code session (`claude --resume <session id>`) with a short harness notice. The resume is a `run.human` record, so `aas publish` labels the category `restart-only`; `aas timeline` and `aas render` treat the segments as one run (RTA is the sum of the segments, the downtime in between is not part of it).

## 3. After the run

`npm run obs:launch` starts OBS in the tray with `--disable-shutdown-check` (a forced kill otherwise leaves a crash dialog that blocks the WebSocket server). `npm run portal:stop` closes Portal (after `stop_run`), LiveSplit and OBS (waiting up to 30 s for a clean exit); add `-- --steam` to shut Steam down too. Run it at the end of every session: nothing the harness started stays behind on the desktop.


```bash
node packages/core/src/cli.mjs timeline <runs>/portal-01
node packages/core/src/cli.mjs render <runs>/portal-01 [--burn timers,inputs]      # YouTube video: playbacks only, pauses cut
node packages/core/src/cli.mjs publish <runs>/portal-01 <runs>/portal-01-public --completion-marker "Reached the end credits"
```

`render` runs ffmpeg on the OBS recording with the cut list, so the video contains only the moments the game was playing; `chapters.cut.txt` has the YouTube chapters for that video. `--burn` adds the timers and the keys as burned-in subtitles for runs where LiveSplit or the overlay were not in the scene.

`timeline` prints RTA, IGT (sum of played ticks), thinking time and the sections (one per map transition), and writes `runs/portal-01/timeline/`: `chapters.txt`, `cut.sh` + `cut.ffmpeg.txt` (ffmpeg keeps only the playbacks with 0.5 s margins, so the thinking pauses disappear from a video recording), `timers.srt` and `inputs.srt` (RTA/IGT and the keys held, in cut-video time), `splits.lss`.

`publish` finds the Claude Code session log for the run directory, exports it sanitized, adds the schema 3 summary (category, recording, harness), copies tools.json, AGENTS.md, documentation.md, runtime-config/, game-config/ (portal-agent's cvars and SPT upstream reference), recording/, chapters.txt, timeline.json and splits.lss, writes manifest.json, scans for private data and runs `aas check`. Review the output before sharing it.

`aas check` against portal-agent's own evidence reports: timeline and summary valid (schema 2), the other required files missing, exactly as the conformance table in the spec says.

## Testing without the game

`games/portal/test/fake-spt.mjs` speaks SPT's wire protocol (NUL-framed JSON over TCP: `observe`, `look_delta`, `tas_run`, `tas_abort`, `screenshot` as rgb8 chunks). `npm test` runs the real broker under `node --permission` with the real portal-agent controller against it, plays the TAS plan from their AGENTS.md, and checks the screenshot, the log and the sandbox.
