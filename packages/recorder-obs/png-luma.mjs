// Mean brightness of a PNG, for judging whether a capture source shows anything. OBS's GetSourceScreenshot
// returns an 8-bit, non-interlaced PNG (RGB or RGBA); that is all this decodes: the IHDR, the IDAT stream
// inflated with zlib, the five scanline filters undone, then the mean of the colour channels (0 = black,
// 255 = white). Anything else (16-bit, palette, interlaced) is refused rather than misjudged.
import zlib from "node:zlib";

export function pngMeanLuma(png) {
  const buf = Buffer.isBuffer(png) ? png : Buffer.from(png, "base64");
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) throw new Error(`PNG ${width}x${height} depth ${depth} colour type ${colorType} interlace ${interlace}: only 8-bit RGB/RGBA non-interlaced is read`);
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  let sum = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let x = line[i];
      switch (filter) {
        case 0: break;
        case 1: x += a; break;
        case 2: x += b; break;
        case 3: x += (a + b) >> 1; break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; }
        default: throw new Error(`PNG filter ${filter}`);
      }
      line[i] = x & 0xff;
      if (i % channels < 3) sum += line[i];
    }
    prev = line;
  }
  return sum / (width * height * 3);
}
