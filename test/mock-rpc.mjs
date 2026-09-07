// Mock Base JSON-RPC node for testing web/index.html without touching mainnet.
// Scenario is chosen by the URL path: /happy, /pools, /wrongchain, /flaky, /nobatch, /nocode
import http from "node:http";

const LAPTOP   = "0xb095274743941e953c746f9c228da9c18bb6ec29";
const USDC     = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const POOL_MGR = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const AERO_REG = "0x5c3f18f06cc09ca1910767a34a20f771039e37c0";
const V3_FAC   = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
const WETH     = "0x4200000000000000000000000000000000000006";
const POOL     = "0x1111111111111111111111111111111111111111";
const FOREIGN0 = "0xaaaa000000000000000000000000000000000001";
const FOREIGN1 = "0xbbbb000000000000000000000000000000000002";
// V3 fixture: spot 100,000 LAPTOP per WETH, virtual reserve 10 WETH deep.
// sqrtP = sqrt(1e5) = 316.227766..., L = 10e18 * sqrtP
const SQRT_P_X96 = BigInt(Math.floor(316.22776601683796 * 2 ** 96));
const V3_LIQ = 3162277660168379331998n;
// Reversed ordering: LAPTOP is token0, so price = WETH per LAPTOP = 1e-5.
const SQRT_P_REV_X96 = BigInt(Math.floor(0.0031622776601683794 * 2 ** 96));
// USDC-quoted (6 decimals on one side): 1 USDC = 10 LAPTOP, so raw price = 1e13.
const SQRT_P_USDC_X96 = BigInt(Math.floor(3162277.6601683795 * 2 ** 96));
const V3_LIQ_USDC = 158113883008418966n;

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
    if (scn === "pool-nocode") return { result: "0x" };
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

    // ---- size-curve pool fixtures ----
    if (scn.startsWith("pool-")) {
      const rev = scn.startsWith("pool-rev"), usdcQ = scn === "pool-usdc";
      const foreign = scn === "pool-foreign";
      const t0 = foreign ? FOREIGN0 : rev ? LAPTOP : usdcQ ? USDC : WETH;
      const t1 = foreign ? FOREIGN1 : rev ? WETH : LAPTOP;
      const decOf = a => (a === USDC ? 6 : 18);
      const symOf = a => a === LAPTOP ? "LAPTOP" : a === WETH ? "WETH"
                       : a === USDC ? "USDC" : "FOO";
      const sqrtX = usdcQ ? SQRT_P_USDC_X96 : rev ? SQRT_P_REV_X96 : SQRT_P_X96;
      const liq = usdcQ ? V3_LIQ_USDC : V3_LIQ;
      if (to === POOL) {
        const v2like = scn === "pool-v2" || scn === "pool-stable" || scn === "pool-rev-v2";
        if (sel === "0x0dfe1681") return { result: addrWord(t0) };            // token0
        if (sel === "0xd21220a7") return { result: addrWord(t1) };            // token1
        if (sel === "0x3850c7bd")                                            // slot0
          return v2like ? { result: "0x" }
                        : { result: uintWord(sqrtX) + "0".repeat(64 * 6) };
        if (sel === "0x1a686502")                                            // liquidity
          return v2like ? { result: "0x" }
               : scn === "pool-dry" ? { result: W0 } : { result: uintWord(liq) };
        if (sel === "0x0902f1ac") {                                          // getReserves
          if (!v2like) return { result: "0x" };
          // token0 reserve first. Reversed pools put LAPTOP in slot 0.
          const rL = 1000000n * 10n ** 18n, rW = 10n * 10n ** 18n;
          return { result: uintWord(rev ? rL : rW) + uintWord(rev ? rW : rL).slice(2)
                           + W0.slice(2) };
        }
        if (sel === "0xddca3f43") return { result: uintWord(3000) };          // fee
        if (sel === "0x22be3de1") return { result: scn === "pool-stable" ? uintWord(1) : W0 };
        return { result: "0x" };
      }
      if (sel === "0x313ce567") return { result: uintWord(decOf(to)) };       // decimals
      if (sel === "0x95d89b41") return { result: strWord(symOf(to)) };        // symbol
      if (sel === "0x70a08231") {                                            // balanceOf(pool)
        if (scn === "pool-nobal") return { error: { code: -32000, message: "execution reverted" } };
        if (to === LAPTOP)
          return { result: uintWord(scn === "pool-cap" ? 1000n * 10n ** 18n
                                                       : 1000000n * 10n ** 18n) };
        return { result: uintWord(10n * 10n ** 18n) };
      }
      return { result: "0x" };
    }

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
  let scn = (req.url || "/happy").split("?")[0].replace(/^\//, "") || "happy";
  // "nocors-<scenario>" serves the scenario WITHOUT any access-control-allow-origin.
  // application/json is not a CORS-safelisted content type, so the browser preflights
  // every one of these requests; withholding the header on OPTIONS blocks them outright.
  const noCors = scn.startsWith("nocors");
  if (noCors) scn = scn.replace(/^nocors-?/, "") || "happy";
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    if (!noCors) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
    }
    res.setHeader("content-type", "application/json");
    if (req.method === "OPTIONS") { res.writeHead(noCors ? 403 : 204); res.end(); return; }
    let parsed;
    if (scn === "html") { parsed = {}; }
    else {
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end("{}"); return; }
    }

    if (scn === "html") {
      res.setHeader("content-type", "text/html");
      res.writeHead(200);
      res.end("<!doctype html><html><body><h1>429 Too Many Requests</h1></body></html>");
      return;
    }
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
