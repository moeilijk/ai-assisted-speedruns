// Reading a Portal 2 demo: the layout is p2sr's own (p2sr/mdp, src/demo.c), and this builds a demo byte for byte
// to check it, so the test needs no demo of someone else's in the repository.
//
// Measured against two real published demos while this was written (p2sr/mdp's own `demos/`): sp_a1_intro3 by
// m1a2d3i4n5, 1366 ticks and 1361 usercmds, and mp_coop_multifling_1 by daver12345, 1718 ticks and 1718 usercmds.
// Both walk to their stop message with the last tick equal to the tick count in the header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE, readHeader, readMessages } from "../demo.mjs";

const padded = (text, length) => { const b = Buffer.alloc(length); b.write(text, 0, "latin1"); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const f32 = (n) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const message = (type, tick, slot = 0) => Buffer.concat([Buffer.from([type]), u32(tick), Buffer.from([slot])]);

function demo({ map = "sp_a1_intro1", ticks = 3, game = "portal2", protocol = 4, userCmds = [], stop = true } = {}) {
  const header = Buffer.concat([
    padded("HL2DEMO\0", 8), u32(protocol), u32(2001),
    padded("localhost:27015", 260), padded("a runner", 260), padded(map, 260), padded(game, 260),
    f32(ticks / 60), u32(ticks), u32(ticks), u32(0),
  ]);
  const parts = [header, message(MESSAGE.SYNC_TICK, 0)];
  // A packet carries two PacketInfos, the sequence numbers, then its own size.
  parts.push(message(MESSAGE.PACKET, 1), Buffer.alloc(76 * 2 + 4 + 4), u32(4), Buffer.from("data"));
  for (const { tick, number, data } of userCmds) parts.push(message(MESSAGE.USER_CMD, tick), u32(number), u32(data.length), data);
  parts.push(message(MESSAGE.CONSOLE_CMD, 2), u32(5), Buffer.from("echo\0"));
  parts.push(message(MESSAGE.CUSTOM_DATA, 2), u32(0), u32(2), Buffer.from([1, 2]));
  if (stop) parts.push(message(MESSAGE.STOP, ticks), Buffer.from("SAR checksum, not a message"));
  return Buffer.concat(parts);
}

test("a demo says which game, which map and how long it lasted", () => {
  const header = readHeader(demo({ map: "sp_a2_bts1", ticks: 600 }));
  assert.equal(header.protocol, 4);
  assert.equal(header.game, "portal2");
  assert.equal(header.map, "sp_a2_bts1");
  assert.equal(header.ticks, 600);
  assert.equal(header.client, "a runner");
  assert.throws(() => readHeader(Buffer.alloc(1072)), /not a Source demo/);
  assert.throws(() => readMessages(demo({ protocol: 3 })), /protocol 3 is not Portal 2's/);
});

test("the input of every tick comes back out, in order", () => {
  const cmds = [
    { tick: 0, number: 11243, data: Buffer.from("d75700008a0100004477b3ecfdb3442b0480010058", "hex") },
    { tick: 1, number: 11244, data: Buffer.from("d95700008e010000dc72b3ecfdb3442b0480020058", "hex") },
    { tick: 20, number: 11245, data: Buffer.from("db570000da010000a442b3ecfde0452b0480010058", "hex") },
  ];
  const seen = [];
  const read = readMessages(demo({ ticks: 20, userCmds: cmds }), { onUserCmd: (c) => seen.push(c.tick) });
  assert.equal(read.userCmds.length, 3, "one per tick that had input");
  assert.deepEqual(seen, [0, 1, 20], "handed over while reading, in the order the run played them");
  assert.deepEqual(read.userCmds.map((c) => c.number), [11243, 11244, 11245]);
  // The payload is kept exactly as the engine wrote it: what is in it is the next step's business, not this one's.
  assert.equal(read.userCmds[0].data.toString("hex"), cmds[0].data.toString("hex"));
  assert.equal(read.lastTick, 20);
  assert.equal(read.counts[MESSAGE.USER_CMD], 3);
  assert.equal(read.counts[MESSAGE.PACKET], 1);
  // What follows the stop message is SAR's checksum, and the reader stops before it rather than reading it as one.
  assert.ok(read.endedAt < demo({ ticks: 20, userCmds: cmds }).length);
});

test("a demo that was cut short says so, instead of being read as if it were whole", () => {
  assert.throws(() => readMessages(demo({ stop: false })), /no stop message: it was cut short/);
});
