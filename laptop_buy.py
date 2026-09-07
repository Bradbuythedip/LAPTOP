#!/usr/bin/env python3
"""
laptop_buy.py - LAPTOP (0xB095...ec29) on Base: find liquidity, quote, simulate, buy.

Default is a DRY RUN. Nothing is broadcast unless you pass --send and type BUY.

Install:   pip install web3 requests
Key:       export LAPTOP_PK=0xYOURPRIVATEKEY   (or leave unset and you will be prompted, hidden)
Dry run:   python laptop_buy.py --eth 0.01
Send:      python laptop_buy.py --eth 0.01 --send

What it does, in order:
  1. Connects to Base (chain 8453) and sanity-checks the token contract.
  2. Looks for a LAPTOP/WETH pool on Uniswap V2, Uniswap V3 (all fee tiers) and Aerodrome.
     Also asks the DEX Screener API, which covers Uniswap v4 pools the factories cannot see.
  3. For every pool found: reads ETH-side liquidity and quotes your buy.
  4. Picks the best quote, builds the swap, and simulates it with eth_call and eth_estimateGas.
  5. Refuses pools with less than --min-liq-eth of ETH (default 1.0) unless --force.
  6. With --send: signs with your key and broadcasts. Prints the Basescan link.

Verify the router/factory addresses below on basescan.org before you sign anything.
"""
import argparse
import getpass
import os
import sys
import time

from web3 import Web3

import laptop_base as LB

# ---------- constants (Base mainnet) ----------
CHAIN_ID = 8453
LAPTOP = Web3.to_checksum_address("0xB095274743941e953c746F9C228DA9c18Bb6ec29")
WETH = Web3.to_checksum_address("0x4200000000000000000000000000000000000006")

UNI_V2_FACTORY = Web3.to_checksum_address("0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6")
UNI_V2_ROUTER = Web3.to_checksum_address("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24")
UNI_V3_FACTORY = Web3.to_checksum_address("0x33128a8fC17869897dcE68Ed026d694621f6FDfD")
UNI_V3_ROUTER02 = Web3.to_checksum_address("0x2626664c2603336E57B271c5C0b26F421741e481")
UNI_V3_QUOTER2 = Web3.to_checksum_address("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a")
AERO_FACTORY = Web3.to_checksum_address("0x420DD381b31aEf6683db6B902084cB0FFECe40Da")
AERO_ROUTER = Web3.to_checksum_address("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43")
# Fee tiers and quote assets come from laptop_base so they cannot drift again. Base uniquely
# enables the 200/300/400 tiers; probing only four of seven printed "no V3 pool" without
# having looked at three of them.
V3_FEES = LB.V3_FEES
ZERO = "0x0000000000000000000000000000000000000000"

# ---------- minimal ABIs ----------
ERC20_ABI = [
    {"name": "name", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{"type": "string"}]},
    {"name": "symbol", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{"type": "string"}]},
    {"name": "decimals", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint8"}]},
    {"name": "totalSupply", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint256"}]},
    {"name": "balanceOf", "type": "function", "stateMutability": "view", "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]},
]
V2_FACTORY_ABI = [{"name": "getPair", "type": "function", "stateMutability": "view",
                   "inputs": [{"type": "address"}, {"type": "address"}], "outputs": [{"type": "address"}]}]
V2_PAIR_ABI = [
    {"name": "getReserves", "type": "function", "stateMutability": "view", "inputs": [],
     "outputs": [{"type": "uint112"}, {"type": "uint112"}, {"type": "uint32"}]},
    {"name": "token0", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{"type": "address"}]},
]
V2_ROUTER_ABI = [
    {"name": "getAmountsOut", "type": "function", "stateMutability": "view",
     "inputs": [{"type": "uint256"}, {"type": "address[]"}], "outputs": [{"type": "uint256[]"}]},
    {"name": "swapExactETHForTokensSupportingFeeOnTransferTokens", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "amountOutMin", "type": "uint256"}, {"name": "path", "type": "address[]"},
                {"name": "to", "type": "address"}, {"name": "deadline", "type": "uint256"}], "outputs": []},
]
V3_FACTORY_ABI = [{"name": "getPool", "type": "function", "stateMutability": "view",
                   "inputs": [{"type": "address"}, {"type": "address"}, {"type": "uint24"}], "outputs": [{"type": "address"}]}]
