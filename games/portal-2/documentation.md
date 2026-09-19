# Portal 2 JavaScript API

Everything in `portal_2_exec` runs against a live Portal 2 with SourceAutoRecord loaded and its TAS protocol
server open (`plugin_load sar`, `sar_tas_protocol_server 6555`). The controller is called `portal2`.

The game runs at 60 ticks per second and is paused between your calls: game time only advances while a script or a
step is playing, so thinking costs no game time.

```ts
interface Portal2Controller {
  // Observing
  observe(what?: ("map" | "tick" | "playback" | "player")[]): Promise<{
    map?: string | null;          // the map the run is in, e.g. "sp_a2_bts1"
    chamber?: string | null;      // the name the game gives that map, e.g. "Jailbreak"
    tick?: number | null;         // the tick of the last answer from the game
    playback?: "playing" | "paused" | "fast-forwarding" | "inactive" | "unknown";
    player?: Entity;
  }>;
  map(): string | null;
  entity(selector?: string): Promise<Entity>;      // "player", "#12", a targetname
  position(): Promise<[number, number, number]>;
  screenshot(): Promise<{ image: string; mimeType: string; file: string }>;

  // Playing
  tas(script: string, options?: { name?: string }): Promise<{ slot: number; playback: string; tick: number | null }>;
  advance(ticks?: number): Promise<number>;        // plays exactly that many ticks, answers with the tick reached
  pause(): Promise<{ requested: string; playback: string }>;
  play(): Promise<{ requested: string; playback: string }>;
  pauseAtTick(tick: number): Promise<{ requested: string; playback: string }>;
  fastForward(tick: number, pauseAfter?: boolean): Promise<{ requested: string; playback: string }>;
  rate(value: number): Promise<{ rate: number | null }>;
  seconds(s: number): number;                      // seconds → ticks
}

interface Entity { state: number; position: [number, number, number]; angles: [number, number, number]; velocity: [number, number, number]; }
```

## Playing with a script

Input is a `.p2tas` script, sent inline — there is no file on disk. A script you pass without a header gets
`version 9` and `start now`, which continues from the state the game is in: the game is already loaded and paused,
which is what a run needs.

A tickbulk is `tick>movement|angles|buttons|commands|tools`:

- **tick** — absolute (`120>`) or relative to the previous bulk (`+10>`).
- **movement** — two numbers, each −1 … 1: sideways and forward.
- **angles** — two numbers, each −180 … 180: the camera's turn this tick.
- **buttons** — `J` jump, `D` duck, `U` use, `Z` zoom, `B` blue portal, `O` orange portal. Uppercase presses,
  lowercase releases, and a number right after a letter holds it for that many ticks (`J1`).
- **commands** — console commands, separated by `;`.
- **tools** — `strafe`, `autojump`, `autoaim`, separated by `;`.

A value stays as it was until you change it, so a bulk may be `69>` on its own.

`tas()` answers when the script has finished playing, not when it was accepted: the game sends its "processed
script" packet at the end of playback. The state requests (`pause`, `play`, `pauseAtTick`, `fastForward`) have no
answer in the protocol, so they report what was asked for; `playback` next to it is the last state the game itself
sent, and not proof that the request landed.

```js
// Walk forward for one second, then fire a blue portal.
await portal2.tas(`
+0>0 1|0 0|||
+60>0 0|0 0|B1||
`);
return await portal2.observe(["map", "tick", "player"]);
```

## Stepping

```js
await portal2.advance(portal2.seconds(2));   // play exactly two seconds of game time
return await portal2.position();
```

## What the protocol does not carry

SAR's TAS protocol has no screenshot message and names the map only once, when the controller connects
(`docs/tas_proto.txt`). Both are answered with the engine's own facilities, not with a change to SAR:
`portal2.screenshot()` runs the engine's `jpeg` command and returns the file it wrote, and `portal2.map()` reads
the map from the console log the game writes itself when it is started with `-condebug`.
