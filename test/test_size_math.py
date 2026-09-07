#!/usr/bin/env python3
"""
Reference implementation and property tests for the size-curve math in web/size.html.

Written independently of the JavaScript so the two can be compared. test/run-size.mjs
loads the fixture this emits and asserts the page agrees.

    python3 test/test_size_math.py            # run tests, write test/size-fixture.json
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name + (("\n         " + str(extra)) if not cond and extra else ""))


def close(name, got, want, rel=1e-9):
    if want == 0:
        ok = abs(got) < 1e-12
    else:
        ok = abs(got - want) / abs(want) < rel
    check(name, ok, f"got  {got!r}\n         want {want!r}")


# ---------------------------------------------------------------- reference math

def v2_out(amount_in, reserve_in, reserve_out, fee_bps):
    """Constant product, exact integer arithmetic - the formula the pool itself runs."""
    if amount_in <= 0 or reserve_in <= 0 or reserve_out <= 0:
        return 0
    in_after_fee = amount_in * (10000 - fee_bps)
    return (in_after_fee * reserve_out) // (reserve_in * 10000 + in_after_fee)


def v3_out(amount_in, L, sqrt_p, fee_ppm, zero_for_one):
    """Concentrated liquidity, single range, constant L.

    Over the VIRTUAL reserves x = L/sqrtP, y = L*sqrtP - because for a single range with
    constant L, concentrated liquidity is exactly constant product over those. This is the
    form the page implements."""
    if L <= 0 or sqrt_p <= 0 or amount_in <= 0:
        return 0.0
    a = amount_in * (1 - fee_ppm / 1e6)
    x_v, y_v = L / sqrt_p, L * sqrt_p
    return a * y_v / (x_v + a) if zero_for_one else a * x_v / (y_v + a)


def v3_out_closed_form(amount_in, L, sqrt_p, fee_ppm, zero_for_one):
    """The textbook derivation, via the next sqrt price. Algebraically identical to the
    above; kept as an independent cross-check. It is NOT what the page uses, because
    L*(sqrtP - sqrtNext) subtracts two nearly-equal large numbers and loses roughly 1e-10
    of relative precision to cancellation - which is why the comparison below is checked
    at 1e-8 rather than to the last bit."""
    if L <= 0 or sqrt_p <= 0 or amount_in <= 0:
        return 0.0
    a = amount_in * (1 - fee_ppm / 1e6)
    if zero_for_one:
        sqrt_next = 1.0 / (1.0 / sqrt_p + a / L)
        return L * (sqrt_p - sqrt_next)
    sqrt_next = sqrt_p + a / L
    return L * (1.0 / sqrt_p - 1.0 / sqrt_next)


# ================================================================ V2
print("── constant product: exact, and matching Uniswap's own formula")
R = 1000 * 10**18
# Uniswap V2 getAmountOut, written the way the pair contract does it, as a cross-check.
def uni_v2_reference(amount_in, r_in, r_out):
    a = amount_in * 997
    return (a * r_out) // (r_in * 1000 + a)


for amt in (10**16, 10**18, 5 * 10**18, 100 * 10**18):
    check(f"v2_out matches Uniswap's 997/1000 form at {amt/1e18:g}",
          v2_out(amt, R, R, 30) == uni_v2_reference(amt, R, R),
          f"{v2_out(amt, R, R, 30)} vs {uni_v2_reference(amt, R, R)}")

check("v2: zero input gives zero out", v2_out(0, R, R, 30) == 0)
check("v2: empty reserves give zero out", v2_out(10**18, 0, R, 30) == 0)
check("v2: output can never exceed the output reserve",
      all(v2_out(a, R, R, 30) < R for a in (10**18, 10**24, 10**30)))

# Monotonicity and diminishing returns are the properties a size curve lives or dies on.
outs = [v2_out(a * 10**18, R, R, 30) for a in (1, 2, 5, 10, 25, 50, 100)]
check("v2: output rises with size", all(b > a for a, b in zip(outs, outs[1:])))
eff = [o / (a * 10**18) for o, a in zip(outs, (1, 2, 5, 10, 25, 50, 100))]
check("v2: effective price gets strictly worse with size",
      all(b < a for a, b in zip(eff, eff[1:])), eff)

# A fee-free infinitesimal trade should price at spot.
# The probe is sized to balance two errors: integer flooring (~1/probe) and real price
# impact (~probe/reserve). sqrt(reserve) minimises their sum.
probe_v2 = 10**11
tiny = v2_out(probe_v2, R, R, 0) / probe_v2
close("v2: a well-sized zero-fee probe prices at spot", tiny, 1.0, rel=1e-6)

# ================================================================ V3
print("── concentrated liquidity: two independent derivations must agree")
L = 5.0e21
SQRT_P = 2.5           # price = 6.25 token1 per token0
for amt in (1e15, 1e18, 1e19, 5e19, 1e21):
    for z in (True, False):
        a = v3_out(amt, L, SQRT_P, 3000, z)
        b = v3_out_closed_form(amt, L, SQRT_P, 3000, z)
        close(f"virtual-reserve form == textbook closed form "
              f"({'0->1' if z else '1->0'}, in={amt:g})", a, b, rel=1e-8)

check("v3: zero liquidity gives zero out", v3_out(1e18, 0, SQRT_P, 3000, True) == 0)
check("v3: zero input gives zero out", v3_out(0, L, SQRT_P, 3000, True) == 0)

outs3 = [v3_out(a * 1e18, L, SQRT_P, 3000, False) for a in (1, 2, 5, 10, 25, 50)]
check("v3: output rises with size", all(b > a for a, b in zip(outs3, outs3[1:])))
eff3 = [o / (a * 1e18) for o, a in zip(outs3, (1, 2, 5, 10, 25, 50))]
check("v3: effective price gets strictly worse with size",
      all(b < a for a, b in zip(eff3, eff3[1:])), eff3)

# Spot price, computed as the limit rather than sampled. A probe small enough to be
# "infinitesimal" against a large L rounds to zero in double precision - the size page had
# exactly that bug until this test caught it.
def spot_price(sqrt_p, zero_for_one, dec_in, dec_out):
    raw = sqrt_p ** 2 if zero_for_one else 1 / sqrt_p ** 2
    return raw * 10 ** (dec_in - dec_out)


close("spot 0->1 is P", spot_price(SQRT_P, True, 18, 18), SQRT_P ** 2)
close("spot 1->0 is 1/P", spot_price(SQRT_P, False, 18, 18), 1 / SQRT_P ** 2)
close("spot adjusts for decimals (6 in, 18 out)",
      spot_price(SQRT_P, True, 6, 18), SQRT_P ** 2 * 1e-12)

# A probe scaled to L still approaches spot from below.
probe = L * 1e-9
close("a probe scaled to L approaches spot", v3_out(probe, L, SQRT_P, 0, False) / probe,
      1 / SQRT_P ** 2, rel=1e-6)
# Why the page derives spot analytically rather than sampling it. The textbook closed form
# underflows to exactly zero for a probe this small against this L: sqrtP + a/L rounds back
# to sqrtP, so the difference is 0. The virtual-reserve form has no such cancellation and
# survives the same probe. The page uses the analytic limit regardless - the probe approach
# is fragile in a way that fails silently, producing a spot of 0 and meaningless slippage.
check("the textbook closed form underflows to zero on a tiny probe",
      v3_out_closed_form(1e6, L, SQRT_P, 0, False) == 0)
check("the virtual-reserve form survives the same probe",
      v3_out(1e6, L, SQRT_P, 0, False) > 0,
      v3_out(1e6, L, SQRT_P, 0, False))

# The fee is taken off the input, so a 0.3% fee costs exactly 0.3% at the limit.
no_fee = v3_out(probe, L, SQRT_P, 0, False)
with_fee = v3_out(probe, L, SQRT_P, 3000, False)
close("v3: a 0.3% fee costs 0.3% on a tiny trade", with_fee / no_fee, 0.997, rel=1e-6)

# Deeper liquidity must mean less slippage at the same size.
shallow = v3_out(1e20, 1.0e21, SQRT_P, 3000, False) / 1e20
deep = v3_out(1e20, 1.0e23, SQRT_P, 3000, False) / 1e20
check("v3: deeper liquidity fills better at the same size", deep > shallow, (shallow, deep))

# Output is bounded by the virtual reserve of the output token: you cannot drain a range.
# As input grows the fill approaches, but never passes, the virtual reserve of the output
# token. At absurd sizes it saturates there exactly in double precision.
huge = v3_out(1e40, L, SQRT_P, 0, False)
big_but_finite = v3_out(1e24, L, SQRT_P, 0, False)
check("v3: output never exceeds the output-side virtual reserve",
      huge <= L / SQRT_P, (huge, L / SQRT_P))
check("v3: a large-but-finite trade stays strictly under it",
      big_but_finite < L / SQRT_P, (big_but_finite, L / SQRT_P))

# ================================================================ fixture
print("── emitting cross-language fixture")
fixture = {"v2": [], "v3": []}
for amt, ri, ro, fee in [(10**18, R, R, 30), (5 * 10**18, R, 2 * R, 30),
                         (10**20, R, R, 30), (10**16, R, R, 5),
                         (10**18, 3 * 10**18, 7 * 10**18, 30)]:
    fixture["v2"].append({"in": str(amt), "rIn": str(ri), "rOut": str(ro),
                          "feeBps": fee, "out": str(v2_out(amt, ri, ro, fee))})
fixture["spot"] = [
    {"sqrtP": SQRT_P, "zeroForOne": True, "decIn": 18, "decOut": 18,
     "out": spot_price(SQRT_P, True, 18, 18)},
    {"sqrtP": SQRT_P, "zeroForOne": False, "decIn": 6, "decOut": 18,
     "out": spot_price(SQRT_P, False, 6, 18)},
    {"sqrtP": 0.05, "zeroForOne": False, "decIn": 18, "decOut": 6,
     "out": spot_price(0.05, False, 18, 6)},
]
for amt, l, sp, fee, z in [(1e18, L, SQRT_P, 3000, False), (1e18, L, SQRT_P, 3000, True),
                           (5e19, L, SQRT_P, 500, False), (1e21, L, SQRT_P, 10000, True),
                           (1e17, 1.0e20, 0.05, 3000, False)]:
    fixture["v3"].append({"in": amt, "L": l, "sqrtP": sp, "feePpm": fee,
                          "zeroForOne": z, "out": v3_out(amt, l, sp, fee, z)})
with open(os.path.join(HERE, "size-fixture.json"), "w") as f:
    json.dump(fixture, f, indent=1)
check("fixture written", os.path.exists(os.path.join(HERE, "size-fixture.json")))

# ================================================================
print()
for p in PASS:
    print("  ok   " + p)
for f in FAIL:
    print("  FAIL " + f)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
