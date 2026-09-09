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
  // The loop below reads the committed data files. A default endpoint hidden in a .mjs source
  // is the same bearer credential in a place the loop never looked, and `process.env.SNOOZE_RPC`
  // being MENTIONED is satisfied by `process.env.SNOOZE_RPC || "https://…/v2/<key>"`.
  const inSource = files.map(f => [path.relative(ROOT, f), fs.readFileSync(f, "utf8")])
    .flatMap(([name, t]) => (t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      .match(/https?:\/\/[^\s"'`]+/g) || []).map(u => `${name}: ${u}`))
    // The one that is allowed to appear is the public endpoint named in the "set this yourself"
    // message, which is not a credential and is not a default — nothing reads it.
    .filter(u => !/mainnet\.base\.org/.test(u));
  ok("no script hardcodes an endpoint outside a comment", inSource.length === 0,
     inSource.join(", "));
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
const html = R("deploy/deploy.html");
const blockOf = id => (html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`)) || [])[1];
const PAGE = (() => {
  // Pulled out of the page and evaluated with no DOM and no window, which is possible only
  // because that block is pure. It is the block that decides what bytes go out, so it is the
  // block worth comparing against the scripts.
  const block = blockOf("calldata");
  if (!block) return null;
  return new Function(block + "\nreturn SNOOZE;")();
})();
/// deploy/artifacts.js is the ONLY input the signing page has: it carries the bytecode AND the
/// launch parameters, and the page never reads config.json or the .mjs sources. Comparing the
/// page's encoder against freshly compiled artifacts and a freshly loaded config therefore
/// tests something the page never sees. This is the file it actually runs on.
const TWIN = (() => {
  const src = R("deploy/artifacts.js");
  return new Function("window", src + "\nreturn window.__SNOOZE;")({});
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

/// The page's GATING layer, lifted out and made runnable. It decides whether the next
/// irreversible button lights up, and it was covered by nothing: changing `push(c, !!ok, …)`
/// to `push(c, true, …)` on one line made every check on the signing page pass unconditionally
/// and left the whole suite green. So each step's check is run below at the SAME point in the
/// sequence as the scripts' own — after the deployment it is about and before the next one,
/// because "sealed_() is false" and "frozen() is false" are true then and false later.
/// A copy, not TWIN.launch itself: the suite grinds a two-character suffix rather than the
/// configured five (a million keccaks is ten seconds of a core and not something a test should
/// spend), so the page has to be told the same suffix the scripts were told, and mutating the
/// twin the assertions above just compared against config.json would make that comparison a
/// lie. Everything else in it is the file the page really runs on.
const PAGE_LAUNCH = TWIN ? JSON.parse(JSON.stringify(TWIN.launch)) : null;
const PAGECHECKS = (() => {
  const block = blockOf("checks");
  if (!block || !TWIN) return null;
  const noStore = { getItem: () => null, setItem: () => {} };
  return new Function("window", "localStorage", "SNOOZE", "$", "A", "L", "W",
    block + "\nreturn { STEPS: STEPS, ST: ST, oracleChecks: oracleChecks, " +
            "exportProgress: exportProgress, importProgress: importProgress };")(
    { __SNOOZE: TWIN, localStorage: noStore }, noStore, PAGE,
    () => null, TWIN, PAGE_LAUNCH, { prov: null, addr: null, chain: null });
})();

/// Run one of the page's steps against the live EVM, exactly as the page would: its own reads,
/// its own decoding, its own check.
async function runPageCheck(id, st) {
  if (!PAGECHECKS) return { list: [] };
  Object.assign(PAGECHECKS.ST, st);
  const step = PAGECHECKS.STEPS().find(x => x.id === id);
  const results = {};
  for (const r of step.reads()) {
    const got = await raw(r.to, r.data, OWNER);
    results[r.sig] = got.ok ? { ok: true, data: got.raw } : { ok: false, error: got.err };
  }
  const target = step.code();
  const code = target && (await evm.stateManager.getCode(
    createAddressFromString(target))).length ? "0x01" : "0x";
  return { step, list: step.check(results, code) };
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
  ok("it is a classic script, not a module, so file:// can load it",
     /window\.__SNOOZE = /.test(js));
  ok("the page loads it that way", /<script src="artifacts\.js"><\/script>/.test(html));
  // Every byte of it, not one initCode and a regex. The page has no other input, so a twin
  // that has drifted from contracts/ or from config.json is a signing page building the wrong
  // transaction with nothing anywhere to notice.
  for (const n of DEPLOYABLE) {
    ok(`the twin's ${n} is the bytes that compile today`,
       TWIN.contracts?.[n]?.initCode === ART.contracts[n].initCode, "stale artifacts.js");
    ok(`and its ${n} constructor list matches`,
       JSON.stringify(TWIN.contracts?.[n]?.constructorInputs) ===
       JSON.stringify(ART.contracts[n].constructorInputs));
  }
  ok("the twin carries the settable-mock blocklist the page's oracle guard needs",
     TWIN.refuse?.MockOracle?.runtime === ART.refuse.MockOracle.runtime &&
     TWIN.refuse?.MockOracle?.selectors?.["set(uint256,uint256,bool)"] === SETTER_SELECTOR);
  const str = v => (typeof v === "bigint" ? v.toString() : v);
  const expected = {
    chainId: CFG.chainId, owner: CFG.owner,
    token: { ...CFG.token, supply: str(CFG.token.supply) },
    curve: Object.fromEntries(Object.entries(CFG.curve).map(([k, v]) => [k, str(v)])),
    vanity: CFG.vanity,
    oracle: { choice: CFG.oracle.choice, address: CFG.oracle.address,
              describe: CFG.oracle.describe },
  };
  ok("and its launch parameters are exactly what deploy/config.json resolves to",
     JSON.stringify(TWIN.launch) === JSON.stringify(expected),
     "regenerate: node deploy/scripts/artifacts.mjs");
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

  // The same mock rebuilt elsewhere: solc's CBOR blob holds a hash of the source and of the
  // compiler settings, so the bytes inside it differ while its two-byte length trailer does
  // not. Mutating inside the blob and leaving the trailer alone is what a rebuild actually
  // looks like — flipping the trailer instead would only test that a corrupt tail is caught.
  const withOtherMetadata = (rt) => {
    const tailLen = (parseInt(rt.slice(-4), 16) + 2) * 2;
    const at = rt.length - tailLen + 8;     // a few bytes into the blob, well clear of the end
    return rt.slice(0, at) + (rt[at] === "a" ? "b" : "a") + rt.slice(at + 1);
  };
  const rebuilt = withOtherMetadata(mockRuntime);
  const reb = inspectOracle({ code: rebuilt, results: good, refuse: ART.refuse,
                              choice: "observational" });
  ok("a rebuilt mock with a different metadata tail is still refused",
     reb.some(c => !c.ok && /set\(uint256,uint256,bool\)/.test(c.name)));
  // Same source, different machine: the metadata blob changes and its two-byte length trailer
  // does not. A length test alone passes on an implementation that only drops the "0x", which
  // would leave inspectOracle doing a byte-for-byte comparison under a stripped name.
  {
    const tail = parseInt(mockRuntime.slice(-4), 16);
    ok("stripMetadata removes exactly the CBOR blob its own length trailer describes",
       stripMetadata(mockRuntime).length === mockRuntime.length - 2 - (tail + 2) * 2,
       `${mockRuntime.length - stripMetadata(mockRuntime).length} chars removed, ` +
       `the trailer says ${(tail + 2) * 2} plus the 0x`);
    ok("and two builds of the same source agree once it is off",
       stripMetadata(mockRuntime) === stripMetadata(rebuilt),
       "a rebuild differs only inside the blob, so stripping it must make them equal");
  }
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
                         "contracts/SnoozeCurve.sol", "contracts/test/SnoozeMocks.sol",
                         "contracts/test/UniV2Mocks.sol"]);
const OWNER = CFG.owner.toLowerCase();
const STRANGER = "0x00000000000000000000000000000000deadbeef";
const BUYER = "0x00000000000000000000000000000000000000b1";
const DEAD = "0x000000000000000000000000000000000000dEaD";
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
/// Drive a step's own verify block: its own declared calls, its own decoding, its own check.
///
/// WHY THIS EXISTS SEPARATELY from the assertions below. Reading name(), oracle() and
/// balanceOf() with ABI.readX and comparing them here proves the CHAIN is right and says
/// nothing about steps.mjs — six wrong expectations were substituted into its check functions
/// (totalSupply 1, oracle = the owner, isPool false, sealed_ false, curveSupply 42, feeTo zero)
/// and the suite's output did not change by a byte, because nothing ever called them. The
/// verify blocks are what decide whether the next irreversible button unlocks, so they are the
/// part that has to be exercised rather than merely defined.
async function runStepCheck(step, address) {
  const results = {};
  for (const c of step.verify.calls || []) {
    const r = await raw(address, c.data, OWNER);
    results[c.sig] = r.ok ? { ok: true, data: r.raw } : { ok: false, error: r.err };
  }
  for (const c of (step.verify.extraCalls ? step.verify.extraCalls() : [])) {
    const r = await raw(c.to, c.data, OWNER);
    results[c.sig] = r.ok ? { ok: true, data: r.raw } : { ok: false, error: r.err };
  }
  const code = (await evm.stateManager.getCode(createAddressFromString(address))).length
    ? "0x01" : "0x";
  return { results, list: step.verify.check(results, { code, address }) };
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

// The venue graduation goes into. On Base these are the real Uniswap V2 factory and WETH,
// which config.json names and which nothing in this EVM has; so the two minimal mocks stand
// at addresses of their own, and the launch under test is pointed at them. Deployed by a
// stranger, because on Base they were.
const V2F = (await deploy(all.MockV2Factory.evm.bytecode.object, "", { evm, from: STRANGER })).address.toString();
const WETH = (await deploy(all.MockWETH.evm.bytecode.object, "", { evm, from: STRANGER })).address.toString();
cfg.curve = { ...cfg.curve, factory: ABI.toChecksum(V2F), weth: ABI.toChecksum(WETH) };
if (PAGE_LAUNCH) PAGE_LAUNCH.curve = { ...PAGE_LAUNCH.curve, factory: ABI.toChecksum(V2F),
                                       weth: ABI.toChecksum(WETH) };

{
  const s = stepsNow();
  // deploy/config.json now names a choice, so the refusal is exercised against a config with
  // the field emptied rather than against the shipped one. The refusal itself is the thing
  // being tested — that nothing can be built while nobody has decided — not which value ships.
  const unchosen = { ...CFG, oracle: { ...CFG.oracle, choice: "", address: "" } };
  ok("step 1 cannot be verified while the oracle is unchosen",
     !!buildSteps({ cfg: unchosen, artifacts: ART, state }).find(x => x.id === "oracle").blocked());
  ok("and every later step is blocked behind it",
     buildSteps({ cfg: unchosen, artifacts: ART, state })
       .filter(x => x.n >= 3).every(x => !!x.blocked()));
  ok("the shipped config does name one, so a fresh clone is not stuck",
     !!CFG.oracle.choice, "oracle.choice is empty in deploy/config.json");
  ok("with an oracle chosen but not yet read back, step 2 is ready and step 3 is not",
     !s.find(x => x.id === "deployer").blocked() && !!s.find(x => x.id === "token").blocked(),
     "a chosen oracle is a line in a config file; a verified one answered three calls");

  // Step 1 can deploy exactly one oracle and no other, and which one is the whole point. With
  // an address already configured it deploys nothing; with "never-ready" and no address it
  // offers SnoozeNeverReady; there is no path at all to the settable mock, because a
  // convenient button for that is how it reaches Base "temporarily".
  ok("with an address already configured, step 1 deploys nothing over it",
     !!s[0].txs[0].blocked(), s[0].txs[0].blocked() || "it offered to redeploy");
  {
    const noAddr = { ...CFG, oracle: { ...CFG.oracle, choice: "never-ready", address: "" } };
    const st = buildSteps({ cfg: noAddr, artifacts: ART, state: { steps: {} } })[0];
    ok('"never-ready" with no address offers to deploy one', !st.txs[0].blocked());
    ok("and what it offers is SnoozeNeverReady, with no constructor arguments",
       st.txs[0].build().data === ART.contracts.SnoozeNeverReady.initCode &&
       st.txs[0].build().to === null);
    ok("and it says on its face that Rule 1 will never fire",
       /never fires/i.test(st.note() || ""), st.note() || "(no note)");
    const obs = { ...CFG, oracle: { ...CFG.oracle, choice: "observational", address: "" } };
    ok('"observational" with no address still refuses, because there is no such oracle here',
       !!buildSteps({ cfg: obs, artifacts: ART, state: { steps: {} } })[0].blocked());
  }
  // The one contract that must never have a button.
  ok("nothing in the sequence can deploy the settable mock",
     !DEPLOYABLE.includes("MockOracle") && !JSON.stringify(ART.contracts).includes("MockOracle"));
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
  state.steps.deployer = { status: "sent", readBack: { address: DEPLOYER } };
  const v = await runStepCheck(stepsNow().find(x => x.id === "deployer"), DEPLOYER);
  ok(`step 2's own verify block passes on the real deployment (${v.list.length} checks)`,
     v.list.every(c => c.ok), v.list.filter(c => !c.ok).map(c => c.name + " " + c.detail).join("; "));
  const pv = await runPageCheck("deployer", { deployer: DEPLOYER });
  ok(`and so does the page's, on the same chain state (${pv.list.length} checks)`,
     pv.list.length > 0 && pv.list.every(c => c.ok),
     pv.list.filter(c => !c.ok).map(c => c.name + " " + c.why).join("; "));
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
  state.steps.token = { status: "sent", readBack: { address: TOKEN } };
  const v = await runStepCheck(stepsNow().find(x => x.id === "token"), TOKEN);
  ok(`step 3's own verify block passes on the real token (${v.list.length} checks)`,
     v.list.every(c => c.ok), v.list.filter(c => !c.ok).map(c => c.name + " " + c.detail).join("; "));
  // And it is not a check that passes on anything: pointed at the DEPLOYER instead, which is a
  // real contract with real code, every claim about the token has to fail.
  const wrong = await runStepCheck(stepsNow().find(x => x.id === "token"), DEPLOYER);
  ok("and fails against a different contract at a real address",
     wrong.list.filter(c => !c.ok).length >= 5,
     `only ${wrong.list.filter(c => !c.ok).length} of ${wrong.list.length} failed`);
  const pv = await runPageCheck("token", { oracle: ORACLE, deployer: DEPLOYER, token: TOKEN });
  ok(`the page's step 3 check passes on the same token (${pv.list.length} checks)`,
     pv.list.length > 0 && pv.list.every(c => c.ok),
     pv.list.filter(c => !c.ok).map(c => c.name + " " + c.why).join("; "));
  const pw = await runPageCheck("token", { token: DEPLOYER });
  ok("and fails when pointed at a different contract",
     pw.list.filter(c => !c.ok).length >= 5,
     `only ${pw.list.filter(c => !c.ok).length} of ${pw.list.length} failed`);
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
  if (PAGE_LAUNCH) PAGE_LAUNCH.vanity = { ...PAGE_LAUNCH.vanity, suffix: cfg.vanity.suffix };
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
let CURVE, PAIR;
{
  const step = stepsNow().find(x => x.id === "curve");
  ok("step 5 demands a phrase naming the immutable parameters",
     /immutable/.test(step.confirm) && /fee address/.test(step.confirm), step.confirm);
  ok("and its irreversible list names where graduation goes, since nobody can change it",
     step.irreversible.some(t => /lpTo/.test(t) && /constructor creates the pair/.test(t)),
     step.irreversible.join(" | ").slice(0, 200));
  ok("including that the LP is burned when lpTo is the dead address",
     step.irreversible.some(t => /LP is burned/.test(t)));
  ok("and that one wallet is exempt from both rules, because that is a choice with a cost",
     step.irreversible.some(t => /capExempt\(/.test(t)));

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
  // What record.mjs 5.deploy does next: ask the curve which pair its constructor created.
  PAIR = ABI.readAddress((await raw(CURVE, ABI.selector("pair()"), OWNER)).raw);
  ok("the constructor created the pair, so its address is a fact before the first buy",
     PAIR && !ABI.sameAddress(PAIR, ABI.ZERO), String(PAIR));
  const gp = await raw(V2F, ABI.selector("getPair(address,address)") + w(TOKEN) + w(WETH), OWNER);
  ok("and it is the factory's pair for (token, WETH)", ABI.sameAddress(ABI.readAddress(gp.raw), PAIR));
  state.steps.curve = { status: "sent", readBack: { address: CURVE, pair: PAIR } };

  // The audit's R11: step 2 asserted count() == 0, which is false forever after this point, so
  // a launch that lost its state file after 5.deploy could never re-verify step 2 — and
  // grind.mjs is gated on step 2, so the salt could never be recovered. State-aware now.
  {
    const s2 = stepsNow().find(x => x.id === "deployer");
    const again = await runStepCheck(s2, DEPLOYER);
    ok("step 2 still verifies after the curve has been deployed from it",
       again.list.every(c => c.ok), again.list.filter(c => !c.ok).map(c => c.name + " " + c.detail).join("; "));
    ok("and it now says count() is 1, which is what the chain says",
       again.list.some(c => /count\(\) is 1/.test(c.name)));
  }

  // The audit's C10: three files said step 5 reads the address off the chain by calling
  // addressOf, and nothing did. It is a precondition on 5.deploy now, so the deployer's own
  // derivation is read BEFORE the send rather than enforced by a revert at spend time.
  {
    const dep5 = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "deploy");
    ok("5.deploy carries a chain precondition", !!dep5.precondition && /addressOf/.test(dep5.precondition.needsChain));
    const results = {};
    for (const c of dep5.precondition.calls()) {
      const r = await raw(c.to, c.data, OWNER);
      results[c.sig] = r.ok ? { ok: true, data: r.raw } : { ok: false, error: r.err };
    }
    const list = dep5.precondition.check(results);
    ok("and the deployer's addressOf agrees with the salt's promise, read off the chain",
       list.every(c => c.ok), list.map(c => c.name + " " + c.detail).join("; "));
    // A salt record that promises somewhere else is caught by this read, before any send.
    const lying = { ...state, steps: { ...state.steps, salt: { ...state.steps.salt,
      readBack: { ...state.steps.salt.readBack, predicted: "0x" + "ab".repeat(20) } } } };
    const dep5b = buildSteps({ cfg, artifacts: ART, state: lying }).find(x => x.id === "curve")
      .txs.find(t => t.key === "deploy");
    const bad = dep5b.precondition.check(results);
    ok("and a promise the deployer does not agree with fails it", bad.some(c => !c.ok),
       "the wrong address would have been sent to");
  }

  // The audit's R3, the one that sends 80% of the supply to the wrong contract: the funding
  // transfer used to be gated on the curve's address being KNOWN, and a wrong hash pasted at
  // record.mjs 5.deploy makes some address known. Now it has to be the salt's promise.
  {
    const wrong = { ...state, steps: { ...state.steps, curve: { status: "sent", readBack: { address: TOKEN } } } };
    const fund = buildSteps({ cfg, artifacts: ART, state: wrong }).find(x => x.id === "curve")
      .txs.find(t => t.key === "fund");
    ok("5.fund refuses when the recorded curve is not the address the salt promised",
       /not the address the salt promised/.test(fund.blocked() || ""), fund.blocked() || "it would have built");
    const right = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "fund");
    ok("and builds when it is", right.blocked() === null, right.blocked());
  }

  // The precondition that encodes the ordering. Funding must come first: once isPool[curve] is
  // true, a transfer into the curve is a sell.
  const reg = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "register");
  const pre = (held, sold) => reg.precondition.check({
    "token.balanceOf(curve)": { ok: true, data: "0x" + w(held) },
    "curve.sold()": { ok: true, data: "0x" + w(sold) } });
  const before = pre(0n, 0n);
  ok("setPool is refused while the curve is empty", before.some(c => !c.ok));
  ok("and the refusal says what would happen instead of just refusing",
     before.some(c => !c.ok && /burns/.test(c.detail)));
  ok("and a half-funded curve is refused too", pre(CFG.curve.curveSupply / 2n, 0n).some(c => !c.ok));

  // THE ONE THAT BRICKED THE LAUNCH. The curve is public and tradeable the moment it is
  // funded, and setPool is a separate transaction, so there is a window and anybody may buy in
  // it. The first version of this precondition read balanceOf(curve) alone and demanded it
  // equal curveSupply — so ONE buy of a tenth of an ether left it short forever, setPool could
  // never be built, neither rule ever fired, and step 6 is gated on step 5, so freeze() and
  // seal() were unreachable for the life of the token. Measured, not imagined.
  //
  // held + sold is what SnoozeCurve actually maintains: buy does `sold += out` then transfers
  // out, sell reverses both. Trading moves tokens between the two and leaves the sum alone.
  {
    const bought = CFG.curve.curveSupply / 100n;
    const after = pre(CFG.curve.curveSupply - bought, bought);
    ok("a buy between funding and setPool does NOT block setPool", after.every(c => c.ok),
       after.filter(c => !c.ok).map(c => c.name + " " + c.detail).join("; "));
    ok("and it says trading has started rather than saying nothing",
       after.some(c => /already sold/.test(c.detail || "")));
    ok("even when almost the whole float has been bought",
       pre(CFG.curve.curveSupply / 50n, CFG.curve.curveSupply * 49n / 50n).every(c => c.ok));
    // The shortfall that IS real still refuses, and no longer tells you to send tokens into a
    // curve that is merely trading.
    const short = pre(CFG.curve.curveSupply / 2n, bought);
    ok("but a genuine funding shortfall still refuses", short.some(c => !c.ok));
    ok("and says which of the two it is", short.some(c => !c.ok && /missing funding/.test(c.detail)));
  }

  // Sent to the address the step CHOSE, with the value the step chose. Passing TOKEN and 0 by
  // hand meant `to` and `value` were pinned by nothing: repointing 5.fund at the curve and
  // giving non-payable freeze() ten ether both left the suite at all-green, and the page hands
  // `built.value` straight to eth_sendTransaction.
  const fundTx = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "fund").build();
  ok("the funding transaction is addressed to the TOKEN, not the curve",
     ABI.sameAddress(fundTx.to, TOKEN), String(fundTx.to));
  ok("and carries no value", fundTx.value === "0x0", fundTx.value);
  const fr = await raw(fundTx.to, fundTx.data, fundTx.from, BigInt(fundTx.value));
  ok("funding the curve goes through", fr.ok, fr.err);
  const held = await raw(TOKEN, ABI.selector("balanceOf(address)") + w(CURVE), OWNER);
  ok("and it holds every token it is allowed to sell, intact",
     ABI.readUint(held.raw) === CFG.curve.curveSupply, String(ABI.readUint(held.raw)));

  const soldNow = await raw(CURVE, ABI.selector("sold()"), OWNER);
  const after = reg.precondition.check({ "token.balanceOf(curve)": { ok: true, data: held.raw },
                                         "curve.sold()": { ok: true, data: soldNow.raw } });
  ok("now setPool is allowed", after.every(c => c.ok),
     after.filter(c => !c.ok).map(c => c.name).join("; "));

  const regTx = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "register").build();
  ok("setPool is addressed to the token, which is where isPool lives",
     ABI.sameAddress(regTx.to, TOKEN), String(regTx.to));
  const rr = await raw(regTx.to, regTx.data, regTx.from, BigInt(regTx.value));
  ok("registering the curve as the pool goes through", rr.ok, rr.err);
  const isPool = await raw(TOKEN, ABI.selector("isPool(address)") + w(CURVE), OWNER);
  const exempt = await raw(TOKEN, ABI.selector("capExempt(address)") + w(CURVE), OWNER);
  ok("isPool(curve) is true, which is what switches BOTH rules on", ABI.readBool(isPool.raw));
  ok("capExempt(curve) is true, so the curve can pay buyers out", ABI.readBool(exempt.raw));

  // The two transactions that did not exist before graduation was automatic: the pair the
  // constructor made has to be a pool on the token, or post-graduation sells are outside
  // both rules forever once freeze() lands; and the owner's exemption, which is a config
  // choice and is checked as one.
  const rp = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "registerPair");
  ok("5.registerPair builds once the pair is known", rp.blocked() === null, rp.blocked());
  const rpTx = rp.build();
  ok("and it is setPool(pair, true) on the token",
     ABI.sameAddress(rpTx.to, TOKEN) && rpTx.data.toLowerCase().includes(PAIR.slice(2).toLowerCase()));
  const rpr = await raw(rpTx.to, rpTx.data, rpTx.from, 0n);
  ok("registering the pair goes through", rpr.ok, rpr.err);
  ok("isPool(pair) is true", ABI.readBool((await raw(TOKEN, ABI.selector("isPool(address)") + w(PAIR), OWNER)).raw));
  const ex = stepsNow().find(x => x.id === "curve").txs.find(t => t.key === "exemptOwner");
  ok("5.exemptOwner builds when token.ownerExempt is true", ex.blocked() === null, ex.blocked());
  const exTx = ex.build();
  const exr = await raw(exTx.to, exTx.data, exTx.from, 0n);
  ok("exempting the owner goes through", exr.ok, exr.err);
  ok("capExempt(owner) is true — the one wallet outside both rules",
     ABI.readBool((await raw(TOKEN, ABI.selector("capExempt(address)") + w(OWNER), OWNER)).raw));
  ok("and a stranger cannot exempt themselves — setCapExempt reverts NotAdmin",
     !(await raw(TOKEN, ABI.selector("setCapExempt(address,bool)") + w(STRANGER) + w(1), STRANGER)).ok);
  {
    const off = { ...state, steps: state.steps };
    const cfgOff = { ...cfg, token: { ...cfg.token, ownerExempt: false } };
    const exOff = buildSteps({ cfg: cfgOff, artifacts: ART, state: off }).find(x => x.id === "curve")
      .txs.find(t => t.key === "exemptOwner");
    ok("with ownerExempt false the exemption is refused rather than sent",
       /ownerExempt is false/.test(exOff.blocked() || ""), exOff.blocked() || "it built");
  }

  const rd = async sig => (await raw(CURVE, ABI.selector(sig), OWNER)).raw;
  ok("feeTo() is the owner", ABI.sameAddress(ABI.readAddress(await rd("feeTo()")), CFG.owner));
  ok("virtualEth() is the configured virtual reserve",
     ABI.readUint(await rd("virtualEth()")) === CFG.curve.virtualEth);
  ok("bondTarget() is the configured target",
     ABI.readUint(await rd("bondTarget()")) === CFG.curve.bondTarget);
  ok("token() is the token", ABI.sameAddress(ABI.readAddress(await rd("token()")), TOKEN));
  ok("sold() is zero — nothing has traded", ABI.readUint(await rd("sold()")) === 0n);
  const v = await runStepCheck(stepsNow().find(x => x.id === "curve"), CURVE);
  ok(`step 5's own verify block passes on the real curve (${v.list.length} checks)`,
     v.list.every(c => c.ok), v.list.filter(c => !c.ok).map(c => c.name + " " + c.detail).join("; "));
  const pv = await runPageCheck("curve",
    { token: TOKEN, curve: CURVE, predicted: PREDICTED, salt: SALT, deployer: DEPLOYER, pair: PAIR });
  ok(`and so does the page's (${pv.list.length} checks)`,
     pv.list.length > 0 && pv.list.every(c => c.ok),
     pv.list.filter(c => !c.ok).map(c => c.name + " " + c.why).join("; "));
  markVerified(state, "curve", { address: CURVE, pair: PAIR });
}

