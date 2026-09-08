// contracts/Snooze.sol, compiled and EXECUTED. The point of this suite is not that the code
// matches the spec — it is to find where the SPEC is wrong, by running it.
//
// Four claims are tested against arithmetic rather than against the pitch, and three of them
// come back false as written. Those are the assertions worth reading.
//   node test/run-snooze.mjs
import fs from "node:fs";
import { compile, deploy, call, fund, encodeCall, createAddressFromString } from "./evm.mjs";
import { createEVM } from "@ethereumjs/evm";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push("  ok   " + name); }
  else { fail++; results.push("  FAIL " + name + (extra ? "\n         " + extra : "")); }
}
const eq = (name, got, want) => ok(name, got === want, `got ${got}, want ${want}`);

const E = 10n ** 18n;
const SUPPLY = 1_000_000n * E;
const DEV = "0x00000000000000000000000000000000000000de";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const POOL = "0x00000000000000000000000000000000000000f0";
const DEPLOYER = "0x1000000000000000000000000000000000000001";
const DAY = 86400;

console.log("── it compiles");
const { contracts, all, warnings } = compile(["contracts/Snooze.sol", "contracts/test/SnoozeMocks.sol"]);
ok("compiles with no errors", !!contracts.Snooze);
ok("and no warnings", warnings.length === 0,
   warnings.map(w => w.message.split("\n")[0]).join("; "));

const w = v => (typeof v === "string" && v.startsWith("0x")
  ? v.slice(2) : BigInt(v).toString(16)).padStart(64, "0");

async function world(opts = {}) {
  const evm = await createEVM();
  for (const a of [A, B, DEPLOYER, POOL]) await fund(evm, a, 100n * E);
  const orc = await deploy(all.MockOracle.evm.bytecode.object, "", { evm });
  await call({ evm, address: orc.address }, "set(uint256,uint256,bool)",
    [opts.spot ?? E, opts.twap ?? E, opts.ready === false ? 0 : 1]);
  const tok = await deploy(contracts.Snooze.evm.bytecode.object,
    [SUPPLY, orc.address.toString(), DEV, opts.devBps ?? 0].map(w).join(""), { evm });
  await call(tok, "setPool(address,bool)", [POOL, 1], { from: DEPLOYER });
  return { evm, orc, tok };
}
const bal = async (x, who) => (await call(x.tok, "balanceOf(address)", [who])).words[0];
const give = async (x, who, amt, t = 1000) => {
  // The deployer holds everything at genesis and is capped like anyone else, so seed the test
  // wallets by exempting the deployer first — which is itself the thing Rule 2 must survive.
  await call(x.tok, "setCapExempt(address,bool)", [DEPLOYER, 1], { from: DEPLOYER });
  await call(x.tok, "transfer(address,uint256)", [who, amt], { from: DEPLOYER, timestamp: t });
};

console.log("── rule 1: the dial");
{
  const x = await world({ spot: 170n * E / 100n, twap: E });   // spot 70% above the average
  const bps = (await call(x.tok, "burnBps()")).words[0];
  eq("spot 70% over the average burns 41% — the number on the site", bps, 4117n);
  const q = await call(x.tok, "quoteSell(uint256)", [1000n * E]);
  eq("a 1000 sale delivers 588.3", q.words[0], 1000n * E - (1000n * E * 4117n) / 10_000n);
  eq("and burns the rest", q.words[1], (1000n * E * 4117n) / 10_000n);
  eq("with nothing to the dev at the default", q.words[2], 0n);
}
{
  const x = await world({ spot: E, twap: E });
  eq("at the average there is no haircut at all", (await call(x.tok, "burnBps()")).words[0], 0n);
}

