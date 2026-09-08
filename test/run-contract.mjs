// Compiles contracts/LaunchTaxRamp.sol and EXECUTES it in an in-process EVM. Every number
// below came out of running the opcodes, not out of reading the source.
//
// What this is not: a testnet. There is no PoolManager here, so the hook integration —
// unlock/settle accounting, the delta the hook returns, reentrancy across the lock — is
// untested and is where the real risk lives. This covers the arithmetic and the ordering,
// which is the part that can be pinned without a network.
//   node test/run-contract.mjs
import { compile, deploy, call, encodeCall } from "./evm.mjs";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push("  ok   " + name); }
  else { fail++; results.push("  FAIL " + name + (extra ? "\n         " + extra : "")); }
}
const eq = (name, got, want) => ok(name, got === want, `got ${got}, want ${want}`);

const BPS = 10_000n;
const ETH = 10n ** 18n;
const ALICE = "0x00000000000000000000000000000000000000a1";
const SEEDLP = "0x00000000000000000000000000000000000005ee";
const DEPLOYER = "0x1000000000000000000000000000000000000001";

console.log("── it compiles");
const { contracts, warnings } = compile("contracts/LaunchTaxRamp.sol");
ok("compiles with no errors", !!contracts.LaunchTaxRamp);
ok("and no warnings", warnings.length === 0,
   warnings.map(w => w.message.split("\n")[0]).join("; "));
const BYTECODE = contracts.LaunchTaxRamp.evm.bytecode.object;

/* Schedule struct is (uint8,uint64,uint256,uint256,uint256,uint256,uint256,uint256) — a
   static tuple, so it encodes inline as eight words, then the seedLp address. */
const UNIT = { PerBuy: 0, PerBlock: 1, PerVolume: 2 };
const w = v => (typeof v === "string" && v.startsWith("0x")
  ? v.slice(2) : BigInt(v).toString(16)).padStart(64, "0");
const ctor = (s, seedLp) => [
  s.unit, s.startBlock ?? 0, s.startBps, s.stepBps, s.stepUnit ?? 0,
  s.capBps, s.sellBps, s.offAfterUnits ?? 0, seedLp,
].map(w).join("");

const mk = (s, seedLp = SEEDLP, opts = {}) => deploy(BYTECODE, ctor(s, seedLp), opts);
const BASE = { unit: UNIT.PerBuy, startBps: 100, stepBps: 100, capBps: 1000, sellBps: 500 };

console.log("── the off-by-one on the very first buy");
{
  // The first taxed buy must pay exactly startBps. A ramp that advances its counter before
  // pricing charges start+step to buyer #1, which is not the schedule anyone published.
  const c = await mk(BASE);
  const first = await call(c, "buyTaxBps(address)", [ALICE], { from: ALICE });
  eq("buyer #1 pays exactly the starting rate, not start+step", first.words[0], 100n);
  const u = await call(c, "unitsElapsed(uint256)", [0]);
  eq("and sees zero elapsed units", u.words[0], 0n);

  await call(c, "recordBuy(address,uint256)", [ALICE, ETH], { from: ALICE });
  const second = await call(c, "buyTaxBps(address)", [ALICE], { from: ALICE });
  eq("buyer #2 pays start + one step", second.words[0], 200n);

  await call(c, "recordBuy(address,uint256)", [ALICE, ETH], { from: ALICE });
  eq("buyer #3 pays start + two steps",
     (await call(c, "buyTaxBps(address)", [ALICE])).words[0], 300n);
}

console.log("── the cap");
{
  const c = await mk({ ...BASE, startBps: 100, stepBps: 300, capBps: 1000 });
  for (let i = 0; i < 20; i++)
    await call(c, "recordBuy(address,uint256)", [ALICE, ETH], { from: ALICE });
  eq("the ramp stops at the cap and does not wrap or overflow",
     (await call(c, "buyTaxBps(address)", [ALICE])).words[0], 1000n);
}
{
  const bad = await deploy(BYTECODE, ctor({ ...BASE, startBps: 900, capBps: 500 }, SEEDLP))
    .then(() => null).catch(e => e);
  ok("a cap below the start is rejected at construction, not silently applied", bad !== null);
}
{
  const bad = await deploy(BYTECODE, ctor({ ...BASE, capBps: 10_000 }, SEEDLP))
    .then(() => null).catch(e => e);
  ok("a 100% cap is rejected — it would zero the pool input", bad !== null);
}
{
  const bad = await deploy(BYTECODE,
    ctor({ ...BASE, unit: UNIT.PerVolume, stepUnit: 0 }, SEEDLP))
    .then(() => null).catch(e => e);
  ok("a volume ramp with a zero step unit is rejected, not a division by zero", bad !== null);
}

