// The bit every command does before it does its own thing: load the config, refuse if it is
// wrong, compile, and build the steps against whatever the chain has already confirmed.
//
// It is here rather than repeated in four files because "refuse on a bad config" is only a
// rule if every entry point does it, and the one that forgets is the one that gets run.
import fs from "node:fs";
import { loadConfig } from "./config.mjs";
import { artifacts as compileArtifacts, loadArtifacts, ARTIFACTS_JSON, ROOT } from "./solc.mjs";
import { loadState, STATE_PATH } from "./state.mjs";
import { buildSteps } from "./steps.mjs";
import { rpcFromEnv, chainFromEnv, NO_ENDPOINT } from "./rpc.mjs";
import { keccakHex } from "./abi.mjs";

export const bar = (t = "") => "── " + t;

/// ANSI only when something is going to interpret it. A log file full of escape codes is a log
/// file nobody greps.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
export const red = s => tty ? `[31m${s}[0m` : s;
export const green = s => tty ? `[32m${s}[0m` : s;
export const dim = s => tty ? `[2m${s}[0m` : s;
export const bold = s => tty ? `[1m${s}[0m` : s;

export function die(msg) {
  console.error("\n" + red("refused") + "  " + String(msg).replace(/\n/g, "\n         ") + "\n");
  process.exit(1);
}

/// Compile fresh AND compare against what is committed. Two generators write bytecode into
/// deploy/ — test/run-deployable.mjs writes the .bin files, this writes artifacts.json — and
/// the CREATE2 ground address is derived from bytecode, so a stale artifacts.json is a
/// transaction that lands somewhere other than the salt was ground for. Neither file is
/// trusted over the other; a disagreement stops the run.
export function resolveArtifacts({ allowStale = false } = {}) {
  const { artifacts: fresh, warnings } = compileArtifacts();
  if (warnings.length)
    die("the contracts compile with warnings, and this deployment will not be sent from a " +
        "build nobody looked at:\n" + warnings.map(w => w.message.split("\n")[0]).join("\n"));
  if (!fs.existsSync(ARTIFACTS_JSON)) {
    if (allowStale) return fresh;
    die("deploy/artifacts.json does not exist yet. Run:\n  node deploy/scripts/artifacts.mjs");
  }
  const onDisk = loadArtifacts();
  for (const [name, c] of Object.entries(fresh.contracts)) {
    const was = onDisk.contracts?.[name];
    if (!was) die(`deploy/artifacts.json has no ${name}. Run: node deploy/scripts/artifacts.mjs`);
    if (keccakHex(was.initCode) !== keccakHex(c.initCode))
      die(`deploy/artifacts.json is stale: ${name} compiles to different bytes than the file ` +
          "records. contracts/ has changed since it was written, and every ground address " +
          "changes with it.\n  node deploy/scripts/artifacts.mjs");
  }
  return fresh;
}

/// Everything a command needs, or a refusal. `needChain` makes the RPC mandatory.
export async function context({ needChain = false } = {}) {
  const cfg = loadConfig();
  if (cfg.problems.length)
    die("deploy/config.json:\n" + cfg.problems.map(p => "  · " + p).join("\n"));

  const chainId = chainFromEnv();
  if (chainId !== cfg.raw.chainId && chainId !== 84532)
    die(`SNOOZE_CHAIN is ${chainId} and deploy/config.json says ${cfg.raw.chainId}`);

  const artifacts = resolveArtifacts();
  const state = loadState(STATE_PATH, { chainId, owner: cfg.owner });

  let rpc = rpcFromEnv();
  if (needChain) {
    if (!rpc) die(NO_ENDPOINT);
    await rpc.requireChain(chainId);
  }
  const steps = buildSteps({ cfg, artifacts, state });
  return { cfg, artifacts, state, steps, rpc, chainId, ROOT };
}

/// Run a step's read-backs. `target` is the address the step is about; extraCalls carry their
/// own `to`, because some of a step's evidence lives on a different contract.
export async function readStep(rpc, step, { address }) {
  const results = {};
  const target = address || (step.verify.target && step.verify.target());
  for (const call of step.verify.calls || []) {
    if (!target) { results[call.sig] = { ok: false, error: "no address to call" }; continue; }
    results[call.sig] = await rpc.call(target, "0x" + call.data.replace(/^0x/, ""));
  }
  for (const call of (step.verify.extraCalls ? step.verify.extraCalls() : []))
    results[call.sig] = await rpc.call(call.to, "0x" + call.data.replace(/^0x/, ""));
  const code = target ? await rpc.code(target) : "";
  return { results, code: code ? "0x" + code : "0x", address: target };
}

export function printChecks(list) {
  let bad = 0;
  for (const c of list) {
    console.log(`  ${c.ok ? green("ok  ") : red("FAIL")} ${c.name}` +
                (c.detail && (!c.ok || /^0x/.test(c.detail)) ? "\n         " + dim(c.detail) : ""));
    if (!c.ok) bad++;
  }
  return bad;
}