V3_POOL_ABI = [
    {"name": "liquidity", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint128"}]},
]
V3_QUOTER2_ABI = [{"name": "quoteExactInputSingle", "type": "function", "stateMutability": "nonpayable",
                   "inputs": [{"name": "params", "type": "tuple", "components": [
                       {"name": "tokenIn", "type": "address"}, {"name": "tokenOut", "type": "address"},
                       {"name": "amountIn", "type": "uint256"}, {"name": "fee", "type": "uint24"},
                       {"name": "sqrtPriceLimitX96", "type": "uint160"}]}],
                   "outputs": [{"type": "uint256"}, {"type": "uint160"}, {"type": "uint32"}, {"type": "uint256"}]}]
V3_ROUTER02_ABI = [{"name": "exactInputSingle", "type": "function", "stateMutability": "payable",
                    "inputs": [{"name": "params", "type": "tuple", "components": [
                        {"name": "tokenIn", "type": "address"}, {"name": "tokenOut", "type": "address"},
                        {"name": "fee", "type": "uint24"}, {"name": "recipient", "type": "address"},
                        {"name": "amountIn", "type": "uint256"}, {"name": "amountOutMinimum", "type": "uint256"},
                        {"name": "sqrtPriceLimitX96", "type": "uint160"}]}],
                    "outputs": [{"type": "uint256"}]}]
AERO_FACTORY_ABI = [{"name": "getPool", "type": "function", "stateMutability": "view",
                     "inputs": [{"type": "address"}, {"type": "address"}, {"type": "bool"}], "outputs": [{"type": "address"}]}]
AERO_POOL_ABI = [
    {"name": "getReserves", "type": "function", "stateMutability": "view", "inputs": [],
     "outputs": [{"type": "uint256"}, {"type": "uint256"}, {"type": "uint256"}]},
    {"name": "token0", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{"type": "address"}]},
]
AERO_ROUTE = {"name": "routes", "type": "tuple[]", "components": [
    {"name": "from", "type": "address"}, {"name": "to", "type": "address"},
    {"name": "stable", "type": "bool"}, {"name": "factory", "type": "address"}]}
AERO_ROUTER_ABI = [
    {"name": "getAmountsOut", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "amountIn", "type": "uint256"}, AERO_ROUTE], "outputs": [{"type": "uint256[]"}]},
    {"name": "swapExactETHForTokens", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "amountOutMin", "type": "uint256"}, AERO_ROUTE,
                {"name": "to", "type": "address"}, {"name": "deadline", "type": "uint256"}],
     "outputs": [{"type": "uint256[]"}]},
]


def rpc(fn, *a, **kw):
    """Call fn with retries on 429 / transient RPC errors (public endpoints rate-limit hard)."""
    delay = 0.5
    for attempt in range(8):
        try:
            return fn(*a, **kw)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            transient = ("429" in msg or "Too Many" in msg or "timeout" in msg.lower()
                         or "Connection" in msg or "502" in msg or "503" in msg)
            if not transient or attempt == 7:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 8)


def die(msg, code=2):
    print(f"\nSTOP: {msg}")
    sys.exit(code)


def fmt_eth(wei):
    return f"{wei / 1e18:.6f} ETH"


def fmt_tok(raw, dec):
    return f"{raw / 10 ** dec:,.2f}"


def dexscreener_pools(token):
    """Best effort. Covers Uniswap v4 and anything else the factories can't see."""
    try:
        import requests
        r = requests.get(f"https://api.dexscreener.com/latest/dex/tokens/{token}", timeout=8)
        pairs = (r.json() or {}).get("pairs") or []
        return [p for p in pairs if p.get("chainId") == "base"]
    except Exception as e:  # noqa: BLE001
        print(f"  DEX Screener check skipped ({type(e).__name__}).")
        return []


def _reader(w3):
    """Adapter so the shared read helpers in laptop_base can drive this script's RPC."""
    def call(to, data):
        return rpc(w3.eth.call, {"to": Web3.to_checksum_address(to), "data": data})
    return call


