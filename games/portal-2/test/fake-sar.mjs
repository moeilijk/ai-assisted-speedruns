// A stand-in for SourceAutoRecord's TAS protocol server: it speaks the protocol of docs/tas_proto.txt and nothing
// else. It exists so the controller can be tested without Portal 2: it sends packet 255 first, answers an entity
// info request, counts ticks, and records what the controller sent.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { decode, encode, FROM_GAME, TO_GAME } from "../sar-protocol.mjs";

// With `gameRoot`, a script that saves (`save <name>`) makes the engine's file, portal2/SAVE/<name>.sav, holding the map
// it was made on, and a script that starts on a map or a save prints the engine's `Loading map "<map>"` to
// portal2/console.log, as the game started with -condebug does.
export function startFakeSar({ location = "portal2/maps/sp_a1_intro1", entity = { state: 1, position: [1, 2, 3], angles: [0, 90, 0], velocity: [0, 0, 0] }, gameRoot = null } = {}) {
  const received = [];
  let tick = 0;
  let map = location.split("/").pop().replace(/\.bsp$/, "");
  const loading = (m) => { map = m; if (gameRoot) { fs.mkdirSync(path.join(gameRoot, "portal2"), { recursive: true }); fs.appendFileSync(path.join(gameRoot, "portal2", "console.log"), `Loading map "${m}"\n`); } };
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
        if (p.id === 10) {
          const saved = /\|save ([A-Za-z0-9_-]+)\|/.exec(p.script1 ?? "");
          if (saved && gameRoot) { fs.mkdirSync(path.join(gameRoot, "portal2", "SAVE"), { recursive: true }); fs.writeFileSync(path.join(gameRoot, "portal2", "SAVE", `${saved[1]}.sav`), JSON.stringify({ map })); }
          const startMap = /^start map ([a-z0-9_]+)/m.exec(p.script1 ?? "");
          if (startMap) loading(startMap[1]);
          const startSave = /^start save ([A-Za-z0-9_-]+)/m.exec(p.script1 ?? "");
          if (startSave && gameRoot) { try { loading(JSON.parse(fs.readFileSync(path.join(gameRoot, "portal2", "SAVE", `${startSave[1]}.sav`), "utf8")).map); } catch { /* no such save */ } }
          socket.write(encode(FROM_GAME, 3)); socket.write(encode(FROM_GAME, 10, { slot: 0, script: p.script1 }));
        }
        if (p.id === 100 || p.id === 101) socket.write(encode(FROM_GAME, 100, entity));
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, received, close: () => server.close(), get tick() { return tick; } }));
  });
}
