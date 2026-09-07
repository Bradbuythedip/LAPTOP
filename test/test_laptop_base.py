#!/usr/bin/env python3
"""
Edge-case tests for laptop_base.py. No network: every read goes through a fake `call`
so each failure mode is directly reachable.

    python3 test/test_laptop_base.py
"""
import os
import sys
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import laptop_base as L  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name + (("\n         " + str(extra)) if not cond and extra else ""))


def eq(name, got, want):
    check(name, got == want, f"got  {got!r}\n         want {want!r}")


# ---------------------------------------------------------------- fakes
W0 = b"\x00" * 32


def word_addr(a):
    return bytes(12) + bytes.fromhex(a.replace("0x", ""))


class Revert(Exception):
    pass


def caller(table, default=None):
    """table: {(to.lower(), selector): bytes | Exception}"""
    def call(to, data):
        key = (to.lower(), data[:10].lower())
        v = table.get(key, default)
        if isinstance(v, Exception):
            raise v
        if v is None:
            raise Revert("execution reverted")
        return v
    return call


# ================================================================ read discipline
print("── read discipline: none vs unknown is the whole point")
c = caller({(L.UNI_V2_FACTORY, L.SEL["getPair"]): W0})
eq("32 zero bytes -> none", L.find_v2_pair(c, L.LAPTOP, L.WETH), ("none", None))

c = caller({(L.UNI_V2_FACTORY, L.SEL["getPair"]): word_addr("0x1111111111111111111111111111111111111111")})
eq("address word -> found", L.find_v2_pair(c, L.LAPTOP, L.WETH),
   ("found", "0x1111111111111111111111111111111111111111"))

c = caller({(L.UNI_V2_FACTORY, L.SEL["getPair"]): b""})
check("empty 0x return -> unknown, NOT none", L.find_v2_pair(c, L.LAPTOP, L.WETH)[0] == "unknown")

c = caller({(L.UNI_V2_FACTORY, L.SEL["getPair"]): b"\x12\x34"})
check("short return -> unknown", L.find_v2_pair(c, L.LAPTOP, L.WETH)[0] == "unknown")

c = caller({(L.UNI_V2_FACTORY, L.SEL["getPair"]): Revert("execution reverted")})
check("revert -> unknown", L.find_v2_pair(c, L.LAPTOP, L.WETH)[0] == "unknown")

c = caller({(L.UNI_V2_FACTORY, L.SEL["getPair"]): Exception("429 Too Many Requests")})
r = L.find_v2_pair(c, L.LAPTOP, L.WETH)
check("rate limit -> unknown with reason", r[0] == "unknown" and "429" in r[1], r)

# ================================================================ Aerodrome quirks
print("── Aerodrome: no getPair, and a selector that collides with V3")
# Aerodrome has no getPair of any arity and no fallback: the call reverts.
aero = caller({(L.AERO_FACTORY, L.SEL["getPoolAero"]): W0}, default=Revert("execution reverted"))
eq("Aerodrome getPool(bool) -> none", L.find_aero_pool(aero, L.LAPTOP, L.WETH, False), ("none", None))
r = L.read_address(aero, L.AERO_FACTORY, L.SEL["getPair"] + L.pad_addr(L.LAPTOP) + L.pad_addr(L.WETH))
check("Aerodrome getPair reverts -> unknown, never 'no pool'", r[0] == "unknown", r)

# The killer case: Aerodrome answers a V3-shaped call with address(0) for any fee > 1.
# If find_v3_pool ever targeted the wrong factory this would read as a confident negative.
collide = caller({
    (L.AERO_FACTORY, L.SEL["getPoolV3"]): W0,                                        # Aerodrome: silent 0
    (L.UNI_V3_FACTORY, L.SEL["getPoolV3"]): word_addr("0x2222222222222222222222222222222222222222"),
})
eq("find_v3_pool pins the Uniswap V3 factory despite the shared selector",
   L.find_v3_pool(collide, L.LAPTOP, L.USDC, 3000),
   ("found", "0x2222222222222222222222222222222222222222"))

# ================================================================ V3 tier enablement
print("── V3: 'tier not enabled' vs 'pool absent' are different facts")
c = caller({(L.UNI_V3_FACTORY, L.SEL["feeTick"]): W0})
eq("feeAmountTickSpacing 0 -> tier not enabled", L.v3_tier_enabled(c, 400), ("found", 0))
c = caller({(L.UNI_V3_FACTORY, L.SEL["feeTick"]): (8).to_bytes(32, "big")})
eq("feeAmountTickSpacing 8 -> tier enabled (400bps)", L.v3_tier_enabled(c, 400), ("found", 8))

eq("Base V3 fee tiers include the Base-only 200/300/400",
   L.V3_FEES, (100, 200, 300, 400, 500, 3000, 10000))
