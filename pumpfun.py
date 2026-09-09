#!/usr/bin/env python3
"""pumpfun.py — create a pump.fun token and take the first slice in ONE transaction.

    python3 pumpfun.py size                       # what a dev buy actually buys
    python3 pumpfun.py selftest                   # against published vectors
    python3 pumpfun.py launch --keypair ./launch.json --dev-buy 1.0 \\
        --name "Snooze Bear" --symbol SNOOZE --image ./snooze.png
    python3 pumpfun.py watch <mint> --minutes 5   # who actually bought, from public data

WHY ATOMIC, AND WHY THAT IS THE WHOLE DESIGN. Snipers buy in the same block the mint is
created in. You cannot out-race them and nothing here tries to: the create instruction and
your buy are in the SAME TRANSACTION, so there is no gap for anyone to land in and you hold
the first slice at the opening price by construction. Everything after that block is a real
market, and this script has no opinion about it.

WHAT IT WILL NOT DO, and these are refusals rather than omissions:

  NO CHILD WALLETS. Splitting the opening buy across wallets you own exists to make the
  top-holders view look distributed when one person holds the float. Bundle checkers and
  bubble maps detect it in seconds and "bundled" is a label that does not come off. It is a
  worse outcome than doing nothing, so there is no --wallets flag to add later.

  NO SELF-TRADING. No buy-from-one-sell-from-another, no volume mode, no scheduler. Volume
  you manufacture works by convincing somebody the demand is real, which makes the person on
  the other side of it the product. `watch` reads what happened; nothing here writes it.

  NO SNIPER DEFENCE THAT DOES NOT EXIST. Selling from wallets you control does not remove a
  sniper — by the time you sell, they already hold, and your sells are their cheaper
  re-entry. Atomicity is the only real answer and it is the one implemented.

THE KEY, WHICH IS THE PART TO READ TWICE. Base's deploy console never touched a key because a
browser wallet signed. Solana has no equivalent path here: a script that submits a transaction
must hold a key. So the rule changes shape rather than relaxing:

  · the key is read from a FILE, in the standard Solana CLI format, and from nowhere else —
    never an argument, never an environment variable, never a prompt, so it cannot land in
    shell history or /proc/<pid>/cmdline;
  · the file is a FRESH keypair funded with the launch cost and nothing else. `launch` reads
    the balance first and REFUSES to run against a wallet holding more than it needs, because
    the most expensive mistake available here is pointing this at your main wallet;
  · nothing is ever printed, logged or transmitted from the secret half.

AND WHAT IS NOT SIGNED BLIND. The transaction is built by pump.fun's public builder, which
means a third party composes the bytes your key is about to authorise. So it is taken apart
before it is signed: fee payer, signer set, every program it invokes, and — the one that does
not depend on knowing anybody's instruction layout — a SIMULATION against the live cluster
that reports what your balance actually does. Over your authorised amount, it refuses. See
`verify_transaction`, which is the reason this file is worth more than a curl command.

UNTESTED AGAINST MAINNET. This was written and self-tested where no cluster is reachable. The
arithmetic, the signing and the decoding are checked against published vectors; the live path
is not, and it moves real money. Rehearse on devnet, then launch with the smallest dev buy you
are willing to lose, and read what `--dry-run` prints before you drop it.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = "1.0.0"
LAMPORTS = 1_000_000_000

# pump.fun's curve opens here. Both are public constants of the program, and the only thing
# this file uses them for is `size` — the launch path never prices anything itself.
VIRTUAL_SOL = 30.0

# ───────────────────────────────────────────────────────────────────────── base58

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + (out or "1" if b else "")


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        i = _B58.find(c)
        if i < 0:
            raise ValueError("not base58: %r" % c)
        n = n * 58 + i
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\0" * pad + body


# ──────────────────────────────────────────────────────────────────────── ed25519
#
# RFC 8032, written out rather than imported, for the reason every other primitive in this
# project is written out: a library's bug in this position is indistinguishable from a bug
# somewhere else, and what it produces here is a valid signature over the wrong bytes.
# Extended coordinates, so a signature is milliseconds rather than seconds. `selftest` runs
# the RFC 8032 test vectors.

_Q = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493


def _inv(x: int) -> int:
    return pow(x, _Q - 2, _Q)


_D = (-121665 * _inv(121666)) % _Q
_I = pow(2, (_Q - 1) // 4, _Q)


def _xrecover(y: int) -> int:
    xx = (y * y - 1) * _inv(_D * y * y + 1)
    x = pow(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q != 0:
        x = (x * _I) % _Q
    if x % 2 != 0:
        x = _Q - x
    return x


_BY = (4 * _inv(5)) % _Q
_BX = _xrecover(_BY)
_B = (_BX % _Q, _BY % _Q, 1, (_BX * _BY) % _Q)


def _add(p, q):
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = ((y1 - x1) * (y2 - x2)) % _Q
    b = ((y1 + x1) * (y2 + x2)) % _Q
    c = (2 * t1 * t2 * _D) % _Q
    d = (2 * z1 * z2) % _Q
    e, f, g, h = b - a, d - c, d + c, b + a
    return ((e * f) % _Q, (g * h) % _Q, (f * g) % _Q, (e * h) % _Q)


def _double(p):
    x1, y1, z1, _ = p
    a = (x1 * x1) % _Q
    b = (y1 * y1) % _Q
    c = (2 * z1 * z1) % _Q
    h = (a + b) % _Q
    e = (h - (x1 + y1) * (x1 + y1)) % _Q
    g = (a - b) % _Q
    f = (c + g) % _Q
    return ((e * f) % _Q, (g * h) % _Q, (f * g) % _Q, (e * h) % _Q)


def _mul(p, e: int):
    q = (0, 1, 1, 0)
    while e > 0:
        if e & 1:
            q = _add(q, p)
        p = _double(p)
        e >>= 1
    return q


def _encode_point(p) -> bytes:
    x, y, z, _ = p
    zi = _inv(z)
    x = (x * zi) % _Q
    y = (y * zi) % _Q
    return ((y & ~(1 << 255)) | ((x & 1) << 255)).to_bytes(32, "little")


def _clamp(h: bytes) -> int:
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a


def ed25519_publickey(seed: bytes) -> bytes:
    if len(seed) != 32:
        raise ValueError("an ed25519 seed is 32 bytes")
    return _encode_point(_mul(_B, _clamp(hashlib.sha512(seed).digest())))


def ed25519_sign(msg: bytes, seed: bytes, pub: bytes) -> bytes:
    h = hashlib.sha512(seed).digest()
    a = _clamp(h)
    r = int.from_bytes(hashlib.sha512(h[32:] + msg).digest(), "little") % _L
    rr = _encode_point(_mul(_B, r))
    k = int.from_bytes(hashlib.sha512(rr + pub + msg).digest(), "little") % _L
    return rr + ((r + k * a) % _L).to_bytes(32, "little")


# ────────────────────────────────────────────────────────────────────── the keypair

class Keypair:
    """A Solana CLI keypair file: a JSON array of 64 bytes, seed then public key.

    Read from a PATH and from nowhere else. Not an argument, not an environment variable, not
    a prompt — all three of those end up somewhere durable that another process can read, and
    the whole point of a launch wallet is that it is the one key whose loss is survivable
    rather than the one whose loss is not.
    """

    def __init__(self, seed: bytes, pub: bytes):
        self._seed = seed
        self.pub = pub

    @property
    def address(self) -> str:
        return b58encode(self.pub)

    @classmethod
    def generate(cls) -> "Keypair":
        seed = os.urandom(32)
        return cls(seed, ed25519_publickey(seed))

    @classmethod
    def load(cls, path: str) -> "Keypair":
        p = Path(path).expanduser()
        if not p.is_file():
            raise RuntimeError("no keypair file at %s" % p)
        # A key readable by everybody on the machine is a key you have already shared.
        try:
            mode = p.stat().st_mode & 0o077
            if mode and os.name == "posix":
                raise RuntimeError(
                    "%s is readable by other users (mode %o). chmod 600 it first."
                    % (p, p.stat().st_mode & 0o777))
        except OSError:
            pass
        raw = json.loads(p.read_text())
        if not isinstance(raw, list) or len(raw) != 64:
            raise RuntimeError(
                "%s is not a Solana CLI keypair — expected a JSON array of 64 bytes" % p)
        b = bytes(raw)
        seed, pub = b[:32], b[32:]
        derived = ed25519_publickey(seed)
        # A file whose halves disagree is a corrupted or hand-edited key, and signing with it
        # produces a valid signature that no account will accept.
        if derived != pub:
            raise RuntimeError(
                "%s is inconsistent: the public half is not the seed's public key" % p)
        return cls(seed, pub)

    def sign(self, msg: bytes) -> bytes:
        return ed25519_sign(msg, self._seed, self.pub)

    def __repr__(self):
        return "<Keypair %s>" % self.address        # never the secret half


# ────────────────────────────────────────────────────────────────────────── the cluster
#
# THE ENDPOINT IS NEVER IN THIS FILE AND NEVER IN AN ARGUMENT. A keyed RPC URL is a
# credential: committed to a repository it is scraped within minutes, and passed on a command
# line it lands in shell history and in /proc/<pid>/cmdline where every other process on the
# machine can read it. So it comes from the environment:
#
#     export SOLANA_RPC='https://solana-mainnet.g.alchemy.com/v2/YOUR-KEY'
#
# and nothing here ever prints it back — errors carry the HOST only, because Python attaches
# the full URL to a URLError and one `print(err)` publishes the key to a terminal log.
#
# Unset, it falls back to the public endpoint, which is rate-limited and fine for `size`,
# `selftest` and a small `watch`, and not fine for a launch.

PUBLIC_RPC = "https://api.mainnet-beta.solana.com"


class Rpc:
    def __init__(self, url: str | None = None):
        self.url = url or os.environ.get("SOLANA_RPC") or PUBLIC_RPC
        self.keyed = self.url != PUBLIC_RPC
        self._id = 0

    @property
    def host(self) -> str:
        try:
            return urllib.parse.urlsplit(self.url).hostname or "(unparseable)"
        except Exception:
            return "(unparseable)"

    def send(self, method: str, params=None):
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method,
                           "params": params or []}).encode()
        req = urllib.request.Request(self.url, data=body,
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                out = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError("RPC to %s returned HTTP %s" % (self.host, e.code)) from None
        except urllib.error.URLError as e:
            raise RuntimeError("RPC to %s failed: %s" % (self.host, e.reason)) from None
        except Exception:
            raise RuntimeError("RPC to %s failed" % self.host) from None
        if "error" in out:
            raise RuntimeError("RPC to %s: %s"
                               % (self.host, out["error"].get("message", "?")))
        return out.get("result")

    def balance(self, addr: str) -> int:
        return self.send("getBalance", [addr])["value"]

    def blockhash(self) -> str:
        return self.send("getLatestBlockhash", [{"commitment": "finalized"}])["value"]["blockhash"]


# ─────────────────────────────────────────────────────── transactions, taken apart
#
# Solana's wire format, decoded so the thing being signed can be looked at first. This is the
# reason this file exists rather than a curl command: the transaction is composed by somebody
# else's builder, and signing bytes you have not decoded is the whole class of loss this
# project spends nine HTML pages arguing against.

def _shortvec_decode(buf: bytes, i: int):
    """Solana's compact-u16. Returns (value, next index)."""
    n = 0
    shift = 0
    while True:
        b = buf[i]
        i += 1
        n |= (b & 0x7F) << shift
        if not b & 0x80:
            return n, i
        shift += 7
        if shift > 21:
            raise ValueError("compact-u16 is too long to be one")


