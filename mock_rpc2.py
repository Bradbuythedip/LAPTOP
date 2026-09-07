import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from eth_abi import encode
from Crypto.Hash import keccak
def kec(b): k=keccak.new(digest_bits=256); k.update(b); return k.digest()
SCEN = os.environ.get("SCENARIO","vaulted")
L="0xb095274743941e953c746f9c228da9c18bb6ec29"; PM="0x498581ff718922c3f8e6a244956af099b2652b2b"
VAULT="0xf859bf7a00000000000000000000000004ccd8b24d"; SUPPLY=10**27
T0=1_700_000_000; MINT_TS=1777317433  # 2026-04-27 19:17:13 UTC
HEAD=45_000_000
def ts(n): return T0 + 2*n
MINT_BLOCK = (MINT_TS - T0)//2 + 1
TRANSFER="0x"+kec(b"Transfer(address,address,uint256)").hex(); INIT="0x"+kec(b"Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)").hex()
pad=lambda a: "0x"+a[2:].lower().rjust(64,"0")
POOL_ID="0x"+"77"*32; HOOK="0x0000000000000000000000000000000000000abc"
def pool_liq_slot():
    base=int.from_bytes(kec(bytes.fromhex(POOL_ID[2:])+ (6).to_bytes(32,"big")),"big")
    return (base+3).to_bytes(32,"big").hex()
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_POST(self):
        req=json.loads(self.rfile.read(int(self.headers["Content-Length"]))); reqs=req if isinstance(req,list) else [req]; out=[]
        for r in reqs:
            m,p=r["method"],r.get("params",[]); res=None
            if m=="web3_clientVersion": res="mock"
            elif m=="eth_chainId": res="0x2105"
            elif m=="eth_blockNumber": res=hex(HEAD)
            elif m=="eth_getBalance": res=hex(10**17)
            elif m=="eth_getTransactionCount": res="0x3"
            elif m=="eth_gasPrice": res="0x5f5e100"
            elif m=="eth_estimateGas": res=hex(300000)
            elif m=="eth_sendRawTransaction": res="0x"+"cd"*32
            elif m=="eth_getBlockByNumber":
                n=int(p[0],16) if p[0]!="latest" else HEAD
                res={"number":hex(n),"timestamp":hex(ts(n)),"hash":"0x"+"11"*32,"parentHash":"0x"+"11"*32,"transactions":[],"gasLimit":"0x1","gasUsed":"0x0","baseFeePerGas":"0x1","miner":"0x"+"00"*20,"difficulty":"0x0","totalDifficulty":"0x0","size":"0x0","extraData":"0x","logsBloom":"0x"+"00"*256,"nonce":"0x0000000000000000","sha3Uncles":"0x"+"00"*32,"stateRoot":"0x"+"00"*32,"receiptsRoot":"0x"+"00"*32,"transactionsRoot":"0x"+"00"*32,"uncles":[],"mixHash":"0x"+"00"*32}
            elif m=="eth_getLogs":
                f=p[0]; a=int(f["fromBlock"],16); b=int(f["toBlock"],16); addr=(f["address"][0] if isinstance(f["address"],list) else f["address"]).lower(); tps=f.get("topics",[]); res=[]
                if addr==L and a<=MINT_BLOCK<=b and tps[0].lower()==TRANSFER:
                    res=[{"address":L,"topics":[TRANSFER,pad("0x"+"0"*40),pad(VAULT)],"data":"0x"+SUPPLY.to_bytes(32,"big").hex(),"blockNumber":hex(MINT_BLOCK),"transactionHash":"0x"+"22"*32,"transactionIndex":"0x0","blockHash":"0x"+"11"*32,"logIndex":"0x0","removed":False}]
                if addr==PM and SCEN=="moved" and tps[0].lower()==INIT and a<=MINT_BLOCK+500_000<=b and (((tps[2] if len(tps)>2 else None) or "").lower()==pad(L) or ((tps[3] if len(tps)>3 else None) or "").lower()==pad(L)):
                    data=encode(["uint24","int24","address","uint160","int24"],[3000,60,HOOK,79228162514264337593543950336,0])
                    res=[{"address":PM,"topics":[INIT,POOL_ID,pad(L),pad("0x4200000000000000000000000000000000000006")],"data":"0x"+data.hex(),"blockNumber":hex(MINT_BLOCK+500_000),"transactionHash":"0x"+"33"*32,"transactionIndex":"0x0","blockHash":"0x"+"11"*32,"logIndex":"0x0","removed":False}]
            elif m=="eth_getTransactionByHash": res={"hash":p[0],"from":"0x"+"aa"*20,"to":"0x"+"bb"*20,"blockNumber":hex(MINT_BLOCK+500_000),"blockHash":"0x"+"11"*32,"transactionIndex":"0x0","nonce":"0x1","value":"0x0","gas":"0x1","gasPrice":"0x1","input":"0x","v":"0x0","r":"0x0","s":"0x0","type":"0x0","chainId":"0x2105"}
            elif m=="eth_call":
                d=p[0]["data"]; to=p[0]["to"].lower()
                if to==L and d.startswith("0x70a08231"): res="0x"+(SUPPLY if SCEN=="vaulted" else SUPPLY-10**26).to_bytes(32,"big").hex()
                elif d.startswith("0x95d89b41"): res="0x"+encode(["string"],["QUOTE" if to!=L else "LAPTOP"]).hex()
                elif d.startswith("0x313ce567"): res="0x"+(18).to_bytes(32,"big").hex()
                elif to==PM and d.startswith("0x1e2eaeaf"): res="0x"+((12345678 if d[10:]==pool_liq_slot() else 0)).to_bytes(32,"big").hex()
                else: res="0x"+"00"*32
            out.append({"jsonrpc":"2.0","id":r.get("id"),"result":res})
        body=json.dumps(out if isinstance(req,list) else out[0]).encode()
        self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
HTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()
