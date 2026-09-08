// <summary> elements were styled as plain dim text. Four of them on the checker alone carry
// real function — change the reference address, change the endpoint, show the derivations,
// coverage — and nothing said they opened. A control whose only signifier is a native triangle
// somebody removed is a control nobody finds.
//
// The fix is a signifier that matches the function: a caret that rotates when the thing opens,
// and a hit area big enough to press. Not a button, because it is not a button — it is a
// disclosure, and it should look like one.
import fs from "node:fs";
import path from "node:path";
const WEB = path.resolve(new URL(".", import.meta.url).pathname, "..", "web");

const CSS = `
/* Disclosures. A caret that turns, a real tap target, and no borrowed button styling. */
summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:7px;
  min-height:36px;padding:4px 0;color:var(--baseLt);font-weight:600;
  -webkit-tap-highlight-color:transparent}
summary::-webkit-details-marker{display:none}
summary::before{content:"";width:0;height:0;flex:none;
  border-left:5px solid currentColor;border-top:4px solid transparent;
  border-bottom:4px solid transparent;transition:transform .15s ease}
details[open]>summary::before{transform:rotate(90deg)}
summary:hover{color:var(--goldHi)}
summary:focus-visible{outline:2px solid var(--gold);outline-offset:3px;border-radius:3px}
@media (prefers-reduced-motion:reduce){ summary::before{transition:none} }
`;

let n = 0;
for (const f of fs.readdirSync(WEB).filter(x => x.endsWith(".html"))) {
  const p = path.join(WEB, f);
  let s = fs.readFileSync(p, "utf8");
  if (!/<summary/.test(s) || s.includes("Disclosures. A caret that turns")) continue;
  s = s.replace(/\n<\/style>/, CSS + "</style>");
  fs.writeFileSync(p, s); n++; console.log("  " + f);
}
console.log(`\n${n} pages`);
