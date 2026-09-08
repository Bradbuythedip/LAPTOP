// Tests for web/index.html — the $SNOOZE landing page.
//
// The thing this suite exists to prevent is a chart that lies. A page like this has every
// incentive to draw a line going up, and a line going up is what a chart communicates whether
// or not anything produced it. So most of what follows is about the difference between a plot
// of a FORMULA (exact, checkable against the contract, honest) and a plot of a MARKET (only
// legitimate if a chain read produced it), and about the page never quietly turning the first
// into the second.
//
// The launch-day path is tested too, by serving a copy of the page with the pool address
// filled in against a mock node. That code has to work the first time it ever runs.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { if (c) { pass++; results.push("  ok   " + n); }
  else { fail++; results.push("  FAIL " + n + (x ? "\n         " + x : "")); } };
const near = (n, g, w, tol) => ok(n, Math.abs(g - w) <= (tol ?? 1e-9),
  `got  ${g}\n         want ${w}`);

const SRC = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const POOL_ADDR = "0x00000000000000000000000000000000000000aa";

// A node that answers the three reads this page makes, and nothing else. `logs` is swapped
// between scenarios so the same page can be driven through every state it has.
let LOGS = [], LOG_MODE = "ok", HEAD = 0x1000000;
const CORS = { "access-control-allow-origin": "*",
               "access-control-allow-headers": "content-type",
               "access-control-allow-methods": "POST, OPTIONS" };
const node = http.createServer((req, res) => {
  // The page is on one origin and the node on another, exactly as in production, so the
  // browser sends a preflight first. A mock that does not answer it never sees the POST, and
  // the suite silently tests nothing.
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  let body = "";
  req.on("data", d => body += d);
  req.on("end", () => {
    let r;
    try { r = JSON.parse(body); } catch { res.writeHead(400, CORS); return res.end(); }
    const reply = m => {
      if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x2105" };
      if (m.method === "eth_blockNumber")
        return { jsonrpc: "2.0", id: m.id, result: "0x" + HEAD.toString(16) };
      if (m.method === "eth_getLogs") {
        if (LOG_MODE === "refuse")
          return { jsonrpc: "2.0", id: m.id, error: { code: -32005, message: "range too large" } };
        // A node that only serves a short window: refuse anything wider than 10k blocks, which
        // is what the fallback ladder exists for.
        if (LOG_MODE === "narrow") {
          const from = parseInt(m.params[0].fromBlock, 16);
          if (HEAD - from > 10000)
            return { jsonrpc: "2.0", id: m.id, error: { code: -32005, message: "range too large" } };
        }
        return { jsonrpc: "2.0", id: m.id, result: LOGS };
      }
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not allowed here" } };
    };
    res.writeHead(200, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify(Array.isArray(r) ? r.map(reply) : reply(r)));
  });
});
await new Promise(r => node.listen(0, r));
const NODE = "http://127.0.0.1:" + node.address().port;

// The site. `?pool=1` serves the page with the address filled in, which is the only way to
// exercise the deployed path while the real constant is honestly empty.
const site = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const rel = u.pathname;
  const f = path.join(ROOT, "web", rel === "/" ? "index.html" : rel.replace(/^\//, ""));
  if (rel === "/" && u.searchParams.get("pool")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(SRC.replace('const POOL  = "";', `const POOL  = "${POOL_ADDR}";`));
  }
  const target = (!fs.existsSync(f) && f.endsWith("bg.png"))
    ? path.join(ROOT, "test", "fixture-bg.png") : f;
  fs.readFile(target, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(target);
    res.writeHead(200, { "content-type":
      ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "text/html; charset=utf-8" });
    res.end(d);
  });
});
await new Promise(r => site.listen(0, r));
const SITE = "http://127.0.0.1:" + site.address().port;

