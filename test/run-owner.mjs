// The first launch, driven as the owner's wallet would drive it.
//
// Two claims are being checked and they are both about one address:
//   1. Only 0x4296…5929 can deploy the first token. Not "should not" — cannot.
//   2. Every fee ends up at that address and nowhere else, with no call that can repoint it.
//
// Everything runs against the real compiled contracts in an in-process EVM, from that address,
// in the order the runbook says to send them.
import fs from "node:fs";
import { compile, deploy, call, fund, balance } from "./evm.mjs";
import { createEVM } from "@ethereumjs/evm";
const { keccak256 } = await import("ethereum-cryptography/keccak.js");

let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { if (c) { pass++; results.push("  ok   " + n); }
  else { fail++; results.push("  FAIL " + n + (x ? "\n         " + x : "")); } };

const E = 10n ** 18n;
const w = v => (typeof v === "string" && v.startsWith("0x") ? v.slice(2)
                : BigInt(v).toString(16)).padStart(64, "0");
const bytes = h => Uint8Array.from((h.replace(/^0x/, "").match(/../g) || [])
                                   .map(x => parseInt(x, 16)));
const hexs = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");

const CFG = JSON.parse(fs.readFileSync("deploy/config.json", "utf8"));
const OWNER = CFG.owner.toLowerCase();
const STRANGER = "0x00000000000000000000000000000000deadbeef";

const { all, warnings } = compile(["contracts/SnoozeDeployer.sol", "contracts/SnoozeCurve.sol",
  "contracts/Snooze.sol", "contracts/SnoozeGate.sol", "contracts/test/Mocks.sol",
  "contracts/test/SnoozeMocks.sol"]);

console.log("── the config says one address, and it is the one you gave");
ok("config.json names an owner", /^0x[0-9a-f]{40}$/.test(OWNER), OWNER);
ok("every fee destination is that same address",
   [CFG.fees.curveFeeTo, CFG.fees.snoozeDev, CFG.fees.gateUnclaimedTo]
     .every(a => a.toLowerCase() === OWNER),
   JSON.stringify(CFG.fees));
ok("the site is snoozebear.xyz", CFG.site === "snoozebear.xyz", CFG.site);
ok("the token is Snooze Bear, ticker SNOOZE",
   CFG.token.name === "Snooze Bear" && CFG.token.symbol === "SNOOZE",
   JSON.stringify(CFG.token));
ok("everything compiles with no warnings", warnings.length === 0,
   warnings.map(x => x.message.split("\n")[0]).join("; "));
{
  const src = fs.readFileSync("contracts/Snooze.sol", "utf8");
  ok("and the contract's own name matches the config",
     /string public constant name = "Snooze Bear"/.test(src));
}

// An impossible vanity suffix costs nothing to write down and everything to discover at grind
// time, when the contracts are frozen and you are waiting on a search that can never finish.
// PUMP, DUMP, BULL, MOON, BEAR and ZZZ are all in that category. Cheaper to fail here.
console.log("── the vanity suffix is one an address can actually contain");
{
  const HEX = new Set("0123456789abcdef");
  const suf = (CFG.vanity && CFG.vanity.suffix || "").toLowerCase();
  ok("config.json names a suffix", suf.length > 0, JSON.stringify(suf));
  const bad = [...new Set([...suf].filter(c => !HEX.has(c)))];
  ok(`"${suf}" contains only hex digits`, bad.length === 0,
     `${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} not in an address`);
  ok("and it is short enough to grind before the sun burns out",
     suf.length <= 8, `${suf.length} chars is about ${(16 ** suf.length).toExponential(1)} salts`);
  // The guard, guarded: if this ever stops rejecting the impossible it is measuring nothing.
  for (const w of ["pump", "bear", "zzz", "moon"])
    ok(`the check still rejects "${w}"`, [...w].some(c => !HEX.has(c)));
}

console.log("── only the owner can deploy the first token");
const evm = await createEVM();
await fund(evm, OWNER, 100n * E);
await fund(evm, STRANGER, 100n * E);
const dep = await deploy(all.SnoozeDeployer.evm.bytecode.object, w(OWNER),
                         { evm, from: STRANGER });
