// Flip every page from the light lavender theme to the dark gold one, in one pass, so the
// eight pages cannot drift apart. The token NAMES are unchanged wherever possible, so this
// touches colour and nothing else.
//
// The values are not taste. tools/contrast.mjs composites each one down through the artwork
// (at the brightest and darkest pixel bg.png actually contains), the vignette at its weakest,
// and the card, and reports the WCAG ratio. test/run.mjs recomputes the same thing in a real
// browser and fails the build on a regression.
//   node tools/theme-dark.mjs
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WEB = path.join(ROOT, "web");

const ROOT_BLOCK = `:root{
  /* Dark. The ground is near-black navy so the gold artwork reads as metal rather than as a
     watermark, and gold is the single accent because it is the one colour the bear already is.
     Every value was chosen against the COMPOSITED ground — the artwork at the brightest pixel
     bg.png actually contains (#212829), plus the vignette at its weakest, plus the card — and
     not against a swatch. tools/contrast.mjs prints the arithmetic; test/run.mjs recomputes it
     in the browser and fails the build on a regression. That is the only reason these are the
     exact values they are. */
  --bg:#070b16; --fg:#e9edf8; --dim:#9aa6c2;
  --line:#26304a;                    /* dividers and card edges: decorative, no WCAG floor */
  --edge:#7c8aaf;                    /* borders of things you can TOUCH: 3.86:1, clears 1.4.11 */
  --card:#0e1424;                    /* opaque, for inputs and selects */
  --cardBg:rgba(255,255,255,.045);
  --gold:#f0c040; --goldHi:#ffd970; --goldSoft:rgba(240,192,64,.14);
  /* Base blue. #0052FF is the real brand colour and it is 2.91:1 on this ground — under the
     4.5 for text and under the 3 for a border. So it is a FILL, where white on it is 5.75:1,
     and --baseLt is the lifted tint that is allowed to speak: 5.68:1. Using the brand blue as
     text would be the one place on this site where the brand beat the reader. */
  --base:#0052ff; --baseLt:#5b94ff; --baseSoft:rgba(0,82,255,.16); --onBase:#ffffff;
  --onGold:#140f02;                  /* text ON a gold fill. White on gold is 1.8:1 — unusable */
  --ok:#4fd18a; --okbg:rgba(79,209,138,.13);
  --bad:#ff8178; --badbg:rgba(255,129,120,.13);
  --warn:#f2c14e; --warnbg:rgba(242,193,78,.13);
  --unk:#9aa6c2; --unkbg:rgba(154,166,194,.09);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}`;

// Same geometry as the light vignette it replaces, so the 0.30-at-the-centre figure the
// contrast test assumes stays true.
const VIGNETTE = `  background:radial-gradient(ellipse 120% 90% at 50% 38%,
    rgba(7,11,22,.30) 0%, rgba(7,11,22,.62) 48%, rgba(6,9,19,.90) 82%, rgba(5,8,17,.97) 100%);`;

// Bolder edges, and the gold treated as a material. Appended last so it wins over anything
// above it without having to find and edit each rule.
const EDGES = `
/* ---------------------------------------------------------------- dark: edges and material.
   "Bolder edges" is a real accessibility win, not only a look: WCAG 1.4.11 wants 3:1 on the
   boundary of anything you can interact with, and the old 1px hairline did not have it on any
   ground. Interactive borders move to --edge; decorative ones stay on --line. */
input,select,textarea{border:1.5px solid var(--edge);background:var(--card)}
input::placeholder{color:var(--dim);opacity:.75}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--gold);
  box-shadow:0 0 0 3px rgba(240,192,64,.22)}
button.act{border:1.5px solid var(--edge);background:var(--card);color:var(--fg)}
button.act:hover{border-color:var(--gold);color:var(--goldHi)}
button.act:focus-visible,a:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.card{border:1px solid var(--line);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05), 0 1px 2px rgba(0,0,0,.5)}
.badge{border-width:1.5px}
a.ext,a.cta{text-underline-offset:3px}
::selection{background:rgba(240,192,64,.28);color:var(--fg)}
/* Scrollbars, so a dense table does not paint a white gutter across a dark page. */
*{scrollbar-color:var(--edge) transparent}
*::-webkit-scrollbar{height:10px;width:10px}
*::-webkit-scrollbar-thumb{background:var(--edge);border-radius:10px}
*::-webkit-scrollbar-track{background:transparent}
`;

let touched = 0;
for (const f of fs.readdirSync(WEB).filter(n => n.endsWith(".html"))) {
  const p = path.join(WEB, f);
  let s = fs.readFileSync(p, "utf8");
  const before = s;

  // 1. the token block, comment and all
  s = s.replace(/:root\{[\s\S]*?\n\}/, ROOT_BLOCK);

  // 2. the vignette
  s = s.replace(/ {2}background:radial-gradient\(ellipse 120% 90% at 50% 38%,[\s\S]*?\);/, VIGNETTE);

  // 3. the artwork layer. On a light page the art had to be faint or it ate the text; on a
  //    dark one it is dark-on-dark and can be stronger before it costs anything.
  s = s.replace(/(url\("\/bg\.png"\)[^}]*?opacity:)\.\d+/g, "$10.34");
  s = s.replace(/(url\("\/bg\.png"\)[^;]*;\s*\n\s*opacity:)\.\d+/g, "$10.34");

  // 4. tell the browser, so form controls and scrollbars come up dark too
  s = s.replace(/<meta name="color-scheme" content="light">/,
                '<meta name="color-scheme" content="dark">');

  // 5. the accent is gold now, and white on gold is unreadable
  s = s.replace(/background:var\(--eth\);color:#fff/g, "background:var(--gold);color:var(--onGold)");
  s = s.replace(/var\(--eth\)/g, "var(--gold)");
  s = s.replace(/var\(--ethSoft\)/g, "var(--goldSoft)");

  // 6. edges last, so it wins
  if (!s.includes("dark: edges and material")) s = s.replace(/\n<\/style>/, EDGES + "</style>");

  if (s !== before) { fs.writeFileSync(p, s); touched++; console.log("  " + f); }
}
console.log(`\n${touched} pages re-themed`);
