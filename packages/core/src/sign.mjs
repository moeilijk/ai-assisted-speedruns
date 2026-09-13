// Signing a bundle. What is signed is the exact bytes of manifest.json and nothing else: the manifest carries a
// sha256 of every other file, so one signature covers the whole bundle, and it keeps covering it in the upload
// zip, which carries the same manifest. The signature lives next to it in signature.json, which the manifest
// therefore cannot list (a file cannot hash the thing that signs it).
//
// The key is ed25519, and its public half is written in the one-line OpenSSH form because that form is short
// enough to paste into a profile and is what some hosts already publish for an account. Neither is a
// requirement: the key here is the publisher's, made by this tooling if they have none, and an archive learns
// whose it is from its own accounts. Verification needs no dependency: ed25519 is in Node's crypto and in a
// browser's WebCrypto.
//
// A checker can say the signature is valid for the key in the file. It cannot say the key belongs to anyone;
// that binding belongs to whoever holds the accounts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function sshString(buf, at) {
  const len = buf.readUInt32BE(at);
  return { value: buf.subarray(at + 4, at + 4 + len), next: at + 4 + len };
}

/** The 32-byte seed of an unencrypted OpenSSH ed25519 private key. */
function seedFromOpenSsh(text) {
  const body = Buffer.from(text.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "").replace(/\s+/g, ""), "base64");
  if (body.subarray(0, 15).toString("latin1") !== "openssh-key-v1\0") throw new Error("not an OpenSSH private key");
  let at = 15;
  const cipher = sshString(body, at); at = cipher.next;
  const kdf = sshString(body, at); at = kdf.next;
  const kdfOpts = sshString(body, at); at = kdfOpts.next;
  if (cipher.value.toString() !== "none" || kdf.value.toString() !== "none") {
    throw new Error("the key is protected with a passphrase; sign with a key without one, or give a PKCS#8 key (ssh-keygen -p -N '' -f <key> removes the passphrase)");
  }
  at += 4; // number of keys, always 1
  const pub = sshString(body, at); at = pub.next;
  const priv = sshString(body, at);
  let p = 8; // two check integers
  const type = sshString(priv.value, p); p = type.next;
  if (type.value.toString() !== "ssh-ed25519") throw new Error(`the key is ${type.value.toString()}, not ssh-ed25519`);
  const pubKey = sshString(priv.value, p); p = pubKey.next;
  const secret = sshString(priv.value, p);
  return secret.value.subarray(0, 32);
}

/** `{ privateKey, publicKey, publicLine, fingerprint }` for an ed25519 key in OpenSSH or PKCS#8 form. */
export function readKey(file) {
  const text = fs.readFileSync(file, "utf8");
  const privateKey = /BEGIN OPENSSH PRIVATE KEY/.test(text)
    ? crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seedFromOpenSsh(text)]), format: "der", type: "pkcs8" })
    : crypto.createPrivateKey(text);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`the key is ${privateKey.asymmetricKeyType}, not ed25519`);
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, ...publicInfo(publicKey) };
}

/** The OpenSSH one-line public key and its SHA256 fingerprint, as `ssh-keygen -lf` prints it. */
export function publicInfo(publicKey) {
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const wire = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), raw]);
  return { publicLine: `ssh-ed25519 ${wire.toString("base64")}`, fingerprint: `SHA256:${crypto.createHash("sha256").update(wire).digest("base64").replace(/=+$/, "")}` };
}