console.log("── the seed LP exemption, which is the one that costs real money");
{
  const c = await mk(BASE, SEEDLP);
  eq("the seed LP is exempt from construction, with no window before it",
     (await call(c, "buyTaxBps(address)", [SEEDLP])).words[0], 0n);
  const s = await call(c, "splitBuy(address,uint256)", [SEEDLP, 100n * ETH]);
  eq("so seeding liquidity is taxed nothing", s.words[0], 0n);
  eq("and the whole seed reaches the pool", s.words[1], 100n * ETH);

  // An exempt trade must not advance the ramp. If it did, the operator's own seeding would
  // push the first real buyer past the published starting rate.
  await call(c, "recordBuy(address,uint256)", [SEEDLP, 100n * ETH], { from: SEEDLP });
  eq("an exempt trade does not advance the ramp",
     (await call(c, "buyTaxBps(address)", [ALICE])).words[0], 100n);
  const p = await call(c, "progress()");
  eq("nor the buy counter", p.words[0], 0n);
  eq("nor the volume counter", p.words[1], 0n);
}

console.log("── tax on top, never tax on tax");
{
  const c = await mk({ ...BASE, startBps: 500, stepBps: 0, capBps: 500 });
  const s = await call(c, "splitBuy(address,uint256)", [ALICE, 10n * ETH]);
  eq("5% of a 10 ETH buy is 0.5 ETH", s.words[0], ETH / 2n);
  eq("and 9.5 ETH reaches the pool", s.words[1], 10n * ETH - ETH / 2n);
  ok("tax plus pool input is exactly the gross, with no wei unaccounted for",
     s.words[0] + s.words[1] === 10n * ETH);

  // The pool fee is charged by the pool on what it receives. The contract must never apply
  // it, or the buyer is charged the pool fee on money that never entered the pool.
  const poolFeeBps = 100n;
  const feeInPool = (s.words[1] * poolFeeBps) / BPS;
  const naive = (10n * ETH * poolFeeBps) / BPS;
  ok("the pool fee lands on the net, and that is strictly less than on the gross",
     feeInPool < naive, `${feeInPool} vs ${naive}`);
  eq("the difference is exactly the fee on the tax — the double charge avoided",
     naive - feeInPool, (s.words[0] * poolFeeBps) / BPS);
}

console.log("── the sell side");
{
  const c = await mk({ ...BASE, sellBps: 500 });
  eq("sell tax is flat and does not ride the buy ramp",
     (await call(c, "sellTaxBps(address)", [ALICE])).words[0], 500n);
  for (let i = 0; i < 5; i++)
    await call(c, "recordBuy(address,uint256)", [ALICE, ETH], { from: ALICE });
  eq("still flat after the buy ramp has advanced",
     (await call(c, "sellTaxBps(address)", [ALICE])).words[0], 500n);

  // Sell tax applies to what came OUT of the pool, so the pool fee is already deducted. A
  // round trip therefore pays: buy tax, pool fee in, pool fee out, sell tax — each once.
  const out = await call(c, "splitSell(address,uint256)", [ALICE, 10n * ETH]);
  eq("5% of a 10 ETH gross output is 0.5 ETH", out.words[0], ETH / 2n);
  eq("the seller keeps the rest", out.words[1], 10n * ETH - ETH / 2n);
  eq("the seed LP pays no sell tax either",
     (await call(c, "sellTaxBps(address)", [SEEDLP])).words[0], 0n);
}

console.log("── turn-off");
{
  const c = await mk({ ...BASE, startBps: 100, stepBps: 100, capBps: 5000, offAfterUnits: 3 });
  const seen = [];
  for (let i = 0; i < 5; i++) {
    seen.push((await call(c, "buyTaxBps(address)", [ALICE])).words[0]);
    await call(c, "recordBuy(address,uint256)", [ALICE, ETH], { from: ALICE });
  }
  eq("ramps for the first three buys", seen.slice(0, 3).join(","), "100,200,300");
  ok("then turns off cleanly to exactly zero", seen[3] === 0n && seen[4] === 0n, seen.join(","));
}

