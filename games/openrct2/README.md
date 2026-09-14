# OpenRCT2 (RollerCoaster Tycoon 2 scenarios) (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `openrct2` |
| upstream | [OpenRCT2](https://github.com/OpenRCT2/OpenRCT2) (GPL-3.0), its JavaScript plugin API |
| bridge | An own plugin with `network.createListener()` (localhost only by design): `context.executeAction`, `context.paused`, `captureImage`, `saveGame`. |
| ends | `end` "To be defined" |

A scenario's objective and status are natural ends.

Known risks:

- A plugin written against OpenRCT2's plugin API falls under its GPL-3.0 terms; check before writing it.
- The FF% board forbids plugins, so runs are comparable but not board-valid.
- Needs the RollerCoaster Tycoon 2 files.
- Fast-forward versus game time has to be defined.
