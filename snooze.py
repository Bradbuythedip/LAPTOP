#!/usr/bin/env python3
"""snooze.py — the $SNOOZE launch, in one file you can read before you run it.

    curl -O https://snoozebear.xyz/snooze.py
    python3 snooze.py                 # the deploy console, in your browser
    python3 snooze.py --help          # everything else

WHAT IT IS. One file, standard library only, no pip install, no node, no wallet library. It
opens a local console that walks the six-step launch, draws the two curves the whole design
rests on, and solves for the parameters before you make any of them immutable.

WHAT IT REFUSES TO DO, and these are load-bearing rather than cautious:

  IT NEVER TOUCHES A PRIVATE KEY. There is no --key, no keystore reader, no mnemonic prompt,
  no signing code and no import that could sign. It builds {to, data, value} and your wallet
  signs it. A key pasted into a script is a key you have given away, and the fact that this
  one is short and readable is not a reason to trust it with one — read the RPC allowlist in
  `Rpc.ALLOWED` and note that no method on it can send a transaction.

  IT NEVER PUTS THE ENDPOINT ON THE COMMAND LINE. `SNOOZE_RPC` comes from the environment and
  nowhere else, because an argv lands in your shell history and in /proc/<pid>/cmdline where
  every other process on the machine can read it. Nothing here ever prints it back.

  IT DOES NOT MAKE THE PRICE GO UP, AND NOTHING CAN. `optimize` is not a pump button. What it
  does is search the parameter space for settings that do not GUARANTEE a bad launch — a
  curve one buyer can corner, a graduation nobody can afford to reach, a launcher share every
  scanner flags — and print the trade-off it is making, because there is no setting that is
  best at all of them at once and a tool that hides that is lying to you.

  IT DOES NOT TRADE, AND WILL NOT BE MADE TO. There is no order placement here, no multi-
  wallet fleet, no volume generation and no scheduler that buys from itself to draw a shape
  on a chart. Those exist and they are what "launch tooling" usually means. Manufactured
  volume works by convincing somebody the demand is real, which makes the person on the other
  side of it the product; this file's entire premise is the opposite one, so it has none of
  it and takes none of it as a plugin.

THE ONE THING THAT ACTUALLY RAISES THE FLOOR is Rule 3 — holders are paid for not selling, in
an equivalent token, with no lock and no staking transaction. `simulate` models what that is
worth under assumptions it names out loud. Read them; they are guesses, and they are the
difference between the two numbers it prints.
"""
from __future__ import annotations

import argparse
import ast
import http.server
import json
import math
import os
import random
import socketserver
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

VERSION = "1.0.0"
HERE = Path(__file__).resolve().parent

# ─────────────────────────────────────────────────────────────────────── keccak-256
#
# Written out rather than imported, for the same reason deploy/scripts/lib/abi.mjs writes out
# its ABI coder: a library's bug in this position is indistinguishable from a bug in the
# contract, and what it would produce is a correct-looking address holding the wrong parameter
# forever. `selftest` checks it against the empty string, "abc", and two real selectors.

_RC = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)
_ROT = ((0, 36, 3, 41, 18), (1, 44, 10, 45, 2), (62, 6, 43, 15, 61),
        (28, 55, 25, 21, 56), (27, 20, 39, 8, 14))
_M64 = (1 << 64) - 1


def _rotl(x: int, n: int) -> int:
    n &= 63
    return ((x << n) | (x >> (64 - n))) & _M64


def _keccak_f(a: list[list[int]]) -> None:
    for rnd in range(24):
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rotl(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rotl(a[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y] & _M64) & b[(x + 2) % 5][y])
        a[0][0] ^= _RC[rnd]