console.log("── rule 1 is INERT in a dump, which is the opposite of the pitch");
{
  // "Dumpers fund the burn." They do not. Spot below the 24h average means burnBps is zero,
  // so selling into a crash is free. Rule 1 taxes selling into STRENGTH only.
  const x = await world({ spot: 50n * E / 100n, twap: E });   // spot half the average
  eq("a 50% crash burns nothing", (await call(x.tok, "burnBps()")).words[0], 0n);
  await give(x, A, 1000n * E);
  const q = await call(x.tok, "quoteSell(uint256)", [100n * E]);
  eq("and a sale into it delivers every token", q.words[0], 100n * E);
  eq("burning none", q.words[1], 0n);
}
{
  const x = await world({ spot: 99n * E / 100n, twap: E });
  eq("even one percent below the average is a free exit",
     (await call(x.tok, "burnBps()")).words[0], 0n);
}

console.log("── 'sleep on it and the jump is yours' is only true if the jump holds");
{
  // Today: spot 2.0, twap 1.0 — selling burns 50%.
  const x = await world({ spot: 2n * E, twap: E });
  eq("selling into the spike burns half", (await call(x.tok, "burnBps()")).words[0], 5000n);
  // Tomorrow the average has caught up but the price fell back to 1.1.
  await call({ evm: x.evm, address: x.orc.address }, "set(uint256,uint256,bool)",
    [110n * E / 100n, 150n * E / 100n, 1]);
  eq("tomorrow the haircut is gone", (await call(x.tok, "burnBps()")).words[0], 0n);
  // But you are paid at 1.1, not at the 2.0 you slept through. Waiting swapped a certain
  // haircut for an uncertain price; it did not bank the spike.
  ok("but the price you get is the one that survived the night, not the spike",
     110n * E / 100n < 2n * E);
}

console.log("── rule 2: the daily cap, which now measures sells rather than every transfer");
{
  const x = await world();
  await give(x, A, 1000n * E);
  const r = await call(x.tok, "remainingToday(address)", [A]);
  eq("a fresh wallet may sell 20% of its bag", r.words[0], 200n * E);

  const okSell = await call(x.tok, "transfer(address,uint256)", [POOL, 200n * E],
    { from: A, timestamp: 2000 });
  ok("selling exactly 20% is allowed", okSell.ok, okSell.revert);
  const over = await call(x.tok, "transfer(address,uint256)", [POOL, 1n],
    { from: A, timestamp: 2000 });
  ok("one wei more is not", !over.ok);

  // The baseline is the balance at the START of the window. Charging 20% of the CURRENT
  // balance each time would allow 20%, then 20% of the remaining 80%, and so on.
  const r2 = await call(x.tok, "remainingToday(address)", [A]);
  eq("and the day's allowance does not refill as the balance falls", r2.words[0], 0n);

  const next = await call(x.tok, "transfer(address,uint256)", [POOL, 160n * E],
    { from: A, timestamp: 2000 + DAY });
  ok("a day later the window resets", next.ok, next.revert);
  const tooMuch = await call(x.tok, "transfer(address,uint256)", [POOL, 1n],
    { from: A, timestamp: 2000 + DAY });
  ok("baselined on the new, smaller balance", !tooMuch.ok);
}