console.log("── the unit the ramp is keyed to, which decides whether splitting evades it");
{
  // Per-buy: ten 1 ETH buys advance the ramp ten times, one 10 ETH buy advances it once. A
  // splitter and a whale spending the same money pay very different rates. That is the
  // evasion surface, and it is a property of the UNIT, not of the rate.
  const perBuy = await mk({ ...BASE, unit: UNIT.PerBuy, startBps: 100, stepBps: 100, capBps: 5000 });
  for (let i = 0; i < 10; i++)
    await call(perBuy, "recordBuy(address,uint256)", [ALICE, ETH], { from: ALICE });
  const afterSplit = (await call(perBuy, "buyTaxBps(address)", [ALICE])).words[0];

  const perBuy2 = await mk({ ...BASE, unit: UNIT.PerBuy, startBps: 100, stepBps: 100, capBps: 5000 });
  await call(perBuy2, "recordBuy(address,uint256)", [ALICE, 10n * ETH], { from: ALICE });
  const afterWhale = (await call(perBuy2, "buyTaxBps(address)", [ALICE])).words[0];
  ok("a per-buy ramp charges a splitter far more than a whale who spent the same",
     afterSplit > afterWhale, `${afterSplit} vs ${afterWhale}`);
  eq("ten 1-ETH buys reach 11%", afterSplit, 1100n);
  eq("one 10-ETH buy is still at 2%", afterWhale, 200n);

  // Per-volume: both reach the same place. The splitter cannot outrun a volume-keyed ramp.
  const V = { ...BASE, unit: UNIT.PerVolume, stepUnit: ETH, startBps: 100, stepBps: 100, capBps: 5000 };
  const vSplit = await mk(V);
  for (let i = 0; i < 10; i++)
    await call(vSplit, "recordBuy(address,uint256)", [ALICE, ETH], { from: ALICE });
  const vWhale = await mk(V);
  await call(vWhale, "recordBuy(address,uint256)", [ALICE, 10n * ETH], { from: ALICE });
  eq("a volume-keyed ramp prices the splitter and the whale identically",
     (await call(vSplit, "buyTaxBps(address)", [ALICE])).words[0],
     (await call(vWhale, "buyTaxBps(address)", [ALICE])).words[0]);
  eq("and both land at 11%",
     (await call(vSplit, "buyTaxBps(address)", [ALICE])).words[0], 1100n);

  // Sub-step volume must not advance the ramp at all — otherwise dust buys ratchet it.
  const dust = await mk(V);
  for (let i = 0; i < 9; i++)
    await call(dust, "recordBuy(address,uint256)", [ALICE, ETH / 10n], { from: ALICE });
  eq("0.9 ETH of dust does not advance a 1-ETH-per-step ramp",
     (await call(dust, "buyTaxBps(address)", [ALICE])).words[0], 100n);
}

console.log("── the block-keyed ramp");
{
  const c = await mk({ ...BASE, unit: UNIT.PerBlock, startBlock: 100,
                       startBps: 2500, stepBps: 0, capBps: 2500, offAfterUnits: 3 });
  const at = async n => (await call(c, "buyTaxBps(address)", [ALICE], { blockNumber: n })).words[0];
  eq("at the opening block the full rate applies", await at(100), 2500n);
  eq("two blocks later it still applies", await at(102), 2500n);
  ok("and three blocks later it is off — a tax that dies in three blocks",
     (await at(103)) === 0n && (await at(200)) === 0n);
  eq("a block before the open is treated as the open, not as underflow", await at(99), 2500n);
}
{
  const c = await mk({ ...BASE, unit: UNIT.PerBlock, startBlock: 0 });
  const r = await call(c, "buyTaxBps(address)", [ALICE]);
  ok("an unopened block ramp reverts rather than pricing from block zero", !r.ok, r.raw);
}

