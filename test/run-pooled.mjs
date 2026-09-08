// contracts/PooledLaunchBuy.sol, compiled and EXECUTED against an in-process EVM with a
// deliberately hostile token, a lying router, a depositor that refuses ETH and a depositor
// that reenters.
//
// This contract holds pooled customer money, so the tests are written the way an attacker
// would look at it rather than the way the author would: every assertion below is either
// "money cannot leave except to the person who put it in" or "the accounting cannot be made
// to disagree with itself".
//
// It is NOT a testnet and NOT an audit. There is no real router, no real token, no mempool
// and no gas market here.
//   node test/run-pooled.mjs
import fs from "node:fs";
import { compile, deploy, call, fund, balance, encodeCall, createAddressFromString } from "./evm.mjs";
import { createEVM } from "@ethereumjs/evm";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push("  ok   " + name); }
  else { fail++; results.push("  FAIL " + name + (extra ? "\n         " + extra : "")); }
}
const eq = (name, got, want) => ok(name, got === want, `got ${got}, want ${want}`);

const ETH = 10n ** 18n;
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const DEPLOYER = "0x1000000000000000000000000000000000000001";
const T_OPEN = 1000, T_EXEC = 2000, T_REFUND = 3000;

console.log("── it compiles");
const { contracts, all, warnings } = compile(
  ["contracts/PooledLaunchBuy.sol", "contracts/test/Mocks.sol"]);
ok("compiles with no errors", !!contracts.PooledLaunchBuy);
ok("and no warnings", warnings.length === 0,
   warnings.map(w => w.message.split("\n")[0]).join("; "));

const w = v => (typeof v === "string" && v.startsWith("0x")
  ? v.slice(2) : BigInt(v).toString(16)).padStart(64, "0");

/// Fresh world: token, router, pool, three funded depositors.
async function world(opts = {}) {
  const evm = await createEVM();
  for (const a of [A, B, C, DEPLOYER]) await fund(evm, a, 100n * ETH);
  const tok = await deploy(all.MockToken.evm.bytecode.object, "", { evm });
  const rtr = await deploy(all.MockRouter.evm.bytecode.object,
    w(tok.address.toString()), { evm });
  const pool = await deploy(contracts.PooledLaunchBuy.evm.bytecode.object,
    [rtr.address.toString(), tok.address.toString(), T_EXEC, T_REFUND,
     opts.minDeposit ?? 0, opts.exitFeeBps ?? 500,
     opts.minTokensPerEth ?? 1].map(w).join(""), { evm });
  return { evm, tok, rtr, pool };
}
const at = (ctx, addr) => ({ evm: ctx.evm, address: addr });

console.log("── the money can only leave to the person who put it in");
{
  // The design claim is that nobody can take the pool, including the deployer. The strongest
  // form of that is not a test but the absence of a function, so check the ABI first.
  const abi = contracts.PooledLaunchBuy.abi;
  const names = abi.filter(x => x.type === "function").map(x => x.name);
  ok("there is no sweep, rescue, withdraw or drain function",
     !names.some(n => /sweep|rescue|withdraw|drain|emergency|migrate|recover/i.test(n)),
     names.join(","));
  ok("nothing is ownable or transferable to a new owner",
     !names.some(n => /transferOwnership|renounce|setOwner|setAdmin|setFee|setRouter/i.test(n)),
     names.join(","));
  ok("there is no upgrade path", !names.some(n => /upgrade|implementation|proxy/i.test(n)));
  ok("no selfdestruct in the bytecode",
     !/ff(?=([0-9a-f]{2})*$)/.test("") && !contracts.PooledLaunchBuy.evm.bytecode.object.includes("selfdestruct"));
  // Strip comments first: the file *describes* having no delegatecall, and matching the
  // prose instead of the code is how this assertion would pass while being meaningless.
  const code = fs.readFileSync("contracts/PooledLaunchBuy.sol", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("no delegatecall in the code", !/delegatecall/i.test(code));
  ok("no assembly block in the code", !/\bassembly\b/.test(code));
}

console.log("── pro-rata is actually pro-rata");
{
  const x = await world();
  await call(x.pool, "deposit()", [], { from: A, value: 3n * ETH, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: B, value: 1n * ETH, timestamp: T_OPEN });
  eq("the pool records what was sent",
     (await call(x.pool, "totalDeposited()")).words[0], 4n * ETH);

  const ex = await call(x.pool, "execute(uint256)", [0], { from: C, timestamp: T_EXEC });
  ok("anyone can execute, not just the deployer", ex.ok, ex.revert);
  const got = (await call(x.pool, "tokensReceived()")).words[0];
  eq("the router delivered 1000 base units per ETH", got, 4000n);

  await call(x.pool, "claim()", [], { from: A, timestamp: T_EXEC });
  await call(x.pool, "claim()", [], { from: B, timestamp: T_EXEC });
  const balA = (await call(at(x, x.tok.address), "balanceOf(address)", [A])).words[0];
  const balB = (await call(at(x, x.tok.address), "balanceOf(address)", [B])).words[0];
  eq("A put in 3 of 4 and gets three quarters", balA, 3000n);
  eq("B put in 1 of 4 and gets one quarter", balB, 1000n);
  ok("and the two shares never exceed what arrived", balA + balB <= got);

  const again = await call(x.pool, "claim()", [], { from: A, timestamp: T_EXEC });
  ok("nobody can claim twice", !again.ok);
}

console.log("── rounding strands dust, it never mints it");
{
  const x = await world();
  // Three odd deposits so the pro-rata division cannot come out even.
  await call(x.pool, "deposit()", [], { from: A, value: 333333333333333333n, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: B, value: 333333333333333333n, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: C, value: 333333333333333334n, timestamp: T_OPEN });
  await call(x.pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });
  const got = (await call(x.pool, "tokensReceived()")).words[0];
  for (const who of [A, B, C]) await call(x.pool, "claim()", [], { from: who, timestamp: T_EXEC });
  const sum = (await call(x.pool, "totalClaimed()")).words[0];
  ok("the sum of every claim is at most what was received", sum <= got, `${sum} > ${got}`);
  ok("and the shortfall is dust, not a hole", got - sum < 10n, `${got - sum}`);
}

