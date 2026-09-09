// Build one transaction, show you exactly what it is, and hand it to you to send.
//
//   node deploy/scripts/build.mjs 2                 the step's next unsent transaction
//   node deploy/scripts/build.mjs 5.fund            a particular one
//   node deploy/scripts/build.mjs 3 --confirm "…"   irreversible steps need the phrase
//
// It prints {to, data, value}. That is what a wallet's raw-transaction field wants, and it is
// also what deploy/deploy.html sends — the page is the convenience, this is the mechanism, and
// they build from the same lib/steps.mjs so they cannot say different things.
//
// It does NOT send, and it holds no key. There is no --send, no --private-key and no signer.
import { context, die, bar, bold, dim, red, printChecks, pick } from "./lib/run.mjs";
import { stepState } from "./lib/state.mjs";
import { toChecksum } from "./lib/abi.mjs";

const argv = process.argv.slice(2);
const spec = argv.find(a => !a.startsWith("-"));
if (!spec) die("which step? e.g. `node deploy/scripts/build.mjs 2`, or run plan.mjs first");
const ci = argv.indexOf("--confirm");
const confirmed = ci >= 0 ? argv[ci + 1] : null;

const { cfg, steps, state, rpc, chainId } = await context();
const { step, txKey } = pick(steps, spec);

const why = step.blocked();
if (why) die(why);

if (!step.txs.length)
  die(`step ${step.n} (${step.id}) sends no transaction. ` +
      (step.id === "oracle" ? "Record the oracle in deploy/config.json and run verify.mjs."
       : "Run grind.mjs, then verify.mjs."));

// Default to the first transaction that has not been recorded as sent — not to the first that
// has not been VERIFIED, because a sent-but-unverified transaction may simply not be mined yet
// and reprinting it invites sending it twice.
const sent = stepState(state, step.id).sent || {};
const next = step.txs.find(t => !sent[t.key]);
// Falling back to the LAST transaction when they have all been sent re-printed a transaction
// already on chain, with no sign it was a repeat — on step 6 that is a second seal(), on step 2
// a second SnoozeDeployer. Naming one explicitly still works, for a genuine resend.
if (!txKey && !next)
  die(`every transaction in step ${step.n} (${step.id}) has already been recorded as sent:\n` +
      Object.entries(sent).map(([k, h]) => `  ${step.n}.${k}  ${h}`).join("\n") +
      `\nRun \`node deploy/scripts/verify.mjs ${step.n}\` to read them back. To send one again ` +
      `on purpose, name it: build.mjs ${step.n}.${step.txs[step.txs.length - 1].key}`);
const tx = txKey ? step.txs.find(t => t.key === txKey) : next;
const txBlocked = tx.blocked && tx.blocked();
if (txBlocked) die(txBlocked);

/* ---- the preconditions that can only be read off the chain ---- */
if (tx.precondition) {
  if (!rpc) die(`${step.n}.${tx.key} cannot be built offline. ${tx.precondition.needsChain}\n` +
                "Set SNOOZE_RPC and try again.");
  // The one command that read the chain without asking which chain. CREATE and CREATE2
  // addresses are chain-independent, so a rehearsal endpoint left in SNOOZE_RPC answers
  // balanceOf(curve) with the rehearsal's funded numbers, the precondition passes, and setPool
  // is printed for a mainnet curve holding nothing. Every other command already refuses here.
  try { await rpc.requireChain(chainId); } catch (e) { die(e.message); }
  const results = {};
  for (const c of tx.precondition.calls())
    results[c.sig] = await rpc.call(c.to, "0x" + c.data.replace(/^0x/, ""));
  const list = tx.precondition.check(results);
  if (list.some(c => !c.ok)) {
    console.log(bar("before this can be sent"));
    printChecks(list);
    die(`${step.n}.${tx.key} is not safe to send yet`);
  }
}

/* ---- the confirmation, which names what it is confirming ---- */
if (step.confirm && confirmed !== step.confirm) {
  console.log(bar(`step ${step.n} — ${step.title}`));
  console.log(red("  These cannot be undone by anybody, including you:\n"));
  for (const line of step.irreversible)
    console.log("    · " + line.replace(/(.{1,80})(\s|$)/g, "$1\n      ").trimEnd());
  console.log("\n  Read them, then repeat the phrase back:\n");
  console.log(`    node deploy/scripts/build.mjs ${spec} --confirm ${JSON.stringify(step.confirm)}\n`);
  process.exit(2);
}

const built = tx.build();
console.log(bar(`step ${step.n}.${tx.key} — ${tx.label}`));
console.log(`  ${built.about.replace(/(.{1,84})(\s|$)/g, "$1\n  ").trimEnd()}\n`);
console.log(`  from   ${built.from ? toChecksum(built.from) + dim("   (only this address may send it)")
                                   : dim("anyone")}`);
console.log(`  to     ${built.to ? toChecksum(built.to) : bold("(contract creation)")}`);
console.log(`  value  ${built.value}`);
console.log(`  data   ${(built.data.length - 2) / 2} bytes`);
console.log();
console.log("0x" + built.data.replace(/^0x/, ""));
console.log();
console.log(dim("  Send it from your wallet. Nothing here can, and nothing here holds a key."));
console.log(dim(`  Then: node deploy/scripts/record.mjs ${step.n}.${tx.key} <txHash>`));
console.log(dim(`  Then: node deploy/scripts/verify.mjs ${step.n}`));
