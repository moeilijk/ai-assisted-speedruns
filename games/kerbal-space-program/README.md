# Kerbal Space Program (stub)

A stub: the plugin loads and declares its ends, and does nothing else. `aas configure` refuses it. Work on it is planned after 2026-09-16.

| | |
|---|---|
| id | `kerbal_space_program` |
| upstream | [kRPC](https://github.com/krpc/krpc) (LGPL-3.0; the SpaceCenter service GPL-3.0) |
| bridge | protobuf over TCP or WebSocket on `localhost:50000/50001`. |
| ends | `mun_landing` "Mun Landing" |

Decided on 2026-09-14: the first category is Mun Landing, extended only after that succeeds.

Known risks:

- The editor API (`SpaceCenter.Editor`: load and launch a vessel, per-stage delta-v) and tick hold (`KRPC.HoldTick`) are on kRPC `main` (v0.7.0), not in the v0.6.0 release. Which version to build against is parked.
- During a tick hold the game does not render, so no screenshot then.
- The only Node client is old; the controller needs its own protobuf client from kRPC's schema.
- Stock part configurations are Squad's (all rights reserved): read them from the player's own install, never publish them.
