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

console.log("── the page says what the mechanism is, in as few words as it takes");
{
  // This asserted "anyone can launch". The deployer is now locked to one address until the
  // first token is out, so that sentence became false and the assertion was holding it up.
  // What the page owes a reader is the true version, in the steps AND in the limits.
  ok("it does not claim to be permissionless while the deployer is locked",
     !/anyone can launch/i.test(body));
  ok("it says one wallet launches, for now", /One wallet launches, for now/i.test(body));
  ok("and repeats it where the limits are listed",
     /not permissionless yet/i.test(body) && /nobody else can launch/i.test(body));
  ok("while being clear that buying is open to everyone", /Anyone can BUY/i.test(body));
  ok("it says the price is a curve rather than a pool", /a curve, not a pool/i.test(body));
  ok("it says the curve can only pay out what came in",
     /only ever pay out the ETH that came in/i.test(body));
  ok("bonding is described with a number, not a vibe",
     /2\.16/.test(body) && /bonds/i.test(body));
  ok("Rule 1 is stated against the 24-hour average", /24-hour average/i.test(body));
  ok("LAPTOP is named as the first launch on the pad",
     /LAPTOP is the first launch on it/i.test(body));
  ok("the gate is stated in the hero, where the decision is made",
     /Hold \$SNOOZE to bid on LAPTOP at launch/i.test(body));
  ok("and the dynamic is stated, not just the rule",
     /pays holders, not renters/i.test(body));
  ok("including that renting the gate is the worst way to use it",
     /worst way to use it/i.test(body));
  ok("the claim is self-service, because nothing can claim for you",
     /claimed by you, from your own wallet/i.test(body));
  // textContent on <body> sweeps up the inline <script> too, which is most of this file and
  // none of the page. innerText is what a reader actually sees.
  const seen = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
  ok("the whole visible page is under 700 words",
     seen.split(" ").filter(Boolean).length < 700,
     seen.split(" ").filter(Boolean).length + " words");
}

console.log("── and what it does not do, which is the part a launch page leaves out");
{
  ok("virtual liquidity is not sold as liquidity",
     /Virtual liquidity is not liquidity/i.test(body));
  ok("and it says what is actually behind the price before bonding",
     /only ETH behind the price is what buyers put in/i.test(body));
  ok("the burn is named as the buyer's instant loss too",
     /also your instant loss/i.test(body));
  ok("a falling market is admitted to burn nothing",
     /falling market burns nothing/i.test(body));
  ok("one wallet being outside both rules is on the landing page",
     /One wallet is outside both rules/i.test(body) && /launcher/i.test(body));
  ok("and it does not claim the deployer is bound", !/not the deployer/i.test(body));
  ok("most tokens never bonding is stated as normal, not hidden",
     /Most tokens never bond/i.test(body) && /normal outcome/i.test(body));
  ok("the absence of an audit is on the page, not only in the repo",
     /No audit, no testnet/i.test(body));
  ok("it states plainly that nothing is deployed", /Nothing is deployed/i.test(body));
  ok("and that anything shown today is not it", /is not it/i.test(body));
}

console.log("── the first action on the page is the one the owner asked for");
{
  const order = await page.$$eval("h1, .card, section.card", els =>
    els.map(e => (e.id || e.tagName + ":" + (e.textContent || "").trim().slice(0, 18))));
  const buyAt = order.findIndex(x => x === "buy");
  const liveAt = order.findIndex(x => x === "live");
  ok("the Buy LAPTOP card exists", buyAt >= 0, JSON.stringify(order));
  ok("and comes before everything else on the page", buyAt >= 0 && buyAt < liveAt,
     JSON.stringify(order.slice(0, 5)));
  const cta = await page.$eval(".heroCta a.cta", a => a.getAttribute("href") + "|" + a.textContent.trim());
  ok("the hero's primary action is Buy LAPTOP", cta === "#buy|Buy LAPTOP", cta);
  ok("the contract row is hidden while there is no contract",
     await page.isHidden("#lapCaRow"));
  ok("and the card says so rather than showing a blank", /not launched/i.test(body));
  const copy = await page.$$eval(".copy", els => els.length);
  ok("there is a copy control ready for the address", copy === 1, String(copy));
}