console.log("── same block, and therefore no way to know what you will pay");
{
  // Base has one sequencer and a private mempool, so buyers in a 2-second window submit
  // without seeing each other. The aggregate is unaffected — constant product is path
  // independent for a given total and transaction count — but WHO PAYS WHAT is decided by an
  // ordering nobody can observe. Under a per-buy ramp that means two people who pressed the
  // button at the same instant pay different tax, and neither could have known.
  const perBuy = await mk({ ...BASE, unit: UNIT.PerBuy, startBps: 100, stepBps: 100, capBps: 5000 });
  const rates = [];
  for (let i = 0; i < 4; i++) {
    rates.push((await call(perBuy, "buyTaxBps(address)", [ALICE], { blockNumber: 50 })).words[0]);
    await call(perBuy, "recordBuy(address,uint256)", [ALICE, ETH],
               { from: ALICE, blockNumber: 50 });
  }
  ok("under a per-buy ramp, four buys in ONE block pay four different rates",
     new Set(rates.map(String)).size === 4, rates.join(","));
  ok("and the spread inside that single block is already 3 points",
     rates[3] - rates[0] === 300n, rates.join(","));

  const perVol = await mk({ ...BASE, unit: UNIT.PerVolume, stepUnit: ETH,
                            startBps: 100, stepBps: 100, capBps: 5000 });
  const vrates = [];
  for (let i = 0; i < 4; i++) {
    vrates.push((await call(perVol, "buyTaxBps(address)", [ALICE], { blockNumber: 50 })).words[0]);
    await call(perVol, "recordBuy(address,uint256)", [ALICE, ETH],
               { from: ALICE, blockNumber: 50 });
  }
  ok("a volume ramp has the same problem — ordering still decides the rate",
     new Set(vrates.map(String)).size === 4, vrates.join(","));

  // A block-keyed ramp is the only unit where simultaneity is not a lottery.
  const perBlock = await mk({ ...BASE, unit: UNIT.PerBlock, startBlock: 50,
                              startBps: 100, stepBps: 100, capBps: 5000 });
  const brates = [];
  for (let i = 0; i < 4; i++) {
    brates.push((await call(perBlock, "buyTaxBps(address)", [ALICE], { blockNumber: 50 })).words[0]);
    await call(perBlock, "recordBuy(address,uint256)", [ALICE, ETH],
               { from: ALICE, blockNumber: 50 });
  }
  ok("under a per-block ramp everyone in the same block pays the same rate",
     new Set(brates.map(String)).size === 1, brates.join(","));
  eq("and it is the rate the schedule promised for that block", brates[0], 100n);
  eq("the next block steps once, for everyone in it",
     (await call(perBlock, "buyTaxBps(address)", [ALICE], { blockNumber: 51 })).words[0], 200n);
}

console.log("── the exemption list is the back door, so it must be closable");
{
  const c = await mk(BASE);
  const notAdmin = await call(c, "setExempt(address,bool)", [ALICE, true], { from: ALICE });
  ok("a stranger cannot grant themselves an exemption", !notAdmin.ok);

  await call(c, "setExempt(address,bool)", [ALICE, true], { from: DEPLOYER });
  eq("the admin can, before freezing",
     (await call(c, "buyTaxBps(address)", [ALICE])).words[0], 0n);

  await call(c, "freeze()", [], { from: DEPLOYER });
  const after = await call(c, "setExempt(address,bool)",
    ["0x00000000000000000000000000000000000000b2", true], { from: DEPLOYER });
  ok("after freezing even the admin cannot add one", !after.ok);
  const reopen = await call(c, "open(uint64)", [500], { from: DEPLOYER });
  ok("nor reopen the schedule", !reopen.ok);
}

console.log("── rounding never invents money");
{
  const c = await mk({ ...BASE, startBps: 333, stepBps: 0, capBps: 333 });
  for (const amt of [1n, 2n, 3n, 7n, 999n, ETH - 1n, ETH, 12345678901234567n]) {
    const s = await call(c, "splitBuy(address,uint256)", [ALICE, amt]);
    ok(`splitBuy(${amt}) conserves every wei`, s.words[0] + s.words[1] === amt,
       `${s.words[0]} + ${s.words[1]} != ${amt}`);
    ok(`splitBuy(${amt}) rounds the tax down, never up`,
       s.words[0] <= (amt * 333n) / BPS);
  }
  const zero = await call(c, "splitBuy(address,uint256)", [ALICE, 0]);
  ok("a zero buy is zero tax and zero to pool",
     zero.words[0] === 0n && zero.words[1] === 0n);
}

console.log("── quote agrees with the parts it is made of");
{
  const c = await mk({ ...BASE, startBps: 250, stepBps: 50, capBps: 1000 });
  for (let i = 0; i < 4; i++) {
    const q = await call(c, "quote(address,uint256)", [ALICE, 3n * ETH]);
    const b = await call(c, "buyTaxBps(address)", [ALICE]);
    const s = await call(c, "splitBuy(address,uint256)", [ALICE, 3n * ETH]);
    const u = await call(c, "unitsElapsed(uint256)", [0]);
    ok(`quote matches its parts at buy ${i + 1}`,
       q.words[0] === b.words[0] && q.words[1] === s.words[0] &&
       q.words[2] === s.words[1] && q.words[3] === u.words[0],
       `${q.words.join(",")} vs ${b.words[0]},${s.words[0]},${s.words[1]},${u.words[0]}`);
    await call(c, "recordBuy(address,uint256)", [ALICE, 3n * ETH], { from: ALICE });
  }
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
