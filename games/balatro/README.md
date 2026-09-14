# Balatro (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `balatro` |
| upstream | [coder/balatrobot](https://github.com/coder/balatrobot) (MIT), which runs on Lovely and Steamodded (GPL-3.0) |
| bridge | JSON-RPC 2.0 over HTTP on `127.0.0.1:12346`: `gamestate`, every action, `screenshot`, `save`/`load`, `start` with deck, stake and seed. |
| ends | `end` "To be defined" |

Turn-based; an action answers once the state has settled; seeds. speedrun.com has Random Seed and Set Seed boards.

Known risks:

- The debug endpoints `add`/`set` and `--fast`/game speed must stay out of the agent's reach.
- Lovely injects a DLL, which can break with a game patch.
- The broker blocks `fetch`: an HTTP bridge needs the core's HTTP client to declared endpoints (owner decision, not built yet).
