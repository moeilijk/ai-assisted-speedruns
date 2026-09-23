// `aas publish --upload`: the bundle's zip, private part included, sent to the archive under the account that is
// signed in. Uploading needs an account; the archive answers with what it made of the upload.
import fs from "node:fs";
import { accessToken } from "./auth.mjs";
import { proofUrl } from "./proof.mjs";

export async function uploadBundle(zipFile, { fetchImpl = fetch, baseUrl = proofUrl(), timeoutMs = 300000 } = {}) {
  const token = await accessToken({ fetchImpl });
  if (!token) throw new Error("uploading needs an account: sign in with `aas login` first");
  const res = await fetchImpl(`${baseUrl}/api/v1/bundles`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip", Accept: "application/json" }, body: fs.readFileSync(zipFile), signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`the archive refused the upload (${res.status}${json.error ? `: ${json.error}` : ""})`);
  return json;
}
