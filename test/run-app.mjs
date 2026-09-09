// Tests for app/index.html — the buy page.
//
// It is the only page in this repository that asks a stranger for a signature, and it asks
// for one that spends their money. So the parts that decide WHAT gets signed are pulled out
// and run here: the selectors, the decimal conversion, and the address encoding.
//
// The decimal conversion is the one that would go wrong quietly. `parseFloat("0.1") * 1e18`
// is 100000000000000000 by luck and 99999999999999998 for numbers a wallet will happily show
// somebody as "0.099999999999999998 ETH" — so it is done in integers, and checked against
// values chosen to break a float.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import * as ABI from "../deploy/scripts/lib/abi.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { if (c) { pass++; results.push("  ok   " + n); }
  else { fail++; results.push("  FAIL " + n + (x ? "\n         " + x : "")); } };

const page = R("app/index.html");

/* ─────────────────────────────────────────────── it is not, and cannot be, part of the site ── */
console.log("── the buy page is outside web/, for the same reason the deploy button is");
{
  const SIGNING = /eth_sendTransaction|eth_sendRawTransaction|personal_sign|eth_signTypedData/;
  ok("app/index.html exists", fs.existsSync(path.join(ROOT, "app", "index.html")));
  ok("and it is not inside web/", !fs.existsSync(path.join(ROOT, "web", "buy-snooze.html")));
  ok("it really does sign, which is why it had to go outside", SIGNING.test(page));
  // The whole point of the exile: every page the site serves keeps its promise.
  for (const f of fs.readdirSync(path.join(ROOT, "web")).filter(f => f.endsWith(".html")))
    ok(`web/${f} still contains no signing method`, !SIGNING.test(R("web/" + f)));
  const vercel = JSON.parse(R("vercel.json"));
  ok("vercel publishes web/, so app/ is not served from the main site",
     vercel.outputDirectory === "web", JSON.stringify(vercel.outputDirectory));
  ok("and it says on its face why it is not on the site",
     /would delete that property for all nine pages/.test(page));
  // No endpoint that needs a key, on a page anybody can view-source.
  const urls = (page.match(/https?:\/\/[^\s"'<>)]+/g) || [])
    .filter(u => !/^https:\/\/(mainnet\.base\.org|basescan\.org|snoozebear\.xyz)/.test(u));
  ok("it reaches no host but Base, Basescan and the site", urls.length === 0, urls.join(", "));
  ok("and carries no key material",
     !/[A-Za-z0-9_-]{32,}\/v2\/|api[_-]?key|alchemy|infura/i.test(page));
}

/* ───────────────────────────────────────────────────────── what actually gets signed ──────── */
console.log("── the bytes it would ask a stranger to sign");
const B = (() => {
  const m = page.match(/<script>\n"use strict";([\s\S]*)<\/script>/);
  if (!m) return null;
  const stub = () => ({ addEventListener() {}, style: {}, dataset: {}, textContent: "",
                        value: "", className: "", hidden: false, innerHTML: "" });
  return new Function("window", "document", "fetch", "navigator", "location",
    "setTimeout", "clearTimeout",
    m[1].replace(/refresh\(\);\s*$/, "return window.__BUY;"))(
    {}, { getElementById: stub, querySelectorAll: () => [] },
    () => {}, {}, {}, () => {}, () => {});
})();
{
  ok("the page's logic runs outside a browser, which is what lets it be tested", !!B);
  if (B) {
    const wrong = [];
    for (const [sig, sel] of Object.entries(B.SEL))
      if (ABI.selector(sig) !== sel) wrong.push(`${sig}: page ${sel}, keccak ${ABI.selector(sig)}`);
    ok(`all ${Object.keys(B.SEL).length} selectors it hardcodes are keccak of their signature`,
       wrong.length === 0, wrong.join("; "));
    // The two that spend money, byte for byte against the encoder the launch itself used.
    const me = "0x4296e9A65582358221EEd0e9A2B4EC94ad4F5929";
    const mine = B.callData("buy(uint256,address)", B.word(1234n) + B.addressWord(me));
    const theirs = ABI.selector("buy(uint256,address)") + ABI.word(1234n) + ABI.addressWord(me);
    ok("a buy encodes exactly as deploy/scripts/lib/abi.mjs encodes it",
       ABI.strip(mine) === ABI.strip(theirs), `${mine}\n         ${theirs}`);
    const s1 = B.callData("sell(uint256,uint256)", B.word(5n) + B.word(6n));
    ok("and a sell does too",
       ABI.strip(s1) === ABI.strip(ABI.selector("sell(uint256,uint256)") + ABI.word(5n) + ABI.word(6n)));
    let threw = false;
    try { B.addressWord("0x4296e9A65582358221EEd0e9A2B4EC94ad4F592"); } catch { threw = true; }
    ok("a 39-character address is refused rather than padded into a different one", threw);

    // THE CONVERSION. Every one of these is a number a float gets wrong.
    const U = (s) => B.toUnits(s, 18);
    ok("0.1 ETH is exactly 1e17 wei, which parseFloat is not", U("0.1") === 10n ** 17n, String(U("0.1")));
    ok("and 0.07 is exact too", U("0.07") === 7n * 10n ** 16n, String(U("0.07")));
    ok("and 1.005", U("1.005") === 1005n * 10n ** 15n, String(U("1.005")));
    ok("a whole number needs no point", U("2") === 2n * 10n ** 18n);
    ok("and a leading point is allowed, because people type it", U(".5") === 5n * 10n ** 17n);
    ok("commas are stripped rather than parsed as a decimal", U("1,000") === 1000n * 10n ** 18n);
    ok("more decimals than the token has are truncated, not rounded up past the balance",
       U("0.1234567890123456789") === 123456789012345678n, String(U("0.1234567890123456789")));
    for (const junk of ["", ".", "abc", "1.2.3", "-1", "1e18", " "])
      ok(`"${junk}" is refused rather than becoming a number`, U(junk) === null, String(U(junk)));
    // And back again, because the number on screen is what somebody decides on.
    ok("1e17 wei reads back as 0.1", B.fromUnits(10n ** 17n, 18, 4) === "0.1", B.fromUnits(10n ** 17n, 18, 4));
    ok("a big balance is grouped so it can be read",
       B.fromUnits(1234567n * 10n ** 18n, 18, 0) === "1,234,567",
       B.fromUnits(1234567n * 10n ** 18n, 18, 0));
    ok("and a round-trip through both is the identity",
       U(B.fromUnits(123456789012345678n, 18, 18).replace(/,/g, "")) === 123456789012345678n);
  }
}

/* ──────────────────────────────────────────────────── what it says, and what it refuses to ── */
console.log("── it says the things a buyer finds out the hard way otherwise");
{
  ok("it names the address as the thing to check",
     /this is the address to paste anywhere/i.test(page));
  ok("it warns that a plain send reverts, which is the common way to lose money here",
     /[Nn]ever send ETH straight to the contract/.test(page));
  ok("it discloses the fee on both sides", /1% fee, in ETH, on the way in/.test(page) &&
     /1% fee on the way out/.test(page));
  ok("it discloses the daily cap before somebody hits it",
     /no wallet may move more than 20%/i.test(page));
  ok("and that selling is two transactions, not one",
     /approve, then sell/i.test(page));
  ok("it says outright that nothing is burned on a sale",
     /oracle answers "not ready" forever/.test(page));
  ok("and that one wallet is outside the cap",
     /outside the daily cap/.test(page) && /public on chain/.test(page));
  ok("it protects a buy with a floor rather than accepting any price",
     /minOut/.test(page) && /98n\) \/ 100n/.test(page));
  ok("and says why zero would be worse", /sandwich/.test(page));
}

/* ───────────────────────────────────────────────────────────────── it renders and works ───── */
console.log("── it loads, reads a chain, and refuses a curve that is not this one");
{
  const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
                  "/opt/pw-browsers/chromium/chrome-linux/chrome"].find(p => fs.existsSync(p));
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const w = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
  const TOKEN = "0xCafFf33E2972C3F3927Def575Fc7C8ed06eD1d47";

  const load = async (answers) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const p = await ctx.newPage();
    const errs = []; p.on("pageerror", e => errs.push(e.message));
    await p.route("**/*", async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = JSON.parse(req.postData() || "{}");
        const sel = ((body.params || [])[0] || {}).data || "";
        const key = Object.keys(answers).find(k => sel.startsWith(k));
        return route.fulfill({ contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id,
                                 result: key ? answers[key] : w(0) }) });
      }
      return route.fulfill({ contentType: "text/html", body: page });
    });
    await p.goto("http://buy.test/", { waitUntil: "load" });
    await p.waitForTimeout(700);
    return { p, ctx, errs };
  };

  const good = {
    "0xe88dc357": w(0),                                          // bonded() false
    "0x899b1528": w(5n * 10n ** 18n),                            // reserveEth 5
    "0x485735c8": w(21622776601683793319n),                      // bondTarget
    "0x9c533f66": w(22500),                                      // 2.25x
    "0xfc0c546a": "0x" + TOKEN.slice(2).toLowerCase().padStart(64, "0"),
    "0x4beb394c": w(1234n * 10n ** 18n),                         // quoteBuy
  };
  {
    const { p, errs } = await load(good);
    ok("it renders with no page errors", errs.length === 0, errs.slice(0, 2).join("; "));
    ok("the curve reads as live", (await p.textContent("#cBadge")) === "live");
    ok("and the token it sells is checked against the one the page names",
       (await p.textContent("#vBadge")) === "matches");
    ok("the price multiple is shown as a multiple", (await p.textContent("#mPrice")) === "2.25×",
       await p.textContent("#mPrice"));
    ok("the raise is shown against the target",
       (await p.textContent("#mRaised")).startsWith("5") &&
       (await p.textContent("#mTarget")).startsWith("21.62"),
       await p.textContent("#mRaised"));
    const width = await p.$eval("#mBar", e => e.style.width);
    ok("and the bar is the fraction of the way there, not a guess",
       Math.abs(parseFloat(width) - 23.12) < 0.2, width);
    ok("the quote appears without a wallet, because a price is a read",
       (await p.textContent("#tokOut")) === "1,234", await p.textContent("#tokOut"));
    ok("but the buy button will not arm until a wallet is connected",
       await p.$eval("#doBuy", e => e.disabled));
    ok("and says so rather than looking broken",
       (await p.textContent("#doBuy")) === "Connect a wallet first");
  }
  {
    // The clone case: a page serving a curve that sells something else.
    const { p } = await load({ ...good, "0xfc0c546a": w(BigInt("0x" + "de".repeat(20))) });
    ok("a curve selling a different token is refused, not sold",
       (await p.textContent("#vBadge")) === "MISMATCH");
    ok("and the buy button is disabled with the reason on screen",
       (await p.$eval("#doBuy", e => e.disabled)) &&
       /Do not buy/.test(await p.textContent("#buyMsg")));
  }
  {
    const { p } = await load({ ...good, "0xe88dc357": w(1) });
    ok("once it has bonded the page stops offering the curve",
       (await p.textContent("#cBadge")) === "bonded" &&
       (await p.$eval("#doBuy", e => e.disabled)));
    ok("and says where it went instead",
       /Uniswap pool and the LP was burned/.test(await p.textContent("#mNote")));
  }
  {
    // A node that will not answer. The page must say so, not show a zero.
    const { p, errs } = await load({});
    ok("an unreadable chain is not rendered as a price of zero",
       (await p.textContent("#mPrice")) === "—" || (await p.textContent("#cBadge")) !== "live",
       await p.textContent("#mPrice"));
    ok("and it still does not throw", errs.length === 0, errs.slice(0, 2).join("; "));
  }
  await browser.close();
}

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
