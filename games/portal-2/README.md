# Portal 2 / Portal Stories: Mel / Aperture Tag (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `portal_2` |
| upstream | [p2sr/SourceAutoRecord](https://github.com/p2sr/SourceAutoRecord) (MIT), its TAS protocol |
| bridge | TCP `6555`: inline `.p2tas` with `start now`, pause at a tick, advance, entity position, angles and velocity. |
| ends | `end` "To be defined" |

Stepping and state without a core patch; the same controller design as portal-agent.

Known risks:

- No screenshot message: OBS `GetSourceScreenshot` or a small SAR patch.
- The tickbulk `commands` column runs console commands, so the controller must whitelist.
- SAR binds all interfaces, not only localhost.
