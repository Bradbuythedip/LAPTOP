// Tests for web/route.html. The page makes no network requests at all, so this is mostly
// a check that it says true things and never drifts into custody language.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const ctx = await browser.newContext({ viewport: { width: 375, height: 820 } });
const page = await ctx.newPage();
const pageErrors = [], requests = [];
page.on("pageerror", e => pageErrors.push(e.message));
page.on("request", r => requests.push(r.url()));
await page.goto(SITE + "/route.html", { waitUntil: "networkidle" });
const txt = async s => (await page.textContent(s).catch(() => "")) || "";

console.log("── the page takes no custody and makes no requests");
const external = requests.filter(u => !u.startsWith(SITE));
ok("no request leaves the origin", external.length === 0, external.join(", "));
const src = fs.readFileSync(path.join(ROOT, "web", "route.html"), "utf8");
ok("no wallet connection", !/window\.ethereum|eth_requestAccounts|solana\.connect|WalletConnect/i.test(src));
ok("no fetch, XHR or websocket anywhere", !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(src));
ok("no deposit address is offered", !/send (?:your )?(?:funds|sol|eth) to/i.test(src));
ok("states plainly that it never touches money",
   (await txt("body")).includes("never touches your money"));
ok("names the preorder arrangement for what it is",
   (await txt("body")).includes("somebody holds your money"));
ok("explains why a preorder cannot exist yet",
   (await txt("body")).includes("no pool to swap"));

console.log("── routes");
const routes = await page.evaluate(() => {
  const R = window.__ROUTE;
  const g = (c, a) => R.buildRoute(c, a, "5").steps.map(s => s.text).join(" | ");
  return {
    sol: g("solana", "SOL"),
    solBadge: R.buildRoute("solana", "SOL", "5").badge,
    base: g("base", "ETH"),
    baseBadge: R.buildRoute("base", "ETH", "5").badge,
    baseUsdc: g("base", "USDC"),
    cex: g("cex", "SOL"),
    arb: g("arbitrum", "USDC"),
    gasSol: R.buildRoute("solana", "SOL", "").gas,
    gasBaseEth: R.buildRoute("base", "ETH", "").gas,
    noAmt: R.buildRoute("solana", "SOL", "").steps[0].text,
    badAmt: R.buildRoute("solana", "SOL", "abc").steps[0].text,
    negAmt: R.buildRoute("solana", "SOL", "-3").steps[0].text,
  };
});
ok("Solana route warns that EVM-only bridges cannot see it", /not an EVM chain/.test(routes.sol));
eq("Solana badge", routes.solBadge, "Solana → Base");
ok("Solana route says bridge early", /now rather than on launch day/.test(routes.sol));
ok("already-on-Base needs no bridge", /No bridge needed/.test(routes.base));
eq("Base badge", routes.baseBadge, "already on Base");
ok("holding only USDC on Base is flagged for gas", /cannot send the swap/.test(routes.baseUsdc));
ok("holding ETH on Base suggests also holding the likely quote asset",
   /USDC-quoted/.test(routes.base));
ok("exchange route checks direct-to-Base withdrawal first", /withdraw directly to Base/.test(routes.cex));
ok("exchange route warns withdrawals can pause", /delayed or paused/.test(routes.cex));
ok("EVM route still needs a bridge", /has to move/.test(routes.arb));
eq("gas warning shown when bridging", routes.gasSol, true);
eq("no redundant gas warning when already holding ETH on Base", routes.gasBaseEth, false);
ok("a missing amount degrades to no number", !/undefined|NaN/.test(routes.noAmt), routes.noAmt);
ok("a non-numeric amount degrades to no number", !/abc|NaN/.test(routes.badAmt), routes.badAmt);
ok("a negative amount is ignored rather than printed", !/-3/.test(routes.negAmt), routes.negAmt);

console.log("── bridge table");
await page.selectOption("#chain", "solana");
await page.waitForTimeout(150);
const solTable = await txt("#bridges");
ok("EVM-only bridges are hidden for Solana", !solTable.includes("Across"), solTable);
ok("Solana-capable bridges are listed", solTable.includes("deBridge"));
ok("the table says nothing is verified",
   (await txt("body")).includes("none verified by this tool"));
await page.selectOption("#chain", "arbitrum");
await page.waitForTimeout(150);
ok("EVM bridges reappear for an EVM chain", (await txt("#bridges")).includes("Across"));

console.log("── asset list follows the chain");
await page.selectOption("#chain", "solana");
await page.waitForTimeout(150);
const solAssets = await page.$$eval("#asset option", os => os.map(o => o.value));
ok("Solana offers SOL", solAssets.includes("SOL"));
ok("Solana does not offer BNB", !solAssets.includes("BNB"));
await page.selectOption("#chain", "base");
await page.waitForTimeout(150);
const baseAssets = await page.$$eval("#asset option", os => os.map(o => o.value));
ok("Base offers USDbC", baseAssets.includes("USDbC"));

console.log("── the Phantom track");
{
  const ph = (await page.textContent("#phantomCard").catch(() => "") || "").replace(/\s+/g, " ");
  ok("there is a Phantom section at all", ph.length > 0);
  ok("it leads with the chain, not the wallet", /LAPTOP is on Base/i.test(ph));
  ok("it states there is no LAPTOP on Solana", /no LAPTOP on Solana/i.test(ph));
  ok("and says why a lookalike will exist there",
     /exactly the setup a lookalike is built for/i.test(ph));
  ok("it tells them nothing on Solana becomes LAPTOP later",
     /Nothing you can buy on Solana becomes LAPTOP later/i.test(ph));
  ok("it says Phantom already supports Base", /Phantom already speaks Base/i.test(ph));
  ok("and marks that as unverified from here", /cannot confirm it for you/i.test(ph));
  ok("it reframes 'deposit' as moving your own money to your own address",
     /moving your own money to your own address/i.test(ph));
  ok("and says there is nothing to deposit into",
     /nothing to deposit into and nobody to deposit with/i.test(ph));
  ok("the gas trap is called out as the sticking point",
     /This is where people get stuck/i.test(ph));
  ok("naming the exact failure: USDC on Base with no ETH",
     /only USDC on Base cannot send anything/i.test(ph));
  ok("it explains why there is no Connect button", /no Connect button here/i.test(ph));
  ok("giving the reason rather than just the rule",
     /it cannot make our prompt appear when we never prompt/i.test(ph));
  ok("and points the wallet at the venue instead",
     /connect Phantom to the venue you swap on/i.test(ph));
  ok("it routes onward to the checker, the venues and the standing order",
     /href="\/"/.test(src) && src.includes('href="/buy.html"') && src.includes('href="/order.html"'));
}
// The whole point of the section is that it adds no wallet surface whatsoever.
ok("no wallet object is touched, not even to detect one",
   !/window\.phantom|window\.solana|isPhantom|window\.ethereum/i.test(src));
ok("no connect call of any kind",
   !/eth_requestAccounts|\.connect\s*\(|requestAccounts/i.test(src));

console.log("── layout and tone");
ok("no horizontal scroll at 375px",
   (await page.evaluate(() => document.documentElement.scrollWidth)) <= 375);
const body = await txt("body");
ok("never tells anyone to buy", !/\byou should buy\b|\bbuy now\b/i.test(body));
ok("says it has no opinion on the token", /no opinion on it/.test(body));
ok("links onward to the checker and size curve",
   src.includes('href="/"') && src.includes('href="/size.html"'));
ok("no page errors", pageErrors.length === 0, pageErrors.join("; "));

await browser.close(); site.close();
console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