def survey_quotes(w3):
    """Every venue x every quote asset. Returns (rows, unknowns).

    This exists because checking only LAPTOP/WETH printed "no liquidity anywhere" while the
    only observed LAPTOP pools were USDC-quoted. A negative here is scoped to what was
    actually read: a cell we could not read is an unknown, never a "no".
    """
    call = _reader(w3)
    rows, unknowns = [], []

    def record(venue, qlabel, quote, res):
        state, val = res
        if state == "found":
            rows.append({"venue": venue, "quote": qlabel, "quote_addr": quote, "pool": val})
        elif state == "unknown":
            unknowns.append((venue, qlabel, val))

    for qlabel, quote in LB.QUOTES:
        record("Uniswap V2", qlabel, quote, LB.find_v2_pair(call, LB.LAPTOP, quote))

    # A V3 tier that was never enabled and a tier with no pool both return address(0).
    # feeAmountTickSpacing is the only thing that tells them apart, so ask once per tier.
    enabled = {}
    for fee in V3_FEES:
        st, v = LB.v3_tier_enabled(call, fee)
        enabled[fee] = (v if st == "found" else None)
        if st == "unknown":
            unknowns.append((f"Uniswap V3 {fee/1e6:.2%}", "-", "tier enablement: " + str(v)))
    for qlabel, quote in LB.QUOTES:
        for fee in V3_FEES:
            if enabled.get(fee) == 0:
                continue  # tier genuinely not enabled on Base; not a missed pool
            record(f"Uniswap V3 {fee/1e6:.2%}", qlabel, quote,
                   LB.find_v3_pool(call, LB.LAPTOP, quote, fee))

    for qlabel, quote in LB.QUOTES:
        for stable in (False, True):
            record(f"Aerodrome {'stable' if stable else 'volatile'}", qlabel, quote,
                   LB.find_aero_pool(call, LB.LAPTOP, quote, stable))

    # Aerodrome Slipstream is a second AMM whose pools are invisible to the v2 factory, and
    # its factory address could not be verified. Ask the registry instead of guessing.
    st, facs = LB.aero_factories(call)
    if st != "found":
        unknowns.append(("Aerodrome registry", "-", str(facs)))
    else:
        for fac in facs:
            if fac.lower() == LB.AERO_FACTORY:
                continue
            probed = False
            for qlabel, quote in LB.QUOTES:
                for spacing in LB.CL_TICK_SPACINGS:
                    r = LB.find_cl_pool(call, fac, LB.LAPTOP, quote, spacing)
                    if r[0] != "unknown":
                        probed = True
                    record(f"Aerodrome CL ts={spacing} @{fac[:10]}", qlabel, quote, r)
            if not probed:
                unknowns.append((f"factory {fac}", "-", "not readable with any known ABI"))
    return rows, unknowns


def find_pools(w3, amount_in, me):
    """Returns list of dicts: {venue, pool, eth_liq, out, router, build}

    Only WETH-quoted pools are returned as buyable: this script spends ETH, and routing
    through a USDC- or USDbC-quoted pool needs approvals and a multi-hop path it does not
    build. Non-WETH pools are still reported, loudly, so a filling USDC pool is never
    invisible - it just is not something this script will trade for you.
    """
    rows, unknowns = survey_quotes(w3)
    cells = len(LB.QUOTES) * (1 + len(V3_FEES) + 2)
    print(f"  surveyed {cells}+ venue/quote combinations across "
          f"{', '.join(q for q, _ in LB.QUOTES)}")
    for venue, qlabel, why in unknowns:
        print(f"  COULD NOT CHECK  {venue} / {qlabel}: {why}")
    if unknowns:
        print("  ^ these are unknowns, not 'no pool'. Any statement below is scoped to what was read.")

    non_weth = [r for r in rows if r["quote_addr"].lower() != WETH.lower()]
    for r in non_weth:
        print(f"  FOUND (not buyable here)  {r['venue']}  {r['quote']}-quoted  {r['pool']}")
    if non_weth:
        print("  ^ this script spends ETH and does not build multi-hop routes. Use a UI or "
              "laptop_v4.py for these.")

    found = []
    for r in rows:
        if r["quote_addr"].lower() != WETH.lower():
            continue
        venue, pool = r["venue"], Web3.to_checksum_address(r["pool"])
        try:
            if venue.startswith("Uniswap V2"):
                p = w3.eth.contract(pool, abi=V2_PAIR_ABI)
                r0, r1, _ = rpc(p.functions.getReserves().call)
                t0 = rpc(p.functions.token0().call)
                eth_liq = r1 if Web3.to_checksum_address(t0) == LAPTOP else r0
                router = w3.eth.contract(UNI_V2_ROUTER, abi=V2_ROUTER_ABI)
                out = rpc(router.functions.getAmountsOut(amount_in, [WETH, LAPTOP]).call)[-1]

                def build(min_out, deadline, _r=router):
                    return _r.functions.swapExactETHForTokensSupportingFeeOnTransferTokens(
                        min_out, [WETH, LAPTOP], me, deadline)
                found.append({"venue": venue, "pool": pool, "eth_liq": eth_liq, "out": out,
                              "router": UNI_V2_ROUTER, "build": build})

            elif venue.startswith("Uniswap V3"):
                fee = int(round(float(venue.split()[-1].rstrip('%')) * 10000))
                weth = w3.eth.contract(WETH, abi=ERC20_ABI)
                eth_liq = rpc(weth.functions.balanceOf(pool).call)
                q = w3.eth.contract(UNI_V3_QUOTER2, abi=V3_QUOTER2_ABI)
                out = rpc(q.functions.quoteExactInputSingle((WETH, LAPTOP, amount_in, fee, 0)).call)[0]
                router = w3.eth.contract(UNI_V3_ROUTER02, abi=V3_ROUTER02_ABI)

                def build(min_out, deadline, _r=router, _fee=fee):
                    return _r.functions.exactInputSingle((WETH, LAPTOP, _fee, me, amount_in, min_out, 0))
                found.append({"venue": venue, "pool": pool, "eth_liq": eth_liq, "out": out,
                              "router": UNI_V3_ROUTER02, "build": build})

            elif venue.startswith("Aerodrome ") and "CL" not in venue:
                stable = venue.endswith("stable")
                p = w3.eth.contract(pool, abi=AERO_POOL_ABI)
                r0, r1, _ = rpc(p.functions.getReserves().call)
                t0 = rpc(p.functions.token0().call)
                eth_liq = r1 if Web3.to_checksum_address(t0) == LAPTOP else r0
                router = w3.eth.contract(AERO_ROUTER, abi=AERO_ROUTER_ABI)
                route = [(WETH, LAPTOP, stable, AERO_FACTORY)]
                out = rpc(router.functions.getAmountsOut(amount_in, route).call)[-1]

                def build(min_out, deadline, _r=router, _route=route):
                    return _r.functions.swapExactETHForTokens(min_out, _route, me, deadline)
                found.append({"venue": venue, "pool": pool, "eth_liq": eth_liq, "out": out,
                              "router": AERO_ROUTER, "build": build})
            else:
                print(f"  FOUND (no route built)  {venue}  {pool}")
        except Exception as e:  # noqa: BLE001
            print(f"  {venue}: pool {pool} found but could not be quoted ({str(e)[:70]})")
    return found


