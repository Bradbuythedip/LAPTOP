// The deployment sequence in deploy/scripts, driven end to end, plus the local page that
// drives the same bytes from a wallet.
//
// WHY THIS SUITE IS AN EXECUTION AND NOT A GREP. The first draft of the sequence was checked by
// encoding calldata with deploy/scripts/lib/abi.mjs and decoding it with the same file, which
// is self-consistent and worth nothing. Every real finding below came from actually sending the
// steps into an EVM:
//
//   · Snooze deployed through SnoozeDeployer mints the ENTIRE SUPPLY to the deployer contract
//     and makes that contract the admin. Both are permanent, both are invisible to an encoder
//     test, and either one alone kills the launch. That is why the sequence deploys the token
//     from the owner's wallet and gives the ground address to the curve, and it is measured
//     below rather than asserted in a comment.
//   · Both Snooze rules fire on ONE condition, isPool[to] && !capExempt[from], so a launch that
//     never calls setPool has neither rule — no haircut, no daily cap — however the oracle is
//     configured.
//   · Funding the curve after setPool instead of before does not revert cleanly; it burns.
//
// It also holds the two invariants that keep deploy/deploy.html out of web/, and the equality
// between the page's own encoder and the scripts' — two implementations of an encoder is a
// risk, two with an equality check between them is a check.
//   node test/run-deploy.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, deploy, call, fund, balance } from "./evm.mjs";
import { createEVM } from "@ethereumjs/evm";
import { createAddressFromString } from "@ethereumjs/util";

import * as ABI from "../deploy/scripts/lib/abi.mjs";
import { loadConfig, oracleDecision, VANITY_TARGETS, ORACLE_CHOICES } from "../deploy/scripts/lib/config.mjs";
import { artifacts as compileArtifacts, SETTER_SELECTOR, DEPLOYABLE } from "../deploy/scripts/lib/solc.mjs";
import { buildSteps, curveInitCode, curveInitCodeHash, snoozeArgs, pickStep, AFTER_THE_SEQUENCE }
  from "../deploy/scripts/lib/steps.mjs";
import { inspectOracle, stripMetadata, NEVER_READY_MEANS } from "../deploy/scripts/lib/oracle.mjs";
import { loadState, markVerified } from "../deploy/scripts/lib/state.mjs";
import { redact, CHAINS } from "../deploy/scripts/lib/rpc.mjs";

let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { if (c) { pass++; results.push("  ok   " + n); }
  else { fail++; results.push("  FAIL " + n + (x ? "\n         " + x : "")); } };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const E = 10n ** 18n;
const w = v => (typeof v === "string" && v.startsWith("0x") ? v.slice(2)
                : BigInt(v).toString(16)).padStart(64, "0");

/* ─────────────────────────────────────────────────────────── the page is not, and cannot be,
   part of the site ───────────────────────────────────────────────────────────────────────── */
