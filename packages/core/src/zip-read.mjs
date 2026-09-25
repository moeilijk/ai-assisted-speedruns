// Reading entries out of a zip (a jar is a zip), without dependencies: a game plugin reports which mod versions
// were actually loaded, and those sit in a file inside the jar; `aas check` checks the upload zip as it is
// uploaded. Store and deflate, no zip64.
import fs from "node:fs";
import zlib from "node:zlib";
import { crc32 } from "./zip.mjs";

// Limits for a zip that comes from elsewhere (an upload, a mod's jar): a bundle is a few files of logs and text.
export const ZIP_LIMITS = { entries: 10000, entryBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3 };

/**
 * Every file entry as `{ name, data }`, or null when the file is not a zip at all. A zip that is broken or built to
 * harm (offsets outside the file, an unknown method, a name twice, more data than it declares: a zip bomb) throws,
 * with the reason.
 */
export function readZipEntries(file, only = null, limits = ZIP_LIMITS) {
  const buf = fs.readFileSync(file);
  const bad = (why) => { throw new Error(`${file} is not a zip that can be read safely: ${why}`); };
  const u16 = (at) => (at + 2 <= buf.length ? buf.readUInt16LE(at) : bad(`a header runs past the end of the file (offset ${at})`));
  const u32 = (at) => (at + 4 <= buf.length ? buf.readUInt32LE(at) : bad(`a header runs past the end of the file (offset ${at})`));
  // End of central directory: the last 22 bytes when there is no comment, else search back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = u16(eocd + 10);
  if (count > limits.entries) bad(`${count} entries, more than ${limits.entries}`);
  let p = u32(eocd + 16);
  const entries = [];
  const seen = new Set();
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (u32(p) !== 0x02014b50) bad(`entry ${i + 1} has no central directory header`);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    if (p + 46 + nameLen > buf.length) bad(`the name of entry ${i + 1} runs past the end of the file`);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (seen.has(name)) bad(`${JSON.stringify(name)} is in it twice`);
    seen.add(name);
    if (!name.endsWith("/") && (only === null || name === only)) {
      const method = u16(p + 10);
      const compSize = u32(p + 20);
      const size = u32(p + 24);
      if (size > limits.entryBytes) bad(`${JSON.stringify(name)} declares ${size} bytes, more than ${limits.entryBytes}`);
      total += size;
      if (total > limits.totalBytes) bad(`the entries declare more than ${limits.totalBytes} bytes together`);
      const local = u32(p + 42);
      if (u32(local) !== 0x04034b50) bad(`${JSON.stringify(name)} points at no local header`);
      const dataAt = local + 30 + u16(local + 26) + u16(local + 28);
      if (dataAt + compSize > buf.length) bad(`the data of ${JSON.stringify(name)} runs past the end of the file`);
      const body = buf.subarray(dataAt, dataAt + compSize);
      let data;
      if (method === 0) data = Buffer.from(body);
      else if (method === 8) {
        // Never more than it declares: a zip bomb stops here instead of filling the memory.
        try { data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }); } catch (e) { bad(`${JSON.stringify(name)} does not inflate to its declared ${size} bytes (${e.code ?? e.message})`); }
      } else bad(`${JSON.stringify(name)} uses compression method ${method}; only store and deflate are read`);
      if (data.length !== size) bad(`${JSON.stringify(name)} holds ${data.length} bytes but declares ${size}`);
      // The checksum the zip gives each file: other tools refuse a zip whose files do not match it.
      if ((crc32(data) >>> 0) !== u32(p + 16)) bad(`${JSON.stringify(name)}: its CRC-32 does not match its data`);
      entries.push({ name, data });
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
