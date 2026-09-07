// Mock Base JSON-RPC node for testing web/index.html without touching mainnet.
// Scenario is chosen by the URL path: /happy, /pools, /wrongchain, /flaky, /nobatch, /nocode
import http from "node:http";

const LAPTOP   = "0xb095274743941e953c746f9c228da9c18bb6ec29";
const USDC     = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL_MGR = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const AERO_REG = "0x5c3f18f06cc09ca1910767a34a20f771039e37c0";
const V3_FAC   = "0x33128a8fc17869897dce68ed026d694621f6fdfd";

const W0 = "0x" + "0".repeat(64);
const word = h => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const addrWord = a => "0x" + word(a);
const uintWord = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
// ABI-encoded dynamic string
function strWord(s) {
  const b = Buffer.from(s, "utf8");
  const len = b.length.toString(16).padStart(64, "0");
  const data = b.toString("hex").padEnd(Math.ceil(b.length / 32) * 64, "0");
  return "0x" + (32).toString(16).padStart(64, "0") + len + data;
}
function addrArrayWord(list) {
  let out = (32).toString(16).padStart(64, "0") + list.length.toString(16).padStart(64, "0");
  for (const a of list) out += word(a);
  return "0x" + out;
}

const CODE = "0x6080604052348015600f57600080fd5b50" + "ab".repeat(64);

function handle(scn, req) {
  const { method, params } = req;

  if (method === "eth_chainId") {
    if (scn === "wrongchain") return { result: "0x1" };
    return { result: "0x2105" }; // 8453
  }
  if (method === "eth_blockNumber") return { result: "0x1470c27" };

  if (method === "eth_getCode") {
    const [addr, blk] = params;
    if (scn === "nocode") return { result: "0x" };
    if (blk && blk !== "latest") {
      if (scn === "flaky") return { error: { code: -32000, message: "missing trie node — state not available" } };
      return { result: "0x" }; // did not exist 24h ago
    }
    return { result: addr.toLowerCase() === LAPTOP ? CODE : CODE };
  }

  if (method === "eth_call") {
    const to = (params[0].to || "").toLowerCase();
    const data = (params[0].data || "").toLowerCase();
    const sel = data.slice(0, 10);

    if (scn === "flaky" && (sel === "0x95d89b41" || sel === "0xe6a43905")) {
      return { error: { code: -32005, message: "rate limit exceeded" } };
    }
    // ERC-20 reads on the token
    if (sel === "0x06fdde03") return { result: strWord("Laptop") };
    if (sel === "0x95d89b41") return { result: strWord("LAPTOP") };
    if (sel === "0x313ce567") return { result: uintWord(18) };
    if (sel === "0x18160ddd") return { result: uintWord("1000000000000000000000000000") };

    // balanceOf(PoolManager) on the token — the v4 gate
    if (sel === "0x70a08231" && to === LAPTOP) {
      const who = "0x" + data.slice(10 + 24, 10 + 64);
      if (who === POOL_MGR) return { result: scn === "pools" ? uintWord("5000000000000000000") : W0 };
      return { result: W0 };
    }
    // Aerodrome registry
    if (sel === "0x06121cd5" && to === AERO_REG) {
      return { result: addrArrayWord([
        "0x420dd381b31aef6683db6b902084cb0ffece40da",
        "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a", // an unknown (Slipstream-shaped) factory
      ]) };
    }
    // Factory pool lookups
    if (sel === "0x1698ee82") { // V3 getPool(a,a,uint24)
      const fee = BigInt("0x" + data.slice(10 + 128, 10 + 192));
      const quote = "0x" + data.slice(10 + 64 + 24, 10 + 128);
      if (scn === "pools" && to === V3_FAC && fee === 3000n && quote === USDC)
        return { result: addrWord("0x1111111111111111111111111111111111111111") };
      return { result: W0 };
    }
    if (sel === "0xe6a43905") return { result: W0 };  // V2 getPair
    if (sel === "0x79bc57d5") return { result: W0 };  // Aerodrome getPool
    if (sel === "0x28af8d0b") return { error: { code: -32000, message: "execution reverted" } };

    return { result: "0x" }; // unknown selector: empty return (must read as "could not check")
  }
  return { error: { code: -32601, message: "method not found" } };
}

const server = http.createServer((req, res) => {
  const scn = (req.url || "/happy").split("?")[0].replace(/^\//, "") || "happy";
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("content-type", "application/json");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end("{}"); return; }

    if (Array.isArray(parsed)) {
      if (scn === "nobatch") { // endpoint refuses batches
        res.writeHead(200);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch not supported" } }));
        return;
      }
      const out = parsed.map(r => ({ jsonrpc: "2.0", id: r.id, ...handle(scn, r) }));
      res.writeHead(200); res.end(JSON.stringify(out)); return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, ...handle(scn, parsed) }));
  });
});

const PORT = Number(process.env.MOCK_PORT || 8599);
server.listen(PORT, () => console.log("mock rpc on http://127.0.0.1:" + PORT));
