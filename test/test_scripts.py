#!/usr/bin/env python3
"""
Integration tests for the patched scripts: laptop_buy.survey_quotes and
laptop_watch.check_classic driven against a fake node. No network.

    python3 test/test_scripts.py
"""
import io
import os
import sys
import contextlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import laptop_base as L        # noqa: E402
import laptop_buy as BUY       # noqa: E402
import laptop_watch as WATCH   # noqa: E402

PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name + (("\n         " + str(extra)) if not cond and extra else ""))


def eq(name, got, want):
    check(name, got == want, f"got  {got!r}\n         want {want!r}")


W0 = b"\x00" * 32
V3POOL = "0x1111111111111111111111111111111111111111"
CLFAC = "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a"
CLPOOL = "0x3333333333333333333333333333333333333333"


def word_addr(a):
    return bytes(12) + bytes.fromhex(a.replace("0x", ""))


class FakeEth:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []
        self.block_number = 0x1470c27

    def call(self, tx, *a, **k):
        to = tx["to"].lower()
        data = tx["data"]
        self.calls.append((to, data[:10]))
        return self.handler(to, data)


class FakeW3:
    def __init__(self, handler):
        self.eth = FakeEth(handler)

    @staticmethod
    def to_wei(v, unit):
        return int(v * 1e18)


def handler(*, v3_usdc_pool=True, tier400_enabled=False, registry=True,
            cl_pool=False, v2_fails=False, balance_fails=False):
    """A node where the only LAPTOP pool is USDC-quoted on Uniswap V3 0.30%."""
    def h(to, data):
        sel = data[:10].lower()
        if to == L.UNI_V2_FACTORY and sel == L.SEL["getPair"]:
            if v2_fails:
                raise Exception("429 Too Many Requests")
            return W0
        if to == L.UNI_V3_FACTORY and sel == L.SEL["feeTick"]:
            fee = int(data[10:], 16)
            spacing = L.V3_TICK_SPACINGS.get(fee, 0)
            if fee == 400 and not tier400_enabled:
                spacing = 0            # tier genuinely not enabled on this node
            return spacing.to_bytes(32, "big")
        if to == L.UNI_V3_FACTORY and sel == L.SEL["getPoolV3"]:
            quote = "0x" + data[10 + 64 + 24:10 + 128]
            fee = int(data[10 + 128:10 + 192], 16)
            if v3_usdc_pool and quote.lower() == L.USDC and fee == 3000:
                return word_addr(V3POOL)
            return W0
        if sel == L.SEL["balanceOf"]:
            if balance_fails:
                raise Exception("execution reverted")
            return (5 * 10**18).to_bytes(32, "big")
        if sel == L.SEL["getReserves"]:
            return (7 * 10**18).to_bytes(32, "big") + (3 * 10**18).to_bytes(32, "big") + W0
        if sel == L.SEL["token0"]:
            return word_addr(L.LAPTOP)
        if to == L.AERO_FACTORY and sel == L.SEL["getPoolAero"]:
            return W0
        if to == L.AERO_REGISTRY and sel == L.SEL["poolFactories"]:
            if not registry:
                raise Exception("execution reverted")
            return ((32).to_bytes(32, "big") + (2).to_bytes(32, "big")
                    + word_addr(L.AERO_FACTORY) + word_addr(CLFAC))
        if to == CLFAC and sel == L.SEL["getPoolCL"]:
            if not cl_pool:
                return W0
            quote = "0x" + data[10 + 64 + 24:10 + 128]
            spacing = int(data[10 + 128:10 + 192], 16)
            if quote.lower() == L.USDC and spacing == 200:
                return word_addr(CLPOOL)
            return W0
        raise Exception("execution reverted")
    return h


def run(fn, *a, **k):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        out = fn(*a, **k)
    return out, buf.getvalue()


# ================================================================
print("── laptop_buy.survey_quotes: the USDC pool that used to be invisible")
w3 = FakeW3(handler())
(rows, unknowns), out = run(BUY.survey_quotes, w3)
hits = [r for r in rows if r["pool"].lower() == V3POOL.lower()]
check("finds the USDC-quoted V3 pool", len(hits) == 1, rows)
eq("and labels its quote asset correctly", hits[0]["quote"] if hits else None, "USDC")
check("no spurious extra pools", len(rows) == 1, rows)
check("no unknowns on a healthy node", unknowns == [], unknowns)

print("── every quote asset is actually probed")


class RecordingEth(FakeEth):
    """Keeps full calldata so the test can assert which quotes and tiers were queried."""
    def call(self, tx, *a, **k):
        self.calls.append((tx["to"].lower(), tx["data"]))
        return self.handler(tx["to"].lower(), tx["data"])


w3c = FakeW3(handler())
w3c.eth = RecordingEth(handler())
run(BUY.survey_quotes, w3c)
v2_quotes = {c[1][10 + 64 + 24:10 + 128].lower() for c in w3c.eth.calls
             if c[1][:10] == L.SEL["getPair"]}
