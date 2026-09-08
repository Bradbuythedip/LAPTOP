// ABI encoding and decoding, written out rather than imported.
//
// WHY NOT ethers OR viem. Everything in this directory has one job: show you the exact bytes
// you are about to hand a wallet, and read the answer back. A library that encodes for you is
// a library whose bugs are indistinguishable from the contract's — test/evm.mjs made the same
// call for the same reason, and the deploy path has a stronger version of it: a wrong word in
// a constructor is not a failed test, it is an immutable address holding the wrong parameter
// forever. The subset here is small enough to read in one sitting and every piece of it is
// exercised against the real compiled contracts in test/run-deploy.mjs.
//
// What is supported: address, bool, uintN, bytes32, and the one dynamic type this deployment
// actually needs — `bytes`, for SnoozeDeployer.deploy(bytes32,bytes). Nothing else, on
// purpose: an encoder that handles types nobody sends is surface with no test behind it.
import { keccak256 } from "ethereum-cryptography/keccak.js";

const enc = new TextEncoder();

export const strip = h => String(h ?? "").replace(/^0x/, "");
export const bytes = h => Uint8Array.from((strip(h).match(/../g) || [])
                                          .map(x => parseInt(x, 16)));
export const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");

/// keccak of raw bytes given as hex. `0x`-prefixed in, `0x`-prefixed out.
export const keccakHex = h => "0x" + hex(keccak256(bytes(h)));
/// keccak of a UTF-8 string, which is what a function signature is.
export const keccakText = s => "0x" + hex(keccak256(enc.encode(s)));
/// The 4-byte selector of a canonical signature, e.g. "owner()" -> "0x8da5cb5b".
export const selector = sig => keccakText(sig).slice(0, 10);

/* -------------------------------------------------------------------- static words */

/// One 32-byte word. Accepts a bigint, a decimal string, a boolean, or 0x-hex.
export function word(v) {
  let h;
  if (typeof v === "boolean") h = v ? "1" : "0";
  else if (typeof v === "string" && v.startsWith("0x")) h = strip(v).toLowerCase();
  else h = BigInt(v).toString(16);
  if (h.length > 64) throw new Error("word overflow: " + h);
  return h.padStart(64, "0");
}

/// An address as a word, with the width checked. A 39- or 41-character address pasted from a
/// chat window is the classic way to send a constructor argument that is silently a different
/// address; padStart would accept it and this does not.
export function addressWord(a) {
  const h = strip(a).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`not a 20-byte address: ${a}`);
  return h.padStart(64, "0");
}

/// A uint, range-checked against its declared width. `uint64 gateUntil` silently truncating a
/// millisecond timestamp is a gate that closes 50,000 years early or never.
export function uintWord(v, bits = 256) {
  const n = BigInt(v);
  if (n < 0n) throw new Error(`uint${bits} cannot be negative: ${v}`);
  if (n >= (1n << BigInt(bits))) throw new Error(`does not fit in uint${bits}: ${v}`);
  return word(n);
}

export function bytes32Word(v) {
  const h = strip(v).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`not 32 bytes: ${v}`);
  return h;
}

/* ------------------------------------------------------------------- dynamic bytes */

/// `bytes` as a head/tail pair. The head is the offset from the start of the argument block;
/// the tail is length then data, right-padded to a whole number of words.
///
/// This is the encoding SnoozeDeployer.deploy(bytes32,bytes) wants, and it is the one place a
/// hand-rolled encoder usually gets it wrong: the offset is measured from the start of the
/// ARGUMENTS, not from the start of the calldata, so it does not include the 4-byte selector.
/// test/run-deploy.mjs checks the result against the real contract by actually deploying
/// through it in an in-process EVM, which is the only check that would have caught this.
export function encodeDeployCall(salt, initCodeHex) {
  const data = strip(initCodeHex).toLowerCase();
  if (!/^[0-9a-f]*$/.test(data)) throw new Error("init code is not hex");
  if (data.length % 2) throw new Error("init code has an odd number of hex digits");
  const pad = (64 - (data.length % 64)) % 64;
  const head = bytes32Word(salt) + word(0x40);        // two args, so the tail starts at 0x40
  const tail = word(data.length / 2) + data + "0".repeat(pad);
  return selector("deploy(bytes32,bytes)") + head + tail;
}

/* ---------------------------------------------------------------------- decoding */

/// Split return data into words. Returns [] for "0x", which is what a call to an address with
/// no code returns — see readUint's insistence on a full word for why that matters.
export function words(hexData) {
  const b = strip(hexData);
  const out = [];
  for (let i = 0; i + 64 <= b.length; i += 64) out.push("0x" + b.slice(i, i + 64));
  return out;
}

/// A failed read is never a zero. This is the same discipline web/buy.html applies to wallet
/// reads, and it matters more here: `oracle()` returning 0x because the address has no code
/// would otherwise decode as the zero address, which is exactly the value the constructor
/// refuses — so the verify step would report the one failure it exists to catch as a pass.
export function readUint(hexData, i = 0) {
  const w = words(hexData)[i];
  if (w === undefined) throw new Error("short return data: " + hexData);
  return BigInt(w);
}

