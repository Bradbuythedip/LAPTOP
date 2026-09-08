// The six steps, as data rather than as prose in a runbook.
//
// EACH STEP IS FOUR THINGS and no more: the transactions it sends, what about it can never be
// undone, what has to be true before it can be built at all, and what reading it back looks
// like. Keeping them together is the reason the command line and deploy/deploy.html cannot
// drift — they render the same objects, they do not each implement the sequence.
//
// WHAT IS NOT HERE: signing. No step produces a signature, a key, or a raw transaction. A step
// produces {to, data, value}, which is what you hand a wallet, and `to: null` means a
// deployment.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THE TOKEN IS NOT DEPLOYED THROUGH THE DEPLOYER, which is the one place this sequence
// departs from LAUNCH.md 4 and from the obvious reading of "put the first token where it was
// promised to be".
//
// Snooze's constructor spends msg.sender twice:
//
//     admin = msg.sender;
//     balanceOf[msg.sender] = supply;
//
// Through SnoozeDeployer, msg.sender is the deployer CONTRACT. Deployed that way — measured in
// test/run-deploy.mjs, not reasoned about — the entire supply is minted to an address whose
// whole ABI is {addressOf, count, deploy, deployed, owner, seal, sealed_}: no transfer, no
// approve, no arbitrary call, no rescue. The supply is gone. And `admin` is that same address,
// so setPool can never be called, so isPool is empty forever, and BOTH Snooze rules are off —
// _move() fires the haircut and the daily cap on the same condition, `isPool[to] &&
// !capExempt[from]`, so a token with no registered pool has neither.
//
// So the token is deployed from the owner's own wallet, where admin and the supply both land
// on the owner, and the ground address goes to the curve instead — which takes nothing from
// msg.sender, has no admin, and is the address buyers actually paste and send ETH to. That
// also makes "grind last" a hard constraint rather than advice: the curve's constructor
// arguments contain the token's address, so the salt cannot even be attempted until the token
// exists.
// ─────────────────────────────────────────────────────────────────────────────────────────
import {
  addressWord, uintWord, selector, keccakHex, create2Address, encodeDeployCall,
  readUint, readBool, readAddress, readString, sameAddress, toChecksum, ZERO,
} from "./abi.mjs";
import { oracleDecision } from "./config.mjs";
import { inspectOracle, NEVER_READY_MEANS } from "./oracle.mjs";
import { isVerified, stepState } from "./state.mjs";

/// A view call, described once and rendered by both the CLI and the page.
export const view = (sig, args = "") => ({ sig, data: selector(sig) + args });

const ORACLE_VIEWS = ["ready()", "spot()", "twap24()"];

export const STEP_IDS = ["oracle", "deployer", "token", "salt", "curve", "lock"];
export const STEP_NUMBER = Object.fromEntries(STEP_IDS.map((id, i) => [id, i + 1]));

/* ------------------------------------------------------------------ constructor arguments */

/// Snooze(uint256 supply, address _oracle, address _dev, uint256 _devBps)
export const snoozeArgs = (cfg, oracle) =>
  uintWord(cfg.token.supply) + addressWord(oracle) +
  addressWord(cfg.token.dev) + uintWord(cfg.token.devBps);

/// SnoozeCurve(address _token, uint256 _virtualEth, uint256 _curveSupply, uint256 _bondTarget,
///             uint256 _feeBps, address _feeTo, address _gateToken, uint256 _gateMin,
///             uint64 _gateUntil)
export const curveArgs = (cfg, token) =>
  addressWord(token) + uintWord(cfg.curve.virtualEth) + uintWord(cfg.curve.curveSupply) +
  uintWord(cfg.curve.bondTarget) + uintWord(cfg.curve.feeBps) + addressWord(cfg.curve.feeTo) +
  addressWord(cfg.curve.gateToken) + uintWord(cfg.curve.gateMin) +
  uintWord(cfg.curve.gateUntil, 64);

/// The exact init code the CREATE2 address is derived from: the contract's own bytecode with
/// its encoded constructor arguments appended. Change the token address, the fee address, the
/// bond target, or a comment in SnoozeCurve.sol that shifts a byte, and this changes, and so
/// does the address. That is the whole reason the salt is ground last.
export const curveInitCode = (artifacts, cfg, token) =>
  artifacts.contracts.SnoozeCurve.initCode + curveArgs(cfg, token);

export const curveInitCodeHash = (artifacts, cfg, token) =>
  keccakHex(curveInitCode(artifacts, cfg, token));

/* --------------------------------------------------------------- small check helpers */

const hasCode = code => !!code && code !== "0x" && code !== "";

const decode = (results, sig, fn) => {
  const r = results[sig];
  if (!r || !r.ok) return null;
  try { return fn(r.data); } catch { return null; }
};