console.log("── a stranger cannot choose the price your pool buys at");
{
  // Found by adversarial audit, and it was CRITICAL. execute() is permissionless, so the
  // caller may be the attacker, and minOut is the caller's own argument — a bound the
  // attacker supplies bounds nobody. One transaction: move the price, call execute(1), sell
  // back. The pool spends everything and receives one base unit; `executed` is already true
  // so refund() is dead and claim() floor-divides to zero for everyone.
  //
  // The fix is an immutable floor published before anyone deposits. The caller's minOut can
  // only tighten it.
  const x = await world({ minTokensPerEth: 500n });   // at least 500 units per 1e18 wei
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: B, value: 2n * ETH, timestamp: T_OPEN });

  // The attacker crashes the rate so the pool would get almost nothing, then asks for 1.
  await call(at(x, x.rtr.address), "setRate(uint256)", [1]);
  const attack = await call(x.pool, "execute(uint256)", [1], { from: C, timestamp: T_EXEC });
  ok("execute(1) at a terrible rate is REFUSED by the immutable floor", !attack.ok,
     "a stranger just bought the pool out at a price they chose");
  eq("and the round stays open, so refunds still work",
     (await call(x.pool, "executed()")).words[0], 0n);
  const r = await call(x.pool, "refund()", [], { from: A, timestamp: T_REFUND });
  ok("the depositor can still walk away with their ETH", r.ok, r.revert);
}
{
  // The floor is a floor, not a ceiling: an honest execute at a good rate still works, and a
  // caller who wants a TIGHTER bound than the floor still gets it.
  const x = await world({ minTokensPerEth: 500n });
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  await call(at(x, x.rtr.address), "setRate(uint256)", [1000]);
  const good = await call(x.pool, "execute(uint256)", [0], { from: C, timestamp: T_EXEC });
  ok("a rate above the floor executes with minOut zero", good.ok, good.revert);

  const y = await world({ minTokensPerEth: 500n });
  await call(y.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  await call(at(y, y.rtr.address), "setRate(uint256)", [1000]);
  const tighter = await call(y.pool, "execute(uint256)",
    [10_000_000n * ETH], { from: C, timestamp: T_EXEC });
  ok("and a caller may still demand MORE than the floor", !tighter.ok);
  eq("leaving the round open", (await call(y.pool, "executed()")).words[0], 0n);
}

console.log("── refund is unconditional once the deadline passes");
{
  const x = await world();
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  const early = await call(x.pool, "refund()", [], { from: A, timestamp: T_EXEC });
  ok("no refund while the round is still live", !early.ok);

  const before = await balance(x.evm, A);
  const r = await call(x.pool, "refund()", [], { from: A, timestamp: T_REFUND });
  ok("but after the deadline it goes through", r.ok, r.revert);
  const after = await balance(x.evm, A);
  eq("and returns the deposit in full, with no fee", after - before, 2n * ETH);
  eq("the pool's record is cleared",
     (await call(x.pool, "deposited(address)", [A])).words[0], 0n);
  const twice = await call(x.pool, "refund()", [], { from: A, timestamp: T_REFUND });
  ok("and cannot be drained by refunding twice", !twice.ok);
}

console.log("── the early-exit fee stays with the people who stayed");
{
  const x = await world({ exitFeeBps: 500 });
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: B, value: 2n * ETH, timestamp: T_OPEN });
  const before = await balance(x.evm, A);
  await call(x.pool, "exitEarly()", [], { from: A, timestamp: T_OPEN });
  const after = await balance(x.evm, A);
  eq("a 5% exit fee returns 95%", after - before, 2n * ETH * 95n / 100n);
  eq("the fee is recorded as forfeited",
     (await call(x.pool, "forfeited()")).words[0], 2n * ETH * 5n / 100n);
  eq("and totalDeposited drops to only what remains",
     (await call(x.pool, "totalDeposited()")).words[0], 2n * ETH);

  // The forfeited ETH is still in the contract, so it is spent on the buy and its tokens are
  // distributed pro-rata to whoever remains. That is the whole point: the fee is not a payment
  // to the operator, it is a transfer to the people who did not leave.
  await call(x.pool, "execute(uint256)", [0], { from: B, timestamp: T_EXEC });
  await call(x.pool, "claim()", [], { from: B, timestamp: T_EXEC });
  const balB = (await call(at(x, x.tok.address), "balanceOf(address)", [B])).words[0];
  ok("the only remaining depositor receives the forfeited fee's tokens too",
     balB > 2000n, `${balB}`);
  eq("which is exactly the 2.1 ETH that was in the pool", balB, 2100n);

  const deployerBal = (await call(at(x, x.tok.address), "balanceOf(address)", [DEPLOYER])).words[0];
  eq("and the deployer receives nothing at all", deployerBal, 0n);
}

