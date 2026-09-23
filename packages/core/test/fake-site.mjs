// An archive like ai-assisted-speedruns.org, for tests: tickets and head receipts signed with its own key, the
// same answers as the live site (409 for a fork, 404 for an unknown ticket or the wrong secret), and the OAuth
// endpoints of `aas login` (authorization code with PKCE, a refresh token that rotates on every use).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { publicInfo } from "../src/sign.mjs";
import { receiptMessage, ticketMessage } from "../src/proof.mjs";

const hex = (n) => crypto.randomBytes(n).toString("hex");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function startFakeSite(dir, { down = false } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const { publicLine, fingerprint } = publicInfo(publicKey);
  const keysFile = join(dir, "aas-proof.txt");
  fs.writeFileSync(keysFile, `aas-proof-key v1\nkey: ${publicLine}\nfingerprint: ${fingerprint}\n`);
  const sign = (text) => crypto.sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");
  const tickets = new Map(); // ticket → { control, account, heads: Map(seq → receipt), state }
  const codes = new Map(); // oauth code → { challenge, redirect }
  const tokens = new Map(); // access token → account
  const refreshTokens = new Map(); // refresh token → account
  const site = { down, tickets, requests: [], forks: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const reply = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const url = new URL(req.url, "http://x");
      site.requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization ?? null, body });
      if (site.down) return reply(503, { error: "down" });
      const auth = req.headers.authorization ?? "";
      const account = auth.startsWith("Bearer ") ? tokens.get(auth.slice(7)) ?? false : null;
      if (req.method === "POST" && url.pathname === "/api/v1/tickets") {
        if (account === false) return reply(401, { error: "invalid token" });
        const t = { ticket: hex(16), control: hex(16), issued_at: new Date().toISOString(), account: Boolean(account) };
        t.expires_at = new Date(Date.now() + (account ? 90 : 60) * 86400000).toISOString();
        t.signature = sign(ticketMessage(t));
        tickets.set(t.ticket, { ...t, owner: account ?? null, heads: new Map(), state: "open" });
        return reply(200, t);
      }
      const m = url.pathname.match(/^\/api\/v1\/tickets\/([0-9a-f]{32})(?:\/(heads|extend|revoke))?$/);
      if (m) {
        const t = tickets.get(m[1]);
        const allowed = t && ((account && t.owner === account) || auth === `Ticket ${t.control}`);
        if (!allowed) return reply(404, { error: "no such ticket for you" });
        if (m[2] === "heads" && req.method === "POST") {
          if (t.state !== "open") return reply(409, { error: `ticket ${t.state}` });
          const b = JSON.parse(body);
          const have = t.heads.get(b.seq);
          if (have && have.head !== b.head) { site.forks += 1; return reply(409, { error: "this seq already has another head" }); }
          if (have) return reply(200, have);
          const r = { ticket: t.ticket, seq: b.seq, kind: b.kind, segment: b.segment, head: b.head, received_at: new Date().toISOString() };
          r.signature = sign(receiptMessage(r));
          t.heads.set(b.seq, r);
          return reply(200, r);
        }
        if (m[2] === "extend") { t.expires_at = new Date(Date.parse(t.expires_at) + 30 * 86400000).toISOString(); return reply(200, { ticket: t.ticket, expires_at: t.expires_at }); }
        if (m[2] === "revoke") { t.state = "revoked"; return reply(200, { ticket: t.ticket, revoked: true }); }
        if (!m[2] && req.method === "DELETE") { tickets.delete(t.ticket); return reply(200, { ticket: t.ticket, deleted: true }); }
      }
      if (url.pathname === "/auth/oauth/authorize") {
        // The person signs in and allows the tooling: here that is always yes, for account "tester".
        if (url.searchParams.get("code_challenge_method") !== "S256") return reply(400, { error: "S256 required" });
        const code = hex(16);
        codes.set(code, { challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri") });
        res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
        return res.end();
      }
      if (url.pathname === "/auth/oauth/token" && req.method === "POST") {
        const f = new URLSearchParams(body);
        const issue = (who) => { const a = hex(16), r = hex(16); tokens.set(a, who); refreshTokens.set(r, who); return reply(200, { access_token: a, token_type: "Bearer", expires_in: 3600, refresh_token: r, scope: "tickets bundles" }); };
        if (f.get("grant_type") === "authorization_code") {
          const c = codes.get(f.get("code"));
          codes.delete(f.get("code"));
          if (!c || c.redirect !== f.get("redirect_uri") || b64url(crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest()) !== c.challenge) return reply(400, { error: "invalid_grant" });
          return issue("tester");
        }
        if (f.get("grant_type") === "refresh_token") {
          const who = refreshTokens.get(f.get("refresh_token"));
          refreshTokens.delete(f.get("refresh_token"));
          return who ? issue(who) : reply(400, { error: "invalid_grant" });
        }
      }
      if (url.pathname === "/auth/oauth/revoke") { refreshTokens.delete(new URLSearchParams(body).get("token")); return reply(200, {}); }
      reply(404, { error: "not found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  site.url = `http://127.0.0.1:${server.address().port}`;
  site.keysFile = keysFile;
  site.fingerprint = fingerprint;
  let closing = null;
  site.close = () => (closing ??= new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return site;
}
