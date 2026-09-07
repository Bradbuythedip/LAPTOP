// Tests for web/buy.html — the venue comparison. Drives the real page in Chromium against
// test/mock-rpc.mjs, including a three-venue fixture with deliberately different depths.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = process.env.MOCK_PORT || 8641;
const MOCK = "http://127.0.0.1:" + MOCK_PORT;
const mockProc = spawn(process.execPath, [path.join(ROOT, "test", "mock-rpc.mjs")], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: "ignore" });
process.on("exit", () => mockProc.kill());
await new Promise(r => setTimeout(r, 700));

let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { if (c) { pass++; results.push("  ok   " + n); }
  else { fail++; results.push("  FAIL " + n + (x ? "\n         " + x : "")); } };
const eq = (n, g, w) => ok(n, g === w, `got  ${g}\n         want ${w}`);

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
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
await page.goto(SITE + "/buy.html", { waitUntil: "domcontentloaded" });
const txt = async s => (await page.textContent(s).catch(() => "")) || "";
const use = async scn => {
  await page.evaluate(u => localStorage.setItem("laptop.rpc", u), MOCK + "/" + scn);
  await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForTimeout(200);
};
const compare = async () => { await page.click("#go"); await page.waitForTimeout(1400); };

console.log("── the page cannot spend money, and says so");
const src = fs.readFileSync(path.join(ROOT, "web", "buy.html"), "utf8");
ok("no wallet connection anywhere",
   !/window\.ethereum|eth_requestAccounts|WalletConnect|personal_sign|eth_sendTransaction/i.test(src));
ok("no transaction construction", !/sendTransaction|signTypedData|approve\(/.test(src));
ok("states it will never ask for a wallet", (await txt("body")).includes("never will"));
ok("tells the user a wallet prompt here means it is not this page",
   (await txt("body")).includes("close it"));
ok("explains why: a clone would drain instead of lie",
   (await txt("body")).includes("a clone drains them"));

console.log("── ranking across three venues of different depth");
await use("venues");
await compare();
const body = await txt("#out");
ok("chain confirmed first", (await txt("#chainBadge")).includes("8453"));
const names = await page.$$eval(".venue .name", ns => ns.map(n => n.textContent));
ok("all three venues are priced", names.length === 3, JSON.stringify(names));
const outs = await page.$$eval(".venue .out", ns => ns.map(n =>
  parseFloat(n.textContent.replace(/[^0-9.]/g, ""))));
ok("results are ranked best first", outs.every((v, i) => i === 0 || v <= outs[i - 1]),
   JSON.stringify(outs));
ok("the deepest pool wins", names[0].includes("Uniswap V2"), JSON.stringify(names));
ok("exactly one venue is marked best",
   (await page.$$(".venue.best")).length === 1);
ok("the spread is quantified", body.includes("worth") && body.includes("% more for the same money"));
ok("constant-product venues are labelled exact", body.includes("the pool's own arithmetic"));
ok("concentrated venues are labelled a best case", body.includes("best case"));

console.log("── every venue links out with a checkable address");
const links = await page.$$eval(".venue a", as => as.map(a => a.href));
const perVenue = await page.$$eval(".venue", vs => vs.map(v => v.querySelectorAll("a").length));
ok("every venue offers at least one link", perVenue.every(n => n >= 1), JSON.stringify(perVenue));
ok("the best venue gets a primary action on top of its link",
   (await page.$$(".venue.best a.cta")).length === 1);
ok("only the winner gets one", (await page.$$(".venue a.cta")).length === 1);
const ctaHref = await page.$eval(".venue.best a.cta", a => a.getAttribute("href"));
ok("the primary action carries the amount as well as the pair",
   /exactAmount=1000/.test(ctaHref) && /outputCurrency=0xb095/i.test(ctaHref), ctaHref);
ok("links carry the LAPTOP contract address",
   links.every(h => h.toLowerCase().includes("0xb095274743941e953c746f9c228da9c18bb6ec29")));
ok("links open in a new tab with no referrer leak",
   (await page.$$eval(".venue a", as => as.every(a => a.target === "_blank" && /noopener/.test(a.rel)))));
ok("the pool address is printed so the venue can be checked against it", body.includes("pool 0x"));
ok("tells the user to verify the token in the venue",
   (await txt("body")).includes("a link is not a guarantee"));

console.log("── v4 is reported, never silently skipped");
ok("the v4 gate is reported", body.includes("Uniswap v4"));
ok("an empty PoolManager proves the v4 branch negative",
   body.includes("no v4 pool can be tradable"));

console.log("── failures never become a ranking");
await use("flaky");
await compare();
const flaky = await txt("#out");
ok("unreadable venues are listed rather than dropped",
   flaky.includes("Not priced") || flaky.includes("could not be read"), flaky.slice(0, 200));
ok("a negative is scoped to what was checked",
   flaky.includes("not the same as") || flaky.includes("checked"), flaky.slice(0, 200));

await use("wrongchain");
await compare();
ok("nothing is priced on the wrong chain", (await txt("#out")).includes("Nothing priced"));

await use("nocors-venues");
await compare();
ok("a CORS block prices nothing rather than guessing",
   (await txt("#out")).includes("Nothing priced"));

console.log("── input handling");
await use("venues");
await page.fill("#amt", "-5"); await compare();
ok("a negative size is refused", (await txt("#out")).includes("above zero"));
await page.fill("#amt", "abc"); await compare();
ok("a non-numeric size is refused", (await txt("#out")).includes("above zero"));

console.log("── layout");
await page.fill("#amt", "1000"); await compare();
ok("no horizontal scroll at 375px",
   (await page.evaluate(() => document.documentElement.scrollWidth)) <= 375);
ok("never tells anyone to buy", !/\byou should buy\b|\bbuy now\b/i.test(await txt("body")));
ok("no page errors", pageErrors.length === 0, pageErrors.join("; "));

await browser.close(); site.close();
console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
