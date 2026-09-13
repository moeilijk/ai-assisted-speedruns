# @aas/runtime-codex

Runtime plugin for Codex. `configure` writes `.codex/config.toml` from [config.template.toml](config.template.toml) (derived from portal-agent's `run/config.template.toml`, MIT): web search off, shell off, only the broker's three tools enabled, broker started with `node --permission --allow-fs-read=<core,game,...> --allow-fs-write=<run>`. `AGENTS.md` is the run brief's instructions. A copy with machine paths replaced goes to `runtime-config/config.template.toml` for publication. Refuses to overwrite.

`start` launches `codex` in the run directory and waits (the TUI); headless (`aas run --headless`) it runs `codex exec --json` with the goal prompt (`codex exec resume <thread>` at a resume), streams the agent's messages and tool calls to stderr, stops the session on the game's victory or the time budget, and locates the thread's rollout under `$CODEX_HOME/sessions` for `aas publish`.

## Project trust

Codex loads a project's `.codex/config.toml` (here: the run's hardened configuration) only for a project it trusts, and trust is an exact entry for that directory in its user config, `[projects."<run dir>"] trust_level = "trusted"` in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Without that entry Codex loads no MCP server and asks for approval on its own terms, so the agent would have no broker tools and a shell instead; a wildcard entry for `/` or a git repository in the directory does not count. `configure` and `reconfigure` write the entry; `start` refuses an untrusted directory.
