// Tests for web/potpal.html — the deployment simulator. Nothing here touches a network.
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
  fs.readFile(f, (e, d) => {
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
await page.goto(SITE + "/potpal.html", { waitUntil: "networkidle" });
const txt = async s => (await page.textContent(s).catch(() => "")) || "";
const src = fs.readFileSync(path.join(ROOT, "web", "potpal.html"), "utf8");

console.log("── it simulates, it does not deploy");
ok("no wallet or signing code",
   !/window\.ethereum|eth_requestAccounts|sendTransaction|signTypedData|privateKey|mnemonic/i.test(src));
ok("no contract deployment", !/eth_sendRawTransaction|deployContract|ContractFactory/i.test(src));
ok("no network calls at all", !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(src));
const external = requests.filter(u => !u.startsWith(SITE));
ok("nothing leaves the origin", external.length === 0, external.join(", "));
ok("says plainly nothing is deployed", (await txt("body")).includes("Nothing here is deployed"));
ok("says nothing is for sale", (await txt("body")).includes("nothing is for sale"));

console.log("── it disclaims affiliation and refuses the LAPTOP pair");
const body = await txt("body");
ok("states it is not affiliated with LAPTOP", body.includes("not affiliated with LAPTOP"));
ok("states it is not endorsed by anyone depicted", body.includes("anyone depicted"));
ok("quoted against ETH", body.includes("Quoted against ETH"));
ok("says the LAPTOP pair is refused on purpose", body.includes("no — deliberately"));
ok("explains why: it could be mistaken for a LAPTOP pool",
   body.includes("mistaken for one"));

console.log("── protocol limits are real and enforced");
const lim = await page.evaluate(() => {
  const S = window.__POTPAL;
  const base = { name: "POT PAL", symbol: "POTPAL", decimals: 18, seedEth: 5, ethUsd: 3000 };
  const run = (supply, seed) => S.simulate({ ...base, supply, seedTokens: seed ?? supply });
  return {
    u112: S.U112.toString(),
    ok420T: run(420000000000000n).errors.length,
    okMax: run(5192296858534n * 1000n).errors.length,           // ~5.19 quadrillion, just under
    quintillion: run(1000000000000000000n).errors,              // 1e18 tokens — overflows uint112
    ceiling: run(420000000000000n).maxSupplyForV2.toString(),
    tickAt420T: run(420000000000000n).tick,
    tickOk: run(420000000000000n).tickOk,
    zeroSupply: run(0n).errors,
    seedMoreThanExists: S.simulate({ ...base, supply: 1000n, seedTokens: 2000n }).errors,
    badDecimals: S.simulate({ ...base, decimals: 99, supply: 1000n, seedTokens: 1000n }).errors,
    noEth: S.simulate({ ...base, seedEth: 0, supply: 1000n, seedTokens: 1000n }).errors,
  };
});
eq("uint112 max is the real constant", lim.u112, ((2n ** 112n) - 1n).toString());
eq("420 trillion is deployable", lim.ok420T, 0);
ok("1 quintillion is rejected", lim.quintillion.length > 0);
ok("and the rejection names uint112 and V2",
   lim.quintillion.some(e => /uint112/.test(e) && /V2/.test(e)), JSON.stringify(lim.quintillion));
ok("the ceiling is stated in the error", /quadrillion|trillion/.test(lim.quintillion.join(" ")));
ok("tick stays inside range at 420T", lim.tickOk, String(lim.tickAt420T));
ok("zero supply is rejected", lim.zeroSupply.length > 0);
ok("seeding more than exists is rejected",
   lim.seedMoreThanExists.some(e => /more tokens than exist/.test(e)));
ok("absurd decimals are rejected", lim.badDecimals.length > 0);
ok("zero ETH is rejected", lim.noEth.length > 0);

console.log("── the launch curve is honest about thinness");
const curve = await page.evaluate(() => {
  const S = window.__POTPAL;
  const thin = S.simulate({ name:"a",symbol:"a",decimals:18,supply:420000000000000n,
    seedTokens:420000000000000n,seedEth:0.5,ethUsd:3000 });
  const deep = S.simulate({ name:"a",symbol:"a",decimals:18,supply:420000000000000n,
    seedTokens:420000000000000n,seedEth:500,ethUsd:3000 });
  return { thinSlip: thin.curve.map(c=>c.slip), deepSlip: deep.curve.map(c=>c.slip),
           thinWarn: thin.warnings, floatWarn: thin.warnings.join(" ") };
});
ok("slippage rises with size", curve.thinSlip.every((v,i)=>i===0||v>=curve.thinSlip[i-1]));
ok("a thin pool slips far more than a deep one at the same size",
   curve.thinSlip[4] > curve.deepSlip[4], `${curve.thinSlip[4]} vs ${curve.deepSlip[4]}`);
ok("shallow depth is called out", /Under 1 ETH of depth/.test(curve.floatWarn));
ok("seeding all supply is called out", /entire market/.test(curve.floatWarn));

console.log("── FDV rests on the user's own number");
ok("FDV is labelled as arithmetic, not a valuation", body.includes("arithmetic, not a valuation"));
ok("nothing is read live", body.includes("nothing is read live"));

console.log("── artwork is a slot, not an asset");
ok("the background is a named slot", src.includes("/potpal-bg.png"));
ok("the page says so when the file is absent", (await txt("#artNone")).includes("this is a slot"));
ok("no artwork is committed for it", !fs.existsSync(path.join(ROOT, "web", "potpal-bg.png")));

console.log("── layout");
ok("no horizontal scroll at 375px",
   (await page.evaluate(() => document.documentElement.scrollWidth)) <= 375);
ok("wordmark renders", (await txt(".wordmark")).replace(/\s/g, "") === "POTPAL");
ok("links back to the checker", src.includes('href="/"'));
ok("no page errors", pageErrors.length === 0, pageErrors.join("; "));

await browser.close(); site.close();
console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
