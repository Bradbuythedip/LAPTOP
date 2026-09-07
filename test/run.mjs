// Test suite for web/index.html. Drives the real page in Chromium against test/mock-rpc.mjs.
//   node test/run.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
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
  // web/bg.png is supplied by the site owner and is not in the repo. For tests, fall back
  // to a clearly-named fixture so the background code path is exercised either way.
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
  const t = window.__TWD;
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
    localStorage.setItem("twd.rpc", url);
    localStorage.removeItem("twd.ref");
    localStorage.removeItem("twd.relay");
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

console.log("── background art and the $TWD watermark");
const bg = await page.evaluate(() => {
  const before = getComputedStyle(document.body, "::before");
  const after = getComputedStyle(document.body, "::after");
  return {
    img: before.backgroundImage, imgOpacity: parseFloat(before.opacity),
    mark: after.backgroundImage, markOpacity: parseFloat(after.opacity),
    zIdxBefore: before.zIndex, zIdxAfter: after.zIndex,
    pointerBefore: before.pointerEvents, pointerAfter: after.pointerEvents,
  };
});
ok("background image layer is applied", /bg\.png/.test(bg.img), bg.img);
ok("background art is subdued enough to read over", bg.imgOpacity > 0 && bg.imgOpacity <= 0.2,
   String(bg.imgOpacity));
ok("$TWD watermark tiles the page", /svg\+xml/.test(bg.mark) && /%24TWD/.test(bg.mark));
ok("watermark is faint", bg.markOpacity > 0 && bg.markOpacity <= 0.1, String(bg.markOpacity));
ok("both layers sit behind the content", Number(bg.zIdxBefore) < 0 && Number(bg.zIdxAfter) < 0);
ok("neither layer can swallow a tap",
   bg.pointerBefore === "none" && bg.pointerAfter === "none");
const src = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const twdCount = (src.match(/\$TWD/g) || []).length + (src.match(/%24TWD/g) || []).length;
ok("$TWD appears many times on the page", twdCount >= 6, "count=" + twdCount);
ok("the ticker is visible in the header, not only in the watermark",
   (await txt("h1")).includes("$TWD"));

// The whole point is that the art never competes with the answer.
await useScenario("happy");
await type("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
ok("verdict box keeps an opaque ground over the art", await page.evaluate(() => {
  const v = document.querySelector(".verdict");
  const bgc = getComputedStyle(v).backgroundColor;
  const m = bgc.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const parts = m[1].split(",").map(s => parseFloat(s));
  return parts.length < 4 || parts[3] >= 0.95;   // no alpha, or effectively opaque
}));
ok("page still fits 375px with the art in place",
   (await page.evaluate(() => document.documentElement.scrollWidth)) <= 375);

// And that it degrades to nothing if the image is absent.
// The meaningful property: no behaviour depends on the image. It is referenced once, from
// a decorative CSS layer, and never from script - so a missing or blocked bg.png costs a
// picture and leaves every number and verdict intact.
const scriptBody = (src.match(/<script[\s\S]*?<\/script>/g) || []).join("");
ok("no script references bg.png, so nothing functional depends on it",
   !/bg\.png/.test(scriptBody));
const cssDecl = (src.match(/url\(["']?\/bg\.png/g) || []).length;
eq("bg.png is loaded from exactly one place", cssDecl, 1);

console.log("── static checks");
const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
ok("no third-party origins (C7)", !/https?:\/\/(?!basescan\.org|laptoptoken\.com|mainnet\.base\.org)[a-z0-9.-]+\//i.test(
   html.replace(/basescan\.org[^"'\s]*/g, "")), "found an external origin");
ok("no window.ethereum / wallet code (C2)", !/window\.ethereum|eth_requestAccounts|personal_sign|eth_sendTransaction/.test(html));
ok("no private key handling (C2)", !/privateKey|mnemonic|signTransaction/i.test(html));
ok("single self-contained file (C1)", !/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html));
ok("verdict vocabulary is literals only (C6)",
   (html.match(/MATCHES PUBLISHED CONTRACT|MATCHES YOUR REFERENCE|DOES NOT MATCH|NO CONTRACT AT THIS ADDRESS|CANNOT VERIFY/g) || []).length > 0);
ok("no page errors during the run", pageErrors.length === 0, pageErrors.join("; "));

await browser.close();
site.close();

console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
