// Test suite for web/launch.html.
//
// The page mirrors launch_model.py. That file is the reference, test_launch_model.py pins its
// properties, and this suite checks the JS agrees with it on a fixture the Python emits. Where
// the two disagree the Python is right — the same arrangement size.html has with
// test_size_math.py.
//
// The page's job changed: it used to recommend a rate. It now reports what a buyer pays
// (arithmetic, no guesses) and refuses to recommend a rate, because across worlds it cannot
// tell apart the optimum spans the whole range. Most of what follows guards that refusal,
// because a page that quietly starts recommending again is the regression that matters.
//   node test/run-launch.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
const flat = async () => (await txt("body")).replace(/\s+/g, " ");

console.log("── it configures nothing and reaches nowhere");
ok("no request leaves the origin", requests.filter(u => !u.startsWith(SITE)).length === 0);
ok("no fetch, XHR or websocket anywhere", !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(src));
ok("no signing or sending",
   !/eth_sendTransaction|eth_sendRawTransaction|personal_sign|signTypedData|signTransaction/.test(src));
ok("says it does not ask you to sign", (await flat()).includes("does not ask you to sign"));
ok("says outright it deploys nothing", (await flat()).includes("does not deploy or configure anything"));

// ---- agreement with the Python reference, on a fixture Python emits ----
console.log("── the page agrees with launch_model.py");
{
  const py = spawnSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from dataclasses import replace
from launch_model import Population, Schedule, simulate, participation, pareto_shape, tax_at
cases = []
pop = Population(volume_eth=100, n_snipe=40, n_organic=360)
for seed in (10.0, 25.0):
    for start in (0.0, 0.02, 0.10):
        for unit in ("buy", "volume", "block"):
            s = Schedule(unit=unit, start=start, step=0.01, step_unit=5.0, cap=0.10, sell=0.05)
            r = simulate(pop, s, seed, 0.01, "treasury")
            cases.append(dict(seed=seed, start=start, unit=unit,
                              buyers=r.buyers, treasury=r.treasury_eth,
                              volume=r.volume, rt=r.round_trip, deterred=r.deterred))
print(json.dumps(dict(
  cases=cases,
  part=[participation(x, 6.0) for x in (0.0, 0.5, 1.0, 1.5, 3.0)],
  shape=pareto_shape(5, 1.8),
  taxes=[tax_at(Schedule(unit="buy", start=0.01, step=0.01, cap=0.10), i, 0.0, 0) for i in range(5)],
)))
`], { encoding: "utf8" });
  ok("the python reference ran", py.status === 0, py.stderr);
  const ref = JSON.parse(py.stdout);

  const jsPart = await page.evaluate(() =>
    [0, 0.5, 1, 1.5, 3].map(x => window.__LAUNCH.participation(x, 6)));
  ref.part.forEach((v, i) =>
    close(`participation matches the reference at pressure ${[0,0.5,1,1.5,3][i]}`,
          jsPart[i], v, 1e-12));

  const jsShape = await page.evaluate(() => window.__LAUNCH.paretoShape(5, 1.8));
  ref.shape.forEach((v, i) => close(`pareto shape[${i}] matches`, jsShape[i], v, 1e-12));

  const jsTax = await page.evaluate(() =>
    [0,1,2,3,4].map(i => window.__LAUNCH.taxAt(
      {unit:"buy",start:0.01,step:0.01,cap:0.10,stepUnit:5,offAfter:0,perBlock:8}, i, 0, 0)));
  ref.taxes.forEach((v, i) => close(`tax_at(buy #${i}) matches`, jsTax[i], v, 1e-15));

  for (const c of ref.cases) {
    const got = await page.evaluate(cc => {
      const pop = {volume:100, nSnipe:40, nOrg:360, snipeShare:0.7, snipeAlpha:1.8,
                   orgAlpha:2.2, snipeBuyKnee:0.06, snipeSellKnee:0.40, orgBuyKnee:0.09,
                   orgSellKnee:0.07, sharpness:6};
      const s = {unit:cc.unit, start:cc.start, step:0.01, stepUnit:5, cap:0.10,
                 sell:0.05, offAfter:0, perBlock:8};
      const r = window.__LAUNCH.simulate(pop, s, cc.seed, 0.01, "treasury");
      return {buyers:r.buyers, treasury:r.treasury, volume:r.volume,
              rt:r.roundTrip, deterred:r.deterred};
    }, c);
    const tag = `seed ${c.seed} start ${c.start} ${c.unit}`;
    ok(`${tag}: buyer count matches the reference`, got.buyers === c.buyers,
       `${got.buyers} vs ${c.buyers}`);
    ok(`${tag}: deterred matches`, got.deterred === c.deterred);
    close(`${tag}: treasury take matches to 1e-9`, got.treasury, c.treasury, 1e-9);
    close(`${tag}: volume matches to 1e-9`, got.volume, c.volume, 1e-9);
    close(`${tag}: round trip matches`, got.rt, c.rt, 1e-12);
  }
}

console.log("── the refusal to recommend, which is the point of the page");
{
  const b = await flat();
  ok("the page says it will not tell you which rate to pick",
     b.includes("why this page will not tell you which rate to pick"));
  ok("it explains that the old 2% was an artifact of a straight-line model",
     b.includes("the answer a straight-line model gives when the real surface is bimodal"));
  ok("it names what would fix it — observed order books",
     b.includes("First-hour order books from comparable Base launches"));
  ok("the guesses are fenced off and labelled as unfitted",
     b.includes("nothing here is fitted") && b.includes("None of these have been fit"));
  ok("and it says why they matter more than the elicited inputs",
     b.includes("the answer depends on them more than on anything you set above"));
  const badge = await txt("#verdictBadge");
  ok("at the defaults the verdict is that there is no recommendation",
     badge.includes("no recommendation"), badge);
  ok("and the verdict explains the bimodality rather than picking a midpoint",
     (await txt("#verdict")).includes("almost never in between"));
}

console.log("── the world sweep actually spans, and is not cosmetic");
{
  const opts = await page.evaluate(() => {
    const pop = {volume:100, nSnipe:40, nOrg:360, snipeShare:0.7, snipeAlpha:1.8, orgAlpha:2.2,
                 snipeBuyKnee:0.06, snipeSellKnee:0.40, orgBuyKnee:0.09, orgSellKnee:0.07,
                 sharpness:6};
    const s = {unit:"volume", start:0, step:0.01, stepUnit:5, cap:0.10, sell:0.05,
               offAfter:0, perBlock:8};
    return window.__LAUNCH.worldSweep(pop, s, 25, 0.01, "treasury");
  });
  ok("81 worlds are swept, not a token few", opts.length === 81, String(opts.length));
  const uniq = [...new Set(opts.map(o => Math.round(o * 100)))].sort((a, b) => a - b);
  ok("the answer genuinely spans, it is not a flat line", uniq.length > 1, uniq.join(","));
  ok("some worlds want no buy tax", opts.some(o => o === 0));
  ok("and some want a substantial one", opts.some(o => o >= 0.07));
  const mid = opts.filter(o => o > 0.005 && o < 0.065);
  ok("almost nothing lands where the old model recommended (1-6%)",
     mid.length <= opts.length * 0.05, `${mid.length} of ${opts.length}`);
}

console.log("── the unit note, because the unit decides who pays");
{
  ok("per-buy is called out as splittable by default text",
     /Ten 1-ETH buys advance it ten times/.test(src));
  await page.selectOption("#unit", "buy");
  await page.waitForTimeout(60);
  ok("choosing per-buy warns that the same money pays 11% split and 2% whole",
     (await flat()).includes("11% split and 2% whole"));
  ok("and the badge marks it splittable", (await txt("#unitBadge")).includes("splittable"));
  await page.selectOption("#unit", "block");
  await page.waitForTimeout(60);
  ok("per-block is described as the only unit without an ordering lottery",
     (await flat()).includes("everyone in the same block pays the same rate"));
  await page.selectOption("#unit", "volume");
  await page.waitForTimeout(60);
  ok("per-volume is described as unsplittable but still order-dependent",
     (await flat()).includes("splitting does not evade it"));
}

console.log("── destinations stay in their own units");
{
  const d = await txt("#dest");
  ok("treasury is reported in ETH withdrawn", /ETH withdrawn/.test(d));
  ok("recycling is reported as depth, not as take", /ETH of extra depth/.test(d));
  ok("burning is reported as a share of supply", /share of pool supply/.test(d));
  ok("the page says why they are not added up",
     (await flat()).includes("marking holdings at a price this model itself moved"));
  ok("and names the size of the error that caused", (await flat()).includes("11,000"));
  // The circular-valuation trap must not come back through the JS either.
  ok("no mark-to-market wealth figure exists in the source",
     !/lp_value|burnValue|lpValue|markToMarket/.test(src));
}

console.log("── what a buyer pays involves no guess");
{
  const before = await txt("#buyer");
  await page.fill("#orgBuyKnee", "1");
  await page.fill("#sharpness", "20");
  await page.waitForTimeout(60);
  const after = await txt("#buyer");
  ok("changing a pure guess does not move what a buyer pays", before === after);
  await page.fill("#orgBuyKnee", "9"); await page.fill("#sharpness", "6");
  await page.waitForTimeout(60);

  await page.fill("#start", "5");
  await page.waitForTimeout(60);
  ok("but changing the schedule does",
     (await flat()).includes("loses 11.55%"), await txt("#roundtripNote"));
  await page.fill("#start", "0");
  await page.waitForTimeout(60);
  ok("and it is back at 6.89% with no starting tax",
     (await flat()).includes("loses 6.89%"), await txt("#roundtripNote"));
}

console.log("── degenerate inputs do not produce confident nonsense");
{
  for (const [id, v] of [["seedE", "abc"], ["volume", "0"], ["nSnipe", "0"],
                         ["nOrg", "0"], ["cap", "0"], ["sellTax", "0"]]) {
    const old = await page.inputValue("#" + id);
    await page.fill("#" + id, v);
    await page.waitForTimeout(60);
    ok(`${id}=${v} does not throw or blank the page`,
       (await txt("#buyer")).length > 0 && pageErrors.length === 0,
       pageErrors.join("; "));
    await page.fill("#" + id, old);
  }
  await page.waitForTimeout(200);
}

console.log("── a broken world is surfaced, never counted as zero");
{
  // An adversarial reviewer's finding, and it applies to this page too: NaN fails every
  // comparison, so it is skipped by `v > best` and dropped by the filter. A non-finite input
  // then reads as "nobody bought, take is 0" and votes for the 0% bucket in the histogram.
  const r = await page.evaluate(() => {
    const pop = {volume:100, nSnipe:40, nOrg:360, snipeShare:0.7, snipeAlpha:1.8, orgAlpha:2.2,
                 snipeBuyKnee:0.06, snipeSellKnee:0.4, orgBuyKnee:0.09, orgSellKnee:0.07,
                 sharpness:NaN};
    const s = {unit:"volume", start:0, step:0.01, stepUnit:5, cap:0.1, sell:0.05,
               offAfter:0, perBlock:8};
    const sim = window.__LAUNCH.simulate(pop, s, 25, 0.01, "treasury");
    const band = window.__LAUNCH.stableRegion(pop, s, 25, 0.01, "treasury");
    const good = window.__LAUNCH.simulate(
      Object.assign({}, pop, {sharpness:6}), s, 25, 0.01, "treasury");
    return {invalid:sim.invalid, rt:sim.roundTrip, obj:window.__LAUNCH.objective(sim,"treasury"),
            broken:band.broken===true, lo:band.lo, goodInvalid:good.invalid===true};
  });
  ok("a non-finite input is flagged invalid", r.invalid === true);
  ok("its round trip is NaN, not a comfortable zero", Number.isNaN(r.rt));
  ok("an invalid run scores NaN rather than zero", Number.isNaN(r.obj));
  ok("a sweep containing one is marked broken", r.broken === true);
  ok("and returns NaN rather than a band that looks trustworthy", Number.isNaN(r.lo));
  ok("an ordinary run is not flagged", r.goodInvalid === false);
}

console.log("── layout and one token");
const sw = await page.evaluate(() => document.documentElement.scrollWidth);
ok("no horizontal scroll at 375px", sw <= 375, "scrollWidth=" + sw);
ok("self-contained, no external scripts or styles",
   !/<script[^>]+src=/i.test(src) && !/<link[^>]+stylesheet/i.test(src));
ok("no other ticker appears", !/\$TWD|POT ?PAL|POTPAL/i.test(src));
ok("LAPTOP is named", (await flat()).includes("LAPTOP"));
ok("no page errors during the run", pageErrors.length === 0, pageErrors.join("; "));

await browser.close();
site.close();
console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