// THE REASON THE CAP MOVED. It used to apply to every outbound transfer, which is 20% of a
// balance that includes the amount being sent — so a contract receiving N and forwarding N
// needed four times the trade parked permanently. Every router, aggregator and wallet swap
// widget is that shape, and they reverted on BUYS as well as sells.
console.log("── and therefore the token can be routed, deposited and swept");
{
  const x = await world();
  const SETTLER = "0x0000000000000000000000000000000000005e77";
  const BUYER = "0x00000000000000000000000000000000000000b9";
  await give(x, POOL, 100_000n * E);

  // A buy routed through a settler that holds no inventory of its own.
  const inLeg = await call(x.tok, "transfer(address,uint256)", [SETTLER, 1000n * E],
    { from: POOL, timestamp: 2000 });
  ok("the pool can pay a settler", inLeg.ok, inLeg.revert);
  const outLeg = await call(x.tok, "transfer(address,uint256)", [BUYER, 1000n * E],
    { from: SETTLER, timestamp: 2000 });
  ok("and the settler can forward the whole lot to the buyer", outLeg.ok, outLeg.revert);
  eq("who receives all of it, because a buy is not a sell",
     (await call(x.tok, "balanceOf(address)", [BUYER])).words[0], 1000n * E);

  // A deposit address being swept clean, which is 100% of a balance every time.
  const DEP = "0x00000000000000000000000000000000000d3901";
  await call(x.tok, "transfer(address,uint256)", [DEP, 500n * E], { from: POOL, timestamp: 2000 });
  const sweep = await call(x.tok, "transfer(address,uint256)", [BUYER, 500n * E],
    { from: DEP, timestamp: 2000 });
  ok("a deposit address can be emptied in one go", sweep.ok, sweep.revert);
  eq("leaving nothing stranded",
     (await call(x.tok, "balanceOf(address)", [DEP])).words[0], 0n);

  // And the thing the wide rule was for is still true, because it never depended on the width:
  // the cap is split-invariant. One wallet with B sells 0.2B a day; n wallets holding B/n each
  // sell 0.2B/n, which sums to the same 0.2B. Splitting was never an evasion.
  const W = i => "0x" + (0x77000n + BigInt(i)).toString(16).padStart(40, "0");
  await give(x, A, 1000n * E);
  let split = 0n;
  for (let i = 0; i < 5; i++) {
    await call(x.tok, "transfer(address,uint256)", [W(i), 200n * E],
      { from: A, timestamp: 4000 });
    const s = await call(x.tok, "transfer(address,uint256)", [POOL, 40n * E],
      { from: W(i), timestamp: 4000 });
    if (s.ok) split += 40n * E;
    const more = await call(x.tok, "transfer(address,uint256)", [POOL, 1n],
      { from: W(i), timestamp: 4000 });
    ok(`split wallet ${i} is capped at its own 20%, not exempted by being fresh`, !more.ok);
  }
  eq("five wallets holding a fifth each sell exactly what one wallet could have",
     split, 200n * E);
}

{
  const x = await world();
  await give(x, A, 1000n * E);
  // The rule has to bind the deployer too or it is not a rule.
  await call(x.tok, "setCapExempt(address,bool)", [DEPLOYER, 0], { from: DEPLOYER });
  const dep = (await call(x.tok, "balanceOf(address)", [DEPLOYER])).words[0];
  const big = await call(x.tok, "transfer(address,uint256)", [POOL, dep],
    { from: DEPLOYER, timestamp: 3000 });
  ok("the deployer is capped like everyone else", !big.ok);
}

console.log("── the five-day drip is not five days");
{
  // The claim is that a nuke becomes a five-day drip. Splitting to fresh wallets is itself an
  // outbound transfer and therefore capped — but tokens are uncapped at REST, and every new
  // wallet gets its own 20%. So the escape accelerates geometrically. This computes the real
  // curve instead of asserting the slogan.
  //
  // Modelled off-chain because it is arithmetic about the rule, not about the code: each day
  // every controlled wallet may move 20% of its own start-of-day balance.
  const drain = (days) => {
    let wallets = [1.0];          // one wallet holding the whole bag
    let out = 0;
    for (let d = 0; d < days; d++) {
      const next = [];
      for (const bagAt of wallets) {
        const move = bagAt * 0.20;
        next.push(bagAt - move);  // what stays
        next.push(move);          // a fresh wallet holding what moved
      }
      wallets = next;
      // Everything sitting in a wallet that has already been used this way is still capped,
      // so "out" is the cumulative fraction that has reached a wallet able to sell tomorrow.
      out = 1 - wallets[0];
    }
    return out;
  };
  const d1 = drain(1), d3 = drain(3), d5 = drain(5), d10 = drain(10);
  ok("day 1 moves 20%", Math.abs(d1 - 0.20) < 1e-9, String(d1));
  ok("by day 5 the original wallet retains 32.8%, not zero",
     Math.abs((1 - d5) - Math.pow(0.8, 5)) < 1e-9, String(1 - d5));
  ok("and the tail is long: after 10 days it still holds 10.7%",
     Math.abs((1 - d10) - Math.pow(0.8, 10)) < 1e-9, String(1 - d10));
  // The honest framing: the cap makes the ORIGINAL wallet decay at 0.8^d, which is a drip.
  // It does not stop the holder spreading into wallets that each drip in parallel.
  ok("so the cap sets a decay rate, it does not set a deadline", d5 < 1 && d10 < 1);
}