console.log("── the deploy button is not a page of the site, and could not be");
{
  ok("deploy/deploy.html exists", fs.existsSync(path.join(ROOT, "deploy", "deploy.html")));
  ok("and it is NOT inside web/", !fs.existsSync(path.join(ROOT, "web", "deploy.html")),
     "a page that signs, served from the origin whose whole clone defence is that it never asks " +
     "you to sign, deletes that defence for every other page at once");
  const inWeb = fs.readdirSync(path.join(ROOT, "web"))
    .filter(f => /deploy|artifacts/i.test(f));
  ok("web/ holds nothing named after the deployer either", inWeb.length === 0, inWeb.join(", "));

  // The reason it had to go outside, stated as a fact rather than a claim. If this ever stops
  // being true the page has stopped being a deploy page, and the exile stops being justified.
  const SIGNING = /eth_sendTransaction|eth_sendRawTransaction|personal_sign|eth_signTypedData|signTransaction|signMessage|signAndSendTransaction/;
  const page = R("deploy/deploy.html");
  ok("it really does contain a signing method, which is why it is exiled",
     SIGNING.test(page), "if it cannot sign it is not a deploy button");
  ok("and it names the rule it would have broken",
     /clone defence|never asks you to sign|no signing or sending method/i.test(page));

  // vercel.json is the line that actually keeps deploy/ off snoozebear.xyz. The exile is only
  // worth anything while it holds, and nothing else in the repo pins it.
  const vercel = JSON.parse(R("vercel.json"));
  ok("vercel.json publishes web/ and therefore not deploy/",
     vercel.outputDirectory === "web", JSON.stringify(vercel.outputDirectory));

  // No endpoint in the page at all: every read goes through the wallet's provider.
  // Localhost is how you are told to open it, and a loopback address is not a credential.
  // Anything else is: a page that "reads back with eth_call" is the obvious place somebody
  // pastes a keyed endpoint, into a file that is committed and world-readable.
  const urls = (page.match(/https?:\/\/[^\s"'<>)]+/g) || [])
    .filter(u => !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(u));
  ok("the page reaches no host but your own wallet", urls.length === 0, urls.join(", "));
  ok("no key material anywhere in it", !/privateKey|mnemonic|seedPhrase/i.test(page));

  // The pages of the site must not learn about it either, or a visitor arrives at a signing
  // page from an origin that promises it never signs.
  const leaks = fs.readdirSync(path.join(ROOT, "web"))
    .filter(f => f.endsWith(".html"))
    .filter(f => /deploy\.html|artifacts\.js/.test(R("web/" + f)));
  ok("no page of the site links to it", leaks.length === 0, leaks.join(", "));
}

/* ─────────────────────────────────────────────────────── the scripts hold no key, and cannot
   send ──────────────────────────────────────────────────────────────────────────────────── */
console.log("── the scripts build and read; they cannot sign, send, or hold a key");
{
  const dir = path.join(ROOT, "deploy", "scripts");
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true }))
      f.isDirectory() ? walk(path.join(d, f.name))
                      : f.name.endsWith(".mjs") && files.push(path.join(d, f.name));
  })(dir);
  ok("there are scripts to check", files.length >= 8, String(files.length));
  const src = files.map(f => fs.readFileSync(f, "utf8")).join("\n");

  // Built from fragments so the pattern does not match the line that defines it — the same
  // self-match that made the delegatecall check in run-pooled.mjs pass while meaning nothing.
  const secret = new RegExp(["priv", "ate", "Key"].join("") + "|" + ["mnem", "onic"].join("") +
                            "|" + ["seed", "Phrase"].join("") + "|PRIVATE_KEY|MNEMONIC", "i");
  ok("no key material in any of them", !secret.test(src));
  ok("the pattern is not matching itself", !secret.test("this line has no key material"));
  ok("but it does match the thing it is looking for", secret.test("const privateKey = 1"));

  // Scoped to the scripts, deliberately: deploy/deploy.html calls eth_sendTransaction because
  // that is its entire job, so a recursive grep over deploy/ would fail on the file it is
  // meant to permit.
  const SEND = /eth_sendTransaction|eth_sendRawTransaction|signTransaction|personal_sign|eth_signTypedData/;
  const offenders = files.filter(f => {
    const t = fs.readFileSync(f, "utf8");
    // The comments in lib/rpc.mjs list the methods it refuses, which is not the same as using
    // one. Only a mention outside a comment counts.
    const code = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return SEND.test(code);
  });
  ok("none of them names a sending or signing method outside a comment",
     offenders.length === 0, offenders.map(f => path.relative(ROOT, f)).join(", "));

  ok("no signing library is a dependency",
     !/"(ethers|web3|viem|@ethersproject\/[\w-]+)"\s*:/.test(R("package.json")));

  // A keyed endpoint must reach these scripts only through the environment. A committed one is
  // published to everyone who can read the repository; one on the command line is published to
  // every process on the machine, via /proc/<pid>/cmdline and the shell's history.
  ok("the endpoint comes from the environment, never a file", /process\.env\.SNOOZE_RPC/.test(src));
  ok("and there is no --rpc flag to leak it into a process list", !/"--rpc"/.test(src));
  ok("the endpoint is redacted before it can reach an error message",
     redact("https://base-mainnet.example.com/v2/SECRETKEY") === "https://base-mainnet.example.com/…",
     redact("https://base-mainnet.example.com/v2/SECRETKEY"));
  for (const f of ["config.json", "artifacts.json", "artifacts.js"]) {
    const t = R("deploy/" + f);
    ok(`deploy/${f} carries no endpoint`, !/https?:\/\//.test(t.replace(/"_[^"]*":\s*(\[[^\]]*\]|"[^"]*")/g, "")),
       "a keyed URL in a committed file is a bearer credential handed to every reader");
  }
}

/* ─────────────────────────────────────────────────────────────── config refuses before gas ── */
console.log("── deploy/config.json is checked against the constructors it feeds");
const CFG = loadConfig();
{
  ok("the committed config has no problems", CFG.problems.length === 0, CFG.problems.join("; "));
  ok("chainId is one this sequence knows", !!CHAINS[CFG.chainId], String(CFG.chainId));
  ok("the owner is EIP-55 checksummed", ABI.toChecksum(CFG.owner) === CFG.owner);
  ok("feeTo is the owner", ABI.sameAddress(CFG.curve.feeTo, CFG.owner));
  ok("feeBps is inside MAX_FEE_BPS", CFG.curve.feeBps <= 500, String(CFG.curve.feeBps));
  ok("devBps is inside the constructor's cap", CFG.token.devBps <= 2000);
  ok("the curve cannot be told to sell more than exists",
     CFG.curve.curveSupply <= CFG.token.supply);
  ok("the gate is both halves or neither",
     (CFG.curve.gateToken === ABI.ZERO) === (CFG.curve.gateMin === 0n));

  // The one decision with no default. Nothing downstream may be built while it is blank.
  const blank = oracleDecision({ ...CFG, oracle: { ...CFG.oracle, choice: "" } });
  ok("an unchosen oracle refuses, rather than defaulting", !blank.ok);
  ok("and the refusal names every choice it will take",
     ORACLE_CHOICES.every(c => blank.reason.includes(c)), blank.reason.split("\n")[0]);
  ok("a choice that is not one of them refuses",
     !oracleDecision({ ...CFG, oracle: { ...CFG.oracle, choice: "whatever",
                                         address: CFG.owner } }).ok);
  ok("a chosen oracle with no address refuses",
     !oracleDecision({ ...CFG, oracle: { ...CFG.oracle, choice: "observational",
                                         address: "" } }).ok);
  ok("the zero address is not an oracle",
     !oracleDecision({ ...CFG, oracle: { ...CFG.oracle, choice: "observational",
                                         address: ABI.ZERO } }).ok);
  ok("a real choice with a real address proceeds",
     oracleDecision({ ...CFG, oracle: { ...CFG.oracle, choice: "observational",
                                        address: CFG.owner } }).ok);
  ok('"never-ready" is a choice, and it says Rule 1 never fires',
     oracleDecision({ ...CFG, oracle: { ...CFG.oracle, choice: "never-ready",
                                        address: CFG.owner } }).ruleOneEverFires === false);
  ok("and that sentence names the token you would actually have",
     /ordinary ERC-20/.test(NEVER_READY_MEANS) && /never fires/.test(NEVER_READY_MEANS));

  // The vanity target, and the one it refuses. See the EVM section for the measurement.
  ok('vanity.target "token" is refused outright', !!VANITY_TARGETS.token.refuse);
  ok("and the refusal explains what would happen, not just that it is refused",
     /balanceOf\[msg\.sender\]/.test(VANITY_TARGETS.token.refuse) &&
     /setPool/.test(VANITY_TARGETS.token.refuse));
  ok('vanity.target "curve" is allowed', !VANITY_TARGETS.curve.refuse);
  const HEX = new Set("0123456789abcdef");
  ok("the configured suffix is hex, so it can exist in an address",
     [...CFG.vanity.suffix].every(ch => HEX.has(ch)), CFG.vanity.suffix);
  for (const word of ["pump", "bear", "moon", "zzz"])
    ok(`"${word}" still contains a letter no address has`,
       [...word].some(ch => !HEX.has(ch)));
}

