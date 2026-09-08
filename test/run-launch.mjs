// Test suite for web/launch.html. The page tells whoever sets the launch parameters what a fee
// design earns and what it costs the people buying, so the two ways it could lie are: overstate
// the take, or understate what a buyer pays. Both are checked against arithmetic written here
// rather than against the page's own algebra.
//   node test/run-launch.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push("  ok   " + name); }
  else { fail++; results.push("  FAIL " + name + (extra ? "\n         " + extra : "")); }
}
const close = (name, got, want, tol) =>
  ok(name, Math.abs(got - want) <= tol, `got ${got}, want ${want} (±${tol})`);

const site = http.createServer((req, res) => {
  const f = path.join(ROOT, "web", req.url === "/" ? "index.html" : req.url.split("?")[0]);
  const target = (!fs.existsSync(f) && f.endsWith("bg.png"))
    ? path.join(ROOT, "test", "fixture-bg.png") : f;
  fs.readFile(target, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": f.endsWith(".png") ? "image/png" : "text/html; charset=utf-8" });
    res.end(d);
  });
}).listen(0);
const SITE = "http://127.0.0.1:" + site.address().port;

const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
                "/opt/pw-browsers/chromium/chrome-linux/chrome"].find(p => fs.existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [], requests = [];
page.on("pageerror", e => pageErrors.push(e.message));
page.on("request", r => requests.push(r.url()));
await page.goto(SITE + "/launch.html", { waitUntil: "networkidle" });
const txt = async s => (await page.textContent(s).catch(() => "")) || "";
const src = fs.readFileSync(path.join(ROOT, "web", "launch.html"), "utf8");
const body = (await txt("body")).replace(/\s+/g, " ");

console.log("── it configures nothing and reaches nowhere");
const external = requests.filter(u => !u.startsWith(SITE));
ok("no request leaves the origin", external.length === 0, external.join(", "));
ok("no fetch, XHR or websocket anywhere", !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(src));
ok("no signing or sending", !/eth_sendTransaction|eth_sendRawTransaction|personal_sign|signTypedData|signTransaction/.test(src));
ok("says it does not ask you to sign", body.includes("does not ask you to sign"));
ok("says outright it deploys nothing", body.includes("does not deploy or configure anything"));
ok("is addressed to the launcher, not to buyers",
   body.includes("for whoever sets the launch parameters, not for buyers"));

// The pool identity, against arithmetic written from the invariant rather than from the page.
console.log("── the pool math is the same constant product the rest of the site uses");
{
  const r = await page.evaluate(() => window.__LAUNCH.buyThrough(10, 1, 1, 0.01, 0));
  // x*y=k with a 1% fee: in_after_fee = 0.99, out = 1*0.99/(10+0.99)
  close("untaxed buy matches x*y=k with the fee taken first",
        r.out, 0.99 / 10.99, 1e-15);
  close("and the pool gains the full amount sent", r.E, 11, 1e-15);
}
{
  const r = await page.evaluate(() => window.__LAUNCH.buyThrough(10, 1, 1, 0, 0.2));
  close("a 20% tax is taken off the top", r.taxPaid, 0.2, 1e-15);
  close("and the pool only ever sees the rest", r.E, 10.8, 1e-15);
  close("so the output prices the net, not the gross", r.out, 0.8 / 10.8, 1e-15);
  close("but the buyer's price is on what they sent", r.price, 1 / (0.8 / 10.8), 1e-12);
}
{
  // A tax must never look free: price with tax strictly worse than price without.
  const [a, b] = await page.evaluate(() => [
    window.__LAUNCH.buyThrough(10, 1, 0.5, 0.01, 0).price,
    window.__LAUNCH.buyThrough(10, 1, 0.5, 0.01, 0.05).price,
  ]);
  ok("a taxed buy always prices worse than an untaxed one", b > a, `${b} vs ${a}`);
}

console.log("── the tax schedule");
{
  const t = await page.evaluate(() => {
    const T = window.__LAUNCH.taxAt;
    return [T(0, .01, .01, .10), T(100, .01, .01, .10), T(250, .01, .01, .10),
            T(5000, .01, .01, .10), T(0, .02, 0, .10)];
  });
  close("starts where you set it", t[0], .01, 1e-15);
  close("adds a step per 100 buys", t[1], .02, 1e-15);
  close("and does so continuously, not in jumps", t[2], .035, 1e-15);
  close("never exceeds the cap however long it runs", t[3], .10, 1e-15);
  close("a zero step is a flat tax", t[4], .02, 1e-15);
}

console.log("── deterrence, which is the assumption and is labelled as one");
ok("the page says the sensitivity number is a guess",
   body.includes("That last number is a guess, not a measurement"));
ok("and says which way it matters",
   body.includes("the one input the answer is genuinely sensitive to"));
{
  const d = await page.evaluate(() => {
    const D = window.__LAUNCH.demandAt;
    return [D(400, 0, 6), D(400, 10, 6), D(400, 100, 6), D(400, 50, 100)];
  });
  close("a zero tax deters nobody", d[0], 400, 1e-9);
  close("10% tax at 6%/pt keeps 40% of them", d[1], 400 * 0.4, 1e-9);
  ok("demand can reach zero but never goes negative", d[2] === 0 && d[3] === 0);
}

console.log("── the take has a maximum, and the page finds it rather than asserting one");
{
  const s = await page.evaluate(() => window.__LAUNCH.sweep(
    { seedE: 10, poolFee: .01, buySize: .25, nBuys: 400,
      tax0: .01, taxStep: .01, taxCap: .10, sellTax: .05, walk: 6 }, 0, 25, 1));
  ok("a zero tax is not the best answer", s.best.tax0 > 0, `best ${s.best.tax0}`);
  ok("neither is the highest tax on offer", s.best.tax0 < 25, `best ${s.best.tax0}`);
  const zero = s.rows.find(r => r.tax0 === 0), top = s.rows.find(r => r.tax0 === 25);
  ok("the optimum beats charging nothing", s.best.take > zero.take);
  ok("the optimum beats charging the most", s.best.take > top.take);
  ok("buyer count falls monotonically as the tax rises",
     s.rows.every((r, i) => i === 0 || r.n <= s.rows[i - 1].n));
  ok("take rises then falls — it is a hump, not a ramp",
     s.rows.some(r => r.tax0 > s.best.tax0 && r.take < s.best.take));
}
{
  // Demand moves the optimum, and it moves it *down*: the more volume you expect, the less a
  // buy tax is worth, because the pool fee and sell tax already collect on that volume while
  // the buy tax only deters it. The page claimed the opposite in an earlier draft — that the
  // best rate was scale-invariant — and this is the assertion that caught it.
  const best = await page.evaluate(() => {
    const base = { seedE: 10, poolFee: .01, buySize: .25, tax0: .01, taxStep: .01,
                   taxCap: .10, sellTax: .05, walk: 6 };
    return [40, 100, 400, 1000, 4000].map(nBuys =>
      window.__LAUNCH.sweep({ ...base, nBuys }, 0, 25, 1).best.tax0);
  });
  ok("the best buy tax never rises as expected demand rises",
     best.every((v, i) => i === 0 || v <= best[i - 1]), best.join(" → "));
  ok("a thin launch does want a buy tax", best[0] > 0, `${best[0]}`);
  ok("a busy one wants none", best[best.length - 1] === 0, `${best[best.length - 1]}`);
  ok("and the take still grows with demand even as the best rate falls",
     await page.evaluate(() => {
       const base = { seedE: 10, poolFee: .01, buySize: .25, tax0: .01, taxStep: .01,
                      taxCap: .10, sellTax: .05, walk: 6 };
       const t = [40, 400, 4000].map(nBuys =>
         window.__LAUNCH.sweep({ ...base, nBuys }, 0, 25, 1).best.take);
       return t[0] < t[1] && t[1] < t[2];
     }));
}
{
  // The page must say this out loud, not just compute it — it is the finding that most
  // changes what someone would actually configure.
  ok("the page says the best buy tax falls as demand rises",
     body.includes("the best buy tax falls as you expect more demand"));
}
{
  // More price-sensitive buyers must mean a lower optimal tax. If this inverted, the page
  // would be advising people to punish exactly the buyers most likely to leave.
  const best = await page.evaluate(() => [2, 6, 16].map(walk =>
    window.__LAUNCH.sweep(
      { seedE: 10, poolFee: .01, buySize: .25, nBuys: 400, tax0: .01, taxStep: .01,
        taxCap: .10, sellTax: .05, walk }, 0, 25, 1).best.tax0));
  ok("touchier buyers push the best tax down",
     best[0] >= best[1] && best[1] >= best[2], best.join(" → "));
}

console.log("── nothing that comes out of it is free money");
{
  const r = await page.evaluate(() => window.__LAUNCH.simulate(
    { seedE: 10, poolFee: .01, buySize: .25, nBuys: 400,
      tax0: .01, taxStep: .01, taxCap: .10, sellTax: .05, walk: 6 }));
  ok("the take is positive for a sane design", r.take > 0);
  ok("the take never exceeds what buyers actually spent",
     r.take <= r.n * 0.25 + 1e-9, `take ${r.take} vs spend ${r.n * 0.25}`);
  ok("buy tax, sell tax and pool fees add up to the total",
     Math.abs((r.buyTax + r.sellTaxTake + r.lpFees) - r.take) < 1e-12);
  ok("a tax nobody survives earns nothing, rather than a negative",
     (await page.evaluate(() => window.__LAUNCH.simulate(
       { seedE: 10, poolFee: .01, buySize: .25, nBuys: 400, tax0: .5, taxStep: 0,
         taxCap: .5, sellTax: .05, walk: 50 }).take)) === 0);
}

console.log("── what the buyer is told");
ok("the round trip is quoted", /Round trip at the starting tax/.test(body));
ok("later buyers are shown paying more than the first", /vs first buyer/.test(body));
ok("the buyer can check the numbers against the size curve",
   body.includes("the same arithmetic"));
ok("the page says plainly a tax worsens execution",
   body.includes("Every point of tax is a point of worse execution"));
ok("and that paying you most is not the same as being worth buying",
   body.includes("is not the same as a design people want to buy into"));

console.log("── disclosure");
{
  const d = await txt("#disclosure");
  ok("the disclosure names the buy tax", /Buy tax/.test(d));
  ok("names the sell tax", /Sell tax/.test(d));
  ok("says where the money goes", /paid to the launch wallet/i.test(d));
  ok("says the tax is not burned or redistributed",
     /not burned and not returned to holders/i.test(d));
  ok("tells the reader to verify on chain rather than trust the page",
     /Verify all of this on chain/i.test(d));
  ok("separates the pool fee from the team's cut",
     /paid to liquidity, not to the team/i.test(d));
  ok("the page explains why disclosing at all",
     body.includes("the checker fails its own test"));
}

console.log("── the page reacts to what you type");
{
  await page.fill("#tax0", "0");
  await page.waitForTimeout(120);
  const zeroBadge = await txt("#verdictBadge");
  await page.fill("#tax0", "24");
  await page.waitForTimeout(120);
  const highBadge = await txt("#verdictBadge");
  ok("a zero tax is flagged as leaving money on the table",
     zeroBadge.includes("leaving money"), zeroBadge);
  ok("so is a punitive one", highBadge.includes("leaving money"), highBadge);
  await page.fill("#tax0", "1");
  await page.waitForTimeout(120);
}
{
  await page.fill("#elast", "0");
  await page.fill("#tax0", "25");
  await page.waitForTimeout(120);
  ok("with no deterrence at all the highest tax is optimal, and the page says so",
     (await txt("#verdictBadge")).includes("at the optimum"));
  await page.fill("#elast", "6"); await page.fill("#tax0", "1");
  await page.waitForTimeout(120);
}
{
  await page.fill("#seedE", "abc");
  await page.waitForTimeout(120);
  ok("junk in a field does not blank the page or throw",
     (await txt("#summary")).length > 0 && pageErrors.length === 0);
  await page.fill("#seedE", "10");
  await page.waitForTimeout(120);
}

console.log("── layout and one token");
const sw = await page.evaluate(() => document.documentElement.scrollWidth);
ok("no horizontal scroll at 375px", sw <= 375, "scrollWidth=" + sw);
ok("self-contained, no external scripts or styles",
   !/<script[^>]+src=/i.test(src) && !/<link[^>]+stylesheet/i.test(src));
ok("no other ticker appears", !/\$TWD|POT ?PAL|POTPAL/i.test(src));
ok("LAPTOP is named", body.includes("LAPTOP"));
ok("no page errors during the run", pageErrors.length === 0, pageErrors.join("; "));

await browser.close();
site.close();
console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
