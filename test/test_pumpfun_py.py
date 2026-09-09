"""pumpfun.py — the Solana launch script, tested from outside itself.

Two things are different about this script from everything else in the repository, and both
are why this file exists.

  IT HOLDS A KEY. A script that submits a Solana transaction must sign it, and there is no
  browser-wallet path that would let something else do the signing. So the rule became a set of
  narrower ones — a FILE, never an argument; a fresh wallet, never a main one; a mode check;
  halves that must agree — and a rule nobody tests is a comment. Every one of them is driven
  here, including the refusals.

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
import shutil
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

    # Routed through send() so a subclass that overrides send() gets these for free — and so a
    # stub can never accidentally answer a question the real client would have asked the
    # network for.
    def blockhash_valid(self, bh, commitment="confirmed"):
        return bool(self.send("isBlockhashValid", [bh, {"commitment": commitment}])["value"])

    def block_height(self, commitment="confirmed"):
        return self.send("getBlockHeight", [{"commitment": commitment}])

    def blockhash(self, commitment="confirmed"):
        return self.send("getLatestBlockhash", [{"commitment": commitment}])["value"]


def fresh_site(d):
    """Copy web/ into `d` AND reset the address line to unpublished.

    The copy alone was the bug. Both publish tests seeded their fixture from the LIVE page, so
    the moment the real site carried an address the fixture started pre-published — and the
    test's own dry publish then tripped cmd_publish's "already publishes a DIFFERENT address"
    refusal as an UNCAUGHT RuntimeError, killing the module and taking `sh test/run.sh` to
    exit 1 with a traceback.

    That happens at LAUNCH.md step 7, in the window the runbook calls minutes long, to an
    operator whose next instruction is to commit and push — and the traceback reads "Refusing
    to overwrite it", which looks exactly like the publish having corrupted the page it was
    supposed to write. A test that goes red on success is worse than no test, and this is the
    SECOND time this file has had that bug: the assertion above was hardened for it and the
    fixture underneath it was missed.

    Resetting here also gives that assertion its meaning back — it requires data-ca="" in the
    fixture, which until now was true only by accident.
    """
    src, dst = ROOT / "web", Path(d) / "web"
    shutil.copytree(str(src), str(dst))
    f = dst / "index.html"
    f.write_text(re.sub(
        r'^(\s*)<div class="ca(?: none)?" id="ca" data-ca="[^"]*">.*</div>\s*$',
        r'\1<div class="ca none" id="ca" data-ca="">Not launched yet.</div>',
        f.read_text(), count=1, flags=re.M))
    return f


def launch_args(keypair, **over):
    a = type("A", (), {})()
    a.keypair, a.dev_buy, a.headroom, a.dry_run = keypair, 1.0, 0.5, True
    a.reserve = 0.03
    a.yes = True
    a.mint_keypair = a.grind = None
    a.name, a.symbol = "Snooze Bear", "SNOOZE"
    a.description = (ROOT / "description.txt").read_text().strip()
    a.website = "https://snoozebear.xyz"
    a.image = str(ROOT / "web" / "snooze.png")
    a.twitter = a.telegram = ""
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
        ok("it refuses a wallet that cannot cover the dev buy", "The dev buy is" in str(e))
    # THE GATE USED TO ASK FOR THE DEV BUY ALONE. A create also pays rent for the mint, the
    # token account and the metadata, plus pump.fun's fee — so a wallet holding EXACTLY the
    # dev buy passed the old check and then failed on chain, after the metadata was pinned.
    try:
        with redirect_stdout(StringIO()):
            with_rpc(StubRpc(int(1.0 * P.LAMPORTS)), P.cmd_launch, a)
        ok("a wallet holding EXACTLY the dev buy and nothing for fees is refused", False,
           "it proceeded, and the launch would have failed on chain")
    except RuntimeError as e:
        ok("a wallet holding EXACTLY the dev buy and nothing for fees is refused",
           "rent" in str(e) and "ESTIMATE" in str(e), str(e)[:160])
    ok("and the reserve is a flag with a stated estimate, not a hidden constant",
       "--reserve" in HELP.getvalue() and "ESTIMATE" in HELP.getvalue())

    print("── it will not launch through the public endpoint")
    try:
        with redirect_stdout(StringIO()):
            with_rpc(StubRpc(int(1.2 * P.LAMPORTS), keyed=False),
                     P.cmd_launch, launch_args(str(good), dry_run=False))
        ok("a real launch through the rate-limited public RPC is refused", False)
    except RuntimeError as e:
        ok("a real launch through the rate-limited public RPC is refused",
           "public endpoint" in str(e), str(e))

print("── the launch record, which is what makes a retry a retry")
with tempfile.TemporaryDirectory() as d:
    kp2 = P.Keypair.generate()
    rp = P.record_path(str(Path(d) / "launch.json"), kp2.address)
    ok("the record sits beside the keypair and is named for the mint",
       rp.name == "launch-" + kp2.address + ".json" and rp.parent == Path(d))
    P.write_record(rp, {"mint": kp2.address, "status": "sent"})
    ok("it is written 0600 and never wider", (rp.stat().st_mode & 0o777) == 0o600,
       oct(rp.stat().st_mode & 0o777))
    ok("and it reads back", P.read_record(rp)["mint"] == kp2.address)
    ok("existing_records finds it, which is what blocks a second launch",
       [x.name for x in P.existing_records(str(Path(d) / "launch.json"))] == [rp.name])

print("── the mint grind refuses what it cannot do in reasonable time")
try:
    with redirect_stdout(StringIO()):
        P.grind_mint("pump")
    ok("grinding 'pump' in pure Python is refused, not started", False, "it started")
except RuntimeError as e:
    ok("grinding 'pump' in pure Python is refused, not started",
       "solana-keygen grind" in str(e) and "--ends-with pump" in str(e))
try:
    P.grind_mint("0O")
    ok("a suffix with non-base58 characters is refused", False)
except RuntimeError as e:
    ok("a suffix with non-base58 characters is refused", "not base58 characters" in str(e))
with redirect_stdout(StringIO()):
    g, tries = P.grind_mint("z")
ok("a one-character suffix actually grinds", g.address.endswith("z") and tries >= 1)

print("── a secret key must not be committable, and .gitignore is only the backstop")
GI = (ROOT / ".gitignore").read_text()
for pat in ["launch-*.json", "launch.json", "id.json", "mint-*.json", "*keypair*.json"]:
    ok("gitignore covers %s" % pat, pat in GI)
ok("and it does NOT swallow vercel.json, which must be committed",
   "vercel.json" not in GI and not re.search(r"^\*\.json$", GI, re.M))
with tempfile.TemporaryDirectory() as d:
    os.makedirs(Path(d) / "repo" / ".git")
    ok("a record inside a git worktree is detected",
       P.in_git_worktree(Path(d) / "repo" / "launch-x.json") == Path(d, "repo").resolve())
    ok("and one outside it is not",
       P.in_git_worktree(Path(d) / "launch-x.json") is None)
    ok("detection walks up from a nested directory",
       P.in_git_worktree(Path(d) / "repo" / "a" / "b" / "launch-x.json")
       == Path(d, "repo").resolve())
    out = StringIO()
    with redirect_stdout(out):
        P.warn_if_committable(Path(d) / "repo" / "launch-x.json")
    ok("it warns, and says the key would be scraped", "SECRET KEY" in out.getvalue()
       and "scraped" in out.getvalue())
    ok("and points the operator outside the repository", "~/.snooze" in out.getvalue())
    quiet = StringIO()
    with redirect_stdout(quiet):
        P.warn_if_committable(Path(d) / "launch-x.json")
    ok("it stays silent when the record is outside a repository", quiet.getvalue() == "")
# The record itself must never be world-readable, whatever else is true.
with tempfile.TemporaryDirectory() as d:
    rp = Path(d) / "launch-x.json"
    os.umask(0)
    P.write_record(rp, {"mint": "x"})
    ok("write_record creates 0600 even under a permissive umask",
       (rp.stat().st_mode & 0o777) == 0o600, oct(rp.stat().st_mode & 0o777))

print("── the docs point keys outside the repository")
LM = (ROOT / "LAUNCH.md").read_text()
ok("LAUNCH.md keeps the launch keypair out of the tree",
   "~/.snooze/launch.json" in LM and "-o ./launch.json" not in LM)
ok("and the ground mint too", "cd ~/.snooze && solana-keygen grind" in LM)
ok("and says why rather than just where", "scraped in minutes" in LM)

print("── the launch image and the site show the SAME picture")
LAUNCH_IMG = ROOT / "web" / "token.jpg"
ok("the launch image exists", LAUNCH_IMG.is_file())
ok("LAUNCH.md points --image at it", "--image ./web/token.jpg" in (ROOT / "LAUNCH.md").read_text())
try:
    from PIL import Image
except ImportError:
    # The suite promises "nothing to install", so this one is skipped rather than failed when
    # Pillow is absent. Everything else here runs on the standard library alone.
    ok("(pixel comparison skipped — Pillow not installed)", True)
else:
    def _sig(path, n=16):
        im = Image.open(path).convert("RGB").resize((n, n), Image.LANCZOS)
        return list(im.tobytes())
    def _diff(a, b):
        return sum(abs(x - y) for x, y in zip(a, b)) / (len(a) * 255)
    base = _sig(LAUNCH_IMG)
    # A CAREFUL BUYER COMPARES THE TWO PICTURES. Two different bears — one on pump.fun, one on
    # the site — is precisely the signal a copycat produces, so a mismatch here is not cosmetic.
    for rel in ("web/snooze-512.webp", "web/icon.png", "web/hero.png"):
        d = _diff(base, _sig(ROOT / rel))
        ok("%s is the same picture as the launch image" % rel, d < 0.02,
           "mean pixel difference %.4f — the site and the token would show different art" % d)

print("── the metadata is permanent, so it is checked before it is pinned")
DESC = (ROOT / "description.txt").read_text().strip()
ok("the launch copy is in the repo, not in somebody's shell history", DESC != "")
ok("and it fits", len(DESC.encode()) < 2000)
ok("the real metadata passes",
   P.check_metadata("Snooze Bear", "SNOOZE", DESC, "https://snoozebear.xyz") == [])
# Every one of these is unfixable after the create instruction runs.
for label, args_, want in [
    ("an empty description", ("Snooze Bear", "SNOOZE", "  ", "https://x"), "description is empty"),
    ("an empty name", ("", "SNOOZE", DESC, "https://x"), "name is empty"),
    ("an empty symbol", ("Snooze Bear", " ", DESC, "https://x"), "symbol is empty"),
    ("no website", ("Snooze Bear", "SNOOZE", DESC, ""), "no --website"),
    ("a symbol over 10 bytes", ("Snooze Bear", "SNOOZEBEARCOIN", DESC, "https://x"), "allows 10"),
    ("a name over 32 bytes", ("S" * 33, "SNOOZE", DESC, "https://x"), "allows 32"),
]:
    bad = P.check_metadata(*args_)
    ok("%s is refused" % label, any(want in b for b in bad), bad)
# BYTES, not characters. An emoji is four, and a name that looks short on screen is not.
emoji = "S" * 20 + "\U0001F43B" * 4   # 24 characters, 36 bytes
ok("the limits are measured in bytes, so emoji count properly",
   len(emoji) <= 32 and len(emoji.encode()) > 32
   and any("allows 32" in b for b in P.check_metadata(emoji, "SNOOZE", DESC, "https://x")))
ok("and every refusal says it cannot be fixed later",
   all("permanent" in b or "cannot be edited" in b or "empty" in b or "copycat" in b
       for b in P.check_metadata("", "", "", "")))

print("── it prompts, but never for key material")
ok("--keypair may be omitted and prompted for",
   'add_argument("--keypair", default=None' in SRC)
ok("--dev-buy may be omitted and prompted for",
   'add_argument("--dev-buy", type=float, default=None' in SRC)
ok("and neither has a DEFAULT VALUE — being asked is not the same as being guessed",
   "ask_float(" in SRC and 'ask_keypair_path("~/.snooze/launch.json")' in SRC)
# THE ONE THING IT WILL NOT BECOME INTERACTIVE ABOUT.
ok("there is no prompt for a private key, a seed or a mnemonic",
   not re.search(r"(getpass|ask)\([^)]*(private key|secret key|seed phrase|mnemonic)",
                 SRC, re.I))
# The IMPORTS, not a substring. "getpass" appears in pumpfun.py's own comment explaining why
# it does not use one — the same trap as grepping the file for "secp256k1", and the third time
# this pattern has bitten in this project.
import ast as _ast
_imported = set()
for _n in _ast.walk(_ast.parse(SRC)):
    if isinstance(_n, _ast.Import):
        _imported.update(a.name.split(".")[0] for a in _n.names)
    elif isinstance(_n, _ast.ImportFrom) and _n.module:
        _imported.add(_n.module.split(".")[0])
ok("getpass is not imported — a masked prompt is still a paste, and the risk is the clipboard",
   "getpass" not in _imported, sorted(_imported))
ok("nor is any wallet, signing or crypto package",
   not (_imported & {"eth_account", "web3", "solana", "solders", "nacl", "ecdsa",
                     "coincurve", "cryptography", "subprocess"}), sorted(_imported))
for good in ("~/.snooze/launch.json", "./launch.json", "/home/brad/.snooze/launch.json",
             "So11111111111111111111111111111111111111112"):
    ok("a path or a pubkey is accepted: %s" % good[:34], not P.looks_like_secret(good))
# 64 bytes of base58 is ~87-88 chars. That is what a wallet's "export private key" produces,
# and it is what got pasted into a chat window once already.
import random as _r
_rng = _r.Random(8453)
for n in (87, 88):
    fake = "".join(_rng.choice(P._B58) for _ in range(n))
    ok("a %d-character base58 blob is caught as key material" % n, P.looks_like_secret(fake))
ok("and the refusal does not echo what was pasted",
   "does not print what was typed" in SRC or "Deliberately does not print" in SRC)

print("── the last door is a typed ticker, not a keypress")
ok("there is a confirmation before anything irreversible",
   "type the ticker to launch" in SRC)
ok("it compares against the symbol, so it cannot be answered reflexively",
   '!= args.symbol' in SRC)
ok("--yes exists for a scripted launch and says who it is for",
   '"--yes"' in SRC and "if you are typing" in SRC)
ok("stopping there leaves the launch resumable rather than half-done",
   "continues this launch rather than starting a different one" in SRC)

print("── --description is required, and readable from a file")
SRC_D = (ROOT / "pumpfun.py").read_text()
ok("it has no default, like --dev-buy", 'add_argument("--description", default=None' in SRC_D)
ok("@file is supported so a paragraph is not a shell argument", 'd.startswith("@")' in SRC_D)
out = StringIO()
try:
    with redirect_stdout(out):
        P.main(["launch", "--keypair", "/dev/null", "--dev-buy", "1",
                "--name", "X", "--symbol", "X", "--image", "x.png"])
    ok("omitting it refuses before anything happens", False, "it proceeded")
except SystemExit as e:
    ok("omitting it refuses before anything happens", "--description is required" in str(e))

print("── the order of operations, which is what stops a lost mint or a lost dev buy")
with tempfile.TemporaryDirectory() as d:
    kpf = Path(d) / "launch.json"
    kpx = P.Keypair.generate()
    kpf.write_text(json.dumps(list(kpx._seed + kpx.pub)))
    os.chmod(kpf, 0o600)
    a = launch_args(str(kpf), image=str(Path(d) / "nope.png"))
    # The image is opened FIRST. It used to surface as an uncaught FileNotFoundError from
    # inside upload_metadata — after a grind of several minutes — and --dry-run never opened
    # it at all, so the rehearsal passed on the same typo the real run died on.
    try:
        with redirect_stdout(StringIO()):
            with_rpc(StubRpc(int(1.2 * P.LAMPORTS)), P.cmd_launch, a)
        ok("a missing --image is refused before anything expensive", False, "it proceeded")
    except RuntimeError as e:
        ok("a missing --image is refused before anything expensive", "no image at" in str(e))
    empty = Path(d) / "empty.png"
    empty.write_bytes(b"")
    a = launch_args(str(kpf), image=str(empty))
    try:
        with redirect_stdout(StringIO()):
            with_rpc(StubRpc(int(1.2 * P.LAMPORTS)), P.cmd_launch, a)
        ok("an empty --image is refused too", False)
    except RuntimeError as e:
        ok("an empty --image is refused too", "is empty" in str(e))
ok("and a missing file reaches the operator as one line, not a traceback",
   "OSError" in (ROOT / "pumpfun.py").read_text().split("except (RuntimeError")[1][:120])

print("── resume keeps the settings the launch was made with")
SRC_R = (ROOT / "pumpfun.py").read_text()
ok("resume's --slippage defaults to None so the record can win",
   'add_argument("--slippage", type=int, default=None' in SRC_R)
ok("and it reads slippage back off the record",
   'record.get("slippage"' in SRC_R and 'record.get("priority_fee"' in SRC_R)
ok("the launch writes them there in the first place",
   '"slippage": args.slippage' in SRC_R and '"priority_fee": args.priority_fee' in SRC_R)

print("── the confirmation loop cannot swallow its own verdict")
ok("a landed-and-failed transaction raises a distinct type",
   issubclass(P.LaunchFailed, RuntimeError))
class FailedRpc(StubRpc):
    def __init__(s): StubRpc.__init__(s); s.n = 0
    def send(s, m, p=None):
        s.n += 1
        if s.n > 8:
            raise AssertionError("the loop never escaped")
        if m == "getSignatureStatuses":
            return {"value": [{"confirmationStatus": "confirmed", "err": {"Custom": 6002}}]}
        if m == "isBlockhashValid":
            return {"value": True}
        raise AssertionError(m)
with tempfile.TemporaryDirectory() as d:
    rp = Path(d) / "r.json"
    P.write_record(rp, {})
    try:
        with redirect_stdout(StringIO()):
            P._await_confirmation(FailedRpc(), "SIG", "BH", "MINT", rp, {})
        ok("it stops on a failed transaction instead of looping", False, "it returned")
    except P.LaunchFailed as e:
        ok("it stops on a failed transaction instead of looping", "landed and FAILED" in str(e))
    except AssertionError as e:
        ok("it stops on a failed transaction instead of looping", False, str(e))
    ok("and it records why", P.read_record(rp).get("status") == "landed-and-failed")

class DeadRpc(StubRpc):
    def send(s, m, p=None):
        if m == "getSignatureStatuses": return {"value": [None]}
        if m == "isBlockhashValid": return {"value": False}
        raise AssertionError(m)
with tempfile.TemporaryDirectory() as d:
    rp = Path(d) / "r.json"
    rec = {"signature": "SIG", "status": "sent"}
    P.write_record(rp, rec)
    with redirect_stdout(StringIO()):
        landed = P._await_confirmation(DeadRpc(), "SIG", "BH", "MINT", rp, rec)
    ok("an expired blockhash with nothing on chain is not 'landed'", landed is False)
    # WITHOUT THIS, resume finds a recorded signature, re-checks a transaction that can never
    # land, reports the same dead end, and never rebuilds. Forever.
    ok("and the dead signature is CLEARED so resume rebuilds instead of re-checking it",
       P.read_record(rp)["signature"] is None)
    ok("with the reason recorded", P.read_record(rp)["status"] == "expired-never-landed")

print("── the verifier's ceiling clears the script's own cost estimate")
import inspect
sig = inspect.signature(P.verify_transaction)
ceiling = sig.parameters["fee_ceiling"].default
ok("the fee ceiling is at least the default --reserve, or a correct launch fails itself",
   ceiling >= 0.03 * P.LAMPORTS, "%d lamports vs a 0.03 SOL reserve" % ceiling)

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

# ── address lookup tables
#
# THE REAL LAUNCH RETURNED ONE OF THESE. The first version of this check refused any v0
# transaction carrying a lookup table, which sounds strict and is not a security property: it
# fires on every v0 transaction whatever is inside, so it cannot tell "I could not see it"
# apart from "it is dangerous", and the only thing it can teach an operator is to override it.
# What matters is whether the hidden accounts can be RESOLVED — and, once resolved, whether
# the program behind them is one this launch needs.
print("── address lookup tables, which is where a v0 transaction hides its accounts")


def build_v0(keys, table=None, prog_index=2, signers=2):
    """A versioned message. `table` is (table_pubkey, [writable idx], [readonly idx])."""
    lk = P._shortvec_encode(0)
    if table:
        key, w, r = table
        lk = (P._shortvec_encode(1) + key
              + P._shortvec_encode(len(w)) + bytes(w)
              + P._shortvec_encode(len(r)) + bytes(r))
    msg = (bytes([0x80]) + bytes([signers, 0, 1]) + P._shortvec_encode(len(keys))
           + b"".join(keys) + bytes(32)
           + P._shortvec_encode(1) + bytes([prog_index])
           + P._shortvec_encode(1) + bytes([0])
           + P._shortvec_encode(2) + b"\x01\x02" + lk)
    return P._shortvec_encode(signers) + bytes(64) * signers + msg


TABLE = P.b58decode("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")
STRANGER = P.b58decode("FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe")


class FakeRpc(P.Rpc):
    """A cluster that serves exactly one lookup table, so resolution is testable offline."""

    def __init__(self, addrs, missing=False):
        self.addrs = addrs
        self.missing = missing
        self.url = "https://fake.invalid"
        self.host_ = "fake.invalid"

    @property
    def host(self):
        return self.host_

    def lookup_table(self, addr, commitment="confirmed"):
        if self.missing:
            raise RuntimeError("lookup table %s does not exist on %s" % (addr, self.host))
        return [P.b58encode(a) for a in self.addrs]


v0 = P.Transaction(build_v0([payer.pub, mint.pub], table=(TABLE, [], [0])))
ok("a versioned message parses as version 0", v0.version == 0)
ok("its lookup entries are decoded, not just counted",
   v0.lookups == 1 and v0.lookup_tables[0]["key"]
   == "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", v0.lookup_tables)
ok("before resolution, an index into the table cannot be named",
   v0.program_of(v0.instructions[0]).startswith("(behind"))
ok("and that is a refusal, not a shrug",
   any("lookup" in nm for g, nm in
       P._structural_only(v0, payer.address, mint.address) if not g))

pulled = FakeRpc([PUMP]).resolve_lookups(v0)
ok("resolving appends the table's accounts after the message's own",
   v0.resolved_keys == [payer.address, mint.address,
                        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"], v0.resolved_keys)
ok("and the program behind the table is now named",
   v0.program_of(v0.instructions[0]) == "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
ok("describe says how many accounts came from where",
   "from lookup tables" in v0.describe(), v0.describe())

# WRITABLE BEFORE READONLY, ACROSS THE WHOLE ENTRY LIST. That is the runtime's order, and an
# index into the wrong order names a different account than the one that executes.
ordered = P.Transaction(build_v0([payer.pub, mint.pub], table=(TABLE, [1], [0])))
FakeRpc([PUMP, STRANGER]).resolve_lookups(ordered)
ok("writable accounts come before readonly ones",
   ordered.resolved_keys[2:] == ["FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe",
                                 "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
   ordered.resolved_keys)

# THE WHOLE POINT. A stranger program hidden behind a table is refused exactly as one named in
# the message is — this is the case the live launch actually hit.
hidden = P.Transaction(build_v0([payer.pub, mint.pub], table=(TABLE, [], [0])))
failed = [nm for g, nm in
          P._structural_only(hidden, payer.address, mint.address, FakeRpc([STRANGER]))
          if not g]
ok("an unknown program reached through a lookup table is still refused",
   any("program it invokes is one this launch needs" in nm for nm in failed), failed)
ok("and the refusal names it, so it can be looked up rather than guessed at",
   any("FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe" in nm for nm in failed), failed)
ok("and points at the command that identifies it",
   any("pumpfun.py program" in nm for nm in failed), failed)

# A table that is short of an index the message uses resolves to the WRONG account if you let
# it — Python would happily take addrs[-1]. It must refuse instead.
short = P.Transaction(build_v0([payer.pub, mint.pub], table=(TABLE, [], [7])))
try:
    FakeRpc([PUMP]).resolve_lookups(short)
    ok("a table too short for the index it is asked for is refused", False)
except RuntimeError as e:
    ok("a table too short for the index it is asked for is refused", "holds 1" in str(e), str(e))
ok("and nothing partial is left behind on the transaction", short.resolved_keys is None)

gone = P.Transaction(build_v0([payer.pub, mint.pub], table=(TABLE, [], [0])))
failed = [nm for g, nm in
          P._structural_only(gone, payer.address, mint.address, FakeRpc([], missing=True))
          if not g]
ok("a lookup table that does not exist is a refusal, not an empty resolution",
   any("does not exist" in nm for nm in failed), failed)

ok("a v0 transaction with no tables needs no cluster and still passes",
   all(g for g, _ in P._structural_only(
       P.Transaction(build_v0([payer.pub, mint.pub, PUMP])),
       payer.address, mint.address)))

# ── program provenance
#
# `program` is what you run when the allowlist refuses an id. It must not report an upgradable
# program as frozen: "authority: none" is the difference between code that cannot change under
# you and code that can.
print("── program provenance, for an id the allowlist refuses")


class ProgRpc(P.Rpc):
    def __init__(self, accounts):
        self.accounts = accounts
        self.url = "https://fake.invalid"

    @property
    def host(self):
        return "fake.invalid"

    def account(self, addr, commitment="confirmed"):
        return self.accounts.get(addr)


import base64 as _b64

PROGDATA = "5tDNqFvSHPqoZTxdkR7oDgAkK7dGGwZDbSjMTNZBqCVK"


def prog_pair(authority):
    """A BPF-upgradeable program account and the ProgramData account behind it."""
    stub = _b64.b64encode(b"\x02\x00\x00\x00" + P.b58decode(PROGDATA)).decode()
    auth = (b"\x01" + P.b58decode(authority)) if authority else b"\x00" + bytes(32)
    pd = _b64.b64encode(b"\x03\x00\x00\x00" + (12345).to_bytes(8, "little") + auth).decode()
    return {"FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe":
            {"executable": True, "owner": P.BPF_UPGRADEABLE_LOADER, "lamports": 1,
             "data": [stub, "base64"]},
            PROGDATA: {"executable": False, "owner": P.BPF_UPGRADEABLE_LOADER, "lamports": 1,
                       "data": [pd, "base64"]}}


UNK = "FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe"
info = ProgRpc(prog_pair(payer.address)).program_provenance(UNK)
ok("an upgradeable program reports its authority",
   info["authority"] == payer.address and info["authority_known"], info)
ok("and the deploy slot it was last written at", info["slot"] == 12345, info)
info = ProgRpc(prog_pair(None)).program_provenance(UNK)
ok("a revoked authority reads as frozen, not as unknown",
   info["authority"] is None and info["authority_known"] is True, info)
ok("an address with nothing deployed at it says so",
   ProgRpc({}).program_provenance(UNK) == {"exists": False, "address": UNK})

# The one that matters: the id from the live launch must NOT be on the allowlist. If a future
# edit adds it because a transaction was refused and the launch was in a hurry, this fails.
ok("the unidentified program from the live launch is not on the allowlist",
   UNK not in P.KNOWN_PROGRAMS)
ok("the allowlist is still exactly the six programs a launch needs",
   len(P.KNOWN_PROGRAMS) == 6, sorted(P.KNOWN_PROGRAMS))
ok("and the unidentified id is not on pump.fun's published list either",
   UNK not in P.PUMP_PUBLISHED, sorted(P.PUMP_PUBLISHED))

# ── what an instruction is ASKING FOR
#
# An Anchor instruction opens with sha256("global:<name>")[:8]. The live transaction sends 26
# bytes to an unidentified program; if those bytes open with pump.fun's own buy discriminator,
# something is reimplementing pump.fun's interface, and that is the single most useful fact
# available before signing. These are the published values, not this file's own arithmetic.
print("── an instruction names what it is asking for")
ok("pump.fun's buy discriminator is the published one",
   P.DISCRIMINATORS.get("66063d1201daebea") == "buy")
ok("and its create discriminator is too",
   P.DISCRIMINATORS.get("181ec828051c0777") == "create")

wrapped = P.Transaction(build_v0([payer.pub, mint.pub, STRANGER], prog_index=2))
wrapped.instructions[0]["data"] = bytes.fromhex("66063d1201daebea") + b"\x00" * 18
shown = wrapped.describe()
ok("a buy sent to a foreign program is called out by name in the description",
   "is not pump.fun's" in shown and "buy" in shown, shown)

native = P.Transaction(build_v0([payer.pub, mint.pub, PUMP], prog_index=2))
native.instructions[0]["data"] = bytes.fromhex("66063d1201daebea") + b"\x00" * 18
ok("and the same instruction to pump.fun itself is not",
   "is not pump.fun's" not in native.describe(), native.describe())

def _raises(fn, exc):
    try:
        fn()
    except exc:
        return True
    except Exception:
        return False
    return False


SYS_ADDR = "11111111111111111111111111111111"

# ── building the transaction here instead of asking for one
#
# The launch stopped because a third-party builder addressed the BUY to a program pump.fun
# does not publish. These check the replacement, and the thing they are really checking is the
# MESSAGE COMPILER: an account's index is what an instruction means, so an ordering bug does
# not raise, it silently sends a different transaction than the one displayed.
print("── the transaction is assembled here, against pump.fun's own program")

ok("the global PDA is the address pump.fun publishes",
   P.find_program_address([b"global"], P.PUMP_PROGRAM)
   == "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf")
ok("the mint-authority PDA is too",
   P.find_program_address([b"mint-authority"], P.PUMP_PROGRAM)
   == "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM")
ok("and the event-authority PDA is too",
   P.find_program_address([b"__event_authority"], P.PUMP_PROGRAM)
   == "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1")
# A PDA must be OFF the curve — that is the entire guarantee, because a point on the curve may
# have a private key. A real public key is on it; a derived address is not.
ok("a real public key is on the curve", P._is_on_curve(payer.pub))
ok("and a derived address is not",
   not P._is_on_curve(P.b58decode(P.find_program_address([b"global"], P.PUMP_PROGRAM))))
ok("a seed longer than 32 bytes is refused rather than truncated",
   _raises(lambda: P.find_program_address([b"x" * 33], P.PUMP_PROGRAM), ValueError))

GLOBAL = {"address": P.find_program_address([b"global"], P.PUMP_PROGRAM), "initialized": True,
          "authority": SYS_ADDR, "fee_recipient": "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
          "initial_virtual_token_reserves": 1_073_000_000_000_000,
          "initial_virtual_sol_reserves": 30_000_000_000,
          "initial_real_token_reserves": 793_100_000_000_000,
          "token_total_supply": 1_000_000_000_000_000, "fee_basis_points": 95}

# x*y=k on the virtual reserves. 0.5 SOL into a 30 SOL curve takes 0.5/30.5 of the virtual
# token side — the token units cancel, so this is checkable without knowing the supply.
got = P.curve_buy_amount(500_000_000, GLOBAL)
want = 1_073_000_000_000_000 * 500_000_000 // 30_500_000_000
ok("the curve math is the constant product, not an approximation",
   abs(got - want) <= 1, (got, want))
ok("it never promises more than the curve actually holds",
   P.curve_buy_amount(10_000 * 10 ** 9, GLOBAL) == GLOBAL["initial_real_token_reserves"])
ok("a non-positive buy is refused", _raises(lambda: P.curve_buy_amount(0, GLOBAL), ValueError))

ixs, detail = P.build_create_and_buy_direct(
    payer.address, mint.address, "Snooze Bear", "SNOOZE", "https://ipfs.io/ipfs/x",
    500_000_000, 10.0, GLOBAL, 250_000, 100)
built = P.Transaction(P._shortvec_encode(2) + bytes(64) * 2
                      + P._compile(payer.address, SYS_ADDR, ixs))

ok("slippage is a ceiling on what it may spend, not a target",
   detail["max_sol_cost"] == 550_000_000, detail)
ok("both pump.fun instructions go to pump.fun and nowhere else",
   [built.program_of(i) for i in built.instructions][2:] [::2]
   == [P.PUMP_PROGRAM, P.PUMP_PROGRAM],
   [built.program_of(i) for i in built.instructions])
ok("the create carries the published create discriminator",
   built.instructions[2]["data"][:8] == P.DISC_CREATE)
ok("the buy carries the published buy discriminator",
   built.instructions[4]["data"][:8] == P.DISC_BUY)
ok("the name, symbol and uri are borsh strings, length-prefixed",
   built.instructions[2]["data"][8:12] == (11).to_bytes(4, "little")
   and built.instructions[2]["data"][12:23] == b"Snooze Bear")
ok("the creator recorded in create is the payer, which is what makes creator_vault derivable",
   built.instructions[2]["data"][-32:] == payer.pub)
ok("it uses no lookup tables, so every account is in the bytes that get signed",
   built.lookups == 0 and built.version == "legacy")

# THE SEED THAT WAS WRONG. buy's fee_config is a PDA of the FEE program whose second seed is
# the 32 bytes of the BONDING CURVE program's id. It was first written as an 8-byte hex
# literal — copied from a debug print that had truncated it — which derived an address that is
# not pump.fun's fee_config, and the buy failed simulation with Anchor 3012,
# AccountNotInitialized. A literal cannot be checked by reading it; a decode can.
FEE_CONFIG = P.find_program_address([b"fee_config", P.b58decode(P.PUMP_PROGRAM)],
                                    P.PUMP_FEE_PROGRAM)
ok("fee_config's second seed is the whole 32-byte pump program id",
   len(P.b58decode(P.PUMP_PROGRAM)) == 32)
ok("and the buy passes that derived fee_config, not a truncated one",
   FEE_CONFIG in [a.key for _, accs, _ in ixs for a in accs], FEE_CONFIG)
ok("which is a different address than the truncated seed produced",
   FEE_CONFIG != P.find_program_address([b"fee_config", bytes.fromhex("0156e0f693665acf")],
                                        P.PUMP_FEE_PROGRAM))

# A buy WRITES to the user's volume accumulator and pump.fun does not create it on the way
# past. A wallet that has never bought does not have one, which is every fresh launch wallet.
uva = P.find_program_address([b"user_volume_accumulator", P.b58decode(payer.address)],
                             P.PUMP_PROGRAM)
with_init, d2 = P.build_create_and_buy_direct(
    payer.address, mint.address, "Snooze Bear", "SNOOZE", "u", 500_000_000, 10.0, GLOBAL,
    250_000, 0, True)
discs = [i[2][:8] for i in with_init]
ok("a wallet with no volume account gets one created in the same transaction",
   P.DISC_INIT_USER_VOLUME in discs, [d.hex() for d in discs])
ok("and the init comes BEFORE the buy that writes to it",
   discs.index(P.DISC_INIT_USER_VOLUME) < discs.index(P.DISC_BUY))
ok("the init points at the same accumulator the buy does",
   with_init[discs.index(P.DISC_INIT_USER_VOLUME)][1][2].key == uva)
ok("the published discriminator for it is the one used",
   P.DISC_INIT_USER_VOLUME == bytes([94, 6, 202, 115, 255, 96, 232, 183]))
# Running it against an account that already exists FAILS, so a wallet that has bought before
# must not get one. Guessing either way is a failed transaction.
ok("a wallet that already has one does not get a second init",
   P.DISC_INIT_USER_VOLUME not in [i[2][:8] for i in ixs])
ok("and the launch asks the chain rather than assuming",
   "rpc.account(uva) is None" in SRC)

# THE COMPILER. Every index in every instruction must resolve back to the account the builder
# asked for, in order, with the flags it asked for. This is the check that an ordering bug
# cannot survive, and an ordering bug is silent: it signs a different transaction.
keys = built.account_keys
nsig = built.num_required_signatures
nro_signed = built.num_readonly_signed
nro_unsigned = built.num_readonly_unsigned


def _is_signer(k):
    return k < nsig


def _is_writable(k):
    if k < nsig:
        return k < nsig - nro_signed
    return k < len(keys) - nro_unsigned


bad = []
for ix, (prog, accs, data) in zip(built.instructions, ixs):
    if built.program_of(ix) != prog:
        bad.append(("program", prog))
    if [keys[k] for k in ix["accounts"]] != [a.key for a in accs]:
        bad.append(("order", prog, [keys[k] for k in ix["accounts"]], [a.key for a in accs]))
    if ix["data"] != data:
        bad.append(("data", prog))
ok("every instruction's accounts resolve back, in order, to what was asked for", not bad, bad)

flagbad = []
for _, accs, _ in ixs:
    for a in accs:
        k = keys.index(a.key)
        if a.signer and not _is_signer(k):
            flagbad.append(("signer lost", a.key))
        if a.writable and not _is_writable(k):
            flagbad.append(("writable lost", a.key))
ok("no account loses a signer or writable flag in compilation", not flagbad, flagbad)
ok("the fee payer is first, and is a writable signer",
   keys[0] == payer.address and _is_signer(0) and _is_writable(0))
ok("the mint signs, because create makes it", _is_signer(keys.index(mint.address)))
ok("the program ids themselves are readonly non-signers",
   not _is_writable(keys.index(P.PUMP_PROGRAM))
   and not _is_signer(keys.index(P.PUMP_PROGRAM)))
# The header's counts and the key order have to agree; a message where they disagree is
# accepted by this parser and rejected by the cluster, after the fee is paid.
ok("the header's readonly counts do not exceed the keys they describe",
   nro_signed <= nsig and nsig + nro_unsigned <= len(keys),
   (nsig, nro_signed, nro_unsigned, len(keys)))
ok("a transaction with no fee payer among its accounts is refused, not compiled",
   _raises(lambda: P._compile(other.address, SYS_ADDR, ixs), RuntimeError))

# `direct` is the default, and this asks the PARSER rather than grepping the source — the
# grep passes on a line that merely mentions the word. If this ever silently flips back, a
# launch goes through the builder whose transaction could not be identified.
_parsed = P.build_parser().parse_args(
    ["launch", "--name", "n", "--symbol", "s", "--image", "i"])
ok("direct is the default builder", _parsed.builder == "direct", _parsed.builder)
ok("and pumpportal is still reachable, so the refusal stays reproducible",
   P.build_parser().parse_args(
       ["launch", "--name", "n", "--symbol", "s", "--image", "i",
        "--builder", "pumpportal"]).builder == "pumpportal")

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

print("── the site is Solana-only, and nothing drags Base back into it")
SITE = (ROOT / "web" / "index.html").read_text()
ok("the page carries no Base blue", "0052ff" not in SITE.lower())
ok("it does not mention Base", not re.search(r"\bBase\b", SITE),
   (re.findall(r".{40}\bBase\b.{40}", SITE) or [""])[0])
ok("it does not mention $DREAM, which cannot exist on a pump.fun token",
   "DREAM" not in SITE)
ok("no EVM anything — no 0x addresses, no chainId, no eth_ methods",
   not re.search(r"\b0x[0-9a-fA-F]{40}\b|chainId|\beth_[a-z]", SITE))
ok("it holds no signing or sending code",
   not re.search(r"eth_send|personal_sign|signTransaction|signMessage|signAndSend", SITE))
ok("it says outright that it cannot send a transaction",
   "cannot send a transaction" in SITE)
# snoogebear.xyz appears in og:url and og:image, which must be absolute to unfurl at all.
ok("it reaches only pump.fun, solscan, dexscreener and its own origin",
   set(re.findall(r"https://([a-z0-9.]+)", SITE))
   == {"pump.fun", "solscan.io", "dexscreener.com", "snoozebear.xyz"},
   sorted(set(re.findall(r"https://([a-z0-9.]+)", SITE))))
ok("the link preview image is absolute, or it does not unfurl",
   'og:image" content="https://' in SITE)
# Prose wraps across source lines, so these read a whitespace-flattened copy. They assert the
# IDEA survives a rewrite, not one phrasing: an address typo is unrecoverable, and the page says
# out loud that the thing may go to zero.
SITE_PROSE = " ".join(SITE.split())
ok("it warns that a Solana address has no error detection",
   "no typo check" in SITE_PROSE or "no checksum" in SITE_PROSE)
ok("and it says the thing most token sites do not",
   "Nothing is behind it" in SITE_PROSE and "goes to zero" in SITE_PROSE)
# NO href, not aria-disabled. aria-disabled is announced but does not stop a click, and
# pointer-events:none does not stop the keyboard — Tab then Enter opened pump.fun's homepage,
# where the first search result for a token name is not necessarily the token. An anchor
# without href is not focusable and not activatable, with or without CSS.
BTNS = re.findall(r'<a class="btn (?:buy|sell)"[^>]*>', SITE)
ok("there are two trade buttons", len(BTNS) == 2, BTNS)
ok("and neither has an href until an address is published",
   all("href=" not in b for b in BTNS), BTNS)
# EITHER EMPTY OR A REAL ADDRESS. Asserting it is empty made `sh test/run.sh` fail the moment
# the address was published — at step 7 of LAUNCH.md, the step the runbook calls a
# minutes-long window, where the operator's next instruction is to commit and push. A test
# that goes red on success trains people to ignore it exactly when it matters.
CA_LINE = re.search(r'<div class="ca(?: none)?" id="ca" data-ca="([^"]*)">', SITE)
ok("the page has the address line publish rewrites", CA_LINE is not None)
ok("and it is either unpublished or a valid 32-byte base58 address",
   CA_LINE is not None and (CA_LINE.group(1) == ""
                            or len(P.b58decode(CA_LINE.group(1))) == 32),
   CA_LINE.group(1) if CA_LINE else "(absent)")
ok("the address is in the MARKUP, not only in the script — the page works with JS off",
   'data-ca=' in SITE.split("<script>")[0])
ok("web/ holds exactly one page", sorted(
   x.name for x in (ROOT / "web").glob("*.html")) == ["index.html"],
   sorted(x.name for x in (ROOT / "web").glob("*.html")))

print("── the suite must pass on a PUBLISHED page, or it goes red at the worst moment")
with tempfile.TemporaryDirectory() as d:
    f = fresh_site(d)
    ok("fresh_site resets the fixture's address line no matter what the live page holds",
       'data-ca=""' in f.read_text() and "Not launched yet" in f.read_text())
# The live page, published, put through the same assertions this module makes about it. This
# is the guard the last fix missed: the CA_LINE assertion was hardened and the FIXTURE thirty
# lines below it was left seeded from the live page, so publishing still killed the run.
PUBLISHED = re.sub(
    r'^(\s*)<div class="ca(?: none)?" id="ca" data-ca="[^"]*">.*</div>\s*$',
    r'\1<div class="ca" id="ca" data-ca="8HDvsFdweJ34a5m1yCyDdvFgpw1pB3GJqY1L5cCxyeHx">'
    r'8HDvsFdweJ34a5m1yCyDdvFgpw1pB3GJqY1L5cCxyeHx</div>',
    SITE, count=1, flags=re.M)
m = re.search(r'<div class="ca(?: none)?" id="ca" data-ca="([^"]*)">', PUBLISHED)
ok("a published page still parses as a valid address line",
   m is not None and len(P.b58decode(m.group(1))) == 32)
ok("and the address is in the markup, before any script",
   m.group(1) in PUBLISHED.split("<script>")[0])
ok("publishing changes exactly one line",
   sum(1 for a, b in zip(SITE.splitlines(), PUBLISHED.splitlines()) if a != b) == 1)

print("── publish writes the address into the page, and refuses to overwrite a different one")
{
}
class PubRpc(StubRpc):
    def __init__(self, kind="mint", decimals=6, mint_auth=None):
        StubRpc.__init__(self)
        self._kind, self._dec, self._ma = kind, decimals, mint_auth
    def send(self, method, params=None):
        if method == "getAccountInfo":
            if self._kind is None:
                return {"value": None}
            return {"value": {"data": {"parsed": {
                "type": self._kind,
                "info": {"decimals": self._dec, "supply": "1000000000000000",
                         "mintAuthority": self._ma, "freezeAuthority": None}}}}}
        raise AssertionError("unexpected " + method)

MINT = P.Keypair.generate().address
import shutil
with tempfile.TemporaryDirectory() as d:
    fresh_site(d)
    real_here = P.HERE
    P.HERE = Path(d)
    try:
        a = type("A", (), {})()
        a.mint, a.record, a.write = MINT, None, False
        out = StringIO()
        with redirect_stdout(out):
            with_rpc(PubRpc(), P.cmd_publish, a)
        ok("a dry publish reports what it would write and writes nothing",
           "would write" in out.getvalue()
           and 'data-ca=""' in (Path(d) / "web/index.html").read_text())
        a.write = True
        out = StringIO()
        with redirect_stdout(out):
            with_rpc(PubRpc(), P.cmd_publish, a)
        wrote = (Path(d) / "web/index.html").read_text()
        ok("--write puts the mint in the page",
           ('data-ca="%s"' % MINT) in wrote and (">%s</div>" % MINT) in wrote)
        ok("and it is readable with no JavaScript at all",
           MINT in wrote.split("<script>")[0])
        # THE LINKS TOO, not just the address. They were filled only by the page's script, so a
        # visitor with JavaScript blocked got a correct contract address and three links to
        # bare domains — the same hole the address itself had, one element over.
        markup = wrote.split("<script>")[0]
        for label, want in [
            ("buy/sell/pump.fun", "https://pump.fun/coin/" + MINT),
            ("solscan",           "https://solscan.io/token/" + MINT),
            ("dexscreener",       "https://dexscreener.com/solana/" + MINT),
        ]:
            ok("publish writes the %s link into the markup, so it works with JS off" % label,
               ('href="%s"' % want) in markup, want)
        ok("every data-url element ends up with a matching href",
           all(('href="%s%s"' % (b, MINT)) in markup
               for b in re.findall(r'data-url="([^"]*)"', markup)),
           re.findall(r'data-url="([^"]*)"', markup))
        ok("and it reports how many it wired", "5 links" in out.getvalue(),
           out.getvalue()[-160:])
        ok("and nothing else on the page moved",
           len(wrote.splitlines()) == len(SITE.splitlines()))
        # Running it again is a no-op, not a second edit.
        with redirect_stdout(StringIO()):
            with_rpc(PubRpc(), P.cmd_publish, a)
        ok("running it twice is not an error and not a second edit",
           (Path(d) / "web/index.html").read_text() == wrote)
        # THE PROTECTION THAT MATTERS: a live address is never silently replaced.
        a.mint = P.Keypair.generate().address
        try:
            with redirect_stdout(StringIO()):
                with_rpc(PubRpc(), P.cmd_publish, a)
            ok("it refuses to overwrite a DIFFERENT published address", False, "it overwrote")
        except RuntimeError as e:
            ok("it refuses to overwrite a DIFFERENT published address",
               "Refusing to overwrite" in str(e))
    finally:
        P.HERE = real_here

with tempfile.TemporaryDirectory() as d:
    fresh_site(d)
    real_here = P.HERE
    P.HERE = Path(d)
    try:
        a = type("A", (), {})()
        a.record, a.write = None, True
        a.mint = MINT
        try:
            with redirect_stdout(StringIO()):
                with_rpc(PubRpc(kind=None), P.cmd_publish, a)
            ok("it refuses an address with no account behind it", False)
        except RuntimeError as e:
            ok("it refuses an address with no account behind it", "no account at" in str(e))
        try:
            with redirect_stdout(StringIO()):
                with_rpc(PubRpc(kind="account"), P.cmd_publish, a)
            ok("it refuses an address that is not a token mint", False)
        except RuntimeError as e:
            ok("it refuses an address that is not a token mint", "not a token mint" in str(e))
        a.mint = "not!base58!"
        try:
            with redirect_stdout(StringIO()):
                with_rpc(PubRpc(), P.cmd_publish, a)
            ok("it refuses something that is not base58", False)
        except RuntimeError as e:
            ok("it refuses something that is not base58", "not base58" in str(e))
        a.mint = P.b58encode(bytes(31))
        try:
            with redirect_stdout(StringIO()):
                with_rpc(PubRpc(), P.cmd_publish, a)
            ok("it refuses a 31-byte address", False)
        except RuntimeError as e:
            ok("it refuses a 31-byte address", "32" in str(e))
        # A mint that can still be minted is not a fixed supply, and the page must not imply one.
        a.mint = MINT
        out = StringIO()
        with redirect_stdout(out):
            with_rpc(PubRpc(mint_auth="SoMeAuTh"), P.cmd_publish, a)
        ok("it warns loudly when the mint authority is still set",
           "mintAuthority is STILL SET" in out.getvalue())
    finally:
        P.HERE = real_here

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
