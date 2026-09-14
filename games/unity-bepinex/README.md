# Unity games through BepInEx (generic bridge) (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `unity_bepinex` |
| upstream | [BepInEx](https://github.com/BepInEx/BepInEx) (LGPL-2.1) with Harmony (MIT) |
| bridge | A BepInEx plugin: pause (`timeScale=0` plus `AudioListener.pause`), step (`captureDeltaTime`), screenshot, scene state. |
| ends | `end` "To be defined" |

One bridge for many Unity Mono games; a first target named in the research: Inscryption (turn-based card battles).

Known risks:

- `observe()` and the actions stay a per-game adapter.
- Generic pausing fails in many games (UniTAS' compatibility list).
- A plugin linking BepInEx has to respect LGPL-2.1.
