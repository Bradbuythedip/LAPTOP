// Every address this launch will have, before it has any of them.
//
//   node deploy/scripts/predict.mjs            # read the wallet's nonce off the chain
//   node deploy/scripts/predict.mjs --nonce 7  # or state it, and no endpoint is needed
//   node deploy/scripts/predict.mjs --grind    # and find the curve's salt now, not on launch day
//
// WHY THIS IS POSSIBLE AT ALL. A plain CREATE lands at keccak(rlp([sender, nonce]))[12:] — the
// deployed bytes do not enter into it. The oracle, SnoozeDeployer and Snooze are all plain
// CREATEs from the owner's wallet, so all three addresses are arithmetic on one number that is
// already public. And the curve follows from those: its constructor argument is the token, so
// once the token's address is known its init code is known, its hash is known, and the CREATE2
// grind can run today against numbers that will still be true next week.
//
// WHAT THIS BUYS, precisely: a contract address to put in front of people — a Dexscreener or
// Dextools submission, a pinned post, an audit request, a Base name pointed at it — days
// before a wei is spent. Nothing is deployed and nothing is committed by running this.
//
// WHAT BREAKS IT, and it is one thing: A NONCE IS CONSUMED BY ANY TRANSACTION FROM THAT
// WALLET. An approval, a transfer, a mint on some other site, a transaction that reverts (a
// revert still consumes it), a wallet's own "cancel" — each one shifts every address below by
// one slot. Predict from a wallet you then leave alone, or re-run this and re-grind, which
// costs seconds. Step 4's grind recomputes the init-code hash from the REAL token address and
// refuses a salt ground against a different one, so a prediction that went stale cannot
// silently become the address you deploy to.
//
// Rejected: predicting from the PENDING nonce. It counts transactions the node has seen and
// not mined, and on Base those can still be replaced or dropped — the address would change
// when a stuck transaction was cancelled. "latest" is what a deployment actually consumes.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { context, die, bar, bold, dim, green, red } from "./lib/run.mjs";
import { curveInitCode, curveInitCodeHash } from "./lib/steps.mjs";
import { createAddress, create2Address, toChecksum, sameAddress } from "./lib/abi.mjs";
import { oracleDecision } from "./lib/config.mjs";
import { isVerified, stepState, PREDICTION_PATH } from "./lib/state.mjs";
import { NO_ENDPOINT, redact } from "./lib/rpc.mjs";
import { ROOT } from "./lib/solc.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };

const { cfg, artifacts, state, rpc, chainId } = await context();

// The one configuration that makes this impossible, and it is worth naming rather than
// producing an address that is wrong an hour later. `gateUntil` is a wall-clock deadline
// resolved at BUILD time, because SnoozeCurve's constructor compares it to block.timestamp —
// so with a gate on, the curve's init code changes every second and there is nothing stable to
// grind. deploy/config.json ships gate.gateMin = 0, which resolves gateUntil to 0, a constant.
if (cfg.curve.gateUntil !== 0n)
  die("gate.gateMin is above zero, so the curve's constructor takes a deadline computed from " +
      "the clock — its init code, its hash and therefore its address all change every second. " +
      "There is nothing here that can be predicted or ground ahead of time. Launch with the " +
      "gate off (gateMin 0), or accept that the curve's address is only knowable at step 4.");

const oracle = oracleDecision(cfg);
if (!oracle.ok) die(oracle.reason);

/* ------------------------------------------------------------------- where the nonce comes from */

