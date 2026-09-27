// End to end against the live Archive: `aas login` the way a person does it, in a browser. Headless Chromium opens
// the authorize page the tooling built, signs in on the Archive's own /signin/ page with the e2e account's password,
// answers the Allow page, and the Archive sends the code to the loopback port the tooling listens on; the tooling
// exchanges it for tokens. Those tokens then serve `aas tickets` and `aas upload` from the command line, and
// `aas logout` removes them. What the e2e account uploads is a test for the Archive: hidden, never listed, wiped here
// at the end through the e2e key. Part of `npm run e2e:chain`; skipped without the password file
// (~/.config/aas/e2e-login.json: archive, email, password; the Archive's own script sets it), the e2e key
// (.local/e2e-archive.mjs) or Playwright. The credentials of this run go to a temporary XDG_CONFIG_HOME, never to
// the machine's own ~/.config/aas/credentials.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const loginFile = path.join(os.homedir(), ".config", "aas", "e2e-login.json");
const hook = path.join(root, ".local", "e2e-archive.mjs");
const playwright = (() => { try { return createRequire(import.meta.url)(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "playwright")); } catch { return null; } })();
const skip = !fs.existsSync(loginFile) ? "no ~/.config/aas/e2e-login.json: the e2e account's password is not on this machine"
  : !fs.existsSync(hook) ? "no .local/e2e-archive.mjs: the e2e key that wipes the account is not here"
  : !playwright ? "Playwright is not installed globally (npm i -g playwright; npx playwright install chromium)" : false;
const log = (t) => process.stderr.write(`# ${new Date().toTimeString().slice(0, 8)} ${t}\n`);

test("aas login walks the Archive's real sign-in and Allow pages in a browser; the tokens then serve aas tickets and aas upload", { skip, timeout: 300000 }, async () => {
  const creds = JSON.parse(fs.readFileSync(loginFile, "utf8"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aas-login-e2e-"));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(work, "config");
  const env = { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const { archiveFetch } = await import(pathToFileURL(hook).href);
  const wipe = async () => { const r = await archiveFetch(`${creds.archive}/api/v1/e2e/`, { method: "DELETE" }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const browser = await playwright.chromium.launch();
  try {
    const { credentialsFile, login, logout, readCredentials } = await import(pathToFileURL(path.join(root, "packages", "core", "src", "auth.mjs")).href);
    const pages = [];
    // The browser: the person signs in on the Archive's page and allows the tooling; the Archive then sends the
    // browser to the loopback address the tooling gave, with the code.
    const open = async (url) => {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      pages.push(`landed on ${page.url().replace(/\?.*/, "")}`);
      assert.match(page.url(), /\/signin\//, "without a session the authorize page sends the browser to the Archive's sign-in page");
      const form = page.locator('form:has(input[name="email"]):has(input[name="password"])').first();
      await form.locator('input[name="email"]').fill(creds.email);
      await form.locator('input[name="password"]').fill(creds.password);
      await Promise.all([page.waitForURL(/\/auth\/oauth\/authorize\//, { timeout: 30000 }), form.locator('input[name="password"]').press("Enter")]);
      pages.push(`signed in, on ${page.url().replace(/\?.*/, "")}`);
      const allow = page.locator('[name="answer"][value="allow"]').first();
      await Promise.all([page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/callback/, { timeout: 30000 }), allow.click()]);
      pages.push(`allowed, sent to ${page.url().replace(/\?.*/, "")}`);
    };
    const c = await login({ baseUrl: creds.archive, open, log: () => {} });
    log(pages.join("; "));
    assert.ok(c?.access_token && c?.refresh_token, "tokens came back through the code exchange");
    assert.ok(fs.existsSync(credentialsFile()) && credentialsFile().startsWith(work), `the credentials live in the test's own config dir (${credentialsFile()})`);
    assert.equal(readCredentials()?.access_token, c.access_token);

    // The command line with those tokens.
    const cli = (...args) => spawnSync("node", [path.join(root, "packages", "core", "src", "cli.mjs"), ...args], { encoding: "utf8", env, cwd: root, timeout: 120000 });
    let r = cli("tickets");
    assert.equal(r.status, 0, `aas tickets: ${r.stderr}`);
    log(`aas tickets: ${(r.stdout.trim().split("\n")[0] || "").slice(0, 120)}`);
    r = cli("upload", path.join(root, "packages", "spec", "fixtures", "mock.zip"));
    assert.equal(r.status, 0, `aas upload: ${r.stderr}`);
    assert.match(r.stdout, /^uploaded: review/m, `the mock fixture is taken in for review under the e2e account, as the verdict table says: ${r.stdout}`);
    log(`aas upload: ${r.stdout.trim().split("\n")[0].slice(0, 160)}`);

    await logout();
    assert.ok(!fs.existsSync(credentialsFile()), "logout removed the credentials");
    r = cli("upload", path.join(root, "packages", "spec", "fixtures", "mock.zip"));
    assert.notEqual(r.status, 0, "signed out, aas upload refuses");
    assert.match(`${r.stdout}${r.stderr}`, /aas login/, `the refusal names the way in: ${r.stdout}${r.stderr}`);
  } finally {
    await browser.close();
    const w = await wipe();
    log(`wiped: ${w.status} ${JSON.stringify(w.json?.removed ?? w.json)}`);
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(work, { recursive: true, force: true });
  }
});