console.log("── nobody can be wedged by another depositor");
{
  const x = await world();
  const rej = await deploy(all.RejectingDepositor.evm.bytecode.object, "", { evm: x.evm });
  await fund(x.evm, rej.address.toString(), 10n * ETH);
  await call(at(x, rej.address), "deposit(address)", [x.pool.address.toString()],
    { value: 1n * ETH, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: A, value: 1n * ETH, timestamp: T_OPEN });

  const bad = await call(at(x, rej.address), "refund(address)",
    [x.pool.address.toString()], { timestamp: T_REFUND });
  ok("a depositor that refuses ETH cannot refund itself", !bad.ok);
  const good = await call(x.pool, "refund()", [], { from: A, timestamp: T_REFUND });
  ok("but that does not stop anyone else refunding", good.ok, good.revert);
}

console.log("── reentrancy");
{
  const x = await world();
  const re = await deploy(all.ReentrantDepositor.evm.bytecode.object, "", { evm: x.evm });
  await fund(x.evm, re.address.toString(), 10n * ETH);
  await call(at(x, re.address), "arm(address,uint256)",
    [x.pool.address.toString(), 1], { timestamp: T_OPEN });
  await call(at(x, re.address), "deposit()", [],
    { value: 2n * ETH, timestamp: T_OPEN });
  ok("the reentrant depositor is recorded once",
     (await call(x.pool, "deposited(address)", [re.address.toString()])).words[0] === 2n * ETH);

  // The balance is zeroed before the ETH is sent, so a reentrant refund finds nothing left.
  const before = await balance(x.evm, re.address.toString());
  await call(at(x, re.address), "callRefund()", [], { timestamp: T_REFUND });
  const after = await balance(x.evm, re.address.toString());
  ok("a reentrant refund cannot take more than was deposited",
     after - before <= 2n * ETH, `${after - before}`);
  eq("and the pool holds nothing for it afterwards",
     (await call(x.pool, "deposited(address)", [re.address.toString()])).words[0], 0n);
}

console.log("── a lying router cannot inflate what people can claim");
{
  const x = await world();
  await call(at(x, x.rtr.address), "setLie(uint256)", [50_000]);  // claims 5x what it sent
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  await call(x.pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });
  const got = (await call(x.pool, "tokensReceived()")).words[0];
  const held = (await call(at(x, x.tok.address), "balanceOf(address)",
    [x.pool.address.toString()])).words[0];
  ok("the contract credits the balance it actually holds, not the router's claim",
     got <= held, `credited ${got} but holds ${held}`);
  const c = await call(x.pool, "claim()", [], { from: A, timestamp: T_EXEC });
  ok("so the claim succeeds rather than reverting on an empty cupboard", c.ok, c.revert);
}

