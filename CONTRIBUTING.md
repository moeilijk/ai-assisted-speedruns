# Contributing

Issues and pull requests are welcome, for a new game plugin as much as for a fix. The tooling is in beta until 1.0.0 on 1 October 2026 (see [CHANGELOG.md](CHANGELOG.md)), so things still move.

## Before you start

Open an issue first when a change is a design choice: a new plugin kind, a change to how the harness runs a session, anything in the bundle format. Say what you want to change, why, and what you considered instead. Once it is settled it goes into the Decisions of [docs/design.md](docs/design.md), with the alternative that was not taken. A plain fix or a new game plugin can go straight to a pull request.

## A pull request

One subject per pull request. Several changes that build on each other go in as a stack, each pull request saying which one it builds on.

In the same pull request as the code:

- `npm test` passes: the summary line reads `# fail 0`. `npm run check` passes too. A new game plugin goes through the whole harness in a test (`packages/core/test/chain.mjs`), and every value it passes on from outside has a test with a hostile form (see `packages/core/test/hostile-input.test.mjs`).
- A line under the unreleased version at the top of [CHANGELOG.md](CHANGELOG.md): what is now true that wasn't before, and why when that isn't obvious. The version follows the rule at the top of that file: a minor version only for a new `summary.json` schema or a new SPEC draft, a patch for everything else.
- The docs that describe what you changed: the plugin's README, [docs/reference.md](docs/reference.md) for a new setting or command, [docs/install.md](docs/install.md) for a new install step, `.env.example` for a new setting.
- Any part with a version that changed gets the version of the release it goes into (`package.json` of the package, `version` in a plugin). Then run `node packages/spec/make-plugins.mjs --write`: it refuses while a plugin changed and kept its version, and the tests fail while `packages/spec/plugins.json` is out of date.
- A change to [packages/spec/SPEC.md](packages/spec/SPEC.md) is a new draft with the next number, listed under Drafts at its end, and `SPEC_VERSION` in `packages/core/src/publish.mjs` goes with it.

In the description, say what was tested and how, with what you measured (a run, a recording, a log). Anything you did not measure goes under what was not tested.

Nothing in the repository names your machine: no paths from your own disks, user names, device names or keys. Settings that differ per machine go through `.env` and stay off by default.

Pull requests made with an AI assistant are welcome. Say so in the commit (a `Co-Authored-By` line) or the description; the rules above apply the same way.

## Game plugins

Writing one is described in [docs/plugins.md](docs/plugins.md), with a checklist at the end. The [rules for every game](README.md#rules-for-every-game) apply to every plugin.

## License

The repository is MIT ([LICENSE](LICENSE)). Code from others keeps its own license and is named in the [License section of the README](README.md#license).
