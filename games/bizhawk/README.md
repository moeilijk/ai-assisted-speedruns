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
| profiles | `nes15` (test): the Fifteen Puzzle by Mathew Brenaman, BSD-2-Clause, [source](https://github.com/christopherpow/nes-test-roms/tree/master/nes15-1.0.0); end `solved` (play_state, RAM 0x2F, = 3) |
| category | `observation: full`, `input: input`, `timing: paused-think` |

## Set up

1. `npm run bizhawk:install` downloads BizHawk and the tool into `%LOCALAPPDATA%\aas\BizHawk` (or `AAS_BIZHAWK_DIR`),
   each checked by sha256, and then lets BizHawk ask its own question: *"Trust this external tool to run on your
   device?"*. It says beforehand what that question is about; answer Yes to allow the tool. BizHawk keeps the answer
   for exactly this DLL; a new version is asked about again (`npm run bizhawk:allow`, or the button in the GUI's
   Setup tab). A run never shows the question: without the answer it does not start.
2. The install also downloads the test profile's ROM (nes15, BSD-2-Clause) into `.local/roms/`. For any other
   profile, put your own dump of the game there. `npm run bizhawk:doctor` checks it by its SHA-1.

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

## Known limits

- The agent's tools read memory and play buttons; memory writes, Lua and state loading are not offered to the agent.
- bizhawk-mcp-native is a small project that has not changed since v0.3.0 (2026-08-04). It is pinned, and the plugin
  uses only tools whose answers were measured against it (`test/fake-bizhawk-mcp.mjs` holds them).
