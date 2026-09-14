# Unreal Engine games through UE4SS (generic bridge) (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `unreal_ue4ss` |
| upstream | [RE-UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) (MIT): UE 4.7–5.8, Lua API, C++ mod API, Blueprint mod loader, injected through a `dwmapi.dll` proxy |
| bridge | A UE4SS mod: game state read through reflection, actions called as UFUNCTIONs (`ProcessEvent`), events through `RegisterHook`; a transport to the controller still to be chosen |
| ends | `end` "To be defined" |

One bridge for many Unreal Engine games; the first target it was planned for: Star Wars Zero Company (Bit Reactor, Unreal Engine 5.6), turn-based, built on the Gameplay Ability System, shipped with its PDB, without DRM or anti-cheat. It was the framework's first reference game until Slay the Spire replaced it on 2026-09-11; its research is in the history of this repository (`games/zero-company/`, removed in b3ed249).

Known risks:

- UE4SS's Lua API documents no sockets. A C++ mod can open one, but building one needs Epic source access linked to a GitHub account. The broker only connects to the endpoints a plugin declares, so writing files for the controller to poll does not fit; a Windows-side bridge like Slay the Spire's is the pattern already in the repository.
- The last stable UE4SS release is v3.0.1 (2024-02-14); newer engines depend on the rolling experimental build.
- Games on their own engine branch need a compatible UE4SS build: Zero Company's `ProjectBruno` branch has a separate compatibility build, which has to match the installed game build.
- `observe()` and the actions stay a per-game adapter.
