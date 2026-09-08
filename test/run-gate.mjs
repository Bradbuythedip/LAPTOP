// Tests for contracts/SnoozeGate.sol — the reason you need $SNOOZE to get LAPTOP.
//
// The design question this suite is really about: a gate that makes people buy a token which
// is expensive to exit is a trap. This one reads a balance at a block and takes custody of
// nothing, so most of what follows checks that there is genuinely no way for it to hold, lock
// or take anybody's $SNOOZE — and that the Merkle proof cannot be forged, reused, or claimed
// on somebody else's behalf.
import fs from "node:fs";
import { compile, deploy, call } from "./evm.mjs";
import { createEVM } from "@ethereumjs/evm";
const { keccak256 } = await import("ethereum-cryptography/keccak.js");

let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { if (c) { pass++; results.push("  ok   " + n); }
  else { fail++; results.push("  FAIL " + n + (x ? "\n         " + x : "")); } };

const E = 10n ** 18n;
const w = v => (typeof v === "string" && v.startsWith("0x") ? v.slice(2)
                : BigInt(v).toString(16)).padStart(64, "0");
const hex = b => "0x" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
const bytes = h => Uint8Array.from((h.replace(/^0x/, "").match(/../g) || [])
                                   .map(x => parseInt(x, 16)));
const { all, warnings } = compile(["contracts/SnoozeGate.sol", "contracts/test/Mocks.sol"]);

// A Merkle tree over keccak256(abi.encodePacked(address, uint256)), sorted-pair hashing —
// the same shape the contract verifies, written here independently of it.
const leafOf = (addr, amt) =>
  keccak256(bytes(addr.toLowerCase().replace(/^0x/, "").padStart(40, "0") + w(amt)));
function tree(leaves) {
  const levels = [leaves.map(l => hex(l))];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1], next = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 === cur.length) { next.push(cur[i]); continue; }
      const [a, b] = [cur[i], cur[i + 1]].sort();
      next.push(hex(keccak256(bytes(a.slice(2) + b.slice(2)))));
    }
    levels.push(next);
  }
  return levels;
}
function proofFor(levels, index) {
  const p = []; let i = index;
  for (let d = 0; d < levels.length - 1; d++) {
    const sib = i ^ 1;
    if (sib < levels[d].length) p.push(levels[d][sib]);
    i >>= 1;
  }
  return p;
}
// The head of verify(address,uint256,bytes32[]) is three words, so the array's offset is
// 0x60. claim(uint256,bytes32[]) has a two-word head and uses 0x40. Getting this wrong made
// the view return false while the claim itself worked, which looks like a contract bug.
const encodeArr = (p, headWords) =>
  w(headWords * 32) + w(p.length) + p.map(x => x.replace(/^0x/, "")).join("");

console.log("── it compiles and is small enough to read");
ok("SnoozeGate compiles", !!all.SnoozeGate);
ok("with no warnings", warnings.length === 0,
   warnings.map(x => x.message.split("\n")[0]).join("; "));
ok("and is a fraction of the deploy limit",
   all.SnoozeGate.evm.deployedBytecode.object.length / 2 < 4000,
   String(all.SnoozeGate.evm.deployedBytecode.object.length / 2));

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b1";
const C = "0x00000000000000000000000000000000000000c1";
const SINK = "0x0000000000000000000000000000000000005177";
const ALLOC = [[A, 300n * E], [B, 200n * E], [C, 500n * E]];
const LEAVES = ALLOC.map(([a, n]) => leafOf(a, n));
const LEVELS = tree(LEAVES);
const ROOT = LEVELS[LEVELS.length - 1][0];
const UNTIL = 100000;

async function fixture() {
  const evm = await createEVM();
  const tok = await deploy(all.PlainToken.evm.bytecode.object, w(1000n * E), { evm });
  const g = await deploy(all.SnoozeGate.evm.bytecode.object,
    [tok.address.toString(), ROOT, 12345678, UNTIL, SINK].map(w).join(""),
    { evm, timestamp: 1000 });
  await call({ evm, address: tok.address }, "transfer(address,uint256)",
             [g.address.toString(), 1000n * E]);
  return { evm, tok: { evm, address: tok.address }, g: { evm, address: g.address },
           gAddr: g.address.toString() };
}

console.log("── a real allocation claims, once, for itself only");
{
  const f = await fixture();
  for (let i = 0; i < ALLOC.length; i++) {
    const [who, amt] = ALLOC[i];
    const proof = proofFor(LEVELS, i);
    const v = await call(f.g, "verify(address,uint256,bytes32[])", [],
      { raw: w(who) + w(amt) + encodeArr(proof, 3) });
    ok(`${who.slice(0, 8)} verifies before spending anything`, v.words[0] === 1n);
    const r = await call(f.g, "claim(uint256,bytes32[])", [],
      { from: who, timestamp: 2000, raw: w(amt) + encodeArr(proof, 2) });
    ok(`${who.slice(0, 8)} claims`, r.ok, r.revert);
    const bal = await call(f.tok, "balanceOf(address)", [who]);
    ok(`and receives exactly the allocation`, bal.words[0] === amt, String(bal.words[0]));
    const again = await call(f.g, "claim(uint256,bytes32[])", [],
      { from: who, timestamp: 2000, raw: w(amt) + encodeArr(proof, 2) });
    ok(`and cannot claim twice`, !again.ok, "it claimed again");
  }
  const t = await call(f.g, "totalClaimed()", []);
  ok("the total is the sum of the allocations", t.words[0] === 1000n * E, String(t.words[0]));
}

