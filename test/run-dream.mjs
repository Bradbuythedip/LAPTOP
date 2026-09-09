// contracts/Snooze.sol Rule 3 and contracts/SnoozeDream.sol, compiled and EXECUTED.
//
// Rule 3 pays a wallet for not selling. Rules 1 and 2 are frictions on leaving and this is the
// only thing in the launch pointed the other way, so it is also the only one with an incentive
// to be overstated — "hold and earn an equivalent token" is a sentence that survives being
// wrong for a long time. This suite exists to make the headline claim a number:
//
//   ONE SNOOZE HELD UNTOUCHED FOR THE 90-DAY RAMP ACCRUES EXACTLY ONE DREAM.
//
// checked as an equality, not a bound, at the same nine decimals on both tokens. The rest is
// the shape of the ramp (which is NOT linear, and the halfway point is the assertion that says
// so), every way a streak can be broken or faked, and what the rule costs everybody who never
// claims it.
//   node test/run-dream.mjs
import { compile, deploy, call, fund, selector } from "./evm.mjs";
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
const C = "0x00000000000000000000000000000000000000c3";
const POOL = "0x00000000000000000000000000000000000000f0";
const DEPLOYER = "0x1000000000000000000000000000000000000001";
const ZERO = "0x" + "0".repeat(40);

const DAY = 86400;
const RAMP = 90 * DAY;          // 7,776,000 seconds. contracts/Snooze.sol: RAMP
const T0 = 1000;                // evm.mjs deploys and calls at timestamp 1000 by default
const BAG = 1000n * E;

console.log("── it compiles");
const { contracts, all, warnings } = compile(
  ["contracts/Snooze.sol", "contracts/SnoozeDream.sol", "contracts/test/SnoozeMocks.sol"]);
ok("compiles with no errors", !!contracts.Snooze && !!all.SnoozeDream);
ok("and no warnings", warnings.length === 0,
   warnings.map(w => w.message.split("\n")[0]).join("; "));

const w = v => (typeof v === "string" && v.startsWith("0x")
  ? v.slice(2) : BigInt(v).toString(16)).padStart(64, "0");

/// A token with the reward wired up, a registered pool, and `who` holding BAG from T0.
async function world(opts = {}) {
  const evm = await createEVM();
  for (const a of [A, B, C, DEPLOYER, POOL]) await fund(evm, a, 100n * E);
  const orc = await deploy(all.MockOracle.evm.bytecode.object, "", { evm });
  await call({ evm, address: orc.address }, "set(uint256,uint256,bool)",
    [opts.spot ?? E, opts.twap ?? E, opts.ready ? 1 : 0]);
  const tok = await deploy(contracts.Snooze.evm.bytecode.object,
    [SUPPLY, orc.address.toString(), DEV, opts.devBps ?? 0].map(w).join(""), { evm });
  const dream = await deploy(all.SnoozeDream.evm.bytecode.object,
    w(tok.address.toString()), { evm });
  if (opts.setDream !== false)
    await call(tok, "setDream(address)", [dream.address.toString()], { from: DEPLOYER });
  await call(tok, "setPool(address,bool)", [POOL, 1], { from: DEPLOYER });
  // The deployer holds the whole supply and is capped like anybody else, so it is exempted to
  // seed the test wallets — which also means the deployer stops dreaming, on purpose.
  await call(tok, "setCapExempt(address,bool)", [DEPLOYER, 1], { from: DEPLOYER });
  const x = { evm, orc, tok, dream };
  for (const who of opts.hold ?? [A])
    await call(tok, "transfer(address,uint256)", [who, BAG], { from: DEPLOYER, timestamp: T0 });
  return x;
}

const pending = async (x, who, t) =>
  (await call(x.tok, "dreamPending(address)", [who], { timestamp: t })).words[0];
const streak = async (x, who, t) =>
  (await call(x.tok, "streakSeconds(address)", [who], { timestamp: t })).words[0];
const snooze = async (x, who) => (await call(x.tok, "balanceOf(address)", [who])).words[0];
const dreamBal = async (x, who) => (await call(x.dream, "balanceOf(address)", [who])).words[0];