def keccak256(data: bytes) -> bytes:
    """Keccak-256 — the original padding (0x01), not SHA3-256's (0x06)."""
    rate = 136
    a = [[0] * 5 for _ in range(5)]
    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % rate != 0:
        padded.append(0x00)
    padded[-1] ^= 0x80
    for off in range(0, len(padded), rate):
        block = padded[off:off + rate]
        for i in range(rate // 8):
            lane = int.from_bytes(block[i * 8:i * 8 + 8], "little")
            a[i % 5][i // 5] ^= lane
        _keccak_f(a)
    out = bytearray()
    for i in range(4):
        out += a[i % 5][i // 5].to_bytes(8, "little")
    return bytes(out)


# ────────────────────────────────────────────────────────────── ABI and addresses

def selector(sig: str) -> str:
    return "0x" + keccak256(sig.encode()).hex()[:8]


def word(v) -> str:
    """One 32-byte ABI word. Addresses left-pad, integers left-pad, both to 64 hex chars."""
    if isinstance(v, str):
        h = v.lower().removeprefix("0x")
        if not h:
            h = "0"
        int(h, 16)                       # a malformed address is a wrong immutable, not a typo
        return h.rjust(64, "0")
    v = int(v)
    if v < 0 or v >= (1 << 256):
        raise ValueError("does not fit a uint256: %d" % v)
    return format(v, "064x")


def checksum(addr: str) -> str:
    """EIP-55. The form a block explorer shows, so a mismatch is visible by eye."""
    h = addr.lower().removeprefix("0x")
    d = keccak256(h.encode()).hex()
    return "0x" + "".join(c.upper() if c.isalpha() and int(d[i], 16) >= 8 else c
                          for i, c in enumerate(h))


def _rlp(item) -> bytes:
    if isinstance(item, list):
        body = b"".join(_rlp(x) for x in item)
        if len(body) <= 55:
            return bytes([0xC0 + len(body)]) + body
        n = len(body).to_bytes((len(body).bit_length() + 7) // 8, "big")
        return bytes([0xF7 + len(n)]) + n + body
    if len(item) == 1 and item[0] < 0x80:
        return item
    if len(item) <= 55:
        return bytes([0x80 + len(item)]) + item
    n = len(item).to_bytes((len(item).bit_length() + 7) // 8, "big")
    return bytes([0xB7 + len(n)]) + n + item


def create_address(sender: str, nonce: int) -> str:
    """keccak(rlp([sender, nonce]))[12:]. The deployed BYTES do not enter into it, which is
    why every plain deployment's address is knowable before a wei is spent."""
    s = bytes.fromhex(sender.lower().removeprefix("0x"))
    n = b"" if nonce == 0 else nonce.to_bytes((nonce.bit_length() + 7) // 8, "big")
    return checksum(keccak256(_rlp([s, n]))[12:].hex())


def create2_address(deployer: str, salt: str, init_code_hash: str) -> str:
    pre = (b"\xff"
           + bytes.fromhex(deployer.lower().removeprefix("0x"))
           + bytes.fromhex(salt.lower().removeprefix("0x").rjust(64, "0"))
           + bytes.fromhex(init_code_hash.lower().removeprefix("0x")))
    return checksum(keccak256(pre)[12:].hex())


# ─────────────────────────────────────────────────────────────── the curve, exactly
#
# Ported from bond_model.py and from contracts/SnoozeCurve.sol, which agree. The token side
# cancels out of every one of these, which is the single most useful fact about the design:
# how much money it takes to Nx is a fact about the VIRTUAL ETH ALONE.

def price_multiple(raised: float, e0: float) -> float:
    """((E0+R)/E0)^2. SnoozeCurve.priceMultipleBps() in bps; this in multiples."""
    if e0 <= 0:
        return 1.0
    return ((e0 + max(0.0, raised)) / e0) ** 2


def eth_to_reach(m: float, e0: float) -> float:
    """Real ETH for the price to reach m x its start. E0*(sqrt(m)-1)."""
    return e0 * (math.sqrt(m) - 1.0)


def sold_fraction(m: float) -> float:
    """Fraction of the curve's allocation sold by multiple m. 1 - 1/sqrt(m)."""
    return 1.0 - 1.0 / math.sqrt(m)


def leftover_fraction(m: float) -> float:
    """What comes back to feeTo at graduation. Exactly 1/m, for every m."""
    return 1.0 / m


def corner_share(buy_eth: float, e0: float) -> float:
    """The share of everything the curve will EVER sell that one buy of `buy_eth` takes.

    b/(E0+b). The token side cancels, so this depends on the virtual ETH and on nothing else
    — not on supply, not on the bond target, not on how many people are watching.
    """
    return buy_eth / (e0 + buy_eth)


# ────────────────────────────────────────────────────────── rule 3, exactly as deployed
#
# Integer arithmetic, matching contracts/Snooze.sol:dreamBetween word for word. Not a model of
# it and not a float approximation of it: the same expression, so a disagreement between this
# file and the chain is a bug in one of two places rather than a rounding difference nobody
# can localise. `selftest` checks the identity the whole mechanic is sold on.

RAMP = 90 * 86400          # contracts/Snooze.sol: RAMP. 7,776,000 seconds.


def dream_between(bal: int, a0: int, a1: int) -> int:
    """DREAM base units accrued by `bal` SNOOZE base units held from streak-age a0 to a1."""
    if bal == 0 or a1 <= a0:
        return 0
    r = RAMP
    m0 = a0 if a0 < r else r
    m1 = a1 if a1 < r else r
    x0 = a0 - r if a0 > r else 0
    x1 = a1 - r if a1 > r else 0
    return (bal * ((m1 * m1 - m0 * m0) + 2 * r * (x1 - x0))) // (r * r)


def dream_ratio(days: float) -> float:
    """DREAM per SNOOZE after `days` of unbroken holding. 1.0 at the ramp, by construction."""
    a = int(days * 86400)
    return dream_between(10 ** 18, 0, a) / 10 ** 18


# ───────────────────────────────────────────────────────────────────── the optimizer
#
# "Make it go as high as possible" has no setting, and the honest version of the request is
# "do not ship a parameter set that guarantees it will not". These four scores are the ways a
# curve launch is dead on arrival before anybody has decided whether they like it, and the
# thing worth knowing about them is that NO SETTING IS BEST AT ALL FOUR — corner resistance
# and graduation speed are the same dial pulling in opposite directions, and this file cannot
# make that untrue. What it can do is show you the whole frontier and say which trade it made.

# THREE SOFT SCORES, AND THEY WERE FOUR. The fourth was `flag`, on the launcher's end share —
# which is 0.2 + 0.8/m, a monotone function of the graduation multiple, exactly like `mult`.
# Scoring both put a weight of 0.40 on m against 0.30 on whether the raise was plausible at
# all, and the search did the obvious thing: it pinned the bond target to the TOP OF THE GRID,
# 30 ETH, because a bigger raise always bought more of the double-counted axis than it cost.
# The launcher share is now a disqualifier and nothing else, which is what it always was.
# THE SCORE IS A PRODUCT, NOT A SUM, and getting there took two corrections worth recording
# because both are ways a weighted sum of plausible-looking terms produces nonsense.
#
#   1. `flag`, on the launcher's end share, was a fourth score. But the launcher share is
#      0.2 + 0.8/m — a monotone function of the graduation multiple, which is exactly what
#      `mult` already scored. Weighting both put 0.40 on m against 0.30 on whether the raise
#      was plausible at all, and the search pinned the bond target to the top of the grid. It
#      is a disqualifier now and nothing else, which is what it always was.
#
#   2. Even then it stayed pinned. `reach` was 1/(1+(R/ref)^2), which for a large raise is
#      already so near zero that going from 15 ETH to 30 costs almost nothing while `mult`
#      kept paying. A SUM LETS A TERM THAT HAS RUN OUT OF ROOM STOP OBJECTING.
#
# So: `reach` is a PROBABILITY and the other two are a VALUE, and what you want is the
# product. A graduation multiple you only reach in a world that does not arrive is worth its
# multiple times zero, and no weighting of a sum can ever say that.
WEIGHTS = {"corner": 0.60, "mult": 0.40}


class Assumptions:
    """Every guess in the optimizer, in one object, so `optimize` can print them all.

    Each of these is a judgment call and none of them is measured. The ranking is exactly as
    good as they are, which is why they are arguments rather than constants buried in a
    function — change them and the recommendation changes, and that is not a bug.
    """

    def __init__(self, whale_eth=1.0, reach_ref=5.0, reach_alpha=2.0,
                 flag_at=0.40, mult_ref=20.0, owner_share=0.20, max_corner=0.25):
        self.whale_eth = whale_eth      # the buy size "cornering" is measured against
        self.reach_ref = reach_ref      # the raise you would call a coin flip, in ETH
        self.reach_alpha = reach_alpha  # how fast plausibility falls off past it
        self.flag_at = flag_at          # launcher share at which scanners start flagging
        self.mult_ref = mult_ref        # the graduation multiple scored as "as high as useful"
        self.owner_share = owner_share  # supply NOT in the curve. config: 1 - 8e25/1e26
        # A HARD CONSTRAINT, and it started as a soft score. Weighted against the other three
        # it recommended E0 = 0.5 ETH — a 25x graduation off a 2 ETH raise, a 23% launcher
        # share, every soft term happy, and ONE BUYER WITH ONE ETH TAKING TWO-THIRDS OF THE
        # FLOAT. That is not a curve with a weakness, it is a private sale with extra steps,
        # and no weighting of a linear penalty stops a search finding it. Cornering is a
        # disqualifier or it is nothing.
        self.max_corner = max_corner

    def rows(self):
        return [
            ("whale buy size", f"{self.whale_eth:g} ETH",
             "one buy this big is what 'cornering' is measured against"),
            ("coin-flip raise", f"{self.reach_ref:g} ETH",
             "the real ETH you would give even odds of arriving"),
            ("falloff", f"{self.reach_alpha:g}",
             "how fast plausibility drops past it; 2 is a guess"),
            ("flagged above", f"{self.flag_at:.0%}",
             "launcher end share at which a scanner calls it a rug risk"),
            ("multiple ceiling", f"{self.mult_ref:g}x",
             "graduation multiple beyond which more stops helping"),
            ("owner share", f"{self.owner_share:.0%}",
             "supply outside the curve; deploy/config.json's curveSupply decides it"),
            ("corner ceiling", f"{self.max_corner:.0%}",
             "HARD: the most of the float one whale-sized buy may take. Not a score."),
        ]


def score_params(e0: float, r: float, a: Assumptions) -> dict:
    """Score one (virtualEth, bondTarget) pair. Every term is in [0, 1] and named."""
    m = price_multiple(r, e0)
    launcher = a.owner_share + (1.0 - a.owner_share) * leftover_fraction(m)
    takes = corner_share(a.whale_eth, e0)
    # Margin BELOW the ceiling, not 1 - takes. Every surviving candidate is already under the
    # ceiling, so 1 - takes only ever varies over the last quarter of its range and barely
    # discriminates; the margin uses the whole of it.
    corner = max(0.0, (a.max_corner - takes) / a.max_corner)
    reach = 1.0 / (1.0 + (r / a.reach_ref) ** a.reach_alpha)
    # Saturating, because past the point where a graduation is comfortably big, more multiple
    # is bought entirely with a bigger raise and `reach` is the thing paying for it.
    mult = max(0.0, min(1.0, math.log(m) / math.log(a.mult_ref))) if m > 1 else 0.0
    total = reach * (WEIGHTS["corner"] * corner + WEIGHTS["mult"] * mult)
    return {"e0": e0, "r": r, "m": m, "launcher": launcher, "corner": corner,
            "reach": reach, "mult": mult, "score": total, "whale_takes": takes,
            "sold_at_bond": sold_fraction(m), "leftover": leftover_fraction(m)}


def optimize(a: Assumptions, e0_range=None, r_range=None) -> list[dict]:
    """Grid search, because the space is two-dimensional and small enough to enumerate.

    A gradient method here would be a way of not showing you the surface, and the surface is
    the answer: the top of it is a long flat ridge, not a peak, and which end of the ridge you
    want is a decision about your launch rather than a fact about the arithmetic.
    """
    e0s = e0_range or [round(x * 0.5, 2) for x in range(1, 61)]      # 0.5 .. 30 ETH
    rs = r_range or [round(x * 0.25, 2) for x in range(1, 121)]      # 0.25 .. 30 ETH
    out = []
    for e0 in e0s:
        for r in rs:
            s = score_params(e0, r, a)
            if s["m"] < 2.0:            # a DEX listing within the hour is not a launch
                continue
            if s["launcher"] > a.flag_at:
                continue
            if s["whale_takes"] > a.max_corner:
                continue
            out.append(s)
    out.sort(key=lambda s: -s["score"])
    return out


# ───────────────────────────────────────────────────────────── what rule 3 is worth
#
# The only mechanism in this launch that pays somebody for staying, and therefore the only one
# whose value can be stated as a number rather than as a hope. The number below is NOT a price
# and NOT a prediction. It is: under a named model of how holders decide to sell, how much
# more of the float is still held at day D when breaking a streak costs something.
#
# The model is deliberately crude and every parameter is printed beside the answer, because a
# simulation whose assumptions are not on the same screen as its output is a way of laundering
# a guess into a figure.

class Behaviour:
    """How a holder decides to sell, and what DREAM is assumed to be worth to them."""

    def __init__(self, holders=2000, days=180, hazard=0.02, dream_worth=0.35,
                 horizon=90, seed=8453):
        self.holders = holders          # wallets in the simulation
        self.days = days                # how long to run it
        self.hazard = hazard            # daily probability of WANTING to sell, per holder
        self.dream_worth = dream_worth  # a DREAM valued at this fraction of a SNOOZE. A GUESS.
        self.horizon = horizon          # how far ahead a holder looks when valuing the ramp
        self.seed = seed

    def rows(self):
        return [
            ("holders", f"{self.holders:,}", "wallets, all entering on day 0"),
            ("days", f"{self.days}", "length of the run"),
            ("sell impulse", f"{self.hazard:.0%}/day",
             "chance a given holder WANTS out on a given day"),
            ("DREAM is worth", f"{self.dream_worth:.0%} of a SNOOZE",
             "THE LOAD-BEARING GUESS. At 0 the two worlds are identical."),
            ("look-ahead", f"{self.horizon} days",
             "how far ahead a holder values the ramp they would forfeit"),
        ]


def streak_cost(age_days: float, b: Behaviour) -> float:
    """What breaking a streak costs, in SNOOZE-equivalents per SNOOZE held.

    Keep the streak and over the next H days you accrue ratio(a+H) - ratio(a). Break it and
    you accrue ratio(H) from zero. The difference is what the break costs, priced at
    `dream_worth`. At a 90-day streak with a 90-day look-ahead that is exactly 3 - 1 - 1 = 1
    SNOOZE-equivalent per SNOOZE, which is the sharpest way to say what the ramp is for.
    """
    keep = dream_ratio(age_days + b.horizon) - dream_ratio(age_days)
    restart = dream_ratio(b.horizon)
    return max(0.0, (keep - restart)) * b.dream_worth


def simulate(b: Behaviour, rule3: bool) -> dict:
    """Monte Carlo over holders. Returns the fraction of the float still held, by day."""
    rng = random.Random(b.seed)
    age = [0.0] * b.holders          # streak age in days
    held = [True] * b.holders
    series = []
    for day in range(b.days + 1):
        alive = 0
        for i in range(b.holders):
            if not held[i]:
                continue
            alive += 1
            if rng.random() < b.hazard:
                # An impulse to sell, with a private urgency. Exponential(1) so that a
                # meaningful fraction of impulses are worth more than any reward.
                urgency = rng.expovariate(1.0)
                cost = streak_cost(age[i], b) if rule3 else 0.0
                if urgency > cost:
                    held[i] = False
                    alive -= 1
                    continue
            age[i] += 1.0
        series.append(alive / b.holders)
    return {"series": series, "final": series[-1],
            "d90": series[min(90, b.days)], "rule3": rule3}


def compare(b: Behaviour) -> dict:
    """Both worlds, and the only honest summary of the difference: a RATIO.

    The absolute retention is almost entirely the hazard rate, which is a guess; what survives
    changing that guess is how much MORE float is still held when breaking a streak costs
    something. That is the number Rule 3 is responsible for.
    """
    on, off = simulate(b, True), simulate(b, False)
    return {
        "on": on, "off": off,
        "d90_lift": (on["d90"] / off["d90"]) if off["d90"] > 0 else float("inf"),
        "final_lift": (on["final"] / off["final"]) if off["final"] > 0 else float("inf"),
    }


def frontier(a: Assumptions, ceilings=(0.10, 0.15, 0.20, 0.25, 0.33, 0.50)) -> list[dict]:
    """The best setting at each corner ceiling, which is the shape of the real decision.

    There is no setting that is both hard to corner and quick to graduate — SnoozeCurve.sol
    says so in its own comments and deploy/config.json's `_relaunch` note says it again with
    arithmetic. So the useful output is not one answer, it is the price of each answer.
    """
    rows = []
    for c in ceilings:
        aa = Assumptions(a.whale_eth, a.reach_ref, a.reach_alpha, a.flag_at,
                         a.mult_ref, a.owner_share, c)
        best = optimize(aa)
        if best:
            r = dict(best[0]); r["ceiling"] = c
            rows.append(r)
    return rows


# ────────────────────────────────────────────────────────────────────────── config
#
# deploy/config.json when it is beside this file, and these otherwise. The embedded copy is
# what makes the script usable on its own — downloaded to an empty directory it still models,
# still draws, still verifies a live launch. What it cannot do without the repository is BUILD
# a deployment, because that needs the compiled bytecode, and a 40KB blob pasted into a script
# is a thing nobody checks against the source it claims to be.

DEFAULT_CONFIG = {
    "chainId": 8453, "chain": "base", "site": "snoozebear.xyz",
    "owner": "0x4296e9A65582358221EEd0e9A2B4EC94ad4F5929",
    "fees": {"curveFeeTo": "0x4296e9A65582358221EEd0e9A2B4EC94ad4F5929"},
    "token": {"name": "Snooze Bear", "symbol": "SNOOZE", "decimals": 9,
              "supply": "100000000000000000000000000", "devBps": 0,
              "dev": "0x0000000000000000000000000000000000000000", "ownerExempt": True},
    "curve": {"virtualEth": "2000000000000000000", "bondTarget": "3500000000000000000",
              "feeBps": 100, "curveSupply": "80000000000000000000000000",
              "factory": "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
              "weth": "0x4200000000000000000000000000000000000006",
              "lpTo": "0x000000000000000000000000000000000000dEaD"},
    "oracle": {"choice": "never-ready", "address": ""},
    "dream": {"symbol": "DREAM", "decimals": 9, "rampDays": 90},
}
WEI = 10 ** 18


def load_config() -> dict:
    for p in (HERE / "deploy" / "config.json", HERE / "config.json"):
        if p.is_file():
            cfg = json.loads(p.read_text())
            cfg.setdefault("dream", DEFAULT_CONFIG["dream"])
            cfg["_source"] = str(p)
            return cfg
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    cfg["_source"] = "built into snooze.py (no deploy/config.json beside it)"
    return cfg


def cfg_e0(cfg) -> float:
    return int(cfg["curve"]["virtualEth"]) / WEI


def cfg_bond(cfg) -> float:
    return int(cfg["curve"]["bondTarget"]) / WEI


def cfg_owner_share(cfg) -> float:
    return 1.0 - int(cfg["curve"]["curveSupply"]) / int(cfg["token"]["supply"])


# ──────────────────────────────────────────────────────────────────── read-only RPC

class Rpc:
    """Eight read methods, and there is no ninth.

    The allowlist is the security property, not a convenience: a client that CANNOT send is a
    different object from one that merely does not. `eth_sendRawTransaction`,
    `eth_sendTransaction`, `eth_sign`, `personal_*` and `eth_accounts` are absent, and calling
    `send` with anything outside the set raises before a socket is opened.
    """

    ALLOWED = frozenset((
        "eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode", "eth_getBalance",
        "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getStorageAt",
    ))

    def __init__(self, url: str | None = None):
        self.url = url or os.environ.get("SNOOZE_RPC", "")
        self._id = 0

    @property
    def host(self) -> str:
        """The host and nothing else. A keyed endpoint's key is in the path or the query, and
        Python attaches the whole URL to a URLError, so one print of an exception publishes it
        to a terminal log. Errors here carry this."""
        if not self.url:
            return "(unset)"
        try:
            return urllib.parse.urlsplit(self.url).hostname or "(unparseable)"
        except Exception:
            return "(unparseable)"

    def send(self, method: str, params=None):
        if method not in self.ALLOWED:
            raise ValueError("%s is not on the read allowlist" % method)
        if not self.url:
            raise RuntimeError(
                "SNOOZE_RPC is not set. Export it — never pass it as an argument:\n"
                "    export SNOOZE_RPC=https://mainnet.base.org")
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id,
                           "method": method, "params": params or []}).encode()
        req = urllib.request.Request(self.url, data=body,
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                out = json.loads(r.read())
        except urllib.error.URLError as e:
            raise RuntimeError("RPC to %s failed: %s" % (self.host, e.reason)) from None
        except Exception:
            raise RuntimeError("RPC to %s failed" % self.host) from None
        if "error" in out:
            raise RuntimeError("RPC to %s returned an error: %s"
                               % (self.host, out["error"].get("message", "?")))
        return out.get("result")

    def call(self, to: str, data: str) -> str:
        return self.send("eth_call", [{"to": to, "data": data}, "latest"])

    def code_at(self, addr: str) -> str:
        return self.send("eth_getCode", [addr, "latest"])

    def nonce(self, addr: str) -> int:
        return int(self.send("eth_getTransactionCount", [addr, "latest"]), 16)


def read_uint(hexdata: str, i: int = 0) -> int:
    h = (hexdata or "0x").removeprefix("0x")
    chunk = h[i * 64:(i + 1) * 64]
    return int(chunk, 16) if len(chunk) == 64 else 0


# ─────────────────────────────────────────────────────────────────────── the six steps
#
# The same six as deploy/scripts/lib/steps.mjs, as data. What each one makes PERMANENT is the
# field worth reading: a launch is a sequence of one-way doors and the cost of finding that out
# afterwards is a relaunch, which this project has already done once.

STEPS = [
    {"n": 1, "id": "oracle", "title": "The oracle",
     "permanent": ["The oracle address becomes immutable on the token in step 3.",
                   "A settable oracle is a dial that sets every sale's burn, held forever by "
                   "whoever holds its key.",
                   "This launch ships `never-ready`, which means RULE 1 NEVER FIRES: no sale "
                   "is ever haircut, at any price, on any day."],
     "sends": "SnoozeNeverReady, or nothing if oracle.address is already set"},
    {"n": 2, "id": "deployer", "title": "SnoozeDeployer",
     "permanent": ["The deployer's owner is fixed at construction.",
                   "Sealing it in step 6 is irreversible."],
     "sends": "SnoozeDeployer (no constructor arguments)"},
    {"n": 3, "id": "token", "title": "Snooze, from your own wallet",
     "permanent": ["`oracle` and `devBps` are immutable from this transaction onward.",
                   "`admin` is msg.sender — which is why this is NOT sent through the "
                   "deployer, where msg.sender would be the deployer contract and the whole "
                   "supply would be minted to an address with no transfer function.",
                   "The whole supply lands in your wallet and your Rule 3 clock starts."],
     "sends": "Snooze(supply, oracle, dev, devBps)"},
    {"n": 4, "id": "salt", "title": "The vanity salt",
     "permanent": ["Nothing. This step sends no transaction.",
                   "It must come after step 3: the curve's constructor arguments contain the "
                   "token's address, so there is nothing to grind against until it exists."],
     "sends": "nothing — this is a local search"},
    {"n": 5, "id": "curve", "title": "The curve, the reward token, and the wiring",
     "permanent": ["Every curve parameter is immutable: virtualEth, bondTarget, feeBps, feeTo, "
                   "factory, weth, lpTo. Getting one wrong means relaunching.",
                   "`setDream` can be called ONCE and never repointed.",
                   "Registering the curve as a pool is what switches Rules 1 and 2 on at all.",
                   "ORDER MATTERS: fund the curve BEFORE registering it. Once isPool[curve] is "
                   "true, a transfer into it is a sell — Rule 2 caps it and Rule 1 burns part "
                   "of it, and the curve silently ends up holding a fraction of its float."],
     "sends": "SnoozeCurve, SnoozeDream, fund, setDream, setPool, registerPair, exemptOwner"},
    {"n": 6, "id": "lock", "title": "Freeze the token, seal the deployer",
     "permanent": ["EVERYTHING. After freeze() nobody can register a pool, hand out an "
                   "exemption, or name the reward token — including you.",
                   "If setDream was not called before this, Rule 3 accrues forever and nobody "
                   "can ever mint against it."],
     "sends": "freeze(), seal()"},
]


# ──────────────────────────────────────────────────────────────────────── the console
#
# THE CHART IS THE POINT OF THIS PAGE, and it is the same discipline web/index.html holds
# itself to: what is drawn here is a FORMULA, it is labelled as one, and there is no code path
# that draws a market series. A chart of arithmetic is exact and cannot go stale. A chart of a
# market drawn from a model is a claim about a future, and from three feet away the two look
# identical — which is exactly why the label is inside the frame rather than under it.

CONSOLE_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>$SNOOZE — deploy console</title>
<style>
:root{--bg:#070b16;--fg:#e9edf8;--dim:#9aa6c2;--line:#26304a;--card:rgba(255,255,255,.045);
 --gold:#f0c040;--ok:#4fd18a;--bad:#ff8178;--warn:#f2c14e;
 --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
 font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
 padding:0 16px 40px;max-width:860px;margin:0 auto}
h1{font-size:22px;margin:22px 0 2px}h2{font-size:15px;margin:0 0 8px}
.sub{color:var(--dim);font-size:13px;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 4px}
.tabs button{font:inherit;font-size:13px;padding:7px 13px;border-radius:999px;cursor:pointer;
 border:1px solid var(--line);background:transparent;color:var(--dim)}
.tabs button[aria-selected=true]{background:var(--gold);color:#140f02;border-color:var(--gold);font-weight:600}
.mono{font-family:var(--mono);font-size:12.5px;word-break:break-all}
.dim{color:var(--dim)}.tiny{font-size:12.5px;line-height:1.55}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}
th,td{text-align:right;padding:7px 5px;border-bottom:1px solid var(--line)}
th:first-child,td:first-child{text-align:left}th{color:var(--dim);font-weight:500}
td.n{font-family:var(--mono)}
.scroll{overflow-x:auto}
.chartwrap{position:relative;width:100%;height:250px;margin:8px 0 2px}
.chartwrap svg{width:100%;height:100%;display:block}
.strap{font-size:12px;color:var(--gold);margin:0 0 4px;letter-spacing:.02em;text-transform:uppercase}
.axis{display:flex;justify-content:space-between;font-size:11.5px;color:var(--dim);margin:2px 0 0}
.warnbox{background:rgba(242,193,78,.13);border:1px solid var(--warn);color:var(--warn);
 border-radius:8px;padding:11px;font-size:12.5px;margin:8px 0}
.badbox{background:rgba(255,129,120,.13);border:1px solid var(--bad);color:var(--bad);
 border-radius:8px;padding:11px;font-size:12.5px;margin:8px 0}
.okbox{background:rgba(79,209,138,.13);border:1px solid var(--ok);color:var(--ok);
 border-radius:8px;padding:11px;font-size:12.5px;margin:8px 0}
.step{border-left:2px solid var(--line);padding:2px 0 2px 13px;margin:14px 0}
.step .n{font-family:var(--mono);color:var(--gold);font-size:12px}
.step ul{margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--dim)}
input{font-family:var(--mono);font-size:15px;padding:9px;border:1.5px solid var(--line);
 border-radius:8px;background:#0e1424;color:var(--fg);width:100%}
label{display:block;font-size:12.5px;color:var(--dim);margin:10px 0 5px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.big{font-family:var(--mono);font-size:34px;font-weight:700;letter-spacing:-.02em}
section[hidden]{display:none}
</style></head><body>
<h1>$SNOOZE — deploy console</h1>
<p class="sub">snooze.py <span id="ver"></span> · nothing here holds a key, and nothing here can send a transaction.</p>
<div class="tabs" role="tablist">
  <button role="tab" data-t="launch" aria-selected="true">Launch</button>
  <button role="tab" data-t="curve" aria-selected="false">The curve</button>
  <button role="tab" data-t="dream" aria-selected="false">Rule 3 — $DREAM</button>
  <button role="tab" data-t="opt" aria-selected="false">Parameters</button>
</div>

<section id="launch">
  <div class="card">
    <h2>Six steps, and each one is a door that only opens one way</h2>
    <p class="tiny dim">Config: <span class="mono" id="cfgsrc"></span></p>
    <div id="steps"></div>
  </div>
</section>

<section id="curve" hidden>
  <div class="card">
    <h2>What a buy costs, as the curve fills</h2>
    <p class="strap" id="curveStrap">this is arithmetic, not a market</p>
    <div class="chartwrap"><svg id="cchart" viewBox="0 0 600 250" preserveAspectRatio="none"></svg></div>
    <p class="axis"><span id="cax">0 ETH raised</span><span id="cay"></span></p>
    <div class="scroll"><table id="ctab"></table></div>
    <p class="tiny dim" style="margin-top:10px">Price multiple is ((E0+R)/E0)² — the token side
    cancels, so how much money it takes to Nx is a fact about the virtual ETH alone. Identical
    to <span class="mono">priceMultipleBps()</span> in contracts/SnoozeCurve.sol.</p>
  </div>
</section>

<section id="dream" hidden>
  <div class="card">
    <h2>What you are paid for not selling</h2>
    <p class="strap">this is arithmetic, not a market</p>
    <div class="chartwrap"><svg id="dchart" viewBox="0 0 600 250" preserveAspectRatio="none"></svg></div>
    <p class="axis"><span>day 0</span><span id="dax"></span></p>
    <div class="grid2">
      <div><label for="dbag">SNOOZE held</label><input id="dbag" value="1000000" inputmode="decimal"></div>
      <div><label for="ddays">days held, untouched</label><input id="ddays" value="90" inputmode="decimal"></div>
    </div>
    <p class="dim tiny" style="margin:14px 0 2px">DREAM accrued</p>
    <div class="big" id="dout">—</div>
    <p class="tiny dim" id="dnote"></p>
    <div class="warnbox">Any outbound transfer resets the clock to zero — a sale, a move to
    your own second wallet, an exchange deposit. What you already accrued is banked and stays
    claimable. What you lose is the rate, and the rate is the whole prize.</div>
  </div>
</section>

<section id="opt" hidden>
  <div class="card">
    <h2>There is no setting that is both hard to corner and quick to graduate</h2>
    <p class="tiny dim">So this is not one answer. It is the price of each answer.</p>
    <div id="shipped"></div>
    <div class="scroll"><table id="otab"></table></div>
    <h2 style="margin-top:18px">Every guess this used</h2>
    <div class="scroll"><table id="atab"></table></div>
  </div>
</section>

<script>
const D = %%DATA%%;
const $ = id => document.getElementById(id);
document.getElementById("ver").textContent = D.version;
$("cfgsrc").textContent = D.configSource;

for (const b of document.querySelectorAll("[role=tab]")) b.onclick = () => {
  for (const o of document.querySelectorAll("[role=tab]")) {
    o.setAttribute("aria-selected", o === b);
    $(o.dataset.t).hidden = o !== b;
  }
};

/* One plotter, shared. Zero-based y because both series mean something at zero. */
function plot(svg, pts, colour){
  while(svg.firstChild) svg.removeChild(svg.firstChild);
  const W=600,H=250,L=6,R=6,T=10,B=18, ns="http://www.w3.org/2000/svg";
  if(!pts || pts.length<2) return;
  const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
  const x0=Math.min(...xs), x1=Math.max(...xs);
  let y0=0, y1=Math.max(...ys); if(y1===y0) y1=y0+1; y1*=1.08;
  const sx=v=>L+(v-x0)/((x1-x0)||1)*(W-L-R);
  const sy=v=>H-B-(v-y0)/((y1-y0)||1)*(H-T-B);
  for(let i=0;i<=4;i++){
    const yy=T+i*(H-T-B)/4, g=document.createElementNS(ns,"line");
    g.setAttribute("x1",L);g.setAttribute("x2",W-R);g.setAttribute("y1",yy);g.setAttribute("y2",yy);
    g.setAttribute("stroke","#26304a");g.setAttribute("stroke-width","1");
    g.setAttribute("vector-effect","non-scaling-stroke");svg.appendChild(g);
  }
  const d=pts.map((p,i)=>(i?"L":"M")+sx(p[0]).toFixed(1)+" "+sy(p[1]).toFixed(1)).join(" ");
  const area=document.createElementNS(ns,"path");
  area.setAttribute("d",d+" L"+sx(x1).toFixed(1)+" "+(H-B)+" L"+sx(x0).toFixed(1)+" "+(H-B)+" Z");
  area.setAttribute("fill",colour+"22");
  const line=document.createElementNS(ns,"path");
  line.setAttribute("d",d);line.setAttribute("fill","none");line.setAttribute("stroke",colour);
  line.setAttribute("stroke-width","2.5");line.setAttribute("stroke-linejoin","round");
  line.setAttribute("vector-effect","non-scaling-stroke");
  svg.appendChild(area);svg.appendChild(line);
}
const trim = n => String(+Number(n).toFixed(4));

/* the six steps */
$("steps").innerHTML = D.steps.map(s => `
  <div class="step"><div class="n">STEP ${s.n} · ${s.id}</div>
  <div style="font-weight:600;margin:2px 0 2px">${s.title}</div>
  <div class="tiny dim">sends: <span class="mono">${s.sends}</span></div>
  <ul>${s.permanent.map(p=>`<li>${p}</li>`).join("")}</ul></div>`).join("");

/* the curve */
plot($("cchart"), D.curve.series, "#f0c040");
$("cay").textContent = "bonds at " + trim(D.curve.bondAt) + " ETH → " + trim(D.curve.bondMultiple) + "x";
$("cax").textContent = "0 ETH raised (E0 = " + trim(D.curve.e0) + " virtual)";
$("ctab").innerHTML = "<tr><th>one buy of</th><th>takes this much of the float</th><th>price after</th></tr>"
  + D.curve.table.map(r=>`<tr><td class="n">${trim(r[0])} ETH</td><td class="n">${(r[1]*100).toFixed(2)}%</td><td class="n">${trim(r[2])}x</td></tr>`).join("");

/* rule 3 */
plot($("dchart"), D.dream.series, "#4fd18a");
$("dax").textContent = "day " + D.dream.days;
function recomputeDream(){
  const bag = Number(String($("dbag").value).replace(/[^0-9.]/g,"")) || 0;
  const days = Number(String($("ddays").value).replace(/[^0-9.]/g,"")) || 0;
  const ratio = D.dream.ratioAt(days);
  $("dout").textContent = (bag*ratio).toLocaleString(undefined,{maximumFractionDigits:2}) + " DREAM";
  $("dnote").textContent = "= " + trim(ratio) + " DREAM per SNOOZE. The ramp is quadratic for the "
    + "first " + D.dream.rampDays + " days, so half the time is a QUARTER of the reward, not half. "
    + "One-for-one lands exactly on day " + D.dream.rampDays + ".";
}
/* ratio in the browser, from the same integer expression the contract uses */
D.dream.ratioAt = function(days){
  const R = D.dream.rampDays*86400, a1 = Math.floor(days*86400);
  const m1 = Math.min(a1,R), x1 = Math.max(a1-R,0);
  return ((m1*m1) + 2*R*x1) / (R*R);
};
for (const id of ["dbag","ddays"]) $(id).addEventListener("input", recomputeDream);
recomputeDream();

/* parameters */
const sh = D.opt.shipped;
$("shipped").innerHTML =
  `<div class="${sh.breaches.length ? "warnbox" : "okbox"}">
   <b>Shipped: E0 = ${trim(sh.e0)} ETH, bond at ${trim(sh.r)} ETH.</b><br>
   Graduates at ${trim(sh.m)}x · launcher ends with ${(sh.launcher*100).toFixed(1)}% of supply ·
   one ${trim(D.opt.whale)} ETH buy takes ${(sh.whale_takes*100).toFixed(1)}% of the float.
   ${sh.breaches.length ? "<br><br>Breaches: " + sh.breaches.join("; ") : "<br><br>Clears every hard constraint."}</div>`;
$("otab").innerHTML = "<tr><th>corner ceiling</th><th>E0</th><th>bond at</th><th>graduates</th><th>launcher</th><th>a whale takes</th></tr>"
  + D.opt.frontier.map(r=>`<tr><td class="n">${(r.ceiling*100).toFixed(0)}%</td><td class="n">${trim(r.e0)}</td><td class="n">${trim(r.r)} ETH</td><td class="n">${trim(r.m)}x</td><td class="n">${(r.launcher*100).toFixed(1)}%</td><td class="n">${(r.whale_takes*100).toFixed(1)}%</td></tr>`).join("");
$("atab").innerHTML = "<tr><th>guess</th><th>value</th><th>what it means</th></tr>"
  + D.opt.assumptions.map(r=>`<tr><td>${r[0]}</td><td class="n">${r[1]}</td><td class="tiny dim" style="text-align:left">${r[2]}</td></tr>`).join("");
</script></body></html>
"""


def console_data(cfg: dict, a: Assumptions) -> dict:
    e0, bond = cfg_e0(cfg), cfg_bond(cfg)
    steps_eth = [bond * i / 60.0 for i in range(61)]
    ramp_days = cfg["dream"]["rampDays"]
    sh = score_params(e0, bond, a)
    breaches = []
    if sh["whale_takes"] > a.max_corner:
        breaches.append("one %g ETH buy takes %.1f%% of the float, over the %.0f%% ceiling"
                        % (a.whale_eth, sh["whale_takes"] * 100, a.max_corner * 100))
    if sh["launcher"] > a.flag_at:
        breaches.append("the launcher ends with %.1f%% of supply, over %.0f%%"
                        % (sh["launcher"] * 100, a.flag_at * 100))
    sh = dict(sh, breaches=breaches)
    return {
        "version": VERSION,
        "configSource": cfg.get("_source", "?"),
        "steps": STEPS,
        "curve": {
            "e0": e0, "bondAt": bond, "bondMultiple": price_multiple(bond, e0),
            "series": [[r, price_multiple(r, e0)] for r in steps_eth],
            "table": [[b, corner_share(b, e0), price_multiple(b, e0)]
                      for b in (0.1, 0.5, 1.0, 2.0, 5.0)],
        },
        "dream": {
            "rampDays": ramp_days, "days": ramp_days * 2,
            "series": [[d, dream_ratio(d)] for d in range(0, ramp_days * 2 + 1, 2)],
        },
        "opt": {
            "shipped": sh, "whale": a.whale_eth,
            "frontier": frontier(a),
            "assumptions": a.rows(),
        },
    }


def serve(cfg: dict, a: Assumptions, port: int, open_browser: bool = True) -> None:
    page = CONSOLE_HTML.replace("%%DATA%%", json.dumps(console_data(cfg, a)))
    body = page.encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):                      # noqa: N802
            if self.path not in ("/", "/index.html"):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            # No third-party anything: the page loads no script, no font and no image it did
            # not arrive with, so a console open on a launch cannot phone anywhere.
            self.send_header("content-security-policy",
                             "default-src 'none'; style-src 'unsafe-inline'; "
                             "script-src 'unsafe-inline'")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    class Server(socketserver.TCPServer):
        allow_reuse_address = True

    # 127.0.0.1, never 0.0.0.0. A launch console bound to every interface is a launch console
    # on the coffee-shop wifi.
    with Server(("127.0.0.1", port), Handler) as httpd:
        url = "http://127.0.0.1:%d/" % port
        print("  console:  %s" % url)
        print("  it binds to localhost only, loads nothing from the network, and cannot send.")
        print("  ctrl-c to stop.\n")
        if open_browser:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.")


# ──────────────────────────────────────────────────────────────────────────── commands

def _fmt_eth(x: float) -> str:
    return ("%.4f" % x).rstrip("0").rstrip(".")


def cmd_plan(cfg, a, args):
    print("\nSIX STEPS. Each one is a door that only opens one way.\n")
    print("  config: %s\n" % cfg.get("_source"))
    for s in STEPS:
        print("  STEP %d — %s" % (s["n"], s["title"]))
        print("    sends: %s" % s["sends"])
        for p in s["permanent"]:
            print("    · %s" % p)
        print()
    print("  Nothing here signs. Each step produces {to, data, value}; your wallet does the")
    print("  rest. Building the deployment transactions needs the compiled bytecode:")
    print("    node deploy/scripts/artifacts.mjs   (in a checkout of the repository)\n")


def cmd_curve(cfg, a, args):
    e0, bond = cfg_e0(cfg), cfg_bond(cfg)
    m = price_multiple(bond, e0)
    print("\nTHE CURVE. k = E*T, E starts at E0 virtual and only real ETH moves it.\n")
    print("  virtual ETH (E0)   %s" % _fmt_eth(e0))
    print("  bonds at           %s ETH of real buys" % _fmt_eth(bond))
    print("  graduation         %.2fx" % m)
    print("  sold by then       %.1f%% of the curve's allocation" % (sold_fraction(m) * 100))
    print("  back to feeTo      %.1f%% of it (exactly 1/m, for every m)"
          % (leftover_fraction(m) * 100))
    print("\n  ONE BUY OF        TAKES OF THE FLOAT     PRICE AFTER")
    for b in (0.1, 0.25, 0.5, 1.0, 2.0, 5.0):
        print("  %-8s ETH      %6.2f%%                %6.2fx"
              % (_fmt_eth(b), corner_share(b, e0) * 100, price_multiple(b, e0)))
    print("\n  b/(E0+b). The token side cancels, so this depends on the virtual ETH and on")
    print("  NOTHING ELSE — not supply, not the bond target, not how many people are watching.\n")


def cmd_dream(cfg, a, args):
    ramp = cfg["dream"]["rampDays"]
    bag = args.bag
    print("\nRULE 3. You are paid for not selling, in an equivalent token.\n")
    print("  ramp               %d days" % ramp)
    print("  at the ramp        exactly 1 DREAM per SNOOZE. Same decimals, same count.")
    print("  after it           flat, not zero: another 2 per SNOOZE every %d days, forever.\n"
          % ramp)
    print("  DAYS HELD    DREAM PER SNOOZE    ON %s SNOOZE" % f"{bag:,.0f}")
    for d in (1, 7, 30, 45, 60, ramp, ramp * 2, ramp * 4):
        r = dream_ratio(d)
        print("  %-9s    %-18s  %s" % (d, "%.6f" % r, f"{bag * r:,.2f}"))
    print("\n  THE RAMP IS QUADRATIC. Half the time is a QUARTER of the reward, not half —")
    print("  %.4f at day %d against %.4f at day %d. A linear reading of \"90 days to 1:1\""
          % (dream_ratio(ramp / 2), ramp // 2, dream_ratio(ramp), ramp))
    print("  is wrong by 2x at the midpoint, and it is the reading everybody takes.\n")
    print("  WHAT BREAKS IT: any outbound transfer. A sale, a move to your own second wallet,")
    print("  an exchange deposit. From inside a transfer those are the same event and no")
    print("  attempt is made to tell them apart. What you accrued is banked; the rate resets.\n")


def cmd_optimize(cfg, a, args):
    e0, bond = cfg_e0(cfg), cfg_bond(cfg)
    sh = score_params(e0, bond, a)
    print("\nPARAMETERS. Not a pump button — a search for settings that do not guarantee a")
    print("bad launch, and an honest account of what each one costs.\n")
    print("  EVERY GUESS THIS USED:")
    for k, v, why in a.rows():
        print("    %-18s %-14s %s" % (k, v, why))
    print("\n  SHIPPED (deploy/config.json): E0 = %s ETH, bond at %s ETH"
          % (_fmt_eth(e0), _fmt_eth(bond)))
    print("    graduates at %.2fx · launcher ends with %.1f%% of supply · a %g ETH buy takes "
          "%.1f%% of the float" % (sh["m"], sh["launcher"] * 100, a.whale_eth,
                                   sh["whale_takes"] * 100))
    bad = []
    if sh["whale_takes"] > a.max_corner:
        bad.append("CORNER CEILING: %.1f%% is over the %.0f%% ceiling."
                   % (sh["whale_takes"] * 100, a.max_corner * 100))
    if sh["launcher"] > a.flag_at:
        bad.append("LAUNCHER SHARE: %.1f%% is over %.0f%%."
                   % (sh["launcher"] * 100, a.flag_at * 100))
    for b in bad:
        print("    ✗ %s" % b)
    if not bad:
        print("    ✓ clears every hard constraint.")

    rows = frontier(a)
    print("\n  THE FRONTIER — the best setting at each corner ceiling:\n")
    print("    CEILING   E0        BOND AT    GRADUATES   LAUNCHER   A WHALE TAKES")
    for r in rows:
        print("    %-9s %-9s %-10s %-11s %-10s %s"
              % ("%.0f%%" % (r["ceiling"] * 100), _fmt_eth(r["e0"]),
                 _fmt_eth(r["r"]) + " ETH", "%.2fx" % r["m"],
                 "%.1f%%" % (r["launcher"] * 100), "%.1f%%" % (r["whale_takes"] * 100)))

    best = optimize(a)
    if best:
        b0 = best[0]
        print("\n  BEST AT YOUR %.0f%% CEILING: E0 = %s ETH, bond at %s ETH → %.2fx"
              % (a.max_corner * 100, _fmt_eth(b0["e0"]), _fmt_eth(b0["r"]), b0["m"]))
        # The optimum landing exactly ON a constraint means the constraint chose it, not the
        # score. Saying so is the difference between a recommendation and a number.
        on_edge = []
        if abs(b0["launcher"] - a.flag_at) < 0.005:
            on_edge.append("the launcher-share ceiling (%.0f%%)" % (a.flag_at * 100))
        if abs(b0["whale_takes"] - a.max_corner) < 0.005:
            on_edge.append("the corner ceiling (%.0f%%)" % (a.max_corner * 100))
        if on_edge:
            print("\n  READ THIS BEFORE USING IT: the optimum sits exactly ON %s, which means"
                  % " and ".join(on_edge))
            print("  that constraint picked it and the score only broke the tie. Move the")
            print("  constraint and the answer moves with it. It is a guess wearing a decimal.")
    print()


def cmd_simulate(cfg, a, args):
    b = Behaviour(holders=args.holders, days=args.days, hazard=args.hazard,
                  dream_worth=args.dream_worth)
    print("\nWHAT RULE 3 IS WORTH. Not a price and not a prediction: how much more of the")
    print("float is still held when breaking a streak costs something.\n")
    print("  EVERY ASSUMPTION:")
    for k, v, why in b.rows():
        print("    %-18s %-24s %s" % (k, v, why))
    c = compare(b)
    print("\n  FLOAT STILL HELD          RULE 3 ON     RULE 3 OFF     DIFFERENCE")
    print("    at day 90               %8.1f%%     %8.1f%%      %.2fx"
          % (c["on"]["d90"] * 100, c["off"]["d90"] * 100, c["d90_lift"]))
    print("    at day %-3d              %8.1f%%     %8.1f%%      %.2fx"
          % (b.days, c["on"]["final"] * 100, c["off"]["final"] * 100, c["final_lift"]))
    print("\n  Breaking a 90-day streak costs %.3f SNOOZE-equivalents per SNOOZE held, at a"
          % streak_cost(90, b))
    print("  90-day look-ahead. That is the mechanism, and it is the whole mechanism.\n")
    print("  THE ABSOLUTE NUMBERS ARE ALMOST ENTIRELY THE HAZARD RATE, which is a guess. The")
    print("  ratio is what survives changing it, and the ratio is what Rule 3 is responsible")
    print("  for. Set --dream-worth 0 and the two columns become the same simulation.\n")


def cmd_predict(cfg, a, args):
    owner = cfg["owner"]
    nonce = args.nonce
    if nonce is None:
        rpc = Rpc()
        nonce = rpc.nonce(owner)
        print("\n  read from %s: nonce %d" % (rpc.host, nonce))
    print("\nADDRESSES BEFORE A WEI IS SPENT. A plain CREATE lands at keccak(rlp([sender,")
    print("nonce]))[12:] — the deployed bytes do not enter into it.\n")
    print("  owner    %s" % checksum(owner))
    print("  nonce    %d\n" % nonce)
    for i, name in enumerate(("oracle (if deployed here)", "SnoozeDeployer", "Snooze  ← the "
                              "address a buyer pastes", "SnoozeDream")):
        print("  +%d  %-34s %s" % (i, name, create_address(owner, nonce + i)))
    print("\n  ONE THING INVALIDATES ALL OF IT: a nonce is consumed by any transaction from")
    print("  that wallet, INCLUDING ONE THAT REVERTS. Predict from a wallet you then leave")
    print("  alone. The curve is a CREATE2 from the deployer and needs the compiled init code,")
    print("  so it is not listed here — deploy/scripts/predict.mjs does that one.\n")


def cmd_verify(cfg, a, args):
    rpc = Rpc()
    token = args.token
    print("\n  reading %s from %s\n" % (checksum(token), rpc.host))
    code = rpc.code_at(token)
    if not code or code == "0x":
        print("  NO CODE AT THAT ADDRESS. Nothing else below would mean anything.\n")
        return
    reads = [("decimals()", "decimals", None), ("totalSupply()", "total supply", None),
             ("RAMP()", "Rule 3 ramp (seconds)", None), ("frozen()", "frozen", "bool"),
             ("supplyOnlyFalls()", "supply only falls", "bool"),
             ("ruleActive()", "Rule 1 active", "bool"), ("dream()", "reward token", "addr"),
             ("totalBurned()", "burned so far", None)]
    for sig, label, kind in reads:
        try:
            v = read_uint(rpc.call(token, selector(sig)))
            if kind == "bool":
                out = "true" if v else "false"
            elif kind == "addr":
                out = checksum("%040x" % v) if v else "NOT SET — nobody can ever mint DREAM"
            else:
                out = str(v)
        except Exception as e:
            out = "could not be read (%s)" % e
        print("  %-24s %s" % (label, out))
    if args.wallet:
        print()
        for sig, label in (("streakSeconds(address)", "streak (seconds)"),
                           ("dreamPending(address)", "DREAM claimable now"),
                           ("balanceOf(address)", "SNOOZE held")):
            try:
                v = read_uint(rpc.call(token, selector(sig) + word(args.wallet)))
                extra = ""
                if sig.startswith("streakSeconds"):
                    extra = "  (%.1f days)" % (v / 86400.0)
                print("  %-24s %s%s" % (label, v, extra))
            except Exception as e:
                print("  %-24s could not be read (%s)" % (label, e))
    print("\n  Reads only. Nothing above sent anything, and this client cannot.\n")


def cmd_selftest(cfg, a, args):
    """Assertions, so a copy of this file can prove itself on a machine with nothing else."""
    n = [0]

    def ok(name, cond, extra=""):
        n[0] += 1
        print("  %s %s%s" % ("ok  " if cond else "FAIL", name,
                             "" if cond else "  <- " + str(extra)))
        if not cond:
            ok.bad = True
    ok.bad = False

    print("\n── keccak-256, against published vectors")
    ok("keccak(\"\")", keccak256(b"").hex() ==
       "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
    ok("keccak(\"abc\")", keccak256(b"abc").hex() ==
       "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
    ok("transfer(address,uint256) is 0xa9059cbb",
       selector("transfer(address,uint256)") == "0xa9059cbb")
    ok("balanceOf(address) is 0x70a08231", selector("balanceOf(address)") == "0x70a08231")

    print("── EIP-55 and address derivation")
    ok("checksums the config owner",
       checksum("0x4296e9a65582358221eed0e9a2b4ec94ad4f5929")
       == "0x4296e9A65582358221EEd0e9A2B4EC94ad4F5929")
    ok("CREATE from nonce 0 (published vector)",
       create_address("0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0", 0).lower()
       == "0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d")
    ok("CREATE2 (EIP-1014 vector)",
       create2_address("0x0000000000000000000000000000000000000000", "0" * 64,
                       keccak256(bytes.fromhex("00")).hex()).lower()
       == "0x4d1a2e2bb4f88f0250f26ffff098b0b30b26bf38")

    print("── Rule 3, against contracts/Snooze.sol:dreamBetween")
    one = 10 ** 9
    ok("one SNOOZE held for the full ramp accrues EXACTLY one DREAM",
       dream_between(one, 0, RAMP) == one, dream_between(one, 0, RAMP))
    ok("half the ramp is a quarter, not a half",
       dream_between(one, 0, RAMP // 2) == one // 4)
    ok("twice the ramp is 3x", dream_between(one, 0, 2 * RAMP) == 3 * one)
    ok("and each further ramp adds exactly 2x, forever",
       dream_between(one, 2 * RAMP, 3 * RAMP) == 2 * one)
    ok("no time, no reward", dream_between(one, 500, 500) == 0)
    ok("no balance, no reward", dream_between(0, 0, RAMP) == 0)

    print("── the curve identities, each derived two ways")
    for m in (2.0, 4.0, 7.5625, 20.0):
        e0 = 2.0
        r = eth_to_reach(m, e0)
        ok("reaching %.4gx costs E0(sqrt(m)-1) and round-trips" % m,
           abs(price_multiple(r, e0) - m) < 1e-9)
        ok("  leftover at %.4gx is exactly 1/m" % m, abs(leftover_fraction(m) - 1 / m) < 1e-12)
        ok("  sold by then is 1-1/sqrt(m)",
           abs(sold_fraction(m) - (1 - 1 / math.sqrt(m))) < 1e-12)
    ok("a buy's share depends on E0 alone: 1 ETH into E0=3 takes a quarter",
       abs(corner_share(1.0, 3.0) - 0.25) < 1e-12)

    print("── the optimizer respects its own hard constraints")
    aa = Assumptions()
    cands = optimize(aa)
    ok("it produced candidates", len(cands) > 0)
    ok("none of them can be cornered past the ceiling",
       all(c["whale_takes"] <= aa.max_corner + 1e-12 for c in cands))
    ok("none leaves the launcher over the flag threshold",
       all(c["launcher"] <= aa.flag_at + 1e-12 for c in cands))
    ok("none graduates under 2x", all(c["m"] >= 2.0 for c in cands))
    ok("a tighter ceiling never admits more settings",
       len(optimize(Assumptions(max_corner=0.10))) <= len(cands))

    print("── Rule 3 changes the simulation, and only through the one parameter")
    b = Behaviour(holders=400, days=120)
    ok("with DREAM worth nothing the two worlds are identical",
       simulate(Behaviour(holders=400, days=120, dream_worth=0.0), True)["final"]
       == simulate(Behaviour(holders=400, days=120, dream_worth=0.0), False)["final"])
    ok("with DREAM worth something, more float is still held",
       simulate(b, True)["final"] >= simulate(b, False)["final"])

    print("── it cannot send, and that is checked rather than asserted")
    r = Rpc("https://example.invalid")
    for m in ("eth_sendRawTransaction", "eth_sendTransaction", "eth_sign",
              "personal_sendTransaction", "eth_accounts", "eth_signTypedData_v4"):
        try:
            r.send(m)
            ok("%s is refused" % m, False, "it was not")
        except ValueError:
            ok("%s is refused before a socket opens" % m, True)
        except Exception as e:
            ok("%s is refused" % m, False, e)
    # GREPPING THE SOURCE FOR "secp256k1" DOES NOT WORK, and the first version of this check
    # did exactly that and failed itself: the needles appear in the list of needles, and
    # "private key" and "keystore" both appear in the docstring PROMISING there are none. A
    # substring search cannot tell a prohibition from a violation.
    #
    # So the check is on the IMPORTS, which is the property that actually matters: signing
    # needs a curve implementation, and a curve implementation in Python arrives as an import.
    # Every module this file pulls in must be on the list below, and none of them can sign.
    STDLIB_OK = {"argparse", "ast", "http", "json", "math", "os", "random", "socketserver",
                 "sys", "threading", "urllib", "webbrowser", "pathlib", "__future__"}
    src = Path(__file__).read_text()
    tree = ast.parse(src)
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(al.name.split(".")[0] for al in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    ok("every import is standard library and on the list", imported <= STDLIB_OK,
       sorted(imported - STDLIB_OK))
    ok("no cryptography, wallet or signing package is imported at all",
       not (imported & {"eth_account", "eth_keys", "web3", "coincurve", "ecdsa",
                        "cryptography", "nacl", "hashlib", "hmac", "secrets", "subprocess"}))
    ok("nothing is imported lazily inside a function either",
       all(isinstance(getattr(n, "col_offset", 0), int) and n.col_offset == 0
           for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))))
    ok("there is no eval and no exec",
       not any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id in ("eval", "exec") for n in ast.walk(tree)))
    ok("the read allowlist has exactly eight methods", len(Rpc.ALLOWED) == 8)
    ok("and none of them can change state",
       all(not m.startswith(("eth_send", "eth_sign", "personal_")) for m in Rpc.ALLOWED))

    print("\n%d checks, %s\n" % (n[0], "all passed" if not ok.bad else "SOMETHING FAILED"))
    return 1 if ok.bad else 0


def cmd_ui(cfg, a, args):
    print("\n$SNOOZE deploy console — snooze.py %s" % VERSION)
    print("  config: %s" % cfg.get("_source"))
    serve(cfg, a, args.port, open_browser=not args.no_browser)


def main(argv=None):
    p = argparse.ArgumentParser(
        prog="snooze.py",
        description="The $SNOOZE launch, in one file. It never holds a key and cannot send.",
        epilog="The endpoint comes from SNOOZE_RPC in your environment and from nowhere else. "
               "There is deliberately no --rpc: an endpoint on a command line lands in your "
               "shell history and in /proc/<pid>/cmdline.")
    p.add_argument("--whale", type=float, default=1.0,
                   help="buy size cornering is measured against, in ETH (default 1)")
    p.add_argument("--corner-ceiling", type=float, default=0.25,
                   help="most of the float one whale buy may take (default 0.25)")
    p.add_argument("--coin-flip-raise", type=float, default=5.0,
                   help="the raise you would give even odds of arriving, in ETH (default 5)")
    sub = p.add_subparsers(dest="cmd")

    def add(name, fn, help_):
        s = sub.add_parser(name, help=help_)
        s.set_defaults(fn=fn)
        return s

    s = add("ui", cmd_ui, "the deploy console in your browser (the default)")
    s.add_argument("--port", type=int, default=8731)
    s.add_argument("--no-browser", action="store_true")
    add("plan", cmd_plan, "the six steps and what each one makes permanent")
    add("curve", cmd_curve, "the bonding curve, and what one buy takes")
    s = add("dream", cmd_dream, "Rule 3: what you are paid for not selling")
    s.add_argument("--bag", type=float, default=1_000_000, help="SNOOZE held (default 1e6)")
    add("optimize", cmd_optimize, "search the parameters, and price each trade-off")
    s = add("simulate", cmd_simulate, "what Rule 3 is worth, under named assumptions")
    s.add_argument("--holders", type=int, default=2000)
    s.add_argument("--days", type=int, default=180)
    s.add_argument("--hazard", type=float, default=0.02)
    s.add_argument("--dream-worth", type=float, default=0.35, dest="dream_worth")
    s = add("predict", cmd_predict, "the addresses, before a wei is spent")
    s.add_argument("--nonce", type=int, default=None)
    s = add("verify", cmd_verify, "read a live launch back off the chain")
    s.add_argument("token", help="the deployed Snooze address")
    s.add_argument("--wallet", default=None, help="also read this wallet's streak")
    add("selftest", cmd_selftest, "prove this file against published vectors")

    args = p.parse_args(argv)
    if not getattr(args, "fn", None):
        args.fn = cmd_ui
        args.port, args.no_browser = 8731, False

    cfg = load_config()
    a = Assumptions(whale_eth=args.whale, reach_ref=args.coin_flip_raise,
                    owner_share=cfg_owner_share(cfg), max_corner=args.corner_ceiling)
    try:
        return args.fn(cfg, a, args) or 0
    except (RuntimeError, ValueError) as e:
        print("\n  %s\n" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
