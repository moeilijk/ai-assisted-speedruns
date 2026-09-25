# `aas` reference

What the tooling in this repository does, command by command, and what it leaves behind. Everything here is taken from the code as it is (`packages/core/src/cli.mjs` and the modules it calls); where a detail is game-specific the game plugin's README has it. For installing it, [install.md](install.md); for the standard itself (what a published run must contain) see [../packages/spec/SPEC.md](../packages/spec/SPEC.md); for the architecture and the decisions behind it, [design.md](design.md); for writing a plugin, [plugins.md](plugins.md).

## At a glance

One run, from an empty directory to something an archive can check:

| | Command | |
|---|---|---|
| before | `aas doctor` | is everything this run needs there and reachable |
| | `aas check-connection` | the real broker against the real game, the three tools the agent will get |
| | `aas budget` | how much of each plan is left |
| | `aas configure` | the run directory: identity, category, goal, the agent's hardened configuration |
| the run | `aas run` | the whole chain: record, prepare, time, play, save, stop, close |
| | `aas resume` | continue a stopped run: restore the save, resume the session, a new segment |
| | `aas start` | only the agent, against a configured directory (development) |
| after | `aas timeline` | RTA, IGT, thinking time, sections, attempts, cut list, subtitles |
| | `aas render` | the video with the thinking pauses cut out, optionally with burned-in timers |
| | `aas publish` | the public bundle + the upload zip, scanned and checked (signing optional) |
| | `aas upload-sheet` | `recording/UPLOAD.txt` in the run directory: the cut and the full recording per segment, each with the line its description needs |
| | `aas check` | the conformance check of a bundle, including goal, recording and signature |
| keys | `aas key [file]` | the publisher's signing key: makes one if there is none, prints the public line and fingerprint to register with an archive. Safe to call unconditionally — it never overwrites, so `aas key && aas publish … --sign` needs no guard |
| | `aas key --claim --identity <uri> [--identity <uri>] [--out <file>]` | the publisher's own signed statement that this key is theirs, as plain text to publish wherever they are known (a profile, their own domain, inside a `gpg --clearsign` block) |
| | `aas key --verify <file\|->` | reads a claim back out of whatever it was published in and says whether it verifies, and which identities it names |
| | `aas scan` | only the privacy scan |

Every command works the same whatever game, runtime, recorder or timer is loaded: the core calls the plugin
contracts and knows no game, model or recorder by name.

## The pieces

- **Core** (`packages/core`): the broker (the MCP server with the three tools the agent gets), the process hardening around it, the run log, and the `aas` commands.
- **Plugins**, four kinds, loaded by id from `packages/<kind>-<id>/index.mjs` or from a module path:
  - **game** (`--game games/<id>/plugin.mjs`): the controller object the agent's code runs against, the API documentation, and the game side (launch, prepare, save, close).
  - **runtime** (`--runtime codex|claude-code|scripted`, or a module path): writes the agent's hardened configuration into the run directory and starts the agent.
  - **recorder** (`--recorder obs|source-demo|null`): records the run and reacts to run events (scenes, chapters).
  - **timer** (`--timer livesplit`): the speedrun timer on screen and the splits.
- **The agent** sees exactly three tools: `<game>_documentation`, `<game>_screenshot`, `<game>_exec`. Everything else (shell, web, files outside the run directory) is denied by the runtime's configuration.

## Settings

