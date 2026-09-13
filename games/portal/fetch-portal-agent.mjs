#!/usr/bin/env node
// Clone cozyblaze/portal-agent at the commit pinned in UPSTREAM.json into
// .local/portal-agent (or AAS_PORTAL_AGENT_DIR). Re-running verifies the
// checkout is at the pinned commit; it never overwrites local changes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const upstream = JSON.parse(readFileSync(join(here, "UPSTREAM.json"), "utf8"));
const target = resolve(process.env.AAS_PORTAL_AGENT_DIR || join(here, "..", "..", ".local", "portal-agent"));
const git = (...args) => execFileSync("git", args, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

if (!existsSync(join(target, ".git"))) {
  console.log(`Cloning ${upstream.repository} into ${target}`);
  git("clone", "--quiet", upstream.repository, target);
  git("-C", target, "checkout", "--quiet", "--detach", upstream.commit);
}
const head = git("-C", target, "rev-parse", "HEAD");
if (head !== upstream.commit) {
  if (git("-C", target, "status", "--porcelain")) {
    throw new Error(`${target} is at ${head.slice(0, 7)} with local changes; expected ${upstream.commit.slice(0, 7)}. Resolve by hand.`);
  }
  git("-C", target, "fetch", "--quiet", "origin");
  git("-C", target, "checkout", "--quiet", "--detach", upstream.commit);
}
console.log(`portal-agent ${upstream.commit.slice(0, 7)} ready at ${target}`);
