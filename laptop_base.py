#!/usr/bin/env python3
"""
laptop_base.py - one source of truth for Base constants, selectors and read discipline.

Why this file exists: the same addresses, fee tiers and quote assets were duplicated across
laptop_scan.py, laptop_watch.py and laptop_buy.py, and they drifted. laptop_buy.py was probing
four V3 fee tiers on a chain that has seven, and both buy and watch checked only WETH-quoted
pairs while the only observed LAPTOP pools are USDC-quoted. Both produce a confident
"no liquidity anywhere" while a pool is filling. Constants live here now.

Every read returns a Result, never a bare value:
    ("found", x)  the contract answered with a value
    ("none",  None) the contract answered "there is nothing here"
    ("unknown", reason) we could not tell - a revert, an empty return, a rate limit

The distinction between "none" and "unknown" is the whole point. 32 zero bytes means the
contract answered. A bare 0x, a short return or an exception means we do not know, and code
that treats those the same turns an unreachable endpoint into a confident negative.
"""
from __future__ import annotations

CHAIN_ID = 8453

# ---------- addresses (lowercase; use cs() when a checksummed form is needed) ----------
LAPTOP        = "0xb095274743941e953c746f9c228da9c18bb6ec29"
POOL_MANAGER  = "0x498581ff718922c3f8e6a244956af099b2652b2b"   # Uniswap v4
UNI_V2_FACTORY = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6"
UNI_V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd"
AERO_FACTORY   = "0x420dd381b31aef6683db6b902084cb0ffece40da"   # Aerodrome v2-style
AERO_REGISTRY  = "0x5c3f18f06cc09ca1910767a34a20f771039e37c0"   # FactoryRegistry
WETH  = "0x4200000000000000000000000000000000000006"
USDC  = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"            # native, Circle-issued
USDBC = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"            # bridged - a DIFFERENT token
ZERO  = "0x" + "0" * 40

# Quote assets to probe. USDbC is here because it is a real tradable Base asset and omitting
# it flags a USDbC-quoted pool as an untradable sidecar. Never render a bare "USDC" for USDbC.
QUOTES = (("WETH", WETH), ("USDC", USDC), ("USDbC", USDBC))
TRADABLE_QUOTES = {ZERO, WETH, USDC, USDBC}

# Base uniquely enables 200/300/400 on top of the usual four. Uniswap's own frontend gates
# exactly those three behind supportedChainIds:[Base]. Probing only four tiers and printing
# "no V3 pool" is an unearned negative on the three never queried.
V3_FEES = (100, 200, 300, 400, 500, 3000, 10000)
V3_TICK_SPACINGS = {100: 1, 200: 4, 300: 6, 400: 8, 500: 10, 3000: 60, 10000: 200}
# Aerodrome Slipstream (concentrated liquidity) - a second AMM invisible to AERO_FACTORY.
CL_TICK_SPACINGS = (1, 50, 100, 200, 2000)

# ---------- selectors (each computed from its signature, not recalled) ----------
SEL = {
    "getPair":      "0xe6a43905",  # getPair(address,address)              Uniswap V2 only
    "getPoolV3":    "0x1698ee82",  # getPool(address,address,uint24)       V3 *and* Aerodrome
    "getPoolAero":  "0x79bc57d5",  # getPool(address,address,bool)         Aerodrome v2-style
    "getPoolCL":    "0x28af8d0b",  # getPool(address,address,int24)        Slipstream
    "feeTick":      "0x22afcccb",  # feeAmountTickSpacing(uint24)
    "poolFactories": "0x06121cd5", # poolFactories()
    "extsload":     "0x1e2eaeaf",  # extsload(bytes32)
    "extsloadN":    "0x35fd631a",  # extsload(bytes32,uint256)  - n slots in one call
    "getReserves":  "0x0902f1ac",
    "token0":       "0x0dfe1681",
    "token1":       "0xd21220a7",
    "balanceOf":    "0x70a08231",
    "symbol":       "0x95d89b41",
    "decimals":     "0x313ce567",
    "totalSupply":  "0x18160ddd",
}

POOLS_SLOT = 6          # PoolManager: mapping(PoolId => Pool.State) _pools
SLOT0_OFFSET = 0        # Pool.State.slot0     - sqrtPriceX96 in the low 160 bits
LIQUIDITY_OFFSET = 3    # Pool.State.liquidity - ACTIVE (in-range) liquidity only
LIQ_MASK = (1 << 128) - 1


def cs(a: str) -> str:
    """Checksum an address without pulling in web3 at import time."""
    from web3 import Web3
    return Web3.to_checksum_address(a)


def pad_addr(a: str) -> str:
    return a.lower().replace("0x", "").rjust(64, "0")


def pad_uint(n: int) -> str:
    return format(n, "x").rjust(64, "0")