eq("V2 probed against all three quote assets", len(v2_quotes), 3)
check("USDbC is among them", L.USDBC[2:] in v2_quotes, v2_quotes)

v3_fees = {int(c[1][10 + 128:10 + 192], 16) for c in w3c.eth.calls
           if c[1][:10] == L.SEL["getPoolV3"]}
check("the Base-only 200 and 300 tiers are queried", {200, 300}.issubset(v3_fees), sorted(v3_fees))
check("a disabled tier (400) is skipped rather than counted as 'no pool'",
      400 not in v3_fees, sorted(v3_fees))

print("── a disabled tier becoming enabled is picked up")
w3d = FakeW3(handler(tier400_enabled=True))
w3d.eth = RecordingEth(handler(tier400_enabled=True))
run(BUY.survey_quotes, w3d)
fees2 = {int(c[1][10 + 128:10 + 192], 16) for c in w3d.eth.calls
         if c[1][:10] == L.SEL["getPoolV3"]}
check("tier 400 queried once enabled", 400 in fees2, sorted(fees2))

print("── failures surface as unknowns, never as 'no pool'")
w3e = FakeW3(handler(v2_fails=True))
(rows, unknowns), out = run(BUY.survey_quotes, w3e)
check("a rate-limited V2 read becomes an unknown", any("Uniswap V2" in u[0] for u in unknowns), unknowns)
check("unknowns are not silently dropped from the row set",
      all(r["venue"] != "Uniswap V2" for r in rows))

print("── Slipstream discovery via the registry")
w3f = FakeW3(handler(cl_pool=True))
(rows, unknowns), out = run(BUY.survey_quotes, w3f)
check("finds the Slipstream CL pool the old code could not see",
      any(r["pool"].lower() == CLPOOL.lower() for r in rows), rows)

w3g = FakeW3(handler(registry=False))
(rows, unknowns), out = run(BUY.survey_quotes, w3g)
check("a dead registry is reported as an unknown venue",
      any("registry" in u[0].lower() for u in unknowns), unknowns)

print("── find_pools refuses to auto-trade a non-WETH pool")
w3h = FakeW3(handler())
found, out = run(BUY.find_pools, w3h, 10**16, "0x" + "1" * 40)
eq("USDC pool is not returned as buyable", found, [])
check("but it is reported loudly", "not buyable here" in out, out[:400])
check("and the reason is stated", "multi-hop" in out, out[:400])

# ================================================================
print("── laptop_watch.check_classic")
w3i = FakeW3(handler())
rows, out = run(WATCH.check_classic, w3i, "USDC", L.USDC)
check("watch finds the USDC pool", any(r[1].lower() == V3POOL.lower() for r in rows), rows)
row = [r for r in rows if r[1].lower() == V3POOL.lower()][0]
eq("quote label carried through", row[3], "USDC")
eq("USDC pool is marked not-ETH-routable", row[4], False)

rows, out = run(WATCH.check_classic, w3i, "WETH", L.WETH)
eq("no WETH pool on this node", rows, [])

w3j = FakeW3(handler(v2_fails=True))
rows, out = run(WATCH.check_classic, w3j, "WETH", L.WETH)
check("watch prints COULD NOT CHECK on a failed read", "COULD NOT CHECK" in out, out[:300])

print("── watch: a failed depth read does not kill the sweep")
w3L = FakeW3(handler(balance_fails=True))
rows, out = run(WATCH.check_classic, w3L, "WETH", L.WETH)
check("sweep survives a failing balanceOf", isinstance(rows, list))
w3M = FakeW3(handler(v3_usdc_pool=True, balance_fails=True))
rows, out = run(WATCH.check_classic, w3M, "USDC", L.USDC)
check("the pool is still reported when its depth cannot be read",
      any(r[1].lower() == V3POOL.lower() for r in rows), rows)

print("── watch: v4 read failure is never a liquidity change")


def dead(to, data):
    raise Exception("429 Too Many Requests")


w3k = FakeW3(dead)
eq("failed v4 read returns the -2 sentinel, distinct from -1 'not seen'",
   WATCH.v4_liquidity(w3k, "0x" + "ab" * 32), -2)

print("── shared constants really are shared (no drift)")
eq("buy uses the shared fee tiers", BUY.V3_FEES, L.V3_FEES)
eq("watch uses the shared fee tiers", WATCH.V3_FEES, L.V3_FEES)
eq("watch tradable quotes include USDbC", WATCH.TRADABLE_QUOTES, L.TRADABLE_QUOTES)
check("USDbC is a tradable quote in watch", L.USDBC in WATCH.TRADABLE_QUOTES)

# ================================================================
print()
for p in PASS:
    print("  ok   " + p)
for f in FAIL:
    print("  FAIL " + f)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
