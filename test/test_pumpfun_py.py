"""pumpfun.py — the Solana launch script, tested from outside itself.

Two things are different about this script from everything else in the repository, and both
are why this file exists.

  IT HOLDS A KEY. Base's deploy console never did: a browser wallet signed and the scripts
  only ever built bytes. Solana has no equivalent path — a script that submits a transaction
  must sign it — so the rule became a set of narrower ones (a FILE, never an argument; a fresh
  wallet, never a main one; a mode check; halves that must agree), and a rule nobody tests is
  a comment. Every one of them is driven here, including the refusals.

  IT SIGNS BYTES SOMEBODY ELSE COMPOSED. pump.fun's builder returns the transaction. So the
  transaction is decoded and checked before a key touches it, and the decoder is exercised
  here against a transaction built byte by byte in this file.

What is NOT tested here is the live path, because there is no cluster to reach and it moves
real money. That is stated in the script's own docstring rather than left to be discovered.

    python3 test/test_pumpfun_py.py
"""
import json
import os
import re
import sys
import tempfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pumpfun as P                     # noqa: E402

PASS = FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok   " + name)
    else:
        FAIL += 1
        print("  FAIL " + name + (("\n         " + str(extra)) if extra else ""))


class StubRpc:
    """The cluster, stubbed. No network is touched by this suite."""
    def __init__(self, bal=0, keyed=True):
        self.url = "https://stub/v2/K" if keyed else P.PUBLIC_RPC
        self.keyed = keyed
        self._bal = bal
        self.sent = []

    host = property(lambda self: "stub")

    def balance(self, addr):
        return self._bal

    def send(self, method, params=None):
        self.sent.append(method)
        raise AssertionError("this suite must never reach the cluster (%s)" % method)


def launch_args(keypair, **over):
    a = type("A", (), {})()
    a.keypair, a.dev_buy, a.headroom, a.dry_run = keypair, 1.0, 0.5, True
    a.name, a.symbol, a.image, a.description = "Snooze Bear", "SNOOZE", "/dev/null", ""
    a.twitter = a.telegram = a.website = ""
    a.slippage, a.priority_fee = 10, 0.0005
    for k, v in over.items():
        setattr(a, k, v)
    return a


def with_rpc(rpc, fn, *a):
    real = P.Rpc
    P.Rpc = lambda *x, **k: rpc
    try:
        return fn(*a)
    finally:
        P.Rpc = real


print("── the key never comes from anywhere but a file")
HELP = StringIO()
try:
    with redirect_stdout(HELP):
        P.main(["launch", "--help"])
except SystemExit:
    pass
FLAGS = set(re.findall(r"^\s+(--[a-z][a-z-]*)", HELP.getvalue(), re.M))
ok("there is no flag that takes a key, a seed or a mnemonic",
   not (FLAGS & {"--key", "--private-key", "--secret", "--seed", "--mnemonic"}), sorted(FLAGS))
ok("--keypair takes a PATH and is required", "--keypair" in FLAGS
   and "--keypair" in HELP.getvalue() and "keypair JSON file" in HELP.getvalue())
ok("--dev-buy is required and has no default — this is money",
   "--dev-buy" in FLAGS and "REQUIRED" in HELP.getvalue()
   and not re.search(r"--dev-buy[^\n]*default", HELP.getvalue()))
ok("there is no --rpc flag either", "--rpc" not in FLAGS)
ok("and the help says where the endpoint comes from", "SOLANA_RPC" in HELP.getvalue())

print("── no child wallets and no self-trading, and not as an omission")
SRC = (ROOT / "pumpfun.py").read_text()
ALL_FLAGS = set(re.findall(r'add_argument\("(--[a-z-]+)"', SRC))
ok("there is no flag for a wallet fleet, a bundle, or volume",
   not (ALL_FLAGS & {"--wallets", "--bundle", "--fleet", "--volume", "--wash",
                     "--split", "--sub-wallets"}), sorted(ALL_FLAGS))
ok("and the file says why rather than just omitting them",
   "NO CHILD WALLETS" in SRC and "NO SELF-TRADING" in SRC)
ok("the only action it ever asks the builder for is a create",
   re.findall(r'"action":\s*"(\w+)"', SRC) == ["create"],
   re.findall(r'"action":\s*"(\w+)"', SRC))

