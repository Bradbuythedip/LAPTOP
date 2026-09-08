// End-to-end: PooledLaunchBuy consolidating deposits into one buy of Snooze, then
// distributing. Both contracts pass their own suites; this asks whether they work TOGETHER,
// which is a different question and the one that breaks.
//   node test/run-wiring.mjs
import fs from "node:fs";
import { compile, deploy, call, fund, createAddressFromString } from "./evm.mjs";
import { createEVM } from "@ethereumjs/evm";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push("  ok   " + name); }
  else { fail++; results.push("  FAIL " + name + (extra ? "\n         " + extra : "")); }
}
const eq = (name, got, want) => ok(name, got === want, `got ${got}, want ${want}`);

const E = 10n ** 18n;
// Ultra-high supply, as asked. It is a units choice: price is E/T, so doubling supply halves
// the unit price and changes nobody's wealth. What it does buy is integer headroom — the
// pro-rata split and the 20% cap both floor-divide, and dust is proportionally smaller
// against a larger denominator. That is the real argument for it, and it is a small one.
const SUPPLY = 1_000_000_000_000n * E;      // 1e12
const DEV = "0x00000000000000000000000000000000000000de";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const DEPLOYER = "0x1000000000000000000000000000000000000001";
const T_OPEN = 1000, T_EXEC = 2000, T_REFUND = 3000, DAY = 86400;

console.log("── both contracts compile together");
const { all, warnings } = compile([
  "contracts/Snooze.sol", "contracts/PooledLaunchBuy.sol",
  "contracts/test/Mocks.sol", "contracts/test/SnoozeMocks.sol",
]);
ok("Snooze and PooledLaunchBuy compile in one unit", !!all.Snooze && !!all.PooledLaunchBuy);
ok("with no warnings", warnings.length === 0,
   warnings.map(w => w.message.split("\n")[0]).join("; "));

const w = v => (typeof v === "string" && v.startsWith("0x")
  ? v.slice(2) : BigInt(v).toString(16)).padStart(64, "0");

/// A launch: Snooze token, an oracle, a market pool, a router that sells Snooze for ETH, and
/// a PooledLaunchBuy pointed at all of it.
async function launch(opts = {}) {
  const evm = await createEVM();
  for (const a of [A, B, C, DEPLOYER]) await fund(evm, a, 1000n * E);

  const orc = await deploy(all.MockOracle.evm.bytecode.object, "", { evm });
  await call({ evm, address: orc.address }, "set(uint256,uint256,bool)",
    [opts.spot ?? E, opts.twap ?? E, 1]);

  const tok = await deploy(all.Snooze.evm.bytecode.object,
    [SUPPLY, orc.address.toString(), DEV, opts.devBps ?? 0].map(w).join(""), { evm });

  // The router mints Snooze to the buyer, standing in for the AMM. It has to hold a float,
  // and it is registered as capExempt for the same reason a real pool must be: a pool that
  // could only pay out 20% of its balance a day is not a pool.
  const rtr = await deploy(all.SnoozeRouter.evm.bytecode.object,
    w(tok.address.toString()), { evm });
  await call({ evm, address: tok.address }, "setCapExempt(address,bool)",
    [rtr.address.toString(), 1], { from: DEPLOYER });
  await call({ evm, address: tok.address }, "setCapExempt(address,bool)",
    [DEPLOYER, 1], { from: DEPLOYER });
  await call({ evm, address: tok.address }, "transfer(address,uint256)",
    [rtr.address.toString(), SUPPLY / 2n], { from: DEPLOYER, timestamp: T_OPEN });

  const pool = await deploy(all.PooledLaunchBuy.evm.bytecode.object,
    [rtr.address.toString(), tok.address.toString(), T_EXEC, T_REFUND, 0,
     opts.exitFeeBps ?? 0, opts.minTokensPerEth ?? 1].map(w).join(""), { evm });

  if (opts.exemptPool !== false)
    await call({ evm, address: tok.address }, "setCapExempt(address,bool)",
      [pool.address.toString(), 1], { from: DEPLOYER });

  return { evm, orc, tok: { evm, address: tok.address }, rtr: { evm, address: rtr.address }, pool };
}
const bal = async (x, who) => (await call(x.tok, "balanceOf(address)", [who])).words[0];

