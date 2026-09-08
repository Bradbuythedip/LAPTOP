// deploy/config.json, loaded and then checked against the constructors it feeds.
//
// EVERY CHECK HERE IS A COPY OF A `revert BadConfig()`. That duplication is the point: the
// contract's version costs a deployment to discover, because a constructor that reverts has
// already been paid for, and on the curve it would mean grinding the salt again. This version
// costs nothing and runs before a wallet is opened. Where a check has no counterpart in the
// contract it says so, and says whose rule it is instead.
//
// loadConfig never throws on bad DATA — it collects `problems` — but it does throw on a file
// that is not shaped like a config at all, because a caller that forgets to check `problems`
// should not also get a half-built object made of undefined.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./solc.mjs";
import { sameAddress, toChecksum, ZERO } from "./abi.mjs";
import { CHAINS } from "./rpc.mjs";
import { NEVER_READY_MEANS } from "./oracle.mjs";

/// SNOOZE_CONFIG points at a different parameter file, which is what a Base Sepolia rehearsal
/// needs: the same sequence, a different oracle address and a different set of deployed
/// contracts, without editing the file the mainnet launch will be sent from. LAUNCH.md 4.0
/// calls that rehearsal the highest-value item in the document, and it is not one you can do
/// while the only config is the real one.
export const CONFIG_PATH = process.env.SNOOZE_CONFIG || path.join(ROOT, "deploy", "config.json");

const HEX = new Set("0123456789abcdef");
const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? ""));
const big = v => BigInt(String(v));

/// The oracle choices, spelled out here rather than derived from the documentation block in
/// config.json. Reading them out of `_choices` meant that renaming a comment key silently made
/// every choice invalid, with an error message that then listed nothing at all.
export const ORACLE_CHOICES = ["observational", "never-ready"];

/// Which contract may take the ground CREATE2 address, and the one that may not.
///
/// THE REFUSAL IS THE INTERESTING ENTRY. Snooze looks like the obvious thing to grind an
/// address for and it is the one contract here that cannot have one, because its constructor
/// spends msg.sender twice:
///
///     admin = msg.sender;                    // Snooze.sol
///     balanceOf[msg.sender] = supply;
///
/// Through SnoozeDeployer, msg.sender is the deployer CONTRACT. So the whole supply is minted
/// to an address whose ABI is {addressOf, count, deploy, deployed, owner, seal, sealed_} — no
/// transfer, no approve, no arbitrary call, no rescue — and `admin` is that same address, so
/// setPool can never be called and neither Snooze rule can ever fire. Both outcomes are
/// permanent. test/run-deploy.mjs deploys it that way and measures both numbers.
///
/// SnoozeCurve takes nothing from msg.sender and has no admin, so it can safely be born at a
/// chosen address — and it is the address buyers paste and send ETH to, which is the one worth
/// making recognisable.
export const VANITY_TARGETS = {
  curve: { contract: "SnoozeCurve" },
  token: { contract: "Snooze", refuse:
    'vanity.target is "token", and Snooze cannot be deployed through SnoozeDeployer.\n' +
    "Its constructor does `admin = msg.sender` and `balanceOf[msg.sender] = supply`, and " +
    "through the deployer msg.sender is the DEPLOYER CONTRACT: the whole supply would be " +
    "minted to a contract with no transfer and no rescue, and the admin that registers the " +
    "curve as a pool would be that same contract, which has no function that could call " +
    "setPool. The supply would be gone and both rules would be off, permanently.\n" +
    'Use "curve". test/run-deploy.mjs measures what the refused shape actually does.' },
};

