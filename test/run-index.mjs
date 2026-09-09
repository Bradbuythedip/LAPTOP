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
// The two $SNOOZE addresses, for the same reason POOL_ADDR exists: the real constants are
// honestly empty until a launch happens, and the deployed path is the one that has to work.
const CURVE_ADDR = "0x99c793b2EDfC5e9C64d5978Aed8f8CF0C64a8453";
const TOKEN_ADDR = "0xA8303A4338Ad29B25D8c8cAAA7d296fdF23E4445";
let BONDED = false;
// THE PAGE UNDER TEST IS THE PRE-LAUNCH ONE, always, whatever has actually launched. Half of
// this suite asserts what a visitor sees while nothing is deployed — "not deployed" badges, a
// hidden contract row, no button — and the other half asserts the deployed path through
// ?curve=1. Once web/index.html carries real addresses the first half tests a page that no
// longer exists and fails, which is what happened the hour after the launch. So the served
// default is blanked and the deployed state is the query parameter, both derived from the one
// real file so a change to it still reaches both.
const BLANK = SRC
  .replace(/^const SNOOZE_CURVE = "[^"]*";/m, 'const SNOOZE_CURVE = "";')
  .replace(/^const SNOOZE_TOKEN = "[^"]*";/m, 'const SNOOZE_TOKEN = "";')
  .replace(/^const TOKEN = "[^"]*";/m, 'const TOKEN = "";');

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
      // The one call the buy card makes. Everything else still refuses, so a page that starts
      // reading something new fails here rather than quietly getting a zero word back.
      if (m.method === "eth_call" && m.params && m.params[0] && m.params[0].data === "0xe88dc357")
        return { jsonrpc: "2.0", id: m.id,
                 result: "0x" + (BONDED ? "1" : "0").padStart(64, "0") };
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
    return res.end(BLANK.replace('const POOL  = "";', `const POOL  = "${POOL_ADDR}";`));
  }
  if (rel === "/" && u.searchParams.get("curve")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(BLANK.replace('const SNOOZE_CURVE = "";', `const SNOOZE_CURVE = "${CURVE_ADDR}";`)
                        .replace('const SNOOZE_TOKEN = "";', `const SNOOZE_TOKEN = "${TOKEN_ADDR}";`));
  }
  if (rel === "/" || rel === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(BLANK);
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
  // It drew Rule 1's haircut, which this launch's oracle makes impossible — a picture of the
  // most prominent false claim on the page. What it draws now is the price the contract
  // actually charges, which is also the only number a buyer is deciding about.
  ok("the x axis is ETH bought, not a date",
     /ETH bought/.test(axes) && !/\bdate|\btime\b/i.test(axes), axes);
  ok("the y axis is the price multiple", /price: 1/.test(axes) && /10/.test(axes), axes);
  ok("and nothing on the chart claims a sale is burned",
     !/burned on sale|sale burns|burns most/i.test(axes + " " + strap), axes + " " + strap);
}

console.log("── the curve is the contract's arithmetic, not a drawing of it");
{
  // priceMultipleBps() in contracts/SnoozeCurve.sol: ((E0+R)/E0)^2, in bps there and as a
  // multiple here. If the page and the contract disagree, the page is telling people the
  // wrong number about the price they are about to pay.
  const at = r => page.evaluate(x => window.__SNOOZE.priceAt(x), r);
  near("nothing bought, nothing moved", await at(0), 1);
  near("the token side cancels, so E0 alone sets it", await at(10), 4, 1e-12);
  near("and 21.62 ETH is exactly a 10x, which is where it bonds",
       await at(21.622776601683793), 10, 1e-9);
  ok("it is monotone in the ETH raised",
     (await at(1)) < (await at(5)) && (await at(5)) < (await at(20)));
  ok("and it never goes below where it opened", (await at(-5)) === 1 && (await at(0)) === 1);
}

