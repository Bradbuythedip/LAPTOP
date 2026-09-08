// contracts/SnoozeLaunchpad.sol, compiled and EXECUTED.
//
// The launchpad exists for one reason: run-wiring.mjs showed that a launcher who wires Snooze
// to PooledLaunchBuy by hand produces a distribution that cannot complete, and finds out on
// distribution day with the money already in. So the assertions that matter here are not
// "launch works" — they are "the bug cannot be made" and "nobody keeps a key".
//   node test/run-launchpad.mjs
import fs from "node:fs";
import { compile, deploy, call, fund } from "./evm.mjs";
import { createEVM } from "@ethereumjs/evm";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push("  ok   " + name); }
  else { fail++; results.push("  FAIL " + name + (extra ? "\n         " + extra : "")); }
}
const eq = (name, got, want) => ok(name, got === want, `got ${got}, want ${want}`);

const E = 10n ** 18n;
const SUPPLY = 1_000_000_000_000n * E;
const LAUNCHER = "0x00000000000000000000000000000000000000aa";
const DEV = "0x00000000000000000000000000000000000000de";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const STRANGER = "0x00000000000000000000000000000000000000ff";
const T_OPEN = 1000, T_EXEC = 100000, T_REFUND = 100000 + 86400 * 2, DAY = 86400;

console.log("── it compiles");
const { contracts, all, warnings } = compile([
  "contracts/SnoozeLaunchpad.sol", "contracts/Snooze.sol", "contracts/PooledLaunchBuy.sol",
  "contracts/test/Mocks.sol", "contracts/test/SnoozeMocks.sol",
]);
ok("compiles with no errors", !!contracts.SnoozeLaunchpad);
ok("and no warnings", warnings.length === 0,
   warnings.map(w => w.message.split("\n")[0]).join("; "));

const w = v => (typeof v === "string" && v.startsWith("0x")
  ? v.slice(2) : BigInt(v).toString(16)).padStart(64, "0");

/// Params is a static struct, so it encodes inline as nine words.
const params = o => [
  o.supply ?? SUPPLY, o.oracle, o.dev ?? DEV, o.devBps ?? 0, o.router,
  o.executeAfter ?? T_EXEC, o.refundAfter ?? T_REFUND, o.minDeposit ?? 0, o.exitFeeBps ?? 0,
  o.minTokensPerEth ?? 1,
].map(w).join("");

async function pad() {
  const evm = await createEVM();
  for (const a of [LAUNCHER, A, B, C, STRANGER]) await fund(evm, a, 1000n * E);
  const orc = await deploy(all.MockOracle.evm.bytecode.object, "", { evm });
  await call({ evm, address: orc.address }, "set(uint256,uint256,bool)", [E, E, 1]);
  const lp = await deploy(contracts.SnoozeLaunchpad.evm.bytecode.object, "", { evm });
  return { evm, orc, lp };
}
console.log("── a launch wires everything, in one transaction");
{
  const x = await pad();
  const rtr = await deploy(all.SnoozeRouter.evm.bytecode.object,
    w("0x0000000000000000000000000000000000000001"), { evm: x.evm });
  const data = params({ oracle: x.orc.address.toString(), router: rtr.address.toString() });
  const r = await call(x.lp,
    "launch((uint256,address,address,uint256,address,uint64,uint64,uint256,uint256,uint256))",
    [], { from: LAUNCHER, timestamp: T_OPEN, raw: data });
  ok("launch succeeds", r.ok, r.revert);
  const [token, pool] = r.words;
  const tokAddr = "0x" + token.toString(16).padStart(40, "0");
  const poolAddr = "0x" + pool.toString(16).padStart(40, "0");
  const tok = { evm: x.evm, address: (await import("./evm.mjs")).createAddressFromString(tokAddr) };

  eq("the launchpad recorded it", (await call(x.lp, "count()")).words[0], 1n);
  eq("the distributor is cap-exempt — the wiring bug, made in the constructor",
     (await call(tok, "capExempt(address)", [poolAddr])).words[0], 1n);
  eq("the venue is registered as a pool",
     (await call(tok, "isPool(address)", [rtr.address.toString()])).words[0], 1n);
  eq("and the token is already frozen", (await call(tok, "frozen()")).words[0], 1n);
  eq("the launcher holds the supply to seed with",
     (await call(tok, "balanceOf(address)", [LAUNCHER])).words[0], SUPPLY);
}

