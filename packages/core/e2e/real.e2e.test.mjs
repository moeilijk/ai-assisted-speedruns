// A mock run of every game with a scripted player through the real GUI on the real programs, driven the way a
// person drives it (Playwright, headless Chromium): the game, OBS and LiveSplit start, the run plays to the game's
// first end, the bundle is made and uploaded to the Archive's e2e account. Around each run it measures what a person
// would notice: the game's sound never on the speakers (only the quiet device, or no session), no error in the log,
// the game, OBS and LiveSplit closed afterwards. One game is also stopped mid-run and continued. The machine's own
// settings are copied first and must be unchanged at the end.
//
// `npm run e2e:real` on the machine the games are installed on (Windows programs, the harness in WSL), with
// Playwright installed (`npm i -g playwright`, then `npx playwright install chromium`) and the Archive's e2e account in
// .local/e2e-archive.mjs. AAS_E2E_GAMES chooses the games (default: every game that has a scripted player and is set
// up here). Not part of `npm test`: it takes minutes per game and needs the programs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const CLI = path.join(root, "packages", "core", "src", "cli.mjs");
const at = () => new Date().toTimeString().slice(0, 8);
const log = (t) => process.stdout.write(`# ${at()} ${t}\n`);

const playwright = (() => {
  try { return createRequire(import.meta.url)(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "playwright")); } catch { return null; }
})();
const { IS_WSL } = await import("../src/gui/windows-paths.mjs");
const onWindowsSide = process.platform === "win32" || IS_WSL;
const skip = !onWindowsSide ? "needs the Windows programs (WSL or Windows)" : !playwright ? "needs Playwright (npm i -g playwright; npx playwright install chromium)" : !fs.existsSync(path.join(root, ".local", "e2e-archive.mjs")) ? "needs the Archive's e2e account (.local/e2e-archive.mjs)" : false;

