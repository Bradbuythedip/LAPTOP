"""Virtual liquidity, and what bonding at 10x actually costs.

THE CONSTRAINT THIS ANSWERS. Nobody can put real ETH behind every token on a permissionless
launchpad. So the curve starts with reserves that do not exist: E0 virtual ETH against T0
tokens, k = E0*T0. Buyers send REAL ETH and the curve prices against virtual + real. The real
ETH piles up in the contract. At a threshold the token BONDS: the real ETH and a token
allocation go into a real pool and the curve retires.

Everything below is a closed form with a numerical check beside it, because the two numbers
that matter — how deep the book feels, and how much money it takes to graduate — are the same
number pulling in opposite directions, and that is easy to get wrong in prose.

    python3 bond_model.py
"""
from math import sqrt

# ---------------------------------------------------------------------------- the curve

def tokens_out(dE, E, T, fee=0.0):
    """Constant product, fee taken off the ETH before it touches the curve."""
    e = dE * (1.0 - fee)
    return T - (E * T) / (E + e), e

def eth_out(dT, E, T, fee=0.0):
    """Selling tokens back. The ETH leaves the curve, so the fee comes off the way out."""
    out = E - (E * T) / (T + dT)
    return out * (1.0 - fee), out

def price(E, T):
    return E / T

# ---------------------------------------------------------- the four identities, derived

def eth_to_reach(m, E0):
    """Real ETH needed for the price to reach m times its starting value.

    price(R) = (E0+R)^2 / (E0*T0), price(0) = E0/T0, so the multiple is ((E0+R)/E0)^2.
    Setting that to m gives R = E0*(sqrt(m) - 1). The token side cancels entirely: how much
    money it takes to 10x is a fact about the VIRTUAL ETH ALONE.
    """
    return E0 * (sqrt(m) - 1.0)

def sold_fraction(m):
    """Fraction of the curve's tokens sold by the time it reaches m x. = 1 - 1/sqrt(m)."""
    return 1.0 - 1.0 / sqrt(m)

def seed_fraction(m):
    """Tokens needed to open the real pool AT the curve's closing price. = (sqrt(m)-1)/m."""
    return (sqrt(m) - 1.0) / m

def leftover_fraction(m):
    """What is left after seeding the real pool at the closing price.

    unsold = T0/sqrt(m); seed = T0*(sqrt(m)-1)/m; leftover = T0/sqrt(m) - T0*(sqrt(m)-1)/m
           = T0*[sqrt(m)/m - (sqrt(m)-1)/m] = T0/m.

    Exactly one m-th of the curve allocation, for every m. At a 10x bond that is 10% of the
    curve's tokens, and it is the only revenue the design produces that is not a fee.
    """
    return 1.0 / m

def impact(dE, E, fee=0.0):
    """Price impact of one buy, as a fraction. Only the ETH side matters.

    out = T - ET/(E+e); effective price = dE/out; spot = E/T.
    effective/spot - 1 works out to (E+e)/(E*(1-fee)) - 1, so it depends on dE/E and nothing
    else. That is why depth is entirely a choice of E0.
    """
    e = dE * (1.0 - fee)
    return (E + e) / (E * (1.0 - fee)) - 1.0

# ------------------------------------------------------------------- numerical checking

def simulate(E0, T0, m, fee=0.0, step=None):
    """Walk the curve in small buys until the price multiple reaches m. Returns what really
    happened, so the closed forms above have something to be wrong against."""
    E, T = E0, T0
    p0 = price(E, T)
    paid = fees = 0.0
    step = step or E0 / 2000.0
    guard = 0
    while price(E, T) / p0 < m and guard < 5_000_000:
        out, e = tokens_out(step, E, T, fee)
        E += e; T -= out
        paid += step; fees += step - e
        guard += 1
    return {"realEth": paid - fees, "fees": fees, "gross": paid,
            "soldFrac": (T0 - T) / T0, "multiple": price(E, T) / p0}

PASS = [0]
FAIL = [0]

def check(name, got, want, tol=2e-3):
    rel = abs(got - want) / max(1e-12, abs(want))
    good = rel <= tol
    (PASS if good else FAIL)[0] += 1
    print(f"  {'ok  ' if good else 'FAIL'} {name:<46} {got:.6f} vs {want:.6f}")
    return good

# --------------------------------------------------------------------------------- main

