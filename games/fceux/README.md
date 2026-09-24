# FCEUX

NES games on the [FCEUX](https://github.com/TASEmulators/fceux) emulator, the emulator most NES TAS movies were made
on, through the bridge of [fceux-mcp](https://github.com/IngvarKofoed/fceux-mcp) by IngvarKofoed: a Lua script
inside FCEUX that answers on `127.0.0.1:9999`. The plugin keeps FCEUX paused between the agent's moves; the game runs
only while the agent's buttons play, frame by frame, so in-game time is the frames played divided by FCEUX's own NTSC
frame rate (1008307711 / 2^24, about 60.0988 a second).

One plugin, one profile per game (`profiles/<id>.json`, chosen with `AAS_FCEUX_PROFILE`). A profile names:

- the ROM by its SHA-1 (the whole file, which the doctor checks) and by the MD5 FCEUX itself reports (its PRG and CHR
  data, which the run checks when it starts), with its maker, license and source. ROMs are never in this repository:
  put yours in `.local/roms/` (or point `AAS_FCEUX_ROM` at it); a run starts only on the exact dump the profile names;
- the game's ends as conditions on the NES CPU's memory, from a published RAM map, a disassembly or the game's own
  source, and measured in FCEUX;
- what the agent is told (controls, goal), and the inputs of the mock run.

| | |
|---|---|
| id | `fceux` |
| upstream | FCEUX 2.6.6, the official 64-bit Windows build (GPL-2.0-or-later), and fceux-mcp's bridge through our fork [moeilijk/fceux-mcp](https://github.com/moeilijk/fceux-mcp) (MIT); both pinned in [UPSTREAM.json](UPSTREAM.json) and not redistributed |
| profiles | `smb`: Super Mario Bros., your own ROM; ends per world and the game's end (the axe in 8-4), from [periwinkle9's autosplitter](https://github.com/periwinkle9/smb-autosplitter) (Zlib); its mock replays the TAS [#3728](https://tasvideos.org/3728M) by HappyLee & Mars608 (CC BY 2.0, tool-assisted) to the end |
| | `nes15` (test): the Fifteen Puzzle by Mathew Brenaman, BSD-2-Clause, [source](https://github.com/christopherpow/nes-test-roms/tree/master/nes15-1.0.0); end `solved` (play_state, RAM 0x2F, = 3) |
| category | `observation: full`, `input: input`, `timing: paused-think` |

## Set up

1. `npm run fceux:install` downloads FCEUX and the bridge into `%LOCALAPPDATA%\aas\FCEUX` (or `AAS_FCEUX_DIR`), each
   checked by sha256. FCEUX asks nothing on the way.
2. The install also downloads the test profile's ROM (nes15, BSD-2-Clause) into `.local/roms/`. For any other
   profile, put your own dump of the game there. `npm run fceux:doctor` checks it by its SHA-1.

## Commands

```bash
npm run fceux:install                                   # once: FCEUX 2.6.6 and the bridge, pinned; the nes15 ROM
npm run fceux:doctor                                    # read-only: FCEUX, the profile's ROM, OBS, LiveSplit, runtime

# start (AAS_FCEUX_PROFILE picks the profile; nes15 is the default)
npm run fceux:launch                                    # FCEUX with the profile's ROM and the bridge on 127.0.0.1:9999
npm run obs:launch
npm run livesplit:launch -- games/fceux/splits/nes15-solved.lss   # smb: smb-credits.lss, or smb-world1.lss … smb-world7.lss

# a run
npm run fceux:tas -- smb                                # once, for the smb mock: the TAS movie into .local/tas
npm run fceux:scripted -- <runs>/nes15-mock-01          # the chain with bot.mjs, no model
npm run fceux:scripted -- <runs>/smb-mock-01 --goal credits         # smb to the end; without --goal it stops at World 1
npm run fceux:run -- <runs>/smb-01 --headless --max-minutes 60      # Claude Code (budget guard applies)

# after
node packages/core/src/cli.mjs timeline <runs>/nes15-mock-01
node packages/core/src/cli.mjs publish <runs>/nes15-mock-01 <runs>/public/nes15-mock-01
npm run fceux:stop                                      # only when something stayed open
```

## The bridge

fceux-mcp's bridge is made for FCEUX on macOS; our fork adds what a run on Windows needs, and offers it upstream:

- Windows: the win32 and win64 builds of FCEUX have LuaSocket's core built in, and start a script with `-lua`, not
  `--loadlua`. The win64-QtSDL build ships no LuaSocket, and FCEUX's Lua does not export its C API, so none can be loaded
  there, and the bridge talks through files in a folder instead; this plugin's client does that when
  `AAS_FCEUX_BRIDGE_DIR` names the folder. The plugin itself installs and starts the win64 build.
- A pause that keeps FCEUX's window alive. The bridge paused the game by looping on its socket without handing control
  back to FCEUX, so the window stopped drawing and could not be closed. Now FCEUX's own pause holds the game, and the
  bridge reads its socket from a `gui.register` callback, which FCEUX runs while paused.
- Held buttons: `joypad.set` holds a button for one frame, so `emu.step` takes steps of buttons and frames and sets
  the whole controller on every frame. Measured: TASVideos #3728 (67,117 frames) played this way, 600 frames a call,
  gives the same world, level, position and game state as FCEUX's own playback of the movie after every call.
- Several clients at once (the run plays from one process and saves from another), `emu.exit` to close FCEUX the way a
  user would, savestates as files, a screenshot of the emulated frame without anything FCEUX draws over it, and
  `FCEUX_BRIDGE_DISABLE` to switch off what the agent never needs (Lua code, memory writes, loading a ROM).

## The mock

A profile's mock replays the input of a published TAS movie through the same buttons the agent has, frame by frame,
from power-on (`bot.mjs`), the movie's reset on frame 0 included; the agent itself cannot play a movie.
`npm run fceux:tas -- <profile>` makes the movie ready in `.local/tas` (downloaded from TASVideos, pinned by sha256).
FCEUX plays an `.fm2` as it is.

## What the launcher sets in FCEUX

`npm run fceux:launch` starts FCEUX with the bridge (`-lua`) and plays two seconds of the game from power-on, so the
recording has a picture before the run starts (a paused FCEUX that has not run a frame shows black). The run then
reloads the ROM, from power-on and paused. The launcher sets these of FCEUX's own settings in its `fceux.cfg`, while
FCEUX is closed:

- `eoptions` with "run in background" (1) and "hide menu" (2048): FCEUX keeps running without the focus, and the
  recording shows the game without FCEUX's menu bar.
- `goptions` without "confirm exit" (2): closing FCEUX asks nothing.
- `sicon 0`: no status icon over the game (a red pause sign whenever FCEUX is paused, which is between every two moves).
- `frame_display`, `rerecord_display`, `input_display`, `lagCounterDisplay`, `Show_FPS` off; `newppu 0`, `dendy 0`.
- `MainWindow_wndx`, `MainWindow_wndy`: only when `AAS_FCEUX_WINDOW_POS` is set (per machine, off by default), for a
  window on another display.

FCEUX for Windows has no setting for its messages over the game ("Power on", "Reset"). The run powers the game on by
reloading the ROM, which clears them, and the agent's tools cause none; the mock's reset on frame 0 shows "Reset".

On a machine with a quiet audio device (`AAS_QUIET_AUDIO_DEVICE`, off by default), the launcher sets that device as
FCEUX's own output in Windows' per-app setting once FCEUX runs, and the close clears it: FCEUX has no output setting of
its own and follows the Windows default when it changes.

## Known limits

- The agent's tools read memory and play buttons; memory writes, Lua, loading a ROM and states are not offered to the
  agent, and the bridge refuses them for the session.
- FCEUX stands still between two calls, and so does its sound: a call of 600 frames leaves a gap of about 30 ms, a
  call of one frame a gap of 33-43 ms every frame. The plugin sends the agent's steps in calls of 600 frames.