export function loadConfig(file = CONFIG_PATH) {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["token", "curve", "fees", "gate", "vanity", "oracle"])
    if (!cfg[k] || typeof cfg[k] !== "object")
      throw new Error(`${path.basename(file)} has no "${k}" block — this is not a launch config`);

  const problems = [];
  const bad = m => problems.push(m);

  /* ---- the owner, which is also every fee destination ---- */
  if (!isAddr(cfg.owner)) bad("owner is not an address");
  else if (toChecksum(cfg.owner) !== cfg.owner)
    bad(`owner fails its EIP-55 checksum — it should be ${toChecksum(cfg.owner)}. ` +
        "A transposed character in a checksummed address stops being an address; in a " +
        "lower-cased one it quietly becomes somebody else's.");
  for (const [k, v] of Object.entries(cfg.fees)) {
    if (k.startsWith("_")) continue;
    if (!sameAddress(v, cfg.owner)) bad(`fees.${k} is not the owner address`);
  }

  if (!CHAINS[cfg.chainId])
    bad(`chainId is ${cfg.chainId}; this sequence knows ` +
        Object.entries(CHAINS).map(([k, v]) => `${k} (${v})`).join(" and "));

  /* ---- Snooze(supply, oracle, dev, devBps) ---- */
  let supply = 0n;
  try { supply = big(cfg.token.supply); } catch { bad("token.supply is not an integer"); }
  if (supply <= 0n) bad("token.supply must be above zero");
  // Snooze.sol: `if (_devBps > 2000) revert BadConfig();`
  const devBps = Number(cfg.token.devBps);
  if (!Number.isInteger(devBps) || devBps < 0 || devBps > 2000)
    bad("token.devBps must be an integer in 0..2000 — above 2000 the constructor reverts");
  const dev = cfg.token.dev;
  if (!isAddr(dev)) bad("token.dev is not an address (use the zero address when devBps is 0)");
  // Not a contract rule — Snooze does not check _dev at all. Above zero the haircut is credited
  // to balanceOf[dev], so a zero dev with a live devBps burns the dev's share to the zero
  // address on every sale while the ABI shows a dev cut that nobody receives.
  else if (devBps > 0 && sameAddress(dev, ZERO))
    bad("token.devBps is above zero with token.dev at the zero address — the dev's share of " +
        "every haircut would be credited to nobody, immutably");
  else if (devBps > 0 && !sameAddress(dev, cfg.fees.snoozeDev))
    bad("token.devBps is above zero and token.dev is not fees.snoozeDev — decide which " +
        "address is actually being paid before it becomes immutable");
  // Not a contract rule: Rule 2 baselines a wallet's balance into a uint192. Above that the cap
  // silently stops meaning anything rather than reverting, which is the worst shape a limit can
  // fail in. 27 orders of magnitude of headroom at the suggested supply.
  if (supply >= (1n << 192n))
    bad("token.supply overflows the uint192 Rule 2 baseline — the cap would silently stop working");

  /* ---- SnoozeCurve(...) ---- */
  const c = cfg.curve;
  let virtualEth = 0n, curveSupply = 0n, bondTarget = 0n;
  try { virtualEth = big(c.virtualEth); } catch { bad("curve.virtualEth is not an integer"); }
  try { curveSupply = big(c.curveSupply); } catch { bad("curve.curveSupply is not an integer"); }
  try { bondTarget = big(c.bondTarget); } catch { bad("curve.bondTarget is not an integer"); }
  if (virtualEth <= 0n) bad("curve.virtualEth must be above zero (BadConfig)");
  if (curveSupply <= 0n) bad("curve.curveSupply must be above zero (BadConfig)");
  if (bondTarget <= 0n) bad("curve.bondTarget must be above zero (BadConfig)");
  const feeBps = Number(c.feeBps);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 500)
    bad("curve.feeBps must be an integer in 0..500 — MAX_FEE_BPS is 500");
  if (feeBps > 0 && !isAddr(cfg.fees.curveFeeTo))
    bad("a non-zero fee needs a feeTo (BadConfig)");
  // Not a contract rule, and the contract cannot check it: the curve is funded by a transfer
  // AFTER it is deployed, so a curveSupply above what the owner will hold deploys a curve that
  // can never be filled and whose parameters are already immutable.
  if (curveSupply > supply)
    bad("curve.curveSupply is larger than token.supply — the curve could never be funded");

  /* ---- the gate on the SNOOZE curve itself ---- */
  // SnoozeCurve.sol: `if ((_gateToken == address(0)) != (_gateMin == 0)) revert BadConfig();`
  const gateToken = cfg.gate.gateToken ? cfg.gate.gateToken : ZERO;
  let gateMin = 0n;
  try { gateMin = big(cfg.gate.gateMin ?? 0); } catch { bad("gate.gateMin is not an integer"); }
  // Negative is neither zero nor positive, so it slips between both halves of the gate check
  // below and then resolves gateUntil to 0 — a config that validates clean and reverts at
  // construction on the one field the contract does check.
  if (gateMin < 0n) bad("gate.gateMin cannot be negative — it is a uint256 on chain");
  if (gateToken !== ZERO && !isAddr(gateToken))
    bad("gate.gateToken is neither empty nor an address");
  if (sameAddress(gateToken, ZERO) !== (gateMin === 0n))
    bad("the gate is half configured: a token with no minimum, or a minimum with no token, " +
        "is a gate that gates nothing while looking on an explorer like one that does");
  // gateUntil is a wall-clock deadline resolved at build time, not a stored constant, because
  // SnoozeCurve.sol compares `_gateUntil <= block.timestamp` INSIDE the constructor. A value
  // computed hours before the transaction is signed can be in the past by the time it lands,
  // and that reverts. Zero when there is no gate, which is the only value the contract accepts
  // when gateMin is zero anyway.
  const gateHours = Number(cfg.gate.gateUntilHoursAfterLaunch ?? 0);
  if (!Number.isFinite(gateHours) || gateHours < 0)
    bad("gate.gateUntilHoursAfterLaunch is not a number of hours");
  const gateUntil = gateMin > 0n
    ? BigInt(Math.floor(Date.now() / 1000) + Math.round(gateHours * 3600))
    : 0n;

  /* ---- the vanity suffix, and the contract it is for ---- */
  const target = String(cfg.vanity.target || "");
  if (!VANITY_TARGETS[target])
    bad(`vanity.target is "${target}" — it must be one of ` +
        Object.keys(VANITY_TARGETS).map(k => `"${k}"`).join(", "));
  else if (VANITY_TARGETS[target].refuse) bad(VANITY_TARGETS[target].refuse);
  const suffix = String(cfg.vanity.suffix || "").toLowerCase();
  if (!suffix) bad("vanity.suffix is empty");
  const nonHex = [...new Set([...suffix].filter(x => !HEX.has(x)))];
  if (nonHex.length)
    bad(`vanity.suffix "${suffix}" cannot be an address: ${nonHex.join(", ")} ` +
        `${nonHex.length > 1 ? "are" : "is"} not a hex digit. An address has only 0-9 and a-f.`);
  if (suffix.length > 8)
    bad(`vanity.suffix is ${suffix.length} characters, about ` +
        `${(16 ** suffix.length).toExponential(1)} salts — that is not a wait, it is a refusal`);

  // The oracle address is the single most irreversible field in the whole sequence, and it was
  // the only address escaping the checksum discipline the owner gets. A lower-cased address
  // that lost a character in a paste is still a valid address; a checksummed one is not.
  if (cfg.oracle.address && isAddr(cfg.oracle.address) &&
      toChecksum(cfg.oracle.address) !== cfg.oracle.address &&
      cfg.oracle.address !== cfg.oracle.address.toLowerCase())
    bad(`oracle.address fails its EIP-55 checksum — it should be ` +
        `${toChecksum(cfg.oracle.address)}`);

  /* ---- the oracle documentation, checked against the choices the code accepts ---- */
  for (const k of ORACLE_CHOICES)
    if (!cfg.oracle._choices || !cfg.oracle._choices[k])
      bad(`oracle._choices does not describe "${k}", which is a choice the scripts accept`);

  return {
    raw: cfg,
    problems,
    chainId: cfg.chainId,
    owner: cfg.owner,
    token: { name: cfg.token.name, symbol: cfg.token.symbol, decimals: cfg.token.decimals,
             supply, devBps, dev },
    curve: { virtualEth, curveSupply, bondTarget, feeBps, feeTo: cfg.fees.curveFeeTo,
             gateToken, gateMin, gateUntil },
    vanity: { suffix, target, contract: VANITY_TARGETS[target]?.contract || null },
    oracle: { choice: String(cfg.oracle.choice || ""), address: cfg.oracle.address || "",
              choices: ORACLE_CHOICES, describe: cfg.oracle._choices || {} },
  };
}