/* ---- and a buyer who arrives before you get round to verifying ---- */
console.log("── somebody trades between funding the curve and reading it back");
{
  // The curve is public from the block it is funded, so this is not a hypothetical. A strict
  // `balanceOf(curve) == curveSupply` fails here and never recovers, and step 6 is gated on
  // step 5 — freeze() and seal() would be unreachable for the rest of the token's life because
  // somebody bought a tenth of an ether's worth at the wrong moment.
  const evmT = await createEVM();
  await fund(evmT, OWNER, 100n * E);
  await fund(evmT, BUYER, 100n * E);
  const orcT = await deploy(all.MockOracle.evm.bytecode.object, "", { evm: evmT });
  if (PAGE_LAUNCH) PAGE_LAUNCH.curve = { ...PAGE_LAUNCH.curve, curveSupply: (800n * E).toString(),
                                         virtualEth: (3n * E).toString(),
                                         bondTarget: (6n * E).toString(), feeTo: CFG.owner };
  const SUP = 1000n * E, FLOAT = 800n * E;
  const t = await deploy(all.Snooze.evm.bytecode.object,
    w(SUP) + w(orcT.address.toString()) + w(CFG.token.dev) + w(0), { evm: evmT, from: OWNER });
  const fT = (await deploy(all.MockV2Factory.evm.bytecode.object, "", { evm: evmT })).address.toString();
  const wT = (await deploy(all.MockWETH.evm.bytecode.object, "", { evm: evmT })).address.toString();
  const c = await deploy(all.SnoozeCurve.evm.bytecode.object,
    [t.address.toString(), 3n * E, FLOAT, 6n * E, 100, OWNER, ABI.ZERO, 0, 0, fT, wT, DEAD].map(w).join(""),
    { evm: evmT, timestamp: 1000, from: OWNER });
  const T = { evm: evmT, address: t.address }, C = { evm: evmT, address: c.address };
  await call(T, "transfer(address,uint256)", [c.address.toString(), FLOAT], { from: OWNER });
  await call(T, "setPool(address,bool)", [c.address.toString(), 1], { from: OWNER });
  // The rest of what step 5 now sends, so the verify below is run against a finished step.
  const pairT = ABI.readAddress((await (async () => {
    const r = await evmT.runCall({ caller: createAddressFromString(OWNER), to: c.address,
      gasLimit: 30_000_000n, data: ABI.bytes(ABI.selector("pair()")),
      block: { header: { number: 1n, timestamp: 1500n } } });
    return "0x" + ABI.hex(r.execResult.returnValue);
  })()));
  await call(T, "setPool(address,bool)", [pairT, 1], { from: OWNER });
  await call(T, "setCapExempt(address,bool)", [OWNER, 1], { from: OWNER });
  const bought = await call(C, "buy(uint256,address)", [0, BUYER],
                            { from: BUYER, value: E / 10n, timestamp: 2000 });
  ok("a buy lands before anybody has run verify", bought.ok, bought.revert);

  const st = { chainId: CFG.chainId, owner: CFG.owner, steps: {
    oracle: { status: "verified", readBack: { address: orcT.address.toString() } },
    deployer: { status: "verified", readBack: { address: DEPLOYER } },
    token: { status: "verified", readBack: { address: t.address.toString() } },
    salt: { status: "verified", readBack: { predicted: c.address.toString() } },
    curve: { status: "sent", readBack: { address: c.address.toString(), pair: pairT } },
  } };
  // This EVM has its own venue — the mocks above are in the main one — so the config the
  // verify block is built from has to name these, or it reads the right values off the curve
  // and compares them with somebody else's factory.
  const cfgT = { ...cfg, curve: { ...cfg.curve, curveSupply: FLOAT, virtualEth: 3n * E,
                                  bondTarget: 6n * E, feeTo: cfg.owner,
                                  factory: ABI.toChecksum(fT), weth: ABI.toChecksum(wT) },
                 vanity: { ...cfg.vanity, suffix: c.address.toString().slice(-2) } };
  const step = buildSteps({ cfg: cfgT, artifacts: ART, state: st }).find(x => x.id === "curve");
  const results = {};
  for (const cc of step.verify.calls)
    results[cc.sig] = await (async () => {
      const r = await evmT.runCall({ caller: createAddressFromString(OWNER),
        to: c.address, gasLimit: 30_000_000n, data: ABI.bytes(cc.data),
        block: { header: { number: 1n, timestamp: 2100n } } });
      return { ok: !r.execResult.exceptionError, data: "0x" + ABI.hex(r.execResult.returnValue) };
    })();
  for (const cc of step.verify.extraCalls())
    results[cc.sig] = await (async () => {
      const r = await evmT.runCall({ caller: createAddressFromString(OWNER),
        to: createAddressFromString(cc.to), gasLimit: 30_000_000n, data: ABI.bytes(cc.data),
        block: { header: { number: 1n, timestamp: 2100n } } });
      return { ok: !r.execResult.exceptionError, data: "0x" + ABI.hex(r.execResult.returnValue) };
    })();
  const list = step.verify.check(results, { code: "0x01", address: c.address.toString() });
  ok("step 5 still verifies, so freeze() and seal() stay reachable",
     list.every(x => x.ok), list.filter(x => !x.ok).map(x => x.name + " " + x.detail).join("; "));
  ok("and it says so rather than pretending nothing happened",
     list.some(x => /already sold/.test(x.detail || "")),
     "the operator has to know trading has started");

  // AND THE PAGE HAS TO AGREE. These two had silently drifted: steps.mjs was softened and
  // deploy.html kept the strict equality, so the signing page would have failed step 5 forever
  // on the same buy. The byte-equality test between them covers CALLDATA only — what a step
  // considers a pass is a second surface, and this is where it is compared.
  if (PAGECHECKS) {
    Object.assign(PAGECHECKS.ST, { token: t.address.toString(), curve: c.address.toString(),
                                   predicted: c.address.toString(), salt: SALT,
                                   deployer: DEPLOYER, oracle: orcT.address.toString() });
    const st = PAGECHECKS.STEPS().find(x => x.id === "curve");
    const pr = {};
    for (const rr of st.reads()) {
      const g = await evmT.runCall({ caller: createAddressFromString(OWNER),
        to: createAddressFromString(rr.to), gasLimit: 30_000_000n, data: ABI.bytes(rr.data),
        block: { header: { number: 1n, timestamp: 2100n } } });
      pr[rr.sig] = { ok: !g.execResult.exceptionError,
                     data: "0x" + ABI.hex(g.execResult.returnValue) };
    }
    const pl = st.check(pr, "0x01");
    const soldFail = pl.filter(x => !x.ok && /sold|received|holds/i.test(x.name));
    ok("the page's step 5 also survives a buy before it is verified", soldFail.length === 0,
       soldFail.map(x => x.name + " — " + x.why).join("; "));
  }
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
  const f3 = (await deploy(all.MockV2Factory.evm.bytecode.object, "", { evm: evm3 })).address.toString();
  const w3 = (await deploy(all.MockWETH.evm.bytecode.object, "", { evm: evm3 })).address.toString();
  const c = await deploy(all.SnoozeCurve.evm.bytecode.object,
    [t.address.toString(), 3n * E, FLOAT, 6n * E, 100, OWNER, ABI.ZERO, 0, 0, f3, w3, DEAD].map(w).join(""),
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

  ok("neither door is sent any value", fz.value === "0x0" && sl.value === "0x0",
     `${fz.value} / ${sl.value}`);
  ok("freeze() goes through", (await raw(fz.to, fz.data, fz.from, BigInt(fz.value))).ok);
  ok("and afterwards even the admin cannot register another pool",
     !(await raw(TOKEN, ABI.selector("setPool(address,bool)") + w(STRANGER) + w(1), OWNER)).ok);
  ok("seal() goes through", (await raw(sl.to, sl.data, sl.from, BigInt(sl.value))).ok);
  const sealed = await raw(DEPLOYER, ABI.selector("sealed_()"), OWNER);
  ok("sealed_() is true", ABI.readBool(sealed.raw));
  const dep2 = stepsNow().find(x => x.id === "curve").txs[0].build();
  ok("and not even the owner can deploy from it again", !(await raw(DEPLOYER, dep2.data, OWNER)).ok);
  const v = await runStepCheck(stepsNow().find(x => x.id === "lock"), DEPLOYER);
  ok(`step 6's own verify block passes once both doors are shut (${v.list.length} checks)`,
     v.list.every(c => c.ok), v.list.filter(c => !c.ok).map(c => c.name + " " + c.detail).join("; "));
  const pv = await runPageCheck("lock", { deployer: DEPLOYER, token: TOKEN });
  ok(`and so does the page's (${pv.list.length} checks)`,
     pv.list.length > 0 && pv.list.every(c => c.ok),
     pv.list.filter(c => !c.ok).map(c => c.name + " " + c.why).join("; "));

  // RE-READING A FINISHED LAUNCH. Step 3's checks used to assert the values that are true only
  // AT step 3 — the owner holding the whole supply, and frozen() false. Both stop being true
  // when the launch completes correctly, so a finished launch failed its own step 3. On the
  // page the button for a done step is labelled "Re-read from the chain", and that same click
  // wrote verified.token = false, persisted it, and locked step 4 behind it.
  markVerified(state, "lock", { address: DEPLOYER });
  const re = await runStepCheck(stepsNow().find(x => x.id === "token"), TOKEN);
  ok(`step 3 still verifies on a finished launch (${re.list.length} checks)`,
     re.list.every(c => c.ok), re.list.filter(c => !c.ok).map(c => c.name + " " + c.detail).join("; "));
  if (PAGECHECKS) {
    // The wrong-order block above pointed PAGE_LAUNCH at its scratch curve; the real page reads
    // the committed twin, so restore it before asking what the real page would conclude.
    PAGE_LAUNCH.curve = JSON.parse(JSON.stringify(TWIN.launch.curve));
    PAGECHECKS.ST.verified = { oracle: true, deployer: true, token: true, salt: true,
                               curve: true, lock: true };
    const rp = await runPageCheck("token", { oracle: ORACLE, deployer: DEPLOYER, token: TOKEN,
                                             curve: CURVE, salt: SALT, predicted: PREDICTED });
    ok(`and so does the page's step 3 (${rp.list.length} checks)`,
       rp.list.length > 0 && rp.list.every(c => c.ok),
       rp.list.filter(c => !c.ok).map(c => c.name + " " + c.why).join("; "));
    PAGECHECKS.ST.verified = {};
  }
  ok("and the page never downgrades a recorded verification on a re-read",
     /var wasVerified = !!ST\.verified\[step\.id\];/.test(R("deploy/deploy.html")) &&
     /if\(bad === 0\)\{ ST\.verified\[step\.id\] = true;/.test(R("deploy/deploy.html")),
     "a re-read that shows a difference must report it, not erase the record");
}

/* ---- and the thing actually works ---- */
console.log("── the launch this sequence produces is one somebody can trade");
{
  const before = await balance(evm, OWNER);
  const buy = await raw(CURVE, ABI.selector("buy(uint256,address)") + w(0) + w(BUYER),
                        BUYER, E, 3000);
  ok("a 1 ETH buy on the curve settles", buy.ok, buy.err);
  const bal = await raw(TOKEN, ABI.selector("balanceOf(address)") + w(BUYER), BUYER);
  ok("and the buyer holds tokens", ABI.readUint(bal.raw) > 0n, String(ABI.readUint(bal.raw)));
  // The exact delta, derived from the configured fee. The first version asserted the owner's
  // balance was "above 999 ETH" against a starting balance of exactly 1000 and a fee of 0.01,
  // so a curve charging no fee at all passed it.
  const want = E * BigInt(CFG.curve.feeBps) / 10_000n;
  const got = (await balance(evm, OWNER)) - before;
  ok(`the ${CFG.curve.feeBps / 100}% fee reached the owner in the same transaction, exactly`,
     got === want, `${got} wei, expected ${want}`);

  // Rule 1, alive, which it would not be without step 5's setPool.
  await call({ evm, address: orc.address }, "set(uint256,uint256,bool)", [2n * E, E, 1]);
  const burn = await raw(TOKEN, ABI.selector("burnBps()"), BUYER);
  ok("with the oracle ready and spot at twice the average, burnBps() is 5000",
     ABI.readUint(burn.raw) === 5000n, String(ABI.readUint(burn.raw)));
  const active = await raw(TOKEN, ABI.selector("ruleActive()"), BUYER);
  ok("and ruleActive() says the rule is actually in force", ABI.readBool(active.raw));
  await call({ evm, address: orc.address }, "set(uint256,uint256,bool)", [E, E, 0]);

  // GRADUATION, which used to be the sequence's biggest hole and is now its last measured
  // step. Real ETH up to the target, then a STRANGER calls bond() — and gets nothing, because
  // there is nothing to get: the pair was fixed in the constructor and the LP goes to lpTo.
  const target = CFG.curve.bondTarget;
  const gross = target * 10_000n / (10_000n - BigInt(CFG.curve.feeBps)) + 10n ** 15n;
  const big = await raw(CURVE, ABI.selector("buy(uint256,address)") + w(0) + w(BUYER), BUYER, gross, 3100);
  ok("a buy that crosses the bond target settles", big.ok, big.err);
  ok("and bondable() is now true", ABI.readBool((await raw(CURVE, ABI.selector("bondable()"), BUYER)).raw));
  const preview = await raw(CURVE, ABI.selector("bondPreview()"), BUYER);
  const [ethToPool, tokensToPool] = [ABI.readUint(preview.raw.slice(0, 66)),
                                     ABI.readUint("0x" + preview.raw.slice(66, 130))];
  const strangerBefore = await balance(evm, STRANGER);
  const bonded = await raw(CURVE, ABI.selector("bond()"), STRANGER, 0n, 3200);
  ok("a stranger may call bond(), and it goes through", bonded.ok, bonded.err);
  ok("the stranger received no ETH for it", (await balance(evm, STRANGER)) <= strangerBefore);
  const pairWeth = ABI.readUint((await raw(WETH, ABI.selector("balanceOf(address)") + w(PAIR), BUYER)).raw);
  ok("the pair holds the whole real reserve as WETH", pairWeth === ethToPool, `${pairWeth} vs ${ethToPool}`);
  const pairTok = ABI.readUint((await raw(TOKEN, ABI.selector("balanceOf(address)") + w(PAIR), BUYER)).raw);
  ok("and the seed tokens, at the curve's closing price", pairTok === tokensToPool, `${pairTok} vs ${tokensToPool}`);
  const lpDead = ABI.readUint((await raw(PAIR, ABI.selector("balanceOf(address)") + w(DEAD), BUYER)).raw);
  ok("the LP tokens went to the dead address — the LP is burned", lpDead > 0n, String(lpDead));
  ok("the curve keeps no ETH", (await balance(evm, CURVE)) === 0n);
  ok("bonded() is true, which is what flips the site's buy button",
     ABI.readBool((await raw(CURVE, ABI.selector("bonded()"), BUYER)).raw));
  ok("and the curve is closed", !(await raw(CURVE, ABI.selector("buy(uint256,address)") + w(0) + w(BUYER), BUYER, E, 3300)).ok);

  // The pool is a registered pool, so the rules follow the token there. A holder selling
  // into it is a transfer INTO isPool — Rule 2 caps it at 20% of the baseline; the owner's
  // wallet is exempt and moves the lot.
  const held = ABI.readUint((await raw(TOKEN, ABI.selector("balanceOf(address)") + w(BUYER), BUYER)).raw);
  const dump = await raw(TOKEN, ABI.selector("transfer(address,uint256)") + w(PAIR) + w(held), BUYER, 0n, 3400);
  ok("a holder cannot move their whole bag into the pool in one go — Rule 2 caps it", !dump.ok);
  const fifth = await raw(TOKEN, ABI.selector("transfer(address,uint256)") + w(PAIR) + w(held / 5n), BUYER, 0n, 3400);
  ok("a fifth goes through", fifth.ok, fifth.err);
  const ownerHeld = ABI.readUint((await raw(TOKEN, ABI.selector("balanceOf(address)") + w(OWNER), OWNER)).raw);
  const ownerMove = await raw(TOKEN, ABI.selector("transfer(address,uint256)") + w(PAIR) + w(ownerHeld / 2n), OWNER, 0n, 3400);
  ok("the exempt owner moves half their bag into the pool in one transaction", ownerMove.ok, ownerMove.err);
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
  const st = { oracle: ORACLE, deployer: DEPLOYER, token: TOKEN, salt: SALT, curve: CURVE,
               pair: PAIR };
  const steps = buildSteps({ cfg, artifacts: ART, state });
  const pairs = [];
  for (const step of steps)
    for (const tx of step.txs) pairs.push([`${step.n}.${tx.key}`, step, tx]);
  ok("every transaction the scripts define has a twin on the page", pairs.length === 10,
     String(pairs.length));

  // THE GAP THAT LET A LIVE LAUNCH STALL. The twin check below passes `st` built HERE, so it
  // proved tx() encodes correctly and said nothing about what the page hands it. `pair` was
  // added to ST, to the progress record, to step 5's reads and to tx()'s switch — and not to
  // the object literal at the call site, so "Register the pool the curve made" threw
  // "not a 20-byte address: undefined" with 80% of the supply already in the curve.
  {
    const src = R("deploy/deploy.html");
    const body = (src.match(/function tx\(key, A, L, st\)\{[\s\S]*?\n  \}/) || [""])[0];
    const reads = [...new Set([...body.matchAll(/\bst\.([A-Za-z_]\w*)/g)].map(m => m[1]))];
    const literal = (src.match(/SNOOZE\.tx\(tx\.key, A, L, \{[\s\S]*?\}\)/) || [""])[0];
    const missing = reads.filter(k => !new RegExp(`\\b${k}\\s*:`).test(literal));
    ok(`the page hands tx() every key it reads (${reads.join(", ")})`, missing.length === 0,
       "missing at the call site: " + missing.join(", "));
  }
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
  // The page hardcodes the Deployed topic because it ships no keccak. A wrong nibble there
  // would match no log, so the page would fall through to "created nothing" on a deployment
  // that worked — or, before that check existed, to trusting the address the operator typed.
  ok("the Deployed topic the page matches on is keccak of the event signature",
     R("deploy/deploy.html").includes(ABI.keccakText("Deployed(address,bytes32,address)")),
     ABI.keccakText("Deployed(address,bytes32,address)"));
  ok("and SnoozeDeployer really emits that event",
     /event Deployed\(address indexed [\w]+, bytes32 indexed [\w]+, address indexed [\w]+\)/
       .test(R("contracts/SnoozeDeployer.sol")));
  // Step 1's button and step 1's block used to be exact opposites of each other.
  {
    const html = R("deploy/deploy.html");
    ok("step 1 does not block itself out of deploying the oracle it offers",
       /if\(L\.oracle\.choice === "never-ready"\) return null;/.test(html));
  }
  ok("a verified step's send buttons are disabled, so an irreversible deploy cannot repeat",
     /\|\| done;/.test(R("deploy/deploy.html")));
  ok("the page's check layer is a block a test can run outside a browser", !!PAGECHECKS);
  ok("and it builds the same six steps", !!PAGECHECKS && PAGECHECKS.STEPS().length === 6);
  if (PAGECHECKS) {
    // The page's oracle guard, against the one contract it exists to refuse.
    const mockRt = "0x" + compile(["contracts/test/SnoozeMocks.sol"]).all
      .MockOracle.evm.deployedBytecode.object.replace(/^0x/, "");
    const mocked = PAGECHECKS.oracleChecks(
      { "ready()": { ok: true, data: "0x" + w(0) },
        "spot()": { ok: true, data: "0x" + w(1000) },
        "twap24()": { ok: true, data: "0x" + w(1000) } }, mockRt);
    ok("the page refuses the settable mock too, not only the scripts",
       mocked.some(c => !c.ok && /MockOracle/.test(c.name)));
    ok("and by its setter selector as well as by its bytes",
       mocked.some(c => !c.ok && /set\(uint256,uint256,bool\)/.test(c.name)));
    // Nothing on the page may be a green tick that cannot fail. Step 4 is the offline one and
    // it carried exactly that until it was removed.
    const salt4 = PAGECHECKS.STEPS().find(x => x.id === "salt");
    Object.assign(PAGECHECKS.ST, { salt: null, predicted: null });
    ok("no check on the page is true by construction",
       salt4.check({}, "0x").every(c => !c.ok),
       "a push(c, true, …) renders as a green tick indistinguishable from a real one");
  }


  const page = R("deploy/deploy.html");
  for (const step of steps)
    if (step.confirm)
      ok(`the page asks for step ${step.n}'s exact confirmation phrase`,
         page.includes(step.confirm), step.confirm);
  ok("the page carries the never-ready sentence on its face, not in a comment",
     page.includes("Rule 1 never fires") && page.includes("ordinary ERC-20"));
  ok("and where graduation goes, in the list of things that cannot be undone",
     /bond\(\) — permissionless, no argument/.test(page) && /LP is burned forever/.test(page));
  ok("and that the owner's wallet is the one outside both rules",
     /capExempt\(owner\) becomes permanent/.test(page));
  for (const item of AFTER_THE_SEQUENCE)
    ok(`the page also carries "${item.title}"`, page.includes(item.title));
}

/* ────────────────────────────── the page's progress, out of the browser and back in ──────── */
// The signing page keeps its progress in localStorage, which is scoped to the ORIGIN it was
// opened from — and test/run.mjs measures, in one browser profile, that file:// and a http://
// origin serving the identical bytes have separate stores. So a person who opens the page one
// way on Tuesday and the other way on Wednesday sees a launch that has not started. Nothing is
// lost when that happens (the chain has the truth, record.mjs rebuilds the CLI's copy), but it
// is exactly the moment somebody deploys a second token on top of their first.
//
// The way out is a paste box, and a paste box is a place where a 39-character address gets in.
// So the validator is checked here rather than by looking at it.
console.log("── the page's progress can leave the browser it is trapped in");
{
  const P = PAGECHECKS;
  ok("the page exposes an export and an import that run outside a browser",
     !!P && typeof P.exportProgress === "function" && typeof P.importProgress === "function");
  if (P && P.importProgress) {
    const owner = PAGE_LAUNCH.owner, chainId = PAGE_LAUNCH.chainId;
    const rec = (state, over = {}) => JSON.stringify(
      { what: "snooze-deploy-progress", version: 1, chainId, owner, state, ...over });
    const full = { oracle: "0x" + "aa".repeat(20), deployer: "0x" + "bb".repeat(20),
                   token: "0x" + "cc".repeat(20), salt: "0x" + "01".repeat(32),
                   initCodeHash: "0x" + "02".repeat(32), predicted: "0x" + "dd".repeat(20),
                   curve: "0x" + "dd".repeat(20), pair: "0x" + "ef".repeat(20),
                   verified: { oracle: true, deployer: true, token: true },
                   sent: { "oracle.deploy": "0x" + "ee".repeat(32) } };

    const good = P.importProgress(rec(full));
    ok("a record this page wrote comes back in", good.ok, good.why);
    ok("and every field survives the round trip",
       good.ok && JSON.stringify(good.state) === JSON.stringify(full),
       good.ok ? JSON.stringify(good.state) : "");

    // The refusals, each of which is a real thing somebody pastes.
    const no = (label, text, wants) => {
      const r = P.importProgress(text);
      ok(label, !r.ok && (!wants || new RegExp(wants).test(r.why)),
         r.ok ? "it was ACCEPTED" : r.why);
    };
    no("junk text is refused, not parsed into an empty launch", "hello", "not JSON");
    no("and so is valid JSON that is not a progress record", '{"token":"0x00"}', "not a progress record");
    no("and an array", "[]", "not a progress record");
    // The one that matters most: a rehearsal's progress, on mainnet. loadState() refuses the
    // same thing for launch-state.json and for the same reason — a testnet read marking a
    // mainnet step verified is the failure where the safety mechanism hides the problem.
    no("a rehearsal's progress is refused on this chain", rec(full, { chainId: 84532 }),
       "chain 84532");
    no("and somebody else's launch is refused by owner",
       rec(full, { owner: "0x" + "11".repeat(20) }), "different launches");
    // A paste box is where a truncated address gets in, and an address one character short is
    // not an address — it is a different one, silently, after padStart.
    no("a 39-character address is refused rather than padded",
       rec({ ...full, token: "0x" + "c".repeat(39) }), "not a 20-byte address");
    no("a 41-character one too", rec({ ...full, curve: "0x" + "d".repeat(41) }));
    no("and a salt that is not 32 bytes", rec({ ...full, salt: "0x" + "01".repeat(31) }),
       "not 32 bytes");
    no("and an init-code hash that is not", rec({ ...full, initCodeHash: "0xdeadbeef" }));

    // Empty is a legitimate record: it is what "I have not started" exports as.
    const blank = P.importProgress(rec({ oracle: null, deployer: null, token: null, salt: null,
                                         initCodeHash: null, predicted: null, curve: null,
                                         pair: null, verified: {}, sent: {} }));
    ok("a record with nothing in it is accepted, because that is a real state", blank.ok, blank.why);
    // And the two maps are normalised, so a record with an array where an object belongs cannot
    // make ST.verified something the rest of the page indexes into and gets undefined from.
    const odd = P.importProgress(rec({ ...full, verified: [], sent: "no" }));
    ok("a verified map that is not a map becomes an empty one rather than an array",
       odd.ok && !Array.isArray(odd.state.verified) &&
       typeof odd.state.verified === "object" && Object.keys(odd.state.verified).length === 0 &&
       typeof odd.state.sent === "object", odd.ok ? JSON.stringify(odd.state.verified) : odd.why);

    const round = P.importProgress(P.exportProgress());
    ok("and exportProgress produces something importProgress accepts", round.ok, round.why);
  }
}

/* ───────────────────────────────────── the one address a paste can silently corrupt ─────── */
// R9. The owner was checksum-checked; the oracle address was checked only when mixed-case, so
// an all-lower-case paste — which carries no checksum at all — went through with any two
// characters transposed. It is the field that becomes immutable in step 3.
console.log("── the oracle address has to arrive checksummed");
{
  // An address whose checksum actually has upper-case letters in it — all-digit hex has no
  // case to carry a checksum, so "0x1234…" would have passed lower-cased for the wrong reason.
  const good = ABI.toChecksum("0x" + "abcdef1234".repeat(4));
  const tmpCfg = path.join(ROOT, "deploy", ".test-oracle.json");
  const withOracle = (address) => {
    const raw = JSON.parse(R("deploy/config.json"));
    raw.oracle.choice = "observational"; raw.oracle.address = address;
    fs.writeFileSync(tmpCfg, JSON.stringify(raw));
    return loadConfig(tmpCfg).problems;
  };
  ok("the checksummed form is accepted", withOracle(good).length === 0, withOracle(good).join("; "));
  const lower = withOracle(good.toLowerCase());
  ok("the same address in lower case is refused, and the refusal says why",
     lower.some(p => /checksummed form/.test(p) && /no checksum/.test(p)), lower.join("; "));
  const swapped = good.toLowerCase().replace(/^0x(.)(.)/, "0x$2$1");
  ok("and so is a lower-case address with two characters transposed — the paste this exists for",
     withOracle(swapped).length > 0);
  fs.unlinkSync(tmpCfg);
}

/* ──────────────────────────────── every address, before the wallet has spent anything ────── */
// deploy/scripts/predict.mjs makes one claim: all four addresses are knowable in advance, so a
// contract address can go on a Dexscreener submission or a pinned post days before a wei is
// spent. It is only worth making if the EVM agrees, and a contract address published wrong is
// not a thing that can be taken back — so this deploys the whole sequence a SECOND time, from
// a wallet nobody has touched, having written down every address FIRST, and compares.
//
// The derivation is easy to get subtly wrong in a way that passes on the numbers you tried:
// nonce 0 RLP-encodes as the empty string 0x80, not as 0x00, so a hand-rolled encoder is
// usually correct from nonce 1 and wrong for the very first contract a fresh wallet deploys.
console.log("── the addresses are knowable before the wallet has spent anything");
{
  // The canonical vectors first, because "it agrees with the EVM in this file" and "it agrees
  // with Ethereum" are different claims and only the second one survives a change of client.
  const V = "0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0";
  const known = ["0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d",
                 "0x343c43a37d37dff08ae8c4a11544c718abb4fcf8",
                 "0xf778b86fa74e846c4f0a1fbd1335fe81c00a0c91",
                 "0xfffd933a0bc612844eaf0c6fe3e5b8e9b6c1d19c"];
  ok("createAddress matches the canonical RLP vectors, nonce 0 included",
     known.every((w, i) => ABI.createAddress(V, i) === w),
     known.map((w, i) => `${i}: ${ABI.createAddress(V, i)}`).join(" "));
  ok("and nonce 0 is not the same address as nonce 1, which 0x00 instead of 0x80 would make it",
     ABI.createAddress(V, 0) !== ABI.createAddress(V, 1));
  // 0x80 and above stop being their own encoding and take a length prefix. A wallet reaches
  // 128 transactions in an afternoon, so this is the ordinary case, not an edge one.
  ok("a nonce of 128 crosses RLP's single-byte boundary and still produces an address",
     /^0x[0-9a-f]{40}$/.test(ABI.createAddress(V, 128)) &&
     ABI.createAddress(V, 128) !== ABI.createAddress(V, 127));
  let threw = false;
  try { ABI.createAddress(V, -1); } catch { threw = true; }
  ok("and a negative nonce is refused rather than encoded as something", threw);

  // Now the real thing. A wallet at nonce 0, three predictions, then the actual deployments.
  const W = "0x" + "d7".repeat(20);
  await fund(evm, W, 1000n * E);
  const said = { oracle: ABI.createAddress(W, 0), deployer: ABI.createAddress(W, 1),
                 token: ABI.createAddress(W, 2) };

  const gotOracle = (await deploy(ART.contracts.SnoozeNeverReady.initCode, "", { evm, from: W }))
                      .address.toString();
  ok("the oracle landed where it was predicted, before it was compiled into a transaction",
     ABI.sameAddress(gotOracle, said.oracle), `${gotOracle} vs ${said.oracle}`);
  const gotDeployer = (await deploy(ART.contracts.SnoozeDeployer.initCode,
                                    ABI.addressWord(W), { evm, from: W })).address.toString();
  ok("and so did SnoozeDeployer", ABI.sameAddress(gotDeployer, said.deployer),
     `${gotDeployer} vs ${said.deployer}`);
  const gotToken = (await deploy(ART.contracts.Snooze.initCode, snoozeArgs(cfg, gotOracle),
                                 { evm, from: W })).address.toString();
  ok("and so did the token — the address a buyer pastes, known two transactions early",
     ABI.sameAddress(gotToken, said.token), `${gotToken} vs ${said.token}`);

  // And the curve, which is the whole point: its constructor argument is the token, so a
  // predicted token is a predictable init code, a predictable hash, and a salt that can be
  // ground now rather than in the middle of a launch.
  const initHash = curveInitCodeHash(ART, cfg, said.token);
  let salt = null, at = null;
  for (let i = 1; i < 200000; i++) {
    const trial = "0x" + i.toString(16).padStart(64, "0");
    const a = ABI.create2Address(said.deployer, trial, initHash);
    if (a.toLowerCase().endsWith("ed")) { salt = trial; at = a; break; }
  }
  ok("a salt for the curve can be ground against the PREDICTED token, before it exists", !!salt);
  const made = await raw(gotDeployer, ABI.encodeDeployCall(salt, curveInitCode(ART, cfg, said.token)), W);
  ok("and the curve really lands there when it is finally deployed", made.ok &&
     ABI.sameAddress(ABI.readAddress(made.raw), at),
     made.ok ? `${ABI.readAddress(made.raw)} vs ${at}` : made.err);

  // THE FAILURE THIS IS ALL EXPOSED TO, measured rather than warned about. A nonce is consumed
  // by any transaction from the wallet, so one stray approval between the prediction and the
  // launch moves the token — and a salt ground for the old token is a salt for an address the
  // deployment never reaches. grind.mjs compares init-code hashes for exactly this reason, so
  // what is checked here is that the two hashes really do differ.
  const strayed = ABI.createAddress(W, 4);
  ok("one extra transaction from the wallet moves the token to a different address",
     !ABI.sameAddress(strayed, said.token));
  ok("and the curve's init-code hash moves with it, which is what step 4 compares",
     curveInitCodeHash(ART, cfg, strayed) !== initHash);
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

/* ────────────────────────────────────────────── the commands refuse rather than crash ────── */
console.log("── the commands themselves: a refusal, never a stack trace");
{
  // Spawned for real, because "it exits non-zero" and "it exits non-zero with a Node stack
  // trace on stderr" are the same to every in-process check and completely different to
  // somebody halfway through a deployment. Four of these printed `at file:///…` before this
  // block existed.
  const { spawnSync } = await import("node:child_process");
  const tmp = path.join(ROOT, "deploy", ".test-cli");
  // Cleared first: a run killed part-way leaves this folder behind (it is gitignored now, C18),
  // and a stale predicted.json in it made "nothing was written" false on the next run.
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const cfgPath = path.join(tmp, "config.json");
  const statePath = path.join(tmp, "state.json");
  const raw = JSON.parse(R("deploy/config.json"));
  raw.oracle.choice = "observational";
  // Checksummed, because config.mjs now refuses a lower-case oracle address outright — the
  // one field that becomes immutable in step 3 and the only one where a transposition in a
  // lower-cased paste is undetectable. The fixture used to be all lower case, which is
  // exactly the paste the rule exists to stop.
  raw.oracle.address = ABI.toChecksum("0x00000000000000000000000000000000000000aa");
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));

  // THE OPERATOR'S SHELL IS NOT THE TEST'S ENVIRONMENT, and this suite inherited it. Every
  // "refuses when there is no endpoint" case silently became "reached the chain instead" on
  // the one machine where it matters most: the terminal that has just run a real launch, where
  // SNOOZE_RPC is exported. Found by a live launch, on the run that followed it.
  const run = (args, extraEnv = {}) => {
    const env = { ...process.env, SNOOZE_CONFIG: cfgPath, SNOOZE_STATE: statePath,
                  NO_COLOR: "1" };
    for (const k of ["SNOOZE_RPC", "SNOOZE_PREDICTION", "SNOOZE_PAGE", "SNOOZE_CHAIN"])
      delete env[k];
    return spawnSync(process.execPath, args, { encoding: "utf8", cwd: ROOT,
                                               env: { ...env, ...extraEnv } });
  };
  const clean = r => !/\bat file:\/\/|\bat async |Node\.js v/.test((r.stderr || "") + (r.stdout || ""));
  // Blanked, not copied. web/index.html carries the real addresses once a launch has happened,
  // and publish.mjs correctly refuses to repoint a live page — so a fixture that copied it
  // verbatim tested the guard instead of the thing under test, and only after launch day.
  const blankPage = () => R("web/index.html")
    .replace(/^const SNOOZE_CURVE = "[^"]*";/m, 'const SNOOZE_CURVE = "";')
    .replace(/^const SNOOZE_TOKEN = "[^"]*";/m, 'const SNOOZE_TOKEN = "";')
    .replace(/^const TOKEN = "[^"]*";/m, 'const TOKEN = "";');

  const B = "deploy/scripts/build.mjs", V = "deploy/scripts/verify.mjs";

  let r = run([B]);
  ok("build.mjs with no step refuses", r.status === 1 && /refused/.test(r.stderr), r.stderr.trim());
  r = run([B, "99"]);
  ok("build.mjs with a step that does not exist refuses, and lists the ones that do",
     r.status === 1 && /no such step/.test(r.stderr) && /1 \(oracle\)/.test(r.stderr));
  ok("and does not print a stack trace at it", clean(r), r.stderr.slice(0, 200));
  r = run([B, "2.nonsense"]);
  ok("an unknown transaction inside a real step refuses too",
     r.status === 1 && /no transaction "nonsense"/.test(r.stderr) && clean(r), r.stderr.trim());
  r = run([V, "zzz"]);
  ok("verify.mjs refuses an unknown step without a stack trace",
     r.status === 1 && /no such step/.test(r.stderr) && clean(r), r.stderr.trim());

  fs.writeFileSync(statePath, "{ not json");
  r = run(["deploy/scripts/plan.mjs"]);
  ok("a corrupt state file is reported as one, not as a SyntaxError",
     r.status === 1 && /not readable JSON/.test(r.stderr) && clean(r), r.stderr.trim());
  fs.rmSync(statePath, { force: true });

  // The confirmation gate, exercised through the command rather than by reading its source.
  // Step 2 is reachable with nothing verified, so the gate is checked on step 3 with the two
  // steps before it marked verified in the temporary state.
  fs.writeFileSync(statePath, JSON.stringify({
    chainId: raw.chainId, owner: raw.owner,
    steps: { oracle: { status: "verified", readBack: { address: raw.oracle.address } },
             deployer: { status: "verified",
                         readBack: { address: "0x00000000000000000000000000000000000000bb" } } },
  }));
  r = run([B, "3"]);
  ok("an irreversible step refuses to print its bytes without the phrase", r.status === 2);
  ok("and shows the phrase it wants, alongside what cannot be undone",
     /--confirm/.test(r.stdout) && /immutable/.test(r.stdout));
  r = run([B, "3", "--confirm", "the oracle address and devBps are immutable"]);
  ok("a partial phrase is not the phrase", r.status === 2, String(r.status));
  r = run([B, "3", "--confirm", "  the oracle address and devBps are immutable and I have checked both  "]);
  ok("and neither is one with whitespace round it", r.status === 2, String(r.status));
  r = run([B, "3", "--confirm"]);
  ok("--confirm with nothing after it is not a bypass", r.status === 2, String(r.status));
  r = run([B, "3", "--confirm", "the oracle address and devBps are immutable and I have checked both"]);
  ok("the exact phrase prints the transaction", r.status === 0 && /contract creation/.test(r.stdout),
     (r.stderr || r.stdout).slice(0, 200));
  ok("and what it printed is a deployment of Snooze with this launch's arguments",
     r.stdout.includes(ART.contracts.Snooze.initCode.slice(2, 42)));

  // A step whose prerequisite is unverified stays refused however it is asked for.
  r = run([B, "5.register"]);
  ok("a step behind an unverified one refuses whichever transaction is named",
     r.status === 1 && /has not been verified/.test(r.stderr), r.stderr.trim());

  /* ---- predict.mjs and the salt it lets step 4 skip ---- */
  // Spawned rather than imported: predict.mjs does its work at module top level, so importing
  // it would run a prediction as a side effect — which is also why PREDICTION_PATH lives in
  // lib/state.mjs and not in the script that writes to it.
  const P = "deploy/scripts/predict.mjs", G = "deploy/scripts/grind.mjs";
  const predPath = path.join(tmp, "predicted.json");
  // The confirm-gate block above left a state file with two steps verified in it, and a
  // verified step contributes its RECORDED address and spends no nonce — which is correct and
  // is also not the situation being tested here. Predicting starts from nothing.
  fs.rmSync(statePath, { force: true });
  // Two characters instead of the configured four, for the same reason step 4's own test grinds
  // ...ed: the search is identical at any length and 65,536 keccaks are not a test's to spend.
  raw.vanity = { ...raw.vanity, suffix: "ed" };
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
  const predEnv = { SNOOZE_PREDICTION: predPath };

  r = run([P], predEnv);
  ok("predict.mjs with neither an endpoint nor a nonce refuses and says what to pass instead",
     r.status === 1 && /--nonce/.test(r.stderr) && clean(r), r.stderr.trim());
  r = run([P, "--nonce", "-1"], predEnv);
  ok("and a nonsense nonce is refused rather than encoded", r.status === 1 && clean(r));
  // The most likely thing to go wrong at this command: a wrong or blocked SNOOZE_RPC. It threw
  // an unhandled rejection and printed a Node stack trace at somebody who only needed to be
  // told to fix an environment variable — which every other command here already refuses to do.
  r = run([P], { ...predEnv, SNOOZE_RPC: "http://127.0.0.1:1/x" });
  ok("an unreachable endpoint is a refusal here too, not a stack trace",
     r.status === 1 && clean(r) && /--nonce/.test(r.stderr), (r.stderr || "").slice(0, 300));

  r = run([P, "--nonce", "5"], predEnv);
  const wantToken = ABI.toChecksum(ABI.createAddress(raw.owner, 6));
  ok("predict.mjs prints the token's address from the wallet's nonce alone",
     r.status === 0 && r.stdout.includes(wantToken), (r.stderr || r.stdout).slice(0, 300));
  ok("with the oracle already on chain counted as spending no nonce",
     r.stdout.includes(ABI.toChecksum(ABI.createAddress(raw.owner, 5))) &&
     r.stdout.includes("no nonce spent"));
  ok("and it says outright that nothing was sent",
     /nothing was sent/.test(r.stdout) && !fs.existsSync(predPath));
  ok("and names the one thing that invalidates it",
     /nothing else in between/.test(r.stdout), r.stdout.slice(-400));

  // The configuration under which none of this is possible. gateUntil is resolved from the
  // clock at build time, so with a gate on, the curve's init code — and its address — change
  // every second. Refusing is the only honest answer; producing an address would not be.
  const gated = { ...raw, gate: { ...raw.gate, gateToken: raw.owner, gateMin: "1" } };
  const gatedPath = path.join(tmp, "gated.json");
  fs.writeFileSync(gatedPath, JSON.stringify(gated, null, 2));
  r = run([P, "--nonce", "5"], { ...predEnv, SNOOZE_CONFIG: gatedPath });
  ok("predict.mjs refuses outright when the gate makes the curve's address time-dependent",
     r.status === 1 && /every second/.test(r.stderr) && clean(r), r.stderr.trim());

  r = run([P, "--nonce", "5", "--grind"], predEnv);
  ok("predict.mjs --grind finds a salt against the predicted token and writes it down",
     r.status === 0 && fs.existsSync(predPath), (r.stderr || r.stdout).slice(0, 300));
  const pred = JSON.parse(fs.readFileSync(predPath, "utf8"));
  ok("and the curve address it recorded really is that CREATE2 derivation",
     ABI.sameAddress(pred.curve, ABI.create2Address(pred.deployer, pred.salt, pred.initCodeHash)) &&
     pred.curve.toLowerCase().endsWith("ed"), JSON.stringify(pred).slice(0, 200));
  ok("and it is labelled a prediction rather than a deployment", /PREDICTION/.test(pred._note));

  // Step 4 with the launch actually at the point the prediction assumed: the salt is reused,
  // and the two independent derivations grind.mjs runs on every salt still have to agree.
  const verified = (address) => ({ status: "verified", readBack: { address } });
  fs.writeFileSync(statePath, JSON.stringify({
    chainId: raw.chainId, owner: raw.owner,
    steps: { oracle: verified(raw.oracle.address),
             deployer: verified(ABI.createAddress(raw.owner, 5)),
             token: verified(ABI.createAddress(raw.owner, 6)) } }));
  r = run([G], predEnv);
  ok("grind.mjs reuses the salt when the token landed where the prediction said",
     r.status === 0 && /reusing the salt/.test(r.stdout), (r.stderr || r.stdout).slice(0, 400));
  ok("and it lands on the address the prediction published",
     r.stdout.includes(ABI.toChecksum(pred.curve)), r.stdout.slice(0, 400));

  // And the case the reuse exists to survive: a prediction ground against something else.
  // Discarded and re-ground, not used — an address nobody will ever deploy to is worse than
  // a few seconds of grinding.
  fs.writeFileSync(predPath, JSON.stringify({ ...pred, initCodeHash: "0x" + "11".repeat(32) }));
  fs.writeFileSync(statePath, JSON.stringify({
    chainId: raw.chainId, owner: raw.owner,
    steps: { oracle: verified(raw.oracle.address),
             deployer: verified(ABI.createAddress(raw.owner, 5)),
             token: verified(ABI.createAddress(raw.owner, 6)) } }));
  r = run([G], predEnv);
  ok("a prediction ground against different numbers is discarded, not used",
     r.status === 0 && /different numbers/.test(r.stdout) && !/reusing the salt/.test(r.stdout),
     (r.stderr || r.stdout).slice(0, 400));

  // A step already sent contributes what it landed at, so this same command is a prediction
  // before a launch and a statement of fact during one — and never disagrees with itself about
  // a step that has happened.
  fs.writeFileSync(statePath, JSON.stringify({
    chainId: raw.chainId, owner: raw.owner,
    steps: { deployer: { status: "verified",
                         readBack: { address: "0x00000000000000000000000000000000000000bb" } } } }));
  r = run([P, "--nonce", "5"], predEnv);
  ok("a step already deployed contributes its real address and spends no nonce",
     r.status === 0 && /0x00000000000000000000000000000000000000[bB]{2}/.test(r.stdout) &&
     r.stdout.includes(ABI.toChecksum(ABI.createAddress(raw.owner, 5))) &&
     /deployed and verified/.test(r.stdout), (r.stderr || r.stdout).slice(0, 400));
  fs.rmSync(statePath, { force: true });

  /* ---- a node in a box, so record.mjs and build.mjs can be run against a receipt of my choosing ---- */
  // The refusal that matters most in this file cannot be reached without an endpoint: record.mjs
  // reads a receipt and decides what to write down. So here is an endpoint, answering exactly
  // what the test says and nothing else.
  //
  // A SEPARATE PROCESS, not an in-process server: the commands are run with spawnSync, which
  // blocks this event loop, so a server living in it could never answer them — the first
  // version hung for the client's 20-second timeout on every request.
  const nodeScript = path.join(tmp, "node.mjs");
  fs.writeFileSync(nodeScript, `
    import http from "node:http"; import fs from "node:fs";
    const cfgPath = process.argv[2];
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", d => body += d);
      req.on("end", () => {
        const m = JSON.parse(body);
        const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));   // re-read: the test edits it
        const reply = m.method === "eth_chainId" ? { result: c.chain }
          : m.method === "eth_getTransactionReceipt" ? { result: c.receipt }
          : m.method === "eth_call" ? { result: "0x" + "0".repeat(64) }
          : m.method === "eth_getCode" ? { result: "0x6001" }
          : { error: { code: -32601, message: "not here" } };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...reply }));
      });
    });
    srv.listen(0, () => { process.stdout.write(String(srv.address().port) + "\\n"); });
  `);
  const nodeCfg = path.join(tmp, "node.json");
  const setNode = (chain, receipt) => fs.writeFileSync(nodeCfg, JSON.stringify({ chain, receipt }));
  setNode("0x2105", null);
  const { spawn } = await import("node:child_process");
  const nodeProc = spawn(process.execPath, [nodeScript, nodeCfg], { stdio: ["ignore", "pipe", "inherit"] });
  const NODE = "http://127.0.0.1:" + await new Promise(res => {
    let buf = ""; nodeProc.stdout.on("data", d => { buf += d; if (/\n/.test(buf)) res(buf.trim()); });
  });
  const nodeEnv = { SNOOZE_RPC: NODE };

  const OWN = raw.owner, DEPL = ABI.createAddress(OWN, 5), TOK5 = ABI.createAddress(OWN, 6);
  const SALT5 = "0x" + "07".repeat(32);
  const IH = curveInitCodeHash(ART, { ...cfg }, TOK5);
  const PROMISED = ABI.create2Address(DEPL, SALT5, IH);
  const HASH = "0x" + "9a".repeat(32);
  const pad = a => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const DEPLOYED_TOPIC = ABI.keccakText("Deployed(address,bytes32,address)");
  const stateAtStep5 = (saltReadBack) => JSON.stringify({
    chainId: raw.chainId, owner: OWN,
    steps: { oracle: verified(raw.oracle.address), deployer: verified(DEPL), token: verified(TOK5),
             salt: { status: "verified", readBack: saltReadBack } } });
  const fullSalt = { salt: SALT5, initCodeHash: IH, predicted: PROMISED, deployer: DEPL, token: TOK5 };

  // R3, reproduced: step 3's receipt has a contractAddress and no Deployed log. It used to win.
  fs.writeFileSync(statePath, stateAtStep5(fullSalt));
  setNode("0x2105", { status: "0x1", contractAddress: TOK5, logs: [], blockNumber: "0x10" });
  r = run(["deploy/scripts/record.mjs", "5.deploy", HASH], nodeEnv);
  ok("record.mjs refuses a receipt that created something other than what the salt promised",
     r.status === 1 && /different deployment/.test(r.stderr) && clean(r), (r.stderr || r.stdout).slice(0, 300));
  ok("and did not write the token down as the curve",
     !/"curve"/.test(fs.readFileSync(statePath, "utf8")));
  // A receipt that created nothing and logged nothing is not the deployment either.
  setNode("0x2105", { status: "0x1", contractAddress: null, logs: [], blockNumber: "0x10" });
  r = run(["deploy/scripts/record.mjs", "5.deploy", HASH], nodeEnv);
  ok("and one that created nothing and emitted no Deployed log",
     r.status === 1 && /no Deployed log/.test(r.stderr), (r.stderr || r.stdout).slice(0, 300));
  // The real thing: a call receipt with the deployer's log, agreeing with the salt.
  setNode("0x2105", { status: "0x1", contractAddress: null, blockNumber: "0x10",
                      logs: [{ topics: [DEPLOYED_TOPIC, pad(PROMISED), SALT5, pad(OWN)] }] });
  r = run(["deploy/scripts/record.mjs", "5.deploy", HASH], nodeEnv);
  ok("a receipt whose Deployed log agrees with the salt is recorded",
     r.status === 0 && new RegExp(ABI.toChecksum(PROMISED)).test(r.stdout), (r.stderr || r.stdout).slice(0, 300));
  // R11: the salt comes back out of the log for a launch that lost its state file.
  fs.writeFileSync(statePath, stateAtStep5({ initCodeHash: IH, deployer: DEPL, token: TOK5 }));
  r = run(["deploy/scripts/record.mjs", "5.deploy", HASH], nodeEnv);
  const recovered = JSON.parse(fs.readFileSync(statePath, "utf8"));
  ok("and a state file with no salt gets it back from the Deployed log's second topic",
     r.status === 0 && recovered.steps.salt.readBack.salt === SALT5 && /read back out of the Deployed log/.test(r.stdout),
     (r.stderr || r.stdout).slice(0, 300));

  // R10: build.mjs was the one command that read the chain without asking which chain.
  fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(stateAtStep5(fullSalt)),
    steps: { ...JSON.parse(stateAtStep5(fullSalt)).steps, curve: { status: "sent", readBack: { address: PROMISED } } } }));
  setNode("0x14a34", null);
  r = run([B, "5.register", "--confirm", "the curve parameters and the fee address are immutable and I have checked them"], nodeEnv);
  ok("build.mjs refuses to read a precondition off the wrong chain",
     r.status === 1 && /chain 84532/.test(r.stderr) && clean(r), (r.stderr || r.stdout).slice(0, 300));
  nodeProc.kill();

  // C17, reproduced by the audit at HEAD: the grinder from a folder with a space in its name
  // found nothing and blamed the suffix. A desktop download lands in exactly such a folder.
  {
    const spaced = path.join(tmp, "Bob Smith");
    fs.mkdirSync(path.join(spaced, "tools"), { recursive: true });
    for (const f of ["vanity.mjs", "vanity-par.mjs"])
      fs.copyFileSync(path.join(ROOT, "tools", f), path.join(spaced, "tools", f));
    try { fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(spaced, "node_modules"), "dir"); } catch {}
    const g = spawnSync(process.execPath, [path.join(spaced, "tools", "vanity-par.mjs"), "ed",
      "--deployer", DEPL, "--inithash", IH, "--max", "400000"], { encoding: "utf8", cwd: spaced });
    ok("the grinder works from a folder whose name contains a space",
       g.status === 0 && /^salt\s+0x/m.test(g.stdout), (g.stderr || g.stdout).slice(0, 300));
  }

  // C1's door: publish.mjs will not make the buy card live under copy that promises a burn the
  // chosen oracle can never produce.
  {
    const nr = JSON.parse(R("deploy/config.json"));
    nr.oracle.choice = "never-ready";
    const nrPath = path.join(tmp, "never-ready.json");
    fs.writeFileSync(nrPath, JSON.stringify(nr));
    const st = path.join(tmp, "nr-state.json"), pg = path.join(tmp, "nr-index.html");
    fs.writeFileSync(st, JSON.stringify({ chainId: nr.chainId, owner: nr.owner,
      steps: { token: verified(TOK5), curve: verified(PROMISED) } }));
    // The shipped page no longer makes the claim — that is what the guard was for and the copy
    // was rewritten. So the page under test has it put BACK, which is the regression this
    // catches: somebody restoring the old headline over a never-ready launch.
    fs.writeFileSync(pg, blankPage()
      .replace("<h1 id=\"how\"", "<h3>Selling into a spike burns</h3><h1 id=\"how\""));
    r = run(["tools/publish.mjs", "--offline"], { SNOOZE_CONFIG: nrPath, SNOOZE_STATE: st, SNOOZE_PAGE: pg });
    ok("publish.mjs refuses to publish Rule 1 copy over a never-ready oracle",
       r.status === 1 && /never fire/.test(r.stderr) && /Selling into a spike burns/.test(r.stderr) && clean(r),
       (r.stderr || r.stdout).slice(0, 300));
    fs.writeFileSync(pg, blankPage());
    r = run(["tools/publish.mjs", "--offline"], { SNOOZE_CONFIG: nrPath, SNOOZE_STATE: st, SNOOZE_PAGE: pg });
    ok("and the page as it actually ships passes the same guard", r.status === 0,
       (r.stderr || r.stdout).slice(0, 300));
  }

  /* ---- tools/publish.mjs: the last manual step, made not manual ---- */
  // It lives in tools/ and it is tested here because what it reads is the launch state, and
  // the failure it exists to prevent is a deployment failure: a page that says "send ETH here"
  // above an address that is one character off. Everything else in this repository can be
  // corrected in the next block.
    const P2 = "tools/publish.mjs";
  const pagePath = path.join(tmp, "index.html");
  const pubState = path.join(tmp, "published.json");
  const TOK = ABI.toChecksum(ABI.createAddress(raw.owner, 6));
  const CRV = ABI.toChecksum("0x" + "77".repeat(19) + "ed");
  const freshPage = () => fs.writeFileSync(pagePath, blankPage());
  const pubEnv = () => ({ SNOOZE_STATE: pubState, SNOOZE_PAGE: pagePath });
  const withSteps = (steps) => fs.writeFileSync(pubState,
    JSON.stringify({ chainId: raw.chainId, owner: raw.owner, steps }));

  freshPage();
  withSteps({ token: verified(TOK) });
  r = run([P2, "--offline", "--write"], pubEnv());
  ok("publish.mjs refuses while the curve is unverified, and says which step",
     r.status === 1 && /step 5 \(curve\)/.test(r.stderr) && clean(r), r.stderr.trim());
  ok("and it did not touch the page on the way out",
     fs.readFileSync(pagePath, "utf8") === blankPage());

  withSteps({ token: verified(TOK), curve: verified(CRV) });
  r = run([P2], pubEnv());
  ok("with no endpoint and no --offline it refuses rather than publishing unchecked",
     r.status === 1 && /--offline/.test(r.stderr) && clean(r), r.stderr.trim());

  r = run([P2, "--offline"], pubEnv());
  ok("a dry run prints both addresses, checksummed",
     r.status === 0 && r.stdout.includes(TOK) && r.stdout.includes(CRV),
     (r.stderr || r.stdout).slice(0, 300));
  ok("and writes nothing until it is asked to",
     /nothing was written/.test(r.stdout) &&
     fs.readFileSync(pagePath, "utf8") === blankPage());

  r = run([P2, "--offline", "--write"], pubEnv());
  const published = fs.readFileSync(pagePath, "utf8");
  ok("--write fills the constants the page reads its addresses out of", r.status === 0 &&
     new RegExp(`^const SNOOZE_CURVE = "${CRV}";$`, "m").test(published) &&
     new RegExp(`^const SNOOZE_TOKEN = "${TOK}";$`, "m").test(published) &&
     new RegExp(`^const TOKEN = "${TOK}";`, "m").test(published),
     (r.stderr || r.stdout).slice(0, 300));
  ok("and leaves the LAPTOP launch's own constants alone, which are not this sequence's",
     /^const POOL {2}= "";/m.test(published) && /^const LAPTOP_CURVE = "";$/m.test(published));
  ok("and the checksummed form is what landed, not the lower-case one the state holds",
     published.includes(CRV) && !published.includes(CRV.toLowerCase()));

  r = run([P2, "--offline", "--write"], pubEnv());
  ok("running it twice is not an error and not a second edit", r.status === 0 &&
     /already/.test(r.stdout) && fs.readFileSync(pagePath, "utf8") === published);

  // Republishing a page over a DIFFERENT live address is a much bigger event than filling in a
  // blank, and it should not look the same. A launch that moved has to say so in a commit.
  withSteps({ token: verified(TOK), curve: verified(ABI.toChecksum("0x" + "12".repeat(20))) });
  r = run([P2, "--offline", "--write"], pubEnv());
  ok("it refuses to quietly point a live page at a different curve",
     r.status === 1 && /already/.test(r.stderr) && clean(r), r.stderr.trim());
  ok("and the page still says what it said", fs.readFileSync(pagePath, "utf8") === published);

  // The read client grew an eighth method for this. It is a read, and the point of an
  // allowlist is that nobody has to take that on trust — so the SET is what is read here,
  // not the file, whose header names the send methods in prose in order to disclaim them.
  const allowed = (R("deploy/scripts/lib/rpc.mjs")
                    .match(/const ALLOWED = new Set\(\[[^\]]*\]\)/) || [""])[0];
  ok("the endpoint client can count a wallet's transactions",
     /eth_getTransactionCount/.test(allowed), allowed);
  ok("and its read set still contains nothing that could send one",
     allowed.length > 0 && !/send|sign/i.test(allowed), allowed);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