const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
                "/opt/pw-browsers/chromium/chrome-linux/chrome"].find(p => fs.existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
await ctx.addInitScript(n => { try { localStorage.setItem("laptop.rpc", n); } catch {} }, NODE);
const page = await ctx.newPage();
const pageErrors = [], requests = [];
page.on("pageerror", e => pageErrors.push(e.message));
page.on("request", r => requests.push(r.url()));

const load = async q => {
  await page.goto(SITE + "/" + (q || ""), { waitUntil: "load" });
  await page.waitForFunction(() => window.__CHART && window.__CHART.mode !== "none")
            .catch(() => {});
  await page.waitForTimeout(120);
};
const txt = async s => (await page.textContent(s).catch(() => "")) || "";
const flat = s => s.replace(/\s+/g, " ");

await load();
const body = flat(await txt("body"));

console.log("── it holds no custody and reaches nothing it should not");
{
  const off = requests.filter(u => !u.startsWith(SITE) && !u.startsWith(NODE));
  ok("no third-party origin is contacted", off.length === 0, off.join(", "));
  ok("no external script or stylesheet", !/<script[^>]+src=|<link[^>]+stylesheet/i.test(SRC));
  ok("no signing, sending or approval method anywhere",
     !/eth_sendTransaction|eth_sendRawTransaction|personal_sign|eth_signTypedData|signTransaction|signMessage|signAndSendTransaction/.test(SRC));
  const methods = [...new Set(SRC.match(/\beth_[a-zA-Z]+/g) || [])];
  const ALLOWED = ["eth_chainId", "eth_blockNumber", "eth_getLogs", "eth_call",
                   "eth_requestAccounts", "eth_accounts", "eth_getBalance", "eth_getCode",
                   "eth_getStorageAt"];
  ok("names only methods in the read set", methods.every(m => ALLOWED.includes(m)),
     methods.filter(m => !ALLOWED.includes(m)).join(","));
  ok("it says it does not ask you to sign", body.includes("does not ask you to sign anything"));
}

console.log("── the chart draws arithmetic, and says so, until a chain read says otherwise");
{
  const c = await page.evaluate(() => ({ ...window.__CHART }));
  ok("with nothing deployed the mode is arithmetic", c.mode === "arithmetic", c.mode);
  ok("and there is no market series at all", Array.isArray(c.marketSeries) && !c.marketSeries.length,
     JSON.stringify(c.marketSeries).slice(0, 80));
  const strap = flat(await txt("#strap"));
  ok("the frame says outright that it is not a market",
     /arithmetic, not a market/i.test(strap), strap);
  ok("and that no price data exists yet", /no price data exists yet/i.test(strap), strap);
  const paths = await page.$$eval("#chart path", ps => ps.length);
  ok("a line is drawn — an empty frame would teach nothing", paths >= 1, String(paths));
  const axes = flat(await txt(".axis"));
  ok("the x axis is labelled as a ratio, not as time",
     /24-hour average/.test(axes) && !/\bdate|\btime\b/i.test(axes), axes);
  ok("the y axis names what burns", /burned on sale/.test(axes), axes);
}

console.log("── the curve is the contract's arithmetic, not a drawing of it");
{
  // burnBps() in contracts/Snooze.sol: (P - T) / P, zero at or below the average, capped at
  // 90%. If the page and the contract ever disagree, the page is telling people the wrong
  // number about their own money.
  const at = r => page.evaluate(x => window.__SNOOZE.burnAt(x), r);
  near("at the average, nothing burns", await at(1), 0);
  near("below the average, nothing burns", await at(0.5), 0);
  near("a 50% premium burns a third", await at(1.5), 1 / 3, 1e-12);
  near("double burns half", await at(2), 0.5, 1e-12);
  near("triple burns two thirds", await at(3), 2 / 3, 1e-12);
  ok("the cap is 90%, not 100%", (await at(1000)) === 0.9, String(await at(1000)));
  ok("it never exceeds the cap however extreme the ratio", (await at(1e9)) <= 0.9);
  ok("it is monotone in the ratio",
     (await at(1.2)) < (await at(1.6)) && (await at(1.6)) < (await at(2.4)));
}

console.log("── the infographic says what the contracts do");
{
  ok("the pooled buy is described as one order at one price",
     /one transaction, one price/i.test(body));
  ok("Rule 1 is stated as the 24-hour average", /24-hour average/i.test(body));
  // "the tokens stop existing" is only true at devBps == 0, and the token exposes
  // supplyOnlyFalls() precisely so a page can stop guessing. snooze.html hedged this and the
  // landing page did not, which is backwards — the landing page is the one a stranger sees.
  ok("the burn is named as destruction rather than a fee",
     /destroyed rather than collected/i.test(body));
  ok("and the dev-cut exception is stated, not buried",
     /unless the launcher took a share/i.test(body));
  ok("and it names the call that settles it", /supplyOnlyFalls\(\)/.test(body));
  ok("Rule 2 is stated as 20% of balance per day",
     /20% of its balance per day/i.test(body));
  // This used to assert "not the deployer", which the contract does not support: launch()
  // cap-exempts the launcher and _move() skips the haircut for any cap-exempt sender, so that
  // wallet is outside BOTH rules. run-snooze.mjs proves it by execution. What the page owes a
  // reader is the true version, prominently, so that is what is asserted.
  ok("it does not claim the deployer is bound by the cap", !/not the deployer/i.test(body));
  ok("it says one wallet is outside both rules",
     /outside both/i.test(body) && /launcher/i.test(body));
  ok("and says why the exemption has to exist at all",
     /seeding a pool and selling into it are the same transfer/i.test(body));
  ok("and names the call a reader can check it with", /capExempt\(\)/.test(body));
  ok("and that a fresh wallet does not escape it", /the first hop is itself a transfer/i.test(body));
}

console.log("── and it says what they do not do, which is the part that gets left out");
{
  ok("the dial is named as the buyer's instant loss too",
     /also your instant loss/i.test(body));
  ok("a slow bleed is admitted to be free", /slow bleed is free/i.test(body));
  ok("the cap is not sold as a lock", /cap is not a lock/i.test(body));
  ok("and the compounding is quantified rather than hand-waved",
     /67% out in five days/i.test(body));
  ok("an unregistered venue is admitted to be outside both rules",
     /outside both rules/i.test(body));
  ok("no oracle means no Rule 1, stated plainly", /No oracle, no Rule 1/i.test(body));
  ok("and that nothing is settled until freeze() has run",
     /frozen\(\)/.test(body) && /can exempt any address/i.test(body));
  ok("the absence of an audit is on the page, not only in the repo",
     /has been audited/i.test(body) && /testnet/i.test(body));
}

console.log("── getting in: the two things that cost money to get wrong");
{
  ok("it warns that a plain ETH send will revert",
     /Do not just send ETH/i.test(body) && /revert/i.test(body));
  ok("and names the call that actually works", /deposit\(\)/.test(body));
  ok("it tells you to check the address against the checker first",
     /check it against/i.test(body) && SRC.includes('href="/checker.html"'));
  ok("it says an address from a DM or a screenshot is not an address",
     /is not an address/i.test(body));
  ok("the exit fee is described as staying with the people who stayed",
     /never paid to the deployer/i.test(body));
  // This asserted that the page says "anybody can trigger" a refund, which the contract does
  // not do: refund() and claim() both read deposited[msg.sender] and there is no refund(address).
  // The assertion was holding a false sentence in place, which is worse than not testing it.
  ok("it does not claim a stranger can refund you for you", !/anybody can trigger/i.test(body));
  ok("it says you have to call refund yourself",
     /call\s+refund\(\)\s+yourself/i.test(body.replace(/\s+/g, " ")));
  ok("and that nothing collects what nobody comes back for",
     /no sweep/i.test(body) || /sits there/i.test(body));
  ok("with nothing deployed it shows no address at all", (await txt("#poolAddr")) === "no address yet");
}

console.log("── the artwork is wired the way it was measured");
{
  const img = await page.$eval(".bear", el => ({
    src: el.getAttribute("src"), w: el.naturalWidth, h: el.naturalHeight,
    alt: el.getAttribute("alt"),
  }));
  ok("the hero uses the transparent bear, not the one with a disc baked in",
     /snooze-\d+\.webp$/.test(img.src), img.src);
  ok("and it actually loaded", img.w > 0 && img.h > 0, JSON.stringify(img));
  ok("it is decorative, so it carries an empty alt rather than a fake description",
     img.alt === "", JSON.stringify(img.alt));
  const bytes = fs.statSync(path.join(ROOT, "web", img.src.replace(/^\//, ""))).size;
  ok("the hero is not a megabyte of PNG on somebody's phone", bytes < 120 * 1024,
     `${(bytes / 1024).toFixed(0)} KB`);
  ok("the full-resolution originals are still in the repo",
     fs.existsSync(path.join(ROOT, "web", "snooze.png"))
     && fs.existsSync(path.join(ROOT, "web", "hero.png")));
  ok("the social card uses the one WITH a background, since a transparent PNG goes black there",
     /og:image" content="\/hero\.png"/.test(SRC));
}

console.log("── motion is optional, and layout survives a phone");
{
  ok("the float is disabled under prefers-reduced-motion",
     /@media \(prefers-reduced-motion:reduce\)\{\.bear\{animation:none\}\}/.test(SRC.replace(/\s+/g, "")) ||
     /prefers-reduced-motion[\s\S]{0,120}animation:none/.test(SRC));
  ok("it animates transform, not a layout property",
     /@keyframes bob\{[^}]*translateY/.test(SRC));
  for (const w of [320, 375, 390, 430]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(80);
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`no horizontal scroll at ${w}px`, over <= 0, `overflows by ${over}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(80);
  const h = await page.$eval(".chartwrap", el => el.getBoundingClientRect().height);
  ok("the chart is given real room on a desktop, not a strip", h >= 300, String(h));
  const wide = await page.$eval(".panels", el => getComputedStyle(el).gridTemplateColumns);
  ok("the panels go two-up on a desktop", wide.split(" ").length === 2, wide);
  await page.setViewportSize({ width: 375, height: 900 });
}

console.log("── the launch-day path, driven before launch day");
{
  const wei = n => "0x" + (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(16).padStart(64, "0");
  LOG_MODE = "ok";
  LOGS = [
    { blockNumber: "0xffff00", data: wei(0.5) },
    { blockNumber: "0xffff40", data: wei(1.25) },
    { blockNumber: "0xffff80", data: wei(2.0) },
  ];
  await load("?pool=1");
  const c = await page.evaluate(() => ({ ...window.__CHART }));
  ok("three deposits make it a market series", c.mode === "market", c.mode);
  ok("and the series has one point per deposit", c.marketSeries.length === 3,
     String(c.marketSeries.length));
  ok("the series is cumulative, not per-deposit",
     Math.abs(c.marketSeries[2][1] - 3.75) < 1e-9, JSON.stringify(c.marketSeries));
  ok("it rises monotonically, because deposits only add",
     c.marketSeries.every((p, i, a) => !i || p[1] >= a[i - 1][1]));
  const strap2 = flat(await txt("#strap"));
  ok("the strapline switches to naming the read", /Read from the chain/i.test(strap2), strap2);
  ok("and states the window it actually covered", /blocks/.test(strap2), strap2);
  ok("and the block it read at", /at block/i.test(strap2), strap2);
  // Read the stats as key/value pairs rather than as one run-together string: textContent
  // concatenates without separators, so "deposits" + "3" becomes "deposits3" and a regex for
  // the number matches the wrong thing or nothing at all.
  const statPairs = () => page.$$eval("#stats .stat", els => Object.fromEntries(
    els.map(e => [e.querySelector(".k").textContent, e.querySelector(".v").textContent])));
  const stats = await statPairs();
  ok("the pooled total is reported in ETH", stats["in the pool"] === "3.75 ETH",
     JSON.stringify(stats));
  ok("the deposit count is reported", stats["deposits"] === "3", JSON.stringify(stats));
  ok("the address is now shown", (await txt("#poolAddr")).toLowerCase() === POOL_ADDR);
}

console.log("── one deposit is not a trend, and a refusing node is not zero interest");
{
  LOGS = [{ blockNumber: "0xffff00", data: "0x" + (10n ** 18n).toString(16).padStart(64, "0") }];
  await load("?pool=1");
  const c = await page.evaluate(() => ({ ...window.__CHART }));
  ok("a single point is never drawn as a line", c.mode === "arithmetic", c.mode);
  ok("and no market series is claimed from it", c.marketSeries.length === 0);
  const one1 = await page.$$eval("#stats .stat", els => Object.fromEntries(
    els.map(e => [e.querySelector(".k").textContent, e.querySelector(".v").textContent])));
  ok("the total is still reported, because one deposit is a real number",
     one1["in the pool"] === "1 ETH", JSON.stringify(one1));

  LOGS = [];
  await load("?pool=1");
  ok("no deposits leaves the rule curve up rather than an empty box",
     (await page.evaluate(() => window.__CHART.mode)) === "arithmetic");

  LOG_MODE = "refuse";
  await load("?pool=1");
  const refused = await page.$$eval("#stats .stat", els => Object.fromEntries(
    els.map(e => [e.querySelector(".k").textContent, e.querySelector(".v").textContent])));
  ok("a node that will not serve logs is reported as unreadable, not as zero",
     refused["deposits"] === "unreadable", JSON.stringify(refused));
  ok("and the badge says so", /no log access/i.test(await txt("#liveBadge")));
  ok("no market series is invented to fill the gap",
     (await page.evaluate(() => window.__CHART.marketSeries.length)) === 0);

  LOG_MODE = "narrow";
  LOGS = [{ blockNumber: "0xffff00", data: "0x" + (10n ** 18n).toString(16).padStart(64, "0") },
          { blockNumber: "0xffff40", data: "0x" + (10n ** 18n).toString(16).padStart(64, "0") }];
  await load("?pool=1");
  const s2 = await page.$$eval("#stats .stat", els => Object.fromEntries(
    els.map(e => [e.querySelector(".k").textContent, e.querySelector(".v").textContent])));
  ok("a node that only serves a short window still works", s2["in the pool"] === "2 ETH",
     JSON.stringify(s2));
  ok("and the shorter window is reported rather than passed off as everything",
     s2["window read"] === "10,000 blocks", JSON.stringify(s2));
}

console.log("── it never shows a stale number when a read fails");
{
  LOG_MODE = "ok";
  LOGS = [];
  node.close();
  await load("?pool=1");
  const c = await page.evaluate(() => ({ ...window.__CHART }));
  ok("an unreachable node produces no market series", c.marketSeries.length === 0, c.mode);
  const e = flat(await txt("#chartEmpty"));
  ok("it says the chain could not be read", /Could not read the chain/i.test(e), e);
  ok("and says nothing is drawn rather than something stale",
     /rather than something stale/i.test(e), e);
}

ok("no page errors during the run", pageErrors.length === 0, pageErrors.join("; "));

await browser.close(); site.close();
console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