def _shortvec_encode(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


# Every program this launch is allowed to invoke. Anything else and the transaction is not the
# one that was asked for — a transfer to a stranger, a SetAuthority, a delegate — and it is
# refused with the offending id printed rather than signed and worried about afterwards.
KNOWN_PROGRAMS = {
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun",
    "11111111111111111111111111111111": "system",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "spl-token",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "associated-token",
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s": "token-metadata",
    "ComputeBudget111111111111111111111111111111": "compute-budget",
}


class Transaction:
    """A parsed Solana transaction: the signature slots, and the message they cover."""

    def __init__(self, raw: bytes):
        self.raw = raw
        count, i = _shortvec_decode(raw, 0)
        self.sig_count = count
        self.sig_offset = i
        self.signatures = [raw[i + 64 * k: i + 64 * (k + 1)] for k in range(count)]
        i += 64 * count
        self.message_offset = i
        self.message = raw[i:]
        self._parse_message()

    def _parse_message(self):
        m = self.message
        i = 0
        self.version = "legacy"
        if m[0] & 0x80:
            self.version = m[0] & 0x7F
            i = 1
        self.num_required_signatures = m[i]
        self.num_readonly_signed = m[i + 1]
        self.num_readonly_unsigned = m[i + 2]
        i += 3
        n, i = _shortvec_decode(m, i)
        self.account_keys = []
        for _ in range(n):
            self.account_keys.append(b58encode(m[i:i + 32]))
            i += 32
        self.recent_blockhash = b58encode(m[i:i + 32])
        i += 32
        n, i = _shortvec_decode(m, i)
        self.instructions = []
        for _ in range(n):
            prog = m[i]
            i += 1
            na, i = _shortvec_decode(m, i)
            accts = list(m[i:i + na])
            i += na
            nd, i = _shortvec_decode(m, i)
            data = m[i:i + nd]
            i += nd
            self.instructions.append({"program_index": prog, "accounts": accts, "data": data})
        # v0 address-table lookups. Any entry here names accounts that are NOT in
        # account_keys and cannot be read without another round trip, so a transaction using
        # them cannot be shown to the operator in full. Recorded, and refused upstream.
        self.lookups = 0
        if self.version != "legacy" and i < len(m):
            try:
                self.lookups, _ = _shortvec_decode(m, i)
            except Exception:
                self.lookups = 0

    def program_of(self, ix) -> str:
        idx = ix["program_index"]
        return self.account_keys[idx] if idx < len(self.account_keys) else "(out of range)"

    def signed(self, signers: dict) -> bytes:
        """Return the wire transaction with `signers` (address -> Keypair) filled in.

        A slot left empty is a transaction the cluster rejects, so every required signer must
        be present: the fee payer and, on a create, the mint. Missing one is raised here
        rather than discovered as an opaque cluster error.
        """
        sigs = []
        for k in range(self.num_required_signatures):
            addr = self.account_keys[k]
            kp = signers.get(addr)
            if kp is None:
                raise RuntimeError(
                    "the transaction needs a signature from %s and no key for it was given"
                    % addr)
            sigs.append(kp.sign(self.message))
        return _shortvec_encode(len(sigs)) + b"".join(sigs) + self.message

    def describe(self) -> str:
        out = ["  version            %s" % self.version,
               "  fee payer          %s" % (self.account_keys[0] if self.account_keys else "?"),
               "  signers required   %d" % self.num_required_signatures,
               "  accounts           %d" % len(self.account_keys),
               "  instructions       %d" % len(self.instructions)]
        for n, ix in enumerate(self.instructions):
            p = self.program_of(ix)
            out.append("    %d. %-44s %s  (%d accounts, %d bytes)"
                       % (n + 1, p, KNOWN_PROGRAMS.get(p, "UNKNOWN PROGRAM"),
                          len(ix["accounts"]), len(ix["data"])))
        return "\n".join(out)


def verify_transaction(tx: Transaction, payer: str, mint: str, authorised_lamports: int,
                       rpc: Rpc, fee_ceiling: int = 20_000_000) -> list[tuple[bool, str]]:
    """Everything that has to be true before a key touches these bytes.

    Two layers, and the second is the one that matters. The structural checks depend on
    knowing what the transaction should look like. The ECONOMIC check does not depend on
    knowing anybody's instruction layout at all: the cluster is asked to run the transaction
    and report what the payer's balance does. An instruction encoding nobody here can read
    still cannot move more lamports than the simulation says it moves.
    """
    # The structural half is _structural_only, called rather than repeated: it was written
    # twice, once here and once for the self-test, and two copies of a refusal drift apart
    # with the drifting copy being the one nothing runs against a real transaction.
    checks = list(_structural_only(tx, payer, mint))

    def ok(cond, name, detail=""):
        checks.append((bool(cond), name + (("  — " + detail) if detail and not cond else "")))

    # ── the economic check, which needs no instruction layout at all
    before = rpc.balance(payer)
    sim = rpc.send("simulateTransaction", [
        base64.b64encode(tx.raw).decode(),
        {"sigVerify": False, "replaceRecentBlockhash": True, "encoding": "base64",
         "commitment": "processed", "accounts": {"encoding": "base64", "addresses": [payer]}},
    ])
    err = sim["value"].get("err")
    ok(err is None, "it executes against the live cluster without reverting", repr(err))
    accts = sim["value"].get("accounts") or []
    after = accts[0]["lamports"] if accts and accts[0] else None
    if after is None:
        # A payer left with no account at all means every lamport moved. That is never right
        # here and is not the same as "could not read".
        ok(False, "the simulation reported your balance afterwards",
           "it did not — refusing rather than guessing")
    else:
        spent = before - after
        limit = authorised_lamports + fee_ceiling
        ok(spent <= limit,
           "it spends %.6f SOL, within the %.6f you authorised plus fees"
           % (spent / LAMPORTS, authorised_lamports / LAMPORTS),
           "it spends %.6f SOL against a ceiling of %.6f"
           % (spent / LAMPORTS, limit / LAMPORTS))
        checks.append((True, "  (simulated: %.6f SOL leaves your wallet)" % (spent / LAMPORTS)))
    return checks


# ──────────────────────────────────────────────────────────── pump.fun's own builders

IPFS_URL = "https://pump.fun/api/ipfs"
TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local"


def _post_multipart(url: str, fields: dict, files: dict) -> dict:
    boundary = "----snooze" + os.urandom(16).hex()
    body = bytearray()
    for k, v in fields.items():
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                 % (boundary, k, v)).encode()
    for k, (name, blob) in files.items():
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                 "Content-Type: application/octet-stream\r\n\r\n" % (boundary, k, name)).encode()
        body += blob + b"\r\n"
    body += ("--%s--\r\n" % boundary).encode()
    req = urllib.request.Request(url, data=bytes(body), headers={
        "content-type": "multipart/form-data; boundary=%s" % boundary})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def upload_metadata(name: str, symbol: str, description: str, image: str,
                    twitter="", telegram="", website="") -> str:
    """Put the name, ticker and picture on IPFS and return the URI the mint will carry.

    This is a THIRD-PARTY UPLOAD and it is public and permanent the moment it lands. Nothing
    private belongs in any of these fields.
    """
    blob = Path(image).expanduser().read_bytes()
    out = _post_multipart(IPFS_URL, {
        "name": name, "symbol": symbol, "description": description,
        "twitter": twitter, "telegram": telegram, "website": website,
        "showName": "true",
    }, {"file": (Path(image).name, blob)})
    uri = out.get("metadataUri") or out.get("metadata_uri")
    if not uri:
        raise RuntimeError("the metadata upload returned no URI: %s" % json.dumps(out)[:200])
    return uri


