// A stand-in for SourceAutoRecord's TAS protocol server: it speaks the protocol of docs/tas_proto.txt and nothing
// else. It exists so the controller can be tested without Portal 2: it sends packet 255 first, answers an entity
// info request, counts ticks, and records what the controller sent.
import net from "node:net";
import { decode, encode, FROM_GAME, TO_GAME } from "../sar-protocol.mjs";

export function startFakeSar({ location = "portal2/maps/sp_a1_intro1", entity = { state: 1, position: [1, 2, 3], angles: [0, 90, 0], velocity: [0, 0, 0] } } = {}) {
  const received = [];
  let tick = 0;
  const server = net.createServer((socket) => {
    socket.write(encode(FROM_GAME, 255, { location }));
    let rest = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const read = decode(TO_GAME, Buffer.concat([rest, chunk]));
      rest = read.rest;
      for (const p of read.packets) {
        received.push(p);
        if (p.id === 7) { tick += 1; socket.write(encode(FROM_GAME, 6, { tick })); }
        if (p.id === 6) socket.write(encode(FROM_GAME, 4));
        if (p.id === 10) { socket.write(encode(FROM_GAME, 3)); socket.write(encode(FROM_GAME, 10, { slot: 0, script: p.script1 })); }
        if (p.id === 100 || p.id === 101) socket.write(encode(FROM_GAME, 100, entity));
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, received, close: () => server.close(), get tick() { return tick; } }));
  });
}
