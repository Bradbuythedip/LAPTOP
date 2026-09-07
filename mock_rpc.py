#!/usr/bin/env python3
"""Mock Base JSON-RPC for testing laptop_buy.py.  SCENARIO=none | pools"""
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from eth_abi import encode, decode
from Crypto.Hash import keccak

SCEN = os.environ.get("SCENARIO", "none")
def sel(sig):
    k = keccak.new(digest_bits=256); k.update(sig.encode()); return k.hexdigest()[:8]
L = "0xb095274743941e953c746f9c228da9c18bb6ec29"
W = "0x4200000000000000000000000000000000000006"
V2F = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6"; V2R = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24"
V3F = "0x33128a8fc17869897dce68ed026d694621f6fdfd"; V3R = "0x2626664c2603336e57b271c5c0b26f421741e481"; Q2 = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a"
AF = "0x420dd381b31aef6683db6b902084cb0ffece40da"; AR = "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43"
ZERO = "0x" + "0" * 40
V2PAIR = "0x1111111111111111111111111111111111111111"
V3POOL = "0x3333333333333333333333333333333333333333"
# reserves: V2 pair 50M LAPTOP / 0.8 ETH (thin).  V3 pool holds 5 ETH.
V2_R_L, V2_R_E = 50_000_000 * 10**18, int(0.8e18)
V3_ETH = 5 * 10**18

def v2_out(amount_in, r_in, r_out):
    a = amount_in * 997
    return a * r_out // (r_in * 1000 + a)

def handle_call(to, data):
    to = to.lower(); s = data[2:10]; args = bytes.fromhex(data[10:])
    if to == L:
        if s == sel("name()"): return encode(["string"], ["Hunter Biden's Laptop"])
        if s == sel("symbol()"): return encode(["string"], ["LAPTOP"])
        if s == sel("decimals()"): return encode(["uint8"], [18])
        if s == sel("totalSupply()"): return encode(["uint256"], [10**9 * 10**18])
        if s == sel("balanceOf(address)"): return encode(["uint256"], [0])
    if to == W and s == sel("balanceOf(address)"):
        who = decode(["address"], args)[0]
        return encode(["uint256"], [V3_ETH if who.lower() == V3POOL else 0])
    if to == V2F and s == sel("getPair(address,address)"):
        return encode(["address"], [V2PAIR if SCEN == "pools" else ZERO])
    if to == V3F and s == sel("getPool(address,address,uint24)"):
        fee = decode(["address", "address", "uint24"], args)[2]
        return encode(["address"], [V3POOL if (SCEN == "pools" and fee == 3000) else ZERO])
    if to == AF and s == sel("getPool(address,address,bool)"):
        return encode(["address"], [ZERO])
    if to == V2PAIR:
        if s == sel("getReserves()"): return encode(["uint112", "uint112", "uint32"], [V2_R_L, V2_R_E, 0])
        if s == sel("token0()"): return encode(["address"], [L])
    if to == V2R and s == sel("getAmountsOut(uint256,address[])"):
        amt = decode(["uint256", "address[]"], args)[0]
        return encode(["uint256[]"], [[amt, v2_out(amt, V2_R_E, V2_R_L)]])
    if to == Q2 and s == sel("quoteExactInputSingle((address,address,uint256,uint24,uint160))"):
        amt = decode(["(address,address,uint256,uint24,uint160)"], args)[0][2]
        # pretend V3 pool: 5 ETH vs 100M LAPTOP, constant product approximation
        return encode(["uint256", "uint160", "uint32", "uint256"], [v2_out(amt, V3_ETH, 100_000_000 * 10**18), 0, 1, 90000])
    if to in (V2R, V3R, AR):  # swap simulation: succeed
        return encode(["uint256[]"], [[0, 0]])
    return b""

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        reqs = req if isinstance(req, list) else [req]
        out = []
        for r in reqs:
            m, p = r["method"], r.get("params", [])
            res = None
            if m == "web3_clientVersion": res = "mock-base/1.0"
            elif m == "eth_chainId": res = "0x2105"
            elif m == "net_version": res = "8453"
            elif m == "eth_blockNumber": res = "0x2000000"
            elif m == "eth_gasPrice": res = "0x5f5e100"
            elif m == "eth_maxPriorityFeePerGas": res = "0x1"
            elif m == "eth_getBalance": res = hex(10**18)
            elif m == "eth_getTransactionCount": res = "0x7"
            elif m == "eth_getCode": res = "0x6080" if p[0].lower() == L else "0x"
            elif m == "eth_estimateGas": res = hex(190_000)
            elif m == "eth_call": res = "0x" + handle_call(p[0]["to"], p[0].get("data", "0x")).hex()
            elif m == "eth_sendRawTransaction": res = "0x" + "ab" * 32
            elif m == "eth_getTransactionReceipt": res = {"status": "0x1", "transactionHash": "0x" + "ab" * 32, "blockNumber": "0x2000001",
                                                          "blockHash": "0x" + "cd" * 32, "transactionIndex": "0x0", "from": ZERO, "to": ZERO,
                                                          "gasUsed": "0x2ee00", "cumulativeGasUsed": "0x2ee00", "contractAddress": None, "logs": [],
                                                          "logsBloom": "0x" + "00" * 256, "type": "0x0", "effectiveGasPrice": "0x5f5e100"}
            elif m == "eth_getBlockByNumber": res = {"number": "0x2000000", "baseFeePerGas": "0x5f5e100", "gasLimit": "0x3938700", "timestamp": "0x66000000", "hash": "0x" + "ef" * 32, "parentHash": "0x" + "ef" * 32, "transactions": []}
            out.append({"jsonrpc": "2.0", "id": r.get("id"), "result": res})
        body = json.dumps(out if isinstance(req, list) else out[0]).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8545), H).serve_forever()
