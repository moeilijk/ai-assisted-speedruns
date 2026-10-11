// An environment variable of Windows, read from WSL. Under WSL that is a `cmd.exe /c echo %VAR%` call, and that call
// can come back empty while Windows is perfectly able to answer it: the interop between WSL and Windows times out
// under load (measured 2026-10-11 during `npm run e2e:real`: `<3>WSL (…) ERROR: UtilAcceptVsock:271: accept4 failed
// 110`, while the same call on its own answers in 40 ms). An empty answer is a failed call, not an answer, so it is
// asked again before the value is called unknown; and only an answer is remembered, so one hiccup does not leave a
// whole run without the folder of its emulator.
import { spawnSync } from "node:child_process";
import os from "node:os";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const isWsl = () => process.platform === "linux" && /microsoft/i.test(os.release());

const answers = new Map();

/**
 * The value of a Windows environment variable, as Windows writes it (`C:\Users\…`), or null when Windows does not
 * have it. On Windows itself it is this process's own environment.
 * @param {string} name without the percent signs, e.g. "LOCALAPPDATA"
 * @param {{tries?: number, waitMs?: number, log?: (line: string) => void}} [opts]
 */
export function winEnv(name, { tries = 4, waitMs = 250, log = () => {} } = {}) {
  if (process.platform === "win32") return process.env[name] ?? null;
  if (!isWsl()) return null;
  if (answers.has(name)) return answers.get(name);
  let last = "";
  for (let i = 1; i <= tries; i += 1) {
    const r = spawnSync("cmd.exe", ["/c", `echo %${name}%`], { encoding: "utf8", cwd: "/mnt/c", timeout: 20000 });
    const out = (r.stdout ?? "").trim();
    if (out && !out.includes("%")) {
      answers.set(name, out);
      if (i > 1) log(`%${name}% came back on attempt ${i} of ${tries}`);
      return out;
    }
    // `%NAME%` echoed back is Windows answering that it has no such variable; that is an answer, not a failed call.
    if (out === `%${name}%`) { answers.set(name, null); return null; }
    last = r.error ? r.error.message : `exit ${r.status}, stdout ${JSON.stringify(out)}, stderr ${JSON.stringify((r.stderr ?? "").trim().slice(0, 200))}`;
    log(`%${name}% did not answer (attempt ${i} of ${tries}): ${last}`);
    if (i < tries) sleep(waitMs);
  }
  return null; // Not remembered: the next caller asks Windows again rather than inherit this failure.
}

/** The same variable as a path on this side: %LOCALAPPDATA% → /mnt/c/Users/…, or null when Windows does not have it. */
export function winEnvPath(name, opts) {
  const win = winEnv(name, opts);
  if (!win) return null;
  if (process.platform === "win32") return win;
  return (spawnSync("wslpath", ["-u", win], { encoding: "utf8" }).stdout ?? "").trim() || null;
}

/** The interop between WSL and Windows failing: the program never ran, so the call can be made again. */
const interopFailed = (r) => Boolean(r.error) || r.status === null || (r.status !== 0 && /UtilAcceptVsock|accept4 failed|CreateProcessEntryCommon|<3>WSL|wsl\/service/i.test(`${r.stderr ?? ""}`));

/**
 * A Windows program called for an answer, e.g. `powershell.exe -NoProfile -Command …`. A call that never
 * reached Windows is made again (measured 2026-10-11 in `npm run e2e:real`: a launcher ended with exit 1 on
 * `<3>WSL (…) ERROR: UtilAcceptVsock:271: accept4 failed 110`, while the same call on its own answers in 40 ms); a
 * program that ran and answered with an error is not, because that answer is the program's own.
 * @returns {string} what the program wrote, without carriage returns
 */
export function winExec(file, args, { tries = 3, waitMs = 300, timeout = 120000, cwd = isWsl() ? "/mnt/c" : undefined, log = () => {} } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i += 1) {
    const r = spawnSync(file, args, { encoding: "utf8", cwd, timeout });
    if (!interopFailed(r)) {
      if (r.status !== 0) throw new Error(`${file} answered with exit ${r.status}: ${(r.stderr ?? "").trim().slice(0, 300) || "(nothing on stderr)"}`);
      if (i > 1) log(`${file} came back on attempt ${i} of ${tries}`);
      return (r.stdout ?? "").replace(/\r/g, "");
    }
    last = r.error ? r.error.message : `exit ${r.status}, stderr ${JSON.stringify((r.stderr ?? "").trim().slice(0, 200))}`;
    log(`${file} did not reach Windows (attempt ${i} of ${tries}): ${last}`);
    if (i < tries) sleep(waitMs);
  }
  throw new Error(`${file} did not reach Windows in ${tries} attempts (WSL interop): ${last}`);
}

/** PowerShell on the Windows side, for a line of state; the script is run without a profile. */
export const winPs = (script, opts) => winExec("powershell.exe", ["-NoProfile", "-Command", script], opts).trim();