eq("tick spacing table matches the tiers",
   sorted(L.V3_TICK_SPACINGS), sorted(L.V3_FEES))

# ================================================================ quote assets
print("── quote assets: the false-negative that costs money")
labels = [k for k, _ in L.QUOTES]
check("WETH, USDC and USDbC are all probed", labels == ["WETH", "USDC", "USDbC"], labels)
check("USDC and USDbC are different contracts", L.USDC != L.USDBC)
eq("USDbC is labelled distinctly, never as 'USDC'", L.quote_label(L.USDBC), "USDbC")
eq("native USDC labelled USDC", L.quote_label(L.USDC), "USDC")
check("USDbC counts as tradable", L.is_tradable_quote(L.USDBC))
check("native ETH counts as tradable", L.is_tradable_quote(L.ZERO))
check("an unknown sidecar token is NOT tradable",
      not L.is_tradable_quote("0xfcac02ca1bead66b91405042063fbce85fd42009"))
eq("an unknown quote falls back to its address, not a friendly name",
   L.quote_label("0xfcac02ca1bead66b91405042063fbce85fd42009"),
   "0xfcac02ca1bead66b91405042063fbce85fd42009")

# ================================================================ v4 pool state
print("── v4: three-way state, which one slot cannot give you")


def v4_caller(slot0, liq, batched=True):
    """Serve extsload(bytes32,uint256) as an ABI-encoded bytes32[4], or force the fallback."""
    def call(to, data):
        if data[:10] == L.SEL["extsloadN"]:
            if not batched:
                raise Revert("execution reverted")
            body = (32).to_bytes(32, "big") + (4).to_bytes(32, "big")
            body += slot0.to_bytes(32, "big") + W0 + W0 + liq.to_bytes(32, "big")
            return body
        if data[:10] == L.SEL["extsload"]:
            slot = int(data[10:], 16)
            base = L.pool_state_slot(PID)
            if slot == base + L.SLOT0_OFFSET:
                return slot0.to_bytes(32, "big")
            if slot == base + L.LIQUIDITY_OFFSET:
                return liq.to_bytes(32, "big")
            return W0
        raise Revert("unexpected call")
    return call


PID = "0x90333bb05c258fe0dddb2840ef66f1a05165aa7dac6815d24e807cc6ebd943a0"
SQRT = 79228162514264337593543950336  # 1:1 price

st, info = L.v4_pool_state(v4_caller(0, 0), PID)
eq("slot0 == 0 -> absent (key never existed)", st, "absent")
st, info = L.v4_pool_state(v4_caller(SQRT, 0), PID)
eq("slot0 set, liquidity 0 -> empty (initialized, nothing tradable)", st, "empty")
st, info = L.v4_pool_state(v4_caller(SQRT, 12345), PID)
eq("both non-zero -> active", st, "active")
eq("active reports the liquidity it read", info["liquidity"], 12345)

# The regression this whole fix exists for: 'absent' and 'empty' both have liquidity == 0.
a = L.v4_pool_state(v4_caller(0, 0), PID)
b = L.v4_pool_state(v4_caller(SQRT, 0), PID)
check("absent and empty are distinguishable despite both having liquidity == 0", a[0] != b[0])

# slot0 is packed: sqrtPriceX96 in the low 160 bits, tick/protocolFee/lpFee above it.
packed = (3000 << 184) | (500 << 160) | SQRT
st, info = L.v4_pool_state(v4_caller(packed, 7), PID)
eq("sqrtPriceX96 extracted from the packed slot0 word", info["sqrtPriceX96"], SQRT)
eq("packed slot0 still classifies as active", st, "active")

st, _ = L.v4_pool_state(v4_caller(SQRT, 99, batched=False), PID)
eq("falls back to two single-slot reads when the batch form reverts", st, "active")


def dead_call(to, data):
    raise Exception("429 Too Many Requests")


eq("v4 state under a failing endpoint -> unknown, never 'absent'",
   L.v4_pool_state(dead_call, PID)[0], "unknown")

# ================================================================ derivations
print("── derivations (cross-checked against the JS implementation)")
eq("pool_id reproduces the real Base USDC/WETH 0.05% pool id",
   L.pool_id(L.WETH, L.USDC, 500, 10, L.ZERO), PID)
check("pool_state_slot is a 256-bit value", 0 < L.pool_state_slot(PID) < (1 << 256))
eq("pad_int encodes a negative tickSpacing in two's complement",
   L.pad_int(-200), "f" * 62 + "38")
eq("pad_int leaves positives alone", L.pad_int(200), "0" * 62 + "c8")

# ================================================================ text decoding
print("── name()/symbol(): string, bytes32, and neither")
c = caller({(L.LAPTOP, L.SEL["symbol"]):
            (32).to_bytes(32, "big") + (6).to_bytes(32, "big") + b"LAPTOP".ljust(32, b"\x00")})
