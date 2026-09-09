// Re-encode the artwork with Chromium's canvas. No image library, no network.
//   node tools/encode-art.mjs           # report candidate sizes only
//   node tools/encode-art.mjs --write   # write the derivatives into web/
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");

// Each derivative names its source, its square edge, the quality to try, and its type.
//
// snoozebase.png is the app icon: the medallion, from the hero that already has its navy disc
// baked in. PNG rather than WebP because it is what a browser tab, an Apple touch icon and
// Phantom's in-app browser all read without argument. 256 square rather than 512 because it is
// fetched on every page load and the 512 came out at 259 KB — four times the size for a picture
// nothing ever renders above about 180. Drop your own square PNG at web/snoozebase.png and it
// is used as-is; nothing else derives from it.
const JOBS = [
  { src: "snooze.png", out: "snooze-256.webp",  edge: 256, q: 0.90 },
  { src: "snooze.png", out: "snooze-512.webp",  edge: 512, q: 0.90 },
  { src: "snooze.png", out: "snooze-768.webp",  edge: 768, q: 0.88 },
  { src: "hero.png",   out: "hero-512.webp",    edge: 512, q: 0.88 },
  { src: "hero.png",   out: "snoozebase.png",   edge: 256, q: 1, type: "image/png" },
];

const b = await chromium.launch();
const p = await b.newPage();
await p.route("**/*", async r => {
  const f = path.join(ROOT, "web", new URL(r.request().url()).pathname);
  const TYPE = { ".html": "text/html", ".png": "image/png", ".webp": "image/webp" };
  if (fs.existsSync(f) && fs.statSync(f).isFile())
    return r.fulfill({ body: fs.readFileSync(f),
                       contentType: TYPE[path.extname(f)] || "application/octet-stream" });
  return r.fulfill({ body: "<html><body>ok</body></html>", contentType: "text/html" });
});
await p.goto("http://x/index.html");

const out = await p.evaluate(async jobs => {
  const load = src => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
  });
  const results = [];
  for (const j of jobs) {
    const img = await load("/" + j.src);
    const c = document.createElement("canvas");
    c.width = j.edge; c.height = j.edge;
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, j.edge, j.edge);
    const url = c.toDataURL(j.type || "image/webp", j.q);
    results.push({ ...j, dataUrl: url, bytes: Math.floor((url.length - url.indexOf(",") - 1) * 3 / 4) });
  }
  return results;
}, JOBS);

for (const r of out) {
  const src = fs.statSync(path.join(ROOT, "web", r.src)).size;
  console.log(`${r.out.padEnd(18)} ${String(r.edge).padStart(4)}px q${r.q}  ` +
              `${(r.bytes / 1024).toFixed(0).padStart(5)} KB   ` +
              `(${r.src} is ${(src / 1024).toFixed(0)} KB, ` +
              `${(100 - r.bytes / src * 100).toFixed(1)}% smaller)`);
  if (WRITE) {
    const b64 = r.dataUrl.slice(r.dataUrl.indexOf(",") + 1);
    fs.writeFileSync(path.join(ROOT, "web", r.out), Buffer.from(b64, "base64"));
  }
}
if (WRITE) console.log("\nwritten into web/");
await b.close();
