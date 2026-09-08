// Can these contracts actually be deployed to Base from a wallet?
//
// This is a go/no-go, not a unit test. It asks the questions that stop a deployment dead
// after you have already paid gas: is the runtime bytecode under the EIP-170 limit, does the
// constructor encoding you are about to paste actually work, and what does it cost.
//
// It does NOT deploy anything anywhere. There is no key here and there must not be — this
// environment has no outbound network access and would be the wrong place to hold one even
// if it did. Deployment happens from your own wallet, with the artifacts this writes.
//   node test/run-deployable.mjs
import fs from "node:fs";
import path from "node:path";
import { compile, deploy, call, fund, encodeCall } from "./evm.mjs";
import { createEVM } from "@ethereumjs/evm";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push("  ok   " + name); }
  else { fail++; results.push("  FAIL " + name + (extra ? "\n         " + extra : "")); }
}

const E = 10n ** 18n;
/// EIP-170. A contract whose RUNTIME code exceeds this cannot be deployed at all, and the
/// transaction fails after the constructor has already run and been paid for.
const MAX_RUNTIME = 24576;
/// EIP-3860. The init code (constructor + runtime + args) has its own, larger, limit.
const MAX_INITCODE = 49152;

const FILES = [
  "contracts/SnoozeLaunchpad.sol", "contracts/Snooze.sol", "contracts/PooledLaunchBuy.sol",
  "contracts/LaunchTaxRamp.sol", "contracts/test/Mocks.sol", "contracts/test/SnoozeMocks.sol",
];
const DEPLOYABLE = ["SnoozeLaunchpad", "Snooze", "PooledLaunchBuy", "LaunchTaxRamp"];

console.log("── it compiles for deployment");
const { all, warnings } = compile(FILES);
ok("every deployable contract compiles", DEPLOYABLE.every(n => !!all[n]),
   DEPLOYABLE.filter(n => !all[n]).join(","));
ok("with no warnings", warnings.length === 0,
   warnings.map(w => w.message.split("\n")[0]).join("; "));

console.log("── size, which is the limit that stops a deployment dead");
const sizes = {};
for (const n of DEPLOYABLE) {
  const init = all[n].evm.bytecode.object.replace(/^0x/, "");
  const runtime = (all[n].evm.deployedBytecode?.object || "").replace(/^0x/, "");
  sizes[n] = { init: init.length / 2, runtime: runtime.length / 2 };
  ok(`${n} init code is under the EIP-3860 limit`,
     sizes[n].init <= MAX_INITCODE, `${sizes[n].init} > ${MAX_INITCODE}`);
  if (runtime) {
    ok(`${n} runtime is under the EIP-170 limit`,
       sizes[n].runtime <= MAX_RUNTIME,
       `${sizes[n].runtime} > ${MAX_RUNTIME} — this cannot be deployed at any gas price`);
    ok(`${n} has headroom, not a squeak past the line`,
       sizes[n].runtime < MAX_RUNTIME * 0.9,
       `${sizes[n].runtime} is ${(sizes[n].runtime / MAX_RUNTIME * 100).toFixed(1)}% of the limit`);
  }
}

console.log("── the constructor arguments you will paste actually work");
const gas = {};
{
  // Every deployment below runs the real constructor with real encoded arguments. If the
  // encoding is wrong the deployment reverts here rather than on Base.
  const evm = await createEVM();
  const DEPLOYER = "0x1000000000000000000000000000000000000001";
  await fund(evm, DEPLOYER, 1000n * E);
  const w = v => (typeof v === "string" && v.startsWith("0x")
    ? v.slice(2) : BigInt(v).toString(16)).padStart(64, "0");

  const lp = await deploy(all.SnoozeLaunchpad.evm.bytecode.object, "", { evm })
    .then(r => r).catch(e => e);
  ok("SnoozeLaunchpad deploys with no constructor arguments", !(lp instanceof Error),
     String(lp));
  if (!(lp instanceof Error)) gas.SnoozeLaunchpad = lp.gasUsed;

  const orc = await deploy(all.MockOracle.evm.bytecode.object, "", { evm });
  await call({ evm, address: orc.address }, "set(uint256,uint256,bool)", [E, E, 1]);

  const tok = await deploy(all.Snooze.evm.bytecode.object,
    [1_000_000_000_000n * E, orc.address.toString(),
     "0x00000000000000000000000000000000000000de", 0].map(w).join(""), { evm })
    .then(r => r).catch(e => e);
  ok("Snooze deploys with (supply, oracle, dev, devBps)", !(tok instanceof Error), String(tok));
  if (!(tok instanceof Error)) gas.Snooze = tok.gasUsed;

  const pool = await deploy(all.PooledLaunchBuy.evm.bytecode.object,
    [orc.address.toString(), orc.address.toString(), 1000, 1000 + 86400 * 2, 0, 500, 1]
      .map(w).join(""), { evm })
    .then(r => r).catch(e => e);
  ok("PooledLaunchBuy deploys with its seven arguments", !(pool instanceof Error), String(pool));
  if (!(pool instanceof Error)) gas.PooledLaunchBuy = pool.gasUsed;

  const ramp = await deploy(all.LaunchTaxRamp.evm.bytecode.object,
    [0, 0, 100, 100, 0, 1000, 500, 0, "0x00000000000000000000000000000000000005ee"]
      .map(w).join(""), { evm })
    .then(r => r).catch(e => e);
  ok("LaunchTaxRamp deploys with its schedule struct", !(ramp instanceof Error), String(ramp));
  if (!(ramp instanceof Error)) gas.LaunchTaxRamp = ramp.gasUsed;

  // The one that matters most: a launch from a plain EOA, which is what a wallet is.
  const rtr = await deploy(all.SnoozeRouter.evm.bytecode.object,
    w("0x0000000000000000000000000000000000000001"), { evm });
  const params = [1_000_000_000_000n * E, orc.address.toString(),
    "0x00000000000000000000000000000000000000de", 0, rtr.address.toString(),
    100000, 100000 + 86400 * 2, 0, 0, 1].map(w).join("");
  const r = await call(lp, "launch((uint256,address,address,uint256,address,uint64,uint64,uint256,uint256,uint256))",
    [], { from: DEPLOYER, timestamp: 1000, raw: params });
  ok("and a launch succeeds when sent from an ordinary externally-owned account", r.ok,
     r.revert);
  gas["launch() itself"] = r.gasUsed;

  // Gas is the other way a deployment fails after you have paid for it: a transaction that
  // needs more than a block can hold never lands, at any price. launch() deploys two
  // contracts and makes five state-changing calls inside one transaction, so it is the one
  // to watch. Base inherits Ethereum's 30M block gas limit; a single transaction that wants
  // more than half a block is already at the mercy of what else is in it.
  //
  // These are EXECUTION gas from an in-process EVM. They exclude the 21,000 intrinsic cost
  // and the per-byte charge on the calldata, and they are not a quote — they are a check that
  // nothing here is anywhere near the ceiling.
  const BLOCK_GAS = 30_000_000;
  for (const [n, g] of Object.entries(gas)) {
    ok(`${n} fits in a block with room to spare`, Number(g) < BLOCK_GAS / 2,
       `${g} gas is more than half of a ${BLOCK_GAS} block`);
  }
}