def pad_int(n: int) -> str:
    """Two's-complement 32-byte word, for int24 tickSpacing."""
    return format(n & ((1 << 256) - 1), "x").rjust(64, "0")


# ---------------------------------------------------------------- read discipline

def _as_bytes(raw) -> bytes:
    if raw is None:
        return b""
    if isinstance(raw, bytes):
        return raw
    if isinstance(raw, str):
        h = raw[2:] if raw.startswith("0x") else raw
        return bytes.fromhex(h) if h else b""
    return bytes(raw)


def read_address(call, to: str, data: str):
    """One factory lookup. Returns ("found", addr) | ("none", None) | ("unknown", reason).

    Aerodrome has no getPair of any arity and no fallback, so calling getPair there REVERTS
    rather than returning the zero address. A revert is "unknown", never "none".
    """
    try:
        raw = _as_bytes(call(to, data))
    except Exception as e:  # noqa: BLE001
        return ("unknown", f"{type(e).__name__}: {str(e)[:80]}")
    if len(raw) == 0:
        return ("unknown", "empty return (no code at target, or reverted)")
    if len(raw) < 32:
        return ("unknown", f"short return ({len(raw)} bytes)")
    word = raw[:32]
    if int.from_bytes(word, "big") == 0:
        return ("none", None)
    return ("found", "0x" + word[-20:].hex())


def read_uint(call, to: str, data: str):
    try:
        raw = _as_bytes(call(to, data))
    except Exception as e:  # noqa: BLE001
        return ("unknown", f"{type(e).__name__}: {str(e)[:80]}")
    if len(raw) < 32:
        return ("unknown", "empty or short return")
    return ("found", int.from_bytes(raw[:32], "big"))


