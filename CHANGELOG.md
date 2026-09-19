# Changelog

The tooling is in beta: versions stay below 1.0.0 until the AAS Archive goes live on 2026-10-01, together with 1.0.0.

- **Minor** (0.x.0): a new `summary.json` schema or a new SPEC draft, so a bundle may look different and the archive
  reads it before the release comes out.
- **Patch** (0.x.y): everything else.
- **BREAKING**: a release after which a run directory or a bundle made with an earlier version is no longer read,
  republished or ranked. Such a release says so in its first line, and what to do with existing runs. None so far.

Versions 0.1.0 to 0.10.0 were numbered afterwards, on 2026-09-16; 0.1.0 is the repository going public on 2026-09-13.
Their tags point at the commits listed; the `package.json` in those commits still says 0.1.0, and a bundle made with
them carries `harness.version` 0.1.0.

## 0.28.1 — 2026-09-19

- **`packages/spec/runtimes.json`**: every runtime plugin this release ships, with the sha256 an archive holds a
  bundle against (SPEC §3). The AAS Archive's witness takes `aas-witness v2` as of today and no longer reads a
  bundle's own `mock`; it keeps its own list of runtime hashes and decides for itself, and its list was empty,
  which means every schema 16 bundle would be refused. The file is made by `node packages/spec/make-runtimes.mjs
  --write`, never by hand, and it says what the hash covers so an archive does not have to guess: every `.mjs`,
  `.json` and `.md` of `packages/runtime-<id>/`, `test/` left out.
- A test holds the file against what `aas publish` would write, with the same function, so the two cannot drift.
  A release that changes a runtime plugin fails until the file is made again.

## 0.28.0 — 2026-09-19

- **A Portal 2 run can actually be started** (owner, 2026-09-19). 0.25.0 said "Portal 2 is a game plugin, not a
  stub" and that was not true of a run: `aas configure` refused it outright ("No instructions: the game plugin has
  none"), and there was no start, no save, no load, no end and no way to close the game. The plugin had the bridge
  and nothing around it. Now it has:
  - `AGENTS.md`, the instructions the model reads, which `aas publish` carries into the bundle verbatim.
  - `prepareRun`: `start map sp_a1_intro1`, SAR's own way to begin on a map (docs/p2tas.md), and the script does
    nothing else, so what it leaves behind is a loaded game standing still.
  - `saveState` and `loadState`: the engine's own `save` through the only channel the TAS protocol has for a
    console command, and `start save <name>` to come back to it. A save is waited for until the engine has
    finished writing it, because a copy taken too early is a save of nothing.
  - `endRun`, `close` and `stop-all.mjs` (`npm run portal2:stop`): the script is stopped, `quit` is handed to the
    game through its own console, and the window gets the time a user would give it. Nothing is killed.
  - A splits file per end, 62 of them, from `npm run portal2:splits` — made from `maps.json`, not by hand.
- A test that was missing when this was called finished: a run is configured end to end against the fake, and the
  plugin is held against everything `aas run` asks a game for. `prepareRun`, `saveState` and `loadState` are
  checked on the exact script they send.
- Still not there: a mock run. A mock replays a published route, and the published Portal 2 TASes I could find are
  four files in SAR's older `sar_tas_frame_at` console format, none of them the campaign's first end.

## 0.27.1 — 2026-09-19

