#!/usr/bin/env python3
"""
laptop_watch.py - sit on Base and shout the moment LAPTOP (0xB095...ec29) becomes buyable.

Every --interval seconds it checks three things:
  1. Uniswap V2 / V3 / Aerodrome: does a LAPTOP/WETH pool exist and hold >= --min-liq-eth?
  2. Uniswap v4: any pool containing LAPTOP (Initialize events, hooks included) whose active
     liquidity went from 0 to non-zero. Prints the pool key so it can be traded manually.
  3. Token flow: every new LAPTOP Transfer since the last poll, flagging transfers INTO known
     DEX contracts (v4 PoolManager / PositionManager / Universal Router, V2/V3 routers,
     Aerodrome) and transfers out of the known holder set. That is the earliest signal:
     tokens move to a DEX contract one block before a pool goes live.

With --auto it runs `laptop_buy.py --eth X --send` the first time check 1 passes (V2/V3/Aero
only; v4 is alert-only). laptop_buy.py must be in the same folder and LAPTOP_PK set.

    python3 laptop_watch.py --rpc https://base-mainnet.g.alchemy.com/v2/KEY
    python3 laptop_watch.py --rpc ... --auto --eth 0.01
"""
import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

from web3 import Web3
from eth_abi import decode

CHAIN_ID = 8453
LAPTOP = Web3.to_checksum_address("0xB095274743941e953c746F9C228DA9c18Bb6ec29")
WETH = Web3.to_checksum_address("0x4200000000000000000000000000000000000006")
POOL_MANAGER = Web3.to_checksum_address("0x498581fF718922c3f8e6A244956aF099B2652b2b")
UNI_V2_FACTORY = Web3.to_checksum_address("0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6")
UNI_V3_FACTORY = Web3.to_checksum_address("0x33128a8fC17869897dcE68Ed026d694621f6FDfD")
AERO_FACTORY = Web3.to_checksum_address("0x420DD381b31aEf6683db6B902084cB0FFECe40Da")
V3_FEES = (100, 500, 3000, 10000)
ZERO = "0x0000000000000000000000000000000000000000"
USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
TRADABLE_QUOTES = {ZERO, WETH.lower(), USDC}
DEX = {POOL_MANAGER.lower(): "v4 PoolManager",
       "0x7c5f5a4bbd8fd63184577525326123b519429bdc": "v4 PositionManager",
       "0x6ff5693b99212da76ad316178a184ab56d299b43": "Universal Router",
       "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24": "Uniswap V2 Router",
       "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap V3 SwapRouter02",
       "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43": "Aerodrome Router",
       "0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12": "Doppler Airlock"}
TRANSFER_T0 = "0x" + Web3.keccak(text="Transfer(address,address,uint256)").hex().replace("0x", "")
INIT_T0 = "0x" + Web3.keccak(text="Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)").hex().replace("0x", "")
SEL = {"getPair": "0xe6a43905", "getPool3": "0x1698ee82", "getPoolAero": "0x79bc57d5",
       "getReserves": "0x0902f1ac", "token0": "0x0dfe1681", "balanceOf": "0x70a08231", "extsload": "0x1e2eaeaf"}


def now():
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def h0x(h):
    h = h.hex() if hasattr(h, "hex") else h
    return h if h.startswith("0x") else "0x" + h


def pad(x):
    return x[2:].lower().rjust(64, "0") if isinstance(x, str) else hex(x)[2:].rjust(64, "0")


def call(w3, to, data):
    return w3.eth.call({"to": Web3.to_checksum_address(to), "data": data})


def addr_of(raw):
    return Web3.to_checksum_address("0x" + raw.hex()[-40:]) if len(raw) >= 20 else ZERO


def v2_style_eth(w3, pool, reserves_sel):
    r = call(w3, pool, reserves_sel)
    r0, r1 = int.from_bytes(r[:32], "big"), int.from_bytes(r[32:64], "big")
    t0 = addr_of(call(w3, pool, SEL["token0"]))
    return r1 if t0 == LAPTOP else r0


def check_classic(w3):
    """Returns list of (venue, pool, eth_wei)."""
    found = []
    p = addr_of(call(w3, UNI_V2_FACTORY, SEL["getPair"] + pad(LAPTOP) + pad(WETH)))
    if p != ZERO:
        found.append(("Uniswap V2", p, v2_style_eth(w3, p, SEL["getReserves"])))
    for fee in V3_FEES:
        p = addr_of(call(w3, UNI_V3_FACTORY, SEL["getPool3"] + pad(LAPTOP) + pad(WETH) + pad(fee)))
        if p != ZERO:
            bal = int.from_bytes(call(w3, WETH, SEL["balanceOf"] + pad(p)), "big")
            found.append((f"Uniswap V3 {fee/1e6:.2%}", p, bal))
    for stable in (0, 1):
        p = addr_of(call(w3, AERO_FACTORY, SEL["getPoolAero"] + pad(LAPTOP) + pad(WETH) + pad(stable)))
        if p != ZERO:
            found.append((f"Aerodrome {'stable' if stable else 'volatile'}", p, v2_style_eth(w3, p, SEL["getReserves"])))
    return found


def v4_liquidity(w3, pool_id):
    base = int.from_bytes(Web3.keccak(bytes.fromhex(pool_id[2:]) + (6).to_bytes(32, "big")), "big")
    return int.from_bytes(call(w3, POOL_MANAGER, SEL["extsload"] + (base + 3).to_bytes(32, "big").hex()), "big")


