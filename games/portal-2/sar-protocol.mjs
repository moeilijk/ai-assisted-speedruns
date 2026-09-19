// The TAS protocol of SourceAutoRecord (p2sr/SourceAutoRecord, docs/tas_proto.txt), as SAR speaks it on TCP 6555
// after `sar_tas_protocol_server`. Both directions, so a test can play either side.
//
// Framing: none. A packet is one byte of id followed by its fields, back to back on the stream; the reader must know
// the layout of every id to find the next packet. Numbers are little-endian (x86); a string is a u32 byte length
// followed by its UTF-8 bytes. The game sends packet 255 ("set game location") once, first, and never again.
//
// Nothing here talks to a game: it is the encoding, and it is what the tests exercise.

/** Player → controller. The layout of each id, in order; `str` is u32 length + bytes. */
export const FROM_GAME = {
  0: { name: "set active", fields: [["script1", "str"], ["script2", "str"]] },
  1: { name: "set inactive", fields: [] },
  2: { name: "playback rate", fields: [["rate", "f32"]] },
  3: { name: "playing", fields: [] },
  4: { name: "paused", fields: [] },
  5: { name: "fast-forwarding", fields: [] },
  6: { name: "current tick", fields: [["tick", "u32"]] },
  7: { name: "debug tick", fields: [["tick", "i32"]] },
  10: { name: "processed script", fields: [["slot", "u8"], ["script", "str"]] },
  100: { name: "entity info", fields: [["state", "u8"], ["position", "f32x3"], ["angles", "f32x3"], ["velocity", "f32x3"]] },
  255: { name: "game location", fields: [["location", "str"]] },
};

/** Controller → player. */
export const TO_GAME = {
  0: { name: "play files", fields: [["script1", "str"], ["script2", "str"]] },
  1: { name: "stop", fields: [] },
  2: { name: "set rate", fields: [["rate", "f32"]] },
  3: { name: "play", fields: [] },
  4: { name: "pause", fields: [] },
  5: { name: "fast forward", fields: [["tick", "u32"], ["pauseAfter", "u8"]] },
  6: { name: "pause at tick", fields: [["tick", "u32"]] },
  7: { name: "advance tick", fields: [] },
  10: { name: "play scripts", fields: [["script1name", "str"], ["script1", "str"], ["script2name", "str"], ["script2", "str"]] },
  100: { name: "entity info", fields: [["selector", "str"]] },
  101: { name: "entity info continuous", fields: [["selector", "str"]] },
};

const SIZE = { u8: 1, u32: 4, i32: 4, f32: 4, f32x3: 12 };

const write = (type, value) => {
  if (type === "str") {
    const body = Buffer.from(String(value ?? ""), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
  }
  const b = Buffer.alloc(SIZE[type]);
  if (type === "u8") b.writeUInt8(Number(value) & 0xff, 0);
  else if (type === "u32") b.writeUInt32LE(Number(value) >>> 0, 0);
  else if (type === "i32") b.writeInt32LE(Number(value) | 0, 0);
  else if (type === "f32") b.writeFloatLE(Number(value), 0);
  else if (type === "f32x3") for (let i = 0; i < 3; i += 1) b.writeFloatLE(Number(value?.[i] ?? 0), i * 4);
  else throw new Error(`unknown field type ${type}`);
  return b;
};

/** One packet, ready for the socket. `values` is keyed by the field names of that id. */
export function encode(table, id, values = {}) {
  const spec = table[id];
  if (!spec) throw new Error(`unknown packet id ${id}`);
  return Buffer.concat([Buffer.from([id]), ...spec.fields.map(([name, type]) => write(type, values[name]))]);
}

/**
 * Reads whole packets off the front of a buffer. Returns the packets it could read and the bytes that are left,
 * because TCP hands over as much as it happens to have.
 */
export function decode(table, buffer) {
  const packets = [];
  let at = 0;
  while (at < buffer.length) {
    const id = buffer[at];
    const spec = table[id];
    if (!spec) throw new Error(`unknown packet id ${id}`);
    let p = at + 1;
    const values = {};
    let short = false;
    for (const [name, type] of spec.fields) {
      if (type === "str") {
        if (p + 4 > buffer.length) { short = true; break; }
        const len = buffer.readUInt32LE(p);
        if (p + 4 + len > buffer.length) { short = true; break; }
        values[name] = buffer.toString("utf8", p + 4, p + 4 + len);
        p += 4 + len;
        continue;
      }
      if (p + SIZE[type] > buffer.length) { short = true; break; }
      if (type === "u8") values[name] = buffer.readUInt8(p);
      else if (type === "u32") values[name] = buffer.readUInt32LE(p);
      else if (type === "i32") values[name] = buffer.readInt32LE(p);
      else if (type === "f32") values[name] = buffer.readFloatLE(p);
      else if (type === "f32x3") values[name] = [0, 1, 2].map((i) => buffer.readFloatLE(p + i * 4));
      p += SIZE[type];
    }
    if (short) break;
    packets.push({ id, name: spec.name, ...values });
    at = p;
  }
  return { packets, rest: buffer.subarray(at) };
}
