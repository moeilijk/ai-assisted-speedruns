// Whether a run may go on with the installed tooling. A run lasts many sessions, perhaps months, and the tooling may
// be updated in between: within a release line that is fine, but never back to an older release (it may misread what
// a newer session wrote), and never past a breaking release unless the runner says so.
import { BREAKING_RELEASES } from "./versions.mjs";

const parts = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
/** Negative, zero or positive, as a semantic version a is below, equal to or above b. */
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * `{ ok, problem, breaking }` for resuming a run whose earlier sessions ran the tooling versions `earlier` (from their
 * `run.started`; a session from before 0.13.0 names none and counts as older than every release) with `installed`.
 */
export function resumeToolingCheck({ earlier = [], installed, breaking = BREAKING_RELEASES, allowBreaking = false }) {
  const known = earlier.filter(Boolean);
  const newest = known.reduce((m, v) => (compareVersions(v, m) > 0 ? v : m), known[0] ?? "0.0.0");
  if (known.length && compareVersions(installed, newest) < 0) {
    return { ok: false, breaking: [], problem: `an earlier session of this run ran tooling ${newest}, and the installed tooling ${installed} is older; resume with ${newest} or newer` };
  }
  const crossed = breaking.filter((b) => compareVersions(b, newest) > 0 && compareVersions(b, installed) <= 0);
  if (crossed.length && !allowBreaking) {
    return { ok: false, breaking: crossed, problem: `release ${crossed.join(", ")} came after the tooling this run last ran with (${known.length ? newest : "a release before 0.13.0"}) and changes what earlier runs can rely on (CHANGELOG.md); resume with that release line (git checkout of its last release), or pass --allow-breaking to go on with ${installed}` };
  }
  return { ok: true, breaking: crossed, problem: null };
}
