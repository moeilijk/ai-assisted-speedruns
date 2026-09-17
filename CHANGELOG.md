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