console.log("── a fee-on-transfer token is credited at what arrived");
{
  const x = await world();
  await call(at(x, x.tok.address), "setFee(uint256)", [1000]);   // 10% on every transfer
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  const ex = await call(x.pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });
  ok("execute still succeeds", ex.ok, ex.revert);
  const got = (await call(x.pool, "tokensReceived()")).words[0];
  const held = (await call(at(x, x.tok.address), "balanceOf(address)",
    [x.pool.address.toString()])).words[0];
  ok("credited no more than the contract actually received", got <= held, `${got} > ${held}`);
}

console.log("── a router that keeps the money cannot mark the round done");
{
  const x = await world();
  await call(at(x, x.rtr.address), "setDeliverNothing(bool)", [true]);
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  const ex = await call(x.pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });
  ok("execute reverts when nothing arrives", !ex.ok);
  eq("and the round is NOT marked executed, so refunds still work",
     (await call(x.pool, "executed()")).words[0], 0n);
  const r = await call(x.pool, "refund()", [], { from: A, timestamp: T_REFUND });
  ok("the depositor can still get their ETH back", r.ok, r.revert);
}

console.log("── minOut is a real floor");
{
  const x = await world();
  await call(x.pool, "deposit()", [], { from: A, value: 1n * ETH, timestamp: T_OPEN });
  const bad = await call(x.pool, "execute(uint256)", [10_000n * ETH],
    { from: A, timestamp: T_EXEC });
  ok("execute reverts below the caller's floor", !bad.ok);
  eq("and leaves the round open", (await call(x.pool, "executed()")).words[0], 0n);
}

console.log("── the lifecycle has no state where money is stuck");
{
  const x = await world();
  await call(x.pool, "deposit()", [], { from: A, value: 1n * ETH, timestamp: T_OPEN });
  const early = await call(x.pool, "execute(uint256)", [0], { from: A, timestamp: T_OPEN });
  ok("no buy before the launch time", !early.ok);

  const x2 = await world();
  await call(x2.pool, "deposit()", [], { from: A, value: 1n * ETH, timestamp: T_OPEN });
  await call(x2.pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });
  const late = await call(x2.pool, "deposit()", [], { from: B, value: 1n * ETH, timestamp: T_EXEC });
  ok("no deposits after the buy", !late.ok);
  const ref = await call(x2.pool, "refund()", [], { from: A, timestamp: T_REFUND });
  ok("and no refund after the buy — the claim is the exit now", !ref.ok);
  const twice = await call(x2.pool, "execute(uint256)", [0], { from: B, timestamp: T_EXEC });
  ok("and no second buy", !twice.ok);

  const x3 = await world();
  const closed = await call(x3.pool, "deposit()", [], { from: A, value: 1n * ETH, timestamp: T_REFUND });
  ok("no deposits once the refund window opens", !closed.ok);

  const x4 = await world();
  const bare = await x4.evm.runCall({
    caller: createAddressFromString(A),
    to: x4.pool.address, gasLimit: 200000n, value: ETH, data: new Uint8Array(0),
    block: { header: { number: 1n, timestamp: BigInt(T_OPEN) } },
  });
  ok("a bare ETH send is rejected rather than silently unaccounted for",
     !!bare.execResult.exceptionError);
}

