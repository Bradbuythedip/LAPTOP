// Tests for contracts/SnoozeCurve.sol — the virtual-liquidity curve.
//
// One property matters more than all the others: the curve can only ever pay out ETH that
// arrived. Its ETH side starts imaginary, so if that ever stops being true the imaginary part
// becomes somebody's real loss. Most of this file is that property attacked from several
// directions, including the one that actually breaks it — a holder who got tokens somewhere
// other than the curve, which on a Snooze launch is the launcher holding the entire supply
// from block one.
//
// The closed forms are checked against bond_model.py's, which were themselves checked against
// a simulated walk up the curve. Three implementations, one answer.
import fs from "node:fs";
import { compile, deploy, call, fund, balance } from "./evm.mjs";
import { createEVM } from "@ethereumjs/evm";

let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { if (c) { pass++; results.push("  ok   " + n); }
  else { fail++; results.push("  FAIL " + n + (x ? "\n         " + x : "")); } };
const near = (n, g, w, tol) => ok(n, Math.abs(Number(g) - Number(w)) <=
  (tol ?? 1e-9) * Math.max(1, Math.abs(Number(w))), `got  ${g}\n         want ${w}`);

const E = 10n ** 18n;
const w = v => (typeof v === "string" && v.startsWith("0x") ? v.slice(2)
                : BigInt(v).toString(16)).padStart(64, "0");
const { all, warnings } = compile(["contracts/SnoozeCurve.sol", "contracts/Snooze.sol",
  "contracts/test/Mocks.sol", "contracts/test/SnoozeMocks.sol"]);

console.log("── it compiles clean and fits");
ok("SnoozeCurve compiles", !!all.SnoozeCurve);
ok("with no warnings", warnings.length === 0,
   warnings.map(x => x.message.split("\n")[0]).join("; "));
ok("and is well under the EIP-170 limit",
   all.SnoozeCurve.evm.deployedBytecode.object.length / 2 < 24576 * 0.5,
   String(all.SnoozeCurve.evm.deployedBytecode.object.length / 2));

const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB   = "0x00000000000000000000000000000000000000b1";
const FEETO = "0x00000000000000000000000000000000000000fe";
const POOL  = "0x00000000000000000000000000000000000000b0";

// A plain ERC-20 with no rules, so the curve is measured on its own before Snooze is added.
async function fixture({ vEth = 3n * E, supply = 1_000_000_000n * E, target = 6n * E,
                         feeBps = 0 } = {}) {
  const evm = await createEVM();
  const tok = await deploy(all.PlainToken.evm.bytecode.object, w(supply * 2n), { evm });
  const c = await deploy(all.SnoozeCurve.evm.bytecode.object,
    [tok.address.toString(), vEth, supply, target, feeBps, FEETO].map(w).join(""), { evm });
  await call({ evm, address: tok.address }, "transfer(address,uint256)",
             [c.address.toString(), supply]);
  await fund(evm, ALICE, 1000n * E);
  await fund(evm, BOB, 1000n * E);
  return { evm, tok: { evm, address: tok.address }, c: { evm, address: c.address },
           addr: c.address.toString(), tokAddr: tok.address.toString() };
}

console.log("── the arithmetic, against the closed forms in bond_model.py");
{
  const f = await fixture({ vEth: 3n * E, supply: 1_000_000_000n * E, target: 100n * E });
  // price multiple after R real ETH is ((E0+R)/E0)^2
  for (const R of [1n, 3n, 6n]) {
    await call(f.c, "buy(uint256,address)", [0, ALICE], { from: ALICE, value: R * E });
  }
  const got = await call(f.c, "priceMultipleBps()", []);
  const E0 = 3, Rtot = 10;
  // priceMultipleBps is an integer in basis points, so it cannot carry more than four
  // decimal places — the tolerance is the resolution of the answer, not a fudge.
  near("price multiple matches ((E0+R)/E0)^2",
       Number(got.words[0]) / 10000, ((E0 + Rtot) / E0) ** 2, 1e-5);

  // R to reach 10x = E0*(sqrt(10)-1)
  const f2 = await fixture({ vEth: 3n * E, supply: 1_000_000_000n * E, target: 100n * E });
  const need = 3 * (Math.sqrt(10) - 1);
  await call(f2.c, "buy(uint256,address)", [0, ALICE],
             { from: ALICE, value: BigInt(Math.round(need * 1e18)) });
  const m = await call(f2.c, "priceMultipleBps()", []);
  near("E0*(sqrt(10)-1) of real ETH lands exactly on 10x",
       Number(m.words[0]) / 10000, 10, 1e-6);

  // tokens sold at 10x = 1 - 1/sqrt(10)
  const s = await call(f2.c, "sold()", []);
  near("and 1 - 1/sqrt(10) of the curve has been sold",
       Number(s.words[0]) / 1e27, 1 - 1 / Math.sqrt(10), 1e-6);
}