/* ──────────────────────────────────────────────────────────────────── the encoders agree ── */
console.log("── the page and the scripts encode the same bytes");
const PAGE = (() => {
  // Pulled out of the page and evaluated with no DOM and no window, which is possible only
  // because that block is pure. It is the block that decides what bytes go out, so it is the
  // block worth comparing against the scripts.
  const html = R("deploy/deploy.html");
  const block = (html.match(/<script id="calldata">([\s\S]*?)<\/script>/) || [])[1];
  if (!block) return null;
  const fn = new Function(block + "\nreturn SNOOZE;");
  return fn();
})();
{
  ok("the page has a pure calldata block that runs outside a browser", !!PAGE);
  if (PAGE) {
    let wrong = [];
    for (const [sig, sel] of Object.entries(PAGE.SEL))
      if (ABI.selector(sig) !== sel) wrong.push(`${sig}: page ${sel}, keccak ${ABI.selector(sig)}`);
    ok(`all ${Object.keys(PAGE.SEL).length} selectors the page hardcodes are keccak of their ` +
       "signature", wrong.length === 0, wrong.join("\n         "));
    ok("the page knows the settable mock's setter selector",
       PAGE.SETTER === SETTER_SELECTOR, `${PAGE.SETTER} vs ${SETTER_SELECTOR}`);
    ok("and that selector really is set(uint256,uint256,bool)",
       "0x" + SETTER_SELECTOR === ABI.selector("set(uint256,uint256,bool)"));
    // A width check rather than a pad. A 39-character address is the classic way to encode a
    // constructor argument that is silently somebody else.
    let threw = false;
    try { PAGE.addressWord("0x4296e9A65582358221EEd0e9A2B4EC94ad4F592"); } catch { threw = true; }
    ok("the page refuses a 39-character address rather than padding it", threw);
    threw = false;
    try { PAGE.uintWord("18446744073709551616", 64); } catch { threw = true; }
    ok("and refuses a uint64 that does not fit", threw);
  }
}

/* ────────────────────────────────────────────────────── the artifacts are what compiles now ─ */
console.log("── the committed artifacts are the bytes the contracts compile to today");
const { artifacts: ART, warnings } = compileArtifacts();
{
  ok("the deployment set compiles with no warnings", warnings.length === 0,
     warnings.map(x => x.message.split("\n")[0]).join("; "));
  ok("SnoozeGate is not in the deployment set", !DEPLOYABLE.includes("SnoozeGate"),
     "its constructor wants a Merkle root over a snapshot that has not been taken");
  const onDisk = JSON.parse(R("deploy/artifacts.json"));
  ok("deploy/artifacts.json records the compiler settings beside the bytes",
     onDisk.solc.version === "0.8.36" && onDisk.solc.runs === 200,
     JSON.stringify(onDisk.solc));
  for (const n of DEPLOYABLE)
    ok(`deploy/artifacts.json holds today's ${n}`,
       onDisk.contracts[n]?.initCode === ART.contracts[n].initCode,
       "stale — run node deploy/scripts/artifacts.mjs. Every ground address moves with it.");
  // Two generators write bytecode into deploy/: test/run-deployable.mjs writes the .bin files
  // and deploy/scripts/artifacts.mjs writes artifacts.json. They must not disagree, because a
  // CREATE2 address is derived from bytecode and only one of them can be right.
  ok("and it agrees with deploy/Snooze.bin, which a different generator wrote",
     R("deploy/Snooze.bin").trim() === ART.contracts.Snooze.initCode,
     "the two generators in deploy/ have drifted");
  const js = R("deploy/artifacts.js");
  ok("deploy/artifacts.js is the browser twin of the same object",
     js.includes(ART.contracts.SnoozeCurve.initCode));
  ok("and it carries the launch parameters, since a file:// page cannot read config.json",
     /"launch":/.test(js));
  ok("it is a classic script, not a module, so file:// can load it",
     /window\.__SNOOZE = /.test(js));
  ok("the page loads it that way", /<script src="artifacts\.js"><\/script>/.test(R("deploy/deploy.html")));
}

