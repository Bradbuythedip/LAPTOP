// Run tools/vanity.mjs across every core. A six-character suffix is ~16.8M keccaks on average
// and one core does about 60k/s, so alone it is minutes and in parallel it is not.
//   node tools/vanity-par.mjs beabed --deployer 0x... --inithash 0x... [--max 200000000]
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
const HERE = path.resolve(new URL(".", import.meta.url).pathname);
const args = process.argv.slice(2);
const N = Math.max(1, os.cpus().length - 1);
const per = Math.ceil(Number(args[args.indexOf("--max") + 1] || 200e6) / N);
console.log(`${N} lanes, ${per.toLocaleString()} salts each`);
const kids = [];
let done = false;
for (let lane = 0; lane < N; lane++) {
  const a = args.filter((_, i) => args[i - 1] !== "--max" && args[i] !== "--max")
    .concat(["--lane", String(lane), "--max", String(per)]);
  const k = spawn(process.execPath, [path.join(HERE, "vanity.mjs"), ...a],
                  { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  k.stdout.on("data", d => out += d);
  k.on("close", code => {
    if (code === 0 && !done) {
      done = true;
      process.stdout.write(out);
      for (const o of kids) if (o !== k) o.kill("SIGKILL");
    }
    if (kids.every(o => o.killed || o.exitCode !== null) && !done) {
      console.log("no salt found in any lane — raise --max");
      process.exit(1);
    }
  });
  kids.push(k);
}
