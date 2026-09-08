// Step 4: find a salt that puts the curve on an address ending in the suffix you chose.
//
//   node deploy/scripts/grind.mjs
//
// It computes the REAL init-code hash first — the curve's bytecode with this launch's exact
// constructor arguments appended, including the token address that did not exist until step 3
// — and only then runs tools/vanity-par.mjs against it. Grinding against a placeholder hash
// produces a salt for an address the deployment will not land on, which is the failure this
// script exists to make impossible: the two numbers come from the same place.
//
// It writes the salt into the launch state and stops. Step 4's verify recomputes
// keccak(0xff, deployer, salt, initCodeHash) independently before anything is sent, and step 5
// reads the third derivation off the chain by calling addressOf.
import { spawn } from "node:child_process";
import path from "node:path";
import { context, die, bar, bold, dim, green } from "./lib/run.mjs";
import { pickStep, curveInitCode, curveInitCodeHash } from "./lib/steps.mjs";
import { markVerified, saveState, stepState, STATE_PATH } from "./lib/state.mjs";
import { create2Address, toChecksum } from "./lib/abi.mjs";
import { ROOT } from "./lib/solc.mjs";

const { cfg, artifacts, steps, state, chainId } = await context();
const { step } = pickStep(steps, "salt");

const why = step.blocked();
if (why) die(why);

const deployer = stepState(state, "deployer").readBack?.address;
const token = stepState(state, "token").readBack?.address;
const initCode = curveInitCode(artifacts, cfg, token);
const initHash = curveInitCodeHash(artifacts, cfg, token);

console.log(bar(`grinding …${cfg.vanity.suffix} for ${cfg.vanity.contract}`));
console.log(`  deployer   ${toChecksum(deployer)}`);
console.log(`  token      ${toChecksum(token)}   ${dim("(inside the init code, hence the order)")}`);
console.log(`  init code  ${(initCode.length - 2) / 2} bytes`);
console.log(`  initHash   ${initHash}`);
console.log(dim(`  about ${(16 ** cfg.vanity.suffix.length).toLocaleString()} salts on average\n`));

const args = [cfg.vanity.suffix, "--deployer", deployer, "--inithash", initHash];
const out = await new Promise((resolve, reject) => {
  const k = spawn(process.execPath, [path.join(ROOT, "tools", "vanity-par.mjs"), ...args],
                  { stdio: ["ignore", "pipe", "inherit"] });
  let buf = "";
  k.stdout.on("data", d => { buf += d; process.stdout.write(d); });
  k.on("close", c => c === 0 ? resolve(buf) : reject(new Error("the grinder found nothing")));
});

const salt = (out.match(/^salt\s+(0x[0-9a-f]{64})$/m) || [])[1];
const address = (out.match(/^address\s+(0x[0-9a-f]{40})$/m) || [])[1];
if (!salt || !address) die("could not read a salt out of the grinder's output");

// Recomputed here rather than taken from the grinder. LAUNCH.md 2c asks for the derivation
// twice, independently; a grinder and a checker that share an implementation share its bugs.
const derived = create2Address(deployer, salt, initHash);
if (derived.toLowerCase() !== address.toLowerCase())
  die(`the grinder says ${address} and recomputing says ${derived}. Do not use this salt.`);
if (!derived.toLowerCase().endsWith(cfg.vanity.suffix))
  die(`${derived} does not end …${cfg.vanity.suffix}`);

state.chainId = chainId;
state.owner = cfg.owner;
markVerified(state, "salt", { salt, initCodeHash: initHash, predicted: derived,
                              deployer, token, suffix: cfg.vanity.suffix });
saveState(state);

console.log(`\n  ${green("agreed")}  ${bold(toChecksum(derived))}`);
console.log(dim(`  salt and hash are not secrets — publish them, so a stranger can recompute this.`));
console.log(dim(`  recorded in ${STATE_PATH}`));
console.log(dim(`  Next: node deploy/scripts/build.mjs 5.deploy`));
