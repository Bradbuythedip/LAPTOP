// Tests for web/slot.html — the "getting a slot" page and its deposit-contract checker.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0; const results = [];
const ok = (n, c, x) => { if (c) { pass++; results.push("  ok   " + n); }
  else { fail++; results.push("  FAIL " + n + (x ? "\n         " + x : "")); } };

const MOCK_PORT = process.env.MOCK_PORT || 8673;
const MOCK = "http://127.0.0.1:" + MOCK_PORT;
const mockProc = spawn(process.execPath, [path.join(ROOT, "test", "mock-rpc.mjs")], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: "ignore" });
process.on("exit", () => mockProc.kill());
await new Promise(r => setTimeout(r, 700));

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
await page.goto(SITE + "/slot.html", { waitUntil: "domcontentloaded" });
const txt = async s => (await page.textContent(s).catch(() => "")) || "";
const src = fs.readFileSync(path.join(ROOT, "web", "slot.html"), "utf8");
const body = (await txt("body")).replace(/\s+/g, " ");

const ADDR = "0x9999999999999999999999999999999999999999";
const useScn = async scn => {
  await page.evaluate(u => localStorage.setItem("laptop.rpc", u), MOCK + "/" + scn);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.fill("#addr", ADDR);
  await page.click("#go");
  await page.waitForTimeout(700);
};

console.log("── it sells nothing and holds nothing");
ok("no wallet connection", !/window\.ethereum|eth_requestAccounts|WalletConnect/i.test(src));
ok("no signing", !/signTypedData|personal_sign|eth_sign\b|privateKey|mnemonic/i.test(src));
ok("no transaction sending", !/eth_sendRawTransaction|sendTransaction/i.test(src));
ok("no deposit address is offered anywhere",
   !/send (?:your )?(?:funds|eth|money) to/i.test(body));
ok("says outright it has no slots to give", /has no slots to give/i.test(body));
ok("names the pitch it will never make", /reserve your allocation/i.test(body));
ok("tells the reader a preorder offer here means it is not this page", /close it/i.test(body));

console.log("── it states what a preorder actually is");
ok("a token that does not exist cannot be bought", /cannot buy a token that does not exist/i.test(body));
ok("calls a preorder unsecured lending", /lending money, unsecured/i.test(body));
ok("frames it as a credit decision", /that is a credit decision/i.test(body));
ok("does not simply condemn preorders", /not an argument against preorders/i.test(body));

console.log("── the four mechanisms are ranked by who must be trusted");
const tiers = await page.$$eval(".tier", ts => ts.map(t => ({
  cls: t.className, name: t.querySelector(".tn").textContent,
  badge: t.querySelector(".badge").textContent })));
ok("four mechanisms are listed", tiers.length === 4, String(tiers.length));
ok("the allowlist is first and graded safest",
   /allowlist/i.test(tiers[0].name) && tiers[0].cls.includes("ok"));
ok("the standing order is also no-custody",
   /standing order/i.test(tiers[1].name) && tiers[1].cls.includes("ok"));
ok("a deposit contract is a middle case",
   /deposit contract/i.test(tiers[2].name) && tiers[2].cls.includes("warn"));
ok("sending money to somebody is graded worst",
   /sending money/i.test(tiers[3].name) && tiers[3].cls.includes("bad"));
ok("the worst option is described as what most preorders really are",
   /what almost every preorder actually is/i.test(body));
ok("each tier says what happens if they do not deliver",
   (await page.$$eval(".tier .tw", ws => ws.filter(w => /If (?:they|it)/i.test(w.textContent)).length)) === 4);
ok("the refund must be unilateral, not promised",
   /you, unilaterally, without anyone/i.test(body));

console.log("── the argument that settles it");
ok("names what people actually want from a preorder",
   /guaranteed allocation/i.test(body) && /gas war/i.test(body));
ok("says an allowlist delivers all three without custody",
   /delivers all three/i.test(body));
ok("isolates the one thing custody adds", /the launcher gets the money early/i.test(body));
ok("and does not pretend that is never legitimate", /a real thing a launch might legitimately need/i.test(body));

