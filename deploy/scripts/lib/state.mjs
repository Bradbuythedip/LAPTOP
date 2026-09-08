// Where the launch has got to, on disk, so a step can refuse to build until the one before it
// has been READ BACK from the chain.
//
// WHY A FILE AND NOT A FLAG. "Verify before advancing" is only a rule if forgetting to verify
// stops the next step. A flag on the command line is a promise the operator makes to
// themselves at 2am; a recorded read from the chain is a fact. Everything in here is written
// by verify.mjs after an eth_call came back with the value the step promised, and nothing
// writes it on the strength of a transaction having been sent — a transaction can be mined and
// still have done something other than what you meant.
//
// This file is NOT committed. It names one wallet's progress through one launch on one chain,
// it is regenerable from the chain, and a stale one in the repository would be a set of
// addresses somebody might trust. .gitignore has it.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./solc.mjs";

export const STATE_PATH = process.env.SNOOZE_STATE || path.join(ROOT, "deploy", "launch-state.json");

const EMPTY = { chainId: null, owner: null, steps: {} };

/// Bound to one chain and one owner, and refuses to be read on another.
///
/// LAUNCH.md 4.0 calls the Base Sepolia rehearsal the highest-value item in the document, and
/// a rehearsal writes exactly the same file. Without this, a state file left over from the
/// testnet run marks every mainnet step "verified" from testnet reads — the one failure mode
/// where the safety mechanism itself is what hides the problem.
export function loadState(file = STATE_PATH, { chainId, owner } = {}) {
  if (!fs.existsSync(file)) return { ...structuredClone(EMPTY), chainId: chainId ?? null,
                                     owner: owner ?? null };
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  if (chainId !== undefined && s.chainId != null && s.chainId !== chainId)
    throw new Error(`${path.basename(file)} records chain ${s.chainId} and this run is chain ` +
      `${chainId}. A rehearsal's verified steps are not this launch's. Move it aside, or set ` +
      "SNOOZE_STATE to a different path.");
  if (owner !== undefined && s.owner && String(s.owner).toLowerCase() !== String(owner).toLowerCase())
    throw new Error(`${path.basename(file)} records owner ${s.owner} and this run is ` +
      `${owner}. These are different launches.`);
  return { ...structuredClone(EMPTY), ...s, chainId: s.chainId ?? chainId ?? null,
           owner: s.owner ?? owner ?? null, steps: { ...(s.steps || {}) } };
}

export function saveState(state, file = STATE_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  return file;
}

export const stepState = (state, id) => state.steps[id] || { status: "not started" };
export const isVerified = (state, id) => stepState(state, id).status === "verified";

/// Record a step as verified, with the facts that were read back. `readBack` is stored so a
/// later step can use an address it did not derive itself and so a reader can check the claim.
export function markVerified(state, id, readBack) {
  state.steps[id] = { ...stepState(state, id), status: "verified", readBack };
  return state;
}

/// Record that a transaction was sent, which is NOT the same as the step having worked.
export function markSent(state, id, txKey, txHash) {
  const s = stepState(state, id);
  const sent = { ...(s.sent || {}), [txKey]: txHash };
  state.steps[id] = { ...s, status: s.status === "verified" ? "verified" : "sent", sent };
  return state;
}
