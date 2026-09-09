"""snooze.py — the one-file launch script, tested from outside itself.

`python3 snooze.py selftest` proves the arithmetic against published vectors, and it has to,
because the whole premise is that somebody downloads ONE FILE and runs it on a machine with
nothing else on it. This suite is the other half: it checks the things a self-test cannot
honestly check about itself, and it checks them against the rest of the repository.

  - That the Rule 3 arithmetic in Python is the SAME EXPRESSION as the Solidity, not a float
    model of it. contracts/Snooze.sol:dreamBetween is integer arithmetic and this file
    reimplements it; a rounding difference would put the site's number and the chain's number
    a wei apart in a way nobody could localise.
  - That the curve identities agree with bond_model.py, which derived them independently.
  - That the script cannot send, cannot sign, and reads its endpoint from the environment.
  - That the console page renders with no external reference of any kind.

    python3 test/test_snooze_py.py
"""
import io
import json
import os
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import bond_model as BM              # noqa: E402
import snooze as S                   # noqa: E402

P = F = 0


def ok(name, cond, extra=""):
    global P, F
    if cond:
        P += 1
        print("  ok   " + name)
    else:
        F += 1
        print("  FAIL " + name + (("\n         " + str(extra)) if extra else ""))


def eq(name, got, want):
    ok(name, got == want, f"got {got!r}, want {want!r}")


print("── rule 3: the same integer expression as the contract, not a model of it")
SRC = (ROOT / "contracts" / "Snooze.sol").read_text()
eq("contracts/Snooze.sol declares the 90-day ramp snooze.py assumes",
   "uint64 public constant RAMP = 90 days;" in SRC, True)
eq("and snooze.py uses the same number of seconds", S.RAMP, 90 * 86400)
# The Solidity, transcribed here from the contract rather than from snooze.py, so agreeing
# means two independent transcriptions of one expression agree.
def solidity_dream_between(bal, a0, a1):
    if bal == 0 or a1 <= a0:
        return 0
    r = 90 * 86400
    m0, m1 = min(a0, r), min(a1, r)
    x0, x1 = max(a0 - r, 0), max(a1 - r, 0)
    return (bal * ((m1 * m1 - m0 * m0) + 2 * r * (x1 - x0))) // (r * r)