export function readBool(hexData, i = 0) { return readUint(hexData, i) !== 0n; }

export function readAddress(hexData, i = 0) {
  const n = readUint(hexData, i);
  if (n >= (1n << 160n)) throw new Error("return word is not an address: " + hexData);
  return "0x" + n.toString(16).padStart(40, "0");
}

/// ABI `string`: an offset word, then a length word, then the bytes.
///
/// `name()` and `symbol()` on Snooze are `string public constant`, and solc still returns them
/// through the ordinary dynamic encoding — the constant lives in the runtime code rather than
/// in storage, but the ABI shape is unchanged. Decoding these as a bytes32 (which is what the
/// short version of this function did first) returns the length prefix as if it were text and
/// reports the symbol as garbage that happens to be non-empty, which a truthiness check passes.
export function readString(hexData) {
  const b = strip(hexData);
  if (b.length < 128) throw new Error("too short to be an ABI string: " + hexData);
  const off = Number(BigInt("0x" + b.slice(0, 64)));
  if (!Number.isSafeInteger(off) || off * 2 + 64 > b.length)
    throw new Error("string offset points past the end of the return data");
  const len = Number(BigInt("0x" + b.slice(off * 2, off * 2 + 64)));
  if (!Number.isSafeInteger(len) || (off + 32 + len) * 2 > b.length)
    throw new Error("string length runs past the end of the return data");
  const raw = b.slice((off + 32) * 2, (off + 32 + len) * 2);
  return new TextDecoder().decode(bytes(raw));
}

/* ------------------------------------------------------------------------ CREATE2 */

/// keccak(0xff ++ deployer ++ salt ++ keccak(initCode))[12:], which is what
/// SnoozeDeployer.addressOf computes on chain. Computed here as well as read from the chain,
/// deliberately: two independent derivations that agree is the check, and LAUNCH.md asks for
/// exactly that ("derive the predicted address twice, independently").
export function create2Address(deployer, salt, initCodeHash) {
  const pre = "ff" + strip(deployer).toLowerCase().padStart(40, "0")
            + bytes32Word(salt) + bytes32Word(initCodeHash);
  if (pre.length !== 170) throw new Error("create2 preimage is not 85 bytes");
  return "0x" + hex(keccak256(bytes(pre))).slice(24);
}

/// The OTHER address derivation, the one nobody grinds: a plain CREATE lands at
/// keccak(rlp([sender, nonce]))[12:]. No salt, no init code — the bytes being deployed do not
/// enter into it at all, which is why the token's address is knowable before the token is
/// compiled and why it CANNOT be chosen. Two consequences this deployment lives on:
///
///   1. Every address in the sequence except the curve's is a function of the owner's wallet
///      and its nonce, so deploy/scripts/predict.mjs can print all of them before a wei is
///      spent — and the curve's follows, because its constructor argument is the token.
///   2. A nonce is consumed by ANY transaction from that wallet, including one that reverts
///      and one sent by hand from a phone. Predict, then send only the planned transactions.
///
/// RLP, inline, for the one shape needed: a 20-byte string and a small integer in a list.
export function createAddress(sender, nonce) {
  const a = strip(sender).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error("not a 20-byte address: " + sender);
  const n = BigInt(nonce);
  if (n < 0n) throw new Error("a nonce cannot be negative: " + nonce);

  // A single byte below 0x80 is its own encoding, and ZERO IS THE EMPTY STRING 0x80 rather
  // than 0x00 — the one case that is wrong in most hand-rolled RLP and the one that matters
  // here, because a freshly funded wallet deploying its first contract is at nonce 0.
  let nHex;
  if (n === 0n) nHex = "80";
  else if (n < 0x80n) nHex = n.toString(16).padStart(2, "0");
  else {
    let h = n.toString(16);
    if (h.length % 2) h = "0" + h;
    if (h.length / 2 > 8) throw new Error("nonce is absurd: " + nonce);
    nHex = (0x80 + h.length / 2).toString(16) + h;
  }

  const payload = "94" + a + nHex;                 // 0x80+20 = 0x94, the 20-byte string header
  const list = (0xc0 + payload.length / 2).toString(16) + payload;   // always under 56 bytes
  return "0x" + hex(keccak256(bytes(list))).slice(24);
}

/* ---------------------------------------------------------------------- checksums */

/// EIP-55. Printed everywhere an address is shown, because the whole point of a checksummed
/// address is that a transposed character stops being a valid address rather than a valid
/// address belonging to nobody.
export function toChecksum(addr) {
  const a = strip(addr).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error("not an address: " + addr);
  const h = hex(keccak256(enc.encode(a)));
  let out = "0x";
  for (let i = 0; i < 40; i++)
    out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

export const sameAddress = (a, b) =>
  /^0x[0-9a-fA-F]{40}$/.test(String(a ?? "")) &&
  /^0x[0-9a-fA-F]{40}$/.test(String(b ?? "")) &&
  String(a).toLowerCase() === String(b).toLowerCase();

export const ZERO = "0x" + "0".repeat(40);
