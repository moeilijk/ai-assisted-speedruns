// The proof of one segment as `aas run` and `aas resume` use it: which mode this machine is in, the ticket fetched
// before anything is recorded, and what the person is told when the run will be unsigned.
import { accessToken, loggedIn } from "./auth.mjs";
import { proofClient, proofMode, segmentProof } from "./proof.mjs";

export async function startSegmentProof({ runDir, segment, runtime, events, opts = {}, log = () => {} }) {
  const mode = await proofMode({ override: opts.proof ?? null, loggedIn });
  if (mode === "off") {
    log("unsigned: this run is recorded without proof. An archive accepts it and marks it unsigned. Sign in with `aas login`, or set AAS_PROOF=anonymous, to record proof.");
    events.append("proof.off", { segment });
  }
  const client = proofClient({ token: mode === "account" ? () => accessToken() : async () => null });
  const proof = segmentProof({ runDir, segment, mode, runtime, client, events, log });
  try {
    await proof.begin();
  } catch (e) {
    throw new Error(`no ticket from the archive (${e.message}). Not starting: try again, or run with --proof off for an unsigned run.`);
  }
  return proof;
}
