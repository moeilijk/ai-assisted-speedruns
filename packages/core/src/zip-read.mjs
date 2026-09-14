// Reading entries out of a zip (a jar is a zip), without dependencies: a game plugin reports which mod versions
// were actually loaded, and those sit in a file inside the jar; `aas check` checks the upload zip as it is
// uploaded. Store and deflate, no zip64.
import fs from "node:fs";
import zlib from "node:zlib";

/** Every file entry as `{ name, data }`, or null when the file is not a zip. */
export function readZipEntries(file, only = null) {
  const buf = fs.readFileSync(file);
  // End of central directory: the last 22 bytes when there is no comment, else search back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (!name.endsWith("/") && (only === null || name === only)) {
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const local = buf.readUInt32LE(p + 42);
      const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const body = buf.subarray(dataAt, dataAt + compSize);
      entries.push({ name, data: method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body) });
      if (only !== null) break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The entry's bytes, or null when the archive does not hold it. */
export function readZipEntry(file, name) {
  return readZipEntries(file, name)?.[0]?.data ?? null;
}
