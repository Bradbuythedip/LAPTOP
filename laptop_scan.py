#!/usr/bin/env python3
"""
laptop_scan.py - can LAPTOP (0xB095...ec29) be bought anywhere on Base, including Uniswap v4?

Two facts decide it, and this script establishes both from chain data:
  A. Supply movement. 1,000,000,000 LAPTOP was minted to one vault on Apr 27 2026. If the vault
     still holds all of it, zero tokens circulate, so no pool can exist on any DEX, hooked or
     hidden, and a flash loan has nothing to buy. This check is one eth_call once the vault is known.
  B. Uniswap v4 pools. v4 has no factory.getPool(); pools are keyed by hash(currency0, currency1,
     fee, tickSpacing, hooks). The only complete way to find one is the PoolManager's Initialize
     events filtered by currency == LAPTOP. This finds hooked pools too. For every pool found it
     reads live liquidity straight out of PoolManager storage (extsload), no StateView needed.

Fast path (recommended): a free Etherscan API key (etherscan.io -> API keys; V2 keys cover Base).
    export ETHERSCAN_API_KEY=...
    python3 laptop_scan.py
RPC-only path: works without a key, uses a block-timestamp binary search to find the mint,
then reads the vault balance. The full v4 event sweep over public RPC is slow and is only
attempted when supply has actually moved.
    python3 laptop_scan.py --rpc https://base-rpc.publicnode.com
"""
import argparse
import os
import sys
import time
from datetime import datetime, timezone

from web3 import Web3
from eth_abi import decode

CHAIN_ID = 8453
LAPTOP = Web3.to_checksum_address("0xB095274743941e953c746F9C228DA9c18Bb6ec29")
POOL_MANAGER = Web3.to_checksum_address("0x498581fF718922c3f8e6A244956aF099B2652b2b")  # Uniswap v4, Base
MINT_TIME = int(datetime(2026, 4, 27, 19, 17, 13, tzinfo=timezone.utc).timestamp())
SUPPLY = 10 ** 9 * 10 ** 18
TRANSFER_T0 = "0x" + Web3.keccak(text="Transfer(address,address,uint256)").hex().replace("0x", "")
INIT_T0 = "0x" + Web3.keccak(text="Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)").hex().replace("0x", "")
POOLS_SLOT = 6           # PoolManager: mapping(PoolId => Pool.State) _pools
LIQUIDITY_OFFSET = 3     # Pool.State: slot0, feeGrowth0, feeGrowth1, liquidity
ES_API = "https://api.etherscan.io/v2/api"


def h0x(h):
    h = h.hex() if hasattr(h, "hex") else h
    return h if h.startswith("0x") else "0x" + h


def topic_addr(a):
    return "0x" + a[2:].lower().rjust(64, "0")


def rpc(fn, *a, **kw):
    delay = 0.5
    for attempt in range(8):
        try:
            return fn(*a, **kw)
        except Exception as e:  # noqa: BLE001
            m = str(e)
            if attempt == 7 or not any(k in m for k in ("429", "Too Many", "imeout", "Connection", "502", "503")):
                raise
            time.sleep(delay)
            delay = min(delay * 2, 8)


# ---------------- Etherscan V2 fast path ----------------
def es_get(params, key):
    import requests
    params = dict(params, chainid=CHAIN_ID, apikey=key)
    for _ in range(5):
        r = requests.get(ES_API, params=params, timeout=30).json()
        if r.get("status") == "1" or r.get("message") == "No records found" or r.get("result") == []:
            return r.get("result") or []
        if "rate limit" in str(r.get("result", "")).lower():
            time.sleep(1.2)
            continue
        raise RuntimeError(f"Etherscan: {r.get('message')} {r.get('result')}")
    raise RuntimeError("Etherscan rate limit")


def es_transfers(key):
    out, page = [], 1
    while True:
        rows = es_get({"module": "account", "action": "tokentx", "contractaddress": LAPTOP,
                       "page": page, "offset": 1000, "sort": "asc"}, key)
        out += rows
        if len(rows) < 1000:
            return out
        page += 1