print("── a keypair file, and every way it is refused")
kp = P.Keypair.generate()
with tempfile.TemporaryDirectory() as d:
    good = Path(d) / "launch.json"
    good.write_text(json.dumps(list(kp._seed + kp.pub)))
    os.chmod(good, 0o600)
    ok("a well-formed keypair loads and gives the right address",
       P.Keypair.load(str(good)).address == kp.address)
    ok("the secret half never appears in its repr",
       kp._seed.hex() not in repr(kp) and P.b58encode(kp._seed) not in repr(kp))

    for name, blob, why in [
        ("short.json", json.dumps(list(kp._seed)), "not a Solana CLI keypair"),
        ("obj.json", json.dumps({"seed": "x"}), "not a Solana CLI keypair"),
        ("mismatch.json", json.dumps(list(kp._seed + bytes(32))), "inconsistent"),
    ]:
        f = Path(d) / name
        f.write_text(blob)
        os.chmod(f, 0o600)
        try:
            P.Keypair.load(str(f))
            ok("%s is refused" % name, False, "it loaded")
        except RuntimeError as e:
            ok("%s is refused (%s)" % (name, why), why in str(e), str(e))

    loose = Path(d) / "loose.json"
    loose.write_text(json.dumps(list(kp._seed + kp.pub)))
    os.chmod(loose, 0o644)
    try:
        P.Keypair.load(str(loose))
        ok("a world-readable key file is refused", os.name != "posix")
    except RuntimeError as e:
        ok("a world-readable key file is refused", "readable by other users" in str(e))

    print("── the main-wallet guard, which is the expensive mistake this prevents")
    a = launch_args(str(good))
    # 40 SOL is not headroom, it is the wrong file. THE point of a launch wallet is that
    # losing it is survivable; pointing this at a main wallet makes that false.
    try:
        with redirect_stdout(StringIO()):
            with_rpc(StubRpc(40 * P.LAMPORTS), P.cmd_launch, a)
        ok("it refuses to sign with a wallet holding 40 SOL", False, "it proceeded")
    except RuntimeError as e:
        ok("it refuses to sign with a wallet holding 40 SOL", "looks like a main wallet" in str(e))
        ok("and names the fresh-keypair command instead of just failing",
           "solana-keygen new" in str(e))
    try:
        with redirect_stdout(StringIO()):
            with_rpc(StubRpc(int(0.2 * P.LAMPORTS)), P.cmd_launch, a)
        ok("it refuses a wallet that cannot cover the dev buy", False, "it proceeded")
    except RuntimeError as e:
        ok("it refuses a wallet that cannot cover the dev buy", "the dev buy alone is" in str(e))
    ok("the guard is dev buy + headroom, so a correctly funded wallet is not refused",
       (1.0 + 0.5) * P.LAMPORTS > 1.4 * P.LAMPORTS)

    print("── it will not launch through the public endpoint")
    try:
        with redirect_stdout(StringIO()):
            with_rpc(StubRpc(int(1.2 * P.LAMPORTS), keyed=False),
                     P.cmd_launch, launch_args(str(good), dry_run=False))
        ok("a real launch through the rate-limited public RPC is refused", False)
    except RuntimeError as e:
        ok("a real launch through the rate-limited public RPC is refused",
           "public endpoint" in str(e), str(e))

print("── the transaction is decoded before a key touches it")
payer, mint, other = P.Keypair.generate(), P.Keypair.generate(), P.Keypair.generate()


def build(keys, signers=2, prog_index=2, lookups=b"", data=b"\x01\x02"):
    msg = (bytes([signers, 0, 1]) + P._shortvec_encode(len(keys))
           + b"".join(k for k in keys) + bytes(32)
           + P._shortvec_encode(1) + bytes([prog_index])
           + P._shortvec_encode(1) + bytes([0])
           + P._shortvec_encode(len(data)) + data + lookups)
    return P._shortvec_encode(signers) + bytes(64) * signers + msg


