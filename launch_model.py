"""Reference implementation of the launch-fee model.

Written independently of web/launch.html so the page can be checked against it, the same way
test_size_math.py backs web/size.html. Everything is deterministic: no randomness, no clock.
A Pareto size mix is drawn at fixed quantiles rather than sampled, so a test can pin exact
numbers.

WHAT THIS MODEL REFUSES TO DO
-----------------------------
It does not report a single "best tax". Two attempts to build one produced numbers that were
artifacts of unfittable priors rather than findings, and both are recorded here so the mistake
is not repeated:

  1. A single scalar elasticity gave "best tax falls with demand, to 0% for a busy launch".
     Replacing it with two-type knee demand moved the optimum to 0% almost everywhere. The
     conclusion changed completely and NEITHER parameterisation is fit to data, because this
     environment has no network access. The deterrence curve IS the model, so a model whose
     deterrence curve is a guess cannot recommend a rate. It can only report the region a
     recommendation would be stable over.

  2. Valuing an LP-recycled or burned tax by marking the operator's holdings at the end price
     is circular: the model inflated that price itself. In an early draft the LP "wealth"
     reduced algebraically to exactly 2E, at an end price 11,000x the start, and reported
     11,214 ETH. That is not a number about the world. Destinations are therefore reported in
     their own units — ETH withdrawn, depth added, supply removed — and never collapsed into
     one comparable figure.

WHAT IT DOES DO
---------------
  (1) two-type demand with a knee, snipers and organic, responding to opposite sides
  (2) the schedule as a path: unit, cap, turn-off — not just an intercept
  (3) three destinations kept in their own units
  (4) a Pareto size mix whose SCALE is elicited and whose SHAPE is a labelled guess
  (5) seed depth as a co-control
  (6) block batching, which decides who pays what under a per-buy ramp

Elicited (the operator has real intuition about these): expected first-hour volume, roughly
how it splits between bots and people, seed depth, pool fee, and the schedule itself.
Guessed (nobody here can fit these): every knee, the sharpness, and the tail exponents.
"""

from dataclasses import dataclass, replace
from typing import List, Tuple
import math

BPS = 10_000

#: Parameters no one in this environment can fit, named so the page can label them.
UNFITTABLE = (
    "snipe_buy_knee", "snipe_sell_knee", "org_buy_knee", "org_sell_knee",
    "sharpness", "snipe_alpha", "org_alpha", "snipe_share",
)


# ----------------------------------------------------------------- population

@dataclass(frozen=True)
class Population:
    """Two types, because they respond to opposite things.

    Snipers are close to unit-elastic in the BUY tax — a direct hit on a thin edge — and
    nearly inelastic in the SELL tax, because they intend to be out within minutes and price
    the round trip as one number. Organic buyers are the reverse: a buy tax reads as a fee,
    a sell tax reads as a trap, and the trap is what they refuse.

    Each type has a KNEE, not a slope. "Won't buy above 8%" is how a launch chat behaves:
    near zero the tax barely registers, past a threshold participation collapses. A linear
    fade makes every rate feel proportionally bad, which is what produced the first model's
    misleadingly smooth answer.

    SCALE IS ELICITED, SHAPE IS GUESSED. `volume_eth` is what the operator expects to trade
    in the first hour at zero tax — a quantity they have some intuition about. Everything
    else here is a prior with no data behind it.
    """
    volume_eth: float = 100.0      # elicited: expected first-hour volume at zero tax
    n_snipe: int = 40              # elicited-ish: how many bots
    n_organic: int = 360           # elicited-ish: how many people
    snipe_share: float = 0.70      # guess: fraction of that volume that is bots
    snipe_alpha: float = 1.8       # guess: tail exponent, bots
    org_alpha: float = 2.2         # guess: tail exponent, people
    snipe_buy_knee: float = 0.06   # guess
    snipe_sell_knee: float = 0.40  # guess
    org_buy_knee: float = 0.09     # guess
    org_sell_knee: float = 0.07    # guess
    sharpness: float = 6.0         # guess: how cliff-like the knee is


