# @aas/runtime-claude-code

Runtime plugin for Claude Code. `configure` writes:

- `.mcp.json`: only the AAS broker, started with `node --permission ...`.
- `.claude/settings.json`: `permissions.allow` = the three `mcp__<game>__<game>_*` tools; `permissions.deny` = Bash, WebFetch, WebSearch, Agent, Read, Edit, Write, Glob, Grep and the rest.
- `CLAUDE.md` (and `AGENTS.md`, the spec's name) with the run brief's instructions.
- `runtime-config/` with machine paths replaced (`__RUN_DIR__`, `__REPO__`, `__HOME__`), for publication.

- Claude Code's own config file (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`): `projects["<run dir>"].hasTrustDialogAccepted: true`, see below.

`start` runs `claude --tools "" --mcp-config .mcp.json --strict-mcp-config --settings .claude/settings.json [--model m]` in the run directory. `--tools ""` removes every built-in tool from the session (shell, web, files, subagents), so the agent is offered the broker's three tools and nothing else; the deny rules stay as a second line.

## Workspace trust (Claude Code 2.1.207 and later)

Claude Code applies the `permissions.allow` rules of a directory's `.claude/settings.json` only in a directory it trusts: one whose trust dialog was accepted in an interactive session. For a directory inside a git repository the entry it checks is the repository's root, not the directory (measured with 2.1.270), so a run directory inside a checkout, such as the smoke test's `runs/claude-smoke`, trusts that checkout. Every run directory is new, and a headless run (`claude -p`) shows no dialog, so without further action every run starts with `Ignoring 3 permissions.allow entries from .claude/settings.json: this workspace has not been trusted` on stderr. The documented way to trust a directory without the dialog is the flag `projects["<absolute run dir>"].hasTrustDialogAccepted: true` in Claude Code's config file, and that is what `configure` (`aas run`) and `reconfigure` (`aas resume`) write ([trust.mjs](trust.mjs)); nothing else in that file is changed.

What the flag does and does not change: the same settings file is also passed with `--settings`, which Claude Code applies as a command-line override outside the trust check, so in an untrusted directory the three broker tools still worked and Bash and Read were still refused. The flag therefore does not change what the agent can do; it removes the warning that says rules were ignored. A run that carries that warning is not accepted as valid, whatever the agent did, so three checks hold the line:

1. `start` refuses an untrusted run directory before Claude Code is started (the message names the flag and the file).
2. In a headless run the runtime reads Claude Code's stderr; a line `Ignoring N permissions.<rule> entries ...` interrupts the session at once and the run ends `failed` with that line in its notes.
3. `aas doctor --runtime claude-code [--run-dir <dir>]` (`npm run sts:doctor`, `npm run portal:doctor`) reports whether `claude` is on the PATH, whether the config file is writable, and, for an existing run directory (a resume), whether it is trusted. `npm run claude:smoke` fails when the warning appears.

Setting up on another machine: install Claude Code, start it once interactively anywhere (that creates the config file), and run `npm run claude:smoke`; a PASS there means the trust flag and the allow rules work on that machine, and that the session offered the agent no tool but the broker's three (read from the session's own init record). Nothing needs to be edited by hand.

## Known gap

None known for the tools: with `--tools ""` the session offers no built-in tool, so the three tools the broker writes to `tools.json` are every tool the agent had.
