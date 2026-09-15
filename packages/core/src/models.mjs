// A model id split into its parts, the way its maker names its models: claude-sonnet-5 is Claude, Sonnet, version 5;
// gpt-5.6-luna is GPT, version 5.6, Luna. Only the patterns below are known; any other id has no parts (null) rather
// than a guess. No imports, so an archive can take this module as it is.

const PATTERNS = [
  // Claude: claude-<variant>-<major>[-<minor>][-<yyyymmdd>] (claude-sonnet-5, claude-fable-5-1, claude-haiku-4-5-20251001).
  [/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/, (m) => ({ name: "claude", variant: m[1], version: m[3] ? `${m[2]}.${m[3]}` : m[2], snapshot: m[4] ?? null })],
  // Older Claude ids put the version first: claude-<major>[-<minor>]-<variant>[-<yyyymmdd>] (claude-3-5-sonnet-20241022).
  [/^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-(\d{8}))?$/, (m) => ({ name: "claude", variant: m[3], version: m[2] ? `${m[1]}.${m[2]}` : m[1], snapshot: m[4] ?? null })],
  // GPT: gpt-<version>[-<variant>] (gpt-5.6-luna, gpt-5.5).
  [/^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/, (m) => ({ name: "gpt", variant: m[2] ?? null, version: m[1], snapshot: null })],
];

/** @returns {{name: string, variant: string|null, version: string, snapshot: string|null} | null} */
export function modelParts(id) {
  for (const [re, parts] of PATTERNS) {
    const m = re.exec(String(id));
    if (m) return parts(m);
  }
  return null;
}