let nonce = null, nonceFrom = "";
const stated = value("--nonce");
if (stated !== null) {
  nonce = Number(stated);
  if (!Number.isInteger(nonce) || nonce < 0) die(`--nonce ${stated} is not a whole number ≥ 0`);
  nonceFrom = "stated on the command line";
} else {
  if (!rpc) die(NO_ENDPOINT + "\n\nOr state the wallet's nonce yourself: --nonce <n>. It is the " +
                "transaction count on Basescan, and it is public.");
  // Caught, because everything else in this directory refuses with a sentence and an endpoint
  // that 403s or times out is the most likely thing to go wrong here — an unhandled rejection
  // would print a Node stack trace at somebody who only needs to be told to fix SNOOZE_RPC.
  // redact() again on the way out: fetch attaches the full URL, key and all, to a network
  // error's cause, and this is a message being printed to a terminal that keeps logs.
  try {
    await rpc.requireChain(chainId);
    nonce = await rpc.nonce(cfg.owner);
  } catch (e) {
    die(redact(e.message) + "\n\nThe nonce is public — it is the transaction count on " +
        "Basescan — so this command also runs with no endpoint at all: --nonce <n>.");
  }
  nonceFrom = `read from ${rpc.label} at "latest"`;
}

/* ------------------------------------------------------- the CREATE chain, in transaction order */

// A step that is already verified contributes its RECORDED address and consumes no nonce: it
// has already been sent. So this same command is a prediction before the launch and a plain
// statement of fact during it, and the two never disagree about a step that has happened.
let next = nonce;
const rows = [];
const take = (id, label, note) => {
  if (isVerified(state, id)) {
    const address = stepState(state, id).readBack?.address;
    rows.push({ id, label, address, source: "deployed and verified", note });
    return address;
  }
  const address = createAddress(cfg.owner, next);
  rows.push({ id, label, address, source: `CREATE from your wallet at nonce ${next}`, note });
  next++;
  return address;
};

let oracleAddress;
if (oracle.deployable) {
  oracleAddress = take("oracle", "SnoozeNeverReady", "step 1");
} else {
  oracleAddress = oracle.address;
  rows.push({ id: "oracle", label: "oracle", address: oracleAddress,
              source: "already on chain — deploy/config.json, no nonce spent", note: "step 1" });
}
const deployerAddress = take("deployer", "SnoozeDeployer", "step 2");
const tokenAddress = take("token", "Snooze — THE TOKEN ADDRESS", "step 3");

/* ------------------------------------------------------------------------------- the curve */

const initCode = curveInitCode(artifacts, cfg, tokenAddress);
const initHash = curveInitCodeHash(artifacts, cfg, tokenAddress);
const suffix = cfg.vanity.suffix;

// A salt already in the launch state wins, but only if it was ground against THESE numbers.
// A stale one is the failure this whole file is about, so it is compared rather than trusted.
const recorded = stepState(state, "salt").readBack || {};
const recordedFits = recorded.salt && recorded.initCodeHash === initHash &&
                     sameAddress(recorded.deployer, deployerAddress);

let salt = recordedFits ? recorded.salt : null;
let saltFrom = recordedFits ? "step 4, already ground and verified" : "";

if (!salt && fs.existsSync(PREDICTION_PATH)) {
  try {
    const prev = JSON.parse(fs.readFileSync(PREDICTION_PATH, "utf8"));
    if (prev.initCodeHash === initHash && sameAddress(prev.deployer, deployerAddress) &&
        prev.suffix === suffix && prev.salt) { salt = prev.salt; saltFrom = "predicted earlier"; }
  } catch { /* a corrupt prediction is a prediction to redo, not an error to stop on */ }
}

