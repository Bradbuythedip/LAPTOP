// Defects found by an adversarial pass over the dark theme, fixed in one place so the eight
// pages cannot end up half-fixed. Each is measured, not guessed — tools/contrast.mjs prints
// the arithmetic and test/run.mjs recomputes it in the browser.
import fs from "node:fs";
import path from "node:path";
const WEB = path.resolve(new URL(".", import.meta.url).pathname, "..", "web");

const OLD_FOCUS = `input:focus,select:focus,textarea:focus{outline:none;border-color:var(--gold);
  box-shadow:0 0 0 3px rgba(240,192,64,.22)}`;

// THE FOCUS INDICATOR, which the "bolder edges" pass broke while fixing something else.
// A focus state is only visible by its DELTA from the resting state. The resting border used
// to be --line, and --line -> --gold is 7.68:1. Raising it to --edge for WCAG 1.4.11 (3:1 on
// the boundary of anything interactive) collapsed that delta to 2.02:1, and `outline:none`
// had thrown away the only other affordance. So the fix for one success criterion broke
// another, and the box-shadow that was supposed to carry it is 1.66:1 against the card.
// A real outline does not depend on the delta at all.
const NEW_FOCUS = `input:focus-visible,select:focus-visible,textarea:focus-visible{
  outline:2px solid var(--gold);outline-offset:2px;border-color:var(--gold)}
input:focus,select:focus,textarea:focus{outline:2px solid var(--gold);outline-offset:2px;
  border-color:var(--gold)}`;

// Every boundary you can touch, at 3:1 or better. a.cta.sub2 is a button-shaped link on six
// pages and its whole boundary was --line at 1.28:1; .tools a is the nav row on the landing
// page. The appended dark block rewrote inputs and .card and never named either.
const TOUCHABLE = `
/* Boundaries of things you can touch, at 3:1. --line is 1.28:1 on a card and is for dividers
   only; anything with a hit area gets --edge (4.87:1). */
a.cta.sub2{border-color:var(--edge)}
.tools a{border-color:var(--edge)}
/* Three spinners rotated forever regardless of the setting, on three different pages, because
   the reduced-motion guard was written for the hero and nothing else. */
@media (prefers-reduced-motion:reduce){
  .spin{animation:none;opacity:.6}
  .bear{animation:none}
}
`;

let n = 0;
for (const f of fs.readdirSync(WEB).filter(x => x.endsWith(".html"))) {
  const p = path.join(WEB, f);
  let s = fs.readFileSync(p, "utf8"); const before = s;

  s = s.split(OLD_FOCUS).join(NEW_FOCUS);

  // Inline border declarations outrank the stylesheet, so the theme pass could not reach them.
  // checker.html's reference-address and RPC-endpoint fields are the two inputs on the
  // anti-scam tool, and both were left at 1.28:1.
  s = s.replace(/style="([^"]*?)border:1\.5px solid var\(--line\)/g,
                'style="$1border:1.5px solid var(--edge)');

  // The comment was wrong about its own number: white on this gold is 1.70:1, not 1.8:1.
  s = s.replace("White on gold is 1.8:1 — unusable", "White on gold is 1.70:1 — unusable");

  if (!s.includes("Boundaries of things you can touch")) {
    // The block only makes sense where the dark edge rules already are.
    if (s.includes("dark: edges and material") || s.includes("--edge:"))
      s = s.replace(/\n<\/style>/, TOUCHABLE + "</style>");
  }

  if (s !== before) { fs.writeFileSync(p, s); n++; console.log("  " + f); }
}
console.log(`\n${n} pages fixed`);