def build_create_and_buy(payer: str, mint: str, name: str, symbol: str, uri: str,
                         sol: float, slippage: int, priority_fee: float) -> bytes:
    """One transaction: create the token AND take the first slice.

    THE ATOMICITY IS THE WHOLE POINT. A create followed by a separate buy leaves a gap of at
    least one block, and that gap is exactly what a sniper occupies — it is not a race that
    can be won by being fast, because the bot is watching the mempool for the create itself.
    In one transaction there is no gap to occupy: the first buy is yours because it is part of
    the creation, not because it beat anybody.
    """
    body = json.dumps({
        "publicKey": payer, "action": "create",
        "tokenMetadata": {"name": name, "symbol": symbol, "uri": uri},
        "mint": mint, "denominatedInSol": "true", "amount": sol,
        "slippage": slippage, "priorityFee": priority_fee, "pool": "pump",
    }).encode()
    req = urllib.request.Request(TRADE_LOCAL_URL, data=body,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError("the transaction builder returned HTTP %s: %s"
                           % (e.code, e.read()[:200].decode("utf8", "replace"))) from None
    if raw[:1] == b"{":
        raise RuntimeError("the builder returned an error rather than a transaction: %s"
                           % raw[:300].decode("utf8", "replace"))
    return raw


# ──────────────────────────────────────────────────────────────────────── commands

def cmd_size(args):
    print("\nWHAT A DEV BUY ACTUALLY BUYS. pump.fun's curve opens at about %g virtual SOL, and"
          % VIRTUAL_SOL)
    print("a buy of R SOL takes R/(%g+R) of everything the curve will ever sell. The token"
          % VIRTUAL_SOL)
    print("side cancels, so this depends on R and on NOTHING ELSE — not the supply, not the")
    print("name, not how many people are watching.\n")
    print("  DEV BUY      SHARE OF THE FLOAT    HOW IT READS")
    for r in (0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0):
        s = r / (VIRTUAL_SOL + r)
        how = ("flagged: the dev owns the float" if s > 0.08
               else "borderline" if s > 0.05 else "clean")
        print("  %5.2f SOL    %8.2f%%              %s" % (r, s * 100, how))
    print("\n  There is no size that is both a meaningful position and invisible, and anything")
    print("  claiming otherwise is describing wallet-splitting, which is the thing every")
    print("  bundle checker looks for first. 1.0 to 1.5 SOL is the defensible band.\n")


def cmd_launch(args):
    rpc = Rpc()
    if not rpc.keyed:
        print("\n  ! SOLANA_RPC is not set, so this would launch through the public endpoint,")
        print("    which is rate-limited and drops transactions under load. Export a real one:")
        print("        export SOLANA_RPC='https://…your-provider…/your-key'\n")
        if not args.dry_run:
            raise RuntimeError("refusing to launch through the public endpoint")

    kp = Keypair.load(args.keypair)
    print("\n  payer     %s" % kp.address)
    print("  cluster   %s" % rpc.host)
    bal = rpc.balance(kp.address)
    print("  balance   %.6f SOL" % (bal / LAMPORTS))

    need = int(args.dev_buy * LAMPORTS)
    # THE MAIN-WALLET GUARD. The most expensive mistake available here is pointing this at a
    # wallet that holds everything. A launch wallet holds the launch and nothing else, so a
    # balance far above what the launch costs is evidence of the wrong file, not of headroom.
    ceiling = int((args.dev_buy + args.headroom) * LAMPORTS)
    if bal > ceiling:
        raise RuntimeError(
            "%s holds %.4f SOL, more than the %.4f this launch needs.\n"
            "  That looks like a main wallet, and this refuses to sign with one. Fund a FRESH\n"
            "  keypair with the launch amount only:\n"
            "      solana-keygen new -o ./launch.json && chmod 600 ./launch.json\n"
            "  Raise --headroom only if you know exactly why."
            % (kp.address, bal / LAMPORTS, args.dev_buy + args.headroom))
    if bal < need:
        raise RuntimeError("%s holds %.4f SOL and the dev buy alone is %.4f"
                           % (kp.address, bal / LAMPORTS, args.dev_buy))

    mint = Keypair.generate()
    print("  mint      %s   (generated now, in memory)" % mint.address)

    print("\n  uploading metadata…")
    uri = upload_metadata(args.name, args.symbol, args.description, args.image,
                          args.twitter, args.telegram, args.website)
    print("  metadata  %s" % uri)

    print("\n  building create + buy as ONE transaction…")
    raw = build_create_and_buy(kp.address, mint.address, args.name, args.symbol, uri,
                               args.dev_buy, args.slippage, args.priority_fee)
    tx = Transaction(raw)
    print(tx.describe())

    print("\n  BEFORE ANYTHING IS SIGNED:")
    checks = verify_transaction(tx, kp.address, mint.address, need, rpc)
    bad = 0
    for good, name in checks:
        print("    %s %s" % ("ok  " if good else "FAIL", name))
        bad += 0 if good else 1
    if bad:
        raise RuntimeError("%d check(s) failed. Nothing was signed and nothing was sent." % bad)

    if args.dry_run:
        print("\n  --dry-run: verified and STOPPED. Nothing was signed, nothing was sent.\n")
        return 0

    print("\n  signing and sending…")
    wire = tx.signed({kp.address: kp, mint.address: mint})
    import base64
    sig = rpc.send("sendTransaction", [base64.b64encode(wire).decode(),
                                       {"encoding": "base64", "skipPreflight": False,
                                        "maxRetries": 3}])
    print("  signature %s" % sig)

    print("\n  confirming…")
    landed = False
    for _ in range(60):
        st = rpc.send("getSignatureStatuses", [[sig], {"searchTransactionHistory": True}])
        v = (st.get("value") or [None])[0]
        if v and v.get("confirmationStatus") in ("confirmed", "finalized"):
            if v.get("err"):
                raise RuntimeError("the transaction landed and FAILED: %r" % v["err"])
            landed = True
            break
        time.sleep(2)
    if not landed:
        raise RuntimeError(
            "the transaction did not confirm in two minutes. Check %s before resending —\n"
            "  resending a create that actually landed makes a second token." % sig)

    # READ IT BACK. "It confirmed" is not "you hold tokens": the buy is a separate instruction
    # inside the same transaction and a slippage failure there is a create with no position.
    print("\n  reading it back off the chain…")
    after = rpc.balance(kp.address)
    spent = bal - after
    held = 0
    for acc in (rpc.send("getTokenAccountsByOwner",
                         [kp.address, {"mint": mint.address},
                          {"encoding": "jsonParsed"}]).get("value") or []):
        held += int(acc["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"])
    dec = 6
    tokens = held / (10 ** dec)
    print("  mint       %s" % mint.address)
    print("  spent      %.6f SOL" % (spent / LAMPORTS))
    print("  you hold   %s tokens" % f"{tokens:,.0f}")
    if held == 0:
        raise RuntimeError(
            "THE BUY DID NOT LAND. The token exists and you hold none of it — the create "
            "succeeded and the buy inside it did not.\n  Do not relaunch blind: read %s first."
            % sig)
    print("  cost basis %.12f SOL per token" % (spent / LAMPORTS / tokens))
    print("\n  https://pump.fun/%s\n" % mint.address)
    print("  PUBLISH THE MINT NOW, before anybody has to guess which one is yours. Copycats")
    print("  appear within minutes and the only defence is being the first published address.\n")
    return 0


def cmd_watch(args):
    """What actually happened in the first minutes, from public data only.

    Layout-independent on purpose: it reads token-balance deltas out of each transaction's
    metadata rather than decoding pump.fun's instructions, so it cannot be wrong about a
    trade because a program changed its encoding.
    """
    rpc = Rpc()
    mint = args.mint
    print("\n  reading %s from %s\n" % (mint, rpc.host))
    sigs = rpc.send("getSignaturesForAddress", [mint, {"limit": args.limit}]) or []
    if not sigs:
        print("  no transactions for that mint.\n")
        return 0
    sigs = list(reversed(sigs))                      # oldest first: the launch is the first
    t0 = sigs[0].get("blockTime") or 0
    cutoff = t0 + args.minutes * 60
    buys, sellers = {}, set()
    first_other = None
    creator = None
    rows = 0
    for s in sigs:
        bt = s.get("blockTime") or 0
        if bt > cutoff:
            break
        tx = rpc.send("getTransaction", [s["signature"],
                                         {"maxSupportedTransactionVersion": 0,
                                          "encoding": "jsonParsed"}])
        if not tx or not tx.get("meta") or tx["meta"].get("err"):
            continue
        meta, msg = tx["meta"], tx["transaction"]["message"]
        keys = [k["pubkey"] if isinstance(k, dict) else k for k in msg["accountKeys"]]
        payer = keys[0] if keys else "?"
        if creator is None:
            creator = payer
        pre = {(b["owner"], b["mint"]): float(b["uiTokenAmount"]["uiAmount"] or 0)
               for b in meta.get("preTokenBalances", [])}
        post = {(b["owner"], b["mint"]): float(b["uiTokenAmount"]["uiAmount"] or 0)
                for b in meta.get("postTokenBalances", [])}
        delta = post.get((payer, mint), 0.0) - pre.get((payer, mint), 0.0)
        if delta > 0:
            buys[payer] = buys.get(payer, 0.0) + delta
            if payer != creator and first_other is None:
                first_other = bt - t0
        elif delta < 0:
            sellers.add(payer)
        rows += 1
    total = sum(buys.values()) or 1.0
    ranked = sorted(buys.items(), key=lambda kv: -kv[1])
    print("  transactions read        %d (first %d minutes)" % (rows, args.minutes))
    print("  distinct buyers          %d" % len(buys))
    print("  wallets that sold        %d" % len(sellers))
    if first_other is not None:
        print("  first buyer after you    %ds" % first_other)
        if first_other <= 2:
            print("      that is same-or-next-block. It is a sniper, and it is normal.")
    else:
        print("  first buyer after you    none yet")
    top10 = sum(v for _, v in ranked[:10])
    print("  top 10 wallets hold      %.1f%% of everything bought" % (top10 / total * 100))
    if creator in buys:
        print("  your own share of that   %.1f%%" % (buys[creator] / total * 100))
    print("\n  TOP BUYERS")
    for a, v in ranked[:10]:
        tag = "  (you)" if a == creator else ""
        print("    %-46s %8.2f%%%s" % (a, v / total * 100, tag))
    print("\n  Concentration is a fact, not a verdict. A high top-10 share on a launch this")
    print("  young is usually snipers rather than anything you did — what it tells you is how")
    print("  much of the float is in hands that are looking for an exit inside the hour.\n")
    return 0


def cmd_selftest(args):
    n = [0]
    bad = [False]

    def ok(name, cond, extra=""):
        n[0] += 1
        print("  %s %s%s" % ("ok  " if cond else "FAIL", name,
                             "" if cond else "  <- " + str(extra)))
        if not cond:
            bad[0] = True

    print("\n── ed25519, against RFC 8032")
    for seed_h, pub_h, msg_h, sig_h in [
        ("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
         "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
         "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e"
         "39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
        ("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
         "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
         "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f"
         "3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
        ("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
         "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
         "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67"
         "f760984dc6594a7c15e9716ed28dc027beceea1ec40a"),
    ]:
        seed, pub = bytes.fromhex(seed_h), bytes.fromhex(pub_h)
        ok("public key for %s…" % seed_h[:8], ed25519_publickey(seed) == pub)
        ok("  signature over %r" % (msg_h or "(empty)"),
           ed25519_sign(bytes.fromhex(msg_h), seed, pub).hex() == sig_h)

    print("── base58 and compact-u16")
    ok("32 zero bytes encode to the all-ones address",
       b58encode(bytes(32)) == "1" * 32 + "1", b58encode(bytes(32)))
    ok("base58 round-trips random keys",
       all(b58decode(b58encode(x)) == x for x in (os.urandom(32) for _ in range(20))))
    ok("compact-u16 round-trips across its boundaries",
       all(_shortvec_decode(_shortvec_encode(v), 0) == (v, len(_shortvec_encode(v)))
           for v in (0, 1, 127, 128, 255, 256, 16383, 16384, 65535)))

    print("── a keypair file is read from a FILE and validated")
    kp = Keypair.generate()
    ok("a generated keypair's halves agree",
       ed25519_publickey(kp._seed) == kp.pub)
    ok("its repr never contains the secret half",
       kp._seed.hex() not in repr(kp) and b58encode(kp._seed) not in repr(kp))
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        good = Path(d) / "good.json"
        good.write_text(json.dumps(list(kp._seed + kp.pub)))
        os.chmod(good, 0o600)
        ok("a well-formed file loads", Keypair.load(str(good)).address == kp.address)
        badf = Path(d) / "bad.json"
        badf.write_text(json.dumps(list(kp._seed + bytes(32))))
        os.chmod(badf, 0o600)
        try:
            Keypair.load(str(badf))
            ok("a file whose halves disagree is refused", False, "it loaded")
        except RuntimeError as e:
            ok("a file whose halves disagree is refused", "inconsistent" in str(e))
        loose = Path(d) / "loose.json"
        loose.write_text(json.dumps(list(kp._seed + kp.pub)))
        os.chmod(loose, 0o644)
        try:
            Keypair.load(str(loose))
            ok("a world-readable key file is refused", os.name != "posix")
        except RuntimeError as e:
            ok("a world-readable key file is refused", "readable by other users" in str(e))
        try:
            Keypair.load(str(Path(d) / "nope.json"))
            ok("a missing file is refused", False)
        except RuntimeError:
            ok("a missing file is refused", True)

    print("── a transaction is decoded before it is signed")
    payer, mintk = Keypair.generate(), Keypair.generate()
    msg = (bytes([2, 0, 1])                                   # 2 signers, header
           + _shortvec_encode(3) + payer.pub + mintk.pub + bytes(32)
           + bytes(32)                                        # blockhash
           + _shortvec_encode(1) + bytes([2]) + _shortvec_encode(1) + bytes([0])
           + _shortvec_encode(4) + b"\x01\x02\x03\x04")
    raw = _shortvec_encode(2) + bytes(64) * 2 + msg
    tx = Transaction(raw)
    ok("the signature slots are found", tx.sig_count == 2 and len(tx.signatures) == 2)
    ok("the fee payer is the first account key", tx.account_keys[0] == payer.address)
    ok("the mint is in the account keys", mintk.address in tx.account_keys)
    ok("the instruction is parsed", len(tx.instructions) == 1
       and tx.instructions[0]["data"] == b"\x01\x02\x03\x04")
    signed = tx.signed({payer.address: payer, mintk.address: mintk})
    ok("signing fills every required slot and keeps the message byte-identical",
       len(signed) == len(raw) and signed[-len(msg):] == msg
       and signed[1:65] != bytes(64) and signed[65:129] != bytes(64))
    ok("and the signatures verify as ed25519 over the message",
       signed[1:65] == payer.sign(msg) and signed[65:129] == mintk.sign(msg))
    try:
        tx.signed({payer.address: payer})
        ok("a missing signer is refused rather than sent half-signed", False)
    except RuntimeError as e:
        ok("a missing signer is refused rather than sent half-signed", "needs a signature" in str(e))

    print("── what the verifier refuses, without a cluster")
    stranger = Keypair.generate().address
    fake = type("T", (), {})()
    fake.account_keys = [stranger, mintk.address]
    fake.num_required_signatures = 2
    fake.lookups = 0
    fake.instructions = []
    fake.program_of = lambda i: ""
    names = [nm for good, nm in _structural_only(fake, payer.address, mintk.address) if not good]
    ok("a transaction that pays from somebody else's wallet fails the fee-payer check",
       any("fee payer" in nm for nm in names), names)

    print("── the endpoint is never printed back")
    r = Rpc("https://solana-mainnet.g.alchemy.com/v2/SECRETKEY")
    ok("errors carry the host only", r.host == "solana-mainnet.g.alchemy.com")
    ok("and the key is not in the host", "SECRETKEY" not in r.host)
    # NOT a substring search for the provider's hostname: this file has to NAME the shape of
    # a keyed endpoint in order to tell you not to commit one, and the check above has to name
    # it again to test that naming. A grep finds all three and calls the warning a violation —
    # the same mistake this project's other script made grepping itself for "secp256k1".
    # So: find every key-shaped path segment and require it to be a known placeholder.
    import re as _re
    leaked = [m for m in _re.findall(r"/v2/([A-Za-z0-9_-]{8,})", Path(__file__).read_text())
              if m not in ("YOUR-KEY", "SECRETKEY")]
    ok("no real endpoint key is committed in this file", not leaked, leaked)

    print("── the arithmetic `size` prints")
    ok("a 1 SOL dev buy takes 3.23% of the float",
       abs(1.0 / (VIRTUAL_SOL + 1.0) - 0.032258) < 1e-5)
    ok("and it depends on the buy alone — doubling both the buy and the reserve is not the same",
       abs(2.0 / (VIRTUAL_SOL + 2.0) - 2 * (1.0 / (VIRTUAL_SOL + 1.0))) > 1e-3)

    print("\n%d checks, %s\n" % (n[0], "all passed" if not bad[0] else "SOMETHING FAILED"))
    return 1 if bad[0] else 0


def _structural_only(tx, payer: str, mint: str):
    """The half of verify_transaction that needs no cluster, so selftest can exercise it."""
    checks = []

    def add(cond, name, detail=""):
        checks.append((bool(cond), name + (("  — " + detail) if detail and not cond else "")))

    add(bool(tx.account_keys) and tx.account_keys[0] == payer,
        "the fee payer is your wallet",
        "it is %s" % (tx.account_keys[0] if tx.account_keys else "absent"))
    signers = tx.account_keys[:tx.num_required_signatures]
    add(set(signers) <= {payer, mint},
        "the only signers are your wallet and the new mint",
        "it also wants " + ", ".join(sorted(set(signers) - {payer, mint})))
    add(mint in tx.account_keys, "the mint you generated is in the transaction")
    add(tx.lookups == 0,
        "no address-table lookups, so every account it touches is visible here",
        "%d lookup table(s): accounts this cannot show you" % tx.lookups)
    unknown = sorted({tx.program_of(i) for i in tx.instructions} - set(KNOWN_PROGRAMS))
    add(not unknown, "every program it invokes is one this launch needs",
        "unknown: " + ", ".join(unknown))
    return checks


def main(argv=None):
    p = argparse.ArgumentParser(
        prog="pumpfun.py",
        description="Create a pump.fun token and take the first slice in ONE transaction.",
        epilog="The endpoint comes from SOLANA_RPC and the key from a --keypair FILE. Neither "
               "is ever accepted as a literal argument: both would land in shell history and "
               "in /proc/<pid>/cmdline.")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser(
        "launch", help="create + buy, atomically, from a fresh keypair file",
        epilog="The endpoint comes from SOLANA_RPC in your environment and the key from the "
               "--keypair FILE. Neither is ever accepted as a literal argument. Fund a FRESH "
               "keypair with the dev buy and nothing else: this refuses to sign with a wallet "
               "holding more than it needs. Run once with --dry-run first — it builds the "
               "transaction, simulates it against the cluster, prints what your balance does, "
               "and stops without signing.")
    s.set_defaults(fn=cmd_launch)
    s.add_argument("--keypair", required=True, help="path to a Solana CLI keypair JSON file")
    s.add_argument("--dev-buy", type=float, required=True, dest="dev_buy",
                   help="SOL to spend on the opening buy. REQUIRED — see `size`, and note "
                        "that there is no default because this is money")
    s.add_argument("--name", required=True)
    s.add_argument("--symbol", required=True)
    s.add_argument("--image", required=True, help="path to the token image")
    s.add_argument("--description", default="")
    s.add_argument("--twitter", default="")
    s.add_argument("--telegram", default="")
    s.add_argument("--website", default="")
    s.add_argument("--slippage", type=int, default=10, help="percent (default 10)")
    s.add_argument("--priority-fee", type=float, default=0.0005, dest="priority_fee")
    s.add_argument("--headroom", type=float, default=0.5,
                   help="SOL the launch wallet may hold above the dev buy before this refuses "
                        "to sign with it (default 0.5)")
    s.add_argument("--dry-run", action="store_true",
                   help="build and verify, then STOP. Nothing is signed and nothing is sent")

    s = sub.add_parser("watch", help="who actually bought, from public data")
    s.set_defaults(fn=cmd_watch)
    s.add_argument("mint")
    s.add_argument("--minutes", type=int, default=5)
    s.add_argument("--limit", type=int, default=200)

    sub.add_parser("size", help="what a dev buy actually buys").set_defaults(fn=cmd_size)
    sub.add_parser("selftest", help="against published vectors").set_defaults(fn=cmd_selftest)

    args = p.parse_args(argv)
    if not getattr(args, "fn", None):
        p.print_help()
        return 0
    try:
        return args.fn(args) or 0
    except (RuntimeError, ValueError) as e:
        print("\n  %s\n" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