def es_v4_inits(key):
    logs = []
    for topic_pos in ("topic2", "topic3"):
        rows = es_get({"module": "logs", "action": "getLogs", "address": POOL_MANAGER,
                       "fromBlock": 0, "toBlock": "latest", "topic0": INIT_T0,
                       topic_pos: topic_addr(LAPTOP), f"topic0_{topic_pos[-1]}_opr": "and",
                       "page": 1, "offset": 1000}, key)
        logs += rows
    return logs


# ---------------- RPC-only path ----------------
def block_at(w3, ts):
    """Binary search the first block with timestamp >= ts."""
    lo, hi = 1, rpc(lambda: w3.eth.block_number)
    while lo < hi:
        mid = (lo + hi) // 2
        time.sleep(0.15)
        if rpc(w3.eth.get_block, mid)["timestamp"] < ts:
            lo = mid + 1
        else:
            hi = mid
    return lo


def get_logs_chunked(w3, flt, start, end, chunk):
    logs, a = [], start
    while a <= end:
        b = min(a + chunk - 1, end)
        try:
            logs += rpc(w3.eth.get_logs, dict(flt, fromBlock=a, toBlock=b))
            a = b + 1
        except Exception as e:  # noqa: BLE001
            if "403" in str(e) or "Forbidden" in str(e):
                sys.exit("   This RPC refuses eth_getLogs (403). Re-run with --vault <address from Basescan>, "
                         "or --rpc https://mainnet.base.org / https://base.llamarpc.com / https://base.drpc.org")
            if chunk <= 500:
                raise
            chunk //= 2
            print(f"    (range too big for this RPC, retrying with {chunk}-block chunks: {str(e)[:60]})")
    return logs


KNOWN = {POOL_MANAGER.lower(): "Uniswap v4 PoolManager",
         "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap V3 SwapRouter02",
         "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24": "Uniswap V2 Router",
         "0x6ff5693b99212da76ad316178a184ab56d299b43": "Uniswap Universal Router",
         "0x7c5f5a4bbd8fd63184577525326123b519429bdc": "Uniswap v4 PositionManager",
         "0x1a44076050125fac6d3b4a5dc5d4a3f6a7b8f6e9": "LayerZero EndpointV2",
         "0x4e59b44847b379578588920ca78fbf26c0b4956c": "Create2 factory"}


def all_transfers(w3, start, end, chunk):
    """Every LAPTOP Transfer since the mint: (block, from, to, amount)."""
    logs = get_logs_chunked(w3, {"address": LAPTOP, "topics": [TRANSFER_T0]}, start, end, chunk)
    rows = []
    for lg in logs:
        t = [h0x(x) for x in lg["topics"]]
        blk = lg["blockNumber"]
        blk = int(blk, 16) if isinstance(blk, str) else blk
        amt = int.from_bytes(bytes.fromhex(h0x(lg["data"])[2:]), "big")
        rows.append((blk, "0x" + t[1][-40:], "0x" + t[2][-40:], amt))
    return sorted(rows)


def label(w3, addr, vault=None, cache={}):
    a = addr.lower()
    if a == "0x" + "0" * 40:
        return "mint"
    if vault and a == vault.lower():
        return "vault"
    if a in KNOWN:
        return KNOWN[a]
    if a not in cache:
        code = rpc(w3.eth.get_code, Web3.to_checksum_address(addr))
        cache[a] = "contract" if code not in (b"", b"\x00") else "EOA"
    return cache[a]


HOOK_FLAGS = [(13, "beforeInitialize"), (12, "afterInitialize"), (11, "beforeAddLiquidity"), (10, "afterAddLiquidity"),
              (9, "beforeRemoveLiquidity"), (8, "afterRemoveLiquidity"), (7, "beforeSwap"), (6, "afterSwap"),
              (5, "beforeDonate"), (4, "afterDonate"), (3, "beforeSwapReturnsDelta"), (2, "afterSwapReturnsDelta"),
              (1, "afterAddLiquidityReturnsDelta"), (0, "afterRemoveLiquidityReturnsDelta")]


def hook_perms(addr):
    bits = int(addr, 16) & ((1 << 14) - 1)
    return [n for b, n in HOOK_FLAGS if bits >> b & 1] or ["none"]