console.log("── nobody keeps a key, including the launchpad");
{
  const x = await pad();
  const rtr = await deploy(all.SnoozeRouter.evm.bytecode.object,
    w("0x0000000000000000000000000000000000000001"), { evm: x.evm });
  const r = await call(x.lp,
    "launch((uint256,address,address,uint256,address,uint64,uint64,uint256,uint256,uint256))",
    [], { from: LAUNCHER, timestamp: T_OPEN,
          raw: params({ oracle: x.orc.address.toString(), router: rtr.address.toString() }) });
  const tokAddr = "0x" + r.words[0].toString(16).padStart(40, "0");
  const tok = { evm: x.evm, address: (await import("./evm.mjs")).createAddressFromString(tokAddr) };

  // The launchpad was admin for the length of one transaction and gave it up inside it.
  for (const [who, label] of [[LAUNCHER, "the launcher"], [STRANGER, "a stranger"]]) {
    const a = await call(tok, "setCapExempt(address,bool)", [who, 1], { from: who });
    ok(`${label} cannot grant an exemption`, !a.ok);
    const b = await call(tok, "setPool(address,bool)", [who, 1], { from: who });
    ok(`${label} cannot register a pool`, !b.ok);
  }
  // And the launchpad itself has no function that would let it try.
  const abi = contracts.SnoozeLaunchpad.abi.filter(f => f.type === "function");
  const names = abi.map(f => f.name);
  ok("the launchpad exposes no admin surface at all",
     !names.some(n => /setPool|setCapExempt|freeze|rescue|sweep|withdraw|upgrade|owner/i.test(n)),
     names.join(","));
  ok("its only state-changing function is launch",
     abi.filter(f => f.stateMutability !== "view" && f.stateMutability !== "pure")
        .every(f => f.name === "launch"),
     abi.filter(f => f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map(f => f.name).join(","));
}

console.log("── the distribution completes, which is the whole point");
{
  const x = await pad();
  const rtr = await deploy(all.SnoozeRouter.evm.bytecode.object,
    w("0x0000000000000000000000000000000000000001"), { evm: x.evm });
  const r = await call(x.lp,
    "launch((uint256,address,address,uint256,address,uint64,uint64,uint256,uint256,uint256))",
    [], { from: LAUNCHER, timestamp: T_OPEN,
          raw: params({ oracle: x.orc.address.toString(), router: rtr.address.toString() }) });
  const tokAddr = "0x" + r.words[0].toString(16).padStart(40, "0");
  const poolAddr = "0x" + r.words[1].toString(16).padStart(40, "0");
  const mk = (await import("./evm.mjs")).createAddressFromString;
  const tok = { evm: x.evm, address: mk(tokAddr) };
  const pool = { evm: x.evm, address: mk(poolAddr) };

  // Point the router at the real token and give it a float to sell.
  await call({ evm: x.evm, address: rtr.address }, "setToken(address)", [tokAddr]);
  await call(tok, "transfer(address,uint256)", [rtr.address.toString(), SUPPLY / 2n],
    { from: LAUNCHER, timestamp: T_OPEN });

  // Three depositors, each owed a third — the exact case that could not complete by hand.
  for (const who of [A, B, C])
    await call(pool, "deposit()", [], { from: who, value: 1n * E, timestamp: T_OPEN });
  ok("three depositors are in", (await call(pool, "totalDeposited()")).words[0] === 3n * E);

  const ex = await call(pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });
  ok("the consolidated buy executes", ex.ok, ex.revert);

  let allClaimed = true;
  for (const who of [A, B, C]) {
    const c = await call(pool, "claim()", [], { from: who, timestamp: T_EXEC });
    if (!c.ok) allClaimed = false;
  }
  ok("and every claimant is paid — a third each, over the 20% cap, and it still settles",
     allClaimed, "this is the bug the launchpad exists to prevent");
  const got = (await call(pool, "tokensReceived()")).words[0];
  const sum = (await call(tok, "balanceOf(address)", [A])).words[0]
            + (await call(tok, "balanceOf(address)", [B])).words[0]
            + (await call(tok, "balanceOf(address)", [C])).words[0];
  ok("with the shares never exceeding what arrived", sum <= got, `${sum} > ${got}`);
  ok("and only dust left behind", got - sum < 10n, String(got - sum));

  // And each claimant is under Rule 2 from that moment — the exemption belonged to the
  // distributor, not to them.
  const holding = (await call(tok, "balanceOf(address)", [A])).words[0];
  eq("a claimant is capped at 20% like anyone else",
     (await call(tok, "remainingToday(address)", [A])).words[0], holding / 5n);
  eq("and is not exempt", (await call(tok, "capExempt(address)", [A])).words[0], 0n);
}

