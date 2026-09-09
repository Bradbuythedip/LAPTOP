// The page's own script, executed against a minimal DOM. No browser and no dependencies —
// the page loads nothing and touches nothing, so a stub is enough to prove the one thing that
// matters: with a contract address published, every link is wired and nothing throws.
//   node test/page-smoke.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n         " + extra : "")); }
};

const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
ok("the page has exactly one inline script", (html.match(/<script/g) || []).length === 1);

function domFor(ids) {
  const els = {};
  for (const id of ids) els[id] = {
    id, textContent: "", className: "", hidden: true, href: "", _attrs: {},
    removeAttribute(a) { delete this._attrs[a]; },
    addEventListener(_e, f) { this._on = f; },
  };
  return {
    document: { getElementById: id => els[id] || null },
    navigator: {}, window: {}, setTimeout: () => {},
    els,
  };
}
const IDS = ["ca", "copy", "buy", "sell", "pf", "scan", "dex"];

function run(ca) {
  const env = domFor(IDS);
  const body = script.replace(/^\s*const CA = "";\s*$/m, `const CA = ${JSON.stringify(ca)};`);
  const fn = new Function("document", "navigator", "window", "setTimeout", body);
  fn(env.document, env.navigator, env.window, env.setTimeout);
  return env.els;
}

console.log("── with nothing launched");
{
  const e = run("");
  ok("it does not throw", true);
  ok("the address box still says not launched", e.ca.textContent === "");
  ok("the copy button stays hidden", e.copy.hidden === true);
  ok("buy and sell are not pointed anywhere", e.buy.href === "" && e.sell.href === "");
}

console.log("── with a contract address published");
{
  const CA = "So11111111111111111111111111111111111111112";
  const e = run(CA);
  ok("the address is rendered", e.ca.textContent === CA);
  ok("the warning styling comes off", e.ca.className === "ca");
  ok("the copy button appears", e.copy.hidden === false);
  ok("buy points at the coin page", e.buy.href === "https://pump.fun/coin/" + CA, e.buy.href);
  ok("sell points at the same place", e.sell.href === "https://pump.fun/coin/" + CA);
  ok("solscan is wired", e.scan.href === "https://solscan.io/token/" + CA, e.scan.href);
  ok("dexscreener is wired", e.dex.href === "https://dexscreener.com/solana/" + CA);
  ok("the buttons stop being inert",
     !("aria-disabled" in e.buy._attrs) && !("aria-disabled" in e.sell._attrs));
  ok("a copy handler is attached", typeof e.copy._on === "function");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