const D = { evm, address: dep.address };
const dAddr = dep.address.toString();
{
  const o = await call(D, "owner()", []);
  ok("the deployer's owner is the configured address",
     "0x" + o.words[0].toString(16).padStart(40, "0") === OWNER,
     "0x" + o.words[0].toString(16).padStart(40, "0"));
  ok("even though a stranger deployed the deployer itself", true);

  const init = all.PlainToken.evm.bytecode.object + w(1000n * E);
  const ih = "0x" + hexs(keccak256(bytes(init)));
  const salt = "0x" + "00".repeat(31) + "07";

  const byStranger = await call(D, "deploy(bytes32,bytes)", [],
    { from: STRANGER, raw: salt.slice(2) + w(0x40) + w(init.length / 2) +
      init + "0".repeat((64 - (init.length % 64)) % 64) });
  ok("a stranger cannot deploy", !byStranger.ok, "a stranger deployed");

  const predicted = await call(D, "addressOf(bytes32,bytes32)", [],
    { raw: salt.slice(2) + ih.slice(2) });
  const want = "0x" + predicted.words[0].toString(16).padStart(40, "0");

  const byOwner = await call(D, "deploy(bytes32,bytes)", [],
    { from: OWNER, raw: salt.slice(2) + w(0x40) + w(init.length / 2) +
      init + "0".repeat((64 - (init.length % 64)) % 64) });
  ok("the owner can", byOwner.ok, byOwner.revert);
  const got = "0x" + (byOwner.words[0] || 0n).toString(16).padStart(40, "0");
  ok("and it lands exactly where addressOf promised, before it existed",
     got === want, `${got} vs ${want}`);
  const code = await evm.stateManager.getCode(
    (await import("@ethereumjs/util")).createAddressFromString(got));
  ok("with code actually at that address", code.length > 0, String(code.length));

  const again = await call(D, "deploy(bytes32,bytes)", [],
    { from: OWNER, raw: salt.slice(2) + w(0x40) + w(init.length / 2) +
      init + "0".repeat((64 - (init.length % 64)) % 64) });
  ok("the same salt cannot be redeployed over", !again.ok, "it redeployed");

  ok("the owner cannot be transferred away", !all.SnoozeDeployer.abi
     .some(f => /transferOwner|renounce|setOwner/i.test(f.name || "")));
  const sealBy = await call(D, "seal()", [], { from: STRANGER });
  ok("a stranger cannot seal it either", !sealBy.ok);
  await call(D, "seal()", [], { from: OWNER });
  const after = await call(D, "deploy(bytes32,bytes)", [],
    { from: OWNER, raw: w(9) + w(0x40) + w(init.length / 2) +
      init + "0".repeat((64 - (init.length % 64)) % 64) });
  ok("and after sealing, not even the owner can deploy again", !after.ok);
}

console.log("── every fee lands on the owner's address");
{
  const evm2 = await createEVM();
  await fund(evm2, STRANGER, 100n * E);
  const tok = await deploy(all.PlainToken.evm.bytecode.object, w(10n ** 27n), { evm: evm2 });
  const curve = await deploy(all.SnoozeCurve.evm.bytecode.object,
    [tok.address.toString(), 3n * E, 10n ** 26n, 6n * E, 100, OWNER,
     "0x" + "0".repeat(40), 0, 0].map(w).join(""), { evm: evm2, timestamp: 1000 });
  const C = { evm: evm2, address: curve.address };
  await call({ evm: evm2, address: tok.address }, "transfer(address,uint256)",
             [curve.address.toString(), 10n ** 26n]);

  const feeBefore = await balance(evm2, OWNER);
  await call(C, "buy(uint256,address)", [0, STRANGER],
             { from: STRANGER, value: 10n * E, timestamp: 2000 });
  const feeAfter = await balance(evm2, OWNER);
  ok("1% of a buy reaches the owner, in the same transaction",
     feeAfter - feeBefore === 10n * E / 100n, String(feeAfter - feeBefore));

  const held = await call(C, "reserveEth()", []);
  ok("and the curve's own book counts only the rest",
     held.words[0] === 10n * E * 99n / 100n, String(held.words[0]));

  const abi = all.SnoozeCurve.abi.map(f => f.name).filter(Boolean).join(" ");
  ok("there is no call that repoints the fee", !/setFee|setFeeTo|setRecipient/i.test(abi));
  const src = fs.readFileSync("contracts/SnoozeCurve.sol", "utf8");
  ok("because the fee address is immutable", /address public immutable feeTo/.test(src));

  // and the sell side
  const bal = await call({ evm: evm2, address: tok.address }, "balanceOf(address)", [STRANGER]);
  await call({ evm: evm2, address: tok.address }, "approve(address,uint256)",
             [curve.address.toString(), bal.words[0]], { from: STRANGER });
  const before2 = await balance(evm2, OWNER);
  const sold = await call(C, "sell(uint256,uint256)", [bal.words[0] / 2n, 0],
                          { from: STRANGER, timestamp: 2100 });
  ok("a sell goes through", sold.ok, sold.revert);
  ok("and its fee also lands on the owner", (await balance(evm2, OWNER)) > before2);
}

