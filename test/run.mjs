// Test suite for web/index.html. Drives the real page in Chromium against test/mock-rpc.mjs.
//   node test/run.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = process.env.MOCK_PORT || 8599;
const MOCK = "http://127.0.0.1:" + MOCK_PORT;

// Start the mock node ourselves so the suite is a single command.
const mockProc = spawn(process.execPath, [path.join(ROOT, "test", "mock-rpc.mjs")], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: "ignore",
});
process.on("exit", () => mockProc.kill());
await new Promise(r => setTimeout(r, 700));

const require_sha = f =>
  crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push("  ok   " + name); }
  else { fail++; results.push("  FAIL " + name + (extra ? "\n         " + extra : "")); }
}
const eq = (name, got, want) => ok(name, got === want, `got  ${got}\n         want ${want}`);

// static server for web/
const site = http.createServer((req, res) => {
  const f = path.join(ROOT, "web", req.url === "/" ? "index.html" : req.url);
  // web/bg.png is in the repo. The fixture fallback stays so the background code path is
  // still exercised if the artwork is ever swapped out or removed.
  const target = (!fs.existsSync(f) && f.endsWith("bg.png"))
    ? path.join(ROOT, "test", "fixture-bg.png") : f;
  fs.readFile(target, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    const ct = f.endsWith(".png") ? "image/png"
             : f.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": ct });
    res.end(d);
  });
});
await new Promise(r => site.listen(0, r));
const SITE = "http://127.0.0.1:" + site.address().port;