if (!salt && flag("--grind")) {
  const expected = 16 ** suffix.length;
  const budget = Math.min(Math.ceil(expected * 40), 4e10);
  console.log(bar(`grinding …${suffix} against the PREDICTED token address`));
  console.log(dim(`  about ${expected.toLocaleString()} salts on average, ` +
                  `${budget.toLocaleString()} before it gives up\n`));
  const out = await new Promise(resolve => {
    const k = spawn(process.execPath, [path.join(ROOT, "tools", "vanity-par.mjs"),
      suffix, "--deployer", deployerAddress, "--inithash", initHash, "--max", String(budget)],
      { stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    k.stdout.on("data", d => { buf += d; process.stdout.write(d); });
    k.on("close", c => resolve(c === 0 ? buf : null));
  });
  if (out === null)
    die(`no salt ending …${suffix} in ${budget.toLocaleString()} tries. Nothing was sent and ` +
        "nothing is at stake — but that is far past the expectation, so check the suffix.");
  salt = (out.match(/^salt\s+(0x[0-9a-f]{64})$/m) || [])[1];
  if (!salt) die("could not read a salt out of the grinder's output");
  saltFrom = "ground just now";
}

// Derived here in every case, including when the grinder just printed it. A grinder and a
// checker that share an implementation share its bugs; step 4 does the same thing again.
const curveAddress = salt ? create2Address(deployerAddress, salt, initHash) : null;
if (curveAddress && !curveAddress.toLowerCase().endsWith(suffix))
  die(`${curveAddress} does not end …${suffix} — do not use this salt`);

/* ------------------------------------------------------------------------------- the report */

const CURVE_LABEL = "SnoozeCurve — WHERE ETH GOES";
const W = Math.max(CURVE_LABEL.length, ...rows.map(r => r.label.length));

console.log(bar(`${CHAIN_NAME()} · owner ${toChecksum(cfg.owner)} · nonce ${nonce}`));
console.log(dim(`  ${nonceFrom}\n`));
for (const r of rows) {
  console.log(`  ${bold(r.label.padEnd(W))} ${r.address ? toChecksum(r.address) : red("unknown")}`);
  console.log(dim(`  ${"".padEnd(W)} ${r.source}${r.note ? ` · ${r.note}` : ""}`));
}
console.log(`  ${bold(CURVE_LABEL.padEnd(W))} ` +
            (curveAddress ? toChecksum(curveAddress) : dim("not ground yet")));
console.log(dim(`  ${"".padEnd(W)} ` + (curveAddress
  ? `CREATE2 · ${saltFrom} · step 5`
  : `run again with --grind, or node deploy/scripts/grind.mjs after step 3`)));

console.log("\n" + bar("what these depend on"));
console.log(`  · The owner's wallet sending ${next - nonce} more transaction` +
            `${next - nonce === 1 ? "" : "s"} and ${bold("nothing else in between")}. Any other ` +
            "transaction\n    from this wallet — including one that reverts — moves every " +
            "address above by one slot.");
console.log(`  · The contracts compiling to the same bytes. ${dim("solc " + artifacts.solc.version +
            ", optimizer " + (artifacts.solc.optimizer ? artifacts.solc.runs + " runs" : "off"))}`);
console.log("  · The curve's constructor arguments in deploy/config.json: the token address " +
            "above,\n    virtualEth, curveSupply, bondTarget, feeBps, feeTo. Change one and " +
            "the curve moves.");
console.log(dim(`\n  initCodeHash  ${initHash}`));
if (salt) console.log(dim(`  salt          ${salt}`));

if (salt && !recordedFits) {
  const doc = { chainId, owner: toChecksum(cfg.owner), baseNonce: nonce,
                oracle: oracleAddress ? toChecksum(oracleAddress) : null,
                deployer: toChecksum(deployerAddress), token: toChecksum(tokenAddress),
                curve: toChecksum(curveAddress), suffix, salt, initCodeHash: initHash,
                _note: "A PREDICTION, not a deployment. Valid only while the owner's next " +
                       "transactions are exactly the ones deploy/scripts/plan.mjs lists. " +
                       "grind.mjs reuses this salt only after recomputing the init-code hash " +
                       "from the token that really landed and finding it identical." };
  fs.writeFileSync(PREDICTION_PATH, JSON.stringify(doc, null, 2) + "\n");
  console.log(dim(`\n  written to ${PREDICTION_PATH}`));
  console.log(dim("  step 4 will reuse this salt if the token lands where this says it will."));
}

console.log(`\n  ${green("nothing was sent")} — this command reads a number and does arithmetic.`);

function CHAIN_NAME() { return chainId === 8453 ? "Base" : `chain ${chainId}`; }