console.log("── the dev-pay contradiction is resolved by refusing it");
{
  const x = await world({ devBps: 0 });
  eq("with no dev cut, supply only falls is TRUE",
     (await call(x.tok, "supplyOnlyFalls()")).words[0], 1n);
}
{
  const x = await world({ devBps: 2000, spot: 2n * E, twap: E });
  eq("with a dev cut it is FALSE, and the contract says so",
     (await call(x.tok, "supplyOnlyFalls()")).words[0], 0n);
  const q = await call(x.tok, "quoteSell(uint256)", [1000n * E]);
  const haircut = (1000n * E * 5000n) / 10_000n;
  eq("the dev takes 20% of the haircut", q.words[2], (haircut * 2000n) / 10_000n);
  eq("and the rest still burns", q.words[1], haircut - (haircut * 2000n) / 10_000n);
  ok("the dev's cut is of the haircut, never of the trade",
     q.words[2] < (1000n * E * 2000n) / 10_000n);
}
{
  const bad = await (async () => {
    const evm = await createEVM();
    const orc = await deploy(all.MockOracle.evm.bytecode.object, "", { evm });
    return deploy(contracts.Snooze.evm.bytecode.object,
      [SUPPLY, orc.address.toString(), DEV, 2001].map(w).join(""), { evm })
      .then(() => null).catch(e => e);
  })();
  ok("a dev cut above 20% of the haircut is rejected at construction", bad !== null);
}

console.log("── a sell actually burns, and only a sell");
{
  const x = await world({ spot: 2n * E, twap: E });
  await give(x, A, 1000n * E);
  const before = (await call(x.tok, "totalSupply()")).words[0];
  await call(x.tok, "transfer(address,uint256)", [POOL, 100n * E], { from: A, timestamp: 5000 });
  const after = (await call(x.tok, "totalSupply()")).words[0];
  eq("selling 100 into the pool burns 50", before - after, 50n * E);
  eq("the pool receives only what was not burnt", await bal(x, POOL), 50n * E);
  eq("and the seller is debited the full amount they sent", await bal(x, A), 900n * E);

  const x2 = await world({ spot: 2n * E, twap: E });
  await give(x2, A, 1000n * E);
  const s0 = (await call(x2.tok, "totalSupply()")).words[0];
  await call(x2.tok, "transfer(address,uint256)", [B, 100n * E], { from: A, timestamp: 5000 });
  eq("a wallet-to-wallet move burns nothing",
     (await call(x2.tok, "totalSupply()")).words[0], s0);
  eq("and arrives in full", await bal(x2, B), 100n * E);
}
{
  // A buy is the pool paying out. If that were capped or burnt nobody could buy at all.
  const x = await world({ spot: 2n * E, twap: E });
  await give(x, POOL, 10_000n * E);
  const r = await call(x.tok, "transfer(address,uint256)", [A, 5_000n * E],
    { from: POOL, timestamp: 6000 });
  ok("the pool can pay a buyer more than 20% of its balance", r.ok, r.revert);
  eq("and the buyer receives every token", await bal(x, A), 5_000n * E);
}

console.log("── the oracle is a dependency, so it is treated as hostile");
{
  const x = await world({ ready: false, spot: 5n * E, twap: E });
  eq("before it has 24h of history the haircut is zero, not a guess",
     (await call(x.tok, "burnBps()")).words[0], 0n);
  // Which means the launch's first day has NO Rule 1 at all. "Snipers get nothing" is false
  // for exactly as long as the oracle is warming up.
  ok("so day one has no Rule 1, and the pitch's first claim does not hold then", true);
}
{
  const x = await world({ spot: 0n, twap: E });
  eq("a zero spot reads as no haircut rather than dividing by zero",
     (await call(x.tok, "burnBps()")).words[0], 0n);
}
{
  const x = await world({ spot: 1_000_000n * E, twap: 1n });
  eq("an absurd spot is capped at 90%, so a broken oracle cannot confiscate a sale",
     (await call(x.tok, "burnBps()")).words[0], 9000n);
}

