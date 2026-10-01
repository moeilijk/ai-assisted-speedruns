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
/**
 * The page the browser lands on after the Archive sent it back to the loopback: what happened, and what to do now.
 * Laid out like the Archive's pages (its colours in light and dark, its header with the clock mark), so the tab reads
 * as part of the same thing; the fonts fall back to the system's, since a page on 127.0.0.1 cannot load the site's.
 */
export function callbackPage({ ok, baseUrl = proofUrl() } = {}) {
  const host = (() => { try { return new URL(baseUrl).host; } catch { return String(baseUrl); } })();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const title = ok ? "Signed in" : "Not signed in";
  const body = ok
    ? `<p class="sub">AAS on this computer is now signed in to the Archive at <b>${esc(host)}</b>. You can close this tab: the sign-in went back to the terminal or the GUI you started it from.</p>
  <ul class="meta">
    <li>Runs on this computer record their proof under your account.</li>
    <li><code>aas upload</code> and the GUI's Upload send bundles under it.</li>
    <li><code>aas logout</code> ends it; the tokens live only in your own config folder.</li>
  </ul>
  <p class="meta"><a href="${esc(baseUrl)}/account/">Your account at the Archive</a></p>`
    : `<p class="sub">This answer did not come from the sign-in that this AAS started (its state does not match), so nothing was stored.</p>
  <ul class="meta">
    <li>Close this tab.</li>
    <li>Run <code>aas login</code> again, or press Sign in in the GUI, and use the tab it opens.</li>
  </ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · AAS</title>
<style>
:root { --ink: #131a20; --ink-2: #4e5a64; --ink-3: #75828c; --surface: #ffffff; --line: #d6dcda; --accent: #2446c4; --good: #16794a; --bad: #c2410c; --rta: #66727f; --igt: #12925d;
  --font-display: "Barlow SC", "Barlow Semi Condensed", "Arial Narrow", system-ui, sans-serif; --font-ui: "Plex Sans", "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --font-mono: "Plex Mono", "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root { --ink: #e5eaec; --ink-2: #a3aeb6; --ink-3: #7b8790; --surface: #141a20; --line: #26303a; --accent: #86a0ff; --good: #4fd394; --bad: #e0703a; --rta: #93a0ad; --igt: #35c98a; } }
html { -webkit-text-size-adjust: 100%; } body { margin: 0; background: var(--surface); color: var(--ink); font: 400 1rem/1.5 var(--font-ui); }
.site-header { border-bottom: 1px solid var(--line); } .site-header .wrap { display: flex; align-items: center; gap: 10px; min-height: 60px; padding: 0 clamp(16px, 3vw, 32px); }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); font: 700 1.375rem/1 var(--font-display); letter-spacing: 0.01em; text-decoration: none; }
.brand-mark { width: 26px; height: 26px; } .brand-mark .ring { fill: none; stroke: var(--ink); stroke-width: 2.2; } .brand-mark line { stroke-width: 2.4; stroke-linecap: round; } .brand-mark .hand-rta { stroke: var(--rta); } .brand-mark .hand-igt { stroke: var(--igt); }
.brand small { font: 500 0.75rem/1 var(--font-ui); color: var(--ink-3); letter-spacing: 0.06em; text-transform: uppercase; }
main { max-width: 1000px; padding: 26px clamp(16px, 3vw, 32px) 40px; } .page-head { display: flex; flex-direction: column; gap: 10px; }
h1 { margin: 0; font: 700 2.2rem/1.05 var(--font-display); letter-spacing: -0.005em; } h1.ok { color: var(--good); } h1.bad { color: var(--bad); }
.sub { margin: 0; color: var(--ink-2); font-size: 1.125rem; max-width: 62ch; } .meta { margin: 14px 0 0; padding-left: 1.2em; color: var(--ink-2); max-width: 62ch; } .meta li { margin: 4px 0; }
code { font: 0.95em var(--font-mono); } a { color: var(--accent); }
</style></head>
<body>
<header class="site-header"><div class="wrap"><span class="brand"><svg class="brand-mark" viewBox="0 0 26 26" aria-hidden="true"><circle class="ring" cx="13" cy="13" r="11"></circle><line class="hand-rta" x1="13" y1="13" x2="13" y2="4.5"></line><line class="hand-igt" x1="13" y1="13" x2="18.5" y2="16"></line></svg>AAS <small>tooling</small></span></div></header>
<main><header class="page-head"><h1 class="${ok ? "ok" : "bad"}">${title}</h1>
  ${body}
</header></main>
</body></html>
`;
}

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
  let timer;
  const code = new Promise((resolve, reject) => {
    fail = reject;
    timer = setTimeout(() => reject(new Error("no answer from the browser within 5 minutes")), timeoutMs);
    server.on("request", (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" }).end(callbackPage({ ok: Boolean(ok), baseUrl }));
      if (!ok) return;
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
    // Also when the opener failed: the 5-minute wait would otherwise keep the command, and the GUI button, busy.
    clearTimeout(timer);
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