def erc20_meta(w3, addr):
    if int(addr, 16) == 0:
        return "native ETH", 18
    try:
        raw = rpc(w3.eth.call, {"to": Web3.to_checksum_address(addr), "data": "0x95d89b41"})
        sym = decode(["string"], raw)[0]
        dec = int.from_bytes(rpc(w3.eth.call, {"to": Web3.to_checksum_address(addr), "data": "0x313ce567"}), "big")
        return sym, dec
    except Exception:  # noqa: BLE001
        return "?", 18


def token_balance(w3, token, holder):
    raw = rpc(w3.eth.call, {"to": token, "data": "0x70a08231" + holder[2:].lower().rjust(64, "0")})
    return int.from_bytes(raw, "big")


def describe_pool(w3, lg, p):
    sym0, dec0 = erc20_meta(w3, p["c0"])
    sym1, dec1 = erc20_meta(w3, p["c1"])
    price = (p["sqrtp"] / 2 ** 96) ** 2 * 10 ** (dec0 - dec1)   # currency1 per currency0
    fee = "DYNAMIC (hook-set)" if p["fee"] == 0x800000 else f"{p['fee']/1e4:.2f}%"
    print(f"     {sym0} / {sym1}   fee {fee}   tickSpacing {p['spacing']}   initial price {price:.10g} {sym1} per {sym0}")
    print(f"     hook {p['hooks']}  permissions: {', '.join(hook_perms(p['hooks']))}")
    try:
        tx = rpc(w3.eth.get_transaction, lg["transactionHash"])
        print(f"     initialized by {tx['from']} via {tx['to']}  tx {h0x(lg['transactionHash'])}")
        for who, tag in ((tx["from"], "initializer"), (tx["to"], "called contract"), (p["hooks"], "hook")):
            b = token_balance(w3, LAPTOP, who)
            if b:
                print(f"     {tag} {who} holds {b/1e18:,.0f} LAPTOP")
    except Exception as e:  # noqa: BLE001
        print(f"     (could not fetch init tx: {str(e)[:80]})")


def decode_init(log):
    """Initialize(bytes32 indexed id, address indexed c0, address indexed c1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"""
    topics = [h0x(t) for t in log["topics"]]
    data = bytes.fromhex(h0x(log["data"])[2:])
    fee, spacing, hooks, sqrtp, tick = decode(["uint24", "int24", "address", "uint160", "int24"], data)
    return {"id": topics[1], "c0": "0x" + topics[2][-40:], "c1": "0x" + topics[3][-40:],
            "fee": fee, "spacing": spacing, "hooks": hooks, "sqrtp": sqrtp, "tick": tick,
            "block": int(log["blockNumber"], 16) if isinstance(log["blockNumber"], str) else log["blockNumber"]}


