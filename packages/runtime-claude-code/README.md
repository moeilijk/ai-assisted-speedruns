# @aas/runtime-claude-code

Runtime plugin for Claude Code. `configure` writes:

- `.mcp.json`: only the AAS broker, started with `node --permission ...`.
- `.claude/settings.json`: `permissions.allow` = the three `mcp__<game>__<game>_*` tools; `permissions.deny` = Bash, WebFetch, WebSearch, Agent, Read, Edit, Write, Glob, Grep and the rest.
- `CLAUDE.md` (and `AGENTS.md`, the spec's name) with the run brief's instructions.
- `runtime-config/` with machine paths replaced (`__RUN_DIR__`, `__REPO__`, `__HOME__`), for publication.

- Claude Code's own config file (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`): `projects["<run dir>"].hasTrustDialogAccepted: true`, see below.

`start` runs `claude --mcp-config .mcp.json --strict-mcp-config --settings .claude/settings.json [--model m]` in the run directory.

## Workspace trust (Claude Code 2.1.207 and later)

Claude Code applies the `permissions.allow` rules of a directory's `.claude/settings.json` only in a directory it trusts: one whose trust dialog was accepted in an interactive session. Every run directory is new, and a headless run (`claude -p`) shows no dialog, so without further action every run starts with `Ignoring 3 permissions.allow entries from .claude/settings.json: this workspace has not been trusted` on stderr. The documented way to trust a directory without the dialog is the flag `projects["<absolute run dir>"].hasTrustDialogAccepted: true` in Claude Code's config file, and that is what `configure` (`aas run`) and `reconfigure` (`aas resume`) write ([trust.mjs](trust.mjs)); nothing else in that file is changed.

What the flag does and does not change: the same settings file is also passed with `--settings`, which Claude Code applies as a command-line override outside the trust check, so in an untrusted directory the three broker tools still worked and Bash and Read were still refused. The flag therefore does not change what the agent can do; it removes the warning that says rules were ignored. A run that carries that warning is not accepted as valid, whatever the agent did, so three checks hold the line:

1. `start` refuses an untrusted run directory before Claude Code is started (the message names the flag and the file).
2. In a headless run the runtime reads Claude Code's stderr; a line `Ignoring N permissions.<rule> entries ...` interrupts the session at once and the run ends `failed` with that line in its notes.
3. `aas doctor --runtime claude-code [--run-dir <dir>]` (`npm run sts:doctor`, `npm run portal:doctor`) reports whether `claude` is on the PATH, whether the config file is writable, and, for an existing run directory (a resume), whether it is trusted. `npm run claude:smoke` fails when the warning appears.

Setting up on another machine: install Claude Code, start it once interactively anywhere (that creates the config file), and run `npm run claude:smoke`; a PASS there means the trust flag, the allow rules and the deny rules all work on that machine. Nothing needs to be edited by hand.

## Known gap

Claude Code has runtime-internal tools (ToolSearch, and the denied built-ins the agent can still *attempt*). The spec asks for every tool the agent had in `tools.json`; the broker writes only its three. The attempts are visible in `summary.json.tool_methods_in_exec` and in the timeline. Listing the runtime's own tools in `tools.json` needs their definitions from Claude Code; open.
