// Put the deployed addresses on the site, out of the launch state rather than out of a person.
//
//   node tools/publish.mjs             # say what it would write and change nothing
//   node tools/publish.mjs --write     # write it, then re-hash the pages in the README
//
// WHAT THIS REPLACES. web/index.html holds the addresses as four `const` lines that are empty
// today, and the last manual step of a launch was "paste the curve and the token into them".
// That is the step where a launch publishes an address off by one character, and a page that
// says "send ETH here" is the worst possible place for that to happen — every other mistake in
// this repository can be corrected in the next block, and this one costs somebody their money.
//
// So nothing is pasted. The addresses come from deploy/launch-state.json, which is only ever
// written after a read-back agreed; they are checksummed on the way in; and before a byte of
// the page changes they are read back ONE MORE TIME off the chain, because a state file is a
// record of what happened and the site is a claim about what is true now:
//
//   · there is code at both addresses
//   · the token's symbol() is what deploy/config.json says it is
//   · the curve's token() is that token — this is the check that catches a curve belonging to
//     somebody else's launch of the same contract, which is a thing anybody can deploy
//   · the token's isPool(curve) is true, so both Snooze rules actually fire on it. Before
//     step 5's setPool, neither rule exists and the page would be inviting buyers into a
//     token that does not yet behave the way the page describes.
//
// Rejected: taking the addresses from the command line. `--curve 0x…` is the paste with extra
// steps, and it would let the site say something the launch never verified.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../deploy/scripts/lib/config.mjs";
import { loadState, stepState, isVerified, STATE_PATH } from "../deploy/scripts/lib/state.mjs";
import { rpcFromEnv, chainFromEnv, NO_ENDPOINT } from "../deploy/scripts/lib/rpc.mjs";
import { toChecksum, sameAddress, selector, addressWord, readAddress, readString, readBool }
  from "../deploy/scripts/lib/abi.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// SNOOZE_PAGE exists for the same reason SNOOZE_CONFIG and SNOOZE_STATE do: a rehearsal has to
// be able to run the real command against a copy. When it is set, the README is NOT re-hashed —
// the hashes describe web/, and stamping them from a rehearsal would publish the wrong ones.
const PAGE = process.env.SNOOZE_PAGE || path.join(ROOT, "web", "index.html");
const REHEARSAL = !!process.env.SNOOZE_PAGE;
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const OFFLINE = args.includes("--offline");

const die = (m) => { console.error("\nrefused  " + m.replace(/\n/g, "\n         ") + "\n");
                     process.exit(1); };

const cfg = loadConfig();
if (cfg.problems.length) die("deploy/config.json:\n" + cfg.problems.map(p => "  · " + p).join("\n"));
const chainId = chainFromEnv();

let state;
try { state = loadState(STATE_PATH, { chainId, owner: cfg.owner }); }
catch (e) { die(e.message); }

for (const id of ["token", "curve"])
  if (!isVerified(state, id))
    die(`step ${id === "token" ? 3 : 5} (${id}) is not verified in ${STATE_PATH}, so there is ` +
        "no address to publish. Run the sequence first — this command only ever repeats what " +
        "the launch already read back.");

const TOKEN = toChecksum(stepState(state, "token").readBack.address);
const CURVE = toChecksum(stepState(state, "curve").readBack.address);

/* ------------------------------------------------------------------ read it back once more */

if (!OFFLINE) {
  const rpc = rpcFromEnv();
  if (!rpc) die(NO_ENDPOINT + "\n\nOr pass --offline, which publishes the recorded addresses " +
                "without confirming that they are still what this page will claim they are.");
  await rpc.requireChain(chainId);

  const view = async (to, sig, argWords = "") => {
    const r = await rpc.call(to, selector(sig) + argWords);
    return r.ok ? r.data : null;
  };
  const fail = [];
  for (const [name, a] of [["token", TOKEN], ["curve", CURVE]])
    if (!(await rpc.code(a))) fail.push(`there is no code at the ${name}'s address ${a}`);
  if (!fail.length) {
    const sym = await view(TOKEN, "symbol()");
    if (readString(sym) !== cfg.token.symbol)
      fail.push(`${TOKEN} calls itself "${readString(sym)}", not "${cfg.token.symbol}"`);
    const owns = await view(CURVE, "token()");
    if (!sameAddress(readAddress(owns), TOKEN))
      fail.push(`the curve at ${CURVE} sells ${readAddress(owns)}, which is not ${TOKEN}. ` +
                "This is somebody else's curve, or the wrong one of yours.");
    const registered = await view(TOKEN, "isPool(address)", addressWord(CURVE));
    if (readBool(registered) !== true)
      fail.push(`isPool(${CURVE}) is false on the token — step 5's setPool has not landed, so ` +
                "NEITHER Snooze rule fires on this curve yet. Publishing now points buyers at " +
                "a token that does not behave the way this page describes.");
  }
  if (fail.length) die("the chain does not agree with " + STATE_PATH + ":\n" +
                       fail.map(f => "  · " + f).join("\n"));
  console.log(`  read back on ${rpc.label}: symbol, curve.token(), isPool — all agree`);
}

