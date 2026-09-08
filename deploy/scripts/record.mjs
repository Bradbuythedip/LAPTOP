// Write down the transaction hash a step was sent as, and learn the address from its receipt.
//
//   node deploy/scripts/record.mjs 2.deploy 0x…
//
// WHY THE RECEIPT AND NOT A TYPED ADDRESS. The first version asked the operator for "the
// address SnoozeDeployer landed at" and then verified it by reading owner(). That check passes
// against ANY SnoozeDeployer anywhere with the same constructor argument — including one a
// stranger deployed and owns nothing of, which anybody can make, and including a typo that
// happens to land on one. A receipt ties the address to a transaction that is in a block.
//
// It also refuses a failed receipt. A reverted deployment has a receipt too, and its
// contractAddress is null, so "it is on chain" is not the same as "it worked".
import { context, die, bar, green, dim, pick } from "./lib/run.mjs";
import { markSent, saveState, stepState, STATE_PATH } from "./lib/state.mjs";
import { toChecksum, keccakText, sameAddress } from "./lib/abi.mjs";

const [spec, txHash] = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!spec || !txHash) die("usage: node deploy/scripts/record.mjs <step>.<tx> <txHash>");
if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) die("that is not a transaction hash");

const { steps, state, rpc, chainId, cfg } = await context({ needChain: true });
const { step, txKey } = pick(steps, spec);
if (!txKey) die(`say which transaction: ${step.txs.map(t => `${step.n}.${t.key}`).join(", ")}`);

const r = await rpc.receipt(txHash);
if (!r) die("no receipt yet — the transaction is not mined. Wait and run this again.");
if (r.status !== "0x1")
  die(`that transaction FAILED (status ${r.status}). Nothing was deployed and nothing was ` +
      "changed, but the gas is spent. Read the revert on a block explorer before resending.");

state.chainId = chainId;
state.owner = cfg.owner;
markSent(state, step.id, txKey, txHash);

// A creation receipt names the address. A CALL receipt does not — and the curve is deployed by
// a call to SnoozeDeployer, so its receipt has none. That is not a gap: CREATE2 fixed the
// address when the salt was ground, step 4 recorded it, and `expectAddress` is that value.
// Without this the sequence deadlocks at step 5 with no address to verify against.
// And when the receipt has no address of its own, the deployer's log still ties one to THIS
// transaction: SnoozeDeployer emits Deployed(address indexed addr, ...), so the address is
// topic 1. Cross-checked against the salt rather than replacing it — agreement between a value
// derived offline and a value the chain emitted is the check; either alone is a claim.
const DEPLOYED_TOPIC = keccakText("Deployed(address,bytes32,address)");
const logged = (r.logs || [])
  .filter(l => (l.topics || [])[0] === DEPLOYED_TOPIC && l.topics[1])
  .map(l => "0x" + l.topics[1].slice(-40))[0] || null;
const expected = step.expectAddress ? step.expectAddress() : null;
if (logged && expected && !sameAddress(logged, expected))
  die(`that transaction deployed ${logged}, and the salt recorded in step 4 promises ` +
      `${expected}. Do not proceed: one of them is not this launch's curve.`);
const created = r.contractAddress || logged || expected;
if (created) {
  const s = stepState(state, step.id);
  state.steps[step.id] = { ...s, readBack: { ...(s.readBack || {}), address: created } };
  console.log(bar(`step ${step.n}.${txKey}`));
  console.log(`  ${green(r.contractAddress ? "created" : "expected")}  ${toChecksum(created)}` +
              (r.contractAddress ? ""
                : dim(logged ? "   (from the deployer's Deployed log, and it agrees with the salt)"
                             : "   (from the salt — a call receipt names no address of its own)")));
} else {
  console.log(bar(`step ${step.n}.${txKey}`));
  console.log(`  ${green("mined")}    ${txHash}`);
}
console.log(`  block    ${Number(BigInt(r.blockNumber))}`);
saveState(state);
console.log(dim(`  recorded in ${STATE_PATH}`));
console.log(dim(`  Next: node deploy/scripts/verify.mjs ${step.n}`));
