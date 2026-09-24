# FCEUX API

`emu` is in scope in `fceux_exec`. The emulator is paused between your calls; the game advances only while a call
plays frames. A second has about 60 frames (60.0988 on an NTSC NES).

## Looking

- `await emu.info()`: `system`, `rom`, `rom_md5`, `framecount` (frames since power-on), `paused`, `profile`.
- `fceux_screenshot`: the current frame as an image.
- `emu.buttons()`: the names of the buttons of controller 1: `Up`, `Down`, `Left`, `Right`, `Start`, `Select`, `B`, `A`.
- `await emu.read(address, { width })`: one value at an address of the NES CPU's memory (the game's RAM is `0x0000`
  to `0x07FF`), `width` 8 or 16 bits.
- `await emu.readRange(address, length)`: up to 4096 bytes from that address, as a list of numbers.

## Playing

- `await emu.press(['A', 'Right'], frames)`: hold these buttons for that many frames (default 1), then release. Returns `{ frames, framecount }`.
- `await emu.sequence([{ buttons: ['A'], frames: 3 }, { frames: 30 }, { buttons: ['Right'], frames: 10 }])`: several steps in one call; a step without buttons plays frames with nothing pressed.
- `await emu.wait(frames)`: play frames with nothing pressed.

A call plays at most 36000 frames. Buttons are held for the whole step; to tap a button, hold it for a few frames and
then let a step without buttons follow. Each call is one entry in the timeline, and the game time of the run is the sum
of the frames you played.
