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
import { context, die, bar, green, dim } from "./lib/run.mjs";
import { pickStep } from "./lib/steps.mjs";
import { markSent, saveState, stepState, STATE_PATH } from "./lib/state.mjs";
import { toChecksum } from "./lib/abi.mjs";

const [spec, txHash] = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!spec || !txHash) die("usage: node deploy/scripts/record.mjs <step>.<tx> <txHash>");
if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) die("that is not a transaction hash");

const { steps, state, rpc, chainId, cfg } = await context({ needChain: true });
const { step, txKey } = pickStep(steps, spec);
if (!txKey) die(`say which transaction: ${step.txs.map(t => `${step.n}.${t.key}`).join(", ")}`);

const r = await rpc.receipt(txHash);
if (!r) die("no receipt yet — the transaction is not mined. Wait and run this again.");
if (r.status !== "0x1")
  die(`that transaction FAILED (status ${r.status}). Nothing was deployed and nothing was ` +
      "changed, but the gas is spent. Read the revert on a block explorer before resending.");

state.chainId = chainId;
state.owner = cfg.owner;
markSent(state, step.id, txKey, txHash);

// A creation receipt names the address; a call receipt does not, and does not need to.
if (r.contractAddress) {
  const s = stepState(state, step.id);
  state.steps[step.id] = { ...s, readBack: { ...(s.readBack || {}), address: r.contractAddress } };
  console.log(bar(`step ${step.n}.${txKey}`));
  console.log(`  ${green("created")}  ${toChecksum(r.contractAddress)}`);
} else {
  console.log(bar(`step ${step.n}.${txKey}`));
  console.log(`  ${green("mined")}    ${txHash}`);
}
console.log(`  block    ${Number(BigInt(r.blockNumber))}`);
saveState(state);
console.log(dim(`  recorded in ${STATE_PATH}`));
console.log(dim(`  Next: node deploy/scripts/verify.mjs ${step.n}`));