console.log("── nothing here holds or wants a key");
{
  const src = FILES.filter(f => !f.includes("/test/"))
    .map(f => fs.readFileSync(f, "utf8")).join("\n");
  ok("no contract stores a private key, seed or mnemonic",
     !/privateKey|mnemonic|seedPhrase/i.test(src));
  // Built from fragments so the pattern does not match the line that defines it — the same
  // self-match that made the delegatecall check in run-pooled.mjs pass while meaning nothing.
  const secret = new RegExp(["priv", "ate", "Key"].join("") + "|" +
                            ["mnem", "onic"].join("") + "|" + ["seed", "Phrase"].join(""), "i");
  const harness = fs.readFileSync("test/evm.mjs", "utf8");
  ok("and neither does the harness that writes the artifacts",
     !secret.test(harness), "the harness references key material");
  ok("the pattern is not matching itself", !secret.test("this line has no key material"));
  ok("but it does match the thing it is looking for", secret.test("const privateKey = 1"));
}

console.log("── write the artifacts a wallet actually needs");
{
  const outDir = "deploy";
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = [];
  for (const n of DEPLOYABLE) {
    const bytecode = "0x" + all[n].evm.bytecode.object.replace(/^0x/, "");
    fs.writeFileSync(path.join(outDir, `${n}.abi.json`), JSON.stringify(all[n].abi, null, 2));
    fs.writeFileSync(path.join(outDir, `${n}.bin`), bytecode);
    const ctor = all[n].abi.find(f => f.type === "constructor");
    manifest.push({
      contract: n,
      initCodeBytes: sizes[n].init,
      runtimeBytes: sizes[n].runtime,
      // Execution gas only: no 21,000 intrinsic, no calldata charge. A floor, not a quote.
      deployExecutionGas: gas[n] === undefined ? null : Number(gas[n]),
      constructorInputs: ctor ? ctor.inputs.map(i => `${i.type} ${i.name}`) : [],
    });
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  ok("an ABI and a bin exist for every deployable contract",
     DEPLOYABLE.every(n => fs.existsSync(path.join(outDir, `${n}.abi.json`))
                        && fs.existsSync(path.join(outDir, `${n}.bin`))));
  ok("and a manifest listing the constructor arguments each one wants",
     fs.existsSync(path.join(outDir, "manifest.json")));
  const bin = fs.readFileSync(path.join(outDir, "SnoozeLaunchpad.bin"), "utf8");
  ok("the bin is 0x-prefixed hex a wallet can paste", /^0x[0-9a-f]+$/.test(bin));
  ok("and is the same bytes the harness just deployed successfully",
     bin.slice(2) === all.SnoozeLaunchpad.evm.bytecode.object.replace(/^0x/, ""));
}

console.log("\n" + results.join("\n"));
console.log("\nsizes (bytes):");
for (const n of DEPLOYABLE)
  console.log(`  ${n.padEnd(18)} init ${String(sizes[n].init).padStart(6)}   ` +
              `runtime ${String(sizes[n].runtime).padStart(6)}   ` +
              `${(sizes[n].runtime / MAX_RUNTIME * 100).toFixed(1)}% of the EIP-170 limit`);
console.log("\ndeployment gas (execution only, no 21k intrinsic, no calldata charge):");
for (const [n, g] of Object.entries(gas))
  console.log(`  ${n.padEnd(18)} ${String(g).padStart(9)}  ` +
              `${(Number(g) / 30_000_000 * 100).toFixed(1)}% of a 30M block`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