console.log("── what it refuses, before the money is in rather than after");
{
  const x = await pad();
  const rtr = await deploy(all.SnoozeRouter.evm.bytecode.object,
    w("0x0000000000000000000000000000000000000001"), { evm: x.evm });
  const base = { oracle: x.orc.address.toString(), router: rtr.address.toString() };
  const tryLaunch = async o => call(x.lp,
    "launch((uint256,address,address,uint256,address,uint64,uint64,uint256,uint256,uint256))",
    [], { from: LAUNCHER, timestamp: T_OPEN, raw: params({ ...base, ...o }) });

  ok("a zero supply is refused", !(await tryLaunch({ supply: 0 })).ok);
  ok("a dev cut above 20% of the haircut is refused", !(await tryLaunch({ devBps: 2001 })).ok);
  ok("a refund window that closes before it opens is refused",
     !(await tryLaunch({ executeAfter: T_REFUND, refundAfter: T_EXEC })).ok);
  ok("a refund window shorter than a day is refused",
     !(await tryLaunch({ executeAfter: T_EXEC, refundAfter: T_EXEC + 3600 })).ok);
  ok("an exit fee that confiscates the deposit is refused",
     !(await tryLaunch({ exitFeeBps: 10_000 })).ok);
  ok("a launch with no oracle is refused",
     !(await tryLaunch({ oracle: "0x" + "0".repeat(40) })).ok);
  ok("but a sane one goes through", (await tryLaunch({})).ok);

  // validate() is pure, so a page can check a proposal without sending anything.
  const v = await call(x.lp,
    "validate((uint256,address,address,uint256,address,uint64,uint64,uint256,uint256,uint256))",
    [], { raw: params({ ...base, devBps: 5000 }) });
  eq("validate says no without a transaction", v.words[0], 0n);
}

console.log("── the decay condition is on chain, not in a spreadsheet");
{
  const x = await pad();
  // spot(n+1)/spot(n) > (1 - tau(n+1))/(1 - tau(n)), in integers.
  const better = async (sNow, sNext, tNow, tNext) =>
    (await call(x.lp, "earlyStaysBetter(uint256,uint256,uint256,uint256)",
      [sNow, sNext, tNow, tNext])).words[0] === 1n;

  ok("price up 5%, tax flat: early stays better", await better(100, 105, 3000, 3000));
  ok("price up 5%, tax 30% -> 28%: still better", await better(100, 105, 3000, 2800));
  ok("price up 5%, tax 30% -> 20%: INVERTED, waiting wins",
     !(await better(100, 105, 3000, 2000)));
  ok("price up 5%, tax 50% -> 0%: badly inverted", !(await better(100, 105, 5000, 0)));
  ok("a flat price with any decay is always inverted", !(await better(100, 100, 3000, 2999)));
  ok("a 100% tax is refused rather than dividing by zero",
     !(await better(100, 105, 10_000, 0)));
  // The boundary: the tax may fall to exactly the point where the price rise offsets it.
  ok("at the exact boundary it is not better, it is equal",
     !(await better(10_000, 10_500, 3000, 2650)));
  ok("a hair inside the boundary is better", await better(10_000, 10_500, 3000, 2651));
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
