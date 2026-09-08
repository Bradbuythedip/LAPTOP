// Grind a CREATE2 salt so the token lands on an address you chose.
//
//   node tools/vanity.mjs beabed            # find a salt for a suffix
//   node tools/vanity.mjs beabed --deployer 0x...   # against a known deployer address
//
// WHAT IS AND IS NOT POSSIBLE. An address is hex, so it can only contain 0-9 and a-f. "BEAR"
// fails on R and "ZZZ" fails on Z — no amount of grinding produces a character the alphabet
// does not have. What does work: bea, bed, beef, face, dead, cafe, feed, babe, and anything
// spelled from those sixteen letters. beabed reads BEA-BED and is six of them.
//
// COST. Each character is one hex digit, so a suffix of n characters takes about 16^n tries on
// average — 4k for three, 65k for four, 16.8M for six. Each try is one keccak of 85 bytes, so
// six characters is a minute of one core and nine is a week of many.
//
// The salt is not a secret and does not need to be. It is published with the address so anybody
// can recompute keccak(0xff, deployer, salt, keccak(initCode)) and check that the address they
// were given is the address the code lands on.
import { keccak256 } from "ethereum-cryptography/keccak.js";

const args = process.argv.slice(2);
const suffix = (args[0] || "beabed").toLowerCase();
const dIdx = args.indexOf("--deployer");
const DEPLOYER = (dIdx >= 0 ? args[dIdx + 1] : "0x" + "11".repeat(20)).toLowerCase();
const iIdx = args.indexOf("--inithash");
const INIT_HASH = iIdx >= 0 ? args[iIdx + 1].replace(/^0x/, "")
                            : "22".repeat(32);   // a stand-in until the real init code exists
const MAX = Number((args[args.indexOf("--max") + 1]) || 40e6);

const HEX = new Set("0123456789abcdef");
const bad = [...suffix].filter(c => !HEX.has(c));
if (bad.length) {
  console.error(`"${suffix}" cannot be an address: ${[...new Set(bad)].join(", ")} ` +
                `${bad.length > 1 ? "are" : "is"} not a hex digit.`);
  console.error("An address has only 0-9 and a-f. Try: bea, bed, beef, face, dead, cafe, beabed.");
  process.exit(2);
}

const bytes = h => Uint8Array.from((h.replace(/^0x/, "").match(/../g) || [])
                                   .map(x => parseInt(x, 16)));
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");

// keccak(0xff ++ deployer(20) ++ salt(32) ++ initCodeHash(32)) -> take the last 20 bytes
const buf = new Uint8Array(85);
buf[0] = 0xff;
buf.set(bytes(DEPLOYER), 1);
buf.set(bytes(INIT_HASH), 53);

// One lane per worker, so N processes can grind the same suffix without ever trying the same
// salt. `--lane N` is set by the parallel runner; on its own the tool uses lane 0.
const lIdx = args.indexOf("--lane");
const LANE = lIdx >= 0 ? Number(args[lIdx + 1]) : 0;

const t0 = Date.now();
let found = null;
for (let i = 0; i < MAX; i++) {
  // The salt is a counter in the last 6 bytes of the 32-byte field, plus a worker id in the
  // two before it so parallel workers never collide.
  //
  // The first version shifted by 32 and 40 and so on. JavaScript's >>> takes its shift count
  // mod 32, so `i >>> 32` is `i` — bytes 24-27 came out as a copy of bytes 28-31 and the
  // search space quietly collapsed to 2^32. Correct answers, half the entropy, no error.
  const s = buf.subarray(21, 53);
  s[24] = (LANE >>> 8) & 0xff; s[25] = LANE & 0xff;
  s[26] = Math.floor(i / 0x100000000) & 0xff;
  s[27] = (i >>> 24) & 0xff; s[28] = (i >>> 16) & 0xff;
  s[29] = (i >>> 8) & 0xff;  s[30] = i & 0xff;
  const addr = hex(keccak256(buf).subarray(12));
  if (addr.endsWith(suffix)) {
    found = { salt: "0x" + hex(buf.subarray(21, 53)), address: "0x" + addr, tries: i + 1 };
    break;
  }
  if (i && i % 2_000_000 === 0)
    process.stderr.write(`  ${(i / 1e6).toFixed(0)}M tried, ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
const secs = (Date.now() - t0) / 1000;
if (!found) {
  console.log(`no salt for "${suffix}" in ${MAX.toLocaleString()} tries (${secs.toFixed(0)}s).`);
  console.log(`expected about ${(16 ** suffix.length).toLocaleString()} — raise --max.`);
  process.exit(1);
}
console.log(`suffix     ...${suffix}`);
console.log(`deployer   ${DEPLOYER}`);
console.log(`initHash   0x${INIT_HASH}`);
console.log(`salt       ${found.salt}`);
console.log(`address    ${found.address}`);
console.log(`tries      ${found.tries.toLocaleString()} in ${secs.toFixed(1)}s ` +
            `(${Math.round(found.tries / secs / 1000)}k/s)`);
console.log(`\nThe salt and the init-code hash are published with the address so anybody can`);
console.log(`recompute it. Change one byte of the contract and the address changes.`);
