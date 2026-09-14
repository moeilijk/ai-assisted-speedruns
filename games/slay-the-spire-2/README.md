# Slay the Spire 2 (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `slay_the_spire_2` |
| upstream | [Gennadiyev/STS2MCP](https://github.com/Gennadiyev/STS2MCP) (MIT). Not [CharTyr/STS2-Agent](https://github.com/CharTyr/STS2-Agent): its LICENSE file is AGPL-3.0 |
| bridge | REST on `localhost:15526`. |
| ends | `end` "To be defined" |

Successor of the Slay the Spire plugin; ends, segments and prepareRun follow the same shape. speedrun.com has an Any% Unseeded board.

Known risks:

- Early Access; the mod was tested on v0.103.2.
- A POST answers at once, so the controller has to poll.
- No seeded single-player start through the API.
- HTTP bridge: needs the core's HTTP client (see Balatro).
