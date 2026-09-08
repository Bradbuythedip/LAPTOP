// Measure and re-encode the artwork with Chromium's canvas. No network, no image library.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const ROOT = "/home/user/LAPTOP";
const b = await chromium.launch();
const p = await b.newPage();
await p.route("**/*", async r => {
  const u = new URL(r.request().url());
  const f = path.join(ROOT, "web", u.pathname);
  if (fs.existsSync(f) && fs.statSync(f).isFile())
    return r.fulfill({ body: fs.readFileSync(f), contentType: "image/png" });
  return r.fulfill({ body: "<html><body>ok</body></html>", contentType: "text/html" });
});
await p.goto("http://x/index.html");

const out = await p.evaluate(async () => {
  const load = src => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
  });
  const report = {};
  for (const name of ["snooze.png", "hero.png", "bg.png"]) {
    const img = await load("/" + name);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1, opaque = 0;
    const hist = new Map();
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4, a = d[i + 3];
      if (a > 8) {
        opaque++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        // quantise to 5 bits per channel for a colour histogram
        const k = ((d[i] >> 3) << 10) | ((d[i+1] >> 3) << 5) | (d[i+2] >> 3);
        hist.set(k, (hist.get(k) || 0) + 1);
      }
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([k, n]) => {
        const r = ((k >> 10) & 31) << 3, g2 = ((k >> 5) & 31) << 3, b2 = (k & 31) << 3;
        return { hex: "#" + [r, g2, b2].map(v => v.toString(16).padStart(2, "0")).join(""),
                 pct: +(n / opaque * 100).toFixed(1) };
      });
    // brightest and darkest opaque pixel by luminance
    let bright = -1, dark = 1e9, bp = null, dp = null;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] <= 8) continue;
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (L > bright) { bright = L; bp = [d[i], d[i+1], d[i+2]]; }
      if (L < dark) { dark = L; dp = [d[i], d[i+1], d[i+2]]; }
    }
    const hex = a => "#" + a.map(v => v.toString(16).padStart(2, "0")).join("");
    report[name] = {
      w: c.width, h: c.height,
      opaquePct: +(opaque / (c.width * c.height) * 100).toFixed(1),
      bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      brightest: { hex: hex(bp), L: +bright.toFixed(1) },
      darkest: { hex: hex(dp), L: +dark.toFixed(1) },
      topColours: top,
    };
  }
  return report;
});
console.log(JSON.stringify(out, null, 2));
await b.close();
