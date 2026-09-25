// `aas login` / `aas logout`: the tooling signs in to the archive the way Claude Code signs in to Anthropic.
// The browser opens the archive's own page, the person signs in and allows the tooling there, and the archive sends a
// one-time code back to a port on 127.0.0.1 that only this process listens on. The tooling exchanges that code for an
// access token and a refresh token (OAuth 2.0 authorization code with PKCE, RFC 7636, loopback redirect, RFC 8252).
// A password never passes through the tooling. The tokens are kept in a file only this user can read; the archive
// rotates the refresh token on every use, so the newest one is always written back.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { proofUrl } from "./proof.mjs";

export const CLIENT_ID = "aas-tooling";
export const credentialsFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "aas", "credentials.json");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const readCredentials = () => { try { return JSON.parse(fs.readFileSync(credentialsFile(), "utf8")); } catch { return null; } };
function writeCredentials(c) {
  fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credentialsFile(), `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(credentialsFile(), 0o600);
}

const isWsl = () => process.platform === "linux" && /microsoft/i.test(os.release());
/** Opens a URL in the person's browser; under WSL and Windows without a shell that would split it on `&`. */
export function openBrowser(url) {
  if (isWsl() || process.platform === "win32") spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function tokenRequest(form, { baseUrl, fetchImpl, timeoutMs = 15000 }) {
  const res = await fetchImpl(`${baseUrl}/auth/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ client_id: CLIENT_ID, ...form }).toString(), signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`the Archive refused the token request (${res.status}${json.error ? `: ${json.error}` : ""})`);
  return json;
}
const store = (json, baseUrl) => {
  const now = Date.now();
  const c = { archive: baseUrl, access_token: json.access_token, refresh_token: json.refresh_token ?? null, expires_at: new Date(now + (Number(json.expires_in) || 3600) * 1000).toISOString(), scope: json.scope ?? null, updated_at: new Date(now).toISOString() };
  writeCredentials(c);
  return c;
};

/**
 * Signs in: opens the archive's authorize page and waits for the code on the loopback. `open` is how the page is
 * opened (the browser by default; the tests follow the redirect themselves). Resolves with the stored credentials.
 */
export async function login({ baseUrl = proofUrl(), fetchImpl = fetch, open = openBrowser, log = console.log, timeoutMs = 300000 } = {}) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const url = `${baseUrl}/auth/oauth/authorize/?${new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state })}`;
  let fail = () => {};
  const code = new Promise((resolve, reject) => {
    fail = reject;
    const timer = setTimeout(() => reject(new Error("no answer from the browser within 5 minutes")), timeoutMs);
    server.on("request", (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" }).end(ok ? "Signed in. You can close this tab and go back to AAS." : "This sign-in did not come from this AAS. Nothing was stored.");
      if (!ok) return;
      clearTimeout(timer);
      resolve(u.searchParams.get("code"));
    });
  });
  log(`Opening ${baseUrl} in your browser to sign in. If it does not open, go to:\n${url}`);
  // An opener that fails (no browser, or an answer that does not lead back here) ends the sign-in with its reason.
  Promise.resolve().then(() => open(url)).catch((e) => fail(e));
  try {
    const got = await code;
    return store(await tokenRequest({ grant_type: "authorization_code", code: got, redirect_uri: redirect, code_verifier: verifier }, { baseUrl, fetchImpl }), baseUrl);
  } finally {
    server.close();
  }
}

/** A valid access token, refreshed when it is about to expire; null when this machine is not signed in. */
export async function accessToken({ fetchImpl = fetch } = {}) {
  const c = readCredentials();
  if (!c?.access_token) return null;
  if (Date.parse(c.expires_at) - Date.now() > 60000) return c.access_token;
  if (!c.refresh_token) return null;
  return store(await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refresh_token }, { baseUrl: c.archive ?? proofUrl(), fetchImpl }), c.archive ?? proofUrl()).access_token;
}

export const loggedIn = async () => Boolean(readCredentials()?.access_token);

/** Signs out: the archive revokes the refresh token and this machine forgets both tokens. */
export async function logout({ fetchImpl = fetch } = {}) {
  const c = readCredentials();
  if (!c) return false;
  try {
    await fetchImpl(`${c.archive ?? proofUrl()}/auth/oauth/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, token: c.refresh_token ?? c.access_token }).toString(), signal: AbortSignal.timeout(15000) });
  } catch { /* forgotten here either way */ }
  fs.rmSync(credentialsFile(), { force: true });
  return true;
}