/* ────────────────────────────────────────────────── what the oracle guard can and cannot see ─ */
console.log("── the oracle guard, and the difference between refusing and reassuring");
{
  const all = compile(["contracts/test/SnoozeMocks.sol"]).all;
  const mockRuntime = "0x" + all.MockOracle.evm.deployedBytecode.object.replace(/^0x/, "");
  const good = { "ready()": { ok: true, data: "0x" + w(0) },
                 "spot()": { ok: true, data: "0x" + w(1000) },
                 "twap24()": { ok: true, data: "0x" + w(1000) } };

  const mock = inspectOracle({ code: mockRuntime, results: good, refuse: ART.refuse,
                               choice: "observational" });
  ok("the settable mock is refused", mock.some(c => !c.ok),
     "MockOracle answers all three views without reverting and is ready:false before anybody " +
     "calls set(), so every naive check passes it — this is the one it has to catch");
  ok("and it is refused by name", mock.some(c => !c.ok && /MockOracle/.test(c.name)));
  ok("and by its setter, which survives a recompile the hash does not",
     mock.some(c => !c.ok && /set\(uint256,uint256,bool\)/.test(c.name)));

  // The same mock with a different metadata tail: a rebuild anywhere else. The hash comparison
  // is defeated, the selector is not.
  const rebuilt = mockRuntime.slice(0, -6) + "beefaa";
  const reb = inspectOracle({ code: rebuilt, results: good, refuse: ART.refuse,
                              choice: "observational" });
  ok("a rebuilt mock with a different metadata tail is still refused",
     reb.some(c => !c.ok && /set\(uint256,uint256,bool\)/.test(c.name)));
  ok("stripMetadata takes the CBOR tail off", stripMetadata(mockRuntime).length < mockRuntime.length);
  ok("and leaves a runtime whose tail does not parse alone",
     stripMetadata("0xdeadbeef") === "deadbeef");

  // An oracle that reverts. LAUNCH.md 2.1: ready() runs inside every sell, so sells revert
  // while buys work — the textbook honeypot, at an address that can never be changed.
  const reverting = inspectOracle({
    code: "0x60006000fd", refuse: ART.refuse, choice: "observational",
    results: { "ready()": { ok: false, error: "execution reverted" },
               "spot()": { ok: false, error: "execution reverted" },
               "twap24()": { ok: false, error: "execution reverted" } } });
  ok("a reverting oracle is refused", reverting.some(c => !c.ok));
  ok("and the refusal says why it is a honeypot rather than a bug",
     reverting.some(c => !c.ok && /honeypot/.test(c.detail)));

  // Nothing there at all. Every call to an address with no code succeeds and returns empty, so
  // this is the shape that reads most like success.
  const nothing = inspectOracle({ code: "0x", refuse: ART.refuse, choice: "observational",
                                  results: { "ready()": { ok: true, data: "0x" },
                                             "spot()": { ok: true, data: "0x" },
                                             "twap24()": { ok: true, data: "0x" } } });
  ok("an address with no code is refused", nothing.some(c => !c.ok));

  // Ready with no history behind it. Unconditional for BOTH choices: the first version
  // exempted "never-ready" from this check, which switched it off for the one choice whose
  // entire definition is that ready() is false.
  const ready = { ...good, "ready()": { ok: true, data: "0x" + w(1) } };
  for (const choice of ORACLE_CHOICES) {
    const r = inspectOracle({ code: "0x6001", results: ready, refuse: {}, choice });
    ok(`ready() true with no history is refused for "${choice}"`, r.some(c => !c.ok));
  }
  const fresh = inspectOracle({ code: "0x6001", results: good, refuse: {},
                                choice: "observational" });
  ok("a plausible fresh oracle passes", fresh.every(c => c.ok),
     fresh.filter(c => !c.ok).map(c => c.name).join("; "));

  // The claim the guard is careful NOT to make. Ownerlessness is not decidable from bytecode:
  // an owner check is a comparison like any other. A green tick that implied otherwise would be
  // worse than no check.
  ok("the guard never claims the oracle is ownerless",
     !fresh.some(c => /ownerless|no owner|not settable/i.test(c.name)),
     "bytecode cannot show the absence of every setter, only of the one it looked for");
}

/* ───────────────────────────────────────────────────────── the sequence, actually executed ── */
console.log("── the sequence, sent into an EVM step by step");
const { all } = compile(["contracts/SnoozeDeployer.sol", "contracts/Snooze.sol",
                         "contracts/SnoozeCurve.sol", "contracts/test/SnoozeMocks.sol"]);
const OWNER = CFG.owner.toLowerCase();
const STRANGER = "0x00000000000000000000000000000000deadbeef";
const BUYER = "0x00000000000000000000000000000000000000b1";
const evm = await createEVM();
await fund(evm, OWNER, 1000n * E);
await fund(evm, STRANGER, 1000n * E);
await fund(evm, BUYER, 1000n * E);

/// Send one of the sequence's own built transactions into the EVM. This is the point of the
/// suite: the bytes under test are the bytes build.mjs prints and deploy.html sends.
async function sendBuilt(built, from) {
  if (built.to === null)
    return deploy(built.data, "", { evm, from: from || built.from || OWNER });
  return call({ evm, address: createAddressFromString(built.to) },
              "unused()", [], { from: from || built.from || OWNER,
                                raw: built.data.slice(10), timestamp: 2000 })
    .then(r => r);
}
/// call() prefixes a selector from the signature, which is wrong for pre-encoded calldata. The
/// harness has no raw-data door, so this is the smallest one: run the EVM directly.
async function raw(to, data, from, value = 0n, timestamp = 2000) {
  const r = await evm.runCall({
    caller: createAddressFromString(from), to: createAddressFromString(to),
    gasLimit: 30_000_000n, data: ABI.bytes(data), value,
    block: { header: { number: 1n, timestamp: BigInt(timestamp) } },
  });
  return { ok: !r.execResult.exceptionError,
           err: r.execResult.exceptionError?.error,
           raw: "0x" + ABI.hex(r.execResult.returnValue) };
}

// A stand-in oracle: the mock, used HERE and only here, because a suite needs an oracle and the
// repo has exactly one. Everything above exists to make sure this particular contract never
// reaches Base.
const orc = await deploy(all.MockOracle.evm.bytecode.object, "", { evm });
const ORACLE = orc.address.toString();

let state = { chainId: CFG.chainId, owner: CFG.owner, steps: {} };
const cfg = { ...CFG, oracle: { ...CFG.oracle, choice: "observational", address: ORACLE } };
const stepsNow = () => buildSteps({ cfg, artifacts: ART, state });

