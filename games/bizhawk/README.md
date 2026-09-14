# BizHawk emulator (generic, with game profiles) (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `bizhawk` |
| upstream | [BizHawk](https://github.com/TASEmulators/BizHawk) (MIT for the frontend; bundled cores carry their own, GPL, licenses). Bridge options: a Lua bridge, [mcp-bizhawk](https://github.com/dmang-dev/mcp-bizhawk) (MIT) or [bizhawk-mcp-native](https://github.com/StealthC/bizhawk-mcp-native) (MIT) |
| bridge | Lua inside EmuHawk; `comm.socketServer` is a TCP client, so a Windows-side bridge has to listen for it. |
| ends | `end` "To be defined" |

Pause, frame advance, screenshot, savestates, RAM and joypad for many systems; the `.bk2` input movie as ground truth. A first profile named in the research: Micro Mages (NES).

Known risks:

- ROMs, BIOS and savestates never go into a bundle, only their names and hashes.
- BizHawk itself is not redistributed.
- The MCP variants expose memory writes and `lua_exec`: allow-list them.
