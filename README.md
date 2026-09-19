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
  half-life-2/ slay-the-spire-2/ celeste/ openrct2/ kerbal-space-program/ bizhawk/ unity-bepinex/ unreal-ue4ss/
                        planned, not implemented; each README has the route, license and risks
docs/                   install, command reference, plugins, design
```

There are four kinds of plugin: game, runtime (starts the model), recorder and timer. The `aas` commands work the same with any combination.

## From run to upload

1. `aas run` starts the recorder, the timer and the model against a game you started with its launch script. Everything that happens goes into one log in the run directory, which stays on your machine.
2. `aas publish` makes a bundle from the run directory: the sanitised log, times, the model's instructions and tools, the configuration, and a hash per file. It stops if the privacy scan finds anything, and packs the bundle into a zip. The video is not included.
3. Upload the cut, the full recording or both. The files are in `<run-dir>/recording/`, with `UPLOAD.txt` next to them. That file lists each video with its length, its chapters and the verification text its description must contain. That text links the video to the bundle. The title and description in `UPLOAD.txt` are only suggestions.
4. Submit the zip at [ai-assisted-speedruns.org/submit](https://ai-assisted-speedruns.org/submit/). You can check the zip first at [ai-assisted-speedruns.org/verify](https://ai-assisted-speedruns.org/verify/).

After `aas resume`, or after a tooling update that changes the bundle, you publish again as a new revision. See [docs/reference.md](docs/reference.md#a-new-revision).

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
drove the run, what the timeline holds and what was witnessed before the run began, and publishes nothing a script
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

Games, mods and tools that the setup downloads or builds are not in this repository. Each is pinned in the game's `UPSTREAM.json` and has its own license:

| Game | Downloaded or built | License |
|---|---|---|
| Slay the Spire | Communication Mod, BaseMod, ModTheSpire | MIT |
| Slay the Spire | sts_lightspeed (built for the scripted bot) | MIT |
| Portal | SourcePauseTool | MIT |
| Balatro | [Lovely](https://github.com/ethangreen-dev/lovely-injector) | MIT |
| Balatro | [Steamodded](https://github.com/Steamodded/smods) | GPL-3.0 |
| Balatro | [balatrobot](https://github.com/coder/balatrobot) | MIT |