{
  const s = stepsNow();
  ok("step 1 cannot be verified while the oracle is unchosen",
     !!buildSteps({ cfg: CFG, artifacts: ART, state }).find(x => x.id === "oracle").blocked());
  ok("and every later step is blocked behind it",
     buildSteps({ cfg: CFG, artifacts: ART, state })
       .filter(x => x.n >= 3).every(x => !!x.blocked()));
  ok("with an oracle chosen but not yet read back, step 2 is ready and step 3 is not",
     !s.find(x => x.id === "deployer").blocked() && !!s.find(x => x.id === "token").blocked(),
     "a chosen oracle is a line in a config file; a verified one answered three calls");

  // Step 1 records rather than deploys: there is deliberately no button that puts an oracle on
  // chain, because the only implementation here is the settable mock.
  ok("step 1 sends no transaction at all", s[0].txs.length === 0,
     "a convenient button for the mock is exactly how it would reach Base 'temporarily'");
  markVerified(state, "oracle", { address: ORACLE, choice: "observational" });
}

/* ---- 2. the deployer ---- */
let DEPLOYER;
{
  const step = stepsNow().find(x => x.id === "deployer");
  const built = step.txs[0].build();
  ok("step 2 needs no confirmation phrase, because nothing about it is irreversible for you",
     step.confirm === null);
  ok("its calldata is the deployer's init code plus the owner word",
     built.data === ART.contracts.SnoozeDeployer.initCode + w(OWNER),
     built.data.slice(-64));

  // Sent by a STRANGER on purpose: the owner is the constructor argument, not the sender, and
  // LAUNCH.md 2b says so. If that stops being true the deployer has become transferable.
  const r = await deploy(built.data, "", { evm, from: STRANGER });
  DEPLOYER = r.address.toString();
  const owner = await raw(DEPLOYER, ABI.selector("owner()"), STRANGER);
  ok("anybody can send it, and the owner is still the configured address",
     ABI.sameAddress(ABI.readAddress(owner.raw), CFG.owner), owner.raw);
  markVerified(state, "deployer", { address: DEPLOYER });
}

/* ---- 3. the token, and the reason it is not deployed through the deployer ---- */
let TOKEN;
{
  const step = stepsNow().find(x => x.id === "token");
  ok("step 3 demands a phrase that names what becomes immutable",
     /oracle/.test(step.confirm) && /devBps/.test(step.confirm), step.confirm);
  ok("and its note explains why it is not sent through the deployer",
     /admin = msg\.sender/.test(step.note()) && /setPool/.test(step.note()));

  const built = step.txs[0].build();
  ok("its calldata is Snooze's init code plus (supply, oracle, dev, devBps)",
     built.data === ART.contracts.Snooze.initCode + snoozeArgs(cfg, ORACLE));
  ok("and it must be sent by the owner", ABI.sameAddress(built.from, CFG.owner));

  const r = await deploy(built.data, "", { evm, from: OWNER });
  TOKEN = r.address.toString();
  const rd = async sig => (await raw(TOKEN, ABI.selector(sig), OWNER)).raw;
  ok("name() is Snooze Bear", ABI.readString(await rd("name()")) === CFG.token.name);
  ok("symbol() is SNOOZE", ABI.readString(await rd("symbol()")) === CFG.token.symbol);
  ok("totalSupply() is the configured supply",
     ABI.readUint(await rd("totalSupply()")) === CFG.token.supply);
  ok("oracle() is exactly the recorded oracle",
     ABI.sameAddress(ABI.readAddress(await rd("oracle()")), ORACLE));
  ok("devBps() is the configured devBps",
     ABI.readUint(await rd("devBps()")) === BigInt(CFG.token.devBps));
  ok("supplyOnlyFalls() agrees with devBps",
     ABI.readBool(await rd("supplyOnlyFalls()")) === (CFG.token.devBps === 0));
  // The two that decide whether the launch is possible at all.
  ok("admin() is the OWNER's wallet, so setPool can be called in step 5",
     ABI.sameAddress(ABI.readAddress(await rd("admin()")), CFG.owner));
  const bal = await raw(TOKEN, ABI.selector("balanceOf(address)") + w(OWNER), OWNER);
  ok("and the whole supply is in the owner's hands, which is what funds the curve",
     ABI.readUint(bal.raw) === CFG.token.supply);
  markVerified(state, "token", { address: TOKEN });
}