def v4_liquidity(w3, pool_id):
    base = int.from_bytes(Web3.keccak(bytes.fromhex(pool_id[2:]) + POOLS_SLOT.to_bytes(32, "big")), "big")
    slot = (base + LIQUIDITY_OFFSET).to_bytes(32, "big")
    data = "0x1e2eaeaf" + slot.hex()  # extsload(bytes32)
    raw = rpc(w3.eth.call, {"to": POOL_MANAGER, "data": data})
    return int.from_bytes(raw, "big")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", default=os.environ.get("BASE_RPC", "https://base-rpc.publicnode.com"))
    ap.add_argument("--chunk", type=int, default=50_000, help="eth_getLogs block range per request (RPC path)")
    ap.add_argument("--full-sweep", action="store_true", help="RPC path: sweep v4 Initialize events even if supply never moved")
    ap.add_argument("--vault", help="mint recipient address (from Basescan); skips the log search, one eth_call decides")
    args = ap.parse_args()
    key = os.environ.get("ETHERSCAN_API_KEY")

    w3 = Web3(Web3.HTTPProvider(args.rpc, request_kwargs={"timeout": 60}))
    if rpc(lambda: w3.eth.chain_id) != CHAIN_ID:
        sys.exit("RPC is not Base.")

    # ---------- A. supply movement ----------
    print("A. Has any LAPTOP ever left the mint vault?")
    vault, moved = None, None
    if key:
        rows = es_transfers(key)
        print(f"   Etherscan: {len(rows)} LAPTOP transfer(s) in history.")
        for r in rows[:25]:
            t = datetime.fromtimestamp(int(r["timeStamp"]), timezone.utc).strftime("%Y-%m-%d %H:%M")
            print(f"     {t}  {r['from'][:10]}.. -> {r['to'][:10]}..  {int(r['value'])/1e18:,.0f}")
        if rows:
            vault = Web3.to_checksum_address(rows[0]["to"])
            moved = len(rows) > 1
    elif args.vault:
        vault = Web3.to_checksum_address(args.vault)
        print(f"   vault given: {vault}")
    else:
        print("   (no ETHERSCAN_API_KEY; locating the mint by block timestamp)")
        b = block_at(w3, MINT_TIME)
        logs = get_logs_chunked(w3, {"address": LAPTOP, "topics": [TRANSFER_T0, topic_addr("0x" + "0" * 40)]},
                                max(1, b - 2000), b + 2000, 4000)
        if not logs:
            sys.exit("   Could not locate the mint event around the expected block; try the Etherscan path.")
        vault = Web3.to_checksum_address("0x" + h0x(logs[0]["topics"][2])[-40:])
        print(f"   Mint found in block {int(logs[0]['blockNumber'], 16) if isinstance(logs[0]['blockNumber'], str) else logs[0]['blockNumber']}.")
    bal = rpc(w3.eth.call, {"to": LAPTOP, "data": "0x70a08231" + vault[2:].lower().rjust(64, "0")})
    bal = int.from_bytes(bal, "big")
    print(f"   Vault {vault} holds {bal/1e18:,.0f} of {SUPPLY/1e18:,.0f} LAPTOP now.")
    if moved is None:
        moved = bal != SUPPLY
    if not moved:
        print("   => 0 tokens circulate. No pool can exist on any venue, hooked or hidden. "
              "A flash loan cannot buy a token nobody holds.")
    else:
        print(f"   => {(SUPPLY - bal)/1e18:,.0f} LAPTOP is outside the vault. Continue.")
        if not key:
            print("\nA2. Where did it go? (every LAPTOP transfer since the mint)")
            start = block_at(w3, MINT_TIME) - 100
            end = rpc(lambda: w3.eth.block_number)
            rows = all_transfers(w3, start, end, args.chunk)
            bals = {}
            for blk, frm, to, amt in rows:
                bals[frm.lower()] = bals.get(frm.lower(), 0) - amt
                bals[to.lower()] = bals.get(to.lower(), 0) + amt
                print(f"   block {blk}  {frm} ({label(w3, frm, vault)}) -> {to} ({label(w3, to, vault)})  {amt/1e18:,.0f}")
            print("   Holders now:")
            for a, v in sorted(bals.items(), key=lambda kv: -kv[1]):
                if v > 0 and a != "0x" + "0" * 40:
                    print(f"     {Web3.to_checksum_address(a)}  {v/1e18:,.0f}  ({label(w3, a, vault)})")

    # ---------- B. Uniswap v4 pools ----------
    print("\nB. Uniswap v4 pools containing LAPTOP (PoolManager Initialize events, hooks included):")
    if key:
        inits = es_v4_inits(key)
    elif moved or args.full_sweep:
        start = block_at(w3, MINT_TIME) - 100
        end = rpc(lambda: w3.eth.block_number)
        print(f"   sweeping blocks {start}..{end} in {args.chunk}-block chunks (slow on public RPC)")
        inits = []
        for pos in (2, 3):   # currency0 or currency1 == LAPTOP
            topics = [INIT_T0, None, None, None]
            topics[pos] = topic_addr(LAPTOP)
            inits += get_logs_chunked(w3, {"address": POOL_MANAGER, "topics": topics}, start, end, args.chunk)
    else:
        print("   skipped: supply never moved, so no v4 pool can hold LAPTOP (use --full-sweep to force).")
        inits = []
    pm_bal = token_balance(w3, LAPTOP, POOL_MANAGER)
    print(f"   LAPTOP held by PoolManager (all v4 pools combined): {pm_bal/1e18:,.0f}")
    if not inits:
        print("   none found.")
    for lg in inits:
        p = decode_init(lg)
        liq = v4_liquidity(w3, p["id"])
        print(f"   pool {p['id']}\n     currencies {p['c0']} / {p['c1']}  initialized at block {p['block']}  live liquidity {liq}")
        describe_pool(w3, lg, p)
        if liq == 0:
            print("     (initialized but empty: no tokens to buy here)")

    print("\nDone.")


if __name__ == "__main__":
    main()
