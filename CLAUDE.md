# CLAUDE.md

Guidance for Claude Code, or any AI assistant, working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) applies in full; this file adds how the work is done here.

## Read first

- [README.md](README.md): what the tooling does, the rules for every game, and the licenses.
- [docs/design.md](docs/design.md): the architecture and the decisions already made. Look there before you change how something works, so a decision is not made again without its reason.
- [docs/plugins.md](docs/plugins.md): the plugin contracts, and the checklist for a game plugin.
- [packages/spec/SPEC.md](packages/spec/SPEC.md): what a bundle must contain. The site reads bundles against it.
- The top of [CHANGELOG.md](CHANGELOG.md): the version rule.

## Where things run

The harness is developed and tested in WSL 2; the games, OBS and LiveSplit run on Windows ([docs/install.md](docs/install.md), "Where each part runs"). The harness reaches a game over `127.0.0.1` and starts Windows programs from WSL. Under WSL a connect to a closed local port can hang for about two minutes, so every connect has a deadline.

## Checking your work

- `npm test` runs every test; the result counts only when the summary reads `# fail 0`. `npm run check` checks the syntax of the plugin files.
- Tests use stand-ins for games, OBS and LiveSplit, so they need none of them installed. A change that touches a real game, the recorder or the timer is also tried against the real program before it is called done, and the pull request says what was tried.
- `npm run e2e:real` puts a game's mock through the real GUI on the real programs (Playwright): sound off the speakers, bundle, upload, nothing left running, settings unchanged. By default it runs only the games whose plugin changed since the last tag, and one game for shared code; `AAS_E2E_GAMES=all` or a list runs more. Run what the change touches, not every game. While it runs, wait through Monitor, never with a blocking loop, so the maintainer's messages come in.
- `npm run e2e:chain` tests the chain with the Archive through its e2e account: the shared fixtures in `packages/spec/fixtures/` (verdicts both sides assert), acceptance, proof on the Archive's tickets, hostile requests, and a wipe at the end. A change to a file the Archive carries goes to `next` first, so the Archive can take it before the release.
- A change to the GUI is tried in the real page with Playwright in WSL (headless Chromium): start `aas gui --no-open` on its own port with its own `AAS_GUI_NOTE`, so a GUI already open is left alone. Save writes the real settings (`.env`, `.local/games/<game>.env`) and check results (`.local/gui-checks.json`), so copy them first and put them back afterwards.
- What you report is what you measured: the frame you looked at, the log line you read, the sound level you measured. A test that was not run is reported as not run.
- A test against a real game makes no sound on the speakers unless that is what is being tested: use the program's own setting to turn sound off, and check before the first frame that it has no audio session.

## Versions and releases

- A part whose code changed gets the version of the release it goes into; `node packages/spec/make-plugins.mjs --write` keeps `packages/spec/plugins.json` in step and refuses while a plugin changed and kept its version.
- A minor version only for a new `summary.json` schema or a new SPEC draft; a patch for everything else. A SPEC change is a new draft number, listed under Drafts, with `SPEC_VERSION` in `packages/core/src/publish.mjs`.
- Releases are made by the maintainer: commit on `main`, an annotated tag `vX.Y.Z`, and a GitHub release whose notes are that version's CHANGELOG section. Tags are pushed by name (`git push origin refs/tags/vX.Y.Z`); `git push --tags` would also push local tags that were never meant to be public.
- Commit, push, tag, release and pull requests to other repositories happen only when the maintainer asks for them.

## What stays out of the repository

- Runs, recordings and their logs (`runs/`, `.local/`, `run.jsonl` are ignored).
- Anything that names a machine or a person: paths from your own disks, user names, device names, keys. Settings that differ per machine go through `.env`, stay off by default, and are listed in `.env.example`.
- Software from others that the setup downloads: it is pinned in the plugin's `UPSTREAM.json` and fetched by the plugin's install script.