console.log("── the proof cannot be forged, and nobody can claim for anybody");
{
  const f = await fixture();
  const proofA = proofFor(LEVELS, 0);
  const encA = encodeArr(proofA, 2);

  // B presents A's proof. The leaf is keccak(msg.sender, amount), so it is A's leaf and B's
  // sender — the tree cannot contain both.
  const stolen = await call(f.g, "claim(uint256,bytes32[])", [],
    { from: B, timestamp: 2000, raw: w(300n * E) + encA });
  ok("somebody else's proof does not work for you", !stolen.ok, "it paid out");

  // A asks for more than the leaf says.
  const greedy = await call(f.g, "claim(uint256,bytes32[])", [],
    { from: A, timestamp: 2000, raw: w(999n * E) + encA });
  ok("a bigger number with a real proof does not work", !greedy.ok, "it paid out");

  // An empty proof against a root that is not a single leaf.
  const empty = await call(f.g, "claim(uint256,bytes32[])", [],
    { from: A, timestamp: 2000, raw: w(300n * E) + encodeArr([], 2) });
  ok("no proof at all does not work", !empty.ok, "it paid out");

  const abi = all.SnoozeGate.abi.filter(x => x.type === "function").map(x => x.name);
  ok("there is no claim(address) — a claim is self-service",
     !abi.some(n => /^claimFor|^claimOnBehalf/.test(n)), abi.join(","));
  const held = await call(f.tok, "balanceOf(address)", [f.gAddr]);
  ok("and after every attempt the gate still holds the whole allocation",
     held.words[0] === 1000n * E, String(held.words[0]));
}

console.log("── it never takes custody of anybody's $SNOOZE, which is the whole point");
{
  const src = fs.readFileSync("contracts/SnoozeGate.sol", "utf8")
    .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok("nothing here calls transferFrom", !/transferFrom/.test(src));
  ok("nothing here is payable", !/payable/.test(src));
  ok("there is no deposit, stake, lock or vault",
     !/function (deposit|stake|lock|bond|vault)/i.test(src));
  const abi = all.SnoozeGate.abi.filter(x => x.type === "function").map(x => x.name).join(" ");
  for (const bad of ["setRoot", "setToken", "sweepTo", "transferOwnership", "owner",
                     "pause", "upgrade", "rescue", "withdraw"])
    ok(`no ${bad}() in the ABI`, !new RegExp(bad, "i").test(abi));
  ok("the root is immutable", /bytes32 public immutable root/.test(src));
  ok("and so is where the unclaimed goes",
     /address public immutable unclaimedTo/.test(src));
}

console.log("── the deadline, and what happens to what nobody came for");
{
  const f = await fixture();
  const early = await call(f.g, "sweepUnclaimed()", [], { from: B, timestamp: 2000 });
  ok("nothing can be swept while the claim window is open", !early.ok, early.revert);

  const proof = proofFor(LEVELS, 0);
  const late = await call(f.g, "claim(uint256,bytes32[])", [],
    { from: A, timestamp: UNTIL + 1, raw: w(300n * E) + encodeArr(proof, 2) });
  ok("and nothing can be claimed after it closes", !late.ok, late.revert);

  const sweep = await call(f.g, "sweepUnclaimed()", [], { from: C, timestamp: UNTIL + 1 });
  ok("anybody may sweep once it has", sweep.ok, sweep.revert);
  const sunk = await call(f.tok, "balanceOf(address)", [SINK]);
  ok("and it goes to the address fixed at deployment, not to the caller",
     sunk.words[0] === 1000n * E, String(sunk.words[0]));
  const twice = await call(f.g, "sweepUnclaimed()", [], { from: C, timestamp: UNTIL + 2 });
  ok("it cannot be swept twice", !twice.ok, "it swept again");
}

console.log("── the configurations it refuses");
{
  const evm = await createEVM();
  const tok = await deploy(all.PlainToken.evm.bytecode.object, w(E), { evm });
  const mk = async (t, r, until, to) => {
    try {
      await deploy(all.SnoozeGate.evm.bytecode.object,
        [t, r, 1, until, to].map(w).join(""), { evm, timestamp: 1000 });
      return null;
    } catch (e) { return String(e.message || e); }
  };
  const T = tok.address.toString(), Z = "0x" + "0".repeat(40);
  ok("a zero token is refused", !!(await mk(Z, ROOT, UNTIL, SINK)));
  ok("a zero root is refused — it would verify nothing and pay nobody",
     !!(await mk(T, "0x" + "0".repeat(64), UNTIL, SINK)));
  ok("a deadline in the past is refused", !!(await mk(T, ROOT, 500, SINK)));
  ok("and unclaimed tokens with nowhere to go are refused", !!(await mk(T, ROOT, UNTIL, Z)));
  ok("a sane configuration deploys", (await mk(T, ROOT, UNTIL, SINK)) === null);
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
