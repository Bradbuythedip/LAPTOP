"""Properties the launch-fee model lives or dies on.

Same role as test_size_math.py: an independent check on arithmetic the page will later have
to agree with. Written against the invariants, not against the implementation — several of
these were written first and caught real defects, which is noted where it happened.
"""
import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from dataclasses import replace
from launch_model import (Population, Schedule, participation, pareto_shape, tax_at,
                          mean_rate, buy, sell, simulate, objective, stable_region,
                          knee_sensitivity, UNFITTABLE)

P, F = 0, 0
def ok(name, cond, extra=""):
    global P, F
    if cond:
        P += 1; print("  ok   " + name)
    else:
        F += 1; print("  FAIL " + name + (("\n         " + str(extra)) if extra else ""))
def close(name, got, want, tol=1e-12):
    ok(name, abs(got - want) <= tol, f"got {got!r}, want {want!r}")


print("── participation: a knee, not a slope")
close("no pressure means nobody is deterred", participation(0.0, 6.0), 1.0)
close("at the knee exactly half remain", participation(1.0, 6.0), 0.5)
ok("well under the knee almost everyone remains", participation(0.3, 6.0) > 0.95)
ok("well over the knee almost nobody does", participation(2.5, 6.0) < 0.05)
ok("it is monotone decreasing",
   all(participation(x / 10, 6.0) >= participation((x + 1) / 10, 6.0) for x in range(40)))
ok("a sharper knee is flatter below and steeper above",
   participation(0.5, 12.0) > participation(0.5, 3.0) and
   participation(1.5, 12.0) < participation(1.5, 3.0))
ok("extreme pressure saturates rather than overflowing",
   participation(1e6, 6.0) == 0.0 and participation(1e-9, 6.0) > 0.99)
# The distinguishing property. A linear fade makes every rate proportionally bad, which is
# what let the first model report a smooth interior optimum that was not really there.
ok("the knee is not linear: the drop from 0.9 to 1.1 exceeds the drop from 0.1 to 0.3",
   (participation(0.9, 6.0) - participation(1.1, 6.0)) >
   (participation(0.1, 6.0) - participation(0.3, 6.0)))

print("── size mix: shape is guessed, scale is elicited")
for n, a in ((10, 1.8), (100, 2.2), (400, 1.5)):
    s = pareto_shape(n, a)
    close(f"shape({n},{a}) sums to exactly 1", sum(s), 1.0, 1e-12)
    ok(f"shape({n},{a}) is sorted largest first", all(s[i] >= s[i+1] for i in range(len(s)-1)))
    ok(f"shape({n},{a}) is all positive", all(x > 0 for x in s))
ok("a heavier tail concentrates more in the top order",
   pareto_shape(100, 1.4)[0] > pareto_shape(100, 2.5)[0])
ok("an empty population has an empty mix", pareto_shape(0, 1.8) == [])
# This is the defect that produced a single 68.6 ETH buy into a 10 ETH pool.
ok("no single order can exceed the elicited total, whatever the exponent",
   all(max(pareto_shape(50, a)) <= 1.0 for a in (1.1, 1.4, 1.8, 2.5, 4.0)))

print("── the schedule is a path")
s = Schedule(unit="buy", start=0.01, step=0.01, cap=0.10)
close("the first buy pays exactly the start", tax_at(s, 0, 0.0, 0), 0.01)
close("the second pays one step more", tax_at(s, 1, 0.0, 0), 0.02)
close("and it stops at the cap", tax_at(s, 999, 0.0, 0), 0.10)
sv = Schedule(unit="volume", start=0.01, step=0.01, step_unit=5.0, cap=0.50)
close("a volume ramp ignores buy count", tax_at(sv, 999, 0.0, 0), 0.01)
close("and advances per step_unit of volume", tax_at(sv, 0, 5.0, 0), 0.02)
close("sub-step volume does not advance it", tax_at(sv, 0, 4.99, 0), 0.01)
sb = Schedule(unit="block", start=0.01, step=0.01, cap=0.50)
close("a block ramp ignores buys and volume", tax_at(sb, 999, 999.0, 0), 0.01)
close("and advances per block", tax_at(sb, 0, 0.0, 3), 0.04)
soff = Schedule(unit="buy", start=0.25, step=0.0, cap=0.25, off_after=3)
close("a turn-off is exactly zero, not the ramp value", tax_at(soff, 3, 0.0, 0), 0.0)
close("and before it the full rate applies", tax_at(soff, 2, 0.0, 0), 0.25)
ok("mean_rate of a flat schedule is that rate",
   abs(mean_rate(Schedule(unit="buy", start=0.03, step=0.0, cap=0.03), 50, 100.0) - 0.03) < 1e-12)