/// The refusal the whole sequence hangs off: nothing may be built while nobody has said, in
/// writing, which of the three oracles this launch has.
///
/// Rejected: defaulting to "never-ready" because it is the safe one. It is safe and it is also
/// a different token — Rule 1 never fires — and a launch that quietly became an ordinary
/// ERC-20 because a config key was blank is exactly the outcome this file exists to prevent.
export function oracleDecision(cfg) {
  const { choice, address, choices, describe } = cfg.oracle;
  if (!choice)
    return { ok: false, reason:
      'deploy/config.json has oracle.choice = "". Nothing further can be built.\n\n' +
      "Snooze takes the oracle address in its constructor and it is IMMUTABLE — no key, " +
      "including yours, can change it afterwards. Pick one and write it down:\n\n" +
      choices.map(k => `  "${k}"\n      ${describe[k] || "(undocumented)"}`).join("\n\n") +
      "\n\nThere is deliberately no default. See LAUNCH.md 2.1." };
  if (!choices.includes(choice))
    return { ok: false, reason: `oracle.choice is "${choice}", which is not one of ` +
      choices.map(k => `"${k}"`).join(", ") };
  if (!isAddr(address))
    return { ok: false, reason: `oracle.choice is "${choice}" but oracle.address is not an ` +
      "address. There is no oracle in this repository: deploy yours first, then record it here." };
  if (sameAddress(address, ZERO))
    return { ok: false, reason: "the zero address is not an oracle — Snooze's constructor " +
      "reverts on it (BadConfig), which is the one guard the token itself has" };
  return { ok: true, choice, address,
           ruleOneEverFires: choice !== "never-ready",
           describe: describe[choice] };
}

export const RULE_ONE_NEVER = NEVER_READY_MEANS;
