// Compile and execute Solidity in-process. No network, no testnet, no RPC.
//
// solc ships as WASM and @ethereumjs/evm is a real EVM interpreter, so a contract can be
// compiled and its opcodes actually executed here — the arithmetic is run, not read. This is
// strictly weaker than a testnet: there is no PoolManager, no other contract to integrate
// with, no gas market and no reorg. It catches arithmetic and ordering bugs. It cannot catch
// an integration bug against a contract that is not present.
import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { createEVM } from "@ethereumjs/evm";
import { createAddressFromString, hexToBytes, bytesToHex, createAccount } from "@ethereumjs/util";

export function compile(files) {
  const list = Array.isArray(files) ? files : [files];
  const sources = {};
  for (const f of list) sources[path.basename(f)] = { content: fs.readFileSync(f, "utf8") };
  const name = path.basename(list[0]);
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  })));
  const errors = (out.errors || []).filter(e => e.severity === "error");
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join("\n"));
  const warnings = (out.errors || []).filter(e => e.severity === "warning");
  const merged = {};
  for (const f of Object.keys(out.contracts || {})) Object.assign(merged, out.contracts[f]);
  return { contracts: out.contracts[name], all: merged, warnings };
}

/* ---- minimal ABI coding, so the harness does not depend on a library whose own bugs
        would be indistinguishable from the contract's ---- */
const KEC = await (async () => {
  const { keccak256 } = await import("ethereum-cryptography/keccak.js");
  return keccak256;
})();
const enc = new TextEncoder();
export const selector = sig => bytesToHex(KEC(enc.encode(sig))).slice(0, 10);

const word = v => {
  let h;
  if (typeof v === "boolean") h = v ? "1" : "0";
  else if (typeof v === "string" && v.startsWith("0x")) h = v.slice(2).toLowerCase();
  else h = BigInt(v).toString(16);
  if (h.length > 64) throw new Error("word overflow: " + h);
  return h.padStart(64, "0");
};
export const encodeCall = (sig, args = []) => selector(sig) + args.map(word).join("");
export const decodeWords = hex => {
  const b = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = [];
  for (let i = 0; i + 64 <= b.length; i += 64) out.push(BigInt("0x" + b.slice(i, i + 64)));
  return out;
};

const DEPLOYER = createAddressFromString("0x1000000000000000000000000000000000000001");

export async function deploy(bytecodeHex, ctorArgsHex = "", opts = {}) {
  const evm = opts.evm || await createEVM();
  const r = await evm.runCall({
    caller: opts.from ? createAddressFromString(opts.from) : DEPLOYER,
    to: undefined, gasLimit: 30_000_000n,
    data: hexToBytes("0x" + bytecodeHex.replace(/^0x/, "") + ctorArgsHex.replace(/^0x/, "")),
    block: { header: { number: BigInt(opts.blockNumber ?? 1),
                       timestamp: BigInt(opts.timestamp ?? 1000) } },
  });
  if (r.execResult.exceptionError)
    throw new Error("deploy reverted: " + r.execResult.exceptionError.error);
  return { evm, address: r.createdAddress };
}

/// Run a call. Returns {ok, words, raw, revert} — a revert is a result, not a throw, so a
/// test can assert that something reverts without wrapping every call in try/catch.
/// `opts.raw` supplies pre-encoded argument words for signatures the minimal encoder cannot
/// build — a struct tuple, say. The selector still comes from `sig`, so a typo in the
/// signature still fails loudly rather than calling the fallback.
export async function call(ctx, sig, args = [], opts = {}) {
  const data = opts.raw !== undefined
    ? selector(sig) + opts.raw.replace(/^0x/, "")
    : encodeCall(sig, args);
  const r = await ctx.evm.runCall({
    caller: opts.from ? createAddressFromString(opts.from) : DEPLOYER,
    to: ctx.address, gasLimit: 10_000_000n,
    data: hexToBytes(data),
    value: BigInt(opts.value ?? 0),
    block: { header: { number: BigInt(opts.blockNumber ?? 1),
                       timestamp: BigInt(opts.timestamp ?? 1000) } },
  });
  const raw = bytesToHex(r.execResult.returnValue);
  if (r.execResult.exceptionError)
    return { ok: false, revert: r.execResult.exceptionError.error, raw, words: [] };
  return { ok: true, raw, words: decodeWords(raw) };
}

/// Give an address a balance, so a depositor can actually send ETH.
export async function fund(evm, addr, wei) {
  const a = createAddressFromString(addr);
  const existing = await evm.stateManager.getAccount(a);
  const acct = existing || createAccount({});
  acct.balance = BigInt(wei);
  await evm.stateManager.putAccount(a, acct);
}

export async function balance(evm, addr) {
  const a = typeof addr === "string" ? createAddressFromString(addr) : addr;
  const acct = await evm.stateManager.getAccount(a);
  return acct ? acct.balance : 0n;
}

export { createAddressFromString };