def symbol(w3, token):
    if int(token, 16) == 0:
        return "ETH"
    try:
        return decode(["string"], call(w3, token, "0x95d89b41"))[0]
    except Exception:  # noqa: BLE001
        return token[:10]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", default=os.environ.get("BASE_RPC", "https://base-rpc.publicnode.com"))
    ap.add_argument("--interval", type=float, default=10)
    ap.add_argument("--min-liq-eth", type=float, default=1.0)
    ap.add_argument("--auto", action="store_true", help="run laptop_buy.py --send when a classic pool passes the floor")
    ap.add_argument("--eth", type=float, default=0.01)
    ap.add_argument("--from-block", type=int, help="start scanning transfers/initializes from this block (default: now)")
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()

    w3 = Web3(Web3.HTTPProvider(args.rpc, request_kwargs={"timeout": 60}))
    if w3.eth.chain_id != CHAIN_ID:
        sys.exit("RPC is not Base.")
    last = args.from_block or w3.eth.block_number
    pools_v4 = {}     # id -> (c0, c1, hooks, last_liq)
    seen_classic = set()
    fired = False
    pm_prev = -1
    print(f"[{now()}] watching LAPTOP from block {last}. Ctrl-C to stop.")

    while True:
        try:
            head = w3.eth.block_number
            # 1. classic pools
            for venue, pool, eth in check_classic(w3):
                key = (venue, pool)
                if key not in seen_classic:
                    seen_classic.add(key)
                    print(f"[{now()}] POOL {venue} {pool} ETH side {eth/1e18:.4f}")
                if eth >= w3.to_wei(args.min_liq_eth, "ether") and args.auto and not fired:
                    fired = True
                    print(f"[{now()}] *** {venue} passes floor. Launching laptop_buy.py --send ***")
                    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "laptop_buy.py"),
                                    "--eth", str(args.eth), "--rpc", args.rpc, "--min-liq-eth", str(args.min_liq_eth), "--send"],
                                   input="BUY\n", text=True)
            if head > last:
                # 2. new v4 pools
                for pos in (2, 3):   # currency0 or currency1 == LAPTOP
                    topics = [INIT_T0, None, None, None]
                    topics[pos] = "0x" + pad(LAPTOP)
                    for lg in w3.eth.get_logs({"address": POOL_MANAGER, "topics": topics, "fromBlock": last + 1, "toBlock": head}):
                        t = [h0x(x) for x in lg["topics"]]
                        data = bytes.fromhex(h0x(lg["data"])[2:])
                        fee, spacing, hooks, _, _ = decode(["uint24", "int24", "address", "uint160", "int24"], data)
                        pid = t[1]
                        c0, c1 = "0x" + t[2][-40:], "0x" + t[3][-40:]
                        pools_v4[pid] = (c0, c1, hooks, -1)
                        quote = c1 if c0.lower() == LAPTOP.lower() else c0
                        ok = "tradable quote" if quote.lower() in TRADABLE_QUOTES else "sidecar quote, not a LAPTOP buy"
                        print(f"[{now()}] NEW v4 POOL {pid}  {symbol(w3, c0)}/{symbol(w3, c1)}  fee {'dynamic' if fee == 0x800000 else fee}  hook {hooks}  [{ok}]")
                # 3. token flow
                for lg in w3.eth.get_logs({"address": LAPTOP, "topics": [TRANSFER_T0], "fromBlock": last + 1, "toBlock": head}):
                    t = [h0x(x) for x in lg["topics"]]
                    frm, to = "0x" + t[1][-40:], "0x" + t[2][-40:]
                    amt = int.from_bytes(bytes.fromhex(h0x(lg["data"])[2:]), "big") / 1e18
                    tag = DEX.get(to.lower())
                    flag = f"  <<< INTO {tag}" if tag else ""
                    print(f"[{now()}] TRANSFER block {lg['blockNumber']}  {frm} -> {to}  {amt:,.0f}{flag}")
                last = head
            # LAPTOP sitting in the PoolManager = deposited into some v4 pool
            pm_bal = int.from_bytes(call(w3, LAPTOP, SEL["balanceOf"] + pad(POOL_MANAGER)), "big")
            if pm_bal != pm_prev:
                if pm_prev != -1 or pm_bal > 0:
                    print(f"[{now()}] PoolManager LAPTOP balance: {pm_bal/1e18:,.0f}" + ("   <<< LAPTOP IS IN v4" if pm_bal > 0 else ""))
                pm_prev = pm_bal
            # v4 liquidity changes
            for pid, (c0, c1, hooks, prev) in list(pools_v4.items()):
                liq = v4_liquidity(w3, pid)
                if liq != prev:
                    pools_v4[pid] = (c0, c1, hooks, liq)
                    if prev != -1 or liq > 0:
                        print(f"[{now()}] v4 LIQUIDITY {pid[:18]}.. {symbol(w3, c0)}/{symbol(w3, c1)}: {liq}"
                              + ("   <<< LIVE. Trade via Universal Router." if liq > 0 else ""))
        except KeyboardInterrupt:
            return
        except Exception as e:  # noqa: BLE001
            print(f"[{now()}] rpc hiccup: {str(e)[:90]}")
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