Machine settings live in `.env` in the repository root, copied from [`.env.example`](../.env.example). The CLI and every `npm run` script load it themselves (Node's `--env-file-if-exists`); a variable already set in the shell wins. Nothing else is read from the machine.

| Variable | Used by | Meaning |
|---|---|---|
| `AAS_OBS_URL`, `AAS_OBS_PASSWORD`, `AAS_OBS_EXE` | recorder obs, `npm run obs:launch`, doctor | obs-websocket address and password; OBS executable for the launcher |
| `AAS_LIVESPLIT_HOST`, `AAS_LIVESPLIT_PORT`, `AAS_LIVESPLIT_EXE`, `AAS_LIVESPLIT_POS` | timer livesplit, `select-splits.mjs`, `launch-livesplit.mjs` | LiveSplit Server address; the executable (its `settings.cfg` is next to it); window position |
| `AAS_BUDGET_WEEKLY_MAX` | `aas budget`, run, resume, doctor | share of the weekly Claude plan that runs may use (default 50) |
| `AAS_CODEX_BUDGET_MAX` | `aas budget`, run, resume, doctor, the Codex runtime | share of the ChatGPT plan's window that Codex runs may use (default 50); the stand comes from the `rate_limits` Codex writes into its rollouts after every turn, no endpoint is asked |
| `AAS_PROOF` | run, resume | `anonymous`: record proof without an account (the one question the GUI asks); `off`: never. Signed in (`aas login`), runs record proof under the account. See [the README](../README.md#proof-that-the-logs-were-not-changed) |
| `AAS_TIME_ZONE` | broker, publish | time zone of the run log (default the machine's) |
| `AAS_STEAM_EXE` | launchers, close | Steam executable, when not at its default path |
A setting that belongs to one game lives in that game's own file, `.local/games/<game>.env`; everything that is
true for the whole machine (OBS, LiveSplit, the output location, budgets, sound, screens) stays in `.env`. Which
settings belong to a game is what its plugin declares (`env`, `setup.settings`, `setup.displayEnv`,
`setup.resolutionEnv`), so nothing is guessed. Both files are read by every command; the game's file is read first
and its value therefore stands, and a variable already set in the shell beats both.
`node packages/core/src/gui/migrate-settings.mjs` moves the game settings out of an older `.env`.

| `AAS_OUTPUT_DIR` | `aas gui` | where the GUI saves runs: `<output>/<game folder>/<run>/`, bundles in `<output>/<game folder>/public/<run>` |
| `AAS_QUIET_AUDIO_DEVICE`, `AAS_SOUNDVOLUMEVIEW`, `AAS_KEEP_DISPLAYS_AWAKE` | launchers | optional: route the game's audio to another device while it starts; keep the displays awake |
| `AAS_PORTAL_*` | Portal plugin and scripts | see [../games/portal/README.md](../games/portal/README.md) |
| `AAS_STS_*`, `AAS_BOT_*` | Slay the Spire plugin, scripts and the scripted bot | see [../games/slay-the-spire/README.md](../games/slay-the-spire/README.md) |
| `AAS_BALATRO_*`, `AAS_BOT_BALATRO_ATTEMPTS` | Balatro plugin, scripts, bridge and the scripted bot | see [../games/balatro/README.md](../games/balatro/README.md) |
| `AAS_BIZHAWK_DIR`, `AAS_BIZHAWK_PROFILE`, `AAS_BIZHAWK_ROM`, `AAS_BIZHAWK_ROMS` | BizHawk plugin and scripts | see [../games/bizhawk/README.md](../games/bizhawk/README.md) |
| `AAS_FCEUX_DIR`, `AAS_FCEUX_PROFILE`, `AAS_FCEUX_ROM`, `AAS_FCEUX_ROMS`, `AAS_FCEUX_BRIDGE_HOST`, `AAS_FCEUX_BRIDGE_PORT`, `AAS_FCEUX_BRIDGE_DIR` | FCEUX plugin and scripts | see [../games/fceux/README.md](../games/fceux/README.md) |

Variables the harness sets for the broker process itself (`AAS_RUN_DIR`, `AAS_GAME_MODULE`, `AAS_ALLOWED_ENDPOINTS`, `AAS_TIME_ZONE`) are not settings. The broker's environment holds those and the variables the game plugin declares in its `env` list, nothing else of the machine's environment; the published copy of the configuration shows the plugin's variables as `__ENV__`.

## Commands

All commands: `node packages/core/src/cli.mjs <command> ...` (the `aas` bin of the package). The npm scripts in `package.json` are the same commands with the plugins of one game filled in.

### Before a run

| Command | What it does |
|---|---|
| `aas check-agent --runtime <claude-code\|codex> --game <plugin.mjs> [--run-dir <dir>] [--keep]` | Does the agent's own CLI reach the broker? It configures a throwaway run directory exactly as a run would and has the CLI list and health-check its MCP servers (`claude mcp list`, `codex mcp list`). The model is never asked anything, so this costs no tokens: it proves the runtime's configuration, its trust flag and the broker together, which the playing itself does not. A mock run runs it for every agent that is installed. Exit code 1 when the CLI does not reach the game's tools. |
| `aas run --runtime scripted --bot <bot.mjs> …` (**a mock run**) | The whole chain without a model and without tokens: the game's own scripted player plays the run. It is the test of this machine. Started from the GUI it first has every agent CLI that is installed reach the game's tools (`aas check-agent` per agent; an agent that is not installed is skipped, which is not a failure), and then does exactly what an AI run does: start the game with its mods and bridge, start the chosen recorder and LiveSplit, play to the chosen goal with in-game time and milestones, close everything, and make the timeline and the bundle. What it cannot prove is the model's own playing; everything the model needs around it is proven. A mock run that goes through means an AI run of the same game and goal starts on the same tools. |
| `aas gui [--port 8770] [--no-open]` | A web page on `127.0.0.1` (opened in the browser) to set up and start runs without a shell. **Setup**: every tool and game setting from `.env` with a check of version and use, the tools found in their standard install places (the registry, Program Files, `%LOCALAPPDATA%\aas`) and the games in the Steam libraries, Epic's manifests and GOG's registry (drives are never searched); The page shows the settings from `.env` at once and checks them only on its button (Initial check, then Check again). One-click fixes: install a game's mods, install LiveSplit or SoundVolumeView (pinned) into `%LOCALAPPDATA%\aas`, turn on LiveSplit's server, take OBS's WebSocket password. **Run**: game, who plays (the game's scripted player in a mock run, or an AI) which AI (it plays an AI run; a mock run checks that it reaches the game's tools), run name, goal, recording (the recorders the game plugin fits, named by their own plugin: OBS for every game, the in-game demo for Portal, and no recording at all, which is never a valid run), time limit, and a seed only for a game whose run has one (Balatro, Slay the Spire; not Portal); the commands for those choices are shown as they change, and Start runs exactly those: the game's launcher, `npm run obs:launch`, `npm run livesplit:launch`, `aas run`, `aas timeline`, `aas publish`. Stop ends a running session like a budget stop (saved, recording kept, everything closed); with nothing running it closes the game, LiveSplit and OBS. `AAS.cmd` in the repository folder starts it from Windows (through WSL). A page whose GUI has ended says so over everything else (what is still running, what to try, and a report with the log), and picks up again by itself when the GUI is back. **Continue** (Run tab, after a session that stopped): the run goes on as its next segment with `aas resume`, the game, the recorder and LiveSplit started first as at Start, and the bundle made again as a new revision. **The Archive** (Run tab): signed in or not, how runs record their proof, Sign in and Sign out (`aas login`, `aas logout`), the one question at the first start whether runs record their proof anonymously (kept as `AAS_PROOF` in `.env`), a warning before an unsigned run starts, the tickets of this machine's runs with extend, revoke and delete (`aas tickets`), and after a session, when signed in, upload to the archive (`aas upload`). Every choice is a button, and every button says what it did: next to where it was pressed, busy while it works and then done, or not done with the reason, and the same outcome in the log on the Run tab (a save names the file and the setting, a secret only as set or empty; every check result stands there with the condition that failed). Only one GUI runs at a time: a second start (double-clicking `AAS.cmd` again) says the GUI is already running and opens that page, instead of failing on the port; a port held by something else names another port to use. |
| `aas doctor --game <plugin.mjs> [--recorder obs] [--timer livesplit] [--runtime claude-code] [--run-dir <dir>]` | Read-only checks: Node version, the game plugin loads and has documentation, its endpoints are reachable, OBS reachable and authenticated and not already recording, LiveSplit Server reachable, the Claude plan budget, and for the Claude Code runtime: `claude` on the PATH, its config file writable, and (for an existing run directory) that Claude Code trusts it. Exit code 1 when a check fails. |
| `aas check-connection --game <plugin.mjs> --run-dir <dir> [--exercise]` | Starts the real broker against the game, does the MCP handshake, calls the three tools, and with `--exercise` runs the plugin's own exercise list. Writes into the run directory (screenshots, a short `run.jsonl`). |
| `aas budget [--max <percent>]` | The Claude plan usage (5-hour window and week, from Claude's own usage endpoint) under `AAS_BUDGET_WEEKLY_MAX`, and the ChatGPT plan's window as Codex last recorded it under `AAS_CODEX_BUDGET_MAX`. Exit code 1 when the Claude plan is over. |
| `aas configure --runtime <id> --game <plugin.mjs> --run-dir <dir> [--model m] [--effort low|medium|high|xhigh|max] [--goal g] [--prompt text] [--instructions file] [--id name]` | Creates the run directory: `brief.json` (the run's identity, category, model, instructions, goal prompt), the runtime's hardened configuration, `AGENTS.md`, `runtime-config/` with machine paths replaced for publication. Refuses to overwrite. The goal is one of the game's ends (the plugin's `ends` list): no `--goal` means the game's own end; `--goal act1` picks an earlier or alternative end, checked against the list, and the harness declares the victory when that end's milestone goes by. `--seed` is the run's seed for games that have one (`brief.seed`, handed to the plugin), `--build` overrides the category's build string, `--id` the run's id when it should differ from the directory's name, and `--bot <module>` is the bot the `scripted` runtime plays with. `aas run` calls this itself when the run directory is new. |

### The run

| Command | What it does |
|---|---|
| `aas run --runtime <id> --game <plugin.mjs> --run-dir <dir> [--recorder obs|source-demo|null] [--timer livesplit] [--overlay-port 8765] [--headless --max-turns N --max-minutes M] [--autosave-minutes 10 | --no-autosave] [--ignore-budget] [--keep-open] [--proof off] [configure options]` | A run directory that already has a run log is refused: a run that has started is continued (`aas resume`), never started again. The whole chain, in this order: configure (when new) → budget check (Claude Code runtime) → the segment's ticket when the run records proof (a run that wants proof and gets no ticket does not start; `--proof off` records it unsigned) → overlay server → recorder preflight and timer preflight → recorder start (t0) → the plugin's `prepareRun` (new game, ready for the agent) → timer start → `run.started` → the runtime starts the agent and waits → the agent stops (done, turn or time budget, weekly budget, `game.over` with victory) → final save state → `run.ended` → the plugin's `endRun` → timer stop → recorder stop, the recording copied into `<run>/recording/` → `outcome.json` → close: the game, LiveSplit and OBS when used, Steam when a launcher of this harness started it, then a measurement of what is still running. When the game fails to come up the recording is stopped and discarded, `run.error` is logged, everything is closed, and the command fails. `--keep-open` skips the close step. |
| `aas resume --run-dir <dir> [--save name] [--goal <later end>] [--allow-breaking] [--recorder obs] [--timer livesplit] [--overlay-port 8765] [--headless --max-turns N --max-minutes M] [--prompt text] [--keep-open] [--proof off]` | Continues a stopped run in the same directory, with a ticket of its own for the new segment when the run records proof. It refuses before anything starts when the installed tooling is older than the tooling of an earlier session, when a breaking release (CHANGELOG.md) lies between them and `--allow-breaking` is not given, or when the installed tooling or game plugin would serve the agent other tools or documentation than the run's `tools.json` and `documentation.md`; resume with the release the run started with. Each session's `run.started` names the tooling that ran it (version, commit, whether the clone was modified, and a breaking release the runner allowed). Then the runtime's configuration is rewritten (paths may have moved), the game is restored to the last save (or `--save`), the agent's own session is resumed with a short notice, a new recording segment is added to `recording.json`, and `run.human` is logged, which makes the category `restart-only`. A run that reached its goal is over, unless `--goal` extends the goal to a later end of the game (act 1 to the game's own end): that is logged as `run.human` and `game.goal`, the earlier victory no longer ends the attempt, and the agent is told the larger goal. The goal is never shortened. Closes everything at the end like `aas run`. |
| `aas login` / `aas logout` | Signs this machine in to the archive, the way `claude` signs in to Anthropic: the archive's page opens in your browser, you sign in and allow the tooling there, and the tooling keeps an access token and a refresh token in `~/.config/aas/credentials.json`, readable only by you. From then on every run records its proof under your account. `aas logout` has the archive revoke the token and forgets it here. |
| `aas tickets [extend\|revoke\|delete <ticket>]` | The tickets of this machine's runs with their run directory, segment and expiry; extends, revokes (it can no longer be submitted) or deletes one at the archive. |
| `aas start --runtime <id> --run-dir <dir>` | Only the agent, against an already configured run directory, without recorder, timer or game preparation. For development. |

Budgets in a headless run: `--max-turns` (the runtime's own turn limit), `--max-minutes` (wall clock; the session is interrupted), the plan budget (Claude: the usage endpoint polled every 3 minutes; Codex: the stand in the thread's rollout read every 3 minutes; the session is interrupted). All end the run as `stopped`, which can be resumed. The victory ends it as `completed`.

### After the run

| Command | What it does |
|---|---|
| `aas timeline <run-dir> [--margin-before s] [--margin-after s] [--attempt last|N]` | From `run.jsonl` and `recording.json`: RTA, IGT (sum of the playbacks), thinking time, sections (chapter milestones), attempts (one per `game.attempt`, ended by `game.over`), the cut list (only the playbacks, with margins). Writes `<run>/timeline/`: `timeline.json`, `chapters.txt`, `chapters.cut.txt`, `cut.sh`, `timers.srt`, `inputs.srt`. |
| `aas render <run-dir> [--video f] [--out f] [--burn timers,inputs] [--no-cut] [--crf 18] [--attempt last|N]` | ffmpeg: the recording with the thinking pauses cut out (`<name>.cut.mp4` next to it), segments of a resumed run concatenated, optional burned-in subtitles. No chapters and no data streams in the cut. `aas run` and `aas resume` run it themselves at the end; by hand it makes the cut again, for example with `--burn`. |
| `aas publish <run-dir> <out-dir> [--sign <key>] [--session <log>] [--completion-marker <text>] [--upload]` | With `--upload` the zip is sent to the archive under the account you are signed in with. **The bundle for the archive**, made from the private run directory: the runtime's private session log exported and sanitised into `session.sanitized.jsonl` with the harness events of `run.jsonl` merged in on the same clock (not `budget.checked`; file paths and session ids dropped), `summary.json` (schema 16: the identifiers and versions, the models used with their parts (name, variant, version) and what the runtime reported about them (context window, maximum output, provider), the runtime CLI's versions, the category with the goal by name, the game's ends and every goal the run had with when it was reached, the game's build and mods (each mod's own name, with what was done to it in details), the recording's length and fingerprint, and the videos a runner may upload with each one's length, code, chapters and an example title and description, plus what says whether a model played it at all: `mock`, the runtime's own `sha256`, `ai_evidence` (the model's messages, tool calls, models and output tokens in this timeline, and the messages a human typed beyond the goal prompt of each segment), `category.goal_prompt` verbatim and `brief` with the sha256 of the instructions and of that prompt), `tools.json`, `AGENTS.md`, `documentation.md`, `runtime-config/` (regenerated: paths as placeholders, the game plugin's variables as `__ENV__`), `game-config/`, `chapters.txt`, `timeline.json`, `splits.lss`, `manifest.json` with sha256 per file. The recording is not in the bundle, and neither is its link: publish it where video is published; the bundle carries the recording's length and a fingerprint (the sha256 of `session.sanitized.jsonl`, this bundle's own published timeline) that the publisher puts in the recording's description, which is what ties the two together. `--sign [key]` signs the bundle with an ed25519 key — without a path, the publisher's own key (`aas key`, then an SSH key if they have one, or `AAS_SIGN_KEY`): the signature covers `manifest.json` and therefore the whole bundle, and lands in `signature.json`. Signing is optional: an unsigned bundle is complete, because who published a run is what an archive's account says, not what a file claims. A signature that is present must verify, or `aas check` reports it invalid. It also carries what it takes to play the same thing again: the game's own build, the mods with their pins and the run's settings, reported by the game plugin. Then the scan (home and WSL mount paths, e-mail addresses, credentials, a password or token in a config, identifiers, images) and the conformance check. A bundle with a finding is removed again and the command fails; a bundle the scan cleared is also packed as `<out-dir>.zip`, the upload file: the whole bundle under one directory named after the run. It is small because a bundle never holds the recording. |
| `aas check [--strict] [--core] <bundle-dir \| bundle.zip>` | The conformance check of a bundle, its directory or the upload zip (the zip is unpacked into a temporary directory and gives the same verdict): the public-bundle marker, required files, timeline format, summary schema, manifest hashes, models used versus requested, whether a recording was made at all (a bundle from recorder `null` is invalid: a run without a recording is not a valid run), whether a model played it at all (a bundle is a mock unless its runtime says a model plays and the timeline shows one did, SPEC §3), whether every playback stands inside the tool call that asked for it, and whether the run reached its declared goal. What the published video shows is not checked here: the recorder checked the recording when the run started, and the video is the archive's to judge. `--core` is accepted and does nothing: it used to mean a bundle without its recording files, which is now every bundle. Exit code 1 when invalid (with `--strict` also when a should-requirement is unmet). |
| `aas upload-sheet <run-dir> [--bundle <public-dir>] [--note <text>]` | Writes `<run>/recording/UPLOAD.txt`, next to the videos in the private run directory, with only what uploading them to a video site takes. The runner uploads the cut, the full recording, or both; the sheet lists the cut (the `.cut.mp4` of `aas render`, or how to make it) and the full recording file by file (one per segment of a resumed run), each with its length, its moments (without the harness's details: save name, exit code, turns, cost) and the one requirement: the code `aas<32 hex>`, the same for every video of the revision, which its description (or title, where a site has none) must contain as a word of its own (a bundle before schema 14: the line `AAS <run-id> · fingerprint <16 hex> · <n> s` with that video's length). Then an example title and description, not a requirement, written for viewers in plain sentences: who plays what, the goal and how the run ended, which video this is (the cut, part k of n, or the whole recording), what the picture shows (LiveSplit, and the overlay when `recording.overlay` says it was there), what happens in that video as `m:ss what happens` (how a person restarted the run is left to the archive), the archive's domain and the run id as text, and the code last, after "Verification code for the AAS Archive:". The start is listed at 0:00 only when the moments make YouTube chapters (at least three, the first at 0:00, each at least ten seconds). The texts come from `packages/core/src/youtube-text.mjs`, which an archive can carry to make the same texts. The videos, their lengths, codes, chapters and example titles and descriptions are the bundle's `summary.recording.videos` (schema 9; for an older bundle the tooling lists them the same way from `timeline.json`). `--note` also goes into the descriptions in the bundle at the next `aas publish`. `aas publish` writes it and remembers the bundle directory in `publish-revision.json`; `aas render` writes it again for a published run. `--note` adds a sentence to the example description and is remembered for later sheets. |
| `aas scan <dir>` | Only the privacy scan. |

## Publishing a run, step by step

The recording is published where video is published, and its link is not in the bundle. Binding the two is the
publisher's job:

1. `aas publish <run-dir> <out-dir>` writes the bundle and the upload sheet, and prints the code
   `aas<32 hex>`, the same for every video of the bundle.
2. Upload the video from the private run directory, not from the public folder: `<run>/recording/UPLOAD.txt`
   lists the videos you may upload, the cut, the full recording (one video per segment), or both, each with the
   code its description needs; the title and description in it are an example. Put the code in the field a viewer can read on that platform: the description, or
   the title where a platform has none.
3. Submit the zip at [ai-assisted-speedruns.org/submit](https://ai-assisted-speedruns.org/submit/). Its [verify page](https://ai-assisted-speedruns.org/verify/) checks the
   same zip in the browser.

### A new revision

Every `aas publish` of the same run directory is a new revision of that run: the counter in
`<run-dir>/publish-revision.json` goes up by one, `run_uid` stays the same, and an archive files the zip as a
new revision of the run it already holds. There are two reasons to publish again: the run went on (`aas resume`),
or the tooling changed the bundle's shape (a new summary schema). Either way:

1. After a resume, `aas render <run-dir>` again: the cut and its length change with the new segment, and the
   upload sheet marks a cut rendered before this revision as out of date.
2. Move the previous bundle out of the way: `aas publish` refuses an `<out-dir>` that is not empty, and writes
   `<out-dir>.zip` over the old zip. Keep the old ones under another name if you want them.
3. `aas publish <run-dir> <out-dir>` with the options of the earlier revisions: the same `--sign` key if they were
   signed, and `--session <log>` if the run directory has moved since it was played (Claude Code keeps the session
   log under the path the run directory had then).
4. Compare the code in the new `recording/UPLOAD.txt` with the descriptions of the videos you already uploaded.
   The fingerprint is the hash of the bundle's published timeline: publishing an unchanged run again keeps it; a
   resume changes it, because the timeline has new records, and so can a tooling update that changes the sanitised
   log. When the code changed, every video you keep gets the new code in its description; a video whose length
   changed (the cut after a resume) is a new video, uploaded with the new code. A video of a bundle before schema 14
   carries the line instead; after republishing, its description gets the code.
5. Submit the new zip.

What that buys a reader: the video cannot be swapped for another one. A platform re-encodes what you upload,
so a hash of the file proves nothing about the video anyone can watch; the fingerprint in the description,
the duration, and a few tool calls spot-checked at their `elapsed_seconds` all have to match the same bundle.

`--sign [key]` signs the bundle with an ed25519 key — without a path, the key `aas key` made, or an SSH key
the publisher happens to have: the signature covers `manifest.json`, which carries a hash of every file, and lands in `signature.json` together
with the public key and its `SHA256:` fingerprint. The key is the publisher's own: `aas key` makes one, no account anywhere is needed, and the public half is a
single line to register with an archive. Signing is a marker, not a gate: an unsigned bundle passes `aas check`
and is a complete bundle, because who published a run is what an archive's accounts say — the publisher is
signed in there — while a key that gates nothing would be one more thing to install and register for no visible
effect. What it earns a publisher who wants it: their publications are tied to one key, inside an archive and
outside it. A signature an archive has not seen before is published as one whose publisher is not established,
and gains its match if that publisher records the line somewhere the archive reads: its own account page, a location
the publisher controls, a key directory, an account list a host happens to serve. The standard names none of
them. It is not an upload credential: the upload
is the zip through a submission form. Setting a key up:
[install.md](install.md#10-optional-signing-your-bundles).

Every publication of the same run raises `bundle.revision` in the run directory's counter, while `run_uid`
stays what it was: an archive keys the run on `run_uid` and the publication on `(run_uid, revision)`.

## Run directories, bundles and the upload

Three things, and they are kept apart:

| What | Where | For |
|---|---|---|
| **run directory** | `<recording drive>/<Game>/<run-id>/` | private: the complete log, the saves, the game's own records, the recording as OBS wrote it. It never leaves the machine. |
| **bundle** | `<recording drive>/<Game>/public/<run-id>/` | the sanitised, checkable copy `aas publish` writes. **"public" means made for upload to an archive**, and that is the only form a run is shared in. |
| **upload file** | `<recording drive>/<Game>/public/<run-id>.zip` | the bundle in one file: what you attach to the archive's submission form. It is small, because the recording is not in it. |

A bundle is written to be read by a program as much as by a person: identifiers are stable (`run_uid`, written once per run and surviving every rename; `run_id`, the name it was published under; `bundle.revision`, counting the publications of that run), versions are separate (`spec_version` for the standard, `schema_version` for the summary's shape, `bundle.bundle_version` for the packaging), times are ISO 8601, numbers are numbers, and anything that can be a list of objects is one (`attempts`, `models`, `game.mods`).

`manifest.json` in a bundle carries `"bundle": "aas-public"`, the `bundle_version`, the `spec_version`, the `run_id` and the `revision`; an archive checks that marker (and the absence of `run.jsonl`) before it accepts an upload as an AAS bundle. `summary.game` says what was played, down to the mods and their pins.

**Run id.** `<game>-<runtime>-NN`, sequential per game: `sts-claude-code-01`, `sts-codex-01`, `portal-claude-code-03`. The id is the name of the run directory, of the bundle and of the zip, and the archive uses it as the run's identity. What a run was about (seed, goal, model, category) lives in `brief.json` and `summary.json`, never in the name: not every game has a seed, and a name cannot be checked.

### Inside the run directory

Created by `aas run` (or `aas configure`), private; only `aas publish` makes the public bundle.

| Path | Written by | Content |
|---|---|---|
| `brief.json` | configure, resume | run id, category, model, effort, instructions, goal prompt, runtime and game plugin, the plugin's `runEnv` values (what the run plays), budgets, resume info |
| `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`, `.codex/config.toml` | runtime configure | the agent's instructions and hardened configuration (which files depends on the runtime) |
| `runtime-config/` | runtime configure | the same configuration with machine paths replaced (`__RUN_DIR__`, `__REPO__`, `__HOME__`), published |
| `run.jsonl` | broker, harness, plugins | the private, complete log: tool calls and results, agent messages, events (`game.playback`, `game.milestone`, `game.over`, `game.saved`, `run.started`, `run.ended`, `recording.*`, ...), all on one clock |
| `tools.json`, `documentation.md` | broker | the tool definitions the agent received and what `<game>_documentation` returned |
| `screenshots/` | broker | every image returned to the agent, referenced from the log |
| `saves/` | harness (autosave, every 10 minutes and at chapter milestones and the end) | the game's save states copied through the plugin's `saveState`; `aas resume` restores the last one |
| `recording/`, `recording.json` | recorder, harness | the recording file(s), one segment per run or resume, with t0, chapters and the timer's result; the cut `<name>.cut.mp4` (`aas render`) and `UPLOAD.txt` (`aas upload-sheet`) sit next to them |
| `outcome.json` | harness | status (`completed`, `stopped`, `failed`), notes, the runtime's session id, deaths |
| `claude-result.json`, `claude-results.jsonl`, `session.jsonl` | runtime | the runtime's own result (Claude Code: the last invocation's, and every invocation's in `claude-results.jsonl`, which `aas publish` reads for each model's context window, maximum output and provider) and, for runtimes that keep it here, the private session log (Claude Code keeps its log under `~/.claude/projects/<run dir>/`) |
| `timeline/` | timeline, render | see `aas timeline` |
| `history/`, `rooms/`, `conformance.jsonl`, `oracle/` | Slay the Spire plugin and bot | game-specific ground truth (never published) |

## Events on the timeline

Every writer (broker, harness, plugins) appends to `run.jsonl`; `kind: "event"` records carry the run's structure. The names the core and the plugins use:

| Event | Written by | Meaning and who reacts |
|---|---|---|
| `run.started`, `run.ended` | harness | the agent session's start and end; recorder and timer react |
| `budget.checked` | harness | the Claude plan usage at the start |
| `game.ready` | harness (from `prepareRun`) | the game is ready for the agent; seed when the game has one |
| `game.playback` (`phase: start` with the steps, `phase: end` with what was played) | game plugin, inside the broker | the only intervals in which game time advances (`paused-think`); the timer runs game time, the timeline sums IGT and builds the cut list |
| `game.milestone` (`chapter: true` for a split) | game plugin | a section boundary: recorder chapter, timer split |
| `game.over` (`victory: true|false`) | game plugin (the game's own end or a death), harness (the goal's end) | the attempt ended; a victory ends the session (`completed`), a death does not |
| `game.goal` (`from`, `to`) | harness (resume) | the goal was extended to a later end; the victory before it no longer ends the attempt |
| `game.attempt` (`phase: start`) | game plugin | the next attempt after a death (same seed); the timer resets |
| `game.saved` | harness | a save state was copied into `saves/` |
| `game.phase`, `game.highlight`, `game.turn` | game plugin (optional) | scene changes, replay-buffer highlights, turn markers |
| `run.human` | harness (resume) | a human intervened; the category becomes `restart-only`, except for the resume that started a goal extension not published yet (after `completed_at`, followed by `game.goal`) |
| `run.error` | harness | the run failed to start or the runtime failed |
| `proof.ticket`, `proof.missed`, `proof.off` | harness (run, resume) | the segment's ticket from the archive; a head the archive did not acknowledge (the run goes on); a segment recorded without proof |
| `recording.started`, `recording.stopped`, `recording.chapter` | recorder, harness | the recording's t0, files and chapters |

`aas timeline` derives everything from these; `aas publish` sanitises the log into the public timeline (`session.sanitized.jsonl`) and counts what it removed.