def main():
    ap = argparse.ArgumentParser(description="LAPTOP on Base: find liquidity, simulate, buy (dry run by default).")
    ap.add_argument("--eth", type=float, default=0.01, help="ETH to spend (default 0.01)")
    ap.add_argument("--rpc", default=os.environ.get("BASE_RPC", "https://base-rpc.publicnode.com"),
                    help="Base RPC (alternates: https://base.llamarpc.com, https://1rpc.io/base, https://base.drpc.org)")
    ap.add_argument("--slippage-bps", type=int, default=300, help="max slippage in bps (default 300 = 3%%)")
    ap.add_argument("--min-liq-eth", type=float, default=1.0, help="refuse pools thinner than this (default 1.0 ETH)")
    ap.add_argument("--force", action="store_true", help="ignore the liquidity floor")
    ap.add_argument("--send", action="store_true", help="broadcast the transaction (otherwise dry run)")
    args = ap.parse_args()

    # ---- key ----
    pk = os.environ.get("LAPTOP_PK") or getpass.getpass("Private key (hidden, never stored): ").strip()
    if not pk.startswith("0x"):
        pk = "0x" + pk
    acct = Web3().eth.account.from_key(pk)
    me = acct.address

    # ---- connect ----
    w3 = Web3(Web3.HTTPProvider(args.rpc, request_kwargs={"timeout": 30}))
    cid = rpc(lambda: w3.eth.chain_id)
    if cid != CHAIN_ID:
        die(f"RPC is chain {cid}, not Base ({CHAIN_ID}).")
    amount_in = w3.to_wei(args.eth, "ether")
    bal = rpc(w3.eth.get_balance, me)
    print(f"\nWallet {me}  balance {fmt_eth(bal)}  spending {fmt_eth(amount_in)}")
    if bal < amount_in and args.send:
        die("Wallet balance is below the buy amount.")

    # ---- token sanity ----
    if rpc(w3.eth.get_code, LAPTOP) in (b"", b"\x00"):
        die("No contract code at the LAPTOP address on this RPC.")
    tok = w3.eth.contract(LAPTOP, abi=ERC20_ABI)
    name, sym, dec, supply = (rpc(tok.functions.name().call), rpc(tok.functions.symbol().call),
                              rpc(tok.functions.decimals().call), rpc(tok.functions.totalSupply().call))
    print(f"Token  {name} ({sym})  decimals {dec}  totalSupply {fmt_tok(supply, dec)}")
    if sym != "LAPTOP" or supply != 10 ** 9 * 10 ** dec:
        print("  WARNING: symbol or supply does not match the announced 1,000,000,000 LAPTOP.")

    # ---- pools ----
    print("\nLooking for LAPTOP/WETH pools on Base:")
    pools = find_pools(w3, amount_in, me)
    ds = dexscreener_pools(LAPTOP)
    for p in ds:
        print(f"  DEX Screener: {p.get('dexId')} {p.get('pairAddress')}  liq ${(p.get('liquidity') or {}).get('usd')}")
    if not pools:
        if ds:
            die("Factories show no V2/V3/Aerodrome pool, but DEX Screener lists pairs above (likely Uniswap v4). "
                "This script does not route v4. Nothing bought.")
        die("No LAPTOP/WETH pool on Uniswap V2, Uniswap V3 or Aerodrome, and DEX Screener shows none. "
            "There is nothing to buy before launch. Nothing sent.")

    # ---- pick best quote among pools deep enough ----
    floor = w3.to_wei(args.min_liq_eth, "ether")
    print("\nQuotes:")
    for p in sorted(pools, key=lambda p: p["out"], reverse=True):
        flag = "" if (p["eth_liq"] >= floor or args.force) else "   <- below liquidity floor, skipped"
        print(f"  {p['venue']:<20} pool {p['pool']}  ETH in pool {fmt_eth(p['eth_liq'])}  "
              f"you get {fmt_tok(p['out'], dec)} {sym}{flag}")
    eligible = [p for p in pools if p["eth_liq"] >= floor or args.force]
    if not eligible:
        thin = max(pools, key=lambda p: p["eth_liq"])
        die(f"Deepest pool holds only {fmt_eth(thin['eth_liq'])} (floor {args.min_liq_eth} ETH). "
            f"That is a trap, not a market. Re-run with --force if you accept it.")
    best = max(eligible, key=lambda p: p["out"])
    impact = amount_in / (best["eth_liq"] + amount_in) if best["eth_liq"] else 1.0
    price_eth = (amount_in / 1e18) / (best["out"] / 10 ** dec) if best["out"] else float("inf")
    print(f"\nBest: {best['venue']}  ->  {fmt_tok(best['out'], dec)} {sym} for {fmt_eth(amount_in)}"
          f"  (~{price_eth:.12f} ETH per token, ~{impact:.1%} of pool depth)")

    # ---- build + simulate ----
    min_out = best["out"] * (10000 - args.slippage_bps) // 10000
    deadline = int(time.time()) + 600
    fn = best["build"](min_out, deadline)
    tx = fn.build_transaction({"from": me, "value": amount_in, "chainId": CHAIN_ID,
                               "nonce": rpc(w3.eth.get_transaction_count, me),
                               "gasPrice": rpc(lambda: w3.eth.gas_price), "gas": 0})
    tx.pop("gas", None)
    try:
        rpc(w3.eth.call, {k: v for k, v in tx.items() if k in ("from", "to", "value", "data")})
        gas = rpc(w3.eth.estimate_gas, {k: v for k, v in tx.items() if k in ("from", "to", "value", "data")})
    except Exception as e:  # noqa: BLE001
        die(f"Simulation reverted: {e}")
    tx["gas"] = int(gas * 1.25)
    print(f"\nSimulation OK.  min out {fmt_tok(min_out, dec)} {sym}  gas {gas}  "
          f"fee ~{fmt_eth(tx['gas'] * tx['gasPrice'])}")

    if not args.send:
        print("\nDRY RUN. Nothing sent. Add --send to broadcast.")
        return

    # ---- send ----
    if input("Type BUY to broadcast: ").strip() != "BUY":
        die("Not confirmed. Nothing sent.", 0)
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
    h = w3.eth.send_raw_transaction(raw)
    hx = h.hex()
    hx = hx if hx.startswith("0x") else "0x" + hx
    print(f"\nSent: https://basescan.org/tx/{hx}")
    rcpt = w3.eth.wait_for_transaction_receipt(h, timeout=180)
    print("Status:", "SUCCESS" if rcpt["status"] == 1 else "FAILED")
    print(f"LAPTOP balance now: {fmt_tok(rpc(tok.functions.balanceOf(me).call), dec)} {sym}")


if __name__ == "__main__":
    main()