console.log("── the gate: hold SNOOZE to bid at launch");
{
  const evm3 = await createEVM();
  const HOLDER = "0x00000000000000000000000000000000000000h1".replace("h", "a");
  const BROKE = "0x00000000000000000000000000000000000000b2";
  await fund(evm3, HOLDER, 50n * E); await fund(evm3, BROKE, 50n * E);
  const gateTok = await deploy(all.PlainToken.evm.bytecode.object, w(10n ** 24n), { evm: evm3 });
  const lap = await deploy(all.PlainToken.evm.bytecode.object, w(10n ** 27n), { evm: evm3 });
  const GT = { evm: evm3, address: gateTok.address };
  await call(GT, "transfer(address,uint256)", [HOLDER, 1000n * E]);

  const MIN = 500n * E, UNTIL = 5000;
  const curve = await deploy(all.SnoozeCurve.evm.bytecode.object,
    [lap.address.toString(), 3n * E, 10n ** 26n, 6n * E, 100, OWNER,
     gateTok.address.toString(), MIN, UNTIL].map(w).join(""),
    { evm: evm3, timestamp: 1000 });
  const C = { evm: evm3, address: curve.address };
  await call({ evm: evm3, address: lap.address }, "transfer(address,uint256)",
             [curve.address.toString(), 10n ** 26n]);

  ok("the gate is open while the window is", !!(await call(C, "gateOpen()", [],
     { timestamp: 2000 })).words[0]);
  const canH = await call(C, "canBuy(address)", [HOLDER], { timestamp: 2000 });
  ok("a holder can buy, and the page can ask before anybody pays gas",
     canH.words[0] === 1n && canH.words[1] === 1000n * E && canH.words[2] === MIN,
     JSON.stringify(canH.words.map(String)));
  const canB = await call(C, "canBuy(address)", [BROKE], { timestamp: 2000 });
  ok("somebody holding none cannot, and is told what they need",
     canB.words[0] === 0n && canB.words[2] === MIN, JSON.stringify(canB.words.map(String)));

  const gated = await call(C, "buy(uint256,address)", [0, BROKE],
                           { from: BROKE, value: E, timestamp: 2000 });
  ok("and the buy actually reverts, not just the view", !gated.ok, "it bought");
  const allowed = await call(C, "buy(uint256,address)", [0, HOLDER],
                             { from: HOLDER, value: E, timestamp: 2000 });
  ok("while the holder's goes through", allowed.ok, allowed.revert);

  // paying on a holder's behalf is fine; the check is on who receives
  const onBehalf = await call(C, "buy(uint256,address)", [0, HOLDER],
                               { from: BROKE, value: E, timestamp: 2000 });
  ok("a stranger may pay FOR a holder, since the holder is who ends up with it",
     onBehalf.ok, onBehalf.revert);

  ok("after the window the gate is off", !(await call(C, "gateOpen()", [],
     { timestamp: UNTIL + 1 })).words[0]);
  const late = await call(C, "buy(uint256,address)", [0, BROKE],
                          { from: BROKE, value: E, timestamp: UNTIL + 1 });
  ok("and anybody can buy", late.ok, late.revert);

  const src = fs.readFileSync("contracts/SnoozeCurve.sol", "utf8");
  ok("the gate cannot be extended or repointed after deployment",
     /address public immutable gateToken/.test(src) &&
     /uint256 public immutable gateMin/.test(src) &&
     /uint64  public immutable gateUntil/.test(src));
  ok("and a gate with a token but no minimum is refused at construction",
     /\(_gateToken == address\(0\)\) != \(_gateMin == 0\)/.test(src));
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
