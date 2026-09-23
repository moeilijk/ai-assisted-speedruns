# ai-assisted-speedruns

Tooling for AI Assisted Speedruns (AAS). A language model plays a game through three tools per game (`<game>_documentation`, `<game>_screenshot` and `<game>_exec`). The tooling records the run and packs it into a bundle, which you submit to the AAS Archive at [ai-assisted-speedruns.org](https://ai-assisted-speedruns.org).

The idea comes from cozyblaze's Portal run. The tool interface and the log format follow [portal-agent](https://github.com/cozyblaze/portal-agent), and the broker, process hardening, log sanitising and privacy scan are built on its code.

## Status

Pre-release. The 0.x versions are for testing the setup: installing, recording a run, publishing a bundle. Expect them to break with version 1.0.0, which comes out when the archive goes live on 1 October 2026. Changes per version are in [CHANGELOG.md](CHANGELOG.md).

## Contents

```
packages/
  core/                 the aas command: broker, process hardening, run log, run/resume, timeline, render, publish, check;
                        gui/ (aas gui), windows/ (Steam, displays, sound device, keep-awake for the launchers)
  spec/                 SPEC.md, the bundle format
  runtime-claude-code/  runs Claude Code against the broker, with its tools locked down
  runtime-codex/        the same for Codex
  runtime-scripted/     runs a bot module instead of a model, for baselines and tests
  recorder-obs/         records with OBS: its own scenes, game audio, no microphone
  recorder-source-demo/ in-game Source demo through SourcePauseTool
  recorder-null/        no recording, for development (a run without a recording is not valid)
  timer-livesplit/      timer and splits on screen through LiveSplit Server
games/
  slay-the-spire/       Slay the Spire through Communication Mod
  portal/               Portal through the controller from portal-agent
  balatro/              Balatro through balatrobot
  portal-2/             Portal 2 through SourceAutoRecord's TAS protocol
  bizhawk/              games on the BizHawk emulator through bizhawk-mcp-native, one profile per game
  half-life-2/ slay-the-spire-2/ celeste/ openrct2/ kerbal-space-program/ unity-bepinex/ unreal-ue4ss/
                        planned, not implemented; each README has the route, license and risks
docs/                   install, command reference, plugins, design
```

There are four kinds of plugin: game, runtime (starts the model), recorder and timer. The `aas` commands work the same with any combination.

## From run to upload

1. `aas run` starts the recorder, the timer and the model against a game you started with its launch script. Everything that happens goes into one log in the run directory, which stays on your machine.
2. `aas publish` makes a bundle from the run directory: the sanitised log, times, the model's instructions and tools, the configuration, and a hash per file. It stops if the privacy scan finds anything, and packs the bundle into a zip. The video is not included.
3. Upload the cut, the full recording or both. The files are in `<run-dir>/recording/`, with `UPLOAD.txt` next to them. That file lists each video with its length, its chapters and the verification text its description must contain. That text links the video to the bundle. The title and description in `UPLOAD.txt` are only suggestions.
4. Submit the zip: `aas publish --upload` sends it under the account you signed in with, or submit it at [ai-assisted-speedruns.org/submit](https://ai-assisted-speedruns.org/submit/). You can check the zip first at [ai-assisted-speedruns.org/verify](https://ai-assisted-speedruns.org/verify/).

After `aas resume`, or after a tooling update that changes the bundle, you publish again as a new revision. See [docs/reference.md](docs/reference.md#a-new-revision).

## Proof that the logs were not changed

A run's logs are on the machine of the person who publishes it, so that person could edit them afterwards and
sign the result with their own key. A signature from the publisher proves nothing against the publisher. What
does is a record kept by someone else while the run goes on, so the run can be recorded with proof from the
archive:

- Before a segment is recorded, the tooling asks the archive for a ticket. At the start of the segment, every hour
  during it and at its end, it sends the archive one hash of the logs as they stand. The archive signs each hash
  with its own clock and keeps it. Only the ticket and the hash go over the line: nothing about you, your machine or
  what happens in the run.
- The upload carries the logs themselves in a private part. The archive recomputes every hash from them and makes
  the public timeline again from them. A log or a timeline edited after its hash was signed no longer matches, and
  the upload is refused.
- The archive uses the private part for that check only. It never publishes it, never offers it for download and
  deletes it as soon as the submission is decided, or after 30 days when a reviewer has not decided by then. Keep
  your run directory as long as you want your run to be defensible: in a dispute the archive asks for the private
  part again, and it must match the hashes it signed.

Proof is recorded when you are signed in (`aas login`, which opens the archive in your browser, like `claude`
does) or when you set `AAS_PROOF=anonymous`. An anonymous ticket is not tied to anyone and expires 60 days after its
last hash when the run is not submitted, an account's after 90. `aas tickets` lists the tickets of your runs and
extends, revokes or deletes them. Without either, a run is unsigned: the archive accepts it and marks it so.

## Disclaimer: anti-cheat, bans, your own risk

> [!WARNING]
> This tooling injects code into games. For Portal that is SourcePauseTool's DLL and an IPC patch, for Balatro Lovely's DLL (`version.dll` in the game folder) with Steamodded and balatrobot, and the games start outside the normal launcher. Anti-cheat such as VAC, EAC or BattlEye can see this as cheating and **ban the account, possibly permanently**.
>
> - **Only use games without anti-cheat and without online play.** Never use it with online or competitive games.
> - **Preferably use a separate offline copy of the game.** Portal here runs from Source Unpack, not from the Steam install.
> - **Check the game's terms and anti-cheat yourself** before you connect anything.
>
> **Everything you do with this repository is at your own risk.** The authors are not responsible for bans, lost accounts or other damage.

## Install

Full instructions, with a check per step: [docs/install.md](docs/install.md).

**Without a command line:** after the clone (see below), double-click `AAS.cmd` in the repository folder, or run
`npm run gui`. The page that opens finds the tools and games in their standard places (and the Steam, Epic and GOG
libraries), checks their versions, installs what the games and LiveSplit need, and starts and stops runs. Runs are
saved to `<output location>\<game>\<run>`. It shows every command it runs, so you can do the same from a shell.

In short, from a shell:

```bash
git clone https://github.com/moeilijk/ai-assisted-speedruns.git && cd ai-assisted-speedruns
node -v && npm test          # Node 22+; tests run against fakes, no game needed
cp .env.example .env         # machine settings: OBS password, game folders, budgets
npm run claude:smoke         # Claude Code and its permissions, against a fake game
```

Then set up the game ([Slay the Spire](games/slay-the-spire/README.md), [Portal](games/portal/README.md), [Balatro](games/balatro/README.md)) and OBS.

**Test the machine first with a mock run.** A mock run is the game played by its own scripted player: no model, no
tokens. It tests everything an AI run needs — the agents that are installed reaching the game's tools, the game with
its mods and bridge, OBS, LiveSplit, in-game time and milestones, the timeline and the bundle — except the model's own
playing. Start it in the GUI (Run type: mock run) or from a shell; when it goes through, an AI run of the same game
and goal starts on the same tools. Its bundle is a complete bundle and never an entry: an archive reads which runtime
drove the run and what the timeline holds, and publishes nothing a script
played (SPEC §3). Then do a first AI run:

```bash
aas doctor --game games/slay-the-spire/plugin.mjs --recorder obs --timer livesplit --runtime claude-code
aas run --runtime claude-code --game games/slay-the-spire/plugin.mjs --run-dir <runs>/sts-claude-code-01 \
        --recorder obs --timer livesplit --overlay-port 8765 --goal act1 --headless --max-minutes 60
aas render  <runs>/sts-claude-code-01
aas publish <runs>/sts-claude-code-01 <runs>/public/sts-claude-code-01
cat <runs>/sts-claude-code-01/recording/UPLOAD.txt
```

## Documentation

| Document | Contents |
|---|---|
| [docs/install.md](docs/install.md) | installation and troubleshooting |
| [docs/reference.md](docs/reference.md) | all commands, the run directory and the bundle |
| [docs/plugins.md](docs/plugins.md) | writing a game, runtime, recorder or timer plugin |
| [docs/design.md](docs/design.md) | architecture and design decisions |
| [packages/spec/SPEC.md](packages/spec/SPEC.md) | the bundle format |
| [CHANGELOG.md](CHANGELOG.md) | changes per version, and which versions break older runs or bundles |

## Rules for every game

- A game only gets what its plugin needs: the original tooling the plugin is built on, installed as published, and the settings the recording needs. No cheats, and no mods or settings beyond that. Each game's README lists what is added or changed.
- The model has no web access and no shell, and can only write inside the run directory.
- A run without a recording is not valid.

## License

MIT, see [LICENSE](LICENSE). Code from others keeps its own license:

- [portal-agent](https://github.com/cozyblaze/portal-agent) by cozyblaze (MIT): see [packages/core/NOTICE](packages/core/NOTICE) and [packages/core/vendor/portal-agent/LICENSE](packages/core/vendor/portal-agent/LICENSE). A bundle that contains portal-agent material (Portal game configuration, instructions and documentation, or the Codex configuration template) includes that license.
- [sts_lightspeed](https://github.com/gamerpuppy/sts_lightspeed) by gamerpuppy (MIT): see [games/slay-the-spire/NOTICE](games/slay-the-spire/NOTICE) and [games/slay-the-spire/lightspeed/LICENSE](games/slay-the-spire/lightspeed/LICENSE).

The games, and the mods and tools the setup downloads or builds, are not in this repository. You bring the game; every mod and tool is pinned in the `UPSTREAM.json` next to the plugin that uses it, and each has its own license:

| Game | Game, or what the setup downloads or builds | License |
|---|---|---|
| Slay the Spire | [Slay the Spire](https://store.steampowered.com/app/646570/) (your own copy) | the game's own |
| Slay the Spire | [Communication Mod](https://github.com/ForgottenArbiter/CommunicationMod) | MIT |
| Slay the Spire | [ModTheSpire](https://steamcommunity.com/sharedfiles/filedetails/?id=1605060445) ([source](https://github.com/kiooeht/ModTheSpire)) | MIT |
| Slay the Spire | [BaseMod](https://steamcommunity.com/sharedfiles/filedetails/?id=1605833019) ([source](https://github.com/daviscook477/BaseMod)) | MIT |
| Slay the Spire | [sts_lightspeed](https://github.com/gamerpuppy/sts_lightspeed) (built for the scripted bot) | MIT |
| Portal | [Portal](https://store.steampowered.com/app/400/) (your own copy), run from [Source Unpack](https://sourceunpack.gameabusefastcomplete.com/) | the game's own |
| Portal | [SourcePauseTool](https://github.com/OutOfBoundsOffice/SourcePauseTool) | MIT |
| Portal 2 | [Portal 2](https://store.steampowered.com/app/620/) (your own copy) | the game's own |
| Portal 2 | [SourceAutoRecord](https://github.com/p2sr/SourceAutoRecord) | MIT |
| Balatro | [Balatro](https://store.steampowered.com/app/2379780/) (your own copy) | the game's own |
| Balatro | [Lovely](https://github.com/ethangreen-dev/lovely-injector) | MIT |
| Balatro | [Steamodded](https://github.com/Steamodded/smods) | GPL-3.0 |
| Balatro | [balatrobot](https://github.com/coder/balatrobot) | MIT |
| Balatro | [jackdaw-balatro](https://github.com/TylerFlar/jackdaw-balatro) (the scripted bot's policy is ported from it) | MIT |
| BizHawk | [BizHawk](https://github.com/TASEmulators/BizHawk) 2.11.1 | MIT (the EmuHawk frontend); each core its own, most GPL |
| BizHawk | [bizhawk-mcp-native](https://github.com/StealthC/bizhawk-mcp-native) by StealthC, through our fork [moeilijk/bizhawk-mcp-native](https://github.com/moeilijk/bizhawk-mcp-native) v0.3.2 | MIT |
| BizHawk | [nes15](https://github.com/christopherpow/nes-test-roms/tree/master/nes15-1.0.0) by Mathew Brenaman, the test profile's ROM, which the install downloads into `.local/roms` | BSD-2-Clause |
| BizHawk | Super Mario Bros. (your own ROM; the `smb` profile checks it by its SHA-1) | the game's own |
| BizHawk | [smb-autosplitter](https://github.com/periwinkle9/smb-autosplitter) by periwinkle9 (the `smb` profile's memory addresses) | Zlib |
| BizHawk | [TASVideos movie 3728M](https://tasvideos.org/3728M), "warpless" by HappyLee & Mars608, which `bizhawk:tas` downloads for the `smb` mock | CC BY 2.0 |
| every game | [LiveSplit](https://github.com/LiveSplit/LiveSplit) (the timer, installed from the GUI) | MIT |
| every game | [SoundVolumeView](https://www.nirsoft.net/utils/sound_volume_view.html) by NirSoft (optional quiet audio routing) | freeware |
