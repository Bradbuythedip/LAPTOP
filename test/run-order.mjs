// Tests for web/order.html — the standing-order page. It reads nothing and signs nothing, so
// the suite is about two things: the arithmetic being right, and the promises being honest.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { if (c) { pass++; results.push("  ok   " + n); }
  else { fail++; results.push("  FAIL " + n + (x ? "\n         " + x : "")); } };
const near = (n, g, w, tol) => ok(n, Math.abs(g - w) <= (tol ?? 1e-12) * Math.max(1, Math.abs(w)),
  `got  ${g}\n         want ${w}`);

const site = http.createServer((req, res) => {
  const rel = (req.url || "/").split("?")[0];
  const f = path.join(ROOT, "web", rel === "/" ? "index.html" : rel.replace(/^\//, ""));
  const target = (!fs.existsSync(f) && f.endsWith("bg.png"))
    ? path.join(ROOT, "test", "fixture-bg.png") : f;
  fs.readFile(target, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": f.endsWith(".png") ? "image/png" : "text/html; charset=utf-8" });
    res.end(d);
  });
});
await new Promise(r => site.listen(0, r));
const SITE = "http://127.0.0.1:" + site.address().port;

const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
                "/opt/pw-browsers/chromium/chrome-linux/chrome"].find(p => fs.existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [], requests = [];
page.on("pageerror", e => pageErrors.push(e.message));
page.on("request", r => requests.push(r.url()));
await page.goto(SITE + "/order.html", { waitUntil: "networkidle" });
const txt = async s => (await page.textContent(s).catch(() => "")) || "";
const src = fs.readFileSync(path.join(ROOT, "web", "order.html"), "utf8");
const set = async (id, v) => {
  await page.fill("#" + id, String(v));
  await page.waitForTimeout(60);
};

console.log("── it cannot take custody, and originates nothing on load");
const external = requests.filter(u => !u.startsWith(SITE));
ok("no request leaves the origin on load", external.length === 0, external.join(", "));
ok("no fetch, XHR or websocket anywhere", !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(src));
ok("the ceiling arithmetic still needs no wallet",
   /feeFloor|minCeiling/.test(src) && !/\bfetch\s*\(/.test(src));
ok("connects to Phantom when asked", /eth_requestAccounts/.test(src));
ok("uses Phantom's EVM side — the Solana one cannot see Base",
   /p\.ethereum/.test(src) && /window\.phantom/.test(src));
ok("no signing of any kind",
   !/signTypedData|_signTypedData|personal_sign|signTransaction|privateKey|mnemonic/i.test(src));
ok("no transaction construction",
   !/eth_sendRawTransaction|eth_sendTransaction|ContractFactory/i.test(src));
// Collapse whitespace before matching prose: the assertion is about what the page says, not
// about where the source happens to wrap.
const flat = (await txt("body")).replace(/\s+/g, " ");
ok("says it does not ask you to sign", flat.includes("does not ask you to sign"));
ok("says outright it cannot place the order", flat.includes("cannot place an order"));
ok("names the deposit pitch it will never make", flat.includes("reserve your allocation"));
ok("still tells the reader a deposit request means it is not this page",
   flat.includes("close it"));

console.log("── the promise it refuses to make");
const body = (await txt("body")).replace(/\s+/g, " ");
ok("says outright that a fill cannot be guaranteed", /No standing order can guarantee a fill/i.test(body));
ok("names the trade as two opposites", /opposites/i.test(body));
ok("calls a promised guaranteed fill a lie", /is lying/i.test(body));
ok("calls no-fill a normal outcome, not a failure", /normal outcome, not a failure/i.test(body));
const urging = body.replace(/no opinion on whether you should buy[^.]*\./i, "");
ok("never urges anyone to buy", !/\bbuy now\b|\byou should buy\b|\bdon.t miss\b|\bape\b/i.test(urging));
ok("has no opinion on the token", /no opinion on whether you should buy/i.test(body));
ok("says the funds never move until the fill", /never move until the fill/i.test(body));
ok("corrects the mental model of withdrawing", /is not a withdrawal/i.test(body));

console.log("── approval discipline is stated, not implied");
ok("names the approval as the real risk", /genuinely at risk is the approval/i.test(body));
ok("says approve the exact amount", /the exact amount of the order/i.test(body));
ok("warns against unlimited approvals", /never .{0,3}unlimited/i.test(body));

console.log("── the ceiling formula, against an independent implementation");
// Reference, written from the pool identity rather than from the page's algebra:
// out = T*S'/(E+S') with S' = S(1-f); effective price = S/out; seed price = E/T.
const refCeiling = (S, E, f) => {
  const T = 1e9;                      // any token side; it cancels
  const Sp = S * (1 - f);
  const out = T * Sp / (E + Sp);
  return (S / out) / (E / T);
};
const api = async (fn, ...a) =>
  page.evaluate(([f, args]) => window.__LAPTOP_ORDER[f](...args), [fn, a]);

for (const [S, E, ppm] of [[1, 100, 3000], [2500, 40000, 3000], [10, 10, 500],
                           [0.5, 1000, 10000], [7, 3, 10000], [1e-6, 5, 500]]) {
  near(`ceiling matches the pool identity at S=${S} E=${E} fee=${ppm}`,
       await api("minCeiling", S, E, ppm), refCeiling(S, E, ppm / 1e6), 1e-12);
}
near("the fee floor is 1/(1-f)", await api("feeFloor", 3000), 1 / (1 - 0.003));
near("a zero-size order still pays the fee floor",
     await api("minCeiling", 0, 1000, 3000), 1 / (1 - 0.003));
ok("an order the size of the whole quote side costs more than double",
   (await api("minCeiling", 100, 100, 3000)) > 2);

console.log("── splitting costs slightly more, which is why the page says so");
// Four quarter-sized buys against an untouched pool must total exactly one whole-sized buy.
const cpOut = (S, E, T, f) => { const s = S * (1 - f); return T * s / (E + s); };
{
  // The fee stays in the pool, so each tranche deepens it against the next one. Splitting is
  // therefore slightly WORSE than one order, not free and certainly not cheaper.
  const E0 = 40000, T0 = 1e12, f = 0.003, S = 4000;
  const split = n => {
    let e = E0, t = T0, total = 0;
    for (let i = 0; i < n; i++) { const o = cpOut(S / n, e, t, f); total += o; e += S / n; t -= o; }
    return total;
  };
  const oneShot = cpOut(S, E0, T0, f);
  near("one tranche is the same as not splitting", split(1), oneShot, 1e-12);
  ok("splitting yields strictly less, never more", split(4) < oneShot);
  ok("slicing finer keeps costing more, not less", split(100) < split(10) && split(10) < split(4));
  const penalty = 1 - split(4) / oneShot;
  ok("the four-way penalty is about a hundredth of a percent",
     penalty > 5e-5 && penalty < 2e-4, String(penalty));
  // Two laws the page states, checked rather than asserted: n tranches pay (1-1/n) of a
  // ceiling, and that ceiling is about half the fee times your share while the share is small.
  const L = 1 - split(200000) / oneShot;
  ok("the penalty converges rather than running away", L < 2e-4, String(L));
  for (const n of [2, 4, 10, 100]) {
    const pn = 1 - split(n) / oneShot;
    ok(`${n} tranches pay (1 - 1/${n}) of the ceiling`,
       Math.abs(pn / L - (1 - 1 / n)) < 0.02, String(pn / L));
  }
  ok("four tranches pay three quarters of it",
     Math.abs(penalty / L - 0.75) < 0.02, String(penalty / L));
  // The rule of thumb is about the ceiling, not about four tranches — and only for small shares.
  const ceilingOf = (E0b, Sb, fb) => {
    const one = cpOut(Sb, E0b, T0, fb);
    let e = E0b, t = T0, tot = 0;
    for (let i = 0; i < 200000; i++) { const o = cpOut(Sb / 200000, e, t, fb); tot += o; e += Sb / 200000; t -= o; }
    return 1 - tot / one;
  };
  {
    const small = ceilingOf(40000, 400, 0.003);       // share 1%
    ok("at a small share the ceiling is half the fee times the share",
       Math.abs(small / (0.003 * 0.01 / 2) - 1) < 0.02, String(small));
    const big = ceilingOf(40000, 40000, 0.003);       // share 100%
    ok("at a large share that rule over-predicts, as the page's caveat says",
       big < 0.003 * 1 / 2 * 0.5, String(big));
  }
  ok("the page states the (1 - 1/n) bound",
     src.includes("(1&nbsp;&minus;&nbsp;1/n) of a ceiling"));
  ok("the page limits the rule of thumb to small shares",
     /while your share is small/i.test(body));
  ok("the page says splitting costs more, not nothing",
     /splitting costs you slightly more, not less/i.test(body));
  ok("the page quantifies it", /0\.01% behind/i.test(body));
  ok("the page says slicing finer never helps", /Slicing finer never helps/i.test(body));
  ok("the page does not claim path-independence", !/path-independent/i.test(body));
  ok("while still giving the real reason to split", /caps the damage from one bad print/i.test(body));
  ok("and frames it as insurance rather than a discount", /not as a discount/i.test(body));
}

console.log("── max fillable size inverts the ceiling");
for (const [E, C, ppm] of [[40000, 1.5, 3000], [1000, 1.05, 500], [500, 2, 10000]]) {
  const max = await api("maxFillable", E, C, ppm);
  near(`the largest order at a ${C}x ceiling fills exactly at it (E=${E}, fee=${ppm})`,
       await api("minCeiling", max, E, ppm), C, 1e-12);
}
ok("a ceiling under the fee floor admits nothing",
   (await api("maxFillable", 40000, 1.0005, 3000)) === 0);
ok("a ceiling below 1 admits nothing", (await api("maxFillable", 40000, 0.9, 3000)) === 0);

console.log("── the page renders those numbers, and grades them");
await set("spend", 2500); await set("depth", 40000);
const out1 = await txt("#outRows");
ok("the minimum ceiling is shown", /1\.0656×|1\.0655×|1\.0657×/.test(out1), out1);
ok("the fee share and the size share are separated",
   out1.includes("the pool fee is") && out1.includes("your own size is"));
ok("a small order is graded good",
   (await page.getAttribute("#sizeBadge", "class")).includes("good"));

await set("spend", 20000);
ok("a half-the-pool order is graded bad",
   (await page.getAttribute("#sizeBadge", "class")).includes("bad"));
ok("and is told it is setting the price, not taking it",
   (await txt("#outNote")).includes("not taking the price, you are setting it"));

await set("spend", 4000);
ok("an eighth of the pool is graded a warning",
   (await page.getAttribute("#sizeBadge", "class")).includes("warn"));

console.log("── the depth is a guess, so a range is always shown");
await set("spend", 2500); await set("depth", 40000);
const rows = await page.$$eval("#sensBody tr", rs => rs.map(r =>
  [...r.querySelectorAll("td")].map(t => t.textContent)));
ok("six depth scenarios are listed", rows.length === 6, String(rows.length));
ok("the row matching the guess is marked",
   (await page.$$eval("#sensBody tr.here", rs => rs.length)) === 1);
ok("the guess row says so", rows.some(r => r[0].includes("your guess")));
{
  const ceilCol = rows.map(r => parseFloat(r[2]));
  ok("a shallower pool always needs a higher ceiling",
     ceilCol.every((v, i) => i === 0 || v <= ceilCol[i - 1] + 1e-9), ceilCol.join(" "));
}

console.log("── the inverse box");
await set("ceil", 1.5);
ok("a workable ceiling gives a size", /[\d,]/.test(await txt("#ceilOut")));
ok("and says what it assumed about the depth", (await txt("#ceilOut")).includes("quote side"));
await set("ceil", 1.001);
ok("a ceiling under the fee floor is refused outright",
   (await txt("#ceilOut")).includes("Nothing can fill under this ceiling"));
ok("and blames the ceiling rather than the size",
   (await txt("#ceilOut")).includes("size is not the problem"));
await set("ceil", "");
ok("an empty ceiling asks rather than computes", (await txt("#ceilOut")).includes("Enter a ceiling"));

console.log("── bad input never becomes a number");
await set("ceil", 1.5);
await set("depth", 0);
ok("a zero depth computes nothing", (await txt("#outNote")).includes("Enter a spend"));
await set("depth", -5);
ok("a negative depth computes nothing", (await txt("#outNote")).includes("Enter a spend"));
await set("depth", "abc");
ok("a non-numeric depth computes nothing", (await txt("#outNote")).includes("Enter a spend"));
await set("depth", 40000); await set("spend", -1);
ok("a negative spend computes nothing", (await txt("#outNote")).includes("Enter a spend"));
await set("spend", "40,000");
ok("a thousands separator is accepted rather than rejected",
   !(await txt("#outNote")).includes("Enter a spend"));

console.log("── it hands off, it does not host");
ok("both venues are external links", /target="_blank"/.test(src));
ok("links carry no referrer and no follow", /rel="noopener noreferrer nofollow"/.test(src));
const cow = await page.getAttribute("#cowLink", "href");
const oneinch = await page.getAttribute("#oneInchLink", "href");
ok("the CoW link is to cow.fi over https", /^https:\/\/swap\.cow\.fi\//.test(cow), cow);
ok("the 1inch link is to 1inch.io over https", /^https:\/\/app\.1inch\.io\//.test(oneinch), oneinch);
ok("both links name Base by chain id", cow.includes("8453") && oneinch.includes("8453"));
ok("both links carry the LAPTOP address",
   cow.toLowerCase().includes("0xb095274743941e953c746f9c228da9c18bb6ec29")
   && oneinch.toLowerCase().includes("0xb095274743941e953c746f9c228da9c18bb6ec29"));
ok("the address is printed for character-by-character comparison",
   (await txt("#caLine")).toLowerCase() === "0xb095274743941e953c746f9c228da9c18bb6ec29");
ok("the links are marked unverified from here", /verified none of the links/i.test(body));
ok("every link is paired with a manual recipe", /manual recipe/i.test(body));
// This asserted href="/" and was named for the checker. Those were the same link only for as
// long as the checker was the front page; it has not been since the buy screen moved there,
// and the assertion went on passing while testing something else. It now tests its own name.
ok("the reader is sent to the checker before pasting", src.includes('href="/checker.html"'));

console.log("── cancelling and notification are described without overclaiming");
ok("the cancel race is admitted", /Cancelling is a race/i.test(body));
ok("the asterisk on withdraw-anytime is named", /has an asterisk/i.test(body));
ok("revoking the approval is part of the cancel path", /Revoke the approval/i.test(body));
ok("it admits it cannot notify you itself", /cannot tell you/i.test(body));
ok("and warns about the fake-fill message", /click to claim/i.test(body));
ok("noting a real fill needs nothing from you", /a real fill needs nothing from you/i.test(body));

console.log("── the failure modes are stated, led by the likeliest");
ok("unindexed liquidity is named as the likeliest killer", /may not be in that set/i.test(body));
ok("and marked as such", /most likely way you end up with nothing/i.test(body));
ok("transfer taxes are named", /transfer tax/i.test(body));
ok("a forgotten expiry plus a forgotten approval is named", /still backed by an approval you forgot/i.test(body));
ok("the fee floor is quoted inline", (await txt("#floorInline")).startsWith("1.00"));

console.log("── one token, and only one");
ok("no other ticker appears", !/\$TWD|POT ?PAL|POTPAL/i.test(src));
ok("LAPTOP is named", body.includes("LAPTOP"));

console.log("── layout");
ok("no horizontal scroll at 375px",
   (await page.evaluate(() => document.documentElement.scrollWidth)) <= 375);
ok("the wide table scrolls inside its own container",
   /class="scroll"/.test(src) && /overflow-x:auto/.test(src));
ok("no page errors", pageErrors.length === 0, pageErrors.join("; "));

await browser.close(); site.close();
console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