- **A game you have not got is not a fault** (owner, 2026-09-19: "een missend spel is niet fout. je kan hem alleen
  niet runnen"). A game whose folder is not chosen read as "Not ready" in the warning colour, as if something on
  the machine were wrong. It says **Not set up** now, in grey, and so does its condition: nothing here is broken,
  there is simply a game you cannot run. "No plugin yet" was already grey and stays that way.
- The same holds for everything else that is only not there yet: Claude Code, Codex, LiveSplit, SoundVolumeView and
  the output location. Not installed is not a problem to solve; **Not ready** stays for something that is set up
  and misses a piece it needs, which is the only one worth a colour.

## 0.27.0 — 2026-09-19

- **"Folder" is a question; the Setup tab answers it** (owner, 2026-09-19: "wat is folder?"). An empty box said
  `folder` and a condition said "the Portal 2 folder", which is the same word twice and tells nobody which folder
  to pick. A game plugin now carries `setup.settings[].what`, the plain answer, and it stands under the heading
  whether anything has been checked or not: "Where Steam installed Portal 2: the folder with portal2.exe in it,
  usually steamapps\common\Portal 2", "The Source Unpack of Portal: the folder with hl2.exe in it. Not the Steam
  copy of Portal — Source Unpack is a separate download."
- The empty box says it too, instead of `folder`: "the folder with portal2.exe in it", and for a setting that is a
  file, "the path to LiveSplit.exe". The output location says what is kept there and that it needs room for video.
- A test holds it: a game plugin whose folder setting does not say which folder it means, and does not name the
  file a person recognises it by, fails.

## 0.26.1 — 2026-09-19

- **Fewer statuses, and each one says whether this part can be used** (owner, 2026-09-19: a status has to reflect
  something, and "Not checked"/"Nothing chosen" read as a refusal). 0.26.0 made it worse by adding words. There were
  seven labels for three states, and four ways of saying no — "Check", "Problem", "Not set", "Nothing chosen" —
  while the condition underneath already said which one it was. A row is now **Ready** or **Not ready**, with the
  failing condition below it, plus **No plugin yet** for a game the framework does not support and **Checking…**
  while it runs. One verdict, one colour: "Not ready" no longer appears in two colours for the same meaning.
- A row that has not been checked has no verdict at all instead of a word of its own. Nothing has run, so nothing is
  true or false about it yet, and whether this page has checked anything is said once at the top, where it belongs.
- Each condition is the thing that has to be true, in full: "the Source Unpack folder (Portal) is chosen",
  "hl2.exe is in the Balatro folder" — readable on its own, without the heading above it.

## 0.26.0 — 2026-09-19

- **A button in the Setup tab says what it does** (owner, 2026-09-19: "install kan op teveel dingen slaan ... je
  moet het me niet hier uitleggen maar in de gui"). It said "Install what the game needs", which could mean the
  game, the mod, the tooling or the harness. A game plugin now carries `setup.installs`, one sentence naming what
  its install script puts where, and that sentence is the button — "Copy SourcePauseTool and portal-agent's configs
  into the Source Unpack folder", "Install Communication Mod next to the game and point it at this harness's
  bridge". When everything already passes the same sentence ends in "(again)". Under the button stands the command
  it runs (`npm run portal:install`), the way the Run tab shows every command before it runs it.
- **A condition names which folder it is about.** "a folder is chosen" said nothing about which; the rows now carry
  the setting's own name: "Source Unpack folder (Portal): a folder is chosen", "hl2.exe is in the Balatro folder".
- **"Not checked yet" and "Nothing chosen" are two different things and no longer look alike.** A row that has not
  run says nothing is known either way; a row that has run and found an empty setting says so. The other statuses
  say what they mean too: `warn` is "Not ready" rather than "Check".

## 0.25.1 — 2026-09-19

- **The Setup tab ran a game's checks without that game's settings** (owner, 2026-09-19). Since 0.22.0 a game's
  folder lives in `.local/games/<game>.env`, and `gui/game-doctor.mjs` — the process the GUI runs a plugin's checks
  in — loaded neither that file nor `.env`. So the row above said the folder was chosen while the plugin's own
  checks reported a game that was not set up. It now loads the same two files every other command reads, in the
  same order.
- **Portal's check covers the controller it runs on.** It checked the Source Unpack, the game files, the audio and
  the autoexec, and said nothing about portal-agent — which is not in this repository, which `connect()` refuses to
  start without, and whose `game-config` and license travel into every bundle. The conditions now include the
  checkout, its `controller/mcp/portal-documentation.md` and `run/AGENTS.md`, the three files that are published
  with a bundle, and whether the checkout still sits at the commit `UPSTREAM.json` pins — a checkout that has moved
  is a run nobody else can reproduce. Each failing row says what makes it true (`npm run portal:fetch`).
- The check also names `spt.dll to install from`, the file `install-game-files.mjs` copies. Without it the Setup
  tab's install button fails on its first file, which is now visible before the button is pressed instead of after.

## 0.25.0 — 2026-09-19

- **Portal 2 is a game plugin, not a stub** (owner, 2026-09-19: "maak eerst de portal 2 zoals afgesproken"). The
  SAR client, the protocol and the installer were written on 2026-09-16 and then left behind a stub that refused
  every run. `games/portal-2/plugin.mjs` now runs on them: inline `.p2tas` scripts, stepping a tick at a time,
  pause, play, pause-at-tick, fast-forward, and the position, angles and velocity of any entity.
- **The campaign comes from SourceAutoRecord's own table, not from anyone's memory.** `npm run portal2:maps`
  (`extract-maps.mjs`) takes the 62 single-player maps in order, with the name the game gives each one, from
  `src/Games/Portal2.cpp` at the commit now pinned in `UPSTREAM.json`; SAR carries that table because its own
  speedrun timer needs it. `maps.json` records the commit it came from. Every map after the first is an end
  (`sp_a1_intro2` "Portal Carousel" … `sp_a4_finale4` "Finale 4"), and the credits are the game's own end.
- **What the protocol does not carry is answered by the engine, not by patching SAR.** `docs/tas_proto.txt` has no
  screenshot message and names the map once, when the controller connects. So the launcher adds `-condebug` and
  `maps.mjs` follows the level loads in the game's own `portal2/console.log` (forward only), and
  `portal2.screenshot()` runs the engine's own screenshot command from a one-tick script and returns the file it
  wrote.
- Two things our own code claimed about the protocol were not what the protocol says, and both are corrected:
  packet 10 is sent **when a script has finished playing**, not when it was accepted, so `tas()` returns at the end
  of the script; and a pause or play request has no documented answer, so those calls report what was asked for and,
  beside it, the last state the game itself sent — never a claim that the request landed.
- `npm run portal2:install|launch|doctor|check|maps`. The syntax check (`npm run check`) covers `games/portal-2`
  and `games/slay-the-spire`, which it never did.
- The stub test names the eight games still waiting for a plugin instead of counting them, so finishing one is a
  change that has to be written down.
- Portal 2 is not installed on the machine this was written on: the ends, the map tracking, stepping, inline
  scripts and entity info are proven against `test/fake-sar.mjs`, and the launcher, the engine's wording on a level
  load and the screenshot command have not met the real game.

## 0.24.0 — 2026-09-19

- **A run no model plays aims at the game's first end** (owner, 2026-09-19: "voor een mock is het laagste doel
  standaard. een run die het einde haalt is overkill voor een functionele test"). Without `--goal`, the goal now
  follows who plays: the game's own end for a model, the game's first end for anything else. For Portal that is
  chamber 01 instead of the credits, for Balatro ante 1 instead of the win, for Slay the Spire the Act 1 boss
  instead of Act 3. The runtime plugin's own `ai` decides, the same declaration that decides whether a bundle is a
  mock (SPEC §3). A goal that is given still stands, for either kind of run.
- The GUI follows the same rule: choosing the mock run puts the goal on the game's first end and choosing an AI puts
  it on the game's own end, until the goal is changed by hand; then that choice is kept as long as the game has it.
- `npm run portal:scripted` — Portal's mock run had no script of its own next to `sts:scripted` and
  `balatro:scripted`, so the only way to start it was the full command line.

## 0.23.0 — 2026-09-19

- **A bundle is a mock unless it shows that a model played it** (owner, 2026-09-19: `mock: true` "klinkt als super
  makkelijk te vervalsen"). It was: `mock` is one word in a file the publisher signs with their own key, and until
  now a bundle without it was read as a run of an AI. SPEC draft 0.40 turns it around. Whether a model plays is a
  property of the runtime, not of the run, so a bundle now names its runtime with `sha256`, the plugin as it ran
  (`pluginDigest`: every `.mjs`, `.json` and `.md` of the package, `test/` left out), and an archive reads its own
  list of runtimes instead of the `ai` a plugin declares about itself. A runtime it cannot place is a mock.
  `aas publish` writes `mock: true` unless the runtime says a model plays, where it used to write `false` for every
  runtime whose `ai` was unknown.
- **What a model leaves behind is counted, and a reader recounts it.** Schema 16 adds `ai_evidence`: the model's
  messages, its tool calls, how many models answered and their output tokens, all countable from
  `session.sanitized.jsonl` itself. `aas check` reports "a model played" met, unmet or invalid from the runtime, that
  evidence and the witnessed start together — a bundle that claims `mock: false` with none of it is invalid, not
  merely unmet.
- **The prompt is fixed before the run and published after it** (§8.10). Nothing stops a publisher from running the
  model for real and dictating its play, and no flag can. What the tooling does instead: `AGENTS.md` was already in
  the bundle verbatim, and `category.goal_prompt` now holds the first prompt verbatim next to it; `brief` carries the
  sha256 of both, recomputable from the bundle; and the witnessed start of every segment carries the same two hashes,
  counter-signed by the archive before the recording ran. Writing the route into the prompt therefore means
  publishing that route, and it cannot be swapped for an innocent prompt afterwards.
- The witness statement is `aas-witness v2` (§8.9): a start adds `runtime:`, `instructions:` and `goal:`, an end adds
  `log:` (the run log's sha256 and its number of records, which fixes what the segment produced on the archive's
  clock). A field this machine cannot fill is `-`, never a guess. `aas-witness v1` statements in existing bundles
  stay valid and are still verified; the archive's witness accepts both kinds.
- **A message typed into a running session is help, whatever it said** (§8.3). The harness sends one prompt per
  segment; every further `role: user` message in the timeline is counted in `ai_evidence.human_turns` and forces the
  human axis to `assisted`. A resume is a restart and stays `restart-only`.
- **Every input came from a tool call** (§8.11). Game time advances only inside `game.playback`, and `aas check` now
  reports a playback that stands outside any tool call: input the agent never asked for was played by something else.
- Schema 16 and SPEC draft 0.40. A mock bundle is still complete, signed and witnessed — the Portal mock run of
  0.21.0 meets every requirement except "a model played", which is the whole point of it.

## 0.22.1 — 2026-09-19

- A game without a plugin is not in the Run tab's list (owner, 2026-09-19: "??? nut?"). Choosing it emptied the
  form and disabled Start: a choice that cannot be acted on. Setup keeps naming every game the repository knows,
  which is where it belongs — what the framework supports and what this machine has.

## 0.22.0 — 2026-09-19

- **A game's settings live with that game** (owner, 2026-09-19). `.local/games/<game>.env` holds what belongs to one
  game — its folder, its window, its own variables — and `.env` keeps what is true for the whole machine. Which
  setting belongs to which game is what the plugin declares, so nothing is guessed. `.local/` is never published, so
  no machine path ends up in `games/`, which is the plugin as everyone else receives it.
- The order is the same everywhere (`packages/core/src/settings.mjs`): the game's file is read first and its value
  stands, then `.env`, and a variable already set in the shell beats both. `aas run --game …`, every `npm run
  <game>:…` script and the GUI read the same two files; the `--env-file-if-exists=.env` in those npm scripts is gone,
  because loading `.env` first would have made it win over the game's own file.
- `node packages/core/src/gui/migrate-settings.mjs` moves the game settings out of an older `.env`, by what the
  plugins declare. Run here: eight settings moved to portal.env, slay-the-spire.env and balatro.env.

## 0.21.0 — 2026-09-19

- **A mock run is marked as one in the bundle, and an archive refuses it** (owner, 2026-09-19). A runtime plugin says
  whether a model plays (`ai`); `aas publish` writes `mock: true` when none did, next to `harness.plugins.runtime.ai`.
  Schema 15 and SPEC draft 0.39: such a bundle may be complete, signed and witnessed and is still not an entry — an
  archive does not publish it, rank it or keep it. A bundle without `mock` is read as `false`. `aas check` refuses a
  schema 15 bundle whose `mock` and `runtime.ai` disagree.
- Portal's mock run reaches its goal, and the route is built by a tool instead of by hand:
  `games/portal/extract-route.mjs` takes the calls of a real run's log, leaves out the screenshots and replaces the
  waits before the first move by the chamber's countdown (`--wait`, 58 s: the countdown reads 00:00:00:00 and the
  portal opens at IGT 57.3 in the recording of portal-03). Turns are never merged: a run with merged turns took
  another path. Measured: merged turns `stopped` at 288 s; the route as recorded `completed` with Victory (Chamber 01)
  at 214 s; with the countdown at 58 s, `completed` at 172 s.

## 0.20.1 — 2026-09-19

- The game lands on the display that was chosen (owner, reported more than once). A launch option was not enough:
  measured 2026-09-19, `hl2.exe` took `-x -1920 -y 1` and still put its window at 320,1, centred on the 2560×1440
  main display, while the setting pointed at the 1920×1080 one at -1920,1. `packages/core/src/windows/move-window.mjs`
  moves the window after the game is up, the way LiveSplit's and Slay the Spire's launchers already did; Portal and
  Portal 2 use it. Measured again after the change: `window: moved to -1920,1`, and the window is at -1920,1.
- OBS is never left pointing at a folder that is gone. It used to be set back to whatever it pointed at before the
  run, which after a killed run is that run's own recording folder — published and then deleted. Now it is set back
  only to a folder that exists and is not a run's recording folder, and otherwise to the output location. The Setup
  tab no longer offers such a folder as the output location either.

## 0.20.0 — 2026-09-19

- Portal's mock run plays a real route instead of walking forward for eight steps (owner, 2026-09-19: the AI runs
  had long since come past chamber 1, so nothing needed inventing). `games/portal/routes/chamber01.json` holds the
  calls an AI run sent to the game, in the order it sent them, taken from that run's log; its `source` names which
  run and which segment. The chamber tracker of `games/portal/chambers.mjs` finds 00 and then 01 in that same log,
  so the route reaches chamber 01. `bot.mjs` replays it.
- The replay is shorter than the recording without changing a single input: the screenshots the model took are left
  out (they cost wall-clock time and no game time, and a replay does not look), and camera turns that followed each
  other are one turn of the same angle. 197 recorded calls become 151 steps.
- `AAS_BOT_PORTAL_STEPS` now stops earlier in the route instead of being the whole bot.

## 0.19.21 — 2026-09-19

- A row that fails says it once, in the colour of what it means, with the file it names as a link. A failing row
  printed its reason twice (as its own line and again behind the condition), a game without a plugin was red while
  its status said grey "No plugin", and the README it pointed at could not be opened. A file of the repository named
  in a condition is now a link to it on GitHub.

## 0.19.20 — 2026-09-19

- A row's conditions are the whole of what it proved, so naming a few unproved things next to them is taken out
  (owner, 2026-09-19: "als je groen zegt wat je WEL hebt bewezen dan is alles wat je NIET noemt toch automatisch
  niet bewezen?"). It was worse than redundant: a partial list of what was not proved suggests everything else was.
  The Setup tab says once that a row's list is all it establishes, and that the programs working together is proved
  by a mock run.
- A game without a plugin is the same row as a game with one (owner, 2026-09-19). Every game row starts with "there
  is a plugin for this game": a game in the repository passes it without a word, a stub fails on it and says where
  to read what it would take. Two shapes of row in one group cannot be compared, and "no plugin yet" in a settings
  field reads as a setting. Its status is "No plugin", in grey: nothing is wrong with the machine.

## 0.19.19 — 2026-09-19

- What a row does not try is one line, not a list (owner, 2026-09-19: "wat moet ik met al die not tried?"). They are
  not tasks — nothing can be done with them — and as a list under every row they read as work. They exist to stop a
  pass being read as "this works", so each row now ends with one grey line, "only a run proves: …", and the Setup tab
  says once at the top what these rows can establish at all and where the rest is proved: a mock run, without tokens.

## 0.19.18 — 2026-09-19

- Every row of Setup shows what it tried (owner, 2026-09-19: "IK WIL DE FAIL STATES ZIEN"). A check is no longer a
  verdict but a list of conditions, each with its outcome, and under it the things this row does **not** try. So
  "Checked" is not a word to trust: next to it stands what was proved, and every line in that list is a state the
  row can fail on. OBS names six conditions and says it never connected; LiveSplit four; Steam one, and that
  whether Steam runs and is logged in is left to the game's launcher; a game names the checks its own plugin
  answered.
- Setup names every game in the repository, not only the ones that work. The nine stubs stand between the games
  with a folder, each saying it has no plugin yet and where to read what it would take. A missing game has to be
  visible, otherwise a complete-looking list says the machine can do more than it can.

## 0.19.17 — 2026-09-19

- A check no longer turns green on nothing (owner, 2026-09-19: green stickers without a function lull the operator
  while a run burns tokens). A pass must say what it proved, in its own words, and the mechanism enforces it: a pass
  without that sentence has no status at all. Rows that only establish a fact (the repository's package.json is
  there, steam.exe is there, no display chosen, no sound device chosen) now state the fact and stay grey — finding a
  file proves nothing about a run. Every other row says what ran and what it showed, and what it did **not** try:
  OBS and LiveSplit are read, not connected to; the agent CLIs answer `--version`, and whether they reach a game is
  what `check-agent` in a run does. A game's row names the checks its own plugin answered.
- The GUI names every game plugin in the repository, including the stubs (owner, 2026-09-19). A stub says it has no
  plugin yet and points at its README; it has no settings and cannot be started.
- The confirm of "Close everything" says what it means: "No run is going. Close the game, LiveSplit and OBS if they
  are still open?" — the old text said nothing is running and then offered to close three things.

## 0.19.16 — 2026-09-19

- The AI is one select for both kinds of run (owner, 2026-09-19). It plays an AI run, and a mock run checks that it
  reaches the game's tools — so a mock proves the set-up of the AI run you would do next, with the agent you would
  use. It is no longer a statement, a second question, or every installed agent at once.
- Every game can also run without a recording ("No recording (never a valid run)"), for testing the rest of the
  chain (owner, 2026-09-19). The run then has no recorder step.

## 0.19.15 — 2026-09-19

- The bundle and the recording open **selected** in Explorer instead of being opened (owner, 2026-09-19: a zip that
  opens as a folder cannot be picked up). `/select,` and the path go as two arguments: as one argument Explorer reads
  a path with a space in it as the whole switch and opens Documents instead (measured).
- The AI field states, for a mock run, which agents it checks ("Claude Code and Codex: checked, no tokens") instead
  of asking. 0.19.14 turned that into a choice, and a mock run has nothing to choose there: it checks everything that
  is installed. For an AI run it stays the choice of who plays.
- The GUI's line about Ctrl-C and the stopped-page's text no longer contradict each other: a GUI that is ended
  (Ctrl-C, its window, a stop signal) stops a running session first and closes the game, OBS and LiveSplit; one that
  crashes or is killed does not, and the page says so. Closing the window (SIGHUP) now ends it the same way.

## 0.19.14 — 2026-09-19

- The AI is a choice of its own (owner, 2026-09-19: "run type mock test welke ai precies?"). The Run tab asks who
  plays — the game's script (a mock run) or an AI — and then which AI. For an AI run that is who plays; for a mock
  run it is whose connection is checked, and it says so ("AI connection to check"). With more than one agent
  installed a mock run defaults to all of them, which is what makes it the test; choosing one checks only that one.
  A machine without an agent is offered no AI run and no check.

## 0.19.13 — 2026-09-19

- The run only asks what the game has (owner, 2026-09-18: Portal offered a seed, and Portal has no seed). A game
  plugin says whether a run has one (`setup.seed`, with the placeholder it wants); the GUI shows the field only for
  a game that declares it, and a seed is never passed to a game without one.

## 0.19.12 — 2026-09-18

- The recording is a choice in the GUI, and a mock run tests the one that is chosen (owner, 2026-09-18: a test tests
  what you selected for the run, and the recorder is a plugin). A recorder plugin names itself (`name`) and says how
  to start its program (`launch`, OBS only); a game plugin says which recorders fit it (`setup.recorders`, default
  `["obs"]`; Portal adds `source-demo`). The GUI's Recording list comes from those two, the step that starts the
  recorder appears only when the chosen one has a program, and the run is passed `--recorder <chosen>`.
- The stopped-GUI overlay lost "Copy the details": the report carries the same details, so the button added nothing.

## 0.19.11 — 2026-09-18

- A mock run is the test of this machine, and it costs no tokens (owner, 2026-09-18). "Check the AI connection
  first" is gone as a choice: a mock run always starts by having every agent CLI that is installed reach the game's
  tools (`aas check-agent` per agent). An agent that is not installed is skipped and says so; testing only Codex on a
  machine without Claude Code is not a failure. An AI run does not do the check: the run itself is the proof.
- The mock run is documented as what it is — everything an AI run needs except the model's own playing — in the
  README and in [reference.md](docs/reference.md).

## 0.19.10 — 2026-09-18

- The report of a stopped GUI asks for the right thing. The page's own log says what the GUI did, not why it ended:
  that is in the window it ran in. The issue now asks for those lines first and fills in what the page can know
  (version, address, browser, and its own log only when it has one). "Copy the log" is "Copy the details", and the
  version is no longer printed twice (owner, 2026-09-18: "Tooling tooling 0.19.8 · Mozilla/5.0 …").
- `AAS.cmd` only replaces a drive letter that stands for a WSL share (`\\wsl.localhost\…`, `\\wsl$\…`). A letter
  mapped to any other share names a place WSL cannot reach under that name either, and is left alone.

## 0.19.9 — 2026-09-18

- The page says when the GUI is gone. A GUI that ends (its window closed, Ctrl-C, a crash) left the page showing
  its last state — "Ready", with a green dot — and the Setup tab simply went empty. The page now covers itself with
  "The GUI has stopped": what is still running, five things to try, and a report button that opens an issue with the
  log of the session filled in (and a Copy the log button, because a long log does not fit in a link). As soon as the
  GUI is back the page picks up by itself, without a reload.
- `AAS.cmd` works from a drive letter that stands for a WSL share. `Y:` mapped to `\\wsl.localhost\Ubuntu` gave
  `wsl: Failed to translate 'Y:\home\...'`, after which WSL started in the home folder and Node reported
  `Cannot find module`. The letter is now replaced by the share it points at. A copy of `AAS.cmd` outside the
  repository says so in a sentence instead of a Node stack trace.

## 0.19.8 — 2026-09-18

- Only one GUI runs at a time. A running GUI leaves a note (`.local/gui.json`); a second `aas gui` (double-clicking
  `AAS.cmd` again) says "aas gui is already running", opens that page and ends with exit code 0, instead of
  `EADDRINUSE` and `AAS.cmd`'s "It needs WSL with Node 22 or newer", which sent the operator to the install guide
  while the GUI was up. A note left behind by a killed GUI does not block a start; a port held by something else
  names the port to use instead.
- `AAS.cmd` points at the reason above it when a start fails, instead of always naming Node and WSL.

## 0.19.7 — 2026-09-17

- Every game can do a mock run: Portal has a scripted player (`games/portal/bot.mjs`), so the whole chain (TAS
  playback, IGT, chamber milestones, recording, timeline, bundle) can be tested without a model and without tokens.
- `aas check-agent --runtime <id> --game <plugin.mjs>`: does the agent's own CLI reach the broker? It configures a
  throwaway run directory and has the CLI health-check its MCP servers (`claude mcp list`, `codex mcp list`); the
  model is never asked anything, so it costs no tokens. Runtime plugins get `connectCheck` for it.
- The GUI's Run tab has "Check the AI connection first", on by default for a mock run; it runs as the first step.

## 0.19.6 — 2026-09-17

- Video descriptions describe only what belongs to the run: for a run that reached its goal, the moments stop at the
  goal, and a part of the recording made after the goal says so instead of listing the resume and the goal extension
  (owner, 2026-09-17, the cut of the act 1 run: after the Act 1 boss it shows the main menu of a later session).

## 0.19.5 — 2026-09-17

- GUI Setup: every row is checked on its own and shows "Checking…" until its result is in; saving a setting checks
  that setting at once; the results are kept (`.local/gui-checks.json`) and a restart shows them again; a setting
  without a check (keep displays awake) has no status. The harness side (repository, Node, ffmpeg, Claude Code, Codex)
  shows its paths at once, and OBS and Steam show the default path the launchers use when none is set.
- Slay the Spire has read-only checks (its mods, the bridge copy, Communication Mod's config); Portal's no longer
  checks Steam, which the launcher starts itself.

## 0.19.4 — 2026-09-17

- Portal: every test chamber after the first is an end of its own (`chamber01` … `chambere02`, reached on entering
  it), each with its LiveSplit file; the credits stay the default. A Portal bundle's `ends` lists them.
- The first prompt names the run's goal: a game plugin's `goalPrompt` may be a function of the chosen end (Balatro,
  Slay the Spire and Portal use it); the agent instructions of Balatro and Slay the Spire refer to that goal.
- LiveSplit starts without questions: `packages/timer-livesplit/windows-setup.mjs` (the GUI runs it after installing
  LiveSplit, or from its check) asks Windows for permission once, blocks that LiveSplit's outbound network (its update
  check at every start fails quietly; the version stays the pinned one) and registers its file types, which it asked
  administrator rights for at every start.

## 0.19.3 — 2026-09-17

- GUI Setup shows the settings as `.env` has them at once; the check runs only on its button ("Initial check" when
  nothing is set, then "Check again"), and a changed setting keeps the other results.
- SoundVolumeView (NirSoft, 2.53, pinned by sha256) is installed by the GUI into `%LOCALAPPDATA%\aas`
  (`packages/core/src/windows/install-soundvolumeview.mjs`), as LiveSplit is.

## 0.19.2 — 2026-09-17

- Balatro: Ante 1 to Ante 7 are ends of their own (`--goal ante1` … `ante7`), shorter goals for tests and first runs;
  `win` stays the default. Each has its LiveSplit file.

## 0.19.1 — 2026-09-17

- The OBS recorder sets OBS's own recording folder back only after the recording has stopped, and says so, or says
  that it could not: before, OBS refused the change while the recording was still stopping, and the folder of the last
  run stayed OBS's recording folder.

## 0.19.0 — 2026-09-17

SPEC 0.38: in a video's description, durations carry a word joiner (U+2060) before each colon.

- YouTube makes every `m:ss` and `h:mm:ss` within a video's length a link to that place, also in the middle of a
  sentence ("after 00:02:02.0 of game time" in the cut of portal-02). With the word joiner the text looks the same and
  is not linked (measured by the owner on 2026-09-17). Places in the video ("2:10 The run is resumed.") keep plain
  colons, on their own line and within the video. Titles are unchanged; the code does not change, so a published video
  can take the new description as it is.

## 0.18.4 — 2026-09-17

- `aas gui` (`npm run gui`, or `AAS.cmd` from Windows): a local web page to set up and start runs without a shell.
  Setup finds the tools and games in their standard places (registry, Program Files, `%LOCALAPPDATA%\aas`, the
  Steam libraries, Epic, GOG; drives are never searched), checks versions and use, and fixes what it can with one
  click. Run shows the commands for the chosen game, run type, name, goal, limit and seed, and Start runs exactly those;
  runs go to `<AAS_OUTPUT_DIR>/<game>/<run>/`.
- Game plugins can declare `setup` (folder, settings with store look-up, install/launch/stop scripts, splits, bot,
  display variable); Balatro, Slay the Spire and Portal do.
- `aas run` and `aas resume` stop the agent session on Ctrl-C or SIGTERM like a budget stop: the game is saved, the
  recording kept and everything closed.
- LiveSplit 1.8.37 is pinned (`packages/timer-livesplit/UPSTREAM.json`); `install-livesplit.mjs` installs it with its
  server starting with it.
- The Portal installer takes `AAS_PORTAL_GAME_ROOT` when `--game-root` is not given.

## 0.18.3 — 2026-09-17

- Code that is not about one game left the game folders: Steam, displays, quiet audio and keep-awake are in
  `packages/core/src/windows/` (`ensureSteam`, `listDisplays`/`displayAt`, `beforeGameStart`/`afterGameClose`), used by
  the Portal, Slay the Spire and Balatro launchers. `games/portal/place-windows.mjs` is gone.
- `npm run livesplit:launch -- <splits.lss>`: LiveSplit with the game's splits (a LiveSplit with other splits is closed
  first), its server checked, its window at `AAS_LIVESPLIT_POS`.
- `npm run balatro:scripted -- <run-dir>`: the Balatro chain with the scripted player, OBS and LiveSplit.
- Documentation: Balatro in the install guide, the design, the plugin guide, the disclaimer and the license table.

## 0.18.2 — 2026-09-17

- Balatro is a game plugin (games/balatro), no longer a stub: balatrobot 1.5.2 on Steamodded 1.0.0-beta-1814a and
  Lovely 0.9.0, pinned with their sha256. A bridge between the agent and balatrobot refuses `add` and `set` to everyone
  and the harness's `start`, `menu`, `save` and `load` to the agent. Goal `win` (ante 8), splits per ante, restart
  after a game over. The run plays on its own profile slot; the launcher can put the game on another display through
  the game's own display setting and keep its audio off the speakers.
- Core: `json-rpc-http.mjs`, a JSON-RPC client over `node:http` for game bridges that speak HTTP, with a deadline that
  also covers connecting (under WSL's mirrored networking a connection to a closed port hangs until the TCP timeout).
- `aas run` and `aas resume` end when a preflight fails (LiveSplit not reachable, OBS already recording); the overlay
  server and the OBS connection kept the process alive after the error.

## 0.18.1 — 2026-09-16

- Portal's goal is "Credits" again, as in the text the owner approved ("stopped before the credits").

## 0.18.0 — 2026-09-16

SPEC 0.37: the example video texts in the wording the owner approved on 2026-09-16 for the cut of portal-02.

- Title: "Claude Sonnet 5 plays Portal (cut): stopped before the credits", with a colon.
- Description: the goal and how the run ended, which video this is, what the picture shows ("Top left: … Bottom
  left: …"), what happens in the video as "m:ss what happens" ("2:10 The run is resumed."), the AAS paragraph, and
  "Verification code for the AAS Archive:" with the code on its own line. How a person restarted the run is left to
  the archive.

## 0.17.0 — 2026-09-16

SPEC 0.36, schema 14: one code to copy (owner 16-09: lines with spaces, special characters and capitals make
copying error-prone).

- Every video of a revision carries the same code, `aas` and the first 32 hex digits of the fingerprint, in
  lowercase and without separators: `aas36d633208676bfdb5e1c0a47b93f2d8e`. 32 hex is 128 bits: making a bundle whose fingerprint starts
  the same takes about 2^128 hashes; 16 hex (2^64) is within reach of about 1000 rented GPUs in ten days. It replaces the line with run id, fingerprint and
  length; the archive measures a video's length itself and holds it against the lengths in the bundle, which stay.
- `aas check` requires the code in each video's description as a word of its own. A bundle of schema 8 to 13 keeps
  its line, and a video that carries it stays bound to that bundle.
- The upload sheet and `aas publish` give the code.

## 0.16.0 — 2026-09-16

SPEC 0.35: durations in ISO 8601 (owner 16-09: "the international standard everyone understands").

- Every duration the tooling shows people is hh:mm:ss with two digits each: game time with tenths (00:02:02.0), real
  time in whole seconds (00:10:32); hours past 24 go on counting. That covers the example video texts, the upload
  sheet, the lengths in `aas check` (with the seconds of the line next to them), and the logs of `aas run` and
  `aas render`. A place in a video stays as YouTube writes it (11:15), and the line keeps its seconds.

## 0.15.1 — 2026-09-16

- A recording whose length could not be measured (no ffprobe, or not a video) lists no whole-recording video: its
  line would state a length the bundle does not, and `aas check` rejected the bundle `aas publish` had just made.

## 0.15.0 — 2026-09-16

Summary schema 13, SPEC 0.34: the example video texts are written for viewers, and a bundle says what the picture
shows.

- `run.started` says whether the harness's overlay was in the picture; `summary.recording.overlay` is `{shown, keys}`,
  or null for a run from before.
- The example title and description come from `youtube-text.mjs`, which imports only `videos.mjs` and `models.mjs`,
  so the archive can carry it and suggest the same texts. In plain sentences: who plays what and how it ended
  ("Claude Sonnet 5 plays Portal (cut) — stopped before the end credits"), what the picture shows (LiveSplit top
  left; the overlay bottom left with the section, RTA and IGT, the keys, the last command), what happens in that
  video only (a restart by a person, a goal reached, a goal extension), and the archive's domain and the run id as
  text. No links, no runtime name. Timestamps are listed only when YouTube makes chapters of them. The line stays
  last, after "Verification line for the AAS Archive:".
- Portal's goal is "End credits".

## 0.14.0 — 2026-09-16

SPEC 0.33: the AAS Archive witnesses when each segment ran.

- Once the game is up, and when a segment's recording has stopped, `aas run` and `aas resume` send the archive a
  statement signed with the publisher key (`aas key`) and log its receipt as `run.witnessed`, which the published
  timeline keeps. Without a network, a key or an answer the run goes on, logged as `run.unwitnessed`.
- `aas check` verifies the receipts against the archive's witness keys and reports "witnessed"; a bundle without
  receipts is not conforming.
- `AAS_WITNESS_URL` (`off` for none; `npm test` sets it) and `AAS_WITNESS_KEYS` (another witness's keys).
- `aas doctor` says whether the witness knows the publisher key.
- `aas resume` logs `recording.stopped` for its segment, as `aas run` does; it was missing.

## 0.13.1 — 2026-09-16

The example video description reads well on YouTube.

- The run's page comes first, with the run id in plain text (YouTube shortens long links and shows only the first
  lines), then the model, the game and the result in one sentence. The line stays last.
- No link to the bundle checker: a viewer has no bundle.
- Timestamps are headed "Chapters" only when YouTube makes chapters of them (at least three, the first at 0:00, each
  at least ten seconds); otherwise "Moments".
- The upload sheet says that the run's page is found only once the archive has put the run online.

## 0.13.0 — 2026-09-16

SPEC 0.32: each session says which tooling ran it.

- `run.started` carries `tooling`: the version, the commit of the clone, and whether tracked files were modified.
  The published timeline keeps it, so a bundle shows per segment which release recorded it.
- `aas resume` refuses tooling older than an earlier session of the run, and a breaking release between the run's
  last session and the installed tooling unless `--allow-breaking` is given; that choice is logged in `run.started`.
  `versions.mjs` lists the breaking releases (none so far).

## 0.12.0 — 2026-09-16

SPEC 0.31: a run keeps the tool interface it started with.

- `aas resume` refuses, before anything starts, when the installed tooling or game plugin would serve the agent other
  tools or documentation than the run's `tools.json` and `documentation.md`; the run directory is left as it was.
  Resume such a run with the release it started with.
- The broker does not serve a run whose `tools.json` or `documentation.md` differs from what it would serve;
  `--check-interface` only compares.

## 0.11.0 — 2026-09-16

Summary schema 12, SPEC 0.30: mod details. The tooling reports its version as 0.11.0.

- Schema 12: each mod carries details, what was done to it beyond its own name; SourcePauseTool's name without the IPC patch (SPEC 0.30) (518860b)

## 0.10.0 — 2026-09-15

Summary schema 11, SPEC 0.29: model parts. Tag v0.10.0 at 139a4df.

- Schema 11: each model carries parts, its id split into name, variant, version and snapshot by the maker's naming; null for an id the tooling does not know (SPEC 0.29) (139a4df)

## 0.9.0 — 2026-09-15

Summary schema 10, SPEC 0.28: what the runtime reported about each model; runtime CLI versions. Tag v0.9.0 at 7f4f313; 0.9.1 at d92bc25, the last commit before the next minor.

- Schema 10: each model carries the context window, maximum output and provider its runtime reported; the runtime CLI's versions apart from the plugin's (SPEC 0.28) (7f4f313)
- reference: claude-results.jsonl keeps every invocation's result (01fe601)
- A new revision, step by step: render again after a resume, move the old bundle aside, same options, compare the lines; the upload sheet marks a cut that is out of date (d92bc25)

## 0.8.0 — 2026-09-15

Summary schema 9, SPEC 0.27: example title and description per video. Tag v0.8.0 at 802d7a8.

- Schema 9: each video carries an example title and description ending on its line (SPEC 0.27) (802d7a8)

## 0.7.0 — 2026-09-15

Summary schema 8, SPEC 0.26: recording.videos. Tag v0.7.0 at 5affac4.

- Schema 8: recording.videos lists the videos a runner may upload (SPEC 0.26) (5affac4)

## 0.6.0 — 2026-09-15

SPEC 0.25: the runner uploads the cut, the full recording per segment, or both. Tag v0.6.0 at 7e7fd20.

- Runner's choice: upload the cut, the full recording per segment, or both; each video's line carries its own length (SPEC 0.25) (7e7fd20)

## 0.5.0 — 2026-09-15

SPEC 0.24: versions.mjs; an archive may keep a run that did not reach its goal. Tag v0.5.0 at 02858cc; 0.5.1 at df4445e, the last commit before the next minor.

- The versions the checker reads in versions.mjs, without imports; SPEC §3: an archive may keep a run that did not reach its goal (0.24) (02858cc)
- aas upload-sheet: everything for a video upload in recording/UPLOAD.txt, next to the videos (fdc95e7)
- Upload sheet shows paths on a WSL drive as the Windows drive the file dialog knows (b6e48fb)
- Upload sheet: the run's own text opens the description, the fingerprint line closes it (8354d7d)
- Upload sheet chapters leave out the save name and the resumed session's exit code, turns and cost (d18f4db)
- Upload sheet holds only the video upload: the file, a title and the description (a4348f1)
- Upload sheet says the one requirement: the fingerprint line in the description; title and description are an example (07fdb54)
- Upload sheet: the explanation of the fingerprint line sits with the requirement, not in the example description (df4445e)

## 0.4.0 — 2026-09-15

Summary schema 7, SPEC 0.23: the recording is checked when the run starts. Tag v0.4.0 at a0dbba4.

- The recording is checked when the run starts, not measured afterwards; schema 7; SPEC drafts numbered (0.23) (a0dbba4)

## 0.3.0 — 2026-09-14

Summary schema 6: goals by name, the game's ends, every goal the run had. Tag v0.3.0 at e1aa20a; 0.3.1 at 69b814d, the last commit before the next minor.

- Goals are recorded as they were, with their names, for every game (e1aa20a)
- aas check names an earlier goal that was reached (f5ea7f8)
- An extended goal is published once it is reached (ba4cff3)
- A bundle states the run's times to its goal; post-completion is marked (5bf55ed)
- The winning playback counts to completion, and the goal's milestone ends the splits (8a94c20)
- SPEC §8.3 carries the same human-axis exception as §6 and the checker (c3d98b5)
- Say what is so about portal-agent, and nothing about what it has not done (029720d)
- Credit portal-agent for the idea, kindly (0792efb)
- Credit cozyblaze, the person, for the run, the design and the code (b3bf8a6)
- Attribution and license texts for the code by others (5042abd)
- Stubs for the planned game plugins (6343ca1)
- aas check takes the upload zip, with the same verdict as the bundle directory (0b25b02)
- Name the AAS Archive where the tooling hands a run over (4aaed9e)
- Say what the archive does today: the zip at submit, keys on the account page (241b8d2)
- Key dates on the account page, as the archive shows them (5b80025)
- Stub for Unreal Engine games through UE4SS, first planned for Zero Company (1be0300)
- SPEC: summary.json as schema 6 writes it (bundle, identifiers, harness_events, recording files, black interval marks) (972007a)
- README: what the folders do, and a run from recording to upload (69b814d)

## 0.2.0 — 2026-09-14

Summary schema 5: video links come from the archive, not from the bundle. Tag v0.2.0 at c54fcc0; 0.2.1 at 7b52184, the last commit before the next minor.

- Video links come from the archive, not from the bundle (c54fcc0)
- A bundle reports the mods that were loaded, not every jar in the folder (52b41e1)
- A victory before a goal extension does not complete the extended goal (437c74c)
- Black frames are part of the recording, not a failure (7b52184)

## 0.1.0 — 2026-09-13

First public release: summary schema 4, SPEC draft 0.1. Tag v0.1.0 at 84341e1; 0.1.1 at e0f0afc, the last commit before the next minor.

- AI Assisted Speedruns: plugin framework and open standard (84341e1)
- Documentation says what the tooling can do, and how to install it step by step (1e5aa79)
- Installers are linked, WSL is a prerequisite of its own, and the signing key is the publisher key (77d2ab7)
- Docs keep no mount path of their own (f8a092b)
- Several published keys is the normal case, and the guide says so (27b5458)
- Which GitHub key list a publisher lands in decides whether they can be matched (d5dbdf7)
- An entry says who published it: signing is a requirement, not a nicety (e87662b)
- --sign on its own uses the key the publisher already pushes with (751b7a4)
- The publisher makes their own key: no code-hosting account anywhere in the chain (bc9b9ce)
- Binding a recording to a bundle is two claims, not one (0e7523d)
- An unsigned publish prints the two commands that fix it (8f5ed39)
- Retiring a key does not un-publish what it signed (e722754)
- The one line a publisher must paste is printed as one line (a140055)
- Signing is a marker for whoever wants one, not a requirement (631aed4)
- The standard names no place to record a key (8891c25)
- A key can be published anywhere, so the tooling writes what you publish (8dd1372)
- The reference described the bundle of two versions ago (1890267)
- The repository makes no claim about how a game was obtained (4de43d6)
- A Claude Code agent is offered the broker's tools and no other (48ee01c)
- A run without a recording is invalid, as the README says (d5e241e)
- Each game says what it gets, and the rule says what is allowed (e0f0afc)