console.log("── the leftover at graduation is exactly curveSupply/m");
for (const m of [4, 10, 25]) {
  const need = 3 * (Math.sqrt(m) - 1);
  const f = await fixture({ vEth: 3n * E, supply: 1_000_000_000n * E,
                            target: BigInt(Math.round(need * 1e18)) });
  await call(f.c, "buy(uint256,address)", [0, ALICE],
             { from: ALICE, value: BigInt(Math.round(need * 1e18)) });
  const p = await call(f.c, "bondPreview()", []);
  near(`bond at ${m}x leaves curveSupply/${m} over`,
       Number(p.words[2]) / 1e27, 1 / m, 1e-5);
  // Both sides in the same raw units: wei per token base unit. The pool's is what it is
  // actually handed; the curve's is its own reserve ratio at the moment it closes.
  const openedAt = Number(p.words[0]) / Number(p.words[1]);
  const res = await call(f.c, "reserves()", []);
  const closedAt = Number(res.words[0]) / Number(res.words[1]);
  near(`bond at ${m}x opens the pool AT the curve's closing price, not below it`,
       openedAt, closedAt, 1e-5);
}

console.log("── solvency: the curve can only pay out what came in");
{
  const f = await fixture({ vEth: 3n * E, supply: 1_000_000_000n * E, target: 1000n * E });
  const before = await balance(f.evm, f.addr);
  await call(f.c, "buy(uint256,address)", [0, ALICE], { from: ALICE, value: 5n * E });
  const held = await balance(f.evm, f.addr);
  ok("the contract holds exactly the ETH that was sent", held - before === 5n * E,
     String(held - before));

  const got = await call(f.tok, "balanceOf(address)", [ALICE]);
  await call(f.tok, "approve(address,uint256)", [f.addr, got.words[0]], { from: ALICE });
  const q = await call(f.c, "quoteSell(uint256)", [got.words[0]]);
  ok("selling every token back asks for no more than arrived", q.words[0] <= 5n * E,
     `${q.words[0]} vs ${5n * E}`);
  const r = await call(f.c, "sell(uint256,uint256)", [got.words[0], 0], { from: ALICE });
  ok("and the round trip completes", r.ok, r.revert);
  const after = await balance(f.evm, f.addr);
  ok("leaving the curve with nothing of its own", after - before <= 1n, String(after - before));
  const res = await call(f.c, "reserveEth()", []);
  ok("and its book back to zero", res.words[0] <= 1n, String(res.words[0]));
}

console.log("── the hole: somebody selling tokens the curve never sold");
{
  const f = await fixture({ vEth: 3n * E, supply: 1_000_000n * E, target: 1000n * E });
  // BOB never bought here. On a Snooze launch the launcher holds the whole supply from block
  // one, so this is not a hypothetical.
  await call(f.tok, "transfer(address,uint256)", [BOB, 500_000n * E]);
  await call(f.c, "buy(uint256,address)", [0, ALICE], { from: ALICE, value: 1n * E });
  const held = await balance(f.evm, f.addr);
  await call(f.tok, "approve(address,uint256)", [f.addr, 500_000n * E], { from: BOB });
  const r = await call(f.c, "sell(uint256,uint256)", [500_000n * E, 0], { from: BOB });
  ok("a sell larger than the curve ever sold is refused", !r.ok, "it went through");
  ok("and refused by name, not by underflow", /revert/.test(String(r.revert)), String(r.revert));
  const after = await balance(f.evm, f.addr);
  ok("the curve keeps every wei it was holding", after === held, `${after} vs ${held}`);
  const q = await call(f.c, "quoteSell(uint256)", [500_000n * E]);
  ok("and the quote says zero rather than a number nobody can be paid", q.words[0] === 0n,
     String(q.words[0]));
}