console.log("── the happy path, end to end");
{
  const x = await launch();
  await call(x.pool, "deposit()", [], { from: A, value: 3n * E, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: B, value: 1n * E, timestamp: T_OPEN });
  const ex = await call(x.pool, "execute(uint256)", [0], { from: C, timestamp: T_EXEC });
  ok("the consolidated buy goes through", ex.ok, ex.revert);

  const got = (await call(x.pool, "tokensReceived()")).words[0];
  ok("the pool now holds Snooze", got > 0n, String(got));
  eq("and the buy was not haircut — Rule 1 only touches sells",
     await bal(x, x.pool.address.toString()), got);

  const cA = await call(x.pool, "claim()", [], { from: A, timestamp: T_EXEC });
  ok("A can claim", cA.ok, cA.revert);
  const cB = await call(x.pool, "claim()", [], { from: B, timestamp: T_EXEC });
  ok("B can claim", cB.ok, cB.revert);
  eq("A put in 3 of 4 and receives three quarters", await bal(x, A), got * 3n / 4n);
  eq("B receives one quarter", await bal(x, B), got / 4n);
  ok("and the two together never exceed what arrived",
     (await bal(x, A)) + (await bal(x, B)) <= got);
}

console.log("── the wiring bug: Rule 2 throttles the distribution");
{
  // This is the whole reason to run the two together. PooledLaunchBuy.claim() is an OUTBOUND
  // transfer from the pool contract, so Snooze's 20%/day cap applies to it. Without an
  // exemption the distribution cannot complete: the fifth claimant is refused, and the pool's
  // baseline shrinks each day so it never catches up.
  const x = await launch({ exemptPool: false });
  for (const who of [A, B, C]) await fund(x.evm, who, 1000n * E);
  await call(x.pool, "deposit()", [], { from: A, value: 1n * E, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: B, value: 1n * E, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: C, value: 1n * E, timestamp: T_OPEN });
  await call(x.pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });

  const first = await call(x.pool, "claim()", [], { from: A, timestamp: T_EXEC });
  ok("the first claimant gets 33%, which is over the 20% cap, and is REFUSED",
     !first.ok, "if this passes, the cap is not being applied to the distribution");

  // And it is not a timing problem that waiting fixes: each depositor's share is a third of
  // the bag, and no single day ever allows a third.
  const later = await call(x.pool, "claim()", [], { from: A, timestamp: T_EXEC + DAY * 30 });
  ok("and still refused thirty days later, because the share is fixed and the cap is not",
     !later.ok);
}
{
  // With the exemption the same distribution completes in one block.
  const x = await launch({ exemptPool: true });
  for (const who of [A, B, C]) await fund(x.evm, who, 1000n * E);
  for (const who of [A, B, C])
    await call(x.pool, "deposit()", [], { from: who, value: 1n * E, timestamp: T_OPEN });
  await call(x.pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });
  let allOk = true;
  for (const who of [A, B, C]) {
    const r = await call(x.pool, "claim()", [], { from: who, timestamp: T_EXEC });
    if (!r.ok) allOk = false;
  }
  ok("exempting the distributor lets every claim settle immediately", allOk);
  const got = (await call(x.pool, "tokensReceived()")).words[0];
  const sum = (await bal(x, A)) + (await bal(x, B)) + (await bal(x, C));
  ok("and the three shares still never exceed what arrived", sum <= got, `${sum} > ${got}`);
  ok("with only dust left behind", got - sum < 10n, String(got - sum));
}

