# @aas/runtime-mistral-vibe

Runtime plugin for [Mistral Vibe](https://github.com/mistralai/mistral-vibe), Mistral's coding agent CLI (`vibe`).

`configure` writes `.vibe/config.toml` into the run directory: the broker as the only MCP server (named `aas`, so its
tools reach the agent as `aas_<game>_documentation`, `aas_<game>_screenshot` and `aas_<game>_exec`), `enabled_tools`
limited to those three, and, when the run asks for them, `active_model` and that model's `thinking`. `AGENTS.md` is the
run brief's instructions. A copy with machine paths replaced goes to `runtime-config/config.template.toml` for
publication. Refuses to overwrite.

`start` launches `vibe` in the run directory (interactive). Headless (`aas run --headless`) it runs
`vibe -p <prompt> --legacy-harness --output streaming --trust --workdir <run> --auto-approve --max-price <AAS_VIBE_MAX_PRICE>` with
`--enabled-tools` for each of the three tools (in programmatic mode that disables every other tool), `--max-turns`
from the run's turn limit, and `--resume <session>` at a resume. What Vibe streams is kept in `vibe-stream.jsonl` in
the run directory, each entry with the time it arrived: Vibe's own saved session (`$VIBE_HOME/logs/session/`) has no
time per message, and the timeline needs one. A session that reaches `--max-turns` or `--max-price` ends `stopped`, so
the run can be resumed.

The legacy harness is Vibe's own `--legacy-harness`. The harness Vibe 2.25.8 runs by default kept tools of its own in a
smoke session (bash and file tools denied, `process.*` allowed, subagents on) whatever `--enabled-tools` named; in the
legacy harness `--enabled-tools` disables every other tool in `-p` mode. `aas doctor` checks that the flag is there,
and a run does not start without it.

## Models and thinking

Vibe has no flag for the model. `aas options --runtime mistral-vibe` and the GUI ask Vibe itself: its editor mode
(`vibe-acp`, the Agent Client Protocol) starts a session without a prompt and names the models it offers, the thinking
levels (`off`, `low`, `medium`, `high`, `max` in 2.25.8) and the ones in use. No model is asked anything. The run's
choice is written into its `.vibe/config.toml`, which Vibe merges with its own configuration by model alias.

## Price limit

Vibe keeps no plan budget the tooling can read (its own folder records only the plan's name), so every run is held to a
price: `AAS_VIBE_MAX_PRICE` in `.env`, the most one session may cost in dollars as Vibe counts it (`--max-price`). A run
does not start without it.

## Verify

```bash
npm run vibe:smoke     # a real headless session against the GUI's fake game (a few API calls, at most --max-price)
```

PASS means: the three broker tools were used through the generated configuration, Vibe's own saved session offered the
agent those three tools and nothing else, and no other tool ran.

`aas check-agent --runtime mistral-vibe --game <plugin.mjs>` is the check without a model: it starts the MCP server
exactly as the run's `.vibe/config.toml` names it and asks it for its tools.
