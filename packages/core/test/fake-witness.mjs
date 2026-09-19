// A witness like the archive's, for tests: it checks the statement's signature, answers with its own clock and a
// receipt signed with its own key, and refuses a second start or end of a segment (409).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { publicInfo, publicKeyFromLine } from "../src/sign.mjs";
import { RECEIPT_KIND, STATEMENT_KINDS } from "../src/witness-receipt.mjs";

export async function startFakeWitness(dir, { registered = [] } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const { publicLine, fingerprint } = publicInfo(publicKey);
  const keysFile = join(dir, "aas-witness.txt");
  fs.writeFileSync(keysFile, `aas-witness-key v1\nkey: ${publicLine}\nfingerprint: ${fingerprint}\nsince: ${new Date().toISOString()}\n`);
  const statements = [];
  const done = new Set();
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      const fingerprint = new URL(req.url, "http://x").searchParams.get("fingerprint");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ fingerprint, registered: registered.includes(fingerprint) }));
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const reply = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const lines = body.split("\n");
      const value = (name) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
      const signed = lines.slice(0, -1).join("\n");
      let ok = false;
      try { ok = crypto.verify(null, Buffer.from(signed), publicKeyFromLine(value("key")), Buffer.from(value("signature") ?? "", "base64")); } catch { /* not valid */ }
      // Every kind the standard has had: a witness that only knows the newest one refuses the runs still on the older tooling.
      if (!STATEMENT_KINDS.includes(lines[0]) || !lines.at(-1).startsWith("signature: ")) return reply(400, { error: "not a statement" });
      if (!ok) return reply(401, { error: "the signature does not verify" });
      const id = `${value("run_uid")} ${value("segment")} ${value("phase")}`;
      if (done.has(id)) return reply(409, { error: "already witnessed" });
      done.add(id);
      statements.push(body);
      const receivedAt = new Date().toISOString();
      const sha = crypto.createHash("sha256").update(body, "utf8").digest("hex");
      const receipt = crypto.sign(null, Buffer.from(`${RECEIPT_KIND}\nstatement: ${sha}\nreceived: ${receivedAt}`), privateKey).toString("base64");
      reply(200, { received_at: receivedAt, statement_sha256: sha, site_key: publicLine, receipt });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/witness/`, keysFile, fingerprint, statements, close: () => new Promise((resolve) => server.close(resolve)) };
}