console.log("── the page says what the mechanism is, in as few words as it takes");
{
  // This asserted "anyone can launch". The deployer is now locked to one address until the
  // first token is out, so that sentence became false and the assertion was holding it up.
  // What the page owes a reader is the true version, in the steps AND in the limits.
  ok("it does not claim to be permissionless while the deployer is locked",
     !/anyone can launch/i.test(body));
  ok("it says $SNOOZE launches first", /\$SNOOZE launches first/i.test(body));
  ok("and repeats it where the limits are listed",
     /not permissionless yet/i.test(body) && /nobody else can launch/i.test(body));
  ok("while being clear that buying is open to everyone", /Anyone can BUY/i.test(body));
  ok("it says the price is a curve rather than a pool", /a curve, not a pool/i.test(body));
  ok("and does not describe itself as a launchpad", !/launchpad/i.test(body));
  ok("it says the curve can only pay out what came in",
     /only ever pay out the ETH that came in/i.test(body));
  ok("bonding is described with a number, not a vibe",
     /21\.6 ETH/.test(body) && /burns itself/i.test(body));
  // THE CLAIM THAT WOULD HAVE BEEN FALSE. This launch's oracle answers "not ready" forever,
  // so no sale is ever burned — and the page led on a burn, in its headline, its meta
  // description and its chart. tools/publish.mjs now refuses to publish the buy card while
  // that copy is present; this is the same rule, from the reader's side.
  ok("the page never promises a burn it cannot deliver",
     !/spike burns|burns most of what/i.test(body), (body.match(/[^.]*burns[^.]*\./i) || [])[0]);
  ok("and says outright that nothing is ever burned on a sale",
     /Nothing is ever burned on a sale/i.test(body));
  ok("with the reason, which is that the oracle is immutable and never ready",
     /not ready/i.test(body) && /immutable/i.test(body));
  // "LAPTOP is the first launch on $SNOOZE" was never true — it was invented here and the
  // assertion was holding it up. What the owner actually said is that holding one gets you the
  // other, so that is what is asserted, and the invented version is asserted ABSENT.
  ok("it does not claim LAPTOP launches on $SNOOZE",
     !/first launch on it/i.test(body) && !/Launchpad on Base/i.test(body));
  ok("the hero says what the pair is in one line",
     /\$SNOOZE is the ticket\. LAPTOP is the show\./i.test(body));
  ok("and the page shows the two rather than explaining them",
     (await page.$$eval(".tok", els => els.length)) === 2);
  ok("LAPTOP is described as separate and on its own",
     /A separate token, on its own/i.test(body));
  ok("and as not yet buyable", /You cannot buy it yet/i.test(body));
  ok("the connection is named as one thing, not several",
     /whatever \$SNOOZE you hold at one block/i.test(body));
  ok("and it is a snapshot, not a lock", /Nothing is locked and nothing is taken/i.test(body));
  ok("and the dynamic is stated, not just the rule",
     /pays holders, not renters/i.test(body));
  ok("including that the cap still applies to somebody renting the gate",
     /cap still holds you to a fifth a day/i.test(body));
  ok("the claim is self-service, because nothing can claim for you",
     /You claim it yourself, from your own wallet/i.test(body));
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
  ok("the LP being burned is stated as automatic, and as nobody's choice",
     /LP burns itself/i.test(body) && /Nobody picks where it goes/i.test(body));
  ok("one wallet skipping the daily cap is on the landing page, and it is named",
     /One wallet skips the daily cap/i.test(body) && /dev/i.test(body));
  ok("and so is the 1% the dev takes from every trade",
     /1% of every buy and every sell goes to the dev/i.test(body));
  ok("and it does not claim the deployer is bound", !/not the deployer/i.test(body));
  ok("most tokens never bonding is stated as normal, not hidden",
     /Most tokens never bond/i.test(body) && /normal outcome/i.test(body));
  ok("the absence of an audit is on the page, not only in the repo",
     /No audit, no testnet/i.test(body));
  // Every address slot on the page says so for itself, which is stronger than one sentence
  // somewhere saying it about all of them.
  // Only the slots a visitor can see. The owner panel and the hidden contract row are not on
  // screen, and asserting over them measured markup rather than what anybody reads.
  const slots = await page.$$eval(".ca .v", els => els
    .filter(e => e.getBoundingClientRect().height > 0)
    .map(e => e.textContent.trim()));
  ok("every address slot on screen says the same thing",
     slots.length >= 2 && new Set(slots).size === 1 && /not deployed/i.test(slots[0]),
     JSON.stringify(slots));
  ok("and each token carries its own state badge",
     (await page.$$eval(".tok .badge", els => els.map(e => e.textContent.trim())))
       .every(t => /not (deployed|open)/i.test(t)));
}