/// Every check is {ok, name, detail}. `detail` is only shown when it says something the name
/// does not — a passing check with a detail is noise, and noise is how a failing one is missed.
const checks = () => {
  const out = [];
  return {
    out,
    add: (ok, name, detail = "") => out.push({ ok: !!ok, name, detail }),
    num(results, sig, want, name) {
      const v = decode(results, sig, readUint);
      out.push({ ok: v === BigInt(want), name: name || `${sig} is ${want}`,
                 detail: v === null ? "could not be read" : v === BigInt(want) ? "" : `it is ${v}` });
    },
    addr(results, sig, want, name) {
      const v = decode(results, sig, readAddress);
      out.push({ ok: sameAddress(v, want), name: name || `${sig} is ${toChecksum(want)}`,
                 detail: v === null ? "could not be read" : sameAddress(v, want) ? "" : `it is ${v}` });
    },
    bool(results, sig, want, name) {
      const v = decode(results, sig, readBool);
      out.push({ ok: v === want, name: name || `${sig} is ${want}`,
                 detail: v === null ? "could not be read" : `it is ${v}` });
    },
    str(results, sig, want) {
      const v = decode(results, sig, readString);
      out.push({ ok: v === want, name: `${sig} is "${want}"`,
                 detail: v === null ? "could not be read" : v === want ? "" : `it is "${v}"` });
    },
  };
};

/* ---------------------------------------------------------------------------- the steps */

