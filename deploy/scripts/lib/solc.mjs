// Compile the three contracts this launch actually deploys, and pin what they compile to.
//
// WHY THIS EXISTS ALONGSIDE test/run-deployable.mjs. That script is the go/no-go for the
// launchpad-era contracts — SnoozeLaunchpad, Snooze, PooledLaunchBuy, LaunchTaxRamp — and it
// writes deploy/*.bin for them. The curve launch deploys a different set: SnoozeDeployer,
// Snooze, SnoozeCurve and SnoozeGate. Three of those four have no .bin in deploy/, so there
// is nothing for a wallet to paste and nothing for deploy/deploy.html to send. Rather than
// change a suite that is not mine to change, this compiles the set the sequence needs, with
// the same settings, and writes it beside the others.
//
// SETTINGS ARE PART OF THE BYTECODE. solc 0.8.36, optimizer on, 200 runs — the same three
// facts deploy/README.md tells you to type into Basescan. Change any one and the bytes change,
// the CREATE2 address changes, and the verification does not match. That is why the settings
// are here in one place and not spread across the scripts that use them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";
import { keccakHex, selector } from "./abi.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const SETTINGS = { version: "0.8.36", optimizer: true, runs: 200 };

/// keccak("set(uint256,uint256,bool)")[:4]. Computed once here rather than typed, because a
/// selector typed from memory that is one nibble wrong is a guard that matches nothing and
/// reports a pass. test/run-deploy.mjs checks it against the compiled mock's ABI.
export const SETTER_SELECTOR = selector("set(uint256,uint256,bool)").slice(2);

/// The contracts a curve launch deploys, in the order the sequence deploys them.
///
/// SnoozeGate is NOT here, and its absence is deliberate. Its constructor wants a Merkle root
/// over a snapshot that has not been taken, a snapshot block that does not exist yet, and a
/// claimUntil that must be in the future at the moment it is sent — none of which can be known
/// during this sequence. A compiled-but-undeployable blob in artifacts.json is an invitation
/// to paste bytecode by hand, so it is left out until there is a step that deploys it. Note
/// that a sealed SnoozeDeployer cannot deploy it later: the gate needs its own deployer, or
/// the seal has to wait.
export const DEPLOYABLE = ["SnoozeDeployer", "Snooze", "SnoozeCurve"];

const SOURCES = [
  "contracts/SnoozeDeployer.sol", "contracts/Snooze.sol", "contracts/SnoozeCurve.sol",
];
/// Compiled only so its runtime bytecode can be BLOCKED. See fingerprints below.
const REFUSED_SOURCES = ["contracts/test/SnoozeMocks.sol"];

export function compileAll() {
  const sources = {};
  for (const f of [...SOURCES, ...REFUSED_SOURCES])
    sources[path.basename(f)] = { content: fs.readFileSync(path.join(ROOT, f), "utf8") };
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: SETTINGS.optimizer, runs: SETTINGS.runs },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object",
                                      "evm.deployedBytecode.object"] } },
    },
  })));
  const errors = (out.errors || []).filter(e => e.severity === "error");
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join("\n"));
  const merged = {};
  for (const f of Object.keys(out.contracts || {})) Object.assign(merged, out.contracts[f]);
  return { all: merged, warnings: (out.errors || []).filter(e => e.severity === "warning") };
}

/// The deployable set as {name: {initCode, runtime, initCodeHash, runtimeHash, abi, ctor}}.
/// `initCode` is the constructor code with NO arguments appended; a step appends its own.
export function artifacts() {
  const { all, warnings } = compileAll();
  // The settings are recorded next to the bytes they produced. The CREATE2 ground address is
  // derived from this bytecode, so "which compiler made it" is part of the address, and a
  // build.mjs that silently used a different one would emit a transaction landing somewhere
  // other than the salt was ground for.
  const out = { solc: SETTINGS, contracts: {}, refuse: {} };
  for (const n of DEPLOYABLE) {
    if (!all[n]) throw new Error(`${n} did not compile`);
    const initCode = "0x" + String(all[n].evm.bytecode.object).replace(/^0x/, "");
    const runtime = "0x" + String(all[n].evm.deployedBytecode?.object || "").replace(/^0x/, "");
    const ctor = all[n].abi.find(f => f.type === "constructor");
    out.contracts[n] = {
      initCode, runtime,
      // The hash of the init code WITHOUT arguments is not the CREATE2 input — the real one
      // includes the encoded constructor arguments, which is exactly why the salt is ground
      // last. This is published so a reader can tell the two apart rather than assume.
      initCodeHashNoArgs: keccakHex(initCode),
      runtimeHash: keccakHex(runtime),
      initCodeBytes: (initCode.length - 2) / 2,
      runtimeBytes: (runtime.length - 2) / 2,
      constructorInputs: ctor ? ctor.inputs.map(i => `${i.type} ${i.name}`) : [],
      abi: all[n].abi,
    };
  }
  // The blocklist, by content rather than by address. An oracle is chosen by whoever runs this
  // sequence, so the only durable way to refuse the settable mock is to recognise what it
  // compiles to.
  //
  // THE HASH IS THE WEAK HALF and it is recorded anyway. Solidity appends a CBOR metadata tail
  // containing a hash of the source and the compiler settings, so the same mock built by
  // anybody else has a different runtime hash and walks straight past an equality check. The
  // durable half is the SELECTOR: a dispatcher for set(uint256,uint256,bool) has to appear in
  // the runtime of anything that has that function, whoever compiled it. Both are published,
  // and lib/oracle.mjs is careful to claim only what each one proves.
  for (const n of ["MockOracle"]) {
    if (!all[n]) continue;
    const runtime = "0x" + String(all[n].evm.deployedBytecode?.object || "").replace(/^0x/, "");
    out.refuse[n] = {
      runtime, runtimeHash: keccakHex(runtime),
      selectors: { "set(uint256,uint256,bool)": SETTER_SELECTOR },
      why: "settable: whoever holds it sets every sale's burn, up to the 90% cap, forever",
    };
  }
  return { artifacts: out, warnings };
}

export const ARTIFACTS_JSON = path.join(ROOT, "deploy", "artifacts.json");
export const ARTIFACTS_JS = path.join(ROOT, "deploy", "artifacts.js");

/// Read what was written. deploy/deploy.html loads the .js twin of this under file://, where
/// fetch() of a sibling file is blocked by the browser and a classic <script src> is not.
export function loadArtifacts() {
  if (!fs.existsSync(ARTIFACTS_JSON))
    throw new Error("deploy/artifacts.json is missing. Run:\n" +
                    "  node deploy/scripts/artifacts.mjs");
  return JSON.parse(fs.readFileSync(ARTIFACTS_JSON, "utf8"));
}