console.log("── the first action on the page is the one the owner asked for");
{
  const order = await page.$$eval("h1, .card, section.card", els =>
    els.map(e => (e.id || e.tagName + ":" + (e.textContent || "").trim().slice(0, 18))));
  const buyAt = order.findIndex(x => x === "buy");
  const liveAt = order.findIndex(x => x === "live");
  ok("the Buy $SNOOZE card exists", buyAt >= 0, JSON.stringify(order));
  ok("and comes before everything else on the page", buyAt >= 0 && buyAt < liveAt,
     JSON.stringify(order.slice(0, 5)));
  const cta = await page.$eval(".heroCta a.cta", a => a.getAttribute("href") + "|" + a.textContent.trim());
  // It was Buy LAPTOP, and that was the page's worst thing: the token that launches SECOND,
  // that cannot be bought, that has no address, offered as the primary action above every badge
  // saying nothing is live. $SNOOZE is what launches first and the only thing anybody can act
  // on, so it is what the first button points at.
  ok("the hero's primary action is Buy $SNOOZE", cta === "#buy|Buy $SNOOZE", cta);
  ok("and the first card sells the same thing the first button does",
     /Buy \$SNOOZE/.test(await page.$eval("#buy h2", e => e.textContent)));
  ok("and it says how, which is the question the mechanism copy never answered",
     (await page.$$eval("#buy .howto li", els => els.length)) >= 3);
  ok("the contract row is hidden while there is no contract",
     await page.isHidden("#buyCaRow"));
  // One word for one state. The page used to carry three — "not launched" in the buy card,
  // "not deployed" on the token, "not open" on LAPTOP — for two facts, and a reader has to
  // decide whether they mean different things. Two of them did not. ("not open" survives
  // because it IS a different fact: LAPTOP can exist with the window still shut.)
  ok("and the card says so rather than showing a blank", /not deployed/i.test(body));
  const words = await page.$$eval("#buy .badge, .tok .badge", els =>
    [...new Set(els.map(e => e.textContent.trim().toLowerCase()))]);
  ok("and every 'nothing is on chain yet' badge uses the same words",
     words.filter(w => !/^not open$/.test(w)).every(w => w === "not deployed"),
     words.join(" / "));
  ok("with no button, because there is nothing for one to do yet",
     await page.isHidden("#buyCta"));
  const copy = await page.$$eval(".copy", els => els.length);
  ok("there is a copy control ready for the address", copy === 1, String(copy));
}

console.log("── shorter, because the page is for people deciding in a minute");
{
  // The depth/slippage table was the least degen thing on the page and the most mechanism per
  // word: three rows proving a second-order fact about virtual ETH. The numbers still live on
  // /size.html and /launch.html, and the two sentences worth keeping moved into the honest
  // list, where somebody reading the risks will actually meet them.
  ok("the mechanism table is gone from the landing page", !/Depth costs speed/i.test(body));
  ok("but virtual ETH not buying depth is still said", /does not buy depth/i.test(body));
  ok("and the cliff at graduation, since it runs the wrong way",
     /worse at bonding/i.test(body));
  const words = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim()
                                            .split(" ").filter(Boolean).length);
  ok("the whole visible page is well inside the budget, not just under it", words < 620,
     words + " words");
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

