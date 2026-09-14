// Text sanitisation shared by the exporters and `aas scan`. Derived from cozyblaze's portal-agent,
// tools/export-session.mjs and tools/scan-publication.mjs
// (MIT, Copyright (c) 2026 cozyblaze; license text in packages/core/vendor/portal-agent/LICENSE; see packages/core/NOTICE).
export function createSanitizer() {
  const counts = { removed_images: 0 };
  const redactions = {};
  const replace = (s, re, label, sub) =>
    s.replace(re, (...args) => {
      redactions[label] = (redactions[label] ?? 0) + 1;
      return typeof sub === "function" ? sub(...args) : sub;
    });
  function cleanText(s) {
    s = replace(s, /<environment_context>[\s\S]*?<\/environment_context>/g, "environment", "[Host environment omitted]");
    s = replace(s, /<system-reminder>[\s\S]*?<\/system-reminder>/g, "environment", "[Host context omitted]");
    s = replace(s, /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "image", () => {
      counts.removed_images++;
      return "[Image omitted]";
    });
    s = replace(s, /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/gi, "home_path", "<USER_HOME>");
    s = replace(s, /\/home\/[^/\s"'<>]+|\/Users\/[^/\s"'<>]+/g, "home_path", "<USER_HOME>");
    s = replace(s, /\/mnt\/[a-z]\/[^\s"'<>]+/g, "mount_path", "<MOUNT_PATH>");
    s = replace(s, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "identifier", "[ID]");
    s = replace(s, /\b(?:call|msg|ctc|ctco|fc|fco|rs|resp|toolu|req|cse)_[A-Za-z0-9_-]{12,}\b/g, "identifier", "[ID]");
    s = replace(s, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "email", "[EMAIL]");
    s = replace(s, /\b(?:sk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, "credential", "[SECRET]");
    s = replace(s, /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "credential", "[TOKEN]");
    s = replace(s, /Bearer\s+[A-Za-z0-9._~+/-]+/gi, "credential", "Bearer [TOKEN]");
    s = replace(s, /\bS-1-5-21-\d+-\d+-\d+-\d+\b/g, "machine_id", "[SID]");
    s = replace(s, /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "ip", (v) => (["127.0.0.1", "0.0.0.0"].includes(v) ? v : "[IP]"));
    s = replace(s, /https?:\/\/[^\s<>"\\)]+/g, "url", (v) => (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?=[:/]|$)/.test(v) ? v : "[URL]"));
    return s;
  }
  const DROP_KEYS = ["encrypted_content", "internal_chat_message_metadata_passthrough", "session_id", "thread_id", "turn_id", "root_turn_id", "response_id", "rate_limits", "signature", "tool_use_id", "id"];
  function clean(value) {
    if (typeof value === "string") {
      if (/^[[{]/.test(value.trim())) {
        try {
          return JSON.stringify(clean(JSON.parse(value)));
        } catch {
          // not JSON
        }
      }
      return cleanText(value);
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") {
      if (/image/.test(value.type ?? "") || value.mimeType?.startsWith("image/") || value.source?.type === "base64") {
        counts.removed_images++;
        return { type: "image_omitted" };
      }
      return Object.fromEntries(Object.entries(value).filter(([k]) => !DROP_KEYS.includes(k)).map(([k, v]) => [k, clean(v)]));
    }
    return value;
  }
  return { cleanText, clean, counts, redactions };
}

/** Rules for `aas scan`: anything matching must not be in a published run directory. */
export const SCAN_RULES = [
  ["personal home path", /[A-Z]:[\\/]+Users[\\/]+[^\s\\/"'<>]+/i],
  ["WSL mount path", /\/mnt\/[a-z]\/[^\s"'<>]+/],
  ["password or token in a config", /"?[A-Za-z_]*(?:PASSWORD|SECRET|TOKEN|PASSWD)"?\s*[:=]\s*"(?!__)[^"\n]+"/i],
  ["private Unix home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+/],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["credential", /\b(?:sk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Windows identity", /\bS-1-5-21-\d+-\d+-\d+-\d+\b/],
  ["session identifier", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["embedded image", /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{80}/i],
  ["opaque blob", /["'][A-Za-z0-9+/=]{300,}["']/],
];