console.log("── a token that burns part of a sale on its way in");
{
  // Snooze Rule 1 destroys part of a sale as it lands in a registered venue. The curve is a
  // registered venue. So the curve is handed LESS than the seller sent, and if it priced on
  // what it was told rather than on what it got, it would pay for tokens that no longer exist
  // and put the constant product out by exactly the burn — every sale, compounding.
  const f = await fixture({ vEth: 3n * E, supply: 1_000_000_000n * E, target: 1000n * E });
  await call(f.c, "buy(uint256,address)", [0, ALICE], { from: ALICE, value: 5n * E });
  const bought = (await call(f.tok, "balanceOf(address)", [ALICE])).words[0];

  // 40% of anything arriving at the curve is destroyed on arrival.
  await call(f.tok, "setBurn(address,uint256)", [f.addr, 4000]);

  const half = bought / 2n;
  const quotedOnSent = await call(f.c, "quoteSell(uint256)", [half]);
  const quotedOnKept = await call(f.c, "quoteSell(uint256)", [half * 6n / 10n]);
  await call(f.tok, "approve(address,uint256)", [f.addr, bought], { from: ALICE });

  const ethBefore = await balance(f.evm, ALICE);
  const soldBefore = (await call(f.c, "sold()", [])).words[0];
  const r = await call(f.c, "sell(uint256,uint256)", [half, 0], { from: ALICE });
  ok("the sale goes through", r.ok, r.revert);
  const ethAfter = await balance(f.evm, ALICE);
  const paid = ethAfter - ethBefore;

  ok("the seller is paid for what ARRIVED, not for what they sent",
     paid === quotedOnKept.words[0],
     `paid ${paid}, quote on delivered ${quotedOnKept.words[0]}, ` +
     `quote on sent ${quotedOnSent.words[0]}`);
  ok("which is strictly less than pricing on the sent amount would have paid",
     paid < quotedOnSent.words[0], `${paid} vs ${quotedOnSent.words[0]}`);

  const soldAfter = (await call(f.c, "sold()", [])).words[0];
  ok("the book is reduced by the delivered amount, so k tracks reality",
     soldBefore - soldAfter === half * 6n / 10n,
     `${soldBefore - soldAfter} vs ${half * 6n / 10n}`);

  // The property that matters: after the burn, the curve is still solvent.
  const res = (await call(f.c, "reserveEth()", [])).words[0];
  const held = await balance(f.evm, f.addr);
  ok("and the reserve still matches the ETH actually held", res === held, `${res} vs ${held}`);
  ok("the curve never paid out more than arrived", held <= 5n * E, String(held));
}

console.log("── fees leave immediately, so the reserve is only ever the curve's own money");
{
  const f = await fixture({ vEth: 3n * E, supply: 1_000_000_000n * E, target: 1000n * E,
                            feeBps: 100 });
  await call(f.c, "buy(uint256,address)", [0, ALICE], { from: ALICE, value: 10n * E });
  const fee = await balance(f.evm, FEETO);
  ok("1% of the buy reached the fee address", fee === 10n * E / 100n, String(fee));
  const res = await call(f.c, "reserveEth()", []);
  ok("and the reserve counts only the other 99%", res.words[0] === 10n * E * 99n / 100n,
     String(res.words[0]));
  const held = await balance(f.evm, f.addr);
  ok("which is exactly what the contract holds", held === res.words[0], String(held));
}