console.log("── the rule is a promise until it is frozen");
{
  const x = await world();
  const ex = await call(x.tok, "setCapExempt(address,bool)", [A, 1], { from: DEPLOYER });
  ok("the admin can exempt a wallet from rule 2 while unfrozen", ex.ok);
  await call(x.tok, "freeze()", [], { from: DEPLOYER });
  const after = await call(x.tok, "setCapExempt(address,bool)", [B, 1], { from: DEPLOYER });
  ok("after freezing they cannot", !after.ok);
  const pool = await call(x.tok, "setPool(address,bool)", [B, 1], { from: DEPLOYER });
  ok("nor add a pool", !pool.ok);
  const stranger = await call(x.tok, "setCapExempt(address,bool)", [A, 1], { from: A });
  ok("and a stranger never could", !stranger.ok);
}

console.log("── the dial is ALSO the instant loss on buying the top");
{
  // The pitch says Rule 1 makes buying the top stop being the dumbest trade. Run it: buy at
  // spot P while the average is T, and your immediate exit value is T-priced, so you are down
  // (P-T)/P the moment the transaction confirms. That is the SAME number the dial shows. The
  // rule does not de-risk buying the top — it makes the loss mechanical and immediate instead
  // of probabilistic. Buying the top is worse under this rule, not better.
  const x = await world({ spot: 170n * E / 100n, twap: E });
  await give(x, A, 1000n * E);
  const dial = (await call(x.tok, "burnBps()")).words[0];
  const q = await call(x.tok, "quoteSell(uint256)", [200n * E]);
  const kept = (q.words[0] * 10_000n) / (200n * E);
  eq("the dial reads 41%", dial, 4117n);
  eq("and a buyer who exits immediately keeps 58.83% — down by exactly the dial",
     kept, 10_000n - 4117n);
  ok("so the headline number is the buyer's instant loss, not their protection",
     dial + kept === 10_000n);
}

console.log("── an unregistered pool escapes rule 1 entirely");
{
  // The haircut fires on isPool[to]. Anything not on that list is an ordinary transfer, which
  // means a pool the admin never registered — or an OTC counterparty — takes tokens at no
  // haircut at all. And setPool is disabled by freeze(), which trust requires. So the choice
  // is: stay unfrozen and the admin can exempt anyone, or freeze and new venues are
  // permanently outside the rule. There is no setting where both hold.
  const x = await world({ spot: 2n * E, twap: E });
  await give(x, A, 1000n * E);
  const s0 = (await call(x.tok, "totalSupply()")).words[0];
  await call(x.tok, "transfer(address,uint256)", [B, 200n * E], { from: A, timestamp: 8000 });
  eq("selling to an unregistered address burns nothing",
     (await call(x.tok, "totalSupply()")).words[0], s0);
  eq("and delivers in full", await bal(x, B), 200n * E);

  await call(x.tok, "freeze()", [], { from: DEPLOYER });
  const late = await call(x.tok, "setPool(address,bool)", [B, 1], { from: DEPLOYER });
  ok("and once frozen, that venue can never be brought under the rule", !late.ok);
}

