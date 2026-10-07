# BizHawk API

`emu` is in scope in `bizhawk_exec`. The emulator is paused between your calls; the game advances only while a call
plays frames. A second has about 60 frames (the exact rate depends on the system).

## Looking

- `await emu.info()`: `system`, `rom`, `rom_sha1`, `framecount` (frames since power-on), `paused`, `profile`.
- `bizhawk_screenshot`: the current frame as an image.
- `await emu.buttons()`: the names of the buttons of controller 1, for example `Up`, `Down`, `Left`, `Right`, `A`, `B`, `Start`, `Select`.
- `await emu.read(address, { domain, width })`: one value from the game's memory, `width` 8, 16 or 32 bits; `domain` as `emu.domains()` lists them (for example `RAM`).
- `await emu.readRange(address, length, domain)`: up to 4096 bytes as hex.
- `await emu.domains()`: the memory domains of this system with their sizes.

## Playing

Each `bizhawk_exec` call plays one plan: the steps you give it play in one go, at the game's own speed, and the game
stands still again when they are done. The result comes back with a screenshot of the frame the plan ended on. A second
plan in the same call is refused; look at the result and plan the next move in a new call. Reading the memory and
taking screenshots is allowed before and after the plan, while the game stands still.

- `emu.tas()`: build a plan. Nothing plays until `run()`.
  - `.hold(['Right', 'B'], frames)`: hold these buttons for that many frames.
  - `.tap('A', frames)`: press for a few frames (default 3).
  - `.wait(frames)`: play frames with nothing pressed.
  - `await .run()`: play the plan. Returns `{ frames, framecount }`.
- `await emu.sequence([{ buttons: ['A'], frames: 3 }, { frames: 30 }, { buttons: ['Right'], frames: 10 }])`: the same plan as a list of steps.
- `await emu.press(['A', 'Right'], frames)`: a plan of one step (default 1 frame).
- `await emu.wait(frames)`: a plan of one step with nothing pressed.

A plan plays at most 36000 frames. Buttons are held for the whole step; a step without buttons releases them. Each
plan is one entry in the timeline, and the game time of the run is the sum of the frames you played.

Example:

```js
const plan = emu.tas();
plan.hold(['Right', 'B'], 60);        // run right for a second
plan.hold(['Right', 'B', 'A'], 20);   // jump while running
plan.hold(['Right'], 30);             // land
return await plan.run();              // plays, then the screenshot comes back
```