/* ---- the measurement that decides the shape of the whole sequence ---- */
console.log("── what deploying Snooze THROUGH the deployer actually does");
{
  // Not a hypothetical, and not a comment. This is the version LAUNCH.md 4 and the obvious
  // reading of "put the first token where it was promised to be" both describe, executed.
  const evm2 = await createEVM();
  await fund(evm2, OWNER, 100n * E);
  const dep = await deploy(all.SnoozeDeployer.evm.bytecode.object, w(OWNER), { evm: evm2, from: OWNER });
  const orc2 = await deploy(all.MockOracle.evm.bytecode.object, "", { evm: evm2 });
  const init = all.Snooze.evm.bytecode.object +
    w(CFG.token.supply) + w(orc2.address.toString()) + w(CFG.token.dev) + w(CFG.token.devBps);
  const salt = "0x" + "00".repeat(31) + "01";
  const D = { evm: evm2, address: dep.address };
  const r = await call(D, "deploy(bytes32,bytes)", [], { from: OWNER,
    raw: salt.slice(2) + w(0x40) + w(init.length / 2) + init +
         "0".repeat((64 - (init.length % 64)) % 64) });
  ok("it does deploy — which is the trap, because nothing reverts", r.ok, r.revert);
  const tokAddr = "0x" + (r.words[0] || 0n).toString(16).padStart(40, "0");
  const T2 = { evm: evm2, address: createAddressFromString(tokAddr) };
  const admin = await call(T2, "admin()", []);
  ok("but admin() is the SnoozeDeployer contract, not your wallet",
     "0x" + admin.words[0].toString(16).padStart(40, "0") === dep.address.toString());
  const bOwner = await call(T2, "balanceOf(address)", [OWNER]);
  const bDep = await call(T2, "balanceOf(address)", [dep.address.toString()]);
  ok("the owner holds none of the supply", bOwner.words[0] === 0n, String(bOwner.words[0]));
  ok("the deployer contract holds ALL of it", bDep.words[0] === CFG.token.supply,
     String(bDep.words[0]));
  const abi = all.SnoozeDeployer.abi.filter(f => f.type === "function").map(f => f.name);
  ok("and that contract has no transfer, approve, rescue or arbitrary call",
     !abi.some(n => /transfer|approve|rescue|sweep|withdraw|execute|call/i.test(n)),
     abi.join(", "));
  ok("so the supply is unrecoverable by anybody, forever", true);
  const sp = await call(T2, "setPool(address,bool)", [tokAddr, 1], { from: OWNER });
  ok("the owner cannot register a pool either — setPool reverts NotAdmin", !sp.ok);
  const fundTx = await call(T2, "transfer(address,uint256)", [tokAddr, CFG.curve.curveSupply],
                            { from: OWNER });
  ok("and the funding transfer the next step needs reverts on a zero balance", !fundTx.ok);
  ok("which is why vanity.target is the curve and the token comes from your wallet",
     VANITY_TARGETS.curve.contract === "SnoozeCurve" && !!VANITY_TARGETS.token.refuse);
}

/* ---- 4. the salt, which could not have been ground earlier ---- */
console.log("── the sequence, continued");
let SALT, PREDICTED;
{
  const initCode = curveInitCode(ART, cfg, TOKEN);
  const initHash = curveInitCodeHash(ART, cfg, TOKEN);
  ok("the curve's init code contains the token's address, so the grind had to wait for step 3",
     initCode.toLowerCase().includes(TOKEN.slice(2).toLowerCase()));

  // A SHORT suffix, ground here rather than the configured five characters: …ba5ed is about a
  // million keccaks, which is ten seconds of a core and not something a test suite should
  // spend. Two characters is about 256 tries and exercises the same machinery — the search,
  // the derivation and the suffix check are the same code at any length. grind.mjs does the
  // real one, and re-derives the address independently before it will record it.
  cfg.vanity = { ...cfg.vanity, suffix: "ed" };
  for (let i = 1; i < 200000; i++) {
    const trial = "0x" + i.toString(16).padStart(64, "0");
    const at = ABI.create2Address(DEPLOYER, trial, initHash);
    if (at.toLowerCase().endsWith(cfg.vanity.suffix)) { SALT = trial; PREDICTED = at; break; }
  }
  ok(`a salt was found for …${cfg.vanity.suffix}`, !!SALT, "the grinder machinery found nothing");
  const onChain = await raw(DEPLOYER, ABI.selector("addressOf(bytes32,bytes32)") +
                            SALT.slice(2) + initHash.slice(2), OWNER);
  ok("addressOf on chain agrees with keccak(0xff, deployer, salt, initCodeHash) computed here",
     ABI.sameAddress(ABI.readAddress(onChain.raw), PREDICTED),
     `${ABI.readAddress(onChain.raw)} vs ${PREDICTED}`);
  markVerified(state, "salt",
    { salt: SALT, initCodeHash: initHash, predicted: PREDICTED, deployer: DEPLOYER, token: TOKEN });

  const step = stepsNow().find(x => x.id === "salt");
  ok("the recorded salt verifies offline", step.verify.check({}, {}).every(c => c.ok),
     step.verify.check({}, {}).filter(c => !c.ok).map(c => c.name).join("; "));

  // The failure the offline check exists for: a parameter changed after the grind, so the
  // address the salt was ground for is not the address the deployment will land on.
  const drifted = { ...state, steps: { ...state.steps,
    salt: { ...state.steps.salt,
            readBack: { ...state.steps.salt.readBack, initCodeHash: "0x" + "11".repeat(32) } } } };
  const bad = buildSteps({ cfg, artifacts: ART, state: drifted })
    .find(x => x.id === "salt").verify.check({}, {});
  ok("and a salt ground against different bytes is caught before anything is sent",
     bad.some(c => !c.ok), "the address would silently be a different one");
}