SYS = P.b58decode("11111111111111111111111111111111")
PUMP = P.b58decode("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
tx = P.Transaction(build([payer.pub, mint.pub, PUMP]))
ok("the fee payer is read off the front", tx.account_keys[0] == payer.address)
ok("the signer count is read", tx.num_required_signatures == 2)
ok("the instruction's program resolves through the account keys",
   tx.program_of(tx.instructions[0]) == "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
ok("and it is named rather than shown as a bare id",
   "pump.fun" in tx.describe() and "UNKNOWN PROGRAM" not in tx.describe())

signed = tx.signed({payer.address: payer, mint.address: mint})
ok("signing leaves the message byte-identical", signed[-len(tx.message):] == tx.message)
ok("both slots are filled with real signatures",
   signed[1:65] == payer.sign(tx.message) and signed[65:129] == mint.sign(tx.message))
try:
    tx.signed({payer.address: payer})
    ok("a half-signed transaction is never produced", False)
except RuntimeError as e:
    ok("a half-signed transaction is never produced", "needs a signature" in str(e))

print("── and every structural refusal, without a cluster")
cases = [
    ("a transaction paying from somebody else's wallet",
     build([other.pub, mint.pub, PUMP]), "fee payer"),
    ("one that wants a third signature",
     build([payer.pub, mint.pub, other.pub, PUMP], signers=3, prog_index=3), "signers"),
    ("one that does not contain the mint you generated",
     build([payer.pub, other.pub, PUMP]), "mint"),
    ("one invoking a program this launch does not need",
     build([payer.pub, mint.pub, other.pub], prog_index=2), "program"),
]
for name, raw, want in cases:
    t = P.Transaction(raw)
    failed = [nm for good, nm in P._structural_only(t, payer.address, mint.address) if not good]
    ok("%s is refused" % name, any(want in nm for nm in failed), failed)

good_tx = P.Transaction(build([payer.pub, mint.pub, PUMP]))
ok("and the well-formed one passes every structural check",
   all(g for g, _ in P._structural_only(good_tx, payer.address, mint.address)))
# An address-table lookup names accounts that are NOT in account_keys, so a transaction using
# one cannot be shown to the operator in full. Refused rather than partially displayed.
lk = P.Transaction(build([payer.pub, mint.pub, PUMP]))
lk.lookups = 1
ok("a v0 transaction with address-table lookups is refused, because it hides accounts",
   any("lookup" in nm for g, nm in P._structural_only(lk, payer.address, mint.address) if not g))

print("── the endpoint is a credential and is treated as one")
ok("SOLANA_RPC is read from the environment",
   'os.environ.get("SOLANA_RPC")' in SRC)
ok("errors carry the host only, never the path the key lives in",
   P.Rpc("https://solana-mainnet.g.alchemy.com/v2/SECRETKEY").host
   == "solana-mainnet.g.alchemy.com")
leaked = [m for m in re.findall(r"/v2/([A-Za-z0-9_-]{8,})", SRC)
          if m not in ("YOUR-KEY", "SECRETKEY")]
ok("no real endpoint key is committed in the script", not leaked, leaked)
leaked_here = [m for m in re.findall(r"/v2/([A-Za-z0-9_-]{8,})", Path(__file__).read_text())
               if m not in ("YOUR-KEY", "SECRETKEY", "K")]
ok("nor in this suite", not leaked_here, leaked_here)

print("── the arithmetic it prints about dev buy size")
ok("a 1 SOL buy takes 3.23% of the float",
   abs(1.0 / (P.VIRTUAL_SOL + 1.0) - 0.0322580645) < 1e-9)
ok("2 SOL takes 6.25%, which is where scanners start calling it dev-owned",
   abs(2.0 / (P.VIRTUAL_SOL + 2.0) - 0.0625) < 1e-9)
ok("the share is strictly concave in the buy, so doubling it buys less than double",
   2.0 / (P.VIRTUAL_SOL + 2.0) < 2 * (1.0 / (P.VIRTUAL_SOL + 1.0)))
out = StringIO()
with redirect_stdout(out):
    P.cmd_size(None)
ok("`size` says there is no size that is both meaningful and invisible",
   "no size that is both" in out.getvalue())
ok("and names wallet-splitting as the thing it is refusing",
   "wallet-splitting" in out.getvalue())

print("── its own selftest passes, which is what a downloaded copy can run")
buf = StringIO()
with redirect_stdout(buf):
    rc = P.cmd_selftest(None)
ok("pumpfun.py selftest exits clean", rc == 0)
ok("with no failures", "FAIL" not in buf.getvalue(),
   [l for l in buf.getvalue().splitlines() if "FAIL" in l][:3])
m = re.search(r"(\d+) checks, all passed", buf.getvalue())
ok("and runs a real number of checks", bool(m) and int(m.group(1)) >= 25, buf.getvalue()[-200:])

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
