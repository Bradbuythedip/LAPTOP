// A pass over the whole site for one problem: too many things wear the same clothes.
//
// Don Norman's point is that form should say what a thing does. On this site a card, a badge, a
// stat box and a button all had a 1–1.5px border, a 10–12px radius and a translucent fill, so
// the only way to know which one you could press was to try. That is a false affordance, and on
// a page where pressing the wrong thing can cost money it is worse than ugly.
//
// The split, applied everywhere:
//   SURFACES (cards, stats, boxes) — solid, sharp, no outline. They are ground, not controls.
//     Separation comes from the fill being lighter than the page and a hairline where two
//     surfaces actually meet, not from a ring drawn round everything.
//   CONTROLS (buttons, links you press, inputs) — keep the border, keep it BRIGHT, add a
//     pressed state. They are the only things on the page that are outlined.
//   LABELS (badges, chips) — no border at all. A bordered pill is a toggle everywhere else on
//     the internet, and none of these toggle.
//
// Sharper corners throughout: 12px radius reads consumer-app, 6px reads instrument.
import fs from "node:fs";
import path from "node:path";
const WEB = path.resolve(new URL(".", import.meta.url).pathname, "..", "web");

const SHARP = `
/* ------------------------------------------------------------------ surfaces vs controls.
   Everything below exists to make "can I press this?" answerable at a glance. */

/* SURFACES. Solid, so the artwork does not show through the thing you are reading; sharp, so
   they read as panels rather than as buttons; unoutlined, because an outline is the strongest
   press-me signal there is and these do not press. */
.card{background:#0b111c;border:0;border-radius:6px;padding:16px;margin:12px 0;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.stat,.leg,.step{background:#0b111c;border:0;border-radius:6px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.card .card{background:#0e1524}
.hr{height:1px;background:var(--line);margin:16px 0;border:0}

/* LABELS. A bordered pill is a toggle everywhere else; none of these toggle. */
.badge{border:0;border-radius:4px;background:rgba(255,255,255,.06);color:var(--dim);
  font-weight:600;letter-spacing:.02em;padding:4px 8px}
.badge.good{background:rgba(79,209,138,.14);color:var(--ok)}
.badge.bad{background:rgba(255,129,120,.14);color:var(--bad)}
.badge.warn{background:rgba(242,193,78,.14);color:var(--warn)}
.badge.gold{background:var(--goldSoft);color:var(--gold)}

/* Message boxes are surfaces too. They keep a colour and lose the ring; the left rule carries
   the meaning without pretending to be pressable. */
.warnbox,.badbox,.okbox{border:0;border-left:3px solid;border-radius:0 4px 4px 0;padding:11px 13px}
.warnbox{border-left-color:var(--warn);background:rgba(242,193,78,.08);color:var(--warn)}
.badbox{border-left-color:var(--bad);background:rgba(255,129,120,.08);color:var(--bad)}
.okbox{border-left-color:var(--ok);background:rgba(79,209,138,.08);color:var(--ok)}

/* CONTROLS. The only outlined things on the page, and they say so when you push them. */
a.cta,button.act{border-radius:6px;transition:transform .06s ease, filter .12s ease}
a.cta:active,button.act:active{transform:translateY(1px);filter:brightness(.94)}
button.act{border:1.5px solid var(--edge);background:#111a2a}
button.act:hover{border-color:var(--gold);color:var(--goldHi);background:#16203300}
input,select,textarea{border-radius:6px;background:#0b111c}

/* Tables are data, not a grid of cells to click. */
table{border-collapse:collapse}
th{font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:10.5px;
  color:var(--dim)}
th,td{border-bottom:1px solid rgba(255,255,255,.05)}
tbody tr:last-child td{border-bottom:0}
`;

let n = 0;
for (const f of fs.readdirSync(WEB).filter(x => x.endsWith(".html"))) {
  const p = path.join(WEB, f);
  let s = fs.readFileSync(p, "utf8");
  if (s.includes("surfaces vs controls")) continue;
  const before = s;
  s = s.replace(/\n<\/style>/, SHARP + "</style>");
  // The site is snoozebear.xyz now.
  s = s.replace(/totalworlddomination\.xyz/g, "snoozebear.xyz");
  if (s !== before) { fs.writeFileSync(p, s); n++; console.log("  " + f); }
}
console.log(`\n${n} pages`);