def participation(pressure: float, sharpness: float) -> float:
    """Fraction of a type still buying, given normalised tax pressure (1.0 == at the knee)."""
    if pressure <= 0:
        return 1.0
    x = sharpness * (pressure - 1.0)
    if x > 60:
        return 0.0
    if x < -60:
        return 1.0
    return 1.0 / (1.0 + math.exp(x))


def pareto_shape(n: int, alpha: float) -> List[float]:
    """Deterministic Pareto quantiles normalised to sum to 1, largest first.

    Only the SHAPE. The caller multiplies by an elicited total, so the uncalibrated parameter
    is the exponent alone and never the scale. An early draft got this backwards and produced
    a single 68.6 ETH buy into a 10 ETH pool.
    """
    if n <= 0:
        return []
    raw = [(1.0 - (i + 0.5) / n) ** (-1.0 / alpha) for i in range(n)]
    tot = sum(raw)
    out = [r / tot for r in raw]
    out.sort(reverse=True)
    return out


# ----------------------------------------------------------------- schedule

@dataclass(frozen=True)
class Schedule:
    unit: str = "volume"      # "buy" | "block" | "volume"
    start: float = 0.01
    step: float = 0.01
    step_unit: float = 1.0    # ETH per step, volume unit only
    cap: float = 0.10
    sell: float = 0.05
    off_after: float = 0.0    # units after which the ramp is off entirely; 0 = never
    per_block: int = 8        # buys per block, for the block unit and for batching