console.log("── the EIP-1967 slots are the canonical ones");
// The expected values below are the constants published in EIP-1967 itself, not copied from
// the page — that is what makes this a check rather than a restatement.
const slots = await page.evaluate(() => window.__LAPTOP_SLOT.SLOT);
ok("implementation slot is EIP-1967's",
   slots.impl === "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
ok("admin slot is EIP-1967's",
   slots.admin === "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103");
ok("beacon slot is EIP-1967's",
   slots.beacon === "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50");
ok("the legacy OpenZeppelin slot is also checked",
   slots.zos === "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3");
ok("each slot names its preimage in a comment",
   /eip1967\.proxy\.implementation/.test(src) && /eip1967\.proxy\.beacon/.test(src));
const sel = await page.evaluate(() => window.__LAPTOP_SLOT.SEL);
ok("owner() selector is right", sel.owner === "0x8da5cb5b");
const exits = await page.evaluate(() => window.__LAPTOP_SLOT.EXITS);
ok("withdraw() selector is right", exits.some(([s, n]) => s === "3ccfd60b" && n === "withdraw()"));
ok("refund() selector is right", exits.some(([s, n]) => s === "590e1ae3" && n === "refund()"));

console.log("── input handling");
await page.fill("#addr", "not an address"); await page.click("#go");
await page.waitForTimeout(150);
ok("a non-address is refused before any request",
   (await txt("#addrErr")).includes("not a 20-byte address"));
ok("and says how many characters it actually got", /this has \d+/i.test(await txt("#addrErr")));
ok("no result card is shown for bad input", await page.isHidden("#resCard"));
await page.fill("#addr", ""); await page.click("#go");
await page.waitForTimeout(150);
ok("an empty box asks rather than errors", (await txt("#addrErr")).includes("Paste the address"));
{
  const zw = await page.evaluate(() =>
    window.__LAPTOP_SLOT.normalize("0x99​9999999999‪999999999999999999999999999"));
  ok("zero-width and bidi characters are stripped before parsing", !/[​‪]/.test(zw));
}

console.log("── an EOA is the worst answer, and is named as such");
await useScn("slot-eoa");
{
  const r = await txt("#res");
  ok("no contract is reported", r.includes("There is no contract at this address"));
  ok("it is called a wallet, not a contract", /wallet, not a contract/i.test(r));
  ok("and says nothing can enforce a refund", /no code to enforce it/i.test(r));
  ok("the summary badge is bad", (await page.getAttribute("#resBadge", "class")).includes("bad"));
}

console.log("── a proxy outweighs everything else");
await useScn("slot-proxy");
{
  const r = await txt("#res");
  ok("upgradeability is reported", r.includes("This is an upgradeable proxy"));
  ok("it says the rules can be rewritten after you deposit",
     /rules can be rewritten after you deposit/i.test(r));
  ok("it says this outweighs the other checks", /outweighs all the others/i.test(r));
  ok("the admin is named when readable", /0x1111/i.test(r));
  ok("the exit scan refuses to report on a proxy",
     r.includes("The exit scan says nothing here"));
  ok("because it would be reading the wrong contract", /wrong contract/i.test(r));
  ok("the badge is bad", (await page.getAttribute("#resBadge", "class")).includes("bad"));
}
await useScn("slot-beacon");
ok("a beacon proxy is caught too", (await txt("#res")).includes("upgradeable proxy"));
await useScn("slot-zos");
ok("a legacy OpenZeppelin proxy is caught too", (await txt("#res")).includes("upgradeable proxy"));

console.log("── a plain contract with an exit, and one without");
await useScn("slot-plain");
{
  const r = await txt("#res");
  ok("code is reported with its size", /bytes of code/.test(r));
  ok("not a proxy is stated positively", r.includes("Not a standard upgradeable proxy"));
  ok("exit functions are listed", r.includes("withdraw()") && r.includes("refund()"));
  ok("but existence is not confused with being able to call them",
     /not the same as you being able to call them/i.test(r));
  ok("privileged controls are surfaced", r.includes("Privileged controls exist"));
  ok("a single owner is reported", r.includes("One address owns this contract"));
  ok("the badge stops at 'read the source', never 'safe'",
     (await txt("#resBadge")) === "read the source");
  ok("and it says a clean read is not approval", /clean read here is not approval/i.test(r));
}
await useScn("slot-noexit");
{
  const r = await txt("#res");
  ok("no reachable exit is reported", r.includes("No exit function is reachable"));
  ok("and called strong evidence on a non-proxy", /strong evidence/i.test(r));
  ok("saying there is no way to take your money back", /no way for you to take your money back/i.test(r));
  ok("the badge is bad", (await page.getAttribute("#resBadge", "class")).includes("bad"));
}

console.log("── ownership states are kept distinct");
await useScn("slot-renounced");
ok("a zero owner word reads as renounced", (await txt("#res")).includes("Ownership is renounced"));
await useScn("slot-noowner");
ok("an empty answer is not read as renounced",
   (await txt("#res")).includes("No owner() function answered"));
await useScn("slot-ownerfail");
ok("a revert is 'could not check', not 'no owner'",
   (await txt("#res")).includes("Could not check for an owner"));

console.log("── failures never become findings");
await useScn("nocors");
{
  const r = await txt("#res");
  ok("a blocked endpoint reports nothing checked", r.includes("Nothing was checked"));
  ok("and says so is not a statement about the address",
     /not a statement about the address/i.test(r));
  ok("no field claims a result", !/upgradeable proxy|no contract at this address/i.test(r));
}
await useScn("wrongchain");
{
  const r = await txt("#res");
  ok("the wrong chain stops every check", r.includes("The endpoint is not Base"));
  ok("and says nothing was read", /Nothing was read/i.test(r));
}
await useScn("slot-slotunreadable");
ok("an unreadable proxy slot is unknown, not absent",
   (await txt("#res")).includes("Could not check for upgradeability"));
ok("and says to treat it as unknown rather than absent",
   /unknown rather than absent/i.test(await txt("#res")));

console.log("── the launcher checklist is the mirror of the buyer's");
ok("publishing a merkle root is the first instruction", /merkle root, not a deposit address/i.test(body));
ok("price and cap fixed on chain", /Fix the price and the per-address cap on chain/i.test(body));
ok("unilateral exit if deposits are taken", /make the exit unilateral/i.test(body));
ok("no proxy", /Do not deploy it behind a proxy/i.test(body));
ok("and it closes the loop back to the checks", /pass the checks on this page/i.test(body));

console.log("── one token, and only one");
ok("no other ticker appears", !/\$TWD|POT ?PAL|POTPAL/i.test(src));
ok("no advice to buy", !/\byou should buy\b|\bbuy now\b/i.test(body.replace(/whether to buy[^.]*\./i, "")));

console.log("── layout");
ok("no horizontal scroll at 375px",
   (await page.evaluate(() => document.documentElement.scrollWidth)) <= 375);
ok("no page errors", pageErrors.length === 0, pageErrors.join("; "));

await browser.close(); site.close();
console.log("\n" + results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
