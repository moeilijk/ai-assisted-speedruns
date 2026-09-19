// A Portal 2 demo (.dem), read far enough to get the input back out of it.
//
// Why a demo: the route a mock run plays is not written here and not taken from one of our own runs. Portal 2's
// speedrunners publish theirs — board.portal2.sr keeps the top runs of every single-player and co-op map, with
// the demo of each — and a Source demo carries the player's `usercmd` for every tick it lasted. That is the same
// thing a .p2tas framebulk holds: what was pressed, and where the view was pointed, per tick.
//
// The layout is not guessed: it is the one p2sr's own demo parser reads (p2sr/mdp, src/demo.c). A message is
// `type(1) tick(4) slot(1)` and then, per type, what that type carries. A demo ends on DEMO_MSG_STOP, and what
// follows it is SAR's checksum, which is not a message.
import fs from "node:fs";

export const MESSAGE = Object.freeze({
  SIGN_ON: 1, PACKET: 2, SYNC_TICK: 3, CONSOLE_CMD: 4, USER_CMD: 5,
  DATA_TABLES: 6, STOP: 7, CUSTOM_DATA: 8, STRING_TABLES: 9,
});
const HEADER_BYTES = 1072;
const cstring = (buffer, at, length) => buffer.subarray(at, at + length).toString("latin1").split("\0")[0];

/** What a demo says about itself. `protocol` 4 is Portal 2's; anything else is another game's demo. */
export function readHeader(buffer) {
  if (buffer.subarray(0, 8).toString("latin1") !== "HL2DEMO\0") throw new Error("not a Source demo (no HL2DEMO marker)");
  return {
    protocol: buffer.readInt32LE(8),
    network: buffer.readInt32LE(12),
    server: cstring(buffer, 16, 260),
    client: cstring(buffer, 276, 260),
    map: cstring(buffer, 536, 260),
    game: cstring(buffer, 796, 260),
    seconds: buffer.readFloatLE(1056),
    ticks: buffer.readInt32LE(1060),
    frames: buffer.readInt32LE(1064),
  };
}

/**
 * Every message of a demo, in order. `onUserCmd` is handed each `usercmd` as it comes by: `{ tick, slot, number,
 * data }`, where `data` is the payload exactly as the engine wrote it.
 */
export function readMessages(buffer, { onUserCmd = null } = {}) {
  const header = readHeader(buffer);
  if (header.protocol !== 4) throw new Error(`demo protocol ${header.protocol} is not Portal 2's (4)`);
  const counts = {};
  const userCmds = [];
  let pos = HEADER_BYTES;
  let lastTick = 0;
  while (pos + 6 <= buffer.length) {
    const type = buffer[pos];
    const tick = buffer.readInt32LE(pos + 1);
    const slot = buffer[pos + 5];
    pos += 6;
    counts[type] = (counts[type] ?? 0) + 1;
    if (type === MESSAGE.STOP) return { header, counts, userCmds, lastTick, endedAt: pos };
    if (type === MESSAGE.SYNC_TICK) continue; // carries nothing
    if (type === MESSAGE.SIGN_ON || type === MESSAGE.PACKET) {
      pos += 76 * 2 + 4 + 4; // two PacketInfos (the engine writes one per split screen slot), in and out sequence
      pos += 4 + buffer.readInt32LE(pos);
      lastTick = tick;
    } else if (type === MESSAGE.USER_CMD) {
      const number = buffer.readInt32LE(pos); pos += 4;
      const size = buffer.readInt32LE(pos); pos += 4;
      const cmd = { tick, slot, number, data: buffer.subarray(pos, pos + size) };
      userCmds.push(cmd);
      onUserCmd?.(cmd);
      pos += size;
      lastTick = tick;
    } else if (type === MESSAGE.CUSTOM_DATA) {
      pos += 4; // the kind of custom data (SAR's own, or another tool's)
      pos += 4 + buffer.readInt32LE(pos);
    } else if (type === MESSAGE.CONSOLE_CMD || type === MESSAGE.DATA_TABLES || type === MESSAGE.STRING_TABLES) {
      pos += 4 + buffer.readInt32LE(pos);
    } else {
      throw new Error(`unknown demo message ${type} at byte ${pos - 6}`);
    }
    if (pos > buffer.length) throw new Error(`a message at byte ${pos - 6} runs past the end of the demo`);
  }
  throw new Error("the demo has no stop message: it was cut short while it was being written");
}

export const readDemo = (file, options) => readMessages(fs.readFileSync(file), options);

if (process.argv[1] && process.argv[1].endsWith("demo.mjs")) {
  for (const file of process.argv.slice(2)) {
    const { header, counts, userCmds, lastTick } = readDemo(file);
    console.log(`${file}\n  ${header.game} ${header.map}, ${header.ticks} ticks (${header.seconds.toFixed(2)} s), recorded by ${header.client}`);
    console.log(`  messages ${JSON.stringify(counts)}\n  ${userCmds.length} usercmds, last tick ${lastTick}`);
  }
}