ok("mean_rate of a rising schedule sits between start and cap",
   0.01 < mean_rate(Schedule(unit="buy", start=0.01, step=0.01, cap=0.10), 50, 100.0) < 0.10)

print("── the pool is the same constant product as everywhere else")
E, T, out = buy(10.0, 1.0, 1.0, 0.0)
close("a zero-fee buy is exactly x*y=k", out, 1.0 * 1.0 / 11.0)
close("and the reserve gains the whole input", E, 11.0)
ok("a fee strictly reduces the output", buy(10.0, 1.0, 1.0, 0.01)[2] < out)
# Path independence at zero fee: this is why batching changes who pays, not the aggregate.
def run(total, n, fee):
    e, t, acc = 10.0, 1.0, 0.0
    for _ in range(n):
        e, t, o = buy(e, t, total / n, fee)
        acc += o
    return acc
close("splitting is exactly free at zero fee", run(5.0, 100, 0.0), run(5.0, 1, 0.0), 1e-12)
ok("and strictly costly with one", run(5.0, 100, 0.01) < run(5.0, 1, 0.01))
ok("selling back gives less than was paid, with a fee",
   sell(11.0, 1.0 - out, out, 0.01)[2] < 1.0)

print("── simulation conserves and never invents")
pop, sch = Population(), Schedule(cap=0.10, step_unit=5.0)
r = simulate(pop, sch, 25.0, 0.01, "treasury")
ok("some buyers survive an ordinary schedule", r.buyers > 0)
ok("deterred plus surviving is the whole population",
   r.deterred + r.buyers == pop.n_snipe + pop.n_organic,
   f"{r.deterred} + {r.buyers} != {pop.n_snipe + pop.n_organic}")
ok("the take never exceeds the volume that produced it", r.treasury_eth <= pop.volume_eth)
ok("volume reaching the pool never exceeds what buyers spent", r.volume <= pop.volume_eth)
ok("the price only rises on a launch that is all buys", r.price_multiple >= 1.0)
z = simulate(pop, replace(sch, start=0.0, step=0.0, cap=0.0, sell=0.0), 25.0, 0.01, "treasury")
close("a launch with no taxes at all collects nothing", z.treasury_eth, 0.0)
ok("and deters nobody through the tax channel", z.deterred <= r.deterred)
huge = simulate(pop, replace(sch, start=0.9, step=0.0, cap=0.9, sell=0.9), 25.0, 0.01, "treasury")
ok("a confiscatory schedule collects nothing because nobody buys",
   huge.buyers == 0 and huge.treasury_eth == 0.0)

print("── destinations are not one number in three costumes")
t_ = simulate(pop, sch, 25.0, 0.01, "treasury")
l_ = simulate(pop, sch, 25.0, 0.01, "lp")
b_ = simulate(pop, sch, 25.0, 0.01, "burn")
ok("treasury withdraws ETH and adds no depth",
   t_.treasury_eth > 0 and t_.depth_added_eth == 0.0)
ok("lp adds depth and withdraws nothing",
   l_.depth_added_eth > 0 and l_.treasury_eth == 0.0)
ok("burn removes supply and does neither",
   b_.supply_burned > 0 and b_.treasury_eth == 0.0 and b_.depth_added_eth == 0.0)
# Recycling into the book improves later fills, so it is not simply "treasury you keep".
ok("recycling into the book leaves more depth than the tax alone",
   l_.depth_added_eth >= t_.treasury_eth * 0.5)
