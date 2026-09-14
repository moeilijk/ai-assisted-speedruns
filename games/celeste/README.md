# Celeste (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `celeste` |
| upstream | [CelesteTAS](https://github.com/EverestAPI/CelesteTAS-EverestInterop) (MIT) on Everest |
| bridge | HTTP on `localhost:32270` (DebugRC): `/tas/playtas`, `/tas/sendhotkey` (FrameAdvance, Pause, SaveState), `/tas/game_state` as JSON. |
| ends | `end` "To be defined" |

Frame-exact, rich state, savestates, a large board.

Known risks:

- Needs a small Everest mod for a step and a screenshot endpoint, and to shield `/console` and `/tp`.
- The category is by definition modded and TAS-tooled.
- HTTP bridge: needs the core's HTTP client (see Balatro).