eq("ABI string decoded", L.read_text(c, L.LAPTOP, L.SEL["symbol"]), ("found", "LAPTOP"))
c = caller({(L.LAPTOP, L.SEL["symbol"]): b"LAPTOP".ljust(32, b"\x00")})
eq("bytes32 symbol decoded", L.read_text(c, L.LAPTOP, L.SEL["symbol"]), ("found", "LAPTOP"))
c = caller({(L.LAPTOP, L.SEL["symbol"]): b""})
check("empty return -> unknown", L.read_text(c, L.LAPTOP, L.SEL["symbol"])[0] == "unknown")
c = caller({(L.LAPTOP, L.SEL["symbol"]): (1 << 200).to_bytes(32, "big") + W0})
check("absurd string offset -> unknown, not an empty name",
      L.read_text(c, L.LAPTOP, L.SEL["symbol"])[0] == "unknown")
# A truncated string: the header promises 32 bytes, only 4 arrive.
c = caller({(L.LAPTOP, L.SEL["symbol"]):
            (32).to_bytes(32, "big") + (32).to_bytes(32, "big") + b"LAPT"})
check("truncated string -> unknown, not a partial name",
      L.read_text(c, L.LAPTOP, L.SEL["symbol"])[0] == "unknown")
# Length 10 exercises a hex word with a letter in it - a decoder that forgets the 0x
# prefix parses these as decimal and blows up on exactly this case.
c = caller({(L.LAPTOP, L.SEL["symbol"]):
            (32).to_bytes(32, "big") + (10).to_bytes(32, "big") + b"LAPTOPCOIN".ljust(32, b"\x00")})
eq("10-char symbol (length word contains a hex letter)",
   L.read_text(c, L.LAPTOP, L.SEL["symbol"]), ("found", "LAPTOPCOIN"))

# ================================================================ registry
print("── Aerodrome FactoryRegistry")
arr = (32).to_bytes(32, "big") + (2).to_bytes(32, "big") + \
      word_addr(L.AERO_FACTORY) + word_addr("0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a")
c = caller({(L.AERO_REGISTRY, L.SEL["poolFactories"]): arr})
st, lst = L.aero_factories(c)
eq("registry array decoded", st, "found")
eq("registry returns both factories", len(lst), 2)
check("the known v2 factory is in the set", L.AERO_FACTORY in lst)
check("an unknown (Slipstream-shaped) factory is surfaced",
      any(a != L.AERO_FACTORY for a in lst))

c = caller({(L.AERO_REGISTRY, L.SEL["poolFactories"]):
            (32).to_bytes(32, "big") + (5).to_bytes(32, "big") + word_addr(L.AERO_FACTORY)})
check("truncated registry array -> unknown, not a partial list",
      L.aero_factories(c)[0] == "unknown")
c = caller({(L.AERO_REGISTRY, L.SEL["poolFactories"]): Revert("execution reverted")})
check("registry revert -> unknown", L.aero_factories(c)[0] == "unknown")

# ================================================================ Slipstream
print("── Aerodrome Slipstream (the second AMM nothing was querying)")
CL = "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a"
c = caller({(CL, L.SEL["getPoolCL"]): word_addr("0x3333333333333333333333333333333333333333")})
eq("CL pool found via getPool(address,address,int24)",
   L.find_cl_pool(c, CL, L.LAPTOP, L.USDC, 200),
   ("found", "0x3333333333333333333333333333333333333333"))
eq("Slipstream tick spacings", L.CL_TICK_SPACINGS, (1, 50, 100, 200, 2000))
c = caller({}, default=Revert("execution reverted"))
check("a factory that is not Slipstream-shaped -> unknown, not 'no pool'",
      L.find_cl_pool(c, CL, L.LAPTOP, L.USDC, 200)[0] == "unknown")

# ================================================================ constants sanity
print("── constants")
for nm in ("LAPTOP", "POOL_MANAGER", "UNI_V2_FACTORY", "UNI_V3_FACTORY", "AERO_FACTORY",
           "AERO_REGISTRY", "WETH", "USDC", "USDBC"):
    v = getattr(L, nm)
    check(f"{nm} is a lowercase 20-byte address",
          v == v.lower() and len(v) == 42 and v.startswith("0x"), v)
eq("chain id is Base", L.CHAIN_ID, 8453)
check("no duplicate selectors", len(set(L.SEL.values())) == len(L.SEL))
eq("v4 storage offsets", (L.POOLS_SLOT, L.SLOT0_OFFSET, L.LIQUIDITY_OFFSET), (6, 0, 3))

# ================================================================
print()
for p in PASS:
    print("  ok   " + p)
for f in FAIL:
    print("  FAIL " + f)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