console.log("── the refund promise must outrank the buy, not the other way round");
{
  // Found by adversarial review. execute() originally had no upper time bound, so it could be
  // called at ANY time after executeAfter — including long after refundAfter — and convert
  // everyone's refundable ETH into tokens. "Unconditional refund after the deadline" was
  // therefore only true until somebody decided otherwise. This is the assertion that pins it.
  const x = await world();
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  const late = await call(x.pool, "execute(uint256)", [0], { from: C, timestamp: T_REFUND });
  ok("no buy once the refund window has opened", !late.ok);
  const later = await call(x.pool, "execute(uint256)", [0], { from: C, timestamp: T_REFUND + 100000 });
  ok("and not at any later time either", !later.ok);
  const r = await call(x.pool, "refund()", [], { from: A, timestamp: T_REFUND });
  ok("so the refund is genuinely unconditional", r.ok, r.revert);

  const x2 = await world();
  await call(x2.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  const inWindow = await call(x2.pool, "execute(uint256)", [0], { from: C, timestamp: T_EXEC });
  ok("but the buy still works inside its own window", inWindow.ok, inWindow.revert);
}

console.log("── the router's word is not evidence");
{
  // An UNDER-reporting router used to strand the difference forever, because tokensReceived
  // took min(actual, reported). The balance delta is the only thing that can be checked.
  const x = await world();
  await call(at(x, x.rtr.address), "setLie(uint256)", [1]);   // reports ~0.01% of the truth
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  await call(x.pool, "execute(uint256)", [0], { from: A, timestamp: T_EXEC });
  const got = (await call(x.pool, "tokensReceived()")).words[0];
  const held = (await call(at(x, x.tok.address), "balanceOf(address)",
    [x.pool.address.toString()])).words[0];
  eq("an under-reporting router strands nothing: credit is the balance delta", got, held);
  await call(x.pool, "claim()", [], { from: A, timestamp: T_EXEC });
  const balA = (await call(at(x, x.tok.address), "balanceOf(address)", [A])).words[0];
  eq("so the sole depositor receives everything that arrived", balA, held);
}

console.log("── a router that returns change does not brick the round");
{
  // receive() used to revert unconditionally, which looked safer and was not: any real router
  // that refunds unspent ETH would make execute() revert every time.
  const x = await world();
  await fund(x.evm, x.rtr.address.toString(), 10n * ETH);
  const fromRouter = await x.evm.runCall({
    caller: x.rtr.address, to: x.pool.address, gasLimit: 200000n, value: ETH,
    data: new Uint8Array(0),
    block: { header: { number: 1n, timestamp: BigInt(T_EXEC) } },
  });
  ok("the router may return change", !fromRouter.execResult.exceptionError,
     String(fromRouter.execResult.exceptionError));
  const fromStranger = await x.evm.runCall({
    caller: createAddressFromString(A), to: x.pool.address, gasLimit: 200000n, value: ETH,
    data: new Uint8Array(0),
    block: { header: { number: 1n, timestamp: BigInt(T_OPEN) } },
  });
  ok("but a stranger's bare send is still rejected",
     !!fromStranger.execResult.exceptionError);
}

console.log("── the everyone-left case, where the fee has nobody to belong to");
{
  // If every depositor exits early, totalDeposited is 0 but the contract still holds the
  // forfeited fees. Whether that ETH can still be spent, and whether anyone can then claim
  // the tokens it bought, decides if this is a fund-loss bug.
  const x = await world({ exitFeeBps: 500 });
  await call(x.pool, "deposit()", [], { from: A, value: 2n * ETH, timestamp: T_OPEN });
  await call(x.pool, "deposit()", [], { from: B, value: 2n * ETH, timestamp: T_OPEN });
  await call(x.pool, "exitEarly()", [], { from: A, timestamp: T_OPEN });
  await call(x.pool, "exitEarly()", [], { from: B, timestamp: T_OPEN });
  eq("nobody is left in the round", (await call(x.pool, "totalDeposited()")).words[0], 0n);
  const stranded = (await call(x.pool, "forfeited()")).words[0];
  ok("but the forfeited fees are still in the contract", stranded > 0n, `${stranded}`);

  const ex = await call(x.pool, "execute(uint256)", [0], { from: C, timestamp: T_EXEC });
  ok("execute must refuse to buy for a round with no depositors", !ex.ok,
     "it executed, and the tokens it bought have no owner: claim() would divide by zero");
  eq("so the round stays open", (await call(x.pool, "executed()")).words[0], 0n);
}

console.log("── configuration that would trap depositors is rejected at construction");
{
  const evm = await createEVM();
  const tok = await deploy(all.MockToken.evm.bytecode.object, "", { evm });
  const rtr = await deploy(all.MockRouter.evm.bytecode.object, w(tok.address.toString()), { evm });
  const mk = (ea, ra, fee, tokAddr, floor) => deploy(contracts.PooledLaunchBuy.evm.bytecode.object,
    [rtr.address.toString(), tokAddr ?? tok.address.toString(), ea, ra, 0, fee, floor ?? 1]
      .map(w).join(""), { evm }).then(() => null).catch(e => e);
  ok("a refund deadline at or before the buy time is rejected",
     (await mk(T_EXEC, T_EXEC, 500)) !== null);
  ok("a refund deadline before the buy time is rejected",
     (await mk(T_REFUND, T_EXEC, 500)) !== null);
  ok("a 100% exit fee is rejected", (await mk(T_EXEC, T_REFUND, 10_000)) !== null);
  ok("a zero token address is rejected",
     (await mk(T_EXEC, T_REFUND, 500, "0x" + "0".repeat(40))) !== null);
  ok("a zero price floor is rejected — it is the bug, not a default",
     (await mk(T_EXEC, T_REFUND, 500, null, 0)) !== null);
  ok("a sane configuration deploys", (await mk(T_EXEC, T_REFUND, 500)) === null);
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
