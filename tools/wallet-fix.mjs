// The connect button never went away. wDisconnect was toggled on connect and wConnect was
// not, so after connecting the page still showed a full-width "Connect Phantom" — which reads
// as "you are not connected" no matter what the badge says beside it. And the badge said the
// shortened address rather than the word, so nothing on the page ever said "connected" at all.
//
// One state, said once: the button row swaps, and the badge says connected (or names the wrong
// network). The address stays in the detail rows below, which is where it was already.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

let n = 0;
for (const f of fs.readdirSync(WEB).filter(x => x.endsWith(".html"))) {
  const p = path.join(WEB, f);
  let s = fs.readFileSync(p, "utf8");
  if (!s.includes('id="wConnect"')) continue;
  const before = s;

  // connect: swap the row, and say the word
  s = s.replace(
    /( {2}const d=\$\("wDisconnect"\); if\(d\) d\.style\.display="";)/,
    '  const c=$("wConnect"); if(c) c.style.display="none";\n$1');
  s = s.replace(
    /wSet\(wShort\(W_ADDR\),W_CHAIN===W_BASE_ID\?"good":"warn",""\);/g,
    'wSet(W_CHAIN===W_BASE_ID?"connected":"wrong network",' +
    'W_CHAIN===W_BASE_ID?"good":"warn","");');

  // forget: put it back
  s = s.replace(
    /( {2}const d=\$\("wDisconnect"\); if\(d\) d\.style\.display="none";)/,
    '  const c=$("wConnect"); if(c) c.style.display="";\n$1');

  if (s !== before) { fs.writeFileSync(p, s); n++; console.log("  " + f); }
}
console.log(`\n${n} pages`);
