# Half-Life 2 / Episode One / Half-Life: Source (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `half_life_2` |
| upstream | SourcePauseTool with cozyblaze's patch from [portal-agent](https://github.com/cozyblaze/portal-agent), as [games/portal](../portal/README.md) uses it |
| bridge | SPT IPC on TCP `127.0.0.1:27182`, the same as Portal. |
| ends | `end` "To be defined" |

Most of games/portal carries over: controller, SPT session, launch and close, the source-demo recorder, saves.

Known risks:

- The start detection and the start map are Portal-specific.
- More input than Portal: reload, weapons, vehicles.
- Length: Episode One or Half-Life: Source are shorter first goals than Half-Life 2.
