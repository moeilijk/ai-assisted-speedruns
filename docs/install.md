# Installing aas

From an empty machine to a run you can publish. The steps are ordered: every one ends with a command that
says whether that layer works, so a failure is always in the layer you just installed. Nothing here is
game-specific; the game's own side is one step with a link to the game's README.

Three levels, and you only install what your level needs:

| Level | You want to | Install |
|---|---|---|
| **A. Read and develop** | run the test suite, write or change a plugin | Node only (§1, §2) |
| **B. Do a run** | drive a real game with a real agent, recorded | A + an agent CLI, OBS, the game (§3 – §8) |
| **C. Publish a run** | put a bundle in the [AAS Archive](https://ai-assisted-speedruns.org) | B + ffmpeg, a video platform account and an account at the archive (§9 – §11); signing is optional |

## 1. Prerequisites

| What | Version | Needed for | Where to get it | Check |
|---|---|---|---|---|
| Node.js | 22 or newer (24 recommended) | everything; the broker runs under `node --permission` | [nodejs.org/en/download](https://nodejs.org/en/download) | `node -v` |
| git | any | cloning this repository and the pinned upstreams | your package manager | `git --version` |
| WSL 2 | current | **on Windows**: the harness itself runs in a Linux shell (see §1a) | [learn.microsoft.com — `wsl --install`](https://learn.microsoft.com/en-us/windows/wsl/install) | `wsl -l -v` |
| An agent CLI | Claude Code 2.1.207+ **or** Codex, logged in | a run with an agent | [Claude Code setup](https://code.claude.com/docs/en/setup) · [Codex CLI](https://github.com/openai/codex) | `claude --version`, `codex --version` |
| ffmpeg (with ffprobe) | 6+ | `aas render`, and at `aas publish` the recording's length and its black intervals | [ffmpeg.org/download](https://ffmpeg.org/download.html) | `ffmpeg -version` |
| OBS Studio | 30+ (tested on 32.2.2), obs-websocket v5 enabled | the recording; **a run without a recording is not a valid run** | [obsproject.com/download](https://obsproject.com/download) | OBS → Tools → WebSocket Server Settings |
| LiveSplit | 1.8.37 with the Server component | optional: the timer on screen and the splits | [livesplit.org/downloads](https://livesplit.org/downloads/) | its `settings.cfg` has `ServerStartup=1` |
| The game | no anti-cheat, no online component | a run | the store you bought it from | see the game's README |
| Disk | the run directory on the drive OBS records to | OBS then records straight into `<run>/recording/` | — | — |

No `npm install` is needed: the core has no dependencies. The workspaces exist for versioning, not for packages.

**Anti-cheat.** Read the disclaimer in the [README](../README.md) before you connect anything to a game.

## 1a. Where each part runs (Windows, WSL, Linux)

The harness is a Node program and runs wherever Node runs; the game, OBS and LiveSplit run where that game
runs. Three layouts work, and the middle one is what this repository is developed and tested on:

| Layout | Harness | Game, OBS, LiveSplit | Notes |
|---|---|---|---|
| **Windows + WSL** (tested) | in WSL 2 | on Windows | the harness reaches the game over `127.0.0.1` (WSL forwards it) and calls Windows executables from WSL; paths OBS reports are translated with `wslpath` |
| **Windows only** | in PowerShell or CMD | on Windows | no path translation at all; the game plugins' scripts assume Windows executables, which are then simply local |
| **Linux only** | on Linux | on Linux | works when the game itself runs on Linux; the Windows-only helpers (window placement, audio routing) stay off |

**WSL is a prerequisite on Windows only if you want the tested layout.** In it:

- Install it once from an administrator PowerShell: `wsl --install`, then reboot. Everything below runs inside
  the WSL shell, not in PowerShell: the clone, `npm test`, `aas`, and the agent CLI.
- `wslpath` must be on the PATH (it is, in a standard WSL): the recorder translates the Windows path OBS
  reports into a path the harness can copy from.
- Put the run directories on the drive OBS records to — a Windows drive, reached as `/mnt/<letter>/…`. OBS then
  records straight into `<run>/recording/` and nothing has to be moved across the boundary afterwards.
- The game roots and the `AAS_*_EXE` settings in `.env` are WSL paths to Windows programs
  (under `/mnt/<letter>/`); the launch and install scripts call those executables from WSL.
- Install the agent CLI **inside WSL** (Claude Code's Linux installer, or npm), not the Windows build: the
  harness starts it as a child process from the same shell.

## 2. The harness

```bash
git clone https://github.com/moeilijk/ai-assisted-speedruns.git
cd ai-assisted-speedruns
node -v            # v22 or newer
npm test           # the whole suite against fakes: no game, no OBS, no agent needed
```

`npm test` passing means the broker, the hardening, the run log, the timeline, the publish/check chain and
every plugin's own tests work on this machine. If it fails here, nothing below will work.

Every command below is written as `aas <command>`; that is the package's bin,
`node packages/core/src/cli.mjs <command> …`. Make it an alias or put it on your PATH, or type the long form.

## 3. Machine settings (`.env`)

```bash
cp .env.example .env
```

Fill in what applies to your machine; everything optional is off when unset. The CLI and every `npm run`
script load `.env` themselves, so the same command works from any shell; a variable already set in your
shell wins. The complete list of variables is in [reference.md](reference.md#settings). The minimum for a
recorded run:

| Variable | Where to get it |
|---|---|
| `AAS_OBS_PASSWORD` | OBS → Tools → WebSocket Server Settings → Show Connect Info |
| `AAS_<GAME>_GAME_ROOT` | the game's install or unpack folder, as the harness sees it (a WSL path under WSL) |
| `AAS_BUDGET_WEEKLY_MAX`, `AAS_CODEX_BUDGET_MAX` | the share of your plan runs may spend (default 50 percent) |

`.env` stays on your machine: it is in `.gitignore`, it is never published, and the broker only ever receives
the variables the game plugin declares in its `env` list.

## 4. The agent runtime

You need one of the two, and it must be **logged in and started once as yourself** before a run can use it.
Both runtimes refuse to start a run directory their CLI does not trust, because an agent whose permission
rules are ignored is not a valid run.

### Claude Code

1. Install Claude Code ([setup and installers](https://code.claude.com/docs/en/setup): `curl -fsSL
   https://claude.ai/install.sh | bash` on macOS, Linux and WSL, `irm https://claude.ai/install.ps1 | iex` in
   PowerShell, or `npm install -g @anthropic-ai/claude-code`) and start it once interactively, anywhere: that
   creates `~/.claude.json`.
2. Nothing else to configure. `aas run` marks each new run directory as trusted in that file
   (`projects["<run dir>"].hasTrustDialogAccepted`), because Claude Code applies a directory's
   `permissions.allow` rules only in a directory it trusts.
3. Verify:

```bash
npm run claude:smoke     # a real headless session against a fake game
```

It costs a little of your plan (one short session). PASS means: the trust flag works, the agent got exactly
the three broker tools, and shell and file access were refused. A run in which Claude Code reports
`Ignoring N permissions.allow entries …` is stopped and ends `failed`. Details: [packages/runtime-claude-code/README.md](../packages/runtime-claude-code/README.md).

### Codex

1. Install Codex ([openai/codex](https://github.com/openai/codex): `npm install -g @openai/codex`, or
   `brew install --cask codex`) and log in (`codex login`).
2. `aas configure`/`aas run` write the project trust entry (`[projects."<run dir>"] trust_level = "trusted"`
   in `~/.codex/config.toml`) themselves; without it Codex loads no MCP server at all.
3. Verify: `aas doctor --runtime codex` (and `--run-dir <an existing run>` to see the trust row).

Details: [packages/runtime-codex/README.md](../packages/runtime-codex/README.md).

### The plan budget

```bash
aas budget
```

Every runtime that runs on a plan reports its own stand; a run refuses to start above the limit
(`AAS_BUDGET_WEEKLY_MAX`, `AAS_CODEX_BUDGET_MAX`), and a running session is interrupted with a save when it
crosses it. `--ignore-budget` skips the guard.

## 5. The game

Each game has its own install: the mod or the in-game tooling, the bridge, and its settings in `.env`.

- **Slay the Spire** — [games/slay-the-spire/README.md](../games/slay-the-spire/README.md): Steam + ModTheSpire
  + BaseMod, then `npm run sts:install` (Communication Mod, the bridge, the mod config) and `npm run sts:launch`.
- **Portal** — [games/portal/README.md](../games/portal/README.md): Source Unpack, SourcePauseTool built with
  portal-agent's scripts, then `npm run portal:install -- --game-root <dir>` and `npm run portal:launch`.
- **Another game** — write a plugin: [plugins.md](plugins.md). Nothing in the core has to change, and a game
  plugin may live outside this repository.

## 6. OBS

1. Install OBS, open Tools → WebSocket Server Settings, enable the server, copy the password into `.env`.
2. Set OBS's recording folder to the drive your run directories live on.
3. Nothing else: the recorder builds its own scene collection `AAS-<game>` through the API, with the game
   window and the game's audio, and removes the microphone OBS adds by default. **A microphone anywhere in
   the scene aborts the run.**

The recorder checks the picture instead of assuming it: right after the recording starts it asks OBS for its
own rendering of the game source every two seconds, and a capture that stays black is rebound once and then
aborts the run. See [packages/recorder-obs/README.md](../packages/recorder-obs/README.md).

## 7. LiveSplit (optional)

Install LiveSplit, put `ServerStartup=1` in its `settings.cfg` (next to the executable) so its TCP server
starts with it, and open the game's splits file (`games/<game>/splits/*.lss`). Without LiveSplit, leave
`--timer livesplit` off: `aas publish` still writes `splits.lss` from the timeline.

## 8. Check the whole chain before your first run

With the game running and OBS open:

```bash
aas doctor --game games/<game>/plugin.mjs --recorder obs --timer livesplit --runtime claude-code
aas check-connection --game games/<game>/plugin.mjs --run-dir <runs>/check --exercise
```

`doctor` is read-only: Node's version, the game plugin and its documentation, its endpoints reachable, the
recorder and timer reachable and authenticated, the runtime's CLI and trust, and the plan's stand. Every row
is `PASS`/`FAIL` and comes from the plugin itself, so the list grows with what you loaded.

`check-connection` starts the real broker against the real game, does the MCP handshake, calls the three
tools the agent will have, and with `--exercise` runs the plugin's own exercises (a state read, a screenshot,
a small action). This is the last step that does not record anything.

Then the first run. Keep it short and bounded:

```bash
aas run --runtime claude-code --game games/<game>/plugin.mjs --run-dir <runs>/<game>-claude-code-01 \
        --recorder obs --timer livesplit --overlay-port 8765 \
        --goal <an early end> --headless --max-turns 40 --max-minutes 60
```

`aas run` configures the directory, checks the budget, starts the recorder (t0), prepares the game, starts
the timer and the agent, and when it is over saves, stops the timer and the recorder, copies the recording
into the run directory, writes `outcome.json` and closes the game, the timer, OBS and a Steam it started
itself. `--keep-open` leaves them open. A stopped run continues with `aas resume --run-dir <dir>`.

## 9. After the run: timeline, video, bundle

```bash
aas timeline <run-dir>                      # RTA, IGT, sections, attempts, cut list, subtitles
aas render <run-dir> --burn timers,inputs   # ffmpeg: the video without the thinking pauses
aas publish <run-dir> <public-dir>          # the bundle + the upload zip; prints the description line
```

The recording is not part of the bundle, and neither is its link: gigabyte files are not what anyone shares.
Publish the video where video is published, and bind the two:

1. `aas publish` prints one line, `AAS <run-id> · fingerprint <16 hex> · <n> s`. The fingerprint is the
   sha256 of this bundle's own published timeline (`session.sanitized.jsonl`).
2. Upload the recording and put that line in the field the platform lets a viewer read: the description, or
   the title where there is none.
3. Submit the zip at [ai-assisted-speedruns.org/submit](https://ai-assisted-speedruns.org/submit/). The bundle carries no links.

Anyone can then check that the video belongs to this bundle: the fingerprint in the description, the
duration, and a few tool calls spot-checked at their `elapsed_seconds`.

```bash
aas check --strict <public-dir>.zip # the conformance check of the upload zip (the directory works too)
aas scan <public-dir>               # only the privacy scan
```

`aas publish` runs both itself and **removes the bundle again when the scan finds anything**. What it checks
and what the bundle contains: [reference.md](reference.md#after-the-run) and the standard,
[packages/spec/SPEC.md](../packages/spec/SPEC.md). The upload file is `<public-dir>.zip`, written next to the
bundle: that is what the archive's [submission form](https://ai-assisted-speedruns.org/submit/) takes, and what its
[verify page](https://ai-assisted-speedruns.org/verify/) checks in the browser.

## 10. Optional: signing your bundles

**You do not need a key to publish.** An archive knows who you are because you are signed in there; the bundle
carries no identity of its own and does not have to. `aas check` passes on an unsigned bundle, and nothing in
the tooling asks for one.

Signing is a marker for a publisher who wants one. It ties your publications to a single key — in an archive
and outside it, in a zip someone downloaded a year ago — which is worth having if a claim is ever disputed and
worth little before that:

```bash
aas key                                             # writes ~/.config/aas/signing.pem and prints its public line
aas publish <run-dir> <public-dir> --sign           # signs with it
```

`aas key` makes an ed25519 key if you have none, never overwrites one, and prints the public half as a single
line plus its `SHA256:` fingerprint. It is safe to call unconditionally, so a script can run
`aas key && aas publish <run-dir> <public-dir> --sign` with no check of its own. The private half never leaves
the machine: signing writes a signature over `manifest.json`, and because the manifest holds a hash of every
other file, that one signature covers the whole bundle.

For the marker to say anything about *you* rather than about a key, whoever reads it has to know the key is
yours. **The archive you publish to is where that lives**: paste the public line on your account page there
([ai-assisted-speedruns.org/account](https://ai-assisted-speedruns.org/account/), Record key). The archive records the key by its fingerprint
and lists every key you recorded — several over the years, a new machine, a replacement — and a key you retire
stays on record, so the signatures made with it still resolve. A bundle signed with a key no account has recorded
is still published; its run page says so, and it gains the match whenever you record the line.

Nothing stops you from recording it elsewhere as well, and `aas key --claim` writes what you would publish:

```bash
aas key --claim --identity https://github.com/<you> --identity mailto:<you>@example.org
```

That prints a few lines of plain text — the key, its fingerprint, the identities you claim, the date — signed
with the key itself. Put it anywhere you are already known: a profile, a page on your own domain, a post, or
wrapped in another signature (`gpg --clearsign` leaves the text readable, so a keyserver works too). `aas key
--verify <file|->` reads one back out of whatever it was published in and says whether it holds. What the
claim proves on its own is that the holder of the key says it belongs to those identities; that they agree
comes from the place it was published, somewhere only their owner can write. Two keys and one archive is the
normal case, and this is for the publisher who wants their key to mean something beyond a single site.

`--sign <path>` takes any ed25519 key — an OpenSSH key without a passphrase (the signer cannot unlock one) or
PKCS#8 — and `AAS_SIGN_KEY` sets a default path for a machine. Without a path, `--sign` uses the `aas key` key,
then an SSH key if one happens to be there. **Keep the same key:** a new one makes you a new publisher as far
as any verifier can tell, which is why `aas key` refuses to overwrite. And if you sign, sign correctly: a
signature that does not verify fails `aas check`, because a broken one is worse than none.

## 11. Setting up for someone else

Everything a second person needs is in this file plus the game's README, and three commands prove their
machine is right without a run: `npm test` (the harness), `npm run claude:smoke` or `aas doctor --runtime
codex` (the agent and its trust), and `aas doctor --game … --recorder obs` (the game, OBS and the timer).
No file has to be edited by hand beyond `.env`.

## Troubleshooting

| What you see | What it is |
|---|---|
| `Ignoring N permissions.allow entries from .claude/settings.json` | the run directory is not trusted; start Claude Code once interactively so its config file exists, then `npm run claude:smoke`. The run is stopped on purpose. |
| Codex starts but has no game tools, and asks to run shell commands | no project trust entry; `aas configure` writes it — check `~/.codex/config.toml` for `[projects."<run dir>"]`. A wildcard entry does not count. |
| `doctor`: `game endpoint 127.0.0.1:<port> ECONNREFUSED` | the game is not running, or its mod/IPC is not enabled. Launch it with the game's own launch script. |
| `doctor`: OBS reachable but not authenticated | `AAS_OBS_PASSWORD` does not match OBS's WebSocket settings. |
| The run aborts with a black capture | OBS's game capture bound to a window that is gone. The recorder rebinds once and then stops the run: start the game before the run, and do not restart it during one. |
| `aas run` refuses: the run directory already exists | `configure` never overwrites. Use a new id, or continue with `aas resume --run-dir <dir>`. |
| `aas budget` says STOP | your plan is at or above the configured share. Wait for the window to reset, raise `AAS_BUDGET_WEEKLY_MAX` / `AAS_CODEX_BUDGET_MAX`, or use `--ignore-budget` deliberately. |
| `aas render`: `ffmpeg failed` / no duration in the bundle | ffmpeg or ffprobe is not on the PATH. |
| `aas publish` deleted the output directory | the privacy scan found something (a home path, a mount path, an e-mail address, a credential). The findings are printed; fix the source, then publish again. |
| `--sign`: the key cannot be read, or "is not ed25519" | the key has a passphrase (the signer cannot unlock one) or is RSA. Make a passphrase-free ed25519 key as in §10. |
