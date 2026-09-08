// Read a step back off the chain and decide whether the next one may be built.
//
//   node deploy/scripts/verify.mjs 2
//
// Nothing here trusts that a transaction was sent. Every claim is an eth_call whose answer is
// compared against what deploy/config.json said it would be, and the step is only marked
// verified when all of them agree — that mark is what lib/steps.mjs consults before it will
// build anything downstream. A transaction can be mined and still have done something other
// than what you meant.
import { context, die, bar, green, red, dim, printChecks, readStep } from "./lib/run.mjs";
import { pickStep } from "./lib/steps.mjs";
import { markVerified, saveState, stepState, STATE_PATH } from "./lib/state.mjs";

const spec = process.argv.slice(2).find(a => !a.startsWith("-"));
if (!spec) die("which step? e.g. `node deploy/scripts/verify.mjs 2`");

const { steps, state, rpc, chainId, cfg } = await context();
const { step } = pickStep(steps, spec);

const why = step.blocked();
if (why) die(why);

console.log(bar(`step ${step.n} — ${step.title}`));

let list, address = null, results = {};
if (step.verify.offline) {
  // The salt is the one step with nothing on chain to read: the check is that the derivation
  // still produces the address that was recorded, recomputed here rather than trusted from the
  // grinder's own output.
  list = step.verify.check({}, {});
} else {
  if (!rpc) die("this step is verified by reading the chain. Set SNOOZE_RPC.");
  await rpc.requireChain(chainId);
  const recorded = stepState(state, step.id).readBack?.address;
  if (!recorded && !step.verify.target())
    die(`no address for step ${step.n}. ${step.verify.needsAddress || "Record the transaction " +
        "first"}:\n  node deploy/scripts/record.mjs ${step.n}.${step.txs[0]?.key} <txHash>`);
  const read = await readStep(rpc, step, { address: recorded });
  address = read.address;
  results = read.results;
  list = step.verify.check(read.results, { code: read.code, address: read.address });
}

const bad = printChecks(list);
console.log();

if (bad) {
  console.log(red(`  ${bad} of ${list.length} checks failed. Step ${step.n} is NOT verified, ` +
                  `so nothing after it can be built.`));
  const note = step.note && step.note();
  if (note) console.log("\n  " + note);
  process.exit(1);
}

state.chainId = chainId;
state.owner = cfg.owner;
const prev = stepState(state, step.id).readBack || {};
markVerified(state, step.id,
  { ...prev, ...step.verify.record(results, { address: address || prev.address }) });
saveState(state);

console.log(green(`  all ${list.length} checks passed.`) + dim(`  recorded in ${STATE_PATH}`));
const note = step.note && step.note();
if (note) console.log("\n  " + red("!") + " " + note);
const next = steps.find(s => s.n === step.n + 1);
if (next) console.log(dim(`\n  Next: node deploy/scripts/build.mjs ${next.n}`));
