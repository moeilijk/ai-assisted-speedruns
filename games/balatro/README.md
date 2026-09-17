# Balatro

Turn-based: the agent's thinking costs no game time, and every action is measurable. The first category is Random Seed ("Complete the game on a save file with a full collection without using a seed", speedrun.com); Set Seed is the same run with `aas run --seed <seed>`.

## How it works

- **[balatrobot](https://github.com/coder/balatrobot)** (coder, 1.5.2, MIT) is a Steamodded mod that serves the game as JSON-RPC 2.0 over HTTP on `127.0.0.1:12346`: the full game state and every action (`select`, `skip`, `play`, `discard`, `cash_out`, `buy`, `sell`, `reroll`, `pack`, `use`, `rearrange`, `next_round`), each answering once the game has settled, plus `start`, `menu`, `save`, `load`, `screenshot`, and the debug methods `add` and `set`. It runs on **[Steamodded](https://github.com/Steamodded/smods)** (1.0.0-beta-1814a, GPL-3.0), loaded by **[Lovely](https://github.com/ethangreen-dev/lovely-injector)** (0.9.0, MIT), all three pinned with their sha256 in [UPSTREAM.json](UPSTREAM.json).
- **[bridge.mjs](bridge.mjs)** sits between the agent and balatrobot on `127.0.0.1:12347`, the only port the plugin declares, so the broker cannot reach balatrobot itself. It passes the game actions through, refuses `add` and `set` to everyone, and refuses `start`, `menu`, `save`, `load` and `screenshot` to the agent; the harness sends a token from the bridge's state file (`/tmp/aas-balatro-bridge.json`, which the broker cannot read) and may use them. `aas.screenshot` has balatrobot write a PNG to the Windows temp folder and returns it as base64; `aas.restart` is only accepted at `GAME_OVER` and starts a new run with the deck and stake the harness started with (a new random seed, or the same set seed).
- **[plugin.mjs](plugin.mjs)** is the game plugin: `bal` in `balatro_exec` (see [documentation.md](documentation.md)). Every action is a `game.playback`; its IGT is the game's time on that action, everything else is thinking. Milestones: every round (no split), every ante the game goes past (`chapter: true`, splits and ends `Ante 1` to `Ante 7`, ids `ante1` to `ante7`; after the Hieroglyph or Petroglyph voucher an ante is split only once), and the win (`won` in the state, split `Ante 8`, end `win`, the default goal), which is also `game.over` with victory. `aas run --goal ante1` (or Goal in the GUI) makes a short run for tests and first agent runs, as `act1` does for Slay the Spire, and the first prompt names that goal ("play until you have beaten the boss blind of ante 1"); each goal has its LiveSplit file in [splits/](splits/). A game over is `game.over` without victory and not the end of the session: the controller refuses everything but `bal.restart()` (one playback, a new attempt). `prepareRun` returns the game to the menu when it is elsewhere and starts the run with `AAS_BALATRO_DECK` and `AAS_BALATRO_STAKE` (default RED and WHITE) and the run's seed when it has one. `saveState` writes balatrobot's save to `<tools>/saves/` (the harness copies it into `<run>/saves/`), `loadState` loads it into the running game.
- **Windows side**: [install-mod.mjs](install-mod.mjs) puts Lovely's `version.dll` in the game folder and Steamodded and balatrobot (its manifest, entry point and `src/lua`, as its installation guide lists) in `<tools>/Mods/` (`AAS_BALATRO_TOOLS_DIR`, default `<game>/aas`). [launch-game.mjs](launch-game.mjs) starts Steam when needed, then `Balatro.exe --mod-dir <tools>/Mods --disable-console` with balatrobot's settings from UPSTREAM.json in the environment, waits for balatrobot, starts the bridge and checks it. Optional and off by default, as for Slay the Spire: `AAS_BALATRO_WINDOW_POS` names the display to play on, set through the game's own display setting (its display number, in SDL's order: the primary display first, then the others in Windows' order) with the game's Borderless mode; `AAS_QUIET_AUDIO_DEVICE` routes the game's audio away from the speakers while it starts (`Balatro.exe`); `AAS_KEEP_DISPLAYS_AWAKE=1` keeps the displays on. A game that is already up is left alone, so tests can follow each other against one game (`aas run --keep-open`). [close-game.mjs](close-game.mjs) closes the game window, stops the bridge and restores the player's settings file; [stop-all.mjs](stop-all.mjs) also closes LiveSplit, OBS and a Steam the launcher started.
- **Scripted player** ([bot.mjs](bot.mjs), runtime `scripted`, `npm run balatro:scripted`): the end-to-end test of the chain, not a strategy. It plays the largest group of one rank, buys nothing, skips packs, and stops after `AAS_BOT_BALATRO_ATTEMPTS` game overs (default 1).
- What the harness adds to and changes in the game, and nothing else. Added: `version.dll` (Lovely) in the game folder, and `<tools>/` with `Mods/` (Steamodded, balatrobot, Lovely's own logs), `downloads/`, `saves/`, `launch.json` (the game version and profile slot of the last launch), `game.log`, `bridge.log`, and `aas-audio-defaults.json` when `AAS_QUIET_AUDIO_DEVICE` is set. Changed: the profile slot in `%AppData%\Balatro\settings.jkr` is set to `AAS_BALATRO_PROFILE` (default 3) while the game runs, so a run neither uses nor changes the player's own profile, and with `AAS_BALATRO_WINDOW_POS` the display and the window mode (Borderless) in the same file; the original is kept as `settings.jkr.aas-backup` and put back when the game has closed. balatrobot applies its own settings inside the game while it runs: game speed 4, 60 fps cap without vsync, card animations at 10 fps, reduced motion, no shadows, bloom or CRT effect, no screen shake, no splash screen, tutorial skipped; `BALATROBOT_AUDIO=1` keeps the sound on for the recording; fast mode, headless mode and debug mode are off.
- Because the mods are loaded from `<tools>/Mods` and not from `%AppData%\Balatro\Mods`, a start from Steam loads no mods. Lovely itself is still injected at such a start: it opens its console window and writes its log to `%AppData%\Balatro\Mods\lovely\log` (from Lovely's source, `crates/lovely-win` and `crates/lovely-core`; not measured). Remove `version.dll` from the game folder to play without it.

## Upstream and licenses

None of these is in this repository; `npm run balatro:install` downloads them, pinned with their sha256 in [UPSTREAM.json](UPSTREAM.json), which a bundle publishes as `game-config/`.

| | Version | License | Installed to |
|---|---|---|---|
| Balatro (LocalThunk, Playstack) | 1.0.1o-FULL tested | commercial, Steam app 2379780 | your Steam library |
| [Lovely](https://github.com/ethangreen-dev/lovely-injector) | 0.9.0 | MIT | `<game>/version.dll` |
| [Steamodded](https://github.com/Steamodded/smods) | 1.0.0-beta-1814a | GPL-3.0 | `<tools>/Mods/smods/` |
| [balatrobot](https://github.com/coder/balatrobot) | 1.5.2 | MIT | `<tools>/Mods/balatrobot/` (with its LICENSE) |

The plugin, the bridge and the scripted player are this repository's own code (MIT); they talk to balatrobot over its documented API and copy none of its code.

## Workflow

In the GUI (`npm run gui`, or `AAS.cmd`): Setup → Balatro folder → *Install what the game needs*; Run → Balatro, *Mock run* or an AI run → Start. The same from a shell:

```bash
npm run balatro:install                        # once: Lovely, Steamodded, balatrobot
npm run balatro:doctor                         # read-only: game, mods, OBS, LiveSplit, runtime

# start
npm run balatro:launch                         # game with mods, balatrobot on 12346, bridge on 12347
npm run obs:launch
npm run livesplit:launch -- games/balatro/splits/balatro-win.lss

# a run
npm run balatro:scripted -- <runs>/mock-01     # the chain with bot.mjs, no model; AAS_BOT_BALATRO_ATTEMPTS=3 for more game overs
npm run balatro:run -- <runs>/balatro-01 --headless --max-minutes 60   # Claude Code (budget guard applies)
npm run balatro:check -- --run-dir <dir> --exercise                    # only the connection: handshake, state, screenshot

# after
node packages/core/src/cli.mjs timeline <runs>/mock-01
node packages/core/src/cli.mjs publish <runs>/mock-01 <runs>/public/mock-01
npm run balatro:stop                           # only when something stayed open
```

A run closes the game, the bridge, LiveSplit, OBS and a Steam the launcher started when it ends; `--keep-open` leaves them for the next run.

## Known limits

- Random Seed on speedrun.com is played on a profile with the full collection. The run's profile slot starts empty, so it has what the game unlocks by default; balatrobot's `start` does not check unlocks. The game's own "Unlock All" button (profile screen) sets `all_unlocked` on a profile and turns its achievements off.
- A random seed is not random without a mouse: the game makes it from the position of the element under the mouse cursor and the moment the cursor last moved to another element (`generate_starting_seed` in `functions/misc_functions.lua`). Without mouse movement over the window those values need not change: on 2026-09-17 one game session gave `3KH2H56F` to every run and every restart (13:05 and 13:22), while a fresh game at 15:14 gave `DS6BZBNN` and then `BACQQ8K3`.
- Lovely injects a DLL; a game update can break it or Steamodded. The launcher reports a game version other than the one in UPSTREAM.json.
- The seed is the game's own: with a random seed it is reported in the run log (`game.ready`, `game.over`) and in `summary.json`.