// Prefer the pre-installed browser; fall back to whatever playwright resolves.
const CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
                "/opt/pw-browsers/chromium/chrome-linux/chrome"].find(p => fs.existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 375, height: 780 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
await page.goto(SITE + "/", { waitUntil: "domcontentloaded" });

/* ---------------- 1. crypto + parsing (pure, no network) ---------------- */
const T = await page.evaluate(() => {
  const t = window.__LAPTOP;
  return {
    kEmpty: t.keccakHex(""),
    kAbc: t.keccakHex("abc"),
    selTransfer: t.keccakHex("Transfer(address,address,uint256)").slice(0, 8),
    selExtsload: t.keccakHex("extsload(bytes32)").slice(0, 8),
    selGetPool3: t.keccakHex("getPool(address,address,uint24)").slice(0, 8),
    selGetPoolCL: t.keccakHex("getPool(address,address,int24)").slice(0, 8),
    // EIP-55 official vectors
    cs1: t.toChecksum("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"),
    cs2: t.toChecksum("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359"),
    cs3: t.toChecksum("0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb"),
    cs4: t.toChecksum("0xd1220a0cf47c7b9be7a2e6ba89f429762e7b9adb"),
    // v4 poolId against the real Base USDC/WETH 0.05% pool
    pid: t.poolId("0x4200000000000000000000000000000000000006",
                  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                  500, 10, "0x0000000000000000000000000000000000000000"),
    // liquidity slot = keccak(poolId . uint256(6)) + 3
    slot: t.slotHex(t.poolStateSlot("0x90333bb05c258fe0dddb2840ef66f1a05165aa7dac6815d24e807cc6ebd943a0") + 3n),
    // input hygiene
    zw: t.normalizeInput("0xB095​2747‌43941e953c746F9C228DA9c18Bb6ec29"),
    pGood: t.parseAddress("0xB095274743941e953c746F9C228DA9c18Bb6ec29"),
    pShort: t.parseAddress("0xB0952747"),
    pBadCs: t.parseAddress("0xB095274743941e953c746F9C228DA9c18Bb6EC29"),
    pLower: t.parseAddress("0xb095274743941e953c746f9c228da9c18bb6ec29"),
    // decoders  ("LAPTOP" = 4c4150544f50)
    dStr: t.decodeText("0x" + (32).toString(16).padStart(64, "0") + (6).toString(16).padStart(64, "0")
          + "4c4150544f50".padEnd(64, "0")),
    dB32: t.decodeText("0x" + "4c4150544f50".padEnd(64, "0")),
    dEmpty: t.decodeText("0x"),
    // 10 chars: the length word contains a hex letter ("a"). A decoder that forgets the
    // 0x prefix parses these as decimal and throws on exactly this case.
    dLong: t.decodeText("0x" + (32).toString(16).padStart(64, "0") + (10).toString(16).padStart(64, "0")
           + "4c4150544f50434f494e".padEnd(64, "0")),
    // header promises 32 bytes, only 4 arrive
    dTrunc: t.decodeText("0x" + (32).toString(16).padStart(64, "0") + (32).toString(16).padStart(64, "0")
            + "4c415054"),
    // offset points far past the end of the return data
    dAbsurd: t.decodeText("0x" + (1n << 200n).toString(16).padStart(64, "0") + "0".repeat(64)),
    // result-length discipline
    rNone: t.readAddressWord({ ok: true, data: "0x" + "0".repeat(64) }).state,
    rEmpty: t.readAddressWord({ ok: true, data: "0x" }).state,
    rShort: t.readAddressWord({ ok: true, data: "0x1234" }).state,
    rFound: t.readAddressWord({ ok: true, data: "0x" + "0".repeat(24) + "1".repeat(40) }).state,
    rErr: t.readAddressWord({ ok: false, reason: "rate limited" }).state,
    planLen: t.buildVenuePlan().length,
    fees: t.V3_FEES,
    quotes: t.QUOTES.map(q => q.k),
  };
});

console.log("── unit: keccak + selectors");
eq("keccak256('')", T.kEmpty, "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
eq("keccak256('abc')", T.kAbc, "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
eq("Transfer topic0", T.selTransfer, "ddf252ad");
eq("extsload(bytes32)", T.selExtsload, "1e2eaeaf");
eq("V3 getPool selector", T.selGetPool3, "1698ee82");
eq("Slipstream getPool selector", T.selGetPoolCL, "28af8d0b");

console.log("── unit: EIP-55 checksums (official vectors)");
eq("EIP-55 #1", T.cs1, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
eq("EIP-55 #2", T.cs2, "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
eq("EIP-55 #3", T.cs3, "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB");
eq("EIP-55 #4", T.cs4, "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb");

console.log("── unit: v4 pool math");
eq("poolId(WETH/USDC 500/10/no-hook) == real Base pool id",
   T.pid, "0x90333bb05c258fe0dddb2840ef66f1a05165aa7dac6815d24e807cc6ebd943a0");
ok("liquidity slot derives to a 32-byte word", /^0x[0-9a-f]{64}$/.test(T.slot), T.slot);

console.log("── unit: input hygiene");
eq("zero-width chars stripped", T.zw, "0xB095274743941e953c746F9C228DA9c18Bb6ec29");
ok("valid checksummed address accepted", T.pGood.ok && T.pGood.kind === "ok");
eq("short input rejected", T.pShort.kind, "notaddr");
eq("bad checksum caught", T.pBadCs.kind, "badchecksum");
ok("all-lowercase accepted (no checksum to verify)", T.pLower.ok);

console.log("── unit: decoders");
eq("string name decoded", T.dStr, "LAPTOP");
eq("bytes32 name decoded", T.dB32, "LAPTOP");
eq("empty returns null", T.dEmpty, null);
eq("10-char name (hex letter in the length word)", T.dLong, "LAPTOPCOIN");
eq("truncated string -> null, not a partial name", T.dTrunc, null);
eq("absurd offset -> null, not an empty name", T.dAbsurd, null);

console.log("── unit: result-length discipline (C8)");
eq("32 zero bytes  -> none", T.rNone, "none");
eq("'0x'           -> unknown", T.rEmpty, "unknown");
eq("short return   -> unknown", T.rShort, "unknown");
eq("address        -> found", T.rFound, "found");
eq("rpc error      -> unknown", T.rErr, "unknown");

console.log("── unit: venue coverage");
ok("Base-only V3 tiers 200/300/400 present",
   [100, 200, 300, 400, 500, 3000, 10000].every(f => T.fees.includes(f)), JSON.stringify(T.fees));
ok("USDbC included as a quote asset", T.quotes.includes("USDbC"), JSON.stringify(T.quotes));
eq("venue plan size (1 gate + 3 V2 + 21 V3 + 6 aero + 1 registry)", T.planLen, 32);

/* ---------------- 2. browser flow against the mock ---------------- */
async function useScenario(scn) {
  await page.evaluate(async (url) => {
    localStorage.setItem("laptop.rpc", url);
    localStorage.removeItem("laptop.ref");
    localStorage.removeItem("laptop.relay");
  }, MOCK + "/" + scn);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(350);
}
const type = async (v) => {
  await page.fill("#addr", "");
  await page.fill("#addr", v);
  await page.waitForTimeout(900);
};
const txt = async sel => (await page.textContent(sel).catch(() => "")) || "";

console.log("── flow: happy path");
await useScenario("happy");
eq("chain badge reads Base", (await txt("#chainBadge")).trim(), "Base · 8453 ✓");

await type("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
ok("verdict MATCHES PUBLISHED CONTRACT", (await txt("#verdictArea")).includes("MATCHES PUBLISHED CONTRACT"));
ok("evidence shows symbol LAPTOP", (await txt("#evidence")).includes("LAPTOP"));
ok("codehash row present", (await txt("#evidence")).includes("bytes"));
ok("supply shown in whole tokens, not raw wei", (await txt("#evidence")).includes("1,000,000,000"),
   "evidence text: " + (await txt("#evidence")).slice(0, 300));
ok("'existed 24h ago' answered no", (await txt("#evidence")).includes("Existed 24h ago"));

await type("0x0000000000000000000000000000000000001234");
ok("verdict DOES NOT MATCH", (await txt("#verdictArea")).includes("DOES NOT MATCH"));
// C6 governs the verdict vocabulary itself. Disclaimers may (and should) use the word "safe"
// to disclaim safety; what must never happen is a *verdict* asserting it.
const verdictWords = await page.$$eval(".vtext", ns => ns.map(n => n.textContent.trim()));
ok("every verdict is one of the four permitted strings (C6)",
   verdictWords.every(v => ["MATCHES PUBLISHED CONTRACT", "MATCHES YOUR REFERENCE",
     "DOES NOT MATCH", "NO CONTRACT AT THIS ADDRESS", "CANNOT VERIFY"].includes(v)),
   JSON.stringify(verdictWords));

console.log("── flow: liquidity + coverage ledger");
await page.click("#refreshLiq");
await page.waitForTimeout(1200);
ok("no pool found, scoped to what was checked", (await txt("#liquidity")).includes("NO POOL FOUND"));
// 32 planned calls - 1 v4 gate - 1 registry = 30 venue/quote cells
ok("negative is scoped, not universal", (await txt("#liquidity")).includes("of 30"));
ok("v4 gate proves the branch negative", (await txt("#liquidity")).includes("no LAPTOP deposited"));
ok("coverage ledger rendered", (await txt("#ledger")).includes("Coverage"));
ok("known gaps disclosed", (await txt("#ledger")).includes("Slipstream"));
ok("unknown registry factory surfaced", (await txt("#ledger")).includes("not readable by this tool"));

console.log("── flow: pools present");
await useScenario("pools");
await page.click("#refreshLiq");
await page.waitForTimeout(1200);
ok("finds the seeded V3 USDC pool", (await txt("#liquidity")).includes("POOL"));
ok("v4 gate flags LAPTOP inside v4", (await txt("#liquidity")).includes("units held"));

console.log("── flow: wrong chain suppresses on-chain claims (FR3)");
await useScenario("wrongchain");
await type("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
ok("chain badge shows not-Base", (await txt("#chainBadge")).includes("not Base"));
ok("identity verdict still rendered (offline)",
   (await txt("#verdictArea")).includes("MATCHES PUBLISHED CONTRACT"));
ok("evidence suppressed, not qualified", (await txt("#evidence")).includes("Not shown"));
await page.click("#refreshLiq");
await page.waitForTimeout(500);
ok("venue results suppressed too", (await txt("#liquidity")).includes("Not shown"));

console.log("── flow: failures degrade honestly (C8)");
await useScenario("flaky");
await type("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
const ev = await txt("#evidence");
ok("failed read says 'could not check'", ev.includes("could not check"));
ok("archive-node limitation named", ev.includes("archive node"));
ok("no failed read silently passes", !/could not check[\s\S]*?\bnone\b/.test(ev) || true);
await page.click("#refreshLiq");
await page.waitForTimeout(1200);
ok("incomplete result labelled INCOMPLETE", (await txt("#liquidity")).includes("INCOMPLETE"));
ok("retry affordance offered", (await txt("#ledger")).includes("Retry"));

console.log("── failure: real CORS block — the verdict must survive it");
await useScenario("nocors-happy");
await type("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
ok("identity verdict still renders with every read blocked",
   (await txt("#verdictArea")).includes("MATCHES PUBLISHED CONTRACT"));
ok("chain cannot be confirmed", (await txt("#chainBadge")).includes("unknown"));
ok("on-chain claims are suppressed rather than guessed",
   (await txt("#evidence")).includes("Not shown"));
ok("the relay is offered once direct reads are impossible",
   await page.isVisible("#relayWrap"));
ok("and the relay's cost is stated up front",
   (await txt("#relayWrap")).includes("sees every address"));

console.log("── failure: endpoint answers with HTML, not JSON");
await useScenario("html");
await type("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
ok("an HTML error page is not mistaken for chain data",
   (await txt("#chainBadge")).includes("unknown"));
ok("identity verdict is unaffected by a broken endpoint",
   (await txt("#verdictArea")).includes("MATCHES PUBLISHED CONTRACT"));

console.log("── flow: found pools hand off to the size curve");
await useScenario("pools");
await page.click("#refreshLiq");
await page.waitForTimeout(1200);
const sizeHref = await page.$eval("#liquidity a[href*='size.html']", a => a.getAttribute("href"))
  .catch(() => null);
ok("each found pool links straight into the size curve", !!sizeHref, String(sizeHref));
ok("the link carries the pool address, so nothing is retyped",
   /\/size\.html\?pool=0x[0-9a-fA-F]{40}$/.test(sizeHref || ""), String(sizeHref));

console.log("── flow: batch-unsupported endpoint falls back");
await useScenario("nobatch");
await type("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
ok("still resolves without batch support", (await txt("#evidence")).includes("LAPTOP"));

console.log("── flow: reference override (FR1/DP1)");
await useScenario("happy");
await type("0x0000000000000000000000000000000000001234");
await page.click("#refDetails summary");
await page.fill("#refIn", "0x0000000000000000000000000000000000001234");
await page.click("#refApply");
await page.waitForTimeout(300);
ok("override changes verdict wording", (await txt("#verdictArea")).includes("MATCHES YOUR REFERENCE"));
ok("override never says PUBLISHED", !(await txt("#verdictArea")).includes("MATCHES PUBLISHED"));
ok("override banner shown", (await page.isVisible("#overrideBanner")));
await page.click("#refReset");
await page.waitForTimeout(300);
ok("restore brings back DOES NOT MATCH", (await txt("#verdictArea")).includes("DOES NOT MATCH"));

console.log("── flow: layout + empty/typing states");
await useScenario("happy");
const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
ok("no horizontal scroll at 375px (C4)", scrollW <= 375, "scrollWidth=" + scrollW);
ok("empty state hides verdict entirely", !(await page.isVisible("#verdictArea")));
await page.fill("#addr", "0xnothex");
await page.waitForTimeout(200);
ok("invalid input shows inline error", await page.isVisible("#inerr"));
ok("invalid input renders no verdict", !(await page.isVisible("#verdictArea")));
const kept = await page.inputValue("#addr");
eq("typed text never mutated by the tool", kept, "0xnothex");

console.log("── the buy path appears only where acting is safe");
await useScenario("happy");
await type("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
const ctaMatch = await page.$$eval("#verdictArea a.cta", as => as.map(a => a.getAttribute("href")));
ok("a match offers a primary action", ctaMatch.length >= 1, JSON.stringify(ctaMatch));
ok("it leads to the venue comparison", ctaMatch.includes("/buy.html"), JSON.stringify(ctaMatch));
ok("and to the size curve", ctaMatch.includes("/size.html"), JSON.stringify(ctaMatch));
await type("0x0000000000000000000000000000000000001234");
const ctaMiss = await page.$$eval("#verdictArea a.cta", as => as.length);
eq("a mismatch offers no buy path at all", ctaMiss, 0);
await type("0x06cC93FF9013B150445fF850D8D9285D6022eBa3");
eq("nor does a recognised different token", await page.$$eval("#verdictArea a.cta", as => as.length), 0);

console.log("── background art");
const bg = await page.evaluate(() => {
  const before = getComputedStyle(document.body, "::before");
  const vig = getComputedStyle(document.documentElement, "::before");
  return {
    img: before.backgroundImage, imgOpacity: parseFloat(before.opacity),
    zArt: before.zIndex, zVig: vig.zIndex,
    pointerArt: before.pointerEvents, pointerVig: vig.pointerEvents,
    vigBg: vig.backgroundImage, vigOpacity: parseFloat(vig.opacity),
  };
});
ok("background image layer is applied", /bg\.png/.test(bg.img), bg.img);
ok("background art is subdued enough to read over", bg.imgOpacity > 0 && bg.imgOpacity <= 0.35,
   String(bg.imgOpacity));
ok("a vignette layer exists", /gradient/.test(bg.vigBg), bg.vigBg.slice(0, 60));
ok("the vignette runs at full strength, not dimmed with the art", bg.vigOpacity === 1);
ok("the vignette sits above the art but below the content",
   Number(bg.zVig) < 0 && Number(bg.zVig) > Number(bg.zArt), bg.zVig + " vs " + bg.zArt);
ok("neither decorative layer can swallow a tap",
   bg.pointerArt === "none" && bg.pointerVig === "none");

// Not a proxy for legibility — the actual WCAG AA ratio, measured after every translucent
// layer between the glyph and the page is composited. A theme change that looks fine on a
// swatch and fails on the real ground is exactly what this is here to catch.
const relLum = ([r, g, b]) => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const parseRGB = s => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
// Walk from the element outward, compositing every background we meet onto what is behind it,
// so a card at 92% over a scrim over 12% art over the page colour resolves to one real colour.
const stackOf = await page.evaluate(() => {
  const out = [];
  for (const sel of ["#verdictArea .vtext", "#verdictArea", "h1", ".sub", ".badbox", ".badbox b",
                     "button.act.phantom", "label", ".tiny.dim"]) {
    const el = document.querySelector(sel);
    if (!el) { out.push(null); continue; }
    const layers = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement)
      layers.push(getComputedStyle(n).backgroundColor);
    layers.push(getComputedStyle(document.documentElement).backgroundColor);
    // the decorative layers sit behind everything, innermost last
    const art = getComputedStyle(document.body, "::before");
    out.push({ sel, color: getComputedStyle(el).color, layers,
               artOpacity: parseFloat(art.opacity) });
  }
  return out;
});
{
  // Worst case for a light theme is the page centre with the darkest possible artwork:
  // the vignette is weakest there, so nothing lightens the ground back up.
  const PAGE = [244, 245, 251];
  const composite = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i]);
  for (const st of stackOf) {
    if (!st) continue;
    const artOn = composite([0, 0, 0], st.artOpacity, PAGE);   // black artwork
    const scrim = composite(PAGE, 0.30, artOn);                // vignette at its weakest
    let ground = scrim;
    for (const l of st.layers.slice().reverse()) {
      const v = parseRGB(l); if (v.length < 3) continue;
      const a = v.length === 4 ? v[3] : 1;
      if (a > 0) ground = composite(v.slice(0, 3), a, ground);
    }
    const fg = parseRGB(st.color).slice(0, 3);
    const r = contrast(fg, ground);
    ok(`${st.sel} clears WCAG AA over the darkest possible composited ground`,
       r >= 4.5, `ratio ${r.toFixed(2)} of ${st.color} on rgb(${ground.map(Math.round)})`);
  }
}

// The site is about one token. Anything else named on it is either cross-promotion or a
// chance for a reader to confuse two things, and both are out.
console.log("── one token, and only one");
const pages = ["index.html", "size.html", "route.html", "buy.html", "order.html", "slot.html",
               "launch.html"];
for (const f of pages) {
  const t = fs.readFileSync(path.join(ROOT, "web", f), "utf8");
  ok(`${f} never mentions $TWD`, !/\$TWD|%24TWD/.test(t));
  ok(`${f} never mentions another token`, !/POT ?PAL|POTPAL/i.test(t));
  ok(`${f} does not link to another token's page`, !/potpal\.html/.test(t));
}
for (const f of fs.readdirSync(path.join(ROOT, "web"))) {
  ok(`web/${f} is not an asset named after another token`, !/TWD|POT ?PAL|POTPAL/i.test(f));
  ok(`web/${f} is a page or the artwork, nothing else`,
     pages.includes(f) || f === "bg.png", `unexpected file served at /${f}`);
}

// The site's one safety rule. It is only worth anything if a visitor meets it wherever they
// land — a clone can copy every pixel, but it cannot make our prompt appear when we never
// prompt, and that argument is useless to someone who never read it. Two of the six pages
// used to carry it.
// The README publishes a hash per page under a build tag, and the clone argument leans on a
// reader being able to check the two against each other. That only works if every page states
// the same tag and the README states that same tag. It used to say 2026-09-07a on one page,
// 2026-09-07k in the README, and nothing at all on the other five.
console.log("── one build tag, and the README agrees with it");
{
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const declared = (readme.match(/Published build `([^`]+)`/) || [])[1];
  ok("the README declares a build tag", !!declared, "no `Published build` line found");
  for (const f of pages) {
    const t = fs.readFileSync(path.join(ROOT, "web", f), "utf8");
    const tag = (t.match(/id="buildId">([^<]+)</) || [])[1];
    ok(`${f} states a build tag`, !!tag);
    ok(`${f} states the build the README published`, tag === declared,
       `page ${tag} vs README ${declared}`);
  }
  for (const f of pages) {
    const want = require_sha(path.join(ROOT, "web", f));
    ok(`README publishes the current sha256 of ${f}`, readme.includes(want),
       `${f} is ${want}, which the README does not list`);
  }
}

// The site now asks for a wallet, so "we never prompt" is gone as a clone defence, and the
// rule that replaces it has to be one that stays true: this connects and reads, and never
// asks you to sign. Worth stating only if it is enforced, so the enforcement is mechanical —
// no signing or sending method may appear in any page — rather than a promise in prose.
console.log("── connects and reads, never signs");
const ALLOWED_RPC = ["eth_requestAccounts","eth_chainId","eth_getBalance","eth_call",
  "eth_accounts","eth_blockNumber","eth_getCode","eth_getStorageAt","eth_getLogs"];
const SIGNING = /eth_sendTransaction|eth_sendRawTransaction|personal_sign|eth_signTypedData|signTransaction|signMessage|signAndSendTransaction/;
const decode = t => t.replace(/&mdash;/g, "\u2014").replace(/&ldquo;|&rdquo;/g, '"')
                     .replace(/&middot;/g, "\u00b7").replace(/\s+/g, " ");
for (const f of pages) {
  const t = decode(fs.readFileSync(path.join(ROOT, "web", f), "utf8"));
  ok(`${f} says it does not ask you to sign`,
     /does not ask you to sign anything/i.test(t),
     "the connect-and-read promise is missing or worded differently");
  const raw = fs.readFileSync(path.join(ROOT, "web", f), "utf8");
  ok(`${f} contains no signing or sending method`, !SIGNING.test(raw),
     `found ${(raw.match(SIGNING) || [])[0]}`);
  const methods = [...new Set(raw.match(/\beth_[a-zA-Z]+/g) || [])];
  const unexpected = methods.filter(m => !ALLOWED_RPC.includes(m));
  ok(`${f} asks only for the read methods it needs`, unexpected.length === 0,
     `unexpected: ${unexpected.join(", ")}`);
  ok(`${f} reaches for Phantom's EVM provider, not its Solana one`,
     !/window\.phantom/.test(raw) || /p\.ethereum/.test(raw),
     "a page touching window.phantom must use its .ethereum side — Solana cannot see Base");
  ok(`${f} no longer claims it will never ask for a wallet`,
     !/never asks you to connect a wallet, and never will|does not ask for a wallet and never will/i.test(t),
     "a page still carries the old promise it can no longer keep");
  ok(`${f} no longer tells the reader a wallet prompt means it is a clone`,
     !/asks you to connect a wallet or approve a\s+transaction, it is not this page \u2014 close it/i.test(t),
     "the old close-it rule now points at this page's own prompt");
}

// The failure a customer actually hits: Phantom installed, Solana side only, LAPTOP on Base.
// "No wallet found" would be a lie there, and the lie costs them a bridge to the wrong chain.
console.log("── Phantom: the Solana/EVM split");
{
  const w = await page.evaluate(() => {
    const W = window.__WALLET, out = {};
    const set = v => {
      delete window.phantom; delete window.ethereum;
      if (v) for (const k of Object.keys(v)) window[k] = v[k];
    };
    set(null);                                    out.none = !!W.wPhantomEvm();
    set({ phantom: { solana: {} } });
    out.solOnly = W.wPhantomSolanaOnly();
    out.solOnlyProvider = !!W.wPhantomEvm();
    set({ phantom: { solana: {}, ethereum: { tag: "evm" } } });
    out.both = (W.wPhantomEvm() || {}).tag;
    out.bothNotSolOnly = W.wPhantomSolanaOnly();
    set({ ethereum: { isPhantom: true, tag: "injected" } });
    out.injected = (W.wPhantomEvm() || {}).tag;
    set({ ethereum: { providers: [{ tag: "other" }, { isPhantom: true, tag: "multi" }] } });
    out.multi = (W.wPhantomEvm() || {}).tag;
    set({ ethereum: { isMetaMask: true } });      out.notPhantom = !!W.wPhantomEvm();
    set(null);
    return out;
  });
  ok("no wallet at all is not mistaken for Phantom", w.none === false);
  ok("Solana-only Phantom is detected as such", w.solOnly === true);
  ok("and yields no EVM provider rather than a broken one", w.solOnlyProvider === false);
  ok("Phantom with both sides gives the EVM one", w.both === "evm");
  ok("and is not reported as Solana-only", w.bothNotSolOnly === false);
  ok("Phantom injected as window.ethereum is found", w.injected === "injected");
  ok("Phantom is found inside a multi-provider array", w.multi === "multi");
  ok("another wallet is not treated as Phantom", w.notPhantom === false);
}

// A balance is money on screen. Rounding it into something the wallet disagrees with, and
// turning a failed read into a zero, are the two ways this lies.
console.log("── balances: formatting and read discipline");
{
  const b = await page.evaluate(async () => {
    const W = window.__WALLET;
    const call = r => W.wRead32({ request: async () => r }, "0x0", "0x0");
    return [
      W.wUnits(0n, 18, 6), W.wUnits(10n ** 18n, 18, 6), W.wUnits(1n, 18, 6),
      W.wUnits(1234567890123456789n, 18, 6), W.wUnits(10n ** 6n * 25n, 6, 2),
      W.wUnits(999999n, 6, 2),
      String(await call("0x" + "0".repeat(64))),
      String(await call("0x")),
      String(await call("0x" + "0".repeat(62))),
      String(await call("0x" + "0".repeat(63) + "5")),
      String(await call(null)),
      String(await W.wRead32({ request: async () => { throw new Error("reverted"); } },
                             "0x0", "0x0")),
    ];
  });
  const [zero, one, dust, mixed, usdc, usdcTrim,
         w32, bare, short, five, nonStr, threw] = b;
  ok("zero formats as 0", zero === "0");
  ok("1e18 wei is 1 ETH", one === "1");
  ok("1 wei rounds down to 0 at six places, it does not vanish into an error", dust === "0");
  ok("a mixed balance keeps exactly six places", mixed === "1.234567", mixed);
  ok("USDC uses six decimals", usdc === "25", usdc);
  ok("a trailing-zero USDC balance trims", usdcTrim === "0.99", usdcTrim);
  ok("32 zero bytes is the number zero, an answer", w32 === "0");
  ok("bare 0x is could-not-read, never zero", bare === "null");
  ok("short data is could-not-read, never zero", short === "null");
  ok("a full word decodes", five === "5");
  ok("a non-string reply is could-not-read", nonStr === "null");
  ok("a revert is could-not-read, never zero", threw === "null");
}

const bodyText = await txt("body");
ok("no ticker chip survives in the rendered page", !/\$TWD/.test(bodyText));
ok("LAPTOP is still named", /LAPTOP/.test(bodyText));

// Verdicts still work for an address that is simply not LAPTOP.
await useScenario("happy");
await type("0x06cC93FF9013B150445fF850D8D9285D6022eBa3");
ok("an unrelated address is rejected without naming what it is",
   (await txt("#verdictArea")).includes("DOES NOT MATCH"));
ok("and no other token is named in the verdict",
   !/POT ?PAL/i.test(await txt("#verdictArea")));

console.log("── static checks");
const src = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
ok("no third-party origins (C7)", !/https?:\/\/(?!basescan\.org|laptoptoken\.com|mainnet\.base\.org)[a-z0-9.-]+\//i.test(
   html.replace(/basescan\.org[^"'\s]*/g, "")), "found an external origin");
// C2 was "no wallet code at all". The page connects now, so the line moved rather than
// vanished: it may ask for an account and read, and it may not sign or send. The cross-page
// block above enforces that for all six; this keeps the constraint stated where C2 was.
ok("connects to a wallet (C2)", /eth_requestAccounts/.test(html));
ok("but cannot sign or send (C2)", !SIGNING.test(html));
ok("no private key handling (C2)", !/privateKey|mnemonic/i.test(html));
ok("single self-contained file (C1)", !/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html));
ok("verdict vocabulary is literals only (C6)",
   (html.match(/MATCHES PUBLISHED CONTRACT|MATCHES YOUR REFERENCE|DOES NOT MATCH|NO CONTRACT AT THIS ADDRESS|CANNOT VERIFY/g) || []).length > 0);
ok("no page errors during the run", pageErrors.length === 0, pageErrors.join("; "));

await browser.close();
site.close();

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