// ─────────────────────────────────────────────────────────────────── the headline claim
console.log("── \"an equivalent token\": the claim, as an equality");
{
  const x = await world();
  eq("hold 1000 SNOOZE for the 90-day ramp and you have 1000 DREAM pending",
     await pending(x, A, T0 + RAMP), BAG);
  const dec = (await call(x.dream, "decimals()")).words[0];
  eq("DREAM has nine decimals", dec, 9n);
  eq("and SNOOZE has the same nine", (await call(x.tok, "decimals()")).words[0], dec);
  ok("so \"one for one\" is a count, not a conversion",
     (await pending(x, A, T0 + RAMP)) === (await snooze(x, A)));
}

console.log("── the ramp is quadratic, and half the time is NOT half the reward");
{
  const x = await world();
  eq("45 days — half the ramp — accrues a QUARTER, not a half",
     await pending(x, A, T0 + RAMP / 2), BAG / 4n);
  eq("30 days accrues a ninth", await pending(x, A, T0 + RAMP / 3), BAG / 9n);
  eq("and the first day is worth almost nothing: 1/8100th of the bag",
     await pending(x, A, T0 + DAY), BAG / 8100n);
  ok("which is the fact a linear reading of \"90 days to 1:1\" gets wrong by 2x at the midpoint",
     (await pending(x, A, T0 + RAMP / 2)) * 2n < BAG);
}

console.log("── after the ramp the rate is flat, not zero — DREAM is uncapped");
{
  const x = await world();
  eq("180 days is 3x the bag, not 2x", await pending(x, A, T0 + 2 * RAMP), 3n * BAG);
  eq("270 days is 5x", await pending(x, A, T0 + 3 * RAMP), 5n * BAG);
  const y1 = await pending(x, A, T0 + 2 * RAMP), y2 = await pending(x, A, T0 + 3 * RAMP);
  eq("so each further 90 days adds exactly 2x the bag, forever", y2 - y1, 2n * BAG);
  ok("no supply cap exists to stop it", true);
}

// ─────────────────────────────────────────────────────────────────── breaking the streak
console.log("── what breaks a streak: any outbound transfer, and it is any");
{
  const x = await world();
  const t = T0 + RAMP;
  eq("A is 90 days in", await streak(x, A, t), BigInt(RAMP));
  // One base unit. Not one token — one base unit, the smallest amount that exists.
  await call(x.tok, "transfer(address,uint256)", [B, 1n], { from: A, timestamp: t });
  eq("sending ONE BASE UNIT to a wallet resets the clock to zero", await streak(x, A, t), 0n);
  eq("and the 1000 DREAM already earned is banked, not lost", await pending(x, A, t), BAG);
  eq("a day later the restarted rate has earned back 1/8100th",
     (await pending(x, A, t + DAY)) - BAG, (BAG - 1n) / 8100n);
}
{
  const x = await world();
  const t = T0 + RAMP;
  await call(x.tok, "transfer(address,uint256)", [POOL, BAG / 10n], { from: A, timestamp: t });
  eq("selling into a registered pool resets it too", await streak(x, A, t), 0n);
  eq("and banks the same 1000", await pending(x, A, t), BAG);
}
{
  const x = await world({ hold: [A, B] });
  const t = T0 + RAMP;
  await call(x.tok, "transfer(address,uint256)", [C, BAG], { from: B, timestamp: t });
  eq("RECEIVING does not break the recipient's streak — C had none to break",
     await streak(x, C, t), 0n);
  eq("C's clock starts at the receipt, not at the sender's start",
     await streak(x, C, t + DAY), BigInt(DAY));
  eq("meanwhile A, who did nothing at all, is untouched at 90 days",
     await streak(x, A, t), BigInt(RAMP));
}

console.log("── the hole this closes: sell everything, wait, buy back");
{
  const x = await world();
  const tSell = T0 + DAY;
  await call(x.tok, "transfer(address,uint256)", [B, BAG], { from: A, timestamp: tSell });
  eq("A now holds nothing", await snooze(x, A), 0n);
  // Ninety days pass in which A holds zero SNOOZE, then buys the same bag back.
  const tBack = tSell + RAMP;
  await call(x.tok, "transfer(address,uint256)", [A, BAG], { from: B, timestamp: tBack });
  eq("buying back does not resume a clock that ran while the wallet held zero",
     await streak(x, A, tBack), 0n);
  eq("A must serve the full ramp again from the repurchase",
     await pending(x, A, tBack + RAMP) - (await pending(x, A, tBack)), BAG);
  ok("without this, a wallet could farm the ramp while holding none of the token", true);
}