// The seeds a game's scripted player is proven to reach its first end on, in the real game: Balatro's mock wins ante 1
// on YLNKMKFJ (0.29.3, measured 2026-09-21); without a seed the game picks one, and the player may lose on it.
const PROVEN_SEEDS = { balatro: "YLNKMKFJ" };
const running = (exe) => { try { return execFileSync("tasklist.exe", ["/FI", `IMAGENAME eq ${exe}`, "/NH"], { encoding: "utf8" }).toLowerCase().includes(exe.toLowerCase()); } catch { return false; } };
const machineEnv = () => Object.fromEntries(fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
/** Where the game's sound goes now: the device of its audio session, "none", or null when it cannot be told. */
function soundOf(exe) {
  const env = { ...process.env, ...machineEnv() };
  try {
    const out = execFileSync(process.execPath, [path.join(root, "packages", "core", "src", "windows", "audio-route.mjs"), "--check", "--process", exe], { env, encoding: "utf8", timeout: 60000 });
    const m = new RegExp(`${exe.replace(".", "\\.")} active audio session on: (.*)$`, "m").exec(out);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

test("every game's mock through the real GUI: silent, bundled, uploaded, everything closed, settings unchanged", { skip, timeout: 4 * 3600000 }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aas-e2e-real-"));
  // The machine's settings, copied before anything runs and compared at the end.
  const keep = [".env", ".local/gui-checks.json"].filter((f) => fs.existsSync(path.join(root, f)));
  const games = path.join(root, ".local", "games");
  const snapshot = () => Object.fromEntries([...keep.map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]), ...(fs.existsSync(games) ? fs.readdirSync(games).map((f) => [`.local/games/${f}`, fs.readFileSync(path.join(games, f), "utf8")]) : [])]);
  const before = snapshot();
  const quiet = machineEnv().AAS_QUIET_AUDIO_DEVICE ?? null;
  const port = 8779;
  const env = { ...process.env, AAS_ARCHIVE_FETCH: path.join(root, ".local", "e2e-archive.mjs"), XDG_CONFIG_HOME: path.join(work, "config"), AAS_PROOF: "anonymous", AAS_GUI_NOTE: path.join(work, "gui.json"), AAS_GUI_CHECKS: path.join(work, "gui-checks.json") };
  if (fs.existsSync(path.join(root, ".local", "gui-checks.json"))) fs.copyFileSync(path.join(root, ".local", "gui-checks.json"), env.AAS_GUI_CHECKS);
  const gui = spawn(process.execPath, [CLI, "gui", "--port", String(port), "--no-open"], { cwd: root, env, stdio: "ignore" });
  const browser = await playwright.chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 1000 } })).newPage();
  page.on("dialog", (d) => d.accept());
  const msg = (id) => page.$eval(`#${id}`, (e) => `[${e.className.replace("feedback ", "")}] ${e.textContent}`);
  const settle = (id, ms = 600000) => page.waitForFunction((i) => !/busy/.test(document.getElementById(i).className) && document.getElementById(i).textContent, id, { timeout: ms });
  const phase = () => page.$eval("#phase .phase", (e) => e.textContent);
  const failures = [];
  try {
    for (let i = 0; i < 40; i += 1) { try { await page.goto(`http://127.0.0.1:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    await page.waitForSelector("#game option", { state: "attached" });
    await page.waitForSelector("#account button");
    await page.click('#account button[data-act="login"]');
    await settle("archivemsg", 60000);
    log(`sign in: ${await msg("archivemsg")}`);

    const offered = await page.$$eval("#game option", (o) => o.map((x) => x.value));
    const wanted = (process.env.AAS_E2E_GAMES ?? "").split(",").filter(Boolean);
    const list = [];
    for (const id of wanted.length ? wanted : offered) {
      const p = (await import(path.join(root, "games", id.replace(/_/g, "-"), "plugin.mjs"))).default;
      if (!p.setup?.bot) { log(`${id}: no scripted player, skipped`); continue; }
      list.push({ id, exe: p.processName, name: p.name });
    }

    for (const g of list) {
      log(`${g.name}: start`);
      await page.selectOption("#game", g.id);
      await page.waitForTimeout(300);
      await page.selectOption("#playedby", "scripted");
      await page.waitForTimeout(800);
      if (PROVEN_SEEDS[g.id]) { await page.fill("#seed", PROVEN_SEEDS[g.id]); await page.waitForTimeout(500); }
      const logLen = (await page.$$("#log > div")).length;
      await page.click("#start");
      let last = "";
      const sounds = new Set();
      for (let i = 0; i < 3600; i += 1) {
        const ph = await phase();
        if (ph !== last) { log(`${g.name}: ${ph}`); last = ph; }
        if (ph === "Running" && i % 10 === 0) { const s = soundOf(g.exe); if (s) sounds.add(s); }
        if (i > 3 && ph === "Ready") break;
        await page.waitForTimeout(1000);
      }
      const result = await page.$eval("#result", (e) => e.textContent);
      const lines = (await page.$$eval("#log > div", (d) => d.map((x) => `[${x.className}] ${x.textContent}`))).slice(logLen);
      const errors = lines.filter((l) => l.startsWith("[err]"));
      log(`${g.name}: ${result.slice(0, 140)}; sound on: ${[...sounds].join(", ") || "no session seen"}`);
      const onSpeakers = [...sounds].filter((s) => !s.startsWith("none") && !(quiet && s.includes(quiet)));
      if (onSpeakers.length) failures.push(`${g.name}: sound on ${onSpeakers.join(", ")}`);
      if (errors.length) failures.push(`${g.name}: ${errors.length} error line(s): ${errors.slice(0, 3).join(" | ")}`);
      if (!(PROVEN_SEEDS[g.id] ? /completed/ : /completed|stopped/).test(result)) failures.push(`${g.name}: session ${result.slice(0, 80)}`);
      const up = await page.$("#result button[data-upload]");
      if (!up) failures.push(`${g.name}: no bundle to upload`);
      else { await up.click(); await settle("runmsg"); const u = await msg("runmsg"); log(`${g.name}: upload ${u}`); if (!/uploaded: review/.test(u)) failures.push(`${g.name}: upload ${u}`); }
      for (const exe of [g.exe, "obs64.exe", "LiveSplit.exe"]) if (running(exe)) failures.push(`${g.name}: ${exe} still running after the session`);
    }

    // One game stopped mid-run and continued: one whose player takes many short steps, so a Stop lands mid-run
    // (AAS_E2E_STOP_GAME, default Balatro when it is in the list, else the first).
    const stopGame = list.find((x) => x.id === (process.env.AAS_E2E_STOP_GAME || "balatro")) ?? list[0];
    if (stopGame) {
      const g = stopGame;
      await page.selectOption("#game", g.id);
      await page.selectOption("#playedby", "scripted");
      await page.waitForTimeout(800);
      if (PROVEN_SEEDS[g.id]) { await page.fill("#seed", PROVEN_SEEDS[g.id]); await page.waitForTimeout(500); }
      await page.click("#start");
      for (let i = 0; i < 300 && (await phase()) !== "Running"; i += 1) await page.waitForTimeout(1000);
      await page.waitForTimeout(15000);
      await page.click("#stop");
      for (let i = 0; i < 900 && (await phase()) !== "Ready"; i += 1) await page.waitForTimeout(1000);
      await page.waitForTimeout(1500);
      const stopped = await page.$eval("#result", (e) => e.textContent);
      log(`${g.name}: after Stop: ${stopped.slice(0, 120)}`);
      const cont = await page.$("#result button[data-continue]");
      if (!cont) { if (!/completed/.test(stopped)) failures.push(`${g.name}: no Continue after Stop (${stopped.slice(0, 80)})`); }
      else {
        await cont.click();
        for (let i = 0; i < 5; i += 1) await page.waitForTimeout(1000);
        for (let i = 0; i < 3600 && (await phase()) !== "Ready"; i += 1) await page.waitForTimeout(1000);
        const done = await page.$eval("#result", (e) => e.textContent);
        log(`${g.name}: after Continue: ${done.slice(0, 120)}`);
        if (!/completed|stopped/.test(done)) failures.push(`${g.name}: Continue ended as ${done.slice(0, 80)}`);
      }
      for (const exe of [g.exe, "obs64.exe", "LiveSplit.exe"]) if (running(exe)) failures.push(`${g.name}: ${exe} still running after Continue`);
    }

    await page.click('#account button[data-act="logout"]');
    await settle("archivemsg", 60000);
  } finally {
    await browser.close();
    gui.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const { archiveFetch } = await import(path.join(root, ".local", "e2e-archive.mjs"));
      const { proofUrl } = await import("../src/proof.mjs");
      const w = await archiveFetch(`${proofUrl()}/api/v1/e2e/`, { method: "DELETE", headers: { Accept: "application/json" } });
      log(`e2e account wiped: ${JSON.stringify((await w.json()).removed)}`);
    } catch (e) { log(`wipe failed: ${e.message}`); }
  }
  const after = snapshot();
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "no settings file appeared or went missing");
  for (const f of Object.keys(before)) if (f !== ".local/gui-checks.json") assert.equal(after[f], before[f], `${f} is unchanged`);
  assert.deepEqual(failures, [], failures.join("\n"));
});