/** The public key of an OpenSSH one-line string, for verification. */
export function publicKeyFromLine(line) {
  const wire = Buffer.from(String(line).trim().split(/\s+/)[1] ?? "", "base64");
  const type = sshString(wire, 0);
  if (type.value.toString() !== "ssh-ed25519") throw new Error("the public key is not ssh-ed25519");
  const raw = sshString(wire, type.next).value;
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

export const SIGNATURE_FILE = "signature.json";

/** Signs a bundle's manifest.json and writes signature.json next to it. */
export function signBundle(dir, keyFile) {
  const { privateKey, publicLine, fingerprint } = readKey(keyFile);
  const manifest = fs.readFileSync(path.join(dir, "manifest.json"));
  const signature = crypto.sign(null, manifest, privateKey);
  const out = {
    version: 1,
    algorithm: "ed25519",
    public_key: publicLine,
    key_fingerprint: fingerprint,
    manifest_sha256: crypto.createHash("sha256").update(manifest).digest("hex"),
    signature: signature.toString("base64"),
    signed_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, SIGNATURE_FILE), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/** `{ signed, valid, fingerprint, problem }` for a bundle: is there a signature, and is it valid for its own key? */
export function verifyBundle(dir) {
  const file = path.join(dir, SIGNATURE_FILE);
  if (!fs.existsSync(file)) return { signed: false, valid: false, fingerprint: null, problem: null };
  try {
    const sig = JSON.parse(fs.readFileSync(file, "utf8"));
    if (sig.algorithm !== "ed25519") return { signed: true, valid: false, fingerprint: sig.key_fingerprint ?? null, problem: `algorithm ${sig.algorithm} is not ed25519` };
    const manifest = fs.readFileSync(path.join(dir, "manifest.json"));
    const sha = crypto.createHash("sha256").update(manifest).digest("hex");
    if (sig.manifest_sha256 && sig.manifest_sha256 !== sha) return { signed: true, valid: false, fingerprint: sig.key_fingerprint ?? null, problem: "manifest_sha256 does not match manifest.json" };
    const publicKey = publicKeyFromLine(sig.public_key);
    const info = publicInfo(publicKey);
    if (sig.key_fingerprint && sig.key_fingerprint !== info.fingerprint) return { signed: true, valid: false, fingerprint: info.fingerprint, problem: "key_fingerprint does not match public_key" };
    const valid = crypto.verify(null, manifest, publicKey, Buffer.from(String(sig.signature), "base64"));
    return { signed: true, valid, fingerprint: info.fingerprint, problem: valid ? null : "the signature does not verify against manifest.json" };
  } catch (e) {
    return { signed: true, valid: false, fingerprint: null, problem: e.message };
  }
}

/**
 * The publisher's own signing key, made here when they have none. Not everyone who runs a speedrun has an SSH
 * key or a code-hosting account, so the tooling does not borrow one: it writes an ed25519 key in PKCS#8 form,
 * readable by `readKey`, and prints the public line to register with an archive. Never overwrites.
 */
export function createKey(file) {
  if (fs.existsSync(file)) return { created: false, file, ...publicInfo(crypto.createPublicKey(readKey(file).privateKey)) };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return { created: true, file, ...publicInfo(publicKey) };
}

// --- Key claims -------------------------------------------------------------
//
// A signing key on its own says "these bundles came from one hand". A claim says which hand, and it is the
// publisher's own statement: a few lines of text naming the key and the identities it belongs to, signed with
// that key. It is deliberately plain text and not tied to any archive, because a publisher may publish in more
// than one place and outlive any of them: paste it in a profile, put it on a domain you control, wrap it in
// another signature (`gpg --clearsign` leaves the body readable) and put it wherever such things are kept.
//
// What it proves by itself: whoever holds the key says it belongs to these identities. What it does not prove:
// that the identities agree. That second half comes from where the claim is published — a place only the owner
// of an identity can write to — which is why the format does not care where that is.
export const CLAIM_KIND = "aas-key-claim v1";

const claimBody = ({ publicLine, fingerprint, identities, issued }) =>
  [CLAIM_KIND, `key: ${publicLine}`, `fingerprint: ${fingerprint}`, ...identities.map((i) => `identity: ${i}`), `issued: ${issued}`].join("\n");

/** The publisher's signed statement about their own key. `identities` are URIs (https:, mailto:, or an archive's profile). */
export function makeClaim(keyFile, { identities = [], issued = new Date().toISOString() } = {}) {
  const { privateKey, publicLine, fingerprint } = readKey(keyFile);
  for (const id of identities) if (!/^[a-z][a-z0-9+.-]*:/i.test(id)) throw new Error(`identity must be a URI (https://…, mailto:…): ${id}`);
  const body = claimBody({ publicLine, fingerprint, identities, issued });
  const signature = crypto.sign(null, Buffer.from(body, "utf8"), privateKey).toString("base64");
  return { text: `${body}\nsignature: ${signature}\n`, publicLine, fingerprint, identities, issued };
}

/** Reads a claim as published (any wrapper around it is ignored) and says whether it verifies against its own key. */
export function verifyClaim(text) {
  const lines = String(text).split("\n").map((l) => l.replace(/\r$/, ""));
  const start = lines.findIndex((l) => l.trim() === CLAIM_KIND);
  if (start < 0) return { valid: false, problem: `not a claim: no "${CLAIM_KIND}" line` };
  const value = (name) => lines.slice(start).find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? null;
  const publicLine = value("key");
  const fingerprint = value("fingerprint");
  const issued = value("issued");
  const identities = lines.slice(start).filter((l) => l.startsWith("identity: ")).map((l) => l.slice("identity: ".length).trim());
  const signature = value("signature");
  if (!publicLine || !signature || !issued) return { valid: false, problem: "a claim needs key, issued and signature lines" };
  try {
    const publicKey = publicKeyFromLine(publicLine);
    const info = publicInfo(publicKey);
    if (fingerprint && fingerprint !== info.fingerprint) return { valid: false, fingerprint: info.fingerprint, problem: "the fingerprint line does not match the key" };
    const body = claimBody({ publicLine, fingerprint: info.fingerprint, identities, issued });
    const valid = crypto.verify(null, Buffer.from(body, "utf8"), publicKey, Buffer.from(signature, "base64"));
    return { valid, fingerprint: info.fingerprint, publicLine, identities, issued, problem: valid ? null : "the signature does not verify against the claim" };
  } catch (e) {
    return { valid: false, problem: e.message };
  }
}