console.log("── but the exemption is a hole, so it must be bounded");
{
  // A cap-exempt address can move its whole balance. The distributor needs that to pay
  // claimants; it must not be usable to move the bag anywhere else. The protection is that
  // PooledLaunchBuy has no function that sends tokens to an arbitrary address — claim() pays
  // msg.sender their own recorded share and nothing else. That is a property of the ABI, and
  // asserting it here is what keeps it true.
  const abi = all.PooledLaunchBuy.abi.filter(f => f.type === "function");
  const movers = abi.filter(f => /transfer|send|sweep|rescue|withdraw|payout|distribute/i.test(f.name));
  eq("the distributor has no function that sends tokens to a chosen address", movers.length, 0);
  const claimFn = abi.find(f => f.name === "claim");
  ok("claim takes no arguments, so a caller cannot name a recipient",
     claimFn && claimFn.inputs.length === 0);
}

console.log("── what the pooled buyers actually hold afterwards");
{
  // Each claimant now holds Snooze in their own wallet, which means Rule 2 applies to THEM
  // from that moment. A pooled buyer is not exempt just because their purchase was.
  const x = await launch({ spot: 2n * E, twap: E });
  await call(x.pool, "deposit()", [], { from: A, value: 4n * E, timestamp: T_OPEN });
  await call(x.pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });
  await call(x.pool, "claim()", [], { from: A, timestamp: T_EXEC });
  const holding = await bal(x, A);
  ok("the claimant holds tokens", holding > 0n);

  const r = await call(x.tok, "remainingToday(address)", [A]);
  eq("and is immediately subject to the 20% cap like anyone else", r.words[0], holding / 5n);

  // Selling into a spike is haircut exactly as it would be for any other holder.
  await call(x.tok, "setPool(address,bool)", [B, 1], { from: DEPLOYER });
  const q = await call(x.tok, "quoteSell(uint256)", [holding / 5n]);
  eq("selling their allowance into a 2x spike burns half",
     q.words[1], (holding / 5n) * 5000n / 10_000n);
}

console.log("── the refund path is unaffected by the token's rules");
{
  // If the launch never happens the depositors get ETH back, and ETH is not Snooze, so
  // neither rule can touch it. Worth pinning: the failure mode of a token with transfer
  // restrictions is usually that the escape hatch inherits them.
  const x = await launch();
  await call(x.pool, "deposit()", [], { from: A, value: 2n * E, timestamp: T_OPEN });
  const r = await call(x.pool, "refund()", [], { from: A, timestamp: T_REFUND });
  ok("a refund settles regardless of Rule 2", r.ok, r.revert);
}

console.log("── the launchpad invariant: a decaying tax must not make waiting dominant");
{
  // All-in cost per token for buyer n is spot(n)/(1 - tau(n)). Spot rises with each buy and
  // (1 - tau) rises as the tax decays, so the all-in cost is rising/rising. If the tax decays
  // FASTER than the price climbs, later buyers pay less than earlier ones, waiting becomes
  // dominant, and since the tax only decays ON BUYS the launch deadlocks: the relief needs
  // the buys that waiting prevents.
  //
  // The condition is exact:  spot(n+1)/spot(n) > (1 - tau(n+1))/(1 - tau(n))
  const effective = (spot, tau) => spot / (1 - tau);
  const simulate = (E0, S, tau0, decay, n) => {
    const out = [];
    let e = E0;
    for (let i = 0; i < n; i++) {
      const tau = Math.max(0, tau0 * Math.pow(1 - decay, i));
      const spot = (e * e) / (E0 * E0);          // price = E^2/k, normalised
      out.push({ i, tau, spot, all: effective(spot, tau) });
      e += S * (1 - tau);
    }
    return out;
  };
  const monotoneUp = r => r.every((x, i) => i === 0 || x.all > r[i - 1].all);

  // A tax that decays slowly against a thin book: early is still cheaper, so buying now wins.
  const slow = simulate(10, 1, 0.30, 0.05, 12);
  ok("a slowly-decaying tax keeps all-in cost rising, so buying early stays dominant",
     monotoneUp(slow), JSON.stringify(slow.map(x => +x.all.toFixed(4))));

  // The same tax decaying fast inverts it: later buyers pay less all-in.
  const fast = simulate(10, 1, 0.60, 0.40, 12);
  ok("a fast-decaying tax INVERTS it — later buyers pay less all-in",
     !monotoneUp(fast), JSON.stringify(fast.map(x => +x.all.toFixed(4))));
  const firstDrop = fast.findIndex((x, i) => i > 0 && x.all <= fast[i - 1].all);
  ok("and the inversion is early, not a tail effect", firstDrop > 0 && firstDrop < 5,
     String(firstDrop));

  // The boundary is not a matter of taste — it is the ratio test, and it can be checked
  // per-step without simulating anything.
  const safe = (spotRatio, tauNow, tauNext) => spotRatio > (1 - tauNext) / (1 - tauNow);
  ok("the ratio test agrees with the simulation on the slow schedule",
     safe(slow[1].spot / slow[0].spot, slow[0].tau, slow[1].tau));
  ok("and on the fast one", !safe(fast[1].spot / fast[0].spot, fast[0].tau, fast[1].tau));
  ok("a zero-decay tax is always safe: the price climbs and the tax does not move",
     safe(1.05, 0.3, 0.3));
  ok("and a tax that decays to zero in one step never is",
     !safe(1.05, 0.5, 0.0));
}