if __name__ == "__main__":
    print("── the closed forms, against a simulated walk up the curve\n")
    for m in (2, 4, 10, 25, 100):
        E0, T0 = 3.0, 1e9
        s = simulate(E0, T0, m)
        print(f"bond at {m}x")
        check("real ETH to get there = E0*(sqrt(m)-1)",
                         s["realEth"], eth_to_reach(m, E0))
        check("fraction of the curve sold = 1 - 1/sqrt(m)",
                         s["soldFrac"], sold_fraction(m))
        unsold = 1.0 - s["soldFrac"]
        check("leftover after seeding at close = 1/m",
                         unsold - seed_fraction(m), leftover_fraction(m))
        print()

    print("── the graduation gap: dumping every unsold token into the real pool\n")
    for m in (2, 10, 100):
        # all the ETH and ALL the unsold tokens -> the pool opens below where the curve closed
        gap = (sqrt(m) - 1.0) * sqrt(m) / m
        print(f"  bond at {m:>3}x: the real pool opens at {gap * 100:5.1f}% of the closing "
              f"price — an instant {100 - gap * 100:.0f}% gap down")
    print("\n  Seeding with only (sqrt(m)-1)/m of the supply opens it AT the closing price\n"
          "  and leaves exactly 1/m over. That leftover is the design's token revenue.\n")

    print("── depth against speed, which is one dial and not two\n")
    print(f"  {'virtual E0':>10} {'0.1 ETH':>9} {'0.5 ETH':>9} {'1 ETH':>9} {'5 ETH':>9}"
          f" {'to bond 10x':>13}")
    for E0 in (1, 3, 5, 10, 25):
        row = "  " + f"{E0:>8} ETH"
        for dE in (0.1, 0.5, 1.0, 5.0):
            row += f" {impact(dE, E0) * 100:8.2f}%"
        row += f" {eth_to_reach(10, E0):11.1f} ETH"
        print(row)
    print("\n  The same E0 sets both columns. Every point of slippage you remove is real ETH\n"
          "  somebody now has to spend before the token graduates. There is no setting that\n"
          "  is deep AND quick, and 'slippage is never an issue' is a promise about the left\n"
          "  half of this table that gets paid for in the right half.\n")

    print("── the fee, and what it costs in time-to-bond\n")
    E0, T0 = 3.0, 1e9
    base = simulate(E0, T0, 10, 0.0)["gross"]
    print(f"  {'fee':>5} {'gross ETH through the curve':>29} {'fee take':>10} {'vs 0%':>8}")
    for f in (0.00, 0.01, 0.02, 0.05):
        s = simulate(E0, T0, 10, f)
        print(f"  {f*100:4.0f}% {s['gross']:26.2f} ETH {s['fees']:8.3f} ETH"
              f" {(s['gross']/base - 1)*100:+7.1f}%")
    print("\n  A fee on the way in does not slow bonding much, because it is charged on a\n"
          "  quantity that is itself the thing being accumulated: at 5% the curve needs 5.3%\n"
          "  more gross volume, and the take is a clean 5% of it.\n")

    print("── what a fee-funded floor can and cannot do\n")
    for f in (0.01, 0.02, 0.05):
        s = simulate(3.0, 1e9, 10, f)
        real = s["realEth"]
        print(f"  at {f*100:2.0f}%: {s['fees']:.3f} ETH of fees against {real:.2f} ETH of real"
              f" reserves — {s['fees']/real*100:.1f}% of the book")
    print("\n  Fees cannot make the book deep. They are single-digit percentages of the ETH\n"
          "  that arrived. Depth before graduation is E0, and E0 is virtual: it is a pricing\n"
          "  parameter, not money. What fees CAN do is pay for the next thing.\n")

    print("── the one that is not arithmetic: virtual ETH is not ETH\n")
    E0, T0 = 3.0, 1e9
    E, T = E0, T0
    out, e = tokens_out(1.0, E, T)          # one buyer puts in 1 real ETH
    E += e; T -= out
    back, gross = eth_out(out, E, T)        # and immediately sells it all back
    held = e                                 # the contract only ever held the real ETH
    print(f"  buyer sends 1.000 ETH, receives {out/1e6:.2f}M tokens")
    print(f"  sells all of it straight back: the curve owes {gross:.6f} ETH")
    print(f"  the contract actually holds:   {held:.6f} ETH")
    good = gross <= held + 1e-12
    (PASS if good else FAIL)[0] += 1
    print(f"  {'ok  ' if good else 'FAIL'} a round trip never asks for more than came in")
    print("\n  That holds for one buyer. It holds for any sequence, because the curve is a\n"
          "  bijection between ETH in and tokens out — but ONLY while every token outstanding\n"
          "  came from the curve. Mint tokens anywhere else, or burn tokens on their way in,\n"
          "  and the accounting stops being a round trip. That is the thing to test.\n")

    print(f"\n{PASS[0]} passed, {FAIL[0]} failed")
    raise SystemExit(1 if FAIL[0] else 0)