console.log("── the oracle fails OPEN, which is a choice with a cost");
{
  // If the feed is not ready the haircut is zero, so Rule 1 is simply absent. That is the
  // right call — failing closed would block every sell and make this a literal honeypot — but
  // it means a broken or unupgradeable oracle silently switches the rule off forever, and
  // nothing on chain distinguishes "no haircut because the price is low" from "no haircut
  // because the feed died". ruleActive() is what a page must read to tell them apart.
  const x = await world({ ready: false, spot: 5n * E, twap: E });
  eq("a dead feed reads as zero haircut", (await call(x.tok, "burnBps()")).words[0], 0n);
  await give(x, A, 1000n * E);
  const s0 = (await call(x.tok, "totalSupply()")).words[0];
  await call(x.tok, "transfer(address,uint256)", [POOL, 200n * E], { from: A, timestamp: 8500 });
  eq("so sells go through untouched while it is down",
     (await call(x.tok, "totalSupply()")).words[0], s0);
  eq("which is indistinguishable from a calm market unless the page asks",
     (await call(x.tok, "ruleActive()")).words[0], 0n);
  const y = await world({ spot: E, twap: E });
  eq("a live feed at parity also reads zero haircut...",
     (await call(y.tok, "burnBps()")).words[0], 0n);
  eq("...but reports the rule as in force", (await call(y.tok, "ruleActive()")).words[0], 1n);
}

console.log("── 'no lock' is false: a full exit is never possible");
{
  // 20% of what remains, every day, is geometric. The balance approaches zero and never
  // reaches it. The pitch says "no lock, no tax, no staking" — the first of those is not true.
  const remaining = d => Math.pow(0.8, d);
  ok("after 30 days a wallet still holds 0.12%", remaining(30) > 0.001);
  ok("after 90 days it still holds something", remaining(90) > 0);
  // Mathematically it is asymptotic and never reaches zero. Numerically 0.8^d underflows a
  // double past about d=3170, so the assertion is made at a horizon a double can still hold —
  // the claim is about the geometry, not about IEEE 754.
  ok("after a year it still holds 10^-36 of the bag, not zero", remaining(365) > 0);
  ok("and the decay is geometric, so no finite horizon empties it",
     remaining(1000) > 0 && remaining(1000) < remaining(365));
  // On chain the floor division does eventually zero a small enough balance, but only once
  // the balance is under 5 base units — which at 18 decimals is economically never.
  const x = await world();
  await give(x, A, 4n);
  const r = await call(x.tok, "remainingToday(address)", [A]);
  eq("a 4-unit balance allows 0 per day — dust locks completely", r.words[0], 0n);
}

console.log("── the dial and the trade cannot disagree");
{
  // quoteSell is the same function the transfer path uses. If the page computed the haircut
  // itself it would eventually drift, and the number people trust is the one on the page.
  const x = await world({ spot: 137n * E / 100n, twap: 100n * E / 100n });
  await give(x, A, 2000n * E);   // 300 is 15% of this, inside Rule 2
  const q = await call(x.tok, "quoteSell(uint256)", [300n * E]);
  const s0 = (await call(x.tok, "totalSupply()")).words[0];
  await call(x.tok, "transfer(address,uint256)", [POOL, 300n * E], { from: A, timestamp: 7000 });
  eq("what the quote said would burn is what burned",
     s0 - (await call(x.tok, "totalSupply()")).words[0], q.words[1]);
  eq("and what it said would arrive is what arrived", await bal(x, POOL), q.words[0]);
}
{
  // The two rules compose, and the composition is stricter than either alone: the haircut
  // applies to what you send, but Rule 2 caps what you may send in the first place. Trying to
  // dump 30% of a bag reverts before the burn is ever computed, which means the dial's number
  // is not the whole cost of leaving — the cap is.
  const x = await world({ spot: 2n * E, twap: E });
  await give(x, A, 1000n * E);
  const q = await call(x.tok, "quoteSell(uint256)", [300n * E]);
  ok("a quote is happy to price a sale the cap will not allow", q.words[0] > 0n);
  const r = await call(x.tok, "transfer(address,uint256)", [POOL, 300n * E],
    { from: A, timestamp: 7500 });
  ok("but the transfer reverts on Rule 2 before Rule 1 is reached", !r.ok);
  eq("nothing burned", (await call(x.tok, "totalSupply()")).words[0], SUPPLY);
  const okSale = await call(x.tok, "transfer(address,uint256)", [POOL, 200n * E],
    { from: A, timestamp: 7500 });
  ok("at exactly 20% it goes through", okSale.ok, okSale.revert);
}