/* ---- 5. the curve ---- */
let CURVE;
{
  const step = stepsNow().find(x => x.id === "curve");
  ok("step 5 demands a phrase naming the immutable parameters",
     /immutable/.test(step.confirm) && /fee address/.test(step.confirm), step.confirm);
  ok("and its irreversible list discloses that bond() is a race",
     step.irreversible.some(t => /bond\(\) IS PERMISSIONLESS/.test(t)));

  const dep = step.txs.find(t => t.key === "deploy").build();
  ok("the deploy transaction goes to the deployer and only the owner may send it",
     ABI.sameAddress(dep.to, DEPLOYER) && ABI.sameAddress(dep.from, CFG.owner));
  ok("a stranger cannot send it — SnoozeDeployer.deploy reverts NotOwner",
     !(await raw(DEPLOYER, dep.data, STRANGER)).ok);

  const r = await raw(DEPLOYER, dep.data, OWNER);
  ok("the owner can", r.ok, r.err);
  CURVE = ABI.readAddress(r.raw);
  ok("and the curve landed exactly where addressOf promised before it existed",
     ABI.sameAddress(CURVE, PREDICTED), `${CURVE} vs ${PREDICTED}`);
  state.steps.curve = { status: "sent", readBack: { address: CURVE } };

  // The precondition that encodes the ordering. Funding must come first: once isPool[curve] is
  // true, a transfer into the curve is a sell.
  const reg = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "register");
  const before = reg.precondition.check({ "token.balanceOf(curve)": { ok: true, data: "0x" + w(0) } });
  ok("setPool is refused while the curve is empty", before.some(c => !c.ok));
  ok("and the refusal says what would happen instead of just refusing",
     before.some(c => !c.ok && /burns/.test(c.detail)));

  const fundTx = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "fund").build();
  const fr = await raw(TOKEN, fundTx.data, OWNER);
  ok("funding the curve goes through", fr.ok, fr.err);
  const held = await raw(TOKEN, ABI.selector("balanceOf(address)") + w(CURVE), OWNER);
  ok("and it holds every token it is allowed to sell, intact",
     ABI.readUint(held.raw) === CFG.curve.curveSupply, String(ABI.readUint(held.raw)));

  const after = reg.precondition.check({ "token.balanceOf(curve)": { ok: true, data: held.raw } });
  ok("now setPool is allowed", after.every(c => c.ok));

  const regTx = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "register").build();
  const rr = await raw(TOKEN, regTx.data, OWNER);
  ok("registering the curve as the pool goes through", rr.ok, rr.err);
  const isPool = await raw(TOKEN, ABI.selector("isPool(address)") + w(CURVE), OWNER);
  const exempt = await raw(TOKEN, ABI.selector("capExempt(address)") + w(CURVE), OWNER);
  ok("isPool(curve) is true, which is what switches BOTH rules on", ABI.readBool(isPool.raw));
  ok("capExempt(curve) is true, so the curve can pay buyers out", ABI.readBool(exempt.raw));

  const rd = async sig => (await raw(CURVE, ABI.selector(sig), OWNER)).raw;
  ok("feeTo() is the owner", ABI.sameAddress(ABI.readAddress(await rd("feeTo()")), CFG.owner));
  ok("virtualEth() is the configured virtual reserve",
     ABI.readUint(await rd("virtualEth()")) === CFG.curve.virtualEth);
  ok("bondTarget() is the configured target",
     ABI.readUint(await rd("bondTarget()")) === CFG.curve.bondTarget);
  ok("token() is the token", ABI.sameAddress(ABI.readAddress(await rd("token()")), TOKEN));
  ok("sold() is zero — nothing has traded", ABI.readUint(await rd("sold()")) === 0n);
  markVerified(state, "curve", { address: CURVE });
}

/* ---- what the wrong order would have done ---- */
console.log("── funding after setPool, which is the order that does not revert cleanly");
{
  // The reason the precondition is a chain read and not a comment. This is the same sequence
  // with two transactions swapped, and the failure is silent: the transfer returns true.
  const evm3 = await createEVM();
  await fund(evm3, OWNER, 100n * E);
  const orc3 = await deploy(all.MockOracle.evm.bytecode.object, "", { evm: evm3 });
  await call({ evm: evm3, address: orc3.address }, "set(uint256,uint256,bool)", [2n * E, E, 1]);
  const SUP = 1000n * E, FLOAT = 800n * E;
  const t = await deploy(all.Snooze.evm.bytecode.object,
    w(SUP) + w(orc3.address.toString()) + w(CFG.token.dev) + w(0), { evm: evm3, from: OWNER });
  const T3 = { evm: evm3, address: t.address };
  const c = await deploy(all.SnoozeCurve.evm.bytecode.object,
    [t.address.toString(), 3n * E, FLOAT, 6n * E, 100, OWNER, ABI.ZERO, 0, 0].map(w).join(""),
    { evm: evm3, timestamp: 1000, from: OWNER });
  await call(T3, "setPool(address,bool)", [c.address.toString(), 1], { from: OWNER });
  const whole = await call(T3, "transfer(address,uint256)", [c.address.toString(), FLOAT],
                           { from: OWNER, timestamp: 2000 });
  ok("sending the whole float after setPool reverts on the daily cap", !whole.ok);
  const capped = await call(T3, "transfer(address,uint256)",
                            [c.address.toString(), SUP / 5n], { from: OWNER, timestamp: 2000 });
  ok("but retrying at the cap SUCCEEDS, which is the dangerous part", capped.ok, capped.revert);
  const got = await call(T3, "balanceOf(address)", [c.address.toString()]);
  ok("and the curve receives less than was sent, because Rule 1 burned the rest",
     got.words[0] < SUP / 5n, `${got.words[0]} of ${SUP / 5n}`);
  const burned = await call(T3, "totalBurned()", []);
  ok("the difference is gone, not delayed", burned.words[0] > 0n, String(burned.words[0]));
}

/* ---- 6. the locks ---- */
console.log("── the sequence, finished");
{
  const step = stepsNow().find(x => x.id === "lock");
  ok("step 6 demands a phrase naming that it cannot be undone",
     /cannot be undone/.test(step.confirm), step.confirm);
  const fz = step.txs.find(t => t.key === "freeze").build();
  const sl = step.txs.find(t => t.key === "seal").build();
  ok("freeze goes to the token, seal goes to the deployer",
     ABI.sameAddress(fz.to, TOKEN) && ABI.sameAddress(sl.to, DEPLOYER));

  ok("freeze() goes through", (await raw(TOKEN, fz.data, OWNER)).ok);
  ok("and afterwards even the admin cannot register another pool",
     !(await raw(TOKEN, ABI.selector("setPool(address,bool)") + w(STRANGER) + w(1), OWNER)).ok);
  ok("seal() goes through", (await raw(DEPLOYER, sl.data, OWNER)).ok);
  const sealed = await raw(DEPLOYER, ABI.selector("sealed_()"), OWNER);
  ok("sealed_() is true", ABI.readBool(sealed.raw));
  const dep2 = stepsNow().find(x => x.id === "curve").txs[0].build();
  ok("and not even the owner can deploy from it again", !(await raw(DEPLOYER, dep2.data, OWNER)).ok);
}