mismatch = None
for bal in (0, 1, 10**9, 10**18, 10**26):
    for a0, a1 in [(0, 0), (0, 1), (0, S.RAMP // 2), (0, S.RAMP), (0, 2 * S.RAMP),
                   (S.RAMP, 2 * S.RAMP), (S.RAMP // 3, S.RAMP), (5, 7),
                   (2 * S.RAMP, 10 * S.RAMP), (S.RAMP - 1, S.RAMP + 1)]:
        if S.dream_between(bal, a0, a1) != solidity_dream_between(bal, a0, a1):
            mismatch = (bal, a0, a1)
ok("50 cases agree with the contract's expression to the base unit", mismatch is None, mismatch)

ONE = 10 ** 9                       # one SNOOZE, at the nine decimals both tokens use
eq("one SNOOZE for the full ramp is EXACTLY one DREAM, with no truncation",
   S.dream_between(ONE, 0, S.RAMP), ONE)
eq("the whole supply for the full ramp is exactly the whole supply",
   S.dream_between(10 ** 26, 0, S.RAMP), 10 ** 26)
eq("half the ramp is a quarter", S.dream_between(ONE, 0, S.RAMP // 2), ONE // 4)
eq("a third of it is a ninth", S.dream_between(ONE, 0, S.RAMP // 3), ONE // 9)
eq("twice the ramp is three times, not two", S.dream_between(ONE, 0, 2 * S.RAMP), 3 * ONE)
ok("accrual is additive across a split interval — settling early costs nothing",
   S.dream_between(ONE, 0, 1000) + S.dream_between(ONE, 1000, S.RAMP)
   <= S.dream_between(ONE, 0, S.RAMP)
   and S.dream_between(ONE, 0, S.RAMP)
   - (S.dream_between(ONE, 0, 1000) + S.dream_between(ONE, 1000, S.RAMP)) <= 1)
ok("it never goes backwards in time", all(
    S.dream_between(ONE, 0, t) <= S.dream_between(ONE, 0, t + 86400)
    for t in range(0, 4 * S.RAMP, S.RAMP // 7)))
# The one number the site puts on its own front page, computed the way the site computes it.
ok("the ratio helper agrees with the base-unit arithmetic", all(
    abs(S.dream_ratio(d) - S.dream_between(10 ** 18, 0, int(d * 86400)) / 10 ** 18) < 1e-15
    for d in (1, 7, 30, 45, 90, 180, 365)))

print("── the curve, against bond_model.py's independent derivation")
for m in (2.0, 4.0, 7.5625, 10.0, 20.0, 50.0):
    for e0 in (0.5, 2.0, 10.0):
        ok(f"eth_to_reach({m:g}x, E0={e0:g}) agrees with bond_model",
           abs(S.eth_to_reach(m, e0) - BM.eth_to_reach(m, e0)) < 1e-12)
    ok(f"sold_fraction({m:g}) agrees", abs(S.sold_fraction(m) - BM.sold_fraction(m)) < 1e-12)
    ok(f"leftover_fraction({m:g}) agrees",
       abs(S.leftover_fraction(m) - BM.leftover_fraction(m)) < 1e-12)
ok("price_multiple inverts eth_to_reach for every multiple tried",
   all(abs(S.price_multiple(S.eth_to_reach(m, 2.0), 2.0) - m) < 1e-9
       for m in (2.0, 4.0, 7.5625, 20.0)))
ok("a buy's share of the float depends on E0 alone, as SnoozeCurve.sol says",
   abs(S.corner_share(1.0, 3.0) - 0.25) < 1e-12
   and abs(S.corner_share(2.0, 6.0) - 0.25) < 1e-12)

print("── it agrees with the curve deploy/config.json actually ships")
cfg = S.load_config()
ok("config.json is the source, not the built-in fallback", "config.json" in cfg["_source"])
eq("virtualEth is 2 ETH", S.cfg_e0(cfg), 2.0)
eq("bondTarget is 3.5 ETH", S.cfg_bond(cfg), 3.5)
ok("which is a 7.5625x graduation, the number config.json's _relaunch note states",
   abs(S.price_multiple(3.5, 2.0) - 7.5625) < 1e-12)
ok("and leaves the launcher at 30.6% of supply, the other number it states",
   abs((S.cfg_owner_share(cfg)
        + (1 - S.cfg_owner_share(cfg)) * S.leftover_fraction(7.5625)) - 0.3058) < 0.0005)

print("── the optimizer: hard constraints are hard, and it says when it is on one")
a = S.Assumptions()
cands = S.optimize(a)
ok("it finds settings at all", len(cands) > 0)
ok("every one is under the corner ceiling",
   all(c["whale_takes"] <= a.max_corner + 1e-12 for c in cands))
ok("every one is under the launcher-share threshold",
   all(c["launcher"] <= a.flag_at + 1e-12 for c in cands))
ok("none of them is a same-hour DEX listing", all(c["m"] >= 2.0 for c in cands))
ok("tightening the ceiling never admits a setting the looser one refused",
   set((c["e0"], c["r"]) for c in S.optimize(S.Assumptions(max_corner=0.10)))
   <= set((c["e0"], c["r"]) for c in cands))
# The regression the scoring was rewritten for: a weighted SUM recommended E0 = 0.5 ETH, where
# one buyer with 1 ETH takes two-thirds of everything the curve will ever sell.
ok("it never again recommends a curve one buyer can take two-thirds of",
   all(c["whale_takes"] < 0.5 for c in cands))
ok("the frontier prices every ceiling", len(S.frontier(a)) == 6)
ok("and a tighter ceiling always costs virtual ETH", all(
   x["e0"] >= y["e0"] for x, y in zip(S.frontier(a), S.frontier(a)[1:])))
sh = S.score_params(2.0, 3.5, a)
ok("it reports the SHIPPED curve as breaching the 25% corner ceiling — a 1 ETH buy takes 33%",
   sh["whale_takes"] > a.max_corner)
ok("while clearing the launcher-share threshold", sh["launcher"] <= a.flag_at)

print("── rule 3's value: the simulation moves only through the parameter it names")
b0 = S.Behaviour(holders=300, days=120, dream_worth=0.0, seed=1)
eq("with DREAM worth nothing, the two worlds are the same run",
   S.simulate(b0, True)["series"], S.simulate(b0, False)["series"])
b1 = S.Behaviour(holders=300, days=120, dream_worth=0.5, seed=1)
ok("with DREAM worth something, more float survives",
   S.simulate(b1, True)["final"] > S.simulate(b1, False)["final"])
ok("breaking a 90-day streak costs exactly dream_worth per SNOOZE at a 90-day look-ahead",
   abs(S.streak_cost(90, b1) - 0.5) < 1e-12)
ok("breaking a brand-new streak costs nothing", S.streak_cost(0, b1) == 0.0)
# Non-decreasing, with a tolerance, because past the ramp it does not rise at all — it is
# FLAT, and the flat part is float noise on an integer division rather than a trend. That
# plateau is the real property and it is asserted separately below.
ok("the cost never falls as a streak lengthens", all(
   S.streak_cost(d, b1) <= S.streak_cost(d + 10, b1) + 1e-9 for d in range(0, 360, 10)))
ok("and past the ramp it is exactly flat at dream_worth per SNOOZE — keeping a matured "
   "streak beats restarting one by exactly 2x - 1x, forever", all(
   abs(S.streak_cost(d, b1) - b1.dream_worth) < 1e-9 for d in (90, 135, 180, 365, 900)))

print("── it cannot send, cannot sign, and will not take an endpoint from argv")
ok("the read allowlist is exactly eight methods", len(S.Rpc.ALLOWED) == 8)
for m in ("eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "eth_signTransaction",
          "personal_sign", "personal_unlockAccount", "eth_accounts", "miner_start"):
    try:
        S.Rpc("https://example.invalid").send(m)
        ok(f"{m} is refused", False, "it was not")
    except ValueError:
        ok(f"{m} is refused before a socket is opened", True)
    except Exception as e:
        ok(f"{m} is refused", False, e)
ok("every allowlisted method is a read",
   all(not m.startswith(("eth_send", "eth_sign", "personal_", "miner_", "debug_"))
       for m in S.Rpc.ALLOWED))
HELP = io.StringIO()
try:
    with redirect_stdout(HELP):
        S.main(["--help"])
except SystemExit:
    pass
# The FLAGS, not the prose. The epilog explains at length that there is deliberately no
# --rpc, and a substring search over the whole help text reads that explanation as a
# violation — the same mistake snooze.py's own self-test made grepping itself for "secp256k1".
FLAGS = set(re.findall(r"^\s+(--[a-z][a-z-]*)", HELP.getvalue(), re.M))
ok("no flag takes an endpoint, a key, a mnemonic or a keystore",
   not (FLAGS & {"--rpc", "--endpoint", "--key", "--private-key", "--mnemonic",
                 "--keystore", "--send", "--sign"}), sorted(FLAGS))
ok("and it does offer the flags it documents", {"--whale", "--corner-ceiling"} <= FLAGS,
   sorted(FLAGS))
ok("and says where the endpoint does come from", "SNOOZE_RPC" in HELP.getvalue())
os.environ.pop("SNOOZE_RPC", None)
try:
    S.Rpc().send("eth_chainId")
    ok("with no SNOOZE_RPC it refuses rather than guessing an endpoint", False)
except RuntimeError as e:
    ok("with no SNOOZE_RPC it refuses rather than guessing an endpoint", "SNOOZE_RPC" in str(e))
ok("a keyed endpoint is never printed back — errors carry the host only",
   S.Rpc("https://example.com/v2/SECRETKEY").host == "example.com")

print("── the console page: self-contained, and honest about what it draws")
data = S.console_data(cfg, a)
page = S.CONSOLE_HTML.replace("%%DATA%%", json.dumps(data))
ok("it renders with the data substituted", "%%DATA%%" not in page and len(page) > 5000)
ok("it references no external origin at all",
   not re.search(r"""(?:src|href)\s*=\s*["']\s*(?:https?:)?//""", page), 
   re.findall(r"""(?:src|href)\s*=\s*["'][^"']*""", page)[:3])
ok("no fetch, no XHR, no websocket", not re.search(r"\bfetch\s*\(|XMLHttpRequest|WebSocket", page))
ok("the chart says it is arithmetic, inside the frame",
   page.count("this is arithmetic, not a market") == 2)
ok("both charts are drawn from closed forms, and there is no market series",
   "marketSeries" not in page and len(data["curve"]["series"]) > 2
   and len(data["dream"]["series"]) > 2)
ok("the curve it draws is the one config.json ships",
   abs(data["curve"]["e0"] - S.cfg_e0(cfg)) < 1e-12
   and abs(data["curve"]["bondAt"] - S.cfg_bond(cfg)) < 1e-12)
ok("the DREAM curve reaches exactly 1.0 at the ramp",
   any(abs(d - cfg["dream"]["rampDays"]) < 1e-9 and abs(r - 1.0) < 1e-12
       for d, r in data["dream"]["series"]))
ok("the page states the shipped curve's constraint breach rather than hiding it",
   len(data["opt"]["shipped"]["breaches"]) == 1)
ok("and prints every assumption the ranking used", len(data["opt"]["assumptions"]) == 7)
ok("all six launch steps are on it", len(data["steps"]) == 6)
ok("every step says what it makes permanent",
   all(s["permanent"] for s in data["steps"]))

print("── and its own self-test passes, which is what a downloaded copy can run")
buf = io.StringIO()
with redirect_stdout(buf):
    rc = S.cmd_selftest(cfg, a, None)
ok("snooze.py selftest exits clean", rc == 0)
ok("with no failures in it", "FAIL" not in buf.getvalue(),
   [l for l in buf.getvalue().splitlines() if "FAIL" in l][:3])
m = re.search(r"(\d+) checks, all passed", buf.getvalue())
ok("and runs a real number of checks", bool(m) and int(m.group(1)) >= 40,
   buf.getvalue()[-200:])

print(f"\n{P} passed, {F} failed")
sys.exit(1 if F else 0)