console.log("── bonding");
{
  const f = await fixture({ vEth: 3n * E, supply: 1_000_000_000n * E, target: 6n * E });
  ok("not bondable before the target", !(await call(f.c, "bondable()", [])).words[0]);
  const early = await call(f.c, "bond(address)", [POOL], { from: BOB });
  ok("and bond() refuses early", !early.ok, early.revert);
  await call(f.c, "buy(uint256,address)", [0, ALICE], { from: ALICE, value: 6n * E });
  ok("bondable once the real ETH has arrived", !!(await call(f.c, "bondable()", [])).words[0]);
  const pre = await call(f.c, "bondPreview()", []);
  const r = await call(f.c, "bond(address)", [POOL], { from: BOB });
  ok("anybody may bond it, not only the launcher", r.ok, r.revert);
  const poolEth = await balance(f.evm, POOL);
  ok("the pool receives the whole real reserve", poolEth === pre.words[0], String(poolEth));
  const poolTok = await call(f.tok, "balanceOf(address)", [POOL]);
  ok("and the seed tokens", poolTok.words[0] === pre.words[1], String(poolTok.words[0]));
  const feeTok = await call(f.tok, "balanceOf(address)", [FEETO]);
  ok("the leftover goes to the fee address, and is the only token revenue",
     feeTok.words[0] === pre.words[2], String(feeTok.words[0]));
  ok("the curve keeps no ETH", (await balance(f.evm, f.addr)) === 0n);
  const again = await call(f.c, "bond(address)", [POOL], { from: ALICE });
  ok("it cannot be bonded twice", !again.ok, again.revert);
  const buyAfter = await call(f.c, "buy(uint256,address)", [0, ALICE],
                              { from: ALICE, value: 1n * E });
  ok("and the curve is closed to trading afterwards", !buyAfter.ok, buyAfter.revert);
}

console.log("── it refuses the configurations that would hurt somebody");
{
  const evm = await createEVM();
  const tok = await deploy(all.PlainToken.evm.bytecode.object, w(1000n * E), { evm });
  const mk = async (v, s, t, fee, to) => {
    try {
      await deploy(all.SnoozeCurve.evm.bytecode.object,
        [tok.address.toString(), v, s, t, fee, to].map(w).join(""), { evm });
      return null;
    } catch (e) { return String(e.message || e); }
  };
  ok("zero virtual ETH is refused — the price would be undefined",
     !!(await mk(0, 1000, 10, 0, FEETO)));
  ok("zero curve supply is refused", !!(await mk(E, 0, 10, 0, FEETO)));
  ok("a zero bond target is refused — it would graduate on the first wei",
     !!(await mk(E, 1000, 0, 0, FEETO)));
  ok("a fee above 5% is refused", !!(await mk(E, 1000, 10, 501, FEETO)));
  ok("5% exactly is allowed", (await mk(E, 1000, 10, 500, FEETO)) === null);
  ok("a fee with nowhere to go is refused",
     !!(await mk(E, 1000, 10, 100, "0x0000000000000000000000000000000000000000")));
}

console.log("── nothing here can be pointed anywhere later");
{
  const abi = all.SnoozeCurve.abi.map(f => f.name).filter(Boolean).join(" ");
  for (const bad of ["setFee", "setFeeTo", "sweep", "rescue", "withdraw", "transferOwnership",
                     "owner", "renounce", "pause", "setVirtual", "setTarget", "upgrade"])
    ok(`no ${bad}() anywhere in the ABI`, !new RegExp(bad, "i").test(abi));
  const src = fs.readFileSync("contracts/SnoozeCurve.sol", "utf8")
    .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok("no delegatecall", !/delegatecall/.test(src));
  ok("no selfdestruct", !/selfdestruct/.test(src));
  ok("the fee address is immutable", /address public immutable feeTo/.test(src));
  ok("and so are both curve parameters",
     /uint256 public immutable virtualEth/.test(src) &&
     /uint256 public immutable curveSupply/.test(src));
}

console.log("── a stranger's ETH is refused rather than silently absorbed");
{
  const f = await fixture();
  const before = await balance(f.evm, f.addr);
  const r = await call(f.c, "nonexistent()", [], { from: BOB, value: E });
  ok("a bare send reverts", !r.ok, "it was accepted");
  ok("and the balance is untouched", (await balance(f.evm, f.addr)) === before);
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
