#!/usr/bin/env python3
"""
laptop_v4.py - buy LAPTOP (0xB095...ec29) from a Uniswap v4 pool on Base through the Universal Router.

Why this exists: the pre-initialized LAPTOP pools on Base are Uniswap v4 (no factory, no pair contract),
so laptop_buy.py's V2/V3/Aerodrome routes cannot hit them. This script takes a v4 pool key, encodes the
swap once, and either fires immediately or waits for that pool's liquidity to go live and fires then.

Pool key = (currency0, currency1, fee, tickSpacing, hooks), exactly as printed by laptop_scan.py.

Steps:
  1. PREP (once, before launch). For a USDC- or WETH-quoted pool the Universal Router pulls the input
     token through Permit2, so approve USDC -> Permit2 and Permit2 -> Universal Router now:
        python3 laptop_v4.py prep --quote USDC
     ETH-quoted pools (currency0 = 0x0) need no approvals; the swap sends ETH as msg.value.
  2. ARM. Encode the swap for the target pool and wait for liquidity, then fire:
        python3 laptop_v4.py arm --c0 0x8335... --c1 0xB095... --fee 250000 --spacing 200 --hooks 0x0 \
            --amount 25 --quote USDC --send
     Without --send it only prints the encoded calldata and the current liquidity.
  3. FIRE NOW (pool already live):  same as arm but add --now.

Key from LAPTOP_PK or a hidden prompt. Nothing is sent without --send.
"""
import argparse
import getpass
import os
import sys
import time

from web3 import Web3
from eth_abi import encode

