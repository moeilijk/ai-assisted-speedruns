# BizHawk

Games on the [BizHawk](https://github.com/TASEmulators/BizHawk) emulator, the emulator of the TAS community, through
[bizhawk-mcp-native](https://github.com/StealthC/bizhawk-mcp-native) by StealthC: an external tool inside EmuHawk
that serves the emulator over HTTP on `127.0.0.1:8767`. The plugin keeps the emulator paused between the agent's
moves; the game runs only while the agent's buttons play, frame by frame, so in-game time is the frames played divided
by the system's frame rate as BizHawk counts it.

One plugin, one profile per game (`profiles/<id>.json`, chosen with `AAS_BIZHAWK_PROFILE`). A profile names:

- the ROM by its SHA-1, with its maker, license and source. ROMs are never in this repository: put yours in
  `.local/roms/` (or point `AAS_BIZHAWK_ROM` at it); a run starts only on the exact dump the profile names;
- the game's ends as memory conditions, from a published RAM map, a disassembly or the game's own source, and measured
  in BizHawk;
- what the agent is told (controls, goal), and the inputs of the mock run;
- optionally the core, when the game's TAS movie belongs to one (BizHawk's own core preference is set to it).

| | |
|---|---|
| id | `bizhawk` |
| upstream | BizHawk 2.11.1 (MIT for the frontend; each core its own license, most GPL), bizhawk-mcp-native v0.3.0 (MIT); both pinned in [UPSTREAM.json](UPSTREAM.json) and not redistributed |
| profiles | `smb`: Super Mario Bros. (NES), your own ROM; ends per world and the game's end (the axe in 8-4), from [periwinkle9's autosplitter](https://github.com/periwinkle9/smb-autosplitter) (Zlib); its mock replays the TAS [#3728](https://tasvideos.org/3728M) by HappyLee & Mars608 (CC BY 2.0, tool-assisted) through World 2 |
| | `nes15` (test): the Fifteen Puzzle by Mathew Brenaman, BSD-2-Clause, [source](https://github.com/christopherpow/nes-test-roms/tree/master/nes15-1.0.0); end `solved` (play_state, RAM 0x2F, = 3) |
| category | `observation: full`, `input: input`, `timing: paused-think` |

## Set up

1. `npm run bizhawk:install` downloads BizHawk and the tool into `%LOCALAPPDATA%\aas\BizHawk` (or `AAS_BIZHAWK_DIR`),
   each checked by sha256, and then lets BizHawk ask its own question: *"Trust this external tool to run on your
   device?"*. It says beforehand what that question is about; answer Yes to allow the tool. BizHawk keeps the answer
   for exactly this DLL; a new version is asked about again (`npm run bizhawk:allow`, or the button in the GUI's
   Setup tab). A run never shows the question: without the answer it does not start.
2. The install also downloads the test profile's ROM (nes15, BSD-2-Clause) into `.local/roms/`. For any other
   profile, put your own dump of the game there. `npm run bizhawk:doctor` checks it by its SHA-1.

## What BizHawk asks

BizHawk asks two questions of its own in this set-up. Both are announced by the step that causes them, and neither
ever appears during a run:

- **"Confirm loading — Trust this external tool to run on your device?"**, the first time EmuHawk loads
  bizhawk-mcp-native. It comes in `npm run bizhawk:install` (or `bizhawk:allow`), which says beforehand what it is
  about; the answer is yours, and BizHawk keeps it for exactly this DLL. The launcher checks the stored answer and does
  not start a run without it.
- **"ROM required to populate hash — Please select the original ROM to finalize the import process."**, when BizHawk
  imports a TAS movie made in another emulator (FCEUX, lsnes, Mupen). It wants the ROM to put a SHA-1 in the new
  movie's header. `npm run bizhawk:tas -- <profile>` answers Cancel itself: BizHawk writes the movie without that
  SHA-1, and the ROM is checked by the profile's own SHA-1 before a run starts.

## The Lua Console

The plugin holds buttons through a small Lua script, `lua/hold.lua`, which it loads into EmuHawk after the power-on
reboot. BizHawk opens its Lua Console window for that, next to the game, and it stays open until EmuHawk closes; OBS
records only the game window. The tool's own `press_buttons` sets buttons between frames, and BizHawk clears them
when the next frame starts, so a held button reached the game on hardly any frame (Super Mario Bros., 600 frames of
the TAS: x 58 instead of 916). The script sets them at the start of every frame, and the same 600 frames end at 916.
A reboot while the Lua Console is open makes BizHawk show an error about its Lua folder, so nothing touches Lua before
the reboot.

## The mock

A profile's mock replays the input of a published TAS movie through the same buttons the agent has, frame by frame,
from power-on (`bot.mjs`); the agent itself cannot play a movie. `npm run bizhawk:tas -- <profile>` makes the movie
ready in `.local/tas` (downloaded from TASVideos, pinned by sha256). A movie made in another emulator may fall out of
sync in BizHawk: the profile's `bot.frames` stops the mock where it still is (Super Mario Bros.: through World 2).

## What the launcher sets in BizHawk

`npm run bizhawk:launch` starts EmuHawk with the tool (`--open-ext-tool-dll`) and without its menu and status bar
(`--chromeless`), and sets these of BizHawk's own settings in its `config.ini`, while EmuHawk is closed:

- `MuteFrameAdvance: false`: BizHawk mutes the sound while frames are advanced one call at a time, which is how the
  plugin plays every frame; muted, the recording has no game sound.
- `DisplayMessages: false`, `FirstBoot: false`: no BizHawk text over the game in the recording.
- `DispChromeStatusBarWindowed: false`: BizHawk shows its status bar again once a game loads, whatever `--chromeless`.
- `Rewind.Enabled: false`: a run uses its own savestates.
- `SoundDevice`: the quiet output (`AAS_QUIET_AUDIO_DEVICE`), when this machine has one; otherwise the default device.
- `PreferredCores`: the profile's core, when it names one.
- `OpposingDirPolicy: 2` (Allow): with the default (Priority) BizHawk passes only the latest of Left+Right or Up+Down
  held together. A movie's input is not filtered, the plugin's is; a TAS presses both on purpose.

## Known limits

- The agent's tools read memory and play buttons; memory writes, Lua and state loading are not offered to the agent.
- bizhawk-mcp-native is a small project that has not changed since v0.3.0 (2026-08-04). It is pinned, and the plugin
  uses only tools whose answers were measured against it (`test/fake-bizhawk-mcp.mjs` holds them).
