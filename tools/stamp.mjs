// Refresh the build tag on every page and republish the hashes in the README.
// The clone defence is that a reader can hash the page they are looking at and compare it to
// what the README publishes, so the two drifting apart is not cosmetic — it silently disables
// the one check a visitor can perform.
//   node tools/stamp.mjs            # re-hash only, keep the current tag
//   node tools/stamp.mjs 2026-09-08b  # set a new tag on every page, then re-hash
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WEB = path.join(ROOT, "web");
const newTag = process.argv[2];

const pages = fs.readdirSync(WEB).filter(f => f.endsWith(".html")).sort();
if (newTag) {
  for (const f of pages) {
    const p = path.join(WEB, f);
    const s = fs.readFileSync(p, "utf8")
      .replace(/(id="buildId">)[^<]*(<)/, `$1${newTag}$2`);
    fs.writeFileSync(p, s);
  }
  console.log(`build tag set to ${newTag} on ${pages.length} pages`);
}

let readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const tag = (fs.readFileSync(path.join(WEB, "index.html"), "utf8")
  .match(/id="buildId">([^<]+)</) || [])[1];
readme = readme.replace(/Published build `[^`]+`/, `Published build \`${tag}\``);

for (const f of pages) {
  const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(WEB, f))).digest("hex");
  const line = new RegExp(`sha256\\(web/${f.replace(".", "\\.")}\\)\\s*= [0-9a-f]{64}`);
  if (line.test(readme)) readme = readme.replace(line, m => m.replace(/[0-9a-f]{64}/, h));
  else console.log(`  ! README has no line for web/${f} — add one`);
  console.log(`  ${f.padEnd(16)} ${h}`);
}
fs.writeFileSync(path.join(ROOT, "README.md"), readme);
console.log(`\nREADME republished at build ${tag}`);