console.log("── depth costs speed, with the numbers rather than the adjective");
{
  ok("the trade-off is stated as a trade-off", /Depth costs speed/i.test(body));
  const rows = await page.$$eval("table tbody tr", rs =>
    rs.map(r => [...r.querySelectorAll("td")].map(c => c.textContent.trim())));
  ok("three slippage settings are tabulated", rows.length === 3, JSON.stringify(rows));
  // Against bond_model.py's closed form, not against the copy that quotes it. The count is
  // ceil((sqrt(10)-1)/x) and E0 is not in it — which is the whole point of the card.
  for (const r of rows) {
    const x = Number(String(r[0]).replace("%", "")) / 100;
    const want = Math.ceil((Math.sqrt(10) - 1) / x);
    ok(`a ${r[0]} buy needs ceil((sqrt(10)-1)/x) = ${want} of them to bond`,
       Number(r[1]) === want, `the page says ${r[1]}`);
    ok(`and the count is identical at 3 and at 25 virtual ETH`,
       Number(r[2]) === want && Number(r[3]) === want, JSON.stringify(r));
  }
  ok("and it says outright that virtual ETH does not buy depth",
     /does not buy depth/i.test(body));
  ok("the cliff at graduation is disclosed, since it runs the wrong way",
     /worse at bonding/i.test(body));
}

console.log("── every word that needs defining has one attached to it");
{
  const defs = await page.$$eval(".d", els => els.map(e => ({
    word: e.textContent.trim(), title: e.dataset.t || "", def: e.dataset.d || "",
    tag: e.tagName, type: e.getAttribute("type"), aria: e.getAttribute("aria-label"),
    border: parseFloat(getComputedStyle(e).borderTopWidth) || 0,
  })));
  ok("there are definitions on the page", defs.length >= 5, String(defs.length));
  for (const d of defs) {
    ok(`"${d.word}" has a definition`, d.def.length > 10, JSON.stringify(d));
    ok(`"${d.word}" is short enough for a popover`, d.def.split(/\s+/).length <= 30,
       d.def.split(/\s+/).length + " words");
    ok(`"${d.word}" is keyboard-reachable and named for a screen reader`,
       d.tag === "BUTTON" && d.type === "button" && !!d.aria, JSON.stringify(d));
    ok(`"${d.word}" reads as a word, not as a control`, d.border === 0, String(d.border));
  }
  await page.click(".d");
  ok("clicking a term opens the definition", !(await page.isHidden("#defbox")));
  ok("and the box names the term", (await txt("#defTitle")).length > 0);
  await page.click("#defClose");
  ok("the close control closes it", await page.isHidden("#defbox"));
  await page.click(".d");
  await page.keyboard.press("Escape");
  ok("and so does Escape", await page.isHidden("#defbox"));
}

console.log("── Base blue where it clears contrast, and nowhere else");
{
  ok("the real Base blue is in the palette", /--base:\s*#0052ff/i.test(SRC));
  ok("with a lifted tint for anything that has to be read", /--baseLt:\s*#5b94ff/i.test(SRC));
  // #0052ff is 2.91:1 on this ground — under the 4.5 for text and under the 3 for a border.
  // As a fill with white on it, it is 5.75:1. So it fills and it does not speak.
  const misuse = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      const st = getComputedStyle(el);
      if (st.color === "rgb(0, 82, 255)") out.push((el.className || el.tagName) + ":text");
      if (st.borderTopColor === "rgb(0, 82, 255)" && parseFloat(st.borderTopWidth) > 0)
        out.push((el.className || el.tagName) + ":border");
    }
    return out;
  });
  ok("the brand blue is never text and never a border", misuse.length === 0,
     misuse.join(", "));
  const chip = await page.$eval(".chain", el => {
    const st = getComputedStyle(el); return { bg: st.backgroundColor, fg: st.color };
  });
  ok("the chain chip fills with it and puts white on top",
     chip.bg === "rgb(0, 82, 255)" && chip.fg === "rgb(255, 255, 255)", JSON.stringify(chip));
  ok("and the page names the chain and its id", /Base/.test(body) && /8453/.test(body));
}

console.log("── the tools are places to go, not a row of buttons");
{
  const tools = await page.$$eval(".tools a", els => els.map(e => {
    const st = getComputedStyle(e);
    return { text: e.textContent.trim(), border: parseFloat(st.borderTopWidth) || 0,
             bg: st.backgroundColor, h: e.getBoundingClientRect().height };
  }));
  ok("there are tool links", tools.length >= 5, String(tools.length));
  for (const t of tools) {
    ok(`"${t.text}" has no button border`, t.border === 0, String(t.border));
    ok(`"${t.text}" has no button fill`,
       t.bg === "rgba(0, 0, 0, 0)" || t.bg === "transparent", t.bg);
    ok(`"${t.text}" is still a big enough tap target`, t.h >= 36, String(t.h));
  }
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
  const wide = await page.$eval(".steps", el => getComputedStyle(el).gridTemplateColumns);
  ok("the steps go two-up on a desktop", wide.split(" ").length === 2, wide);
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