def tax_at(s: Schedule, buys: int, volume: float, block: int) -> float:
    if s.unit == "buy":
        u = float(buys)
    elif s.unit == "block":
        u = float(block)
    else:
        u = float(int(volume // s.step_unit))
    if s.off_after and u >= s.off_after:
        return 0.0
    return min(s.cap, s.start + s.step * u)


def mean_rate(s: Schedule, n_buys: int, total_volume: float) -> float:
    """The rate a buyer would reason about before deciding, averaged over the path."""
    if n_buys <= 0:
        return s.start
    per = total_volume / n_buys
    acc, vol = 0.0, 0.0
    for i in range(n_buys):
        acc += tax_at(s, i, vol, i // max(1, s.per_block))
        vol += per
    return acc / n_buys


# ----------------------------------------------------------------- the pool

def buy(E: float, T: float, spend: float, fee: float) -> Tuple[float, float, float]:
    a = spend * (1.0 - fee)
    out = T * a / (E + a)
    return E + spend, T - out, out


def sell(E: float, T: float, tokens: float, fee: float) -> Tuple[float, float, float]:
    a = tokens * (1.0 - fee)
    out = E * a / (T + a)
    return E - out, T + tokens, out


# ----------------------------------------------------------------- simulation

@dataclass(frozen=True)
class Result:
    buyers: int
    volume: float               # ETH that reached the pool
    treasury_eth: float         # realizable: ETH withdrawn to a wallet
    depth_added_eth: float      # lp destination: ETH left in the book as extra reserve
    supply_burned: float        # burn destination: fraction of pool supply destroyed
    price_multiple: float       # end price / start price
    avg_tax: float
    round_trip: float
    deterred: int               # buyers the tax removed


def simulate(pop: Population, sched: Schedule, seed_eth: float, pool_fee: float,
             destination: str = "treasury") -> Result:
    """Run one launch.

    `destination` decides where the tax goes, and the three are NOT comparable as one number:
      treasury — leaves as ETH. Reported as ETH, and it is realizable.
      lp       — stays in the pool as reserve, exactly the v2 fee mechanic. Reported as depth
                 added, in ETH. The operator realizes it only insofar as they later sell into
                 a deeper book, which this model does not price.
      burn     — swapped for tokens that are destroyed. Reported as supply removed. Its value
                 to the operator depends on a price this model moved, so it is not converted.

    Pool token supply is normalised to 1.0; every ETH quantity is unaffected by that choice.
    """
    # How many of each type still buy.
    #
    # A buyer does not price the tax in isolation — they price what the trade costs them:
    # the tax, the pool fee, and the impact of their own size against the depth on offer.
    # Impact is where SEED enters demand, and it is the only reason seed and tax are
    # substitutes: 10 ETH of depth with a 5% tax and 25 ETH with none can present the same
    # cost to the same buyer. An earlier draft left impact out, and seed then had no effect
    # on the recommendation at all — the co-control was a co-control in name only.
    probe = mean_rate(sched, pop.n_snipe + pop.n_organic, pop.volume_eth)
    size_s = (pop.volume_eth * pop.snipe_share) / max(1, pop.n_snipe)
    size_o = (pop.volume_eth * (1.0 - pop.snipe_share)) / max(1, pop.n_organic)
    #
    # Buy-side and sell-side are INDEPENDENT hurdles and compose multiplicatively. Adding the
    # two normalised pressures instead makes "at your buy knee and at your sell knee" read as
    # pressure 2.0 — near-total refusal — when it should be half of a half. An earlier draft
    # added them and deterred 399 of 400 buyers at ordinary rates.
    impact = lambda s: s / (seed_eth + s)
    p_s = (participation((probe + pool_fee + impact(size_s)) / max(pop.snipe_buy_knee, 1e-9),
                         pop.sharpness)
           * participation(sched.sell / max(pop.snipe_sell_knee, 1e-9), pop.sharpness))
    p_o = (participation((probe + pool_fee + impact(size_o)) / max(pop.org_buy_knee, 1e-9),
                         pop.sharpness)
           * participation(sched.sell / max(pop.org_sell_knee, 1e-9), pop.sharpness))
    n_s, n_o = int(round(pop.n_snipe * p_s)), int(round(pop.n_organic * p_o))
    deterred = (pop.n_snipe + pop.n_organic) - (n_s + n_o)
    # The round trip is arithmetic on the schedule, not a measurement of the launch, so it
    # holds whether or not anybody buys. Reporting 0.0 here would say "a buyer loses nothing"
    # about the schedule that deterred every single one of them — a failure dressed as a zero,
    # which is the one thing this codebase does not do anywhere else either.
    rt0 = 1.0 - (1.0 - sched.start) * (1.0 - pool_fee) ** 2 * (1.0 - sched.sell)
    if n_s + n_o == 0:
        return Result(0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, rt0, deterred)

    # Volume scales with participation, split by the elicited share. Shape from Pareto.
    v_s = pop.volume_eth * pop.snipe_share * p_s
    v_o = pop.volume_eth * (1.0 - pop.snipe_share) * p_o
    orders = ([(v_s * f, 0) for f in pareto_shape(n_s, pop.snipe_alpha)] +
              [(v_o * f, 1) for f in pareto_shape(n_o, pop.org_alpha)])
    orders.sort(key=lambda x: (x[1], -x[0]))   # bots first, largest first — that is the point

    E, T = seed_eth, 1.0
    start_price = E / T
    treasury = depth = burned = 0.0
    volume = 0.0
    held = 0.0
    tax_sum = 0.0

    for idx, (size, _kind) in enumerate(orders):
        t = tax_at(sched, idx, volume, idx // max(1, sched.per_block))
        tax = size * t
        E, T, out = buy(E, T, size - tax, pool_fee)
        held += out
        tax_sum += t
        volume += size - tax
        if destination == "treasury":
            treasury += tax
        elif destination == "lp":
            E += tax           # v2 fee mechanic: k grows, every later fill improves
            depth += tax
        elif destination == "burn" and tax > 0:
            E, T, bought = buy(E, T, tax, pool_fee)
            burned += bought   # left the pool and was destroyed

    # Everyone sells once — worst case for the sell side.
    if held > 0 and sched.sell > 0:
        E2, T2, gross = sell(E, T, held, pool_fee)
        take = gross * sched.sell
        if destination == "treasury":
            treasury += take
        elif destination == "lp":
            E2 += take
            depth += take
        E, T = E2, T2

    end_price = (E / T) if T > 0 else float("inf")
    rt = 1.0 - (1.0 - sched.start) * (1.0 - pool_fee) ** 2 * (1.0 - sched.sell)
    return Result(len(orders), volume, treasury, depth, burned,
                  end_price / start_price, tax_sum / max(1, len(orders)), rt, deterred)


# ----------------------------------------------------------------- the honest answer

def sweep_start(pop: Population, sched: Schedule, seed_eth: float, pool_fee: float,
                destination: str, lo: float = 0.0, hi: float = 0.25,
                step: float = 0.01) -> List[Tuple[float, Result]]:
    out, t = [], lo
    while t <= hi + 1e-9:
        out.append((t, simulate(pop, replace(sched, start=t), seed_eth, pool_fee, destination)))
        t += step
    return out


def objective(r: Result, destination: str) -> float:
    """The quantity each destination is optimised on, in ITS OWN units. Never compare across."""
    if destination == "treasury":
        return r.treasury_eth
    if destination == "lp":
        return r.depth_added_eth
    return r.supply_burned


def stable_region(pop: Population, sched: Schedule, seed_eth: float, pool_fee: float,
                  destination: str, tol: float = 0.05) -> Tuple[float, float, float]:
    """The band of starting rates within `tol` of the best, not the argmax.

    Reporting an argmax from a model whose deterrence curve is a guess implies a precision
    that does not exist. The band is the honest output: "anything in here is within 5% of the
    best this model can tell apart".
    """
    rows = sweep_start(pop, sched, seed_eth, pool_fee, destination)
    best = max(objective(r, destination) for _, r in rows)
    if best <= 0:
        return (0.0, 0.0, 0.0)
    good = [t for t, r in rows if objective(r, destination) >= best * (1.0 - tol)]
    return (min(good), max(good), best)


def knee_sensitivity(pop: Population, sched: Schedule, seed_eth: float, pool_fee: float,
                     destination: str = "treasury") -> List[Tuple[str, float, float]]:
    """How far the recommendation moves when each guessed knee is halved and doubled.

    If a parameter nobody can fit swings the answer across the whole range, the model has no
    recommendation to give and should say so instead of picking the midpoint.
    """
    out = []
    for name in ("snipe_buy_knee", "org_buy_knee", "org_sell_knee", "sharpness"):
        base = getattr(pop, name)
        lo_r = stable_region(replace(pop, **{name: base * 0.5}), sched, seed_eth,
                             pool_fee, destination)
        hi_r = stable_region(replace(pop, **{name: base * 2.0}), sched, seed_eth,
                             pool_fee, destination)
        out.append((name, lo_r[0], hi_r[1]))
    return out


# ----------------------------------------------------------------- path search

def search_path(pop: Population, seed_eth: float, pool_fee: float,
                destination: str = "treasury", seeds: List[float] = None):
    """Search the SCHEDULE and the SEED jointly, not the intercept alone.

    'Best start tax' answers the wrong question: it treats the ramp, its cap, its unit, its
    turn-off and the depth of the book as given. A 25% tax that dies in three blocks and a 1%
    tax that runs all launch are different objects, and so are the same schedule over 10 ETH
    and over 50 ETH of depth.

    Coarse by design. The deterrence parameters are guesses, so resolving the grid finer than
    the parameters are known resolves noise.
    """
    best, rows = None, []
    seed_grid = seeds if seeds is not None else [seed_eth]
    for unit in ("buy", "block", "volume"):
        for start in (0.0, 0.01, 0.02, 0.05, 0.10, 0.25):
            for step in (0.0, 0.01, 0.05):
                for cap in (start, max(start, 0.10), max(start, 0.25)):
                    for off in (0.0, 3.0, 10.0):
                        for sell in (0.0, 0.02, 0.05, 0.10):
                            for sd in seed_grid:
                                s = Schedule(unit=unit, start=start, step=step, cap=cap,
                                             off_after=off, sell=sell, step_unit=5.0)
                                r = simulate(pop, s, sd, pool_fee, destination)
                                v = objective(r, destination)
                                rows.append((v, s, sd, r))
                                if best is None or v > best[0]:
                                    best = (v, s, sd, r)
    rows.sort(key=lambda x: -x[0])
    return best, rows
