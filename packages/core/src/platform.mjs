// Where a recording is published. A run's video lives on a platform, not in the bundle, and an archive wants the
// platform next to the link: a stream VOD expires, an upload does not, and the two are checked differently.
// The list is what a publisher may name; anything else is accepted as `other` with the host kept, so a platform
// nobody thought of does not block a submission.
// id, host pattern, what the link is (an upload keeps, a VOD expires), and the field on that platform in which a
// viewer can read the fingerprint. Where a platform has no readable field, a bundle cannot be bound to it.
const PLATFORMS = [
  ["youtube", /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i, "upload", "description"],
  ["twitch", /(^|\.)twitch\.tv$/i, "vod", "video description"],
  ["kick", /(^|\.)kick\.com$/i, "vod", "title"],
  ["vimeo", /(^|\.)vimeo\.com$/i, "upload", "description"],
  ["bilibili", /(^|\.)bilibili\.com$/i, "upload", "description"],
  ["odysee", /(^|\.)odysee\.com$/i, "upload", "description"],
  ["rumble", /(^|\.)rumble\.com$/i, "upload", "description"],
  ["dailymotion", /(^|\.)dailymotion\.com$/i, "upload", "description"],
  ["nicovideo", /(^|\.)nicovideo\.jp$/i, "upload", "description"],
  ["archive.org", /(^|\.)archive\.org$/i, "archive", "item description"],
  ["peertube", /(^|\.)(framatube\.org|tilvids\.com|peertube\.[a-z0-9.-]+)$/i, "upload", "description"],
];

/** `{ url, platform, host, kind, binding_field }` for a recording link, or null when the string is not an http(s) URL. */
export function describeRecordingUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./i, "");
  const hit = PLATFORMS.find(([, re]) => re.test(host));
  // An unknown platform is not refused: the publisher names where the fingerprint is readable, or the archive
  // decides it cannot accept that platform. A title is the fallback where a platform has no description.
  return { url: u.href, platform: hit ? hit[0] : "other", host, kind: hit ? hit[2] : "unknown", binding_field: hit ? hit[3] : "title or description" };
}
export const KNOWN_PLATFORMS = PLATFORMS.map(([id]) => id);