def read_text(call, to: str, data: str):
    """name()/symbol() that may return a string OR a bytes32. Both are in the wild."""
    try:
        raw = _as_bytes(call(to, data))
    except Exception as e:  # noqa: BLE001
        return ("unknown", f"{type(e).__name__}: {str(e)[:80]}")
    if len(raw) == 0:
        return ("unknown", "empty return")
    if len(raw) == 32:
        s = raw.rstrip(b"\x00").decode("utf-8", "replace")
        return ("found", s) if s.isprintable() else ("unknown", "undecodable bytes32")
    try:
        off = int.from_bytes(raw[0:32], "big")
        # Bounds-check before slicing. Python slices past the end silently, so an absurd
        # offset would otherwise decode to "" and be reported as a successfully-read
        # empty name - a guess dressed up as an answer.
        if off + 32 > len(raw):
            return ("unknown", "string offset past end of return data")
        ln = int.from_bytes(raw[off:off + 32], "big")
        if ln > 4096:
            return ("unknown", "implausible string length")
        if off + 32 + ln > len(raw):
            return ("unknown", "truncated string")
        return ("found", raw[off + 32:off + 32 + ln].decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return ("unknown", "undecodable string")


# ---------------------------------------------------------------- venue lookups

def v3_tier_enabled(call, fee: int, factory: str = UNI_V3_FACTORY):
    """getPool returns address(0) both when a pool is absent AND when the tier was never
    enabled. Only feeAmountTickSpacing can tell those apart."""
    return read_uint(call, factory, SEL["feeTick"] + pad_uint(fee))


def find_v2_pair(call, token: str, quote: str):
    return read_address(call, UNI_V2_FACTORY,
                        SEL["getPair"] + pad_addr(token) + pad_addr(quote))


def find_v3_pool(call, token: str, quote: str, fee: int):
    # Aerodrome's PoolFactory exposes getPool(address,address,uint24) with the SAME selector
    # as Uniswap V3 and returns address(0) for any fee > 1. Aiming this at the wrong factory
    # yields a silent false negative, so the target is pinned here.
    return read_address(call, UNI_V3_FACTORY,
                        SEL["getPoolV3"] + pad_addr(token) + pad_addr(quote) + pad_uint(fee))


def find_aero_pool(call, token: str, quote: str, stable: bool):
    return read_address(call, AERO_FACTORY,
                        SEL["getPoolAero"] + pad_addr(token) + pad_addr(quote) + pad_uint(1 if stable else 0))


def find_cl_pool(call, factory: str, token: str, quote: str, spacing: int):
    return read_address(call, factory,
                        SEL["getPoolCL"] + pad_addr(token) + pad_addr(quote) + pad_int(spacing))


def aero_factories(call):
    """FactoryRegistry.poolFactories() - the authoritative live set, self-updating if
    Aerodrome deploys another factory. Beats hardcoding a Slipstream address we cannot verify."""
    try:
        raw = _as_bytes(call(AERO_REGISTRY, SEL["poolFactories"]))
    except Exception as e:  # noqa: BLE001
        return ("unknown", f"{type(e).__name__}: {str(e)[:80]}")
    if len(raw) < 64:
        return ("unknown", "empty or short return")
    try:
        off = int.from_bytes(raw[0:32], "big")
        n = int.from_bytes(raw[off:off + 32], "big")
        if n > 64:
            return ("unknown", "implausible array length")
        out = []
        for i in range(n):
            w = raw[off + 32 + i * 32: off + 64 + i * 32]
            if len(w) < 32:
                return ("unknown", "truncated array")
            out.append("0x" + w[-20:].hex())
        return ("found", out)
    except Exception:  # noqa: BLE001
        return ("unknown", "undecodable array")


# ---------------------------------------------------------------- v4 pool state

def pool_id(c0: str, c1: str, fee: int, spacing: int, hooks: str) -> str:
    from web3 import Web3
    enc = bytes.fromhex(pad_addr(c0) + pad_addr(c1) + pad_uint(fee) + pad_int(spacing) + pad_addr(hooks))
    return "0x" + Web3.keccak(enc).hex().replace("0x", "")


def pool_state_slot(pid: str) -> int:
    from web3 import Web3
    pid_b = bytes.fromhex(pid[2:] if pid.startswith("0x") else pid)
    return int.from_bytes(Web3.keccak(pid_b + POOLS_SLOT.to_bytes(32, "big")), "big")


def v4_pool_state(call, pid: str):
    """Three-way answer, which one slot cannot give you.

    Reading an unwritten slot returns 32 zero bytes with no error, so liquidity == 0 cannot
    distinguish "this pool key was never created" from "created but empty". v4's own
    initialization sentinel is slot0.sqrtPriceX96: Pool.initialize reverts if it is non-zero
    and checkPoolInitialized reverts if it is zero.

        absent  slot0 == 0                     - no pool has ever existed at this key
        empty   slot0 != 0 and liquidity == 0  - price is set, nothing tradable
        active  both non-zero                  - in-range liquidity exists

    Note "active" is in-range liquidity only. A pool holding real deposits entirely out of
    range reads zero, so "empty" means "nothing tradable at the current price", not "no tokens".
    """
    base = pool_state_slot(pid)
    # One batched read for 4 consecutive slots instead of two single reads.
    try:
        raw = _as_bytes(call(POOL_MANAGER,
                             SEL["extsloadN"] + pad_uint(base) + pad_uint(4)))
        if len(raw) >= 64 + 4 * 32:
            words = [raw[64 + i * 32: 96 + i * 32] for i in range(4)]
            slot0 = int.from_bytes(words[SLOT0_OFFSET], "big")
            liq = _liquidity_from_word(int.from_bytes(words[LIQUIDITY_OFFSET], "big"))
            if liq is None:
                return ("unknown", {"why": "liquidity slot has unexpected high bits - "
                                           "this is not the slot we think it is"})
            return _classify(slot0, liq)
    except Exception:  # noqa: BLE001
        pass  # fall through to single-slot reads
    s0 = read_uint(call, POOL_MANAGER, SEL["extsload"] + pad_uint(base + SLOT0_OFFSET))
    if s0[0] != "found":
        return ("unknown", {"why": s0[1]})
    lq = read_uint(call, POOL_MANAGER, SEL["extsload"] + pad_uint(base + LIQUIDITY_OFFSET))
    if lq[0] != "found":
        return ("unknown", {"why": lq[1]})
    liq = _liquidity_from_word(lq[1])
    if liq is None:
        return ("unknown", {"why": "liquidity slot has unexpected high bits - "
                                   "this is not the slot we think it is"})
    return _classify(s0[1], liq)


def _liquidity_from_word(word: int):
    """Pool.State.liquidity is a uint128 sitting alone in its slot - the member after it is a
    mapping, which always starts a fresh slot, so the high 128 bits are structurally zero.
    v4's own StateLibrary truncates with uint128(uint256(...)). If the high half is NOT zero
    we are not reading the slot we think we are, and reporting the whole 256-bit word as a
    liquidity figure would be nonsense dressed as data. Returns None in that case."""
    if word >> 128:
        return None
    return word & LIQ_MASK


def _classify(slot0: int, liquidity: int):
    sqrt_price = slot0 & ((1 << 160) - 1)
    info = {"slot0": slot0, "sqrtPriceX96": sqrt_price, "liquidity": liquidity}
    if sqrt_price == 0:
        return ("absent", info)
    if liquidity == 0:
        return ("empty", info)
    return ("active", info)


def quote_label(addr: str) -> str:
    a = (addr or "").lower()
    return {WETH: "WETH", USDC: "USDC", USDBC: "USDbC", ZERO: "ETH"}.get(a, a)


def is_tradable_quote(addr: str) -> bool:
    return (addr or "").lower() in TRADABLE_QUOTES
