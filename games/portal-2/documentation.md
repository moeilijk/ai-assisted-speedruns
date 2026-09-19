# Portal 2 JavaScript API

Everything in `portal_2_exec` runs against a live Portal 2 with SourceAutoRecord loaded and its TAS protocol server
open (`plugin_load sar`, `sar_tas_protocol_server 6555`). The object is called `p2`, and `game` is the same object.

```ts
interface Portal2Controller {
  observe(what?: ("location" | "tick" | "playback" | "player")[]): Promise<{
    location?: string;        // the map the game reports when the protocol connects
    tick?: number;            // the tick of the last answer from the game
    playback?: "playing" | "paused" | "fast-forwarding" | "inactive" | "unknown";
    player?: Entity;
  }>;
  entity(selector?: string): Promise<Entity>;   // "player", "#12", a targetname
  advance(ticks?: number): Promise<number>;     // steps, and answers with the tick reached
  script(text: string, name?: string): Promise<{ slot: number; script: string }>;
  pauseAtTick(tick: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
}

interface Entity { state: number; position: [number, number, number]; angles: [number, number, number]; velocity: [number, number, number]; }
```

## Playing

The input is a `.p2tas` script, sent inline — there is no file on disk. A script that begins with `start now`
continues from the state the game is in, which is what a run needs: the game is already loaded and paused.

```js
await p2.script(`start now
+0 > |          // tick 0: nothing
+20 > |W        // hold forward for 20 ticks
+10 > |         // let go
`);
```

Ticks are 60 per second in Portal 2. `advance(n)` steps the playback by hand, `pauseAtTick(t)` stops it at a tick.

## What this controller cannot do

- **No screenshot.** SAR's TAS protocol has no picture message (`docs/tas_proto.txt`), so `screenshot()` throws.
  What the run shows is the recording.
- **No console commands.** The `commands` column of a p2tas tickbulk would run arbitrary console commands; this
  controller does not offer it, and a script that carries one is refused by the game plugin.
