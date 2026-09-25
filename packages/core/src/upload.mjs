// `aas publish --upload`: the bundle's zip, private part included, sent to the archive under the account that is
// signed in. Uploading needs an account; the archive answers with what it made of the upload.
import fs from "node:fs";
import path from "node:path";
import { accessToken } from "./auth.mjs";
import { currentArchiveFetch, proofUrl } from "./proof.mjs";

export async function uploadBundle(zipFile, { fetchImpl = currentArchiveFetch(), baseUrl = proofUrl(), timeoutMs = 300000 } = {}) {
  // What is uploaded first: a bundle's zip that is there, before anything is asked of the account or the network.
  if (!fs.existsSync(zipFile) || !fs.statSync(zipFile).isFile()) throw new Error(`${zipFile} is not there: upload the .zip that aas publish made`);
  if (!/\.zip$/i.test(zipFile)) throw new Error(`${zipFile} is not a bundle's .zip`);
  const token = await accessToken();
  // Without an account only a caller that authenticates its own requests can upload (useArchiveFetch).
  if (!token && fetchImpl === fetch) throw new Error("uploading needs an account: sign in with `aas login` first");
  const res = await fetchImpl(`${baseUrl}/api/v1/bundles`, { method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/zip", "X-Filename": path.basename(zipFile), Accept: "application/json" }, body: fs.readFileSync(zipFile), signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => ({}));
  // A refusal with a decision (a mock, a proof that does not match) is the archive's answer, not a failed upload.
  if (!res.ok && json.status && json.submission) return json;
  if (!res.ok) throw new Error(`the Archive refused the upload (${res.status}${json.error ? `: ${json.error}` : ""}${json.reasons?.length ? `: ${json.reasons.join("; ")}` : ""})`);
  return json;
}