console.log("── depth and appreciation are the same ETH spent twice");
{
  // Routing the tax into the pool as one-sided ETH deepens the book AND raises the price,
  // but less than not taxing at all would have. There is no setting where a tax produces
  // more of both; the choice is which one you want.
  const k = 10 * 1000;                    // E=10, T=1000
  const price = (E_, T_) => E_ / T_;
  const buyNoTax = (E_, T_, S) => { const e = E_ + S; return [e, k / e]; };
  const buyTaxToLp = (E_, T_, S, tau) => {
    const e1 = E_ + S * (1 - tau);
    const t1 = k / e1;
    return [e1 + S * tau, t1];            // the tax lands as reserve, no tokens leave
  };
  const [eA, tA] = buyNoTax(10, 1000, 5);
  const [eB, tB] = buyTaxToLp(10, 1000, 5, 0.3);
  ok("the taxed buy ends with a lower price", price(eB, tB) < price(eA, tA),
     `${price(eB, tB)} vs ${price(eA, tA)}`);
  ok("and a deeper book", eB * tB > eA * tA, `${eB * tB} vs ${eA * tA}`);
  ok("the buyer also holds fewer tokens for the same ETH",
     1000 - tB < 1000 - tA, `${1000 - tB} vs ${1000 - tA}`);
  // Which is the whole trade-off in one line, and it is why "high tax AND fast growth" is
  // a coupled pair rather than two independent goals.
}

console.log("── ultra-high supply is a units choice");
{
  // Doubling supply halves the unit price and changes nobody's share. The only real effect
  // is integer headroom in the floor-divisions that Rule 2 and the pro-rata split perform.
  // The measurable effect is floor-division dust in the pro-rata split. Distributing a bag
  // among N claimants loses at most N-1 base units whatever the supply, so the dust as a
  // FRACTION of the bag falls as the supply rises. That is the entire economic case for a
  // large supply, and it is a rounding argument, not a growth one.
  const dustFraction = (supply, claimants) => {
    const bag = supply / 2n;
    const each = bag / BigInt(claimants);
    const distributed = each * BigInt(claimants);
    return Number(bag - distributed) / Number(bag);
  };
  const smallDust = dustFraction(1_000_000n * E, 7919);
  const hugeDust = dustFraction(SUPPLY, 7919);
  ok("dust exists at any supply", smallDust >= 0 && hugeDust >= 0);
  ok("but it is a smaller fraction of a larger supply",
     hugeDust <= smallDust, `${hugeDust} vs ${smallDust}`);
  ok("and at this supply it is negligible", hugeDust < 1e-24, String(hugeDust));
  // The thing a large supply does NOT do: change anyone's share.
  const shareOf = (supply, n) => Number((supply / BigInt(n)) * 10_000n / supply) / 10_000;
  ok("a holder's fraction is identical at either supply",
     Math.abs(shareOf(1_000_000n * E, 8) - shareOf(SUPPLY, 8)) < 1e-12);
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