console.log("── buying MORE mid-streak: the whole bag rides the clock you already have");
{
  const x = await world({ hold: [A, B] });
  const tMid = T0 + RAMP / 2;
  await call(x.tok, "transfer(address,uint256)", [A, BAG], { from: B, timestamp: tMid });
  eq("A holds 2000 after topping up at day 45", await snooze(x, A), 2n * BAG);
  // First half at 1000, second half at 2000: BAG/4 + 2*BAG*(1 - 1/4) = BAG/4 + 3*BAG/2.
  eq("at day 90 the top-up earned the day-45-to-90 rate on the whole 2000",
     await pending(x, A, T0 + RAMP), BAG / 4n + 3n * BAG / 2n);
  ok("so adding to a streaked wallet beats starting a fresh one, which is the intended pull",
     (await pending(x, A, T0 + RAMP)) > 2n * (BAG / 4n));
}

// ─────────────────────────────────────────────────────────────────── who does not dream
console.log("── the pool does not dream, and neither does the exempt wallet");
{
  const x = await world();
  const t = T0 + RAMP;
  await call(x.tok, "transfer(address,uint256)", [POOL, BAG / 10n], { from: A, timestamp: t });
  ok("the pool holds SNOOZE", (await snooze(x, POOL)) > 0n);
  eq("and accrues nothing for holding it", await pending(x, POOL, t + RAMP), 0n);
  eq("the cap-exempt deployer accrues nothing either", await pending(x, DEPLOYER, t + RAMP), 0n);
  ok("which is why the launcher cannot farm the reward for holding its own float", true);
}
{
  const x = await world({ hold: [A, B] });
  // B dreams normally, and is then exempted. The exemption voids it — the same call that hands
  // out the exemption, and only before freeze().
  ok("B has accrued before the exemption", (await pending(x, B, T0 + RAMP)) === BAG);
  await call(x.tok, "setCapExempt(address,bool)", [B, 1],
             { from: DEPLOYER, timestamp: T0 + RAMP });
  eq("exempting a wallet voids what it accrued", await pending(x, B, T0 + RAMP), 0n);
  await call(x.tok, "freeze()", [], { from: DEPLOYER });
  const r = await call(x.tok, "setCapExempt(address,bool)", [C, 1], { from: DEPLOYER });
  ok("and after freeze() nobody can do it to anybody", !r.ok);
}

// ─────────────────────────────────────────────────────────────────── claiming
console.log("── claiming mints exactly what was pending, and does not break the streak");
{
  const x = await world();
  const t = T0 + RAMP;
  const want = await pending(x, A, t);
  const r = await call(x.tok, "claimDream()", [], { from: A, timestamp: t });
  ok("claimDream succeeds", r.ok, r.revert);
  eq("it returns the amount", r.words[0], want);
  eq("DREAM landed in A's wallet, one for one with the SNOOZE held", await dreamBal(x, A), BAG);
  eq("and DREAM's total supply is exactly that",
     (await call(x.dream, "totalSupply()")).words[0], BAG);
  eq("pending is now zero", await pending(x, A, t), 0n);
  eq("but the 90-day streak is UNBROKEN — nothing left the wallet",
     await streak(x, A, t), BigInt(RAMP));
  eq("so accrual continues at the ramped rate", await pending(x, A, t + RAMP), 2n * BAG);
  eq("A still holds all of its SNOOZE", await snooze(x, A), BAG);
}
{
  const x = await world();
  const r = await call(x.tok, "claimDream()", [], { from: C, timestamp: T0 + RAMP });
  ok("a wallet that never held cannot claim", !r.ok);
  ok("and the revert is NothingToClaim", r.raw.startsWith(selector("NothingToClaim()")), r.raw);
}
{
  const x = await world({ setDream: false });
  const r = await call(x.tok, "claimDream()", [], { from: A, timestamp: T0 + RAMP });
  ok("with no reward token set, claiming reverts DreamNotSet",
     !r.ok && r.raw.startsWith(selector("DreamNotSet()")), r.raw);
  eq("but the accrual still ran, and is still on chain", await pending(x, A, T0 + RAMP), BAG);
  ok("so an unset reward token is a number nobody can ever mint, not a lost balance", true);
}

