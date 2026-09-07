// Tests for web/size.html. Cross-checks the page's swap math against the independent
// Python implementation in test/test_size_math.py (via test/size-fixture.json), then drives
// the real page in Chromium against the pool fixtures in test/mock-rpc.mjs.
//
//   python3 test/test_size_math.py && node test/run-size.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = process.env.MOCK_PORT || 8601;
const MOCK = "http://127.0.0.1:" + MOCK_PORT;
const POOL = "0x1111111111111111111111111111111111111111";

const fixturePath = path.join(ROOT, "test", "size-fixture.json");
if (!fs.existsSync(fixturePath)) {
  console.error("missing test/size-fixture.json — run: python3 test/test_size_math.py");
  process.exit(1);
}
const FIX = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

const mockProc = spawn(process.execPath, [path.join(ROOT, "test", "mock-rpc.mjs")], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: "ignore",
});
process.on("exit", () => mockProc.kill());
await new Promise(r => setTimeout(r, 700));

let pass = 0, fail = 0;
const results = [];
const ok = (name, cond, extra) => {
  if (cond) { pass++; results.push("  ok   " + name); }
  else { fail++; results.push("  FAIL " + name + (extra ? "\n         " + extra : "")); }
};
const eq = (name, got, want) => ok(name, got === want, `got  ${got}\n         want ${want}`);

const site = http.createServer((req, res) => {
  const f = path.join(ROOT, "web", req.url === "/" ? "index.html" : req.url.replace(/^\//, ""));
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(d);
  });
});
await new Promise(r => site.listen(0, r));
const SITE = "http://127.0.0.1:" + site.address().port;

const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
                "/opt/pw-browsers/chromium/chrome-linux/chrome"].find(p => fs.existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 375, height: 820 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
await page.goto(SITE + "/size.html", { waitUntil: "domcontentloaded" });

/* ---------------- 1. cross-language math check ---------------- */
console.log("── swap math: JavaScript vs the independent Python implementation");
const got = await page.evaluate(fx => {
  const S = window.__SIZE;
  return {
    v2: fx.v2.map(c => S.v2Out(BigInt(c.in), BigInt(c.rIn), BigInt(c.rOut), c.feeBps).toString()),
    v3: fx.v3.map(c => S.v3Out(c.in, c.L, c.sqrtP, c.feePpm, c.zeroForOne)),
    spot: fx.spot.map(c => S.spotPrice(c.sqrtP, c.zeroForOne, c.decIn, c.decOut)),
  };
}, FIX);

FIX.v2.forEach((c, i) => eq(
  `v2Out exact match: ${c.in} in, fee ${c.feeBps}bps`, got.v2[i], c.out));

const rel = (a, b) => b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);
FIX.v3.forEach((c, i) => ok(
  `v3Out matches Python within 1e-12 (in=${c.in}, ${c.zeroForOne ? "0->1" : "1->0"})`,
  rel(got.v3[i], c.out) < 1e-12, `js ${got.v3[i]}  py ${c.out}  rel ${rel(got.v3[i], c.out)}`));
FIX.spot.forEach((c, i) => ok(
  `spotPrice matches Python (sqrtP=${c.sqrtP}, dec ${c.decIn}->${c.decOut})`,
  rel(got.spot[i], c.out) < 1e-12, `js ${got.spot[i]}  py ${c.out}`));

/* ---------------- 2. properties in the browser ---------------- */
console.log("── properties");
const props = await page.evaluate(() => {
  const S = window.__SIZE;
  const L = 5e21, sp = 2.5;
  const sizes = [1, 2, 5, 10, 25, 50].map(x => x * 1e18);
  const outs = sizes.map(a => S.v3Out(a, L, sp, 3000, false));
  const eff = outs.map((o, i) => o / sizes[i]);
  const R = 1000n * 10n ** 18n;
  const v2outs = [1, 2, 5, 10, 25].map(x =>
    Number(S.v2Out(BigInt(x) * 10n ** 18n, R, R, 30)) / (x * 1e18));
  return {
    monotonic: outs.every((o, i) => i === 0 || o > outs[i - 1]),
    worsening: eff.every((e, i) => i === 0 || e < eff[i - 1]),
    v2Worsening: v2outs.every((e, i) => i === 0 || e < v2outs[i - 1]),
    zeroL: S.v3Out(1e18, 0, sp, 3000, false),
    zeroIn: S.v3Out(0, L, sp, 3000, false),
    negIn: S.v3Out(-5, L, sp, 3000, false),
    emptyReserve: S.v2Out(10n ** 18n, 0n, R, 30).toString(),
    slipZero: S.slippage(10, 10),
    slipHalf: S.slippage(5, 10),
  };
});
ok("v3 output rises with size", props.monotonic);
ok("v3 effective price worsens with size", props.worsening);
ok("v2 effective price worsens with size", props.v2Worsening);
eq("zero liquidity yields zero out", props.zeroL, 0);
eq("zero input yields zero out", props.zeroIn, 0);
eq("negative input yields zero out, not a negative fill", props.negIn, 0);
eq("empty reserve yields zero out", props.emptyReserve, "0");
eq("slippage of a spot-priced fill is 0", props.slipZero, 0);
eq("a fill at half spot is 50% slippage", props.slipHalf, 0.5);

