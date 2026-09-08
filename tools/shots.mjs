// Screenshot every page at a phone and a desktop width, so a look can be judged by looking.
//   node tools/shots.mjs [page.html ...]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const OUT = path.join(ROOT, "shots");
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const pages = (only.length ? only
  : fs.readdirSync(path.join(ROOT, "web")).filter(f => f.endsWith(".html"))).sort();

const b = await chromium.launch();
const TYPE = { ".html": "text/html", ".png": "image/png", ".webp": "image/webp" };
for (const [label, w, h] of [["phone", 390, 844], ["desk", 1440, 900]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h },
                                   deviceScaleFactor: label === "phone" ? 2 : 1 });
  const p = await ctx.newPage();
  await p.route("**/*", async r => {
    const f = path.join(ROOT, "web", new URL(r.request().url()).pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile())
      return r.fulfill({ body: fs.readFileSync(f),
                         contentType: TYPE[path.extname(f)] || "application/octet-stream" });
    return r.fulfill({ status: 404, body: "" });
  });
  for (const f of pages) {
    await p.goto("http://x/" + f, { waitUntil: "load" });
    await p.waitForTimeout(350);
    const name = `${f.replace(".html", "")}-${label}.png`;
    await p.screenshot({ path: path.join(OUT, name), fullPage: false });
    await p.screenshot({ path: path.join(OUT, name.replace(".png", "-full.png")), fullPage: true });
    // horizontal overflow is the mobile bug that never shows up on a desktop
    const over = await p.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`${name.padEnd(28)} ${over > 0 ? `OVERFLOWS by ${over}px` : "no h-scroll"}`);
  }
  await ctx.close();
}
await b.close();