console.log("── the owner view is a convenience and says so");
{
  ok("it is hidden with no wallet connected", await page.isHidden("#ownerPanel"));
  // Injecting an account the way Phantom would, to check the match is on the address and not
  // on merely being connected.
  // Driving the decision directly rather than through a reload: page.evaluate sets
  // window.phantom and page.reload immediately wipes it, so the injected wallet was never
  // there when the page looked for it and the panel stayed hidden for the right address.
  const show = async who => {
    await page.evaluate(a => window.__OWNER.view(a), who);
    await page.waitForTimeout(50);
  };
  await show("0x00000000000000000000000000000000deadbeef");
  ok("and stays hidden for a wallet that is not the owner",
     await page.isHidden("#ownerPanel"));
  await show("0x4296e9A65582358221EEd0e9A2B4EC94ad4F5929");
  ok("it appears for the owner's address, whatever its casing",
     await page.isVisible("#ownerPanel"));
  const t = flat(await txt("#ownerPanel"));
  ok("and says outright that it is a convenience, not a permission",
     /convenience, not a permission/i.test(t), t.slice(0, 120));
  ok("and names what the real gate is", /onlyOwner/.test(t));
  ok("the fee destination shown is the owner",
     (await txt("#oFees")).toLowerCase() === "0x4296e9a65582358221eed0e9a2b4ec94ad4f5929",
     await txt("#oFees"));
  await show(null);
  ok("disconnecting hides it again", await page.isHidden("#ownerPanel"));
  // And the load-time path, which is the one a real visitor takes: an already-connected wallet
  // is read with eth_accounts and nothing is prompted.
  const ctx2 = await browser.newContext({ viewport: { width: 375, height: 900 } });
  await ctx2.addInitScript(a => {
    window.phantom = { ethereum: {
      request: ({ method }) => Promise.resolve(method === "eth_accounts" ? [a] : null),
      on(){} } };
  }, "0x4296e9A65582358221EEd0e9A2B4EC94ad4F5929");
  const p2 = await ctx2.newPage();
  const asked = [];
  await p2.exposeFunction("__note", m => asked.push(m));
  await p2.goto(SITE + "/", { waitUntil: "load" });
  await p2.waitForTimeout(300);
  ok("an already-connected owner sees it on load, with no prompt",
     await p2.isVisible("#ownerPanel"));
  await ctx2.close();
}

