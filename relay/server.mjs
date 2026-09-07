// OPTIONAL read-only JSON-RPC relay. Deploy this ONLY if browsers cannot reach a Base
// endpoint directly (a CORS failure). The tool defaults to direct reads and does not need it.
//
// Deploy on Railway:
//   1. New service from this repo, root directory `relay`
//   2. Start command: node server.mjs
//   3. Set UPSTREAM_RPC to a Base endpoint (a keyed one is fine — the key stays server-side)
//   4. In vercel.json add:  "rewrites": [{ "source": "/api/rpc", "destination": "https://<svc>.up.railway.app/" }]
//
// What it deliberately does NOT do: log, store, or forward request bodies anywhere. It cannot
// prove that to a user, which is exactly why the tool treats the relay as opt-in and says
// on screen that the relay sees every address checked.
import http from "node:http";

const UPSTREAM = process.env.UPSTREAM_RPC || "https://mainnet.base.org";
const PORT = Number(process.env.PORT || 3000);

// Only read methods. A relay that can broadcast is a relay that can be abused.
const ALLOWED = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode",
  "eth_getTransactionReceipt", "eth_getStorageAt", "eth_getBlockByNumber",
]);
const MAX_BATCH = 200;
const MAX_BODY = 512 * 1024;

const bad = (res, code, msg) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: msg } }));
};

http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("referrer-policy", "no-referrer");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "POST") return bad(res, 405, "POST only");

  let body = "", tooBig = false;
  req.on("data", c => {
    body += c;
    if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
  });
  req.on("end", async () => {
    if (tooBig) return bad(res, 413, "body too large");
    let parsed;
    try { parsed = JSON.parse(body); } catch { return bad(res, 400, "invalid JSON"); }

    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length > MAX_BATCH) return bad(res, 413, "batch too large");
    for (const c of list) {
      if (!c || typeof c.method !== "string") return bad(res, 400, "malformed call");
      if (!ALLOWED.has(c.method)) return bad(res, 403, "method not allowed: " + c.method);
    }

    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const up = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
        signal: ctl.signal,
      });
      clearTimeout(t);
      const txt = await up.text();
      res.writeHead(up.status, { "content-type": "application/json" });
      res.end(txt);
    } catch (e) {
      bad(res, 502, "upstream unreachable: " + (e.name === "AbortError" ? "timeout" : "error"));
    }
  });
}).listen(PORT, () => console.log("relay on :" + PORT + " -> " + UPSTREAM));