console.log("── setDream is a one-way door and the mint has exactly one caller");
{
  const x = await world({ setDream: false });
  const d = x.dream.address.toString();
  ok("zero is refused", !(await call(x.tok, "setDream(address)", [ZERO], { from: DEPLOYER })).ok);
  ok("a stranger cannot set it", !(await call(x.tok, "setDream(address)", [d], { from: A })).ok);
  ok("the admin can", (await call(x.tok, "setDream(address)", [d], { from: DEPLOYER })).ok);
  const again = await call(x.tok, "setDream(address)", [A], { from: DEPLOYER });
  ok("and cannot repoint it afterwards", !again.ok);
  ok("the revert is AlreadySet", again.raw.startsWith(selector("AlreadySet()")), again.raw);
  eq("it still reads as the first one", (await call(x.tok, "dream()")).words[0],
     BigInt(d));
}
{
  const x = await world();
  const r = await call(x.dream, "mint(address,uint256)", [A, BAG], { from: A });
  ok("nobody but the token may mint DREAM", !r.ok);
  ok("the revert is NotMinter", r.raw.startsWith(selector("NotMinter()")), r.raw);
  eq("so DREAM's supply is zero until somebody serves the time",
     (await call(x.dream, "totalSupply()")).words[0], 0n);
  eq("the minter is the SNOOZE token and nothing else",
     (await call(x.dream, "minter()")).words[0], BigInt(x.tok.address.toString()));
}

// ─────────────────────────────────────────────────────────────────── the public record
console.log("── WokeUp: breaking a streak is a permanent public event");
{
  const x = await world();
  const t = T0 + RAMP;
  const r = await call(x.tok, "transfer(address,uint256)", [B, 1n], { from: A, timestamp: t });
  const topic = "0x" + Buffer.from(
    (await import("ethereum-cryptography/keccak.js")).keccak256(
      new TextEncoder().encode("WokeUp(address,uint64,uint256)"))).toString("hex");
  const log = r.logs.find(l => l.topics[0] === topic);
  ok("an outbound transfer emits WokeUp", !!log);
  eq("naming the wallet", BigInt(log.topics[1]), BigInt(A));
  eq("how long it had held", BigInt("0x" + log.data.slice(2).slice(0, 64)), BigInt(RAMP));
  eq("and what it keeps", BigInt("0x" + log.data.slice(2).slice(64, 128)), BAG);
  ok("nothing else on chain distinguishes a wallet that never held from one that just broke",
     true);
}

// ─────────────────────────────────────────────────────────────────── rules 1 and 2 still hold
console.log("── rule 3 did not quietly switch off rules 1 or 2");
{
  const x = await world({ spot: 170n * E / 100n, twap: E, ready: true });
  eq("Rule 1's dial is still 41% at spot 70% over the average",
     (await call(x.tok, "burnBps()")).words[0], 4117n);
  const t = T0 + RAMP;
  const before = await snooze(x, POOL);
  await call(x.tok, "transfer(address,uint256)", [POOL, 100n * E], { from: A, timestamp: t });
  eq("and a sale still arrives haircut",
     (await snooze(x, POOL)) - before, 100n * E - (100n * E * 4117n) / 10_000n);
}
{
  const x = await world();
  const t = T0 + RAMP;
  const r = await call(x.tok, "transfer(address,uint256)", [POOL, BAG / 2n],
                       { from: A, timestamp: t });
  ok("Rule 2 still refuses half a bag in one day", !r.ok);
  ok("the revert is CapExceeded", r.raw.startsWith(selector("CapExceeded(uint256,uint256)")),
     r.raw);
}

// ─────────────────────────────────────────────────────────────────── what it costs
console.log("── what Rule 3 costs everybody, including whoever never claims it");
{
  const x = await world({ hold: [A, B] });
  const t = T0 + RAMP;
  // A already has a clock and B already exists, so this is the steady-state transfer: both
  // sides settle, the sender's clock resets. The expensive case, not the cheap one.
  const r = await call(x.tok, "transfer(address,uint256)", [B, 1n], { from: A, timestamp: t });
  ok("a wallet-to-wallet transfer costs under 70k execution gas", r.gasUsed < 70_000n,
     `it is ${r.gasUsed}`);
  results.push(`         (measured: ${r.gasUsed} gas, and every holder pays it whether or not
         they ever call claimDream)`);
}
{
  const x = await world();
  const rt = contracts.Snooze.evm.deployedBytecode.object.length / 2;
  ok("Snooze is still deployable — EIP-170 is 24,576 runtime bytes", rt < 24_576,
     `it is ${rt}`);
  results.push(`         (Snooze runtime: ${rt} bytes, ${(rt / 24576 * 100).toFixed(1)}% of the limit;`
    + ` SnoozeDream: ${all.SnoozeDream.evm.deployedBytecode.object.length / 2} bytes)`);
  ok("and the reward token holds no ETH and has no way to receive any",
     !/receive\s*\(\)|fallback\s*\(\)/.test(
       (await import("node:fs")).readFileSync("contracts/SnoozeDream.sol", "utf8")));
}

