# Portal 2

Portal 2 through [SourceAutoRecord](https://github.com/p2sr/SourceAutoRecord)'s own TAS protocol. SAR is not
vendored: `install-mod.mjs` downloads the release pinned in `UPSTREAM.json`, refuses anything whose sha256 differs,
and writes this plugin's own config next to the game, so the player's `autoexec.cfg` stays theirs.

| | |
|---|---|
| id | `portal_2` |
| upstream | [p2sr/SourceAutoRecord](https://github.com/p2sr/SourceAutoRecord) 1.15.4 (MIT), its TAS protocol |
| bridge | TCP `6555`: inline `.p2tas` scripts, pause, play, advance a tick, pause at a tick, fast-forward, entity position/angles/velocity |
| ends | every map after the first, named as the game names it (`sp_a1_intro2` "Portal Carousel" … `sp_a4_finale4` "Finale 4"), then `credits` |
| splits | one per map, 62 in the single-player campaign |

## Set it up

```bash
npm run portal2:install     # SAR next to the game, pinned by sha256, plus portal2/cfg/aas_portal2.cfg
npm run portal2:launch      # starts the game with that config and waits for the protocol server
npm run portal2:doctor      # the game, SAR's pin, the config, the console log
npm run portal2:check       # does the broker reach the game?
```

`AAS_PORTAL2_GAME_ROOT` (the folder with `portal2.exe`) is the only setting a run needs; it lives in
`.local/games/portal-2.env`. `AAS_PORTAL2_PORT` (6555), `AAS_PORTAL2_RESOLUTION`, `AAS_PORTAL2_WINDOW_POS` and
`AAS_PORTAL2_TIMEOUT_MS` are optional.

## The campaign

`maps.json` is the campaign in order, with the name the game gives each map. It is not written by hand:
`npm run portal2:maps` takes it from SAR's own table (`src/Games/Portal2.cpp` at the commit pinned in
`UPSTREAM.json`), which SAR carries because its speedrun timer needs it. Pass `--write` to update it; the file
records the commit it came from, so the list can be made again and compared.

## What the protocol does not carry, and what answers it instead

SAR's `docs/tas_proto.txt` has no screenshot message, and it names the map once, when the controller connects, and
never again. Neither is answered by changing SAR — that is upstream's code, not this project's:

- **The map** comes from the engine's own console log. The launcher starts the game with `-condebug`, so Portal 2
  writes `portal2/console.log`, and `maps.mjs` follows the level loads in it. Only forward progress counts.
- **The picture** comes from the engine's own screenshot command, run from a one-tick script, and the file it
  writes into `portal2/screenshots` is what the tool returns.

## A run

Everything a run needs is here: the instructions the model reads (`AGENTS.md`), the start (`prepareRun` loads the
campaign's first map and leaves the game standing still), saving and loading through the engine's own `save` and
SAR's `start save`, the end of a session (`endRun` stops whatever script is playing) and closing the game the way
a user would (`stop-all.mjs`). A splits file per end comes from `npm run portal2:splits`, made from `maps.json`.

```bash
aas run --runtime claude-code --game games/portal-2/plugin.mjs --run-dir <runs>/portal2-01 \
        --recorder obs --timer livesplit --overlay-port 8765
```

Without `--goal` an AI run aims at the credits and a run no model plays aims at the campaign's first end,
`sp_a1_intro2` ("Portal Carousel").

## What is proven, and what is not

`test/protocol.test.mjs` and `test/plugin.test.mjs` run against `test/fake-sar.mjs`, a stand-in that speaks the
protocol: the ends, the map tracking, stepping, inline scripts and entity info are checked there.

Portal 2 was not installed on the machine this plugin was written on, so nothing here has met the real game yet.
Unproven against it: the launcher, the exact wording the engine prints on a level load, the screenshot command,
and the console commands that go through a tickbulk (`save`, `jpeg`, `quit`).

There is no mock run for this game. A mock replays a published route, and the published Portal 2 TASes I could
find ([ChaoticWeg/p2tas](https://github.com/ChaoticWeg/p2tas)) are four files in SAR's older `sar_tas_frame_at`
console format, none of them the campaign's first end. `setup.bot` waits on a route in the `.p2tas` form that
SAR's protocol plays.
