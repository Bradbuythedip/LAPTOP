// The site's own script, executed against a DOM built FROM THE PAGE. No browser, no deps.
//
// The first version of this file fabricated the DOM from a hardcoded list of ids, which means
// it could not fail the way it claimed to protect against: rename an id in the page and the
// stub still provided the old one, every getElementById succeeded, and the suite stayed green
// while every link on the live page pointed nowhere. The ids come out of the markup now, and
// an id the script asks for that the page does not have is a failure.
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

const PAGE = path.join(ROOT, "web", "index.html");
const html = fs.readFileSync(PAGE, "utf8");
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
ok("the page has exactly one inline script", (html.match(/<script/g) || []).length === 1);

// Ids AS THE PAGE DECLARES THEM, plus each element's attributes, so a rename breaks the test.
const declared = new Map();
for (const m of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  const attrs = {};
  for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  // Bare attributes too. `hidden` has no value, so a name="value" scan misses it and the
  // stub reported the copy button as visible before launch — a failure in the test, which
  // is worse than none because it points at working code.
  for (const a of m[2].matchAll(/(?:^|\s)([\w-]+)(?=\s|$)/g)) {
    if (!(a[1] in attrs)) attrs[a[1]] = "";
  }
  declared.set(m[3], { tag: m[1], attrs });
}
const asked = [...new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]))];
ok("every id the script asks for exists in the markup",
   asked.every(id => declared.has(id)), asked.filter(id => !declared.has(id)).join(", "));

// The address element is the one that must work with no script at all.
const ca = declared.get("ca");
ok("the address element carries a data-ca attribute", ca && "data-ca" in ca.attrs);
ok("the buy and sell anchors have NO href until one is published",
   !("href" in declared.get("buy").attrs) && !("href" in declared.get("sell").attrs),
   "an anchor with an href is clickable and focusable no matter what CSS says");

function domFrom(caValue) {
  const els = {};
  for (const [id, d] of declared) {
    const attrs = { ...d.attrs };
    if (id === "ca") attrs["data-ca"] = caValue;
    els[id] = {
      id, textContent: "", className: attrs.class || "", hidden: "hidden" in attrs,
      href: attrs.href, _attrs: attrs,
      getAttribute(a) { return a in this._attrs ? this._attrs[a] : null; },
      setAttribute(a, v) { this._attrs[a] = v; },
      removeAttribute(a) { delete this._attrs[a]; },
      addEventListener(_e, f) { this._on = f; },
    };
  }
  return { els, document: { getElementById: id => els[id] || null },
           navigator: {}, window: {}, setTimeout: () => {} };
}

function run(caValue) {
  const env = domFrom(caValue);
  new Function("document", "navigator", "window", "setTimeout", script)(
    env.document, env.navigator, env.window, env.setTimeout);
  return env.els;
}

console.log("── with nothing launched");
{
  const e = run("");
  ok("it does not throw", true);
  ok("the copy button stays hidden", e.copy.hidden === true);
  ok("buy and sell are still not pointed anywhere",
     e.buy.href === undefined && e.sell.href === undefined);
}

console.log("── the address renders with NO SCRIPT AT ALL");
{
  // What a visitor sees in an in-app webview, behind a content blocker, or with JS off.
  const CA = "So11111111111111111111111111111111111111112";
  const published = html.replace(
    /<div class="ca(?: none)?" id="ca" data-ca="[^"]*">.*?<\/div>/,
    `<div class="ca" id="ca" data-ca="${CA}">${CA}</div>`);
  const text = published.split("<body>")[1].split("<script>")[0].replace(/<[^>]+>/g, " ");
  ok("the published address is in the served HTML, before any JavaScript runs",
     text.includes(CA));
  ok("and the pre-launch page says so instead of showing an empty box",
     html.split("<body>")[1].split("<script>")[0].includes("Not launched yet"));
}

console.log("── with an address published");
{
  const CA = "So11111111111111111111111111111111111111112";
  const e = run(CA);
  ok("the copy button appears", e.copy.hidden === false);
  ok("buy points at the coin page", e.buy.href === "https://pump.fun/coin/" + CA, e.buy.href);
  ok("sell points at the same place", e.sell.href === "https://pump.fun/coin/" + CA);
  ok("solscan is wired", e.scan.href === "https://solscan.io/token/" + CA, e.scan.href);
  ok("dexscreener is wired", e.dex.href === "https://dexscreener.com/solana/" + CA, e.dex.href);
  ok("a copy handler is attached", typeof e.copy._on === "function");
}

console.log("── every asset the page references exists");
{
  // src/href AND url() in the stylesheet — the background is only referenced from CSS, so a
  // scan of markup attributes alone would never notice it going missing.
  const refs = [...new Set([
    ...[...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1]),
    ...[...html.matchAll(/url\("(\/[^"]+)"\)/g)].map(m => m[1]),
  ])];
  const missing = refs.filter(r => !fs.existsSync(path.join(ROOT, "web", r.slice(1))));
  ok("no broken local reference (" + refs.join(", ") + ")", missing.length === 0,
     "missing: " + missing.join(", "));
  // A file whose extension lies gets the wrong Content-Type, and vercel.json sets nosniff.
  const magic = f => {
    const h = fs.readFileSync(path.join(ROOT, "web", f)).subarray(0, 12);
    if (h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (h.subarray(0, 4).toString() === "RIFF" && h.subarray(8, 12).toString() === "WEBP") return "webp";
    return "?";
  };
  const lying = fs.readdirSync(path.join(ROOT, "web"))
    .filter(f => /\.(png|webp)$/.test(f))
    .filter(f => magic(f) !== f.split(".").pop());
  ok("no image file's extension contradicts its bytes", lying.length === 0,
     "these lie about their format and X-Content-Type-Options is nosniff: " + lying.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