/* ------------------------------------------------------- what the page claims about Rule 1 */

// The one thing this command knows that the page cannot read off the chain. With
// oracle.choice "never-ready", ready() is false forever, so Rule 1 never fires — and the page's
// headline, its meta description and its chart all say that selling into a spike burns. A
// never-ready oracle and an observational one with no history yet answer every view
// identically, so no read distinguishes "not yet" from "never"; only the config does. This is
// the last door before the site goes live, so it is the door that refuses.
if (cfg.oracle.choice === "never-ready") {
  const page = fs.readFileSync(PAGE, "utf8");
  const claims = ["Selling into a spike burns", "burns most of what you would have taken"]
    .filter(c => page.includes(c));
  if (claims.length)
    die(`oracle.choice is "never-ready", so Rule 1 will never fire on this token — and ` +
        `${path.relative(ROOT, PAGE)} still says: ${claims.map(c => JSON.stringify(c)).join(", ")}.` +
        "\n\nThat is a promise the contract cannot keep, above a buy button. Change the copy " +
        "first (the haircut card, the meta description and the chart strap all describe Rule 1), " +
        "then run this again. There is no flag to publish it anyway.");
}

/* --------------------------------------------------------------------------- the edit itself */

// Anchored on the whole line, so a constant that is already filled in is a REPLACEMENT and is
// reported as one. A launch republished over a live address is a different and much larger
// event than one that filled in a blank, and the difference should not be invisible.
const page = fs.readFileSync(PAGE, "utf8");
const targets = [
  { name: "SNOOZE_TOKEN", value: TOKEN, re: /^const SNOOZE_TOKEN = "([^"]*)";/m },
  { name: "SNOOZE_CURVE", value: CURVE, re: /^const SNOOZE_CURVE = "([^"]*)";/m },
  // The two short ones the buy card and the balance row read. TOKEN is the same token; POOL is
  // PooledLaunchBuy, which belongs to the LAPTOP launch and is not this sequence's to fill in.
  { name: "TOKEN", value: TOKEN, re: /^const TOKEN = "([^"]*)";(\s*\/\/ Snooze)/m, keep: 2 },
];

let out = page;
const changes = [];
for (const t of targets) {
  const m = out.match(t.re);
  if (!m) die(`web/index.html has no line matching ${t.re} — the page moved and this tool did ` +
              "not. Fix the pattern rather than editing the page by hand.");
  const was = m[1];
  if (was && !sameAddress(was, t.value))
    die(`${t.name} is already ${was} and this would make it ${t.value}. If the launch really ` +
        "moved, empty the constant first, deliberately, in a commit that says why.");
  changes.push({ name: t.name, was, now: t.value, same: sameAddress(was, t.value) });
  out = out.replace(t.re, (full) =>
    full.replace(/"([^"]*)"/, `"${t.value}"`));
}

console.log(`\n── ${WRITE ? "publishing" : "would publish"} to ${path.relative(ROOT, PAGE)}`);
for (const c of changes)
  console.log(`  ${c.name.padEnd(13)} ${c.now}${c.same ? "   (already there)" : ""}`);

if (!WRITE) {
  console.log("\n  nothing was written. Run again with --write.\n");
  process.exit(0);
}
if (out === page) {
  console.log("\n  the page already says exactly this. Nothing written.\n");
  process.exit(0);
}

fs.writeFileSync(PAGE, out);
if (REHEARSAL) {
  console.log(`\n  written to ${PAGE}. SNOOZE_PAGE is set, so the README was left alone.\n`);
  process.exit(0);
}
console.log("\n  written. Re-hashing the pages, because the README publishes their sha256 and a");
console.log("  page that does not match the hash beside it disables the one check a visitor has.");
const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "stamp.mjs")],
                    { stdio: "inherit", cwd: ROOT });
if (r.status !== 0) die("tools/stamp.mjs failed — the page is written but the README is stale.");
console.log("\n  Next: sh test/run-all.sh, then commit web/index.html and README.md together.\n");