export function buildSteps({ cfg, artifacts, state }) {
  const oracle = oracleDecision(cfg);
  const readBack = id => stepState(state, id).readBack || {};

  // The recorded address wins over the configured one: when step 1 deploys the never-ready
  // oracle, the receipt is where the address comes from, and config.json has nothing to say.
  const oracleAddress = readBack("oracle").address || (oracle.ok ? oracle.address : null);
  const deployerAddress = readBack("deployer").address || null;
  const tokenAddress = readBack("token").address || null;
  const saltRecord = readBack("salt");
  const curveAddress = readBack("curve").address || null;

  const need = (id, why) => isVerified(state, id) ? null
    : `step ${STEP_NUMBER[id]} (${id}) has not been verified yet — ${why}`;

  return [
    /* ---------------------------------------------------------------------- 1. the oracle */
    {
      n: 1, id: "oracle",
      title: "The oracle",
      what: "Record the oracle this token will point at forever, and prove it answers without " +
            "reverting while it still has no history — which is the state it will be in at launch.",
      // One transaction, and only for the one oracle this repository can honestly provide.
      //
      // The first version of this step sent nothing at all, on the grounds that the only
      // implementation here was the settable mock and a convenient button for it is how it
      // reaches Base "temporarily". That reasoning is still right about the mock and it left
      // the sequence unfinishable: Snooze needs an immutable oracle address and there was
      // nowhere for it to point. contracts/SnoozeNeverReady.sol is the other answer — every
      // function `pure`, no storage, no owner, no constructor argument, 156 bytes — so what it
      // will answer is fixed at compile time rather than held by anybody. It costs Rule 1, and
      // that is said on the page, in the plan, and in the note below rather than in a comment.
      txs: [{
        key: "deploy",
        label: "Deploy SnoozeNeverReady",
        build: () => ({
          to: null, value: "0x0",
          data: artifacts.contracts.SnoozeNeverReady.initCode,
          about: "constructor() — no arguments, because there is nothing to configure. " +
                 "ready() false, spot() == twap24(), all three pure.",
        }),
        blocked: () => oracle.ok && oracle.deployable ? null
          : oracle.ok ? `oracle.address is already ${oracle.address} — step 1 records and ` +
                        "verifies it, it does not deploy over it"
                      : oracle.reason,
      }],
      irreversible: [
        "Snooze.oracle is immutable. After step 3 nobody can change it — not you, not the " +
        "deployer, not a proxy, because there is no proxy.",
        "A settable oracle is a dial that sets every sale's burn to anything up to 90%, held " +
        "by whoever holds its key, forever. contracts/test/SnoozeMocks.sol:MockOracle is that.",
        "A reverting oracle is a permanent honeypot: ready() runs inside every sell, so sells " +
        "revert while buys work, and the address cannot be changed.",
      ],
      confirm: null,
      blocked: () => oracle.ok ? null : oracle.reason,
      note: () => oracle.ok && !oracle.ruleOneEverFires
        ? NEVER_READY_MEANS + (oracle.deployable
            ? " That is what contracts/SnoozeNeverReady.sol is, and it is the only oracle this " +
              "repository contains that is safe to deploy."
            : "")
        : null,
      expectAddress: () => null,
      verify: {
        target: () => oracleAddress,
        needsAddress: "the oracle's address — deploy one with step 1, or set oracle.address " +
                      "in deploy/config.json if it already exists",
        calls: ORACLE_VIEWS.map(sig => view(sig)),
        // Delegated to lib/oracle.mjs, which is careful about what each check actually
        // proves. The first version of this computed a blocklist in solc.mjs and never
        // consulted it, so a MockOracle — spot 0, twap24 0, ready false before anybody calls
        // set() — passed every assertion cleanly. The guard that is not wired up is worse
        // than no guard, because it shows a tick.
        check: (results, { code }) =>
          inspectOracle({ code, results, refuse: artifacts.refuse, choice: oracle.choice }),
        record: (results, ctx) => ({ address: (ctx && ctx.address) || oracleAddress,
                                     choice: oracle.choice,
                                     readyAtRecord: decode(results, "ready()", readBool) }),
      },
    },

    /* -------------------------------------------------------------------- 2. the deployer */
    {
      n: 2, id: "deployer",
      title: "SnoozeDeployer",
      what: `CREATE2, locked to ${toChecksum(cfg.owner)}. Anyone may send THIS transaction — ` +
            "the owner is the constructor argument, not the sender — but only that owner can " +
            "deploy anything from it afterwards.",
      txs: [{
        key: "deploy",
        label: "Deploy SnoozeDeployer",
        build: () => ({
          to: null,
          data: artifacts.contracts.SnoozeDeployer.initCode + addressWord(cfg.owner),
          value: "0x0",
          about: `constructor(address _owner = ${toChecksum(cfg.owner)})`,
        }),
        blocked: () => null,
      }],
      irreversible: [
        "owner is immutable: there is no transferOwnership and no renounce, because both are " +
        "ways for an address you checked to become one you did not.",
      ],
      confirm: null,
      blocked: () => null,
      verify: {
        target: () => deployerAddress,
        needsAddress: "the address SnoozeDeployer landed at",
        calls: [view("owner()"), view("sealed_()"), view("count()")],
        check: (results, { code }) => {
          const c = checks();
          c.add(hasCode(code), "there is code at the address the deployment created");
          c.addr(results, "owner()", cfg.owner);
          c.bool(results, "sealed_()", false, "sealed_() is false, so it can still deploy");
          c.num(results, "count()", 0n, "count() is 0 — nothing has been deployed from it yet");
          return c.out;
        },
        record: (_r, { address }) => ({ address }),
      },
    },

    /* ------------------------------------------------------------------------- 3. the token */
    {
      n: 3, id: "token",
      title: "Snooze, from your own wallet",
      what: "An ordinary deployment, sent by the owner. NOT through SnoozeDeployer: see the " +
            "note below, which is measured rather than argued.",
      txs: [{
        key: "deploy",
        label: "Deploy Snooze",
        build: () => ({
          to: null,
          data: artifacts.contracts.Snooze.initCode + snoozeArgs(cfg, oracleAddress),
          value: "0x0",
          from: cfg.owner,
          about: `constructor(supply=${cfg.token.supply}, oracle=${oracleAddress}, ` +
                 `dev=${cfg.token.dev}, devBps=${cfg.token.devBps})`,
        }),
        blocked: () => oracle.ok ? null : oracle.reason,
      }],
      irreversible: [
        `oracle = ${oracleAddress || "?"} is written into the token's immutable storage. ` +
        "Nobody can change it afterwards, including you.",
        `devBps = ${cfg.token.devBps} is immutable. ` +
        (cfg.token.devBps === 0
          ? "At zero, supplyOnlyFalls() is true and every haircut is destroyed rather than paid out."
          : "Above zero, supplyOnlyFalls() returns FALSE — the 'supply only goes down' claim " +
            "is not true and the contract says so on chain."),
        `dev = ${cfg.token.dev} is immutable.`,
        `totalSupply is fixed at ${cfg.token.supply} base units. There is no mint.`,
        "admin is msg.sender, so it is YOUR WALLET only because you sent this yourself. It is " +
        "the address that can register the curve as a pool in step 5, once, before freeze().",
      ],
      confirm: "the oracle address and devBps are immutable and I have checked both",
      // Both halves. A chosen oracle is a line in a config file; a VERIFIED one is three views
      // that answered without reverting at an address with code on it. The address is about to
      // become immutable, so the second is the one that has to hold.
      blocked: () => (oracle.ok ? null : oracle.reason) ||
                     need("oracle", "the oracle address becomes immutable in this transaction"),
      note: () =>
        "Sent from your wallet, not through SnoozeDeployer. Snooze's constructor does " +
        "`admin = msg.sender` and `balanceOf[msg.sender] = supply`, so deploying it through " +
        "the deployer would mint the whole supply to a contract with no transfer and no " +
        "rescue, and hand admin to that same contract — which has no function that could call " +
        "setPool, so neither Snooze rule could ever fire. The ground address goes to the " +
        "curve in step 5 instead.",
      verify: {
        target: () => tokenAddress,
        needsAddress: "the address Snooze landed at",
        calls: [view("name()"), view("symbol()"), view("decimals()"), view("totalSupply()"),
                view("oracle()"), view("dev()"), view("devBps()"), view("supplyOnlyFalls()"),
                view("admin()"), view("frozen()"),
                view("balanceOf(address)", addressWord(cfg.owner))],
        check: (results, { code }) => {
          const c = checks();
          c.add(hasCode(code), "there is code at the token's address");
          c.str(results, "name()", cfg.token.name);
          c.str(results, "symbol()", cfg.token.symbol);
          c.num(results, "decimals()", cfg.token.decimals);
          c.num(results, "totalSupply()", cfg.token.supply);
          c.addr(results, "oracle()", oracleAddress || ZERO);
          c.addr(results, "dev()", cfg.token.dev);
          c.num(results, "devBps()", cfg.token.devBps);
          c.bool(results, "supplyOnlyFalls()", cfg.token.devBps === 0);
          // The two that the deployer route would have broken, checked as facts rather than
          // trusted from having sent the transaction from the right place.
          c.addr(results, "admin()", cfg.owner,
                 `admin() is your wallet, so setPool is callable in step 5`);
          // State-aware, because this step gets re-read. At step 3 the owner holds everything;
          // after step 5 they hold supply - curveSupply, and after step 6 the token is frozen.
          // Asserting the step-3 values unconditionally meant a CORRECTLY FINISHED launch
          // failed its own step 3 — and on the page that same click downgraded the recorded
          // verification and locked step 4 behind it.
          const owned = decode(results, "balanceOf(address)", readUint);
          const funded = isVerified(state, "curve");
          const want = funded ? cfg.token.supply - cfg.curve.curveSupply : cfg.token.supply;
          c.add(owned !== null && owned >= want,
                funded ? "your residual is still at your address"
                       : "the whole supply is at your address, which is what funds the curve",
                owned === null ? "could not be read" : owned >= want ? "" :
                  `you hold ${owned}, expected at least ${want}`);
          const froz = decode(results, "frozen()", readBool);
          const locked = isVerified(state, "lock");
          c.add(froz === locked,
                locked ? "frozen() is true, as step 6 left it"
                       : "frozen() is false, so the curve can still be registered",
                froz === null ? "could not be read" : `it is ${froz}`);
          return c.out;
        },
        record: (_r, { address }) => ({ address }),
      },
    },

    /* ------------------------------------------------------------------------- 4. the salt */
    {
      n: 4, id: "salt",
      title: "The vanity salt",
      what: `Grind a CREATE2 salt so ${cfg.vanity.contract} lands on an address ending ` +
            `…${cfg.vanity.suffix}. Last, and it could not have been earlier: the curve's ` +
            "constructor arguments contain the token's address, so this had nothing to grind " +
            "against until step 3 landed.",
      txs: [],
      irreversible: [],
      confirm: null,
      blocked: () => need("token", "the curve's init code contains the token address") ||
                     need("deployer", "the salt is ground against that deployer's address") ||
                     (oracle.ok ? null : oracle.reason),
      /// Not a chain read. The check is that the salt, the init-code hash and the deployer
      /// still produce the promised address, recomputed here rather than trusted from the
      /// grinder's own output. LAUNCH.md 2c asks for the derivation twice, independently; this
      /// is the second, and step 5 reads the third off the chain by calling addressOf.
      verify: {
        offline: true,
        check: () => {
          const c = checks();
          c.add(!!saltRecord.salt, "a salt has been ground",
                saltRecord.salt ? "" : "run: node deploy/scripts/grind.mjs");
          if (!saltRecord.salt || !deployerAddress || !tokenAddress) return c.out;
          const want = curveInitCodeHash(artifacts, cfg, tokenAddress);
          const same = saltRecord.initCodeHash === want;
          c.add(same, "the salt was ground against the init code this launch will send",
                same ? "" : `ground against ${saltRecord.initCodeHash}, this launch sends ` +
                  `${want} — a parameter changed after the grind, so the address would differ`);
          const derived = create2Address(deployerAddress, saltRecord.salt, want);
          c.add(sameAddress(derived, saltRecord.predicted),
                "recomputing keccak(0xff, deployer, salt, initCodeHash) agrees",
                sameAddress(derived, saltRecord.predicted) ? ""
                  : `recomputed ${derived}, recorded ${saltRecord.predicted}`);
          c.add(String(derived).toLowerCase().endsWith(cfg.vanity.suffix),
                `the address ends …${cfg.vanity.suffix}`, derived);
          return c.out;
        },
        record: () => saltRecord,
      },
    },

    /* ------------------------------------------------------------------------ 5. the curve */
    {
      n: 5, id: "curve",
      title: "SnoozeCurve, at the ground address",
      what: "Three transactions, and the order is load-bearing: deploy the curve through the " +
            "deployer, send it the allocation it is allowed to sell, and only then register " +
            "it as the pool.",
      txs: [
        {
          key: "deploy",
          label: `Deploy SnoozeCurve at …${cfg.vanity.suffix}`,
          build: () => ({
            to: deployerAddress,
            data: encodeDeployCall(saltRecord.salt,
                                   curveInitCode(artifacts, cfg, tokenAddress)),
            value: "0x0",
            from: cfg.owner,
            about: `deploy(salt=${saltRecord.salt}, initCode=SnoozeCurve + args) → ` +
                   `${saltRecord.predicted || "?"}. Only ${toChecksum(cfg.owner)} may send ` +
                   "this; SnoozeDeployer.deploy reverts with NotOwner for anybody else.",
          }),
          blocked: () => need("salt", "there is no salt to deploy with"),
        },
        {
          key: "fund",
          label: "Send the curve its allocation",
          build: () => ({
            to: tokenAddress,
            data: selector("transfer(address,uint256)") +
                  addressWord(curveAddress) + uintWord(cfg.curve.curveSupply),
            value: "0x0",
            from: cfg.owner,
            about: `transfer(${curveAddress}, ${cfg.curve.curveSupply})`,
          }),
          // BEFORE setPool, and that is not a preference. Once isPool[curve] is true, a
          // transfer INTO the curve from a non-exempt wallet is a sell: Rule 2 caps it at 20%
          // of the sender's balance and Rule 1 haircuts what is left. Funding after
          // registering would revert, and if it did not it would burn part of the float.
          blocked: () => curveAddress ? null
            : "the curve's address is not known yet — send and verify the deployment first",
        },
        {
          key: "register",
          label: "Register the curve as the pool",
          build: () => ({
            to: tokenAddress,
            data: selector("setPool(address,bool)") + addressWord(curveAddress) + uintWord(1),
            value: "0x0",
            from: cfg.owner,
            about: `setPool(${curveAddress}, true) — this is what switches BOTH Snooze rules ` +
                   "on. _move() fires the haircut and the daily cap on the same condition, " +
                   "isPool[to] && !capExempt[from], so until this lands the token has neither.",
          }),
          blocked: () => curveAddress ? null : "the curve does not exist yet",
          // THE ORDER IS LOAD-BEARING, so it is a chain read rather than a comment.
          //
          // The moment isPool[curve] is true, a transfer INTO the curve from a non-exempt
          // wallet is a sell. Rule 2 rejects the whole float with CapExceeded at 20% of the
          // sender's baseline; retrying at the cap SUCCEEDS and returns true while Rule 1
          // burns the haircut out of it — the curve ends up holding a fraction of what it was
          // supposed to, quietly, and the parameters are already immutable. setPool exempts
          // the curve (Snooze.sol: `capExempt[p] = on`), not the sender, so it does not rescue
          // the wrong order.
          //
          // Refusing offline is deliberate: a precondition nobody can check is not one.
          precondition: {
            needsChain: "setPool is only safe once the curve is already funded, and that is a " +
                        "fact about the chain rather than about this file",
            calls: () => tokenAddress && curveAddress ? [
              { sig: "token.balanceOf(curve)", to: tokenAddress,
                data: selector("balanceOf(address)") + addressWord(curveAddress) },
              { sig: "curve.sold()", to: curveAddress, data: selector("sold()") },
            ] : [],
            // held + sold, NOT held == curveSupply, and the difference is the launch.
            //
            // The curve is public and tradeable the moment it is funded, and setPool is a
            // separate transaction — so there is a window, and anybody may buy in it. A strict
            // balance check turns that ordinary event into a permanent brick: one 0.1 ETH buy
            // leaves the curve holding less than curveSupply forever, so this precondition
            // never passes again, setPool is never built, neither rule ever fires, and step 6
            // is gated on step 5 so freeze() and seal() are unreachable for the life of the
            // token. Measured: it happens on the first buy.
            //
            // What actually has to hold is that the curve RECEIVED its allocation, and
            // SnoozeCurve maintains exactly that: buy does `sold += out` then transfers out,
            // sell reverses both, so held + sold is invariant at curveSupply.
            check: (results) => {
              const held = decode(results, "token.balanceOf(curve)", readUint);
              const sold = decode(results, "curve.sold()", readUint);
              const got = held === null || sold === null ? null : held + sold;
              return [{
                ok: got !== null && got >= cfg.curve.curveSupply,
                name: "the curve has received its whole allocation",
                detail: got === null ? "could not read the curve's balance and sold()"
                  : got >= cfg.curve.curveSupply
                    ? (sold > 0n ? `holds ${held}, already sold ${sold} — trading has started, ` +
                                   "so register it now" : "")
                    : `it has received ${got} of ${cfg.curve.curveSupply}. Send the REST of the ` +
                      "allocation before registering: once setPool lands, a transfer into the " +
                      "curve is a sell, and Rule 2 rejects it while Rule 1 burns part of a " +
                      "retry. This shortfall is missing funding, not trading — trading moves " +
                      "tokens from the balance into sold() and leaves the sum alone.",
              }];
            },
          },
        },
      ],
      irreversible: [
        `feeTo = ${toChecksum(cfg.curve.feeTo)} is immutable. There is no setFeeTo: a fee ` +
        "address that can be repointed later is an admin key with a different name.",
        `virtualEth = ${cfg.curve.virtualEth}, curveSupply = ${cfg.curve.curveSupply}, ` +
        `bondTarget = ${cfg.curve.bondTarget} and feeBps = ${cfg.curve.feeBps} are all ` +
        "immutable. How much real money it takes to graduate is fixed here and cannot be tuned.",
        "The gate halves are immutable. This curve has no gate, because there is no SNOOZE to " +
        "hold before SNOOZE exists.",
        "Tokens sent to the curve are the curve's. There is no rescue, sweep or withdraw.",
        "setPool also sets capExempt for the curve, permanently, so the curve can pay buyers " +
        "out. That is required — without it nobody could buy more than 20% of its float a day.",
        "bond() IS PERMISSIONLESS AND THE CALLER NAMES THE DESTINATION. SnoozeCurve.bond " +
        "checks only that the target is reached and that `pool` is non-zero, so the first " +
        `stranger to call it after reserveEth passes ${cfg.curve.bondTarget} wei receives the ` +
        "whole raise and the pool's token side, at an address they chose. The contract's own " +
        "comment calls this a real trust edge and says a launchpad is meant to pin the pool; " +
        "this sequence has no launchpad, so nothing pins it. See AFTER_THE_SEQUENCE.",
      ],
      confirm: "the curve parameters and the fee address are immutable and I have checked them",
      blocked: () => need("salt", "the curve is deployed at the ground address"),
      // The curve is deployed BY A CONTRACT, so the transaction is a call to SnoozeDeployer and
      // its receipt carries no contractAddress — a receipt only names an address it created
      // directly. There is nothing to learn from it, and nothing needs learning: CREATE2 means
      // the address was fixed when the salt was ground, and step 4 recorded it. This is what
      // record.mjs uses when a receipt has no address of its own.
      expectAddress: () => saltRecord.predicted || null,
      verify: {
        target: () => curveAddress || saltRecord.predicted,
        needsAddress: "the address SnoozeCurve landed at",
        calls: [view("token()"), view("feeTo()"), view("feeBps()"), view("virtualEth()"),
                view("curveSupply()"), view("bondTarget()"), view("gateToken()"),
                view("gateMin()"), view("sold()"), view("reserveEth()"), view("bonded()")],
        // Read on the TOKEN rather than on the curve, so they are described separately. The
        // balance is the one that says the curve can actually settle a trade; the other two
        // are what says the rules are on.
        extraCalls: () => tokenAddress && curveAddress ? [
          { sig: "token.balanceOf(curve)", to: tokenAddress,
            data: selector("balanceOf(address)") + addressWord(curveAddress) },
          { sig: "token.isPool(curve)", to: tokenAddress,
            data: selector("isPool(address)") + addressWord(curveAddress) },
          { sig: "token.capExempt(curve)", to: tokenAddress,
            data: selector("capExempt(address)") + addressWord(curveAddress) },
        ] : [],
        check: (results, { code, address }) => {
          const c = checks();
          c.add(hasCode(code), "there is code at the curve's address", address || "");
          const promised = saltRecord.predicted;
          c.add(sameAddress(address, promised),
                "and it is exactly the address addressOf promised before it existed",
                promised ? `promised ${promised}` : "no predicted address recorded");
          c.add(String(address || "").toLowerCase().endsWith(cfg.vanity.suffix),
                `the address ends …${cfg.vanity.suffix}`, address || "");
          c.addr(results, "token()", tokenAddress || ZERO);
          c.addr(results, "feeTo()", cfg.curve.feeTo);
          c.num(results, "feeBps()", cfg.curve.feeBps);
          c.num(results, "virtualEth()", cfg.curve.virtualEth);
          c.num(results, "curveSupply()", cfg.curve.curveSupply);
          c.num(results, "bondTarget()", cfg.curve.bondTarget);
          c.addr(results, "gateToken()", cfg.curve.gateToken);
          c.num(results, "gateMin()", cfg.curve.gateMin);
          // NOT assertions that these are zero. They are zero if you verify before anybody
          // trades, and the curve is public from the block it is funded — a single buy between
          // the transfer and this read would otherwise fail step 5 forever, and step 6 is
          // gated on step 5, so freeze() and seal() would be unreachable for the rest of the
          // token's life. What actually has to hold is that the curve has not bonded and has
          // not sold more than it owns; the two numbers are reported so you can see whether
          // trading has started, which is a fact and not a failure.
          const sold = decode(results, "sold()", readUint);
          c.add(sold !== null && sold <= cfg.curve.curveSupply,
                "sold() is within what the curve was funded with",
                sold === null ? "could not be read"
                  : sold === 0n ? "nothing has traded yet"
                  : `${sold} already sold — trading has started, so freeze quickly`);
          const res = decode(results, "reserveEth()", readUint);
          c.add(res !== null, "reserveEth() reads",
                res === null ? "could not be read" : res === 0n ? "" : `${res} wei already in`);
          c.bool(results, "bonded()", false);
          // held + sold, not held == curveSupply. The curve is public from the block it is
          // funded, and every buy moves tokens out of it (`sold += out`, then a transfer), so a
          // strict equality fails the moment anybody trades before you get round to verifying —
          // and step 6 is gated on step 5, so freeze() and seal() would be out of reach for the
          // rest of the token's life. The invariant SnoozeCurve actually maintains is that what
          // it holds plus what it has sold is what it was funded with.
          const held = decode(results, "token.balanceOf(curve)", readUint);
          c.add(held !== null && sold !== null && held + sold >= cfg.curve.curveSupply,
                "the curve holds every token it is allowed to sell, less what it has sold",
                held === null || sold === null ? "could not be read"
                  : `holds ${held}, sold ${sold}, funded with ${cfg.curve.curveSupply}`);
          c.bool(results, "token.isPool(curve)", true,
                 "isPool(curve) is true, so both Snooze rules are on");
          c.bool(results, "token.capExempt(curve)", true,
                 "capExempt(curve) is true, so the curve can pay buyers out");
          return c.out;
        },
        record: (_r, { address }) => ({ address }),
      },
    },

    /* ------------------------------------------------------------- 6. give up the keys */
    {
      n: 6, id: "lock",
      title: "Freeze the token, seal the deployer",
      what: "Two one-way doors. After these there is no address on this launch that can " +
            "change a pool, an exemption, or deploy anything else — including yours.",
      txs: [
        {
          key: "freeze",
          label: "freeze() the token",
          build: () => ({
            to: tokenAddress, data: selector("freeze()"), value: "0x0", from: cfg.owner,
            about: "freeze() — setPool and setCapExempt revert with Frozen() for every " +
                   "caller from here on. Until this lands, admin can exempt itself from Rule " +
                   "2, which makes Rule 2 a promise rather than a rule.",
          }),
          blocked: () => need("curve", "freezing before the curve is registered leaves a token " +
                             "with no pool and therefore no rules, permanently"),
        },
        {
          key: "seal",
          label: "seal() the deployer",
          build: () => ({
            to: deployerAddress, data: selector("seal()"), value: "0x0", from: cfg.owner,
            about: "seal() — deploy() reverts with IsSealed for every caller, forever.",
          }),
          // SnoozeGate is deployed through the same deployer if it is part of this launch, so
          // sealing before it exists costs the gate its ground address permanently.
          blocked: () => need("curve", "there would be nothing deployed to seal around"),
        },
      ],
      irreversible: [
        "There is no unfreeze. No venue created after this is ever inside either rule, and " +
        "there is no call that adds one — liquidity that migrates to a wrapper or an " +
        "unregistered pair trades untaxed and effectively uncapped. That is the trade.",
        "There is no unseal. Nothing can ever be deployed from this SnoozeDeployer again.",
        "If SnoozeGate is part of this launch, deploy it BEFORE sealing — afterwards it can " +
        "only land at an ordinary CREATE address, never a ground one.",
      ],
      confirm: "freezing and sealing cannot be undone and nothing else needs deploying",
      blocked: () => need("curve", "there is nothing to lock yet"),
      verify: {
        target: () => deployerAddress,
        calls: [view("sealed_()"), view("count()")],
        extraCalls: () => tokenAddress ? [
          { sig: "token.frozen()", to: tokenAddress, data: selector("frozen()") },
        ] : [],
        check: (results) => {
          const c = checks();
          c.bool(results, "token.frozen()", true, "the token is frozen");
          c.bool(results, "sealed_()", true, "the deployer is sealed");
          const n = decode(results, "count()", readUint);
          c.add(n !== null && n >= 1n,
                "count() records what it deployed, so the set is enumerable without logs",
                n === null ? "could not be read" : `${n} deployed`);
          return c.out;
        },
        record: (_r, { address }) => ({ address }),
      },
    },
  ];
}