/* ---- and the thing actually works ---- */
console.log("── the launch this sequence produces is one somebody can trade");
{
  const buy = await raw(CURVE, ABI.selector("buy(uint256,address)") + w(0) + w(BUYER),
                        BUYER, E, 3000);
  ok("a 1 ETH buy on the curve settles", buy.ok, buy.err);
  const bal = await raw(TOKEN, ABI.selector("balanceOf(address)") + w(BUYER), BUYER);
  ok("and the buyer holds tokens", ABI.readUint(bal.raw) > 0n, String(ABI.readUint(bal.raw)));
  const feeTo = await balance(evm, OWNER);
  ok("the 1% fee reached the owner in the same transaction", feeTo > 999n * E, String(feeTo));

  // Rule 1, alive, which it would not be without step 5's setPool.
  await call({ evm, address: orc.address }, "set(uint256,uint256,bool)", [2n * E, E, 1]);
  const burn = await raw(TOKEN, ABI.selector("burnBps()"), BUYER);
  ok("with the oracle ready and spot at twice the average, burnBps() is 5000",
     ABI.readUint(burn.raw) === 5000n, String(ABI.readUint(burn.raw)));
  const active = await raw(TOKEN, ABI.selector("ruleActive()"), BUYER);
  ok("and ruleActive() says the rule is actually in force", ABI.readBool(active.raw));
}

/* ─────────────────────────────────────────────────── the page builds the same bytes ──────── */
console.log("── the page's encoder against the scripts', on this launch's real state");
{
  const L = {
    chainId: cfg.chainId, owner: cfg.owner,
    token: { ...cfg.token, supply: cfg.token.supply.toString() },
    curve: Object.fromEntries(Object.entries(cfg.curve)
      .map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
    vanity: cfg.vanity,
  };
  const st = { oracle: ORACLE, deployer: DEPLOYER, token: TOKEN, salt: SALT, curve: CURVE };
  const steps = buildSteps({ cfg, artifacts: ART, state });
  const pairs = [];
  for (const step of steps)
    for (const tx of step.txs) pairs.push([`${step.n}.${tx.key}`, step, tx]);
  ok("every transaction the scripts define has a twin on the page", pairs.length === 7,
     String(pairs.length));
  for (const [key, , tx] of pairs) {
    const mine = tx.build();
    let theirs = null, err = "";
    try { theirs = PAGE.tx(key, ART, L, st); } catch (e) { err = e.message; }
    ok(`${key} is byte-identical between the page and the scripts`,
       !!theirs && ABI.strip(theirs.data) === ABI.strip(mine.data) &&
       (theirs.to || null) === (mine.to || null),
       err || (theirs ? `page ${ABI.strip(theirs.data).length / 2} bytes, ` +
                        `scripts ${ABI.strip(mine.data).length / 2} bytes` : "the page threw"));
  }
  const page = R("deploy/deploy.html");
  for (const step of steps)
    if (step.confirm)
      ok(`the page asks for step ${step.n}'s exact confirmation phrase`,
         page.includes(step.confirm), step.confirm);
  ok("the page carries the never-ready sentence on its face, not in a comment",
     page.includes("Rule 1 never fires") && page.includes("ordinary ERC-20"));
  ok("and the bond() race, in the list of things that cannot be undone",
     /bond\(\) is permissionless/i.test(page) && /race/i.test(page));
  for (const item of AFTER_THE_SEQUENCE)
    ok(`the page also carries "${item.title}"`, page.includes(item.title));
}

/* ─────────────────────────────────────────────────────────────────── the gate on advancing ── */
console.log("── a step that has not been read back blocks the one after it");
{
  const empty = { chainId: 8453, owner: cfg.owner, steps: {} };
  const s = buildSteps({ cfg, artifacts: ART, state: empty });
  for (const id of ["token", "salt", "curve", "lock"])
    ok(`${id} refuses to build with nothing verified before it`,
       !!s.find(x => x.id === id).blocked(), s.find(x => x.id === id).blocked() || "it built");
  ok("the token step is blocked by the oracle READ, not merely by the config entry",
     /\(oracle\)/.test(s.find(x => x.id === "token").blocked()),
     s.find(x => x.id === "token").blocked());
  ok("and the refusal names the step that is missing",
     /step \d \(\w+\)/.test(s.find(x => x.id === "curve").blocked()));
  let threw = false;
  try { pickStep(s, "9"); } catch { threw = true; }
  ok("an unknown step is refused rather than silently doing nothing", threw);
  threw = false;
  try { pickStep(s, "5.nonsense"); } catch { threw = true; }
  ok("and so is an unknown transaction within a step", threw);

  // A state file from a rehearsal on another chain is not this launch's evidence. Without this
  // the safety mechanism is what hides the problem: every mainnet step reads as verified from
  // testnet answers.
  const tmp = path.join(ROOT, "deploy", ".test-state.json");
  fs.writeFileSync(tmp, JSON.stringify({ chainId: 84532, owner: cfg.owner, steps: {} }));
  let rejected = false;
  try { loadState(tmp, { chainId: 8453, owner: cfg.owner }); } catch { rejected = true; }
  ok("a state file from another chain is refused, not reused", rejected);
  fs.writeFileSync(tmp, JSON.stringify({ chainId: 8453, owner: STRANGER, steps: {} }));
  rejected = false;
  try { loadState(tmp, { chainId: 8453, owner: cfg.owner }); } catch { rejected = true; }
  ok("and so is one belonging to a different owner", rejected);
  fs.unlinkSync(tmp);
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
