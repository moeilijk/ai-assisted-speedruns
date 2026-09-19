// The wire format against SAR's own specification (docs/tas_proto.txt), and a round trip over a socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, encode, FROM_GAME, TO_GAME } from "../sar-protocol.mjs";
import { startFakeSar } from "./fake-sar.mjs";
import { connectSar } from "../sar-client.mjs";

test("a packet is one byte of id and then its fields, little-endian, strings length-prefixed", () => {
  const advance = encode(TO_GAME, 7);
  assert.deepEqual([...advance], [7], "advance tick carries no fields");

  const pause = encode(TO_GAME, 6, { tick: 66 });
  assert.equal(pause.length, 5);
  assert.equal(pause[0], 6);
  assert.equal(pause.readUInt32LE(1), 66);

  const scripts = encode(TO_GAME, 10, { script1name: "aas", script1: "start now\n+1>|", script2name: "", script2: "" });
  const { packets, rest } = decode(TO_GAME, scripts);
  assert.equal(rest.length, 0);
  assert.deepEqual(packets, [{ id: 10, name: "play scripts", script1name: "aas", script1: "start now\n+1>|", script2name: "", script2: "" }]);
});

test("a stream is read packet by packet, and half a packet waits for the rest", () => {
  const stream = Buffer.concat([encode(FROM_GAME, 255, { location: "portal2" }), encode(FROM_GAME, 6, { tick: 3 }), encode(FROM_GAME, 4)]);
  const whole = decode(FROM_GAME, stream);
  assert.deepEqual(whole.packets.map((p) => p.name), ["game location", "current tick", "paused"]);
  assert.equal(whole.rest.length, 0);

  // "game location" is 1 + 4 + 7 = 12 bytes and "current tick" is 5, so two bytes short of the end the tick packet
  // is incomplete: it stays in `rest` until the next chunk arrives.
  const cut = decode(FROM_GAME, stream.subarray(0, stream.length - 2));
  assert.deepEqual(cut.packets.map((p) => p.name), ["game location"]);
  assert.equal(cut.rest.length, 4, "the half packet is kept for the next chunk");
  const joined = decode(FROM_GAME, Buffer.concat([cut.rest, stream.subarray(stream.length - 2)]));
  assert.deepEqual(joined.packets.map((p) => p.name), ["current tick", "paused"]);
});

test("entity info carries three vectors of three floats", () => {
  const b = encode(FROM_GAME, 100, { state: 1, position: [1.5, -2.5, 3], angles: [0, 90, 0], velocity: [0, 0, -9.5] });
  const { packets } = decode(FROM_GAME, b);
  assert.equal(packets[0].state, 1);
  assert.deepEqual(packets[0].position, [1.5, -2.5, 3]);
  assert.deepEqual(packets[0].velocity, [0, 0, -9.5]);
});

test("the client talks to a server that speaks the protocol", async () => {
  const sar = await startFakeSar();
  const game = await connectSar({ port: sar.port });
  try {
    assert.equal(game.state.location, "portal2/maps/sp_a1_intro1", "the game sends its location first");
    const entity = await game.entity("player");
    assert.deepEqual(entity.position, [1, 2, 3]);
    await game.advance(3);
    assert.equal(game.state.tick, 3, "every advance is answered with the new tick");
    await game.script("start now\n+1>|");
    assert.deepEqual(sar.received.map((p) => p.name), ["entity info", "advance tick", "advance tick", "advance tick", "play scripts"]);
  } finally {
    game.close();
    sar.close();
  }
});
