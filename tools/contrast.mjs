// WCAG AA arithmetic against the REAL artwork, not against a swatch.
//
// The test suite composites a colour down through every translucent layer between the glyph
// and the page before it measures. This does the same thing from the command line so a palette
// can be checked while it is being chosen rather than after the build goes red.
//
// The important input is the artwork's true luminance range. bg.png is a dark navy gradient
// whose BRIGHTEST pixel is #212829 — a dark theme's worst case is the ground being lifted
// toward the text, so that pixel, not a hypothetical white, is what the scrim has to survive.
//   node tools/contrast.mjs
const hex = h => {
  h = h.replace("#", "");
  if (h.length === 3) h = [...h].map(c => c + c).join("");
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};
export const relLum = ([r, g, b]) => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
export const over = (fg, alpha, bg) => fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);

// ---------------------------------------------------------------- the proposed dark palette
const PAGE      = hex("#070b16");   // the page under everything
const ART_BRIGHT = hex("#212829");  // measured: brightest pixel in web/bg.png
const ART_DARK   = hex("#02091b");  // measured: darkest pixel in web/bg.png
const ART_OPACITY = 0.38;           // how strongly the artwork shows through
const SCRIM_ALPHA = 0.25;           // the vignette at its WEAKEST, i.e. page centre

const FG = {
  "--fg      body text":      ["#e9edf8", 4.5],
  "--dim     secondary":      ["#9aa6c2", 4.5],
  "--gold    brand/accent":   ["#f0c040", 4.5],
  "--goldHi  bright gold":    ["#ffd970", 4.5],
  "--ok      good":           ["#4fd18a", 4.5],
  "--bad     bad":            ["#ff8178", 4.5],
  "--warn    warning":        ["#f2c14e", 4.5],
  "--line    divider (decor)": ["#263048", 1],
  "--edge    input/button border": ["#7c8aaf", 3],
  "--edgeHot focus ring":     ["#f0c040", 3],
};
// The layers a glyph can sit under, innermost last. Tinted boxes are where a dark theme
// actually fails: a gold badge on a card lifts the ground under gold text.
const SURFACES = {
  "page":            [],
  "card  rgba(255,255,255,.045)": [[hex("#ffffff"), 0.045]],
  "card + gold badge rgba(240,192,64,.14)": [[hex("#ffffff"), 0.045], [hex("#f0c040"), 0.14]],
  "card + bad box rgba(255,129,120,.13)": [[hex("#ffffff"), 0.045], [hex("#ff8178"), 0.13]],
  "card + ok box rgba(79,209,138,.13)": [[hex("#ffffff"), 0.045], [hex("#4fd18a"), 0.13]],
  "card + inner rgba(255,255,255,.08)": [[hex("#ffffff"), 0.045], [hex("#ffffff"), 0.08]],
};

const ground = (surface, artPixel) => {
  let g = over(artPixel, ART_OPACITY, PAGE);
  g = over(PAGE, SCRIM_ALPHA, g);
  for (const [c, a] of surface) g = over(c, a, g);
  return g;
};

let fails = 0;
console.log("worst case for a dark theme is the BRIGHTEST artwork, which lifts the ground\n");
for (const [sname, surface] of Object.entries(SURFACES)) {
  const gBright = ground(surface, ART_BRIGHT);
  const gDark = ground(surface, ART_DARK);
  console.log(`${sname}`);
  console.log(`  ground: bright rgb(${gBright.map(Math.round)})  dark rgb(${gDark.map(Math.round)})`);
  for (const [name, [c, need]] of Object.entries(FG)) {
    if (need === 1) continue;
    const rB = contrast(hex(c), gBright), rD = contrast(hex(c), gDark);
    const worst = Math.min(rB, rD);
    if (worst < need) fails++;
    console.log(`  ${worst >= need ? "ok  " : "FAIL"} ${name.padEnd(30)} ${c}  ` +
                `${worst.toFixed(2)}:1  needs ${need}`);
  }
  console.log("");
}
console.log(fails ? `${fails} FAILING PAIRS` : "every pair clears its threshold");