/* ---------------- 3. browser flows ---------------- */
const use = async scn => {
  await page.evaluate(u => localStorage.setItem("twd.rpc", u), MOCK + "/" + scn);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(200);
};
const readPool = async (addr = POOL) => {
  await page.fill("#pool", addr);
  await page.click("#go");
  await page.waitForTimeout(900);
};
const txt = async s => (await page.textContent(s).catch(() => "")) || "";

console.log("── flow: constant-product pool is labelled exact");
await use("pool-v2");
await readPool();
ok("classified as constant product", (await txt("#poolBadge")).includes("exact"));
ok("curve badge says exact", (await txt("#curveBadge")).includes("exact"));
ok("says the numbers are the pool's own arithmetic", (await txt("#curveNote")).includes("exact"));
const v2rows = await page.$$eval("#curve tr", rs => rs.slice(1).map(r =>
  [...r.querySelectorAll("td")].map(td => td.textContent)));
ok("renders the full size ladder", v2rows.length === 9, "rows=" + v2rows.length);
ok("slippage grows down the ladder", await page.evaluate(() => {
  const p = [...document.querySelectorAll("#curve tr")].slice(1)
    .map(r => parseFloat(r.querySelectorAll("td")[3].textContent));
  return p.every((v, i) => i === 0 || v >= p[i - 1]);
}));

console.log("── flow: concentrated liquidity is labelled a best case");
await use("pool-v3");
await readPool();
ok("classified as concentrated liquidity", (await txt("#poolBadge")).includes("estimate"));
ok("curve badge says best case", (await txt("#curveBadge")).includes("best case"));
ok("explains liquidity may not extend", (await txt("#curveNote")).includes("BEST CASE"));
ok("never claims to be exact", !(await txt("#curveNote")).includes("are exact"));

console.log("── flow: the pool's own balance caps any fill");
await use("pool-cap");
await readPool();
ok("oversized rows say the pool cannot fill them",
   (await txt("#curve")).includes("more than the pool holds"));
ok("states the hard ceiling", (await txt("#curveCard")).includes("No trade can take"));

console.log("── flow: custom size");
await use("pool-v2");
await readPool();
await page.fill("#custom", "5");
await page.waitForTimeout(200);
const custom = await txt("#customOut");
ok("custom size produces a fill", /LAPTOP/.test(custom), custom);
ok("custom size reports slippage", /%/.test(custom), custom);
// A bad fill must not be dressed in the "fine" colour.
const cls5 = await page.$eval("#customOut > div", n => n.className + "|" + n.style.color);
ok("a heavily-slipped fill is not rendered as approval", !/okbox/.test(cls5), cls5);
await page.fill("#custom", "0.1");
await page.waitForTimeout(200);
const clsSmall = await page.$eval("#customOut > div", n => n.className);
ok("a small, cheap fill is rendered calmly", /okbox/.test(clsSmall), clsSmall);
await page.fill("#custom", "-3");
await page.waitForTimeout(200);
eq("a negative size renders nothing rather than nonsense", (await txt("#customOut")).trim(), "");

console.log("── flow: refusals");
await use("pool-foreign");
await readPool();
ok("a pool with no LAPTOP side is refused",
   (await txt("#curveNote")).includes("Neither side"));
ok("and no curve is drawn for it", (await txt("#curve")).trim() === "");

await use("pool-stable");
await readPool();
ok("Aerodrome stable pools are declined rather than mispriced",
   (await txt("#curveNote")).includes("x³y+y³x"));

await use("pool-dry");
await readPool();
ok("a pool with no in-range liquidity says so",
   (await txt("#curveNote")).includes("no active in-range liquidity"));

await use("pool-nocode");
await readPool();
ok("an address with no contract is reported", (await txt("#poolInfo")).includes("no contract"));

await use("pool-v2");
await page.fill("#pool", "0xnothex");
await page.click("#go");
await page.waitForTimeout(200);
ok("a malformed address is rejected inline", await page.isVisible("#poolErr"));

console.log("── layout and static checks");
await use("pool-v3");
await readPool();
const sw = await page.evaluate(() => document.documentElement.scrollWidth);
ok("no horizontal scroll at 375px", sw <= 375, "scrollWidth=" + sw);
const html = fs.readFileSync(path.join(ROOT, "web", "size.html"), "utf8");
ok("no wallet code", !/window\.ethereum|eth_sendTransaction|privateKey/.test(html));
ok("self-contained, no external scripts or styles",
   !/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html));
ok("no page errors during the run", pageErrors.length === 0, pageErrors.join("; "));

await browser.close();
site.close();
console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
