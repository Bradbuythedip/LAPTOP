// The whole sequence, and where you are in it.
//
//   node deploy/scripts/plan.mjs
//
// Reads nothing from the chain unless SNOOZE_RPC is set, so it works on a laptop with no
// network as a way of reading what is about to happen before anything happens.
import { context, bar, bold, dim, green, red } from "./lib/run.mjs";
import { AFTER_THE_SEQUENCE } from "./lib/steps.mjs";
import { isVerified, stepState, STATE_PATH } from "./lib/state.mjs";
import { toChecksum } from "./lib/abi.mjs";
import { CHAINS } from "./lib/rpc.mjs";

const { cfg, steps, state, rpc, chainId } = await context();

console.log(bar(`${cfg.token.name} ($${cfg.token.symbol}) on ${CHAINS[chainId]} (${chainId})`));
console.log(`  owner      ${toChecksum(cfg.owner)}`);
console.log(`  supply     ${cfg.token.supply} base units, devBps ${cfg.token.devBps}, ` +
            `dev ${cfg.token.dev}`);
console.log(`  curve      virtualEth ${cfg.curve.virtualEth}, bondTarget ${cfg.curve.bondTarget}, ` +
            `feeBps ${cfg.curve.feeBps} → ${toChecksum(cfg.curve.feeTo)}`);
console.log(`  vanity     …${cfg.vanity.suffix} on ${cfg.vanity.contract}`);
console.log(`  state      ${STATE_PATH}`);
console.log(`  endpoint   ${rpc ? rpc.label : dim("none — set SNOOZE_RPC to verify anything")}`);
console.log();

for (const step of steps) {
  const done = isVerified(state, step.id);
  const blocked = step.blocked();
  const mark = done ? green("done") : blocked ? dim("wait") : bold("next");
  console.log(`${mark}  ${step.n}. ${bold(step.title)}`);
  console.log(`      ${step.what.replace(/\n/g, "\n      ")}`);
  const note = step.note && step.note();
  if (note) console.log("      " + red("! ") + note.replace(/\n/g, "\n        "));
  for (const tx of step.txs) {
    const why = tx.blocked && tx.blocked();
    console.log(`      · ${step.n}.${tx.key.padEnd(9)} ${tx.label}` +
                (why ? dim(`   — ${why.split("\n")[0]}`) : ""));
  }
  if (step.irreversible.length) {
    console.log(dim("      cannot be undone:"));
    for (const line of step.irreversible)
      console.log(dim("        · " + line.replace(/\n/g, " ")));
  }
  if (!done && blocked) console.log(dim("      blocked: " + blocked.split("\n")[0]));
  const st = stepState(state, step.id);
  if (st.sent) for (const [k, h] of Object.entries(st.sent))
    console.log(dim(`      sent ${k}: ${h}`));
  console.log();
}

console.log(bar("what these six steps do not cover"));
for (const item of AFTER_THE_SEQUENCE) {
  console.log(`  ${bold(item.title)}`);
  console.log("      " + item.body.replace(/(.{1,86})(\s|$)/g, "$1\n      ").trimEnd());
}
console.log();