CHAIN_ID = 8453
LAPTOP = Web3.to_checksum_address("0xB095274743941e953c746F9C228DA9c18Bb6ec29")
WETH = Web3.to_checksum_address("0x4200000000000000000000000000000000000006")
USDC = Web3.to_checksum_address("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
POOL_MANAGER = Web3.to_checksum_address("0x498581fF718922c3f8e6A244956aF099B2652b2b")
UNIVERSAL_ROUTER = Web3.to_checksum_address("0x6fF5693b99212Da76ad316178A184AB56D299b43")
PERMIT2 = Web3.to_checksum_address("0x000000000022D473030F116dDEE9F6B43aC78BA3")
ZERO = "0x0000000000000000000000000000000000000000"
# Universal Router command / v4 action ids
CMD_V4_SWAP = 0x10
A_SWAP_EXACT_IN_SINGLE, A_SETTLE_ALL, A_TAKE_ALL = 0x06, 0x0C, 0x0F
QUOTES = {"USDC": (USDC, 6), "WETH": (WETH, 18), "ETH": (ZERO, 18)}


def rpc(fn, *a, **kw):
    d = 0.3
    for i in range(6):
        try:
            return fn(*a, **kw)
        except Exception as e:  # noqa: BLE001
            if i == 5 or not any(k in str(e) for k in ("429", "Too Many", "imeout", "Connection", "502", "503")):
                raise
            time.sleep(d)
            d *= 2


def pool_id(c0, c1, fee, spacing, hooks):
    return Web3.keccak(encode(["address", "address", "uint24", "int24", "address"],
                              [c0, c1, fee, spacing, hooks]))


def v4_liquidity(w3, pid):
    base = int.from_bytes(Web3.keccak(pid + (6).to_bytes(32, "big")), "big")
    slot = (base + 3).to_bytes(32, "big")
    raw = rpc(w3.eth.call, {"to": POOL_MANAGER, "data": "0x1e2eaeaf" + slot.hex()})
    return int.from_bytes(raw, "big")


def encode_swap(c0, c1, fee, spacing, hooks, amount_in, min_out, deadline):
    """Universal Router execute(commands, inputs, deadline) for one v4 exact-input swap buying LAPTOP."""
    zero_for_one = c0.lower() != LAPTOP.lower()          # input is the non-LAPTOP side
    cur_in, cur_out = (c0, c1) if zero_for_one else (c1, c0)
    pool_key = (c0, c1, fee, spacing, hooks)
    swap_params = encode(["((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"],
                         [(pool_key, zero_for_one, amount_in, min_out, b"")])
    settle = encode(["address", "uint256"], [cur_in, amount_in])
    take = encode(["address", "uint256"], [cur_out, min_out])
    actions = bytes([A_SWAP_EXACT_IN_SINGLE, A_SETTLE_ALL, A_TAKE_ALL])
    v4_input = encode(["bytes", "bytes[]"], [actions, [swap_params, settle, take]])
    calldata = "0x3593564c" + encode(["bytes", "bytes[]", "uint256"],
                                     [bytes([CMD_V4_SWAP]), [v4_input], deadline]).hex()
    return calldata, cur_in


def send_tx(w3, acct, tx):
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
    h = w3.eth.send_raw_transaction(raw)
    hx = h.hex()
    return hx if hx.startswith("0x") else "0x" + hx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["prep", "arm"])
    ap.add_argument("--rpc", default=os.environ.get("BASE_RPC", "https://base-rpc.publicnode.com"))
    ap.add_argument("--quote", default="USDC", choices=list(QUOTES))
    ap.add_argument("--amount", type=float, default=25.0, help="input amount in quote units (USDC or ETH)")
    ap.add_argument("--min-out", type=float, default=0.0, help="minimum LAPTOP out (0 = take whatever)")
    ap.add_argument("--c0"); ap.add_argument("--c1"); ap.add_argument("--fee", type=int)
    ap.add_argument("--spacing", type=int); ap.add_argument("--hooks", default=ZERO)
    ap.add_argument("--interval", type=float, default=0.5, help="poll interval while armed (seconds)")
    ap.add_argument("--now", action="store_true", help="fire immediately instead of waiting for liquidity")
    ap.add_argument("--gas-gwei", type=float, default=0.05, help="priority fee to win the block on Base")
    ap.add_argument("--send", action="store_true")
    args = ap.parse_args()

    pk = os.environ.get("LAPTOP_PK") or getpass.getpass("Private key (hidden): ").strip()
    pk = pk if pk.startswith("0x") else "0x" + pk
    acct = Web3().eth.account.from_key(pk)
    me = acct.address
    w3 = Web3(Web3.HTTPProvider(args.rpc, request_kwargs={"timeout": 30}))
    if rpc(lambda: w3.eth.chain_id) != CHAIN_ID:
        sys.exit("RPC is not Base.")
    q_addr, q_dec = QUOTES[args.quote]
    amount_in = int(args.amount * 10 ** q_dec)
    print(f"wallet {me}  ETH {rpc(w3.eth.get_balance, me)/1e18:.5f}")

    def fees():
        base_fee = rpc(w3.eth.get_block, "latest")["baseFeePerGas"]
        prio = w3.to_wei(args.gas_gwei, "gwei")
        return {"maxPriorityFeePerGas": prio, "maxFeePerGas": base_fee * 2 + prio}

    # ---------------- prep: Permit2 approvals for ERC20 quotes ----------------
    if args.mode == "prep":
        if q_addr == ZERO:
            print("ETH quote needs no approvals."); return
        max_u = (1 << 256) - 1
        txs = [
            ("approve quote -> Permit2", q_addr,
             "0x095ea7b3" + PERMIT2[2:].lower().rjust(64, "0") + hex(max_u)[2:].rjust(64, "0"), 0),
            ("Permit2.approve(quote, UniversalRouter, max, far-future)", PERMIT2,
             "0x87517c45" + q_addr[2:].lower().rjust(64, "0") + UNIVERSAL_ROUTER[2:].lower().rjust(64, "0")
             + hex((1 << 160) - 1)[2:].rjust(64, "0") + hex((1 << 48) - 1)[2:].rjust(64, "0"), 0),
        ]
        nonce = rpc(w3.eth.get_transaction_count, me)
        for label, to, data, value in txs:
            tx = {"from": me, "to": to, "data": data, "value": value, "chainId": CHAIN_ID, "nonce": nonce, **fees()}
            tx["gas"] = int(rpc(w3.eth.estimate_gas, tx) * 1.3)
            print(f"{label}: gas {tx['gas']}")
            if args.send:
                print("  sent", send_tx(w3, acct, tx)); nonce += 1
        if not args.send:
            print("dry run; add --send to broadcast the two approvals.")
        else:
            print("approvals broadcast. Wait for confirmations before arming.")
        return

    # ---------------- arm / fire ----------------
    for f in ("c0", "c1", "fee", "spacing"):
        if getattr(args, f) is None:
            sys.exit(f"--{f} is required (copy the pool key from laptop_scan.py output)")
    for f in ("c0", "c1", "hooks"):
        v = getattr(args, f)
        if "…" in v or "..." in v or (len(v) != 42 and f != "hooks"):
            sys.exit(f"--{f} must be the full 42-character address, no ellipsis: got {v}")
    if len(args.hooks) < 42:
        args.hooks = ZERO
    c0, c1, hooks = (Web3.to_checksum_address(args.c0), Web3.to_checksum_address(args.c1),
                     Web3.to_checksum_address(args.hooks))
    if LAPTOP not in (c0, c1):
        sys.exit("pool key does not contain LAPTOP")
    quote_in_key = c1 if c0 == LAPTOP else c0
    if quote_in_key.lower() != q_addr.lower():
        sys.exit(f"--quote {args.quote} does not match the pool's other currency {quote_in_key}")
    pid = pool_id(c0, c1, args.fee, args.spacing, hooks)
    print(f"pool id {pid.hex()}  key ({c0}, {c1}, fee {args.fee}, spacing {args.spacing}, hooks {hooks})")
    min_out = int(args.min_out * 10 ** 18)
    deadline = int(time.time()) + 6 * 3600
    calldata, cur_in = encode_swap(c0, c1, args.fee, args.spacing, hooks, amount_in, min_out, deadline)
    value = amount_in if cur_in == ZERO else 0
    print(f"encoded: {len(calldata)//2} bytes, input {args.amount} {args.quote}, value {value/1e18} ETH")

    if not args.now:
        print(f"armed: polling liquidity every {args.interval}s ...")
        while True:
            liq = v4_liquidity(w3, pid)
            if liq > 0:
                print(f"liquidity live: {liq}")
                break
            time.sleep(args.interval)

    nonce = rpc(w3.eth.get_transaction_count, me)
    tx = {"from": me, "to": UNIVERSAL_ROUTER, "data": calldata, "value": value, "chainId": CHAIN_ID,
          "nonce": nonce, "gas": 600_000, **fees()}
    try:
        rpc(w3.eth.call, {k: tx[k] for k in ("from", "to", "data", "value")})
        tx["gas"] = int(rpc(w3.eth.estimate_gas, {k: tx[k] for k in ("from", "to", "data", "value")}) * 1.3)
        print(f"simulation OK, gas {tx['gas']}")
    except Exception as e:  # noqa: BLE001
        print(f"simulation reverted: {str(e)[:160]}")
        if not args.send:
            return
        print("sending anyway with fixed gas 600000 (armed mode: the pool changed this block)")
    if not args.send:
        print("dry run. add --send to broadcast."); return
    print("sent", send_tx(w3, acct, tx))


if __name__ == "__main__":
    main()
