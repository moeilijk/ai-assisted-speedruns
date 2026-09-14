# ai-assisted-speedruns

The tooling for **AI Assisted Speedruns**: an LLM agent plays a game through a small, hardened tool interface, and the tooling records the run and packs it into a bundle. What happens to a bundle after that — keeping it, showing it, checking it — is the archive's: the **AAS Archive** at [ai-assisted-speedruns.org](https://ai-assisted-speedruns.org).

The agent only ever sees three tools per game: `<game>_documentation`, `<game>_screenshot`, `<game>_exec`. Inspired by cozyblaze's Portal run: that tool interface and the log format follow his design, and the broker, the process hardening, the log sanitising and the privacy scan build on his code from [portal-agent](https://github.com/cozyblaze/portal-agent).

## What is in this repository

```
packages/
  core/                 the `aas` command: the broker the agent's tools run in, the process hardening, the run log,
                        run/resume, timeline, render, publish, check
  spec/                 SPEC.md, the standard a bundle follows
  runtime-claude-code/  starts Claude Code against the broker, with its tools locked down
  runtime-codex/        the same for Codex
  runtime-scripted/     a bot module instead of an agent, for baselines and tests
  recorder-obs/         records the run with OBS: its own scenes, the game's audio, no microphone
  recorder-source-demo/ an in-game Source demo through SourcePauseTool
  recorder-null/        no recording; for development only, never a valid run
  timer-livesplit/      the speedrun timer and splits on screen, through LiveSplit Server
games/
  slay-the-spire/       Slay the Spire through Communication Mod
  portal/               Portal through cozyblaze's controller from portal-agent
  balatro/ half-life-2/ slay-the-spire-2/ portal-2/ celeste/ openrct2/ kerbal-space-program/ bizhawk/ unity-bepinex/ unreal-ue4ss/
                        stubs: planned game plugins, each README with its route, license and risks; not implemented
docs/                   install, command reference, writing plugins, design
```

A **game** plugin connects one game, a **runtime** starts the agent, a **recorder** records and a **timer** times. Every `aas` command works the same whichever are loaded.

## A run, from start to upload

1. **Record.** With the game started by its own launch script, `aas run` starts the recorder, the timer and the agent, and writes everything that happens to one log in the run directory: every tool call, every message, every event of the game. The run directory stays on your machine.
2. **Bundle.** `aas publish` turns that run directory into a bundle: the sanitised log, the times, the agent's instructions and tools, the configuration, and a hash of every file. It refuses anything the privacy scan flags, and packs the bundle into one zip. The recording is not in it.
3. **Upload the video, with its fingerprint.** `aas publish` prints one line: `AAS <run-id> · fingerprint <16 hex> · <n> s`. Upload your recording where you publish video and put that line in its description (or its title, where a platform has no description). That line is what ties the video to this bundle.
4. **Submit the bundle.** Upload the zip at [ai-assisted-speedruns.org/submit](https://ai-assisted-speedruns.org/submit/). Everything after that happens on the site; [ai-assisted-speedruns.org/verify](https://ai-assisted-speedruns.org/verify/) checks a zip in your browser before you send it.

## Disclaimer: anti-cheat, bans, your own risk

This framework drives a game with injected tooling (for Portal: SourcePauseTool's DLL and an IPC patch, with the game started outside the normal launcher). Anti-cheat and monitoring systems such as VAC, EAC or BattlEye can treat that as cheating and **ban the account, possibly permanently**. Use it only with games and builds that have no anti-cheat and no online component, never with online or competitive games, and preferably with a separate offline copy of the game (Portal here runs from Source Unpack, not from the Steam install). Do your own research on the game's terms and anti-cheat before you connect anything, use common sense, and accept that everything you do with this repository is at your own risk: the authors take no responsibility for bans, lost accounts or other damage.

## Install

Prerequisites, step by step, and how to verify each layer: **[docs/install.md](docs/install.md)**. The short version:

```bash
git clone https://github.com/moeilijk/ai-assisted-speedruns.git && cd ai-assisted-speedruns
node -v && npm test          # Node 22+; the whole suite runs against fakes, no game needed
cp .env.example .env         # machine settings (OBS password, game folders, budgets)
npm run claude:smoke         # the agent runtime and its permissions, against a fake game
```

Then the game's own side ([Slay the Spire](games/slay-the-spire/README.md), [Portal](games/portal/README.md)), OBS, and a first run:

```bash
aas doctor --game games/slay-the-spire/plugin.mjs --recorder obs --timer livesplit --runtime claude-code
aas run --runtime claude-code --game games/slay-the-spire/plugin.mjs --run-dir <runs>/sts-claude-code-01 \
        --recorder obs --timer livesplit --overlay-port 8765 --goal act1 --headless --max-minutes 60
aas publish <runs>/sts-claude-code-01 <runs>/public/sts-claude-code-01
```

## Documentation

| Document | What is in it |
|---|---|
| [docs/install.md](docs/install.md) | prerequisites and the installation, step by step; troubleshooting |
| [docs/reference.md](docs/reference.md) | every command, what it does and what it leaves behind; the run directory and the bundle |
| [docs/plugins.md](docs/plugins.md) | how to write a game, runtime, recorder or timer plugin |
| [docs/design.md](docs/design.md) | the architecture and the decisions behind it |
| [packages/spec/SPEC.md](packages/spec/SPEC.md) | the standard: what a bundle contains |

## Rules that apply to every game in this repository

- A game gets only what its plugin needs for the run: the original tooling the plugin is built on, installed as its authors publish it, and the settings the recording needs. No cheats, mods or settings beyond that original tooling. Each game's README lists what is added to the game and what is changed.
- The agent gets no web access, no shell, and can write only inside the run directory.
- A run without a recording is not a valid run.

## License

MIT, see [LICENSE](LICENSE). Code by others keeps its own license and attribution:

- cozyblaze's code from [portal-agent](https://github.com/cozyblaze/portal-agent) (MIT): listed in [packages/core/NOTICE](packages/core/NOTICE), license text in [packages/core/vendor/portal-agent/LICENSE](packages/core/vendor/portal-agent/LICENSE). A published bundle that carries his material (the Portal game configuration, instructions and documentation, or the Codex configuration template) carries his license text next to it.
- gamerpuppy's [sts_lightspeed](https://github.com/gamerpuppy/sts_lightspeed) (MIT): the patches, the planner and the data derived from it are listed in [games/slay-the-spire/NOTICE](games/slay-the-spire/NOTICE), license text in [games/slay-the-spire/lightspeed/LICENSE](games/slay-the-spire/lightspeed/LICENSE).

Games, mods and tools that the setup downloads or builds (Communication Mod, BaseMod, ModTheSpire, SourcePauseTool, sts_lightspeed itself) are not in this repository; each is pinned in the game's `UPSTREAM.json` and comes under its own license.