// THE EXEMPT WALLET IS OUTSIDE BOTH RULES, NOT ONE.
//
// _move() guards the haircut with `if (isPool[to] && !capExempt[from])`. capExempt was added
// for Rule 2 — a pool that could only pay out 20% of its balance a day is not a pool — but the
// same flag also skips the Rule 1 branch entirely. So an address exempted so that it can SEED
// liquidity is also an address that can SELL without ever burning anything, and the two are
// indistinguishable from outside: both are a transfer into the pool.
//
// SnoozeLaunchpad.launch() cap-exempts msg.sender and then freezes, so the launcher wallet
// holds that position permanently, and it is the wallet holding 100% of the supply the moment
// launch() returns. Every page that said the rules apply "to everyone, including whoever
// deployed it" was wrong, and this is here so that sentence cannot come back.
console.log("── the exemption is from BOTH rules, which is not what the pages used to say");
{
  const evm = await createEVM();
  const orc = await deploy(all.MockOracle.evm.bytecode.object, "", { evm });
  await call({ evm, address: orc.address }, "set(uint256,uint256,bool)", [2n * E, E, 1]);
  const SUPPLY = 1000n * E;
  const t = await deploy(all.Snooze.evm.bytecode.object,
    [SUPPLY, orc.address.toString(), "0x00000000000000000000000000000000000000de", 0]
      .map(w).join(""), { evm });
  const T = { evm, address: t.address };
  const POOL = "0x00000000000000000000000000000000000000b0";
  const PLAIN = "0x00000000000000000000000000000000000000a1";
  const FREE  = "0x00000000000000000000000000000000000000a2";
  await call(T, "setPool(address,bool)", [POOL, 1]);

  const dial = await call(T, "burnBps()", []);
  ok("the dial is at 50% for this test", dial.words[0] === 5000n, String(dial.words[0]));

  // An ordinary holder: capped at 20% of the balance, and half of what gets through burns.
  await call(T, "transfer(address,uint256)", [PLAIN, 100n * E]);
  const s0 = (await call(T, "totalSupply()", [])).words[0];
  const tooMuch = await call(T, "transfer(address,uint256)", [POOL, 100n * E], { from: PLAIN });
  ok("an ordinary holder cannot sell its whole balance at all", !tooMuch.ok, tooMuch.revert);
  const sale = await call(T, "transfer(address,uint256)", [POOL, 20n * E], { from: PLAIN });
  ok("but it can sell a fifth", sale.ok, sale.revert);
  const burnedPlain = s0 - (await call(T, "totalSupply()", [])).words[0];
  ok("and half of that fifth burns", burnedPlain === 10n * E, String(burnedPlain / E));

  // The exempt holder: no cap, and no burn either.
  await call(T, "transfer(address,uint256)", [FREE, 100n * E]);
  await call(T, "setCapExempt(address,bool)", [FREE, 1]);
  const s1 = (await call(T, "totalSupply()", [])).words[0];
  const dump = await call(T, "transfer(address,uint256)", [POOL, 100n * E], { from: FREE });
  ok("a cap-exempt holder CAN sell its whole balance in one go", dump.ok, dump.revert);
  const burnedFree = s1 - (await call(T, "totalSupply()", [])).words[0];
  ok("and none of it burns, at the same 50% dial", burnedFree === 0n, String(burnedFree / E));
  const got = (await call(T, "balanceOf(address)", [POOL])).words[0];
  ok("the pool received the exempt seller's tokens in full",
     got === 10n * E + 100n * E, String(got / E));

  // The consequence, stated as the assertion it is.
  ok("so the exemption granted for seeding is also an exemption from the haircut",
     burnedPlain > 0n && burnedFree === 0n,
     "if this ever fails the two exemptions have been split, and the pages may say " +
     "'applies to everyone' again");
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
