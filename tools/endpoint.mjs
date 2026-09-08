// One place to set the Base endpoint, applied to every page that reads the chain.
//
// The pages each grew their own RPC line, so there were five of them and they disagreed about
// what the default was. This sets all of them at once and leaves the same shape everywhere:
// the endpoint you name first, the user's own localStorage override second, and the public
// endpoint last.
//
//   node tools/endpoint.mjs                          # show what each page uses now
//   node tools/endpoint.mjs /api/rpc                 # same-origin path (recommended)
//   node tools/endpoint.mjs https://your-node/v2/KEY # direct, and see the warning below
//
// A KEYED URL IN A STATIC FILE IS PUBLIC. The browser has to read it to use it, so anybody who
// views source can too, and no obfuscation changes that. Referrer restriction cannot save it
// either — every fetch on this site sets no-referrer, so your provider sees nothing to check.
// Origin allowlisting does work. The way to use a paid endpoint without publishing its key is
// a same-origin path (/api/rpc) with the key held server-side.
import fs from "node:fs";
import path from "node:path";
const WEB = path.resolve(new URL(".", import.meta.url).pathname, "..", "web");
const next = process.argv[2];

const PAT = /(["'])https:\/\/mainnet\.base\.org\1|(["'])\/api\/rpc\2|(["'])https:\/\/[^"']*\1(?=;?\s*(?:\/\/[^\n]*)?\n)/;
let changed = 0;
for (const f of fs.readdirSync(WEB).filter(x => x.endsWith(".html"))) {
  const p = path.join(WEB, f);
  const s = fs.readFileSync(p, "utf8");
  const lines = s.split("\n");
  const hits = [];
  lines.forEach((l, i) => {
    if (/(?:const|let)\s+(?:DEFAULT_)?RPC\b|PUBLIC_RPC\s*=|url:\s*localStorage|const RELAY\s*=/.test(l)
        && /https:\/\/|\/api\/rpc/.test(l)) hits.push(i);
  });
  if (!hits.length) continue;
  if (!next) {
    console.log(`${f}`);
    for (const i of hits) console.log(`  ${i + 1}: ${lines[i].trim()}`);
    continue;
  }
  let touched = false;
  for (const i of hits) {
    const before = lines[i];
    lines[i] = before.replace(/(["'])(?:https:\/\/[^"']+|\/api\/rpc)\1/g, (m, q) =>
      // Leave the public fallback alone; it is the last resort and should stay public.
      /PUBLIC_RPC/.test(before) ? m : q + next + q);
    if (lines[i] !== before) touched = true;
  }
  if (touched) { fs.writeFileSync(p, lines.join("\n")); changed++; console.log("  set " + f); }
}
if (next) {
  console.log(`\n${changed} pages now point at ${next}`);
  console.log("run `node tools/stamp.mjs` to republish the hashes, then `sh test/run-all.sh`");
} else {
  console.log("\npass an endpoint to set it everywhere, e.g. node tools/endpoint.mjs /api/rpc");
}