ok("burning drives the price further than banking the same tax",
   b_.price_multiple > t_.price_multiple)
# The circular-valuation trap: nothing in Result marks a holding at the model's own end price.
ok("no destination is reported as a mark-to-market wealth number",
   not any(f in Result_fields() for f in ("lp_value", "burn_value", "wealth"))
   if (Result_fields := (lambda: list(t_.__dataclass_fields__))) else True)

print("── seed is a real co-control, because impact enters demand")
thin = simulate(pop, replace(sch, start=0.0), 5.0, 0.01, "treasury")
deep = simulate(pop, replace(sch, start=0.0), 50.0, 0.01, "treasury")
ok("a deeper book is not deterring more buyers", deep.buyers >= thin.buyers,
   f"{deep.buyers} vs {thin.buyers}")
ok("and seed changes the answer at all — it did not, before impact was priced",
   deep.buyers != thin.buyers)
ok("a thinner book raises the cost a buyer sees, so it deters more",
   thin.deterred >= deep.deterred)

print("── the round trip is arithmetic and depends on no guess")
for tax, sellt, fee in ((0.0, 0.0, 0.01), (0.02, 0.05, 0.01), (0.10, 0.10, 0.003)):
    want = 1 - (1 - tax) * (1 - fee) ** 2 * (1 - sellt)
    got = simulate(pop, replace(sch, start=tax, sell=sellt), 25.0, fee, "treasury").round_trip
    close(f"round trip at buy {tax} sell {sellt} fee {fee}", got, want)
# The one number in this whole model that no unfittable parameter can move.
rts = {simulate(replace(pop, org_buy_knee=k), replace(sch, start=0.02, sell=0.05),
                25.0, 0.01, "treasury").round_trip for k in (0.02, 0.09, 0.5)}
ok("and it is identical across every deterrence guess", len(rts) == 1, rts)

print("── the honest output is a band, and the band is not trustworthy")
lo, hi, best = stable_region(pop, sch, 25.0, 0.01, "treasury")
ok("a band is returned, not a point", hi >= lo)
ok("the band's best is achievable", best >= 0.0)
# The finding that matters: an unfittable parameter moves the recommendation across the
# whole search range, so the model must not report one.
spans = knee_sensitivity(pop, sch, 25.0, 0.01, "treasury")
widest = max(hi_ - lo_ for _, lo_, hi_ in spans)
ok("halving and doubling a guessed knee moves the answer by more than 5 points",
   widest > 0.05, f"widest span {widest}")
ok("every unfittable parameter is named so the page can label it",
   set(UNFITTABLE) >= {"snipe_buy_knee", "org_buy_knee", "org_sell_knee", "sharpness"})
ok("and each named one actually exists on the population",
   all(hasattr(pop, n) for n in UNFITTABLE))

print("── the bimodal result: 2% was never on the menu")
worlds = []
for sbk in (0.03, 0.06, 0.12):
    for obk in (0.045, 0.09, 0.18):
        for osk in (0.035, 0.07, 0.14):
            for sh in (3.0, 6.0, 12.0):
                worlds.append(replace(pop, snipe_buy_knee=sbk, org_buy_knee=obk,
                                      org_sell_knee=osk, sharpness=sh))
opts = [stable_region(w, sch, 25.0, 0.01, "treasury")[0] for w in worlds]
ok("81 plausible worlds were searched", len(opts) == 81)
ok("some worlds want no buy tax at all", any(o == 0.0 for o in opts))
ok("and some want a substantial one", any(o >= 0.07 for o in opts))
# The original model's 2% recommendation lies in the gap between the two modes: it is the
# answer a linear fade gives when the real answer is bimodal.
mid = [o for o in opts if 0.005 < o < 0.065]
ok("almost nothing lands where the linear model put its recommendation",
   len(mid) <= len(opts) * 0.05, f"{len(mid)} of {len(opts)} in the 1-6% gap")

print(f"\n{P} passed, {F} failed")
sys.exit(1 if F else 0)