console.log("── disclosures look like disclosures");
{
  // Checked across the site, not only here: a <summary> styled as dim text is a control whose
  // only signifier somebody removed.
  for (const f of ["index.html", "checker.html", "buy.html", "size.html", "slot.html"]) {
    const src = fs.readFileSync(path.join(ROOT, "web", f), "utf8");
    if (!/<summary/.test(src)) { ok(`${f} has no disclosure to signpost`, true); continue; }
    ok(`${f} gives its disclosures a caret`,
       /summary::before\{content:""/.test(src.replace(/\s+/g, "")) ||
       /summary::before/.test(src), "a summary with no marker");
    ok(`${f} gives them a real tap target`, /summary\{[^}]*min-height:3\dpx/.test(src));
  }
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

console.log("── the buy button lands on a buy, and stops when the curve does");
{
  // What "tradable at snoozebear.xyz" comes down to, given that no page here may ever sign:
  // the button has to put a person on the exact screen where their own wallet can call buy().
  // It used to link to the contract's Basescan ADDRESS page, which is a place to read about a
  // contract and not a place to buy anything — three clicks and a tab nobody names away from
  // the thing the card is for.
  BONDED = false;
  await load("?curve=1");
  const cta = await page.$("#buyCta");
  ok("the buy button is shown once the curve exists", !(await cta.evaluate(e => e.hidden)));
  const href = await cta.getAttribute("href");
  ok("and it lands on the Write Contract tab, not the address page",
     href === "https://basescan.org/address/" + CURVE_ADDR + "#writeContract", href);
  // The fallback is deliberate: with no buy page hosted yet, Basescan is clumsy and real,
  // and a link to a domain nobody has set up would be neither. Setting BUY_APP swaps it.
  ok("that is the FALLBACK, and the page says so rather than leaving it a mystery",
     /Empty is the honest state/.test(SRC) && /const BUY_APP = "";/.test(SRC));
  // And the launched page still is the pre-launch page plus addresses, which is what makes
  // blanking it a fair substitute rather than a different page.
  ok("blanking the three constants is the only difference between the two states",
     BLANK.replace(/const (SNOOZE_CURVE|SNOOZE_TOKEN|TOKEN) = "";/g, "X").length ===
     SRC.replace(/const (SNOOZE_CURVE|SNOOZE_TOKEN|TOKEN) = "[^"]*";/g, "X").length);
  {
    const withApp = BLANK.replace('const BUY_APP = "";', 'const BUY_APP = "https://buy.example";')
                       .replace('const SNOOZE_CURVE = "";', `const SNOOZE_CURVE = "${CURVE_ADDR}";`)
                       .replace('const SNOOZE_TOKEN = "";', `const SNOOZE_TOKEN = "${TOKEN_ADDR}";`);
    const p2 = await ctx.newPage();
    await p2.route("**/*", r => r.request().url().endsWith("/index.html") || r.request().url().endsWith("/")
      ? r.fulfill({ contentType: "text/html", body: withApp })
      : r.fulfill({ status: 404, body: "" }));
    await p2.goto("http://swapped.test/index.html", { waitUntil: "load" });
    await p2.waitForTimeout(300);
    ok("with a buy page configured the button goes there instead",
       (await p2.$eval("#buyCta", e => e.getAttribute("href"))) === "https://buy.example",
       await p2.$eval("#buyCta", e => e.getAttribute("href")));
    ok("and the instructions stop describing a block explorer",
       /where you sign/.test(await p2.$eval("#buyHow3", e => e.textContent)),
       await p2.$eval("#buyHow3", e => e.textContent));
    await p2.close();
  }
  ok("the card names the tab the button lands on, so the two agree",
     /Write Contract/.test(await txt("#buyHow3")), await txt("#buyHow3"));
  ok("and it still says a plain send reverts, which is how people lose money here",
     /plain send reverts/.test(await txt("#buyHow3")));
  ok("the badge says the curve is live", (await txt("#buyBadge")) === "live");
  ok("and the footer stops saying nothing is deployed",
     !/Nothing is deployed/.test(await txt("#buyFoot")), await txt("#buyFoot"));

  // buy() is `if (bonded) revert AlreadyBonded()` on its first line. After bond() the button
  // above sends people at a function that reverts while the page still looks correct, which is
  // the worst kind of broken.
  BONDED = true;
  await load("?curve=1");
  ok("once the curve has bonded the badge says so", (await txt("#buyBadge")) === "bonded");
  const href2 = await page.$eval("#buyCta", e => e.getAttribute("href"));
  ok("and the button stops pointing at a buy() that now reverts",
     !/#writeContract/.test(href2), href2);
  ok("it points at the token, wherever the token trades",
     href2 === "https://dexscreener.com/base/" + TOKEN_ADDR, href2);
  const how = await txt("#buyHow3");
  ok("and the card says the curve has closed", /curve has closed/i.test(how), how);
  // bond(pool) hands the ETH and the tokens to an address the CALLER names and creates no pool
  // of anything — contracts/SnoozeCurve.sol:290. So naming a venue here would be a claim the
  // contract does not support, and this is the assertion that stops one being added back.
  // Read from what a VISITOR sees and where the button goes, not from the source: the comment
  // beside this code says the word "Uniswap" in order to explain why the page must not.
  // The page may NAME Uniswap now — bond() really does create the V2 pair, and saying so is a
  // fact rather than a hope. What must not happen is the button hardcoding a swap URL: where
  // the token trades is still something to read off the chain, and a token page stays right
  // if the factory in deploy/config.json ever changes.
  ok("the bonded button points at the token, not at a hardcoded exchange",
     href2 === "https://dexscreener.com/base/" + TOKEN_ADDR, href2);
  ok("and the page says where graduation goes, since it is fixed in the contract",
     /Uniswap pool/i.test(await page.evaluate(() => document.body.innerText)));
  ok("and the deployed page is still inside the word budget",
     (await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim()
                                  .split(" ").filter(Boolean).length)) < 700,
     await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim()
                                 .split(" ").filter(Boolean).length) + " words");
  BONDED = false;
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