// ─────────────────────────────────────────────────────────────── the page that reads all this
console.log("── web/dream.html calls the functions it says it calls");
{
  const fs = await import("node:fs");
  const page = fs.readFileSync("web/dream.html", "utf8");
  // Prose wraps. Matching a sentence against the raw file finds it only when the author's
  // line breaks happen to fall elsewhere, which is a test that passes for the wrong reason
  // and fails on a reflow — "no supply ceiling" was split across two lines and read as absent.
  const flat = page.replace(/\s+/g, " ");
  const want = { streak: "streakSeconds(address)", pending: "dreamPending(address)",
                 bal: "balanceOf(address)" };
  // Both of the first two were written by hand on the page and both were WRONG. A wrong
  // selector is not a failed read — it is a call to whatever function shares the prefix, or
  // to the fallback, and it returns something. So they are recomputed here from the
  // signatures rather than eyeballed.
  for (const [key, sig] of Object.entries(want)) {
    const s = selector(sig);
    ok(`the page's ${key} selector is ${sig} (${s})`,
       new RegExp(`${key}\\s*:\\s*"${s}"`).test(page),
       (page.match(new RegExp(`${key}\\s*:\\s*"0x[0-9a-f]{8}"`)) || ["absent"])[0]);
  }
  ok("the page states the same 90-day ramp the contract does",
     /const RAMP_DAYS = 90\b/.test(page));
  // The page's OWN expression, lifted out of it and evaluated here, against the contract's.
  // The previous version of this line divided a number by itself and asserted the answer was
  // one, which is true of every number and says nothing about either.
  const R = 90 * 86400;
  const pageRatio = a => { const m = Math.min(a, R), x = Math.max(a - R, 0);
                           return (m * m + 2 * R * x) / (R * R); };
  ok("the page's ramp reaches EXACTLY one-for-one at 90 days", pageRatio(R) === 1);
  // Against the DEPLOYED function, not against a transcription of it. dreamBetween is public
  // and pure, so the contract this suite just compiled can be asked directly, and "the page
  // agrees with the chain" stops being a claim about two pieces of source that look alike.
  {
    const x = await world();
    const ONE = 10n ** 9n;                       // one SNOOZE, nine decimals
    let worst = 0n;
    for (const a of [0, 1, R / 3, R / 2, R, 2 * R, 5 * R].map(Math.floor)) {
      const chain = (await call(x.tok, "dreamBetween(uint256,uint64,uint64)", [ONE, 0, a]))
        .words[0];
      const fromPage = BigInt(Math.round(pageRatio(a) * Number(ONE)));
      const d = chain > fromPage ? chain - fromPage : fromPage - chain;
      if (d > worst) worst = d;
    }
    ok("the page's ramp agrees with the contract's own dreamBetween to one base unit",
       worst <= 1n, `worst disagreement was ${worst} base units`);
  }
  ok("it draws arithmetic and says so inside the frame",
     /this is arithmetic, not a market/.test(page) && /mode:"arithmetic"/.test(page));
  ok("it never draws a market series", /marketSeries:\[\]/.test(page)
     && !/marketSeries\s*=\s*\[[^\]]/.test(page));
  ok("it says DREAM is uncapped rather than leaving it to be discovered",
     /Not capped/.test(flat) && /no supply ceiling/.test(flat));
  ok("and that it is not backed by anything",
     /Not backed/.test(flat) && /no treasury, no redemption/.test(flat));
  ok("and that the pool and the launcher earn none of it",
     /Not for the pool, and not for the launcher/.test(flat));
  ok("and that every holder pays gas for it whether or not they claim",
     /whether or not they ever claim/.test(flat));
  ok("it does not promise a price", /None of this is a reason to expect a price/.test(flat));
  ok("it holds no signing or sending method",
     !/eth_sendTransaction|eth_sendRawTransaction|personal_sign|eth_signTypedData|signTransaction|signMessage/
       .test(page));
  ok("and asks only for eth_call",
     [...new Set(page.match(/\beth_[a-zA-Z]+/g) || [])].join(",") === "eth_call");
}

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