/// What the six steps do NOT cover. Printed at the end of `plan.mjs` and shown on the page,
/// because a sequence that ends green while the launch is still half-done is a worse lie than
/// one that fails.
export const AFTER_THE_SEQUENCE = [
  {
    title: "bond() is a race you can lose",
    body: "SnoozeCurve.bond(pool) is permissionless and the CALLER chooses where the ETH and " +
      "the token side go. It becomes callable the instant reserveEth reaches bondTarget, and " +
      "whoever calls it first takes the raise. Measured against these exact parameters: a " +
      "stranger calling bond(theirOwnAddress) after the target is crossed receives all of " +
      "reserveEth and the whole pool allocation. Nothing in these scripts can prevent that — " +
      "the fix is a contract change that pins `pool` at construction. Until then, either " +
      "watch for the target yourself and be first, or accept the race, and do not let anyone " +
      "find out about it after they have bought.",
  },
  {
    title: "Where the supply ends up",
    body: "The curve is funded with curveSupply and the rest stays in your wallet from the " +
      "block the token is deployed — at the configured numbers that is 20% of supply, and " +
      "another 8% comes back to feeTo as bondPreview()'s leftover (curveSupply / m) if the " +
      "curve graduates. Unlike the launchpad path in LAUNCH.md 1, that residual is not exempt " +
      "from anything: setPool exempts the CURVE, not the sender, so your treasury sits under " +
      "both rules like everybody else's and freeze() makes it permanent. Publish the address.",
  },
  {
    title: "The site still points at nothing",
    body: "web/index.html holds `const POOL = \"\"` and `const TOKEN = \"\"`. Filling them in " +
      "changes those files, which changes their hashes, which `node tools/stamp.mjs` " +
      "republishes in the README. Until then the landing page reads a chain address of \"\".",
  },
  {
    title: "Nothing is verified on Basescan",
    body: "solc 0.8.36, optimizer on, 200 runs, flattened source. The curve was created BY A " +
      "CONTRACT, so it is verified at its own address with its own re-encoded constructor " +
      "arguments — deploy/artifacts.json lists them in order.",
  },
  {
    title: "A holder cannot sell 100% of a position back to the curve",
    body: "Rule 2 stops most of them, and before quoteSell is reached: a transfer into the " +
      "registered curve runs _chargeWindow first, so a wallet holding exactly what the curve has " +
      "sold reverts with CapExceeded rather than an arithmetic error, and each new window " +
      "re-baselines on what is left — 20% of a shrinking bag never releases the last slice. A " +
      "wallet holding five times the curve's sold clears the cap (your own residual treasury is " +
      "one, early on) and then meets the other edge: every buy rounds tokensOut up and drifts " +
      "the constant product down, so quoteSell(sold) computes a gross a wei or two above " +
      "reserveEth and sell(sold) reverts with an arithmetic panic. Measured: after one 0.1 ETH " +
      "buy, sold panics and sold - 1 clears; after one of 1 ETH, sold - 1 panics too. The margin " +
      "is a function of the trade history. Neither edge is a lost balance, and both look like a " +
      "honeypot to whoever hits them first.",
  },
  {
    title: "This is the curve launch, not the launchpad one",
    body: "deploy/README.md and LAUNCH.md 4 describe deploying SnoozeLaunchpad and calling " +
      "launch(), which deploys Snooze and PooledLaunchBuy together. That path needs a venue " +
      "answering 0x1930789c, and LAUNCH.md 2.2 records that nothing on Base does. This is the " +
      "other path: the curve is its own venue. The two runbooks diverge and neither is wrong.",
  },
];

/// Resolve "5", "curve" or "5.fund" to {step, txKey}.
export function pickStep(steps, spec) {
  const [head, txKey] = String(spec ?? "").split(".");
  const step = steps.find(s => String(s.n) === head || s.id === head);
  if (!step) throw new Error(`no such step: "${spec}". Try one of: ` +
    steps.map(s => `${s.n} (${s.id})`).join(", "));
  if (txKey && !step.txs.some(t => t.key === txKey))
    throw new Error(`step ${step.n} has no transaction "${txKey}". It has: ` +
      (step.txs.map(t => t.key).join(", ") || "none — it sends nothing"));
  return { step, txKey: txKey || null };
}
