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

THE KEY, WHICH IS THE PART TO READ TWICE. A script that submits a Solana transaction must sign
it, and there is no browser-wallet path that would let something else do the signing. So this
file holds a key, and the rule changes shape rather than relaxing:

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
import zlib
from pathlib import Path

VERSION = "1.1.0"
# Where this file lives, which is where `publish` looks for web/. It was missing entirely and
# cmd_publish referenced it anyway, so publishing the contract address died with a NameError
# before it read a single thing — on the one command whose whole job is launch-day.
HERE = Path(__file__).resolve().parent
MAX_TX_BYTES = 1232
LAMPORTS = 1_000_000_000

# pump.fun's curve opens here. Both are public constants of the program, and the only thing
# this file uses them for is `size` — the launch path never prices anything itself.
VIRTUAL_SOL = 30.0

# ───────────────────────────────────────────────────────────────────────── base58

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b: bytes) -> str:
    """Base58, and the leading-zero rule is the whole subtlety.

    Each leading ZERO BYTE is one "1", and the rest of the value is the ordinary base-58
    expansion of the integer. Nothing else gets a "1".

    THE BUG THIS REPLACES, because it was one line and it would have stopped the launch dead.
    The old version ended with `(out or "1" if b else "")`, which for an all-zero input appends
    a "1" that the padding has already accounted for. Solana's SYSTEM PROGRAM ADDRESS IS 32
    ZERO BYTES, so it encoded to 33 ones instead of 32 — and the system program appears in
    every transaction that creates an account, which is every pump.fun launch. `KNOWN_PROGRAMS`
    would not have matched it, `verify_transaction` would have reported "UNKNOWN PROGRAM", and
    the script would have refused the correct transaction every single time.

    It survived because the self-test asserted `b58encode(bytes(32)) == "1" * 32 + "1"` — the
    assertion was written to match the implementation instead of to match base58, so the test
    agreed with the bug. The test below now compares against the real published address.
    """
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out


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

    # EVERY READ NAMES ITS COMMITMENT, and that is not tidiness — it is the bug that would
    # have cost a launch. The confirmation loop below accepts "confirmed"; the read-back used
    # to call getBalance and getTokenAccountsByOwner with no commitment at all, which defaults
    # to FINALIZED. Finalized lags confirmed by roughly 13 blocks, so on a launch that had just
    # succeeded the read-back saw the state from BEFORE the transaction: zero tokens. The
    # script then printed "THE BUY DID NOT LAND" and told the operator to investigate before
    # resending — on a token that existed and was already trading. There is no default that is
    # safe here, so there is no default.
    def account(self, addr: str, commitment: str = "confirmed") -> dict | None:
        return self.send("getAccountInfo",
                         [addr, {"encoding": "base64", "commitment": commitment}])["value"]

    # An address lookup table is a plain account: a 56-byte header, then packed 32-byte
    # addresses. 56 is not a guess — it is 4 (discriminator) + 8 (deactivation slot)
    # + 8 (last extended slot) + 1 (start index) + 33 (Option<Pubkey> authority) + 2 (padding),
    # and the addresses begin immediately after it.
    LOOKUP_TABLE_HEADER = 56

    def lookup_table(self, addr: str, commitment: str = "confirmed") -> list:
        v = self.account(addr, commitment)
        if v is None:
            raise RuntimeError("lookup table %s does not exist on %s" % (addr, self.host))
        raw = base64.b64decode(v["data"][0])
        body = raw[self.LOOKUP_TABLE_HEADER:]
        if len(body) % 32:
            raise RuntimeError("lookup table %s is %d bytes, not a whole number of addresses"
                               % (addr, len(body)))
        return [b58encode(body[k:k + 32]) for k in range(0, len(body), 32)]

    def resolve_lookups(self, tx, commitment: str = "confirmed") -> list:
        """Fill in tx.resolved_keys from the chain. Returns the accounts the tables supplied.

        Raises if any table is missing, unreadable, or too short for an index the message
        uses. A partial resolution is worse than none: it would show most of the accounts and
        silently leave the interesting one out.
        """
        if tx.lookups_truncated:
            raise RuntimeError("the lookup-table section of this message could not be parsed")
        if not tx.lookup_tables:
            tx.resolved_keys = list(tx.account_keys)
            return []
        writable, readonly = [], []
        for entry in tx.lookup_tables:
            addrs = self.lookup_table(entry["key"], commitment)
            for which, sink in (("writable", writable), ("readonly", readonly)):
                for idx in entry[which]:
                    if idx >= len(addrs):
                        raise RuntimeError(
                            "the message asks table %s for index %d and it holds %d addresses"
                            % (entry["key"], idx, len(addrs)))
                    sink.append(addrs[idx])
        pulled = writable + readonly
        tx.resolved_keys = list(tx.account_keys) + pulled
        return pulled

    def program_provenance(self, addr: str, commitment: str = "confirmed") -> dict:
        """Who this program is, from the chain alone: is it code, and who may replace it.

        An upgradeable program is only as trustworthy as its upgrade authority, because that
        key can swap the code under a transaction you already read. `authority: None` means
        the code is frozen; a key there means it is not.
        """
        v = self.account(addr, commitment)
        if v is None:
            return {"exists": False, "address": addr}
        out = {"exists": True, "address": addr, "executable": v["executable"],
               "owner": v["owner"], "lamports": v["lamports"],
               "authority": None, "authority_known": False, "slot": None}
        if v["owner"] != BPF_UPGRADEABLE_LOADER or not v["executable"]:
            return out
        # An upgradeable program account holds a 4-byte enum and the address of the
        # ProgramData account that carries the code, the deploy slot and the authority.
        raw = base64.b64decode(v["data"][0])
        if len(raw) < 36:
            return out
        data_addr = b58encode(raw[4:36])
        out["programdata"] = data_addr
        d = self.account(data_addr, commitment)
        if d is None:
            return out
        pd = base64.b64decode(d["data"][0])
        if len(pd) < 45:
            return out
        out["slot"] = int.from_bytes(pd[4:12], "little")
        out["authority_known"] = True
        out["authority"] = b58encode(pd[13:45]) if pd[12] else None
        return out

    def balance(self, addr: str, commitment: str = "confirmed") -> int:
        return self.send("getBalance", [addr, {"commitment": commitment}])["value"]

    def slot(self, commitment: str = "confirmed") -> int:
        return self.send("getSlot", [{"commitment": commitment}])

    def blockhash(self, commitment: str = "confirmed") -> dict:
        return self.send("getLatestBlockhash", [{"commitment": commitment}])["value"]

    def block_height(self, commitment: str = "confirmed") -> int:
        return self.send("getBlockHeight", [{"commitment": commitment}])

    def blockhash_valid(self, bh: str, commitment: str = "confirmed") -> bool:
        """Whether a transaction carrying this blockhash could still land.

        THE ONLY HONEST ANSWER TO "did it land?". A wall clock cannot tell "expired, never
        landed" from "landed and I did not see it", and guessing wrong in the second direction
        mints a second token. A blockhash is valid for 150 blocks; once it is invalid AND the
        signature is not found, the transaction is dead beyond recovery and a retry is safe.
        Until then it is still in flight and a retry is not.
        """
        return bool(self.send("isBlockhashValid", [bh, {"commitment": commitment}])["value"])


# ─────────────────────────────────────────────────────── transactions, taken apart
#
# Solana's wire format, decoded so the thing being signed can be looked at first. This is the
# reason this file exists rather than a curl command: the transaction is composed by somebody
# else's builder, and signing bytes you have not decoded is the whole class of loss this
# project exists to avoid.

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


# ─────────────────────────────────────────────────────────────── program addresses
#
# Building the transaction here rather than asking a service for one. The reason is not
# ideology: the service's create+buy addressed the BUY to a program that is not pump.fun's,
# that pump.fun does not publish, that no public source names, and whose code can be replaced
# at will by a key nobody can identify. There is no way to check that transaction into safety
# from the outside, so it is not used. Everything below comes from pump.fun's own IDL —
# https://github.com/pump-fun/pump-public-docs/tree/main/idl — and the discriminators are the
# published byte arrays, not this file's arithmetic on an instruction name.
PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
MPL_TOKEN_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
SYSVAR_RENT = "SysvarRent111111111111111111111111111111111"
COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"

DISC_CREATE = bytes([24, 30, 200, 40, 5, 28, 7, 119])
DISC_BUY = bytes([102, 6, 61, 18, 1, 218, 235, 234])
DISC_INIT_USER_VOLUME = bytes([94, 6, 202, 115, 255, 96, 232, 183])


def _is_on_curve(pub: bytes) -> bool:
    """True if these 32 bytes decode to a point on ed25519 — i.e. could be a real public key.

    A program-derived address must NOT be on the curve: that is the whole guarantee, because a
    point on the curve might have a private key and a PDA must not. Getting this backwards, or
    skipping it, yields an address the runtime will reject — or worse, one that somebody holds
    the key to.
    """
    y = int.from_bytes(pub, "little")
    sign = (y >> 255) & 1
    y &= (1 << 255) - 1
    if y >= _Q:
        return False
    xx = (y * y - 1) * _inv(_D * y * y + 1) % _Q
    x = pow(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q != 0:
        x = (x * _I) % _Q
    if (x * x - xx) % _Q != 0:
        return False
    if x == 0 and sign:
        return False
    return True


def find_program_address(seeds: list[bytes], program_id: str) -> str:
    """The Solana PDA derivation, bump 255 downwards until the result is off the curve."""
    for seed in seeds:
        if len(seed) > 32:
            raise ValueError("a PDA seed may be at most 32 bytes, got %d" % len(seed))
    pid = b58decode(program_id)
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + pid
                           + b"ProgramDerivedAddress").digest()
        if not _is_on_curve(h):
            return b58encode(h)
    raise RuntimeError("no off-curve address for these seeds")


def ata(owner: str, mint: str, token_program: str = TOKEN_PROGRAM) -> str:
    """The associated token account: a PDA of the ATA program over owner, program, mint."""
    return find_program_address(
        [b58decode(owner), b58decode(token_program), b58decode(mint)], ATA_PROGRAM)


# ── borsh, only the four shapes these two instructions use
def _u64(n: int) -> bytes:
    if n < 0 or n >= 2 ** 64:
        raise ValueError("u64 out of range: %d" % n)
    return int(n).to_bytes(8, "little")


def _string(s: str) -> bytes:
    b = s.encode()
    return len(b).to_bytes(4, "little") + b


def _pubkey(a: str) -> bytes:
    return b58decode(a)


class Account:
    __slots__ = ("key", "signer", "writable")

    def __init__(self, key: str, signer: bool = False, writable: bool = False):
        self.key, self.signer, self.writable = key, signer, writable


def _compile(payer: str, blockhash: str, instructions: list) -> bytes:
    """Assemble a LEGACY message. No address lookup tables, so every account is in the bytes.

    A v0 message would be smaller, and smaller is not the point: a legacy message names every
    account it touches inline, which means `verify_transaction` can read the whole thing with
    no second round trip and no table that could be swapped between reading and sending.

    Ordering is the runtime's, and it is not cosmetic — an account's index is what the
    instruction means: writable signers, readonly signers, writable non-signers, readonly
    non-signers. The header counts readonly signers and readonly non-signers, so getting the
    order and the counts to disagree signs something other than what was displayed.
    """
    merged: dict[str, Account] = {}
    for prog, accs, _ in instructions:
        for a in accs:
            cur = merged.get(a.key)
            if cur is None:
                merged[a.key] = Account(a.key, a.signer, a.writable)
            else:
                cur.signer = cur.signer or a.signer
                cur.writable = cur.writable or a.writable
        merged.setdefault(prog, Account(prog))
    fee = merged.pop(payer, None)
    if fee is None:
        raise RuntimeError("the fee payer is not among the accounts")
    fee.signer = True
    fee.writable = True
    rest = list(merged.values())
    ws = [a for a in rest if a.signer and a.writable]
    rs = [a for a in rest if a.signer and not a.writable]
    wn = [a for a in rest if not a.signer and a.writable]
    rn = [a for a in rest if not a.signer and not a.writable]
    keys = [fee] + ws + rs + wn + rn
    index = {a.key: i for i, a in enumerate(keys)}
    header = bytes([1 + len(ws) + len(rs), len(rs), len(rn)])
    body = b"".join(b58decode(a.key) for a in keys)
    out = [header, _shortvec_encode(len(keys)), body, b58decode(blockhash),
           _shortvec_encode(len(instructions))]
    for prog, accs, data in instructions:
        out.append(bytes([index[prog]]))
        out.append(_shortvec_encode(len(accs)))
        out.append(bytes(index[a.key] for a in accs))
        out.append(_shortvec_encode(len(data)))
        out.append(data)
    return b"".join(out)


ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111"


def alt_create_ix(authority: str, payer: str, recent_slot: int) -> tuple:
    """CreateLookupTable. The table's address is a PDA over the authority and the slot.

    The slot is part of the seed, which is what stops two tables from the same authority
    colliding — and what makes the address derivable rather than random, so the caller knows
    where the table will be before the transaction lands.
    """
    seed_slot = int(recent_slot).to_bytes(8, "little")
    addr, bump = _find_pda_with_bump([b58decode(authority), seed_slot], ALT_PROGRAM)
    data = (0).to_bytes(4, "little") + seed_slot + bytes([bump])
    return (ALT_PROGRAM, [
        Account(addr, writable=True),
        Account(authority, signer=True),
        Account(payer, signer=True, writable=True),
        Account(SYSTEM_PROGRAM),
    ], data), addr


def alt_extend_ix(table: str, authority: str, payer: str, addrs: list) -> tuple:
    """ExtendLookupTable. Appends only — an index, once written, can never mean anything else.

    That is the property that makes a table safe to reference: the authority can add entries
    and can close the whole table (which makes a transaction fail, not misbehave), but cannot
    rewrite entry 3 into a different account after a transaction has been built against it.
    """
    data = ((2).to_bytes(4, "little") + len(addrs).to_bytes(8, "little")
            + b"".join(b58decode(a) for a in addrs))
    return (ALT_PROGRAM, [
        Account(table, writable=True),
        Account(authority, signer=True),
        Account(payer, signer=True, writable=True),
        Account(SYSTEM_PROGRAM),
    ], data)


def _find_pda_with_bump(seeds: list, program_id: str) -> tuple:
    pid = b58decode(program_id)
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + pid
                           + b"ProgramDerivedAddress").digest()
        if not _is_on_curve(h):
            return b58encode(h), bump
    raise RuntimeError("no off-curve address for these seeds")


def _compile_v0(payer: str, blockhash: str, instructions: list, table: str,
                table_addrs: list) -> bytes:
    """A versioned message that reaches `table_addrs` by index instead of by 32 bytes each.

    A LEGACY message would be better and does not fit: with cashback enabled a buy carries
    eight trailing fee recipients, and the launch touches 30 accounts, which is 161 bytes over
    the 1232-byte limit. So the fixed accounts — the programs, the sysvars, the global PDAs,
    the eight recipients — move into a table this wallet OWNS and created, and the per-launch
    accounts stay in the message.

    Signers can never be looked up: a signature is checked against a key in the message
    itself, so the fee payer and the mint stay static no matter what the table holds.

    THE SAFETY ARGUMENT IS NOT "WE MADE THE TABLE". It is that verify_transaction resolves
    every index back through the chain afterwards and checks the resulting programs against
    the allowlist, exactly as it does for a table somebody else built. Owning it removes a
    dependency, not the need to check.
    """
    merged: dict = {}
    for prog, accs, _ in instructions:
        for a in accs:
            cur = merged.get(a.key)
            if cur is None:
                merged[a.key] = Account(a.key, a.signer, a.writable)
            else:
                cur.signer = cur.signer or a.signer
                cur.writable = cur.writable or a.writable
        merged.setdefault(prog, Account(prog))
    fee = merged.pop(payer, None)
    if fee is None:
        raise RuntimeError("the fee payer is not among the accounts")
    fee.signer = True
    fee.writable = True
    rest = list(merged.values())
    pos = {a: i for i, a in enumerate(table_addrs)}
    # A PROGRAM ID CAN NEVER COME FROM A LOOKUP TABLE. The runtime resolves tables while it is
    # loading the transaction, and it has to know which programs to load before it can do
    # that, so an instruction's program_id_index must point into the STATIC keys. Putting the
    # programs in the table produced a message that parsed perfectly here and was rejected by
    # the cluster as "failed to sanitize accounts offsets correctly" — which names the
    # symptom and not the rule. The table may still CONTAIN them; this simply never reaches
    # for them, which is why an already-created table does not have to be rebuilt.
    programs = {prog for prog, _, _ in instructions}

    def lookupable(a) -> bool:
        return (not a.signer) and a.key not in programs and a.key in pos

    ws = [a for a in rest if a.signer and a.writable]
    rs = [a for a in rest if a.signer and not a.writable]
    wn = [a for a in rest if not a.signer and a.writable and not lookupable(a)]
    rn = [a for a in rest if not a.signer and not a.writable and not lookupable(a)]
    lw = [a for a in rest if a.writable and lookupable(a)]
    lr = [a for a in rest if not a.writable and lookupable(a)]
    static = [fee] + ws + rs + wn + rn
    order = static + lw + lr
    index = {a.key: i for i, a in enumerate(order)}
    header = bytes([1 + len(ws) + len(rs), len(rs), len(rn)])
    out = [bytes([0x80]), header, _shortvec_encode(len(static)),
           b"".join(b58decode(a.key) for a in static), b58decode(blockhash),
           _shortvec_encode(len(instructions))]
    for prog, accs, data in instructions:
        out.append(bytes([index[prog]]))
        out.append(_shortvec_encode(len(accs)))
        out.append(bytes(index[a.key] for a in accs))
        out.append(_shortvec_encode(len(data)))
        out.append(data)
    out.append(_shortvec_encode(1))
    out.append(b58decode(table))
    out.append(_shortvec_encode(len(lw)) + bytes(pos[a.key] for a in lw))
    out.append(_shortvec_encode(len(lr)) + bytes(pos[a.key] for a in lr))
    return b"".join(out)


def launch_static_accounts(g: dict) -> list:
    """Every account a launch touches that is the SAME for every launch — table material.

    The per-launch accounts (the mint, its curve, the token accounts, the metadata, the
    creator vault, this wallet's volume accumulator) are deliberately not here: they differ
    each time, so putting them in a table would mean a new table for every launch.
    """
    out = [PUMP_PROGRAM, PUMP_FEE_PROGRAM, MPL_TOKEN_METADATA, SYSTEM_PROGRAM, TOKEN_PROGRAM,
           ATA_PROGRAM, SYSVAR_RENT, COMPUTE_BUDGET, g["address"], g["fee_recipient"],
           find_program_address([b"mint-authority"], PUMP_PROGRAM),
           find_program_address([b"__event_authority"], PUMP_PROGRAM),
           find_program_address([b"global_volume_accumulator"], PUMP_PROGRAM),
           find_program_address([b"fee_config", b58decode(PUMP_PROGRAM)], PUMP_FEE_PROGRAM)]
    if g.get("is_cashback_enabled"):
        out += list(g.get("buyback_fee_recipients") or [])
    seen, uniq = set(), []
    for a in out:
        if a not in seen:
            seen.add(a)
            uniq.append(a)
    return uniq


def read_global(rpc) -> dict:
    """pump.fun's Global account, read in full rather than to the first field that was needed.

    The whole struct is parsed because the tail matters: `buyback_fee_recipients` is eight
    pubkeys that a buy has to carry as trailing accounts when cashback is enabled, and reading
    only as far as `fee_basis_points` is what produced BuybackFeeRecipientMissing. The opening
    reserves are read rather than hardcoded for the same reason — pump.fun has changed them,
    and a stale constant computes an `amount` the curve will not honour.
    """
    addr = find_program_address([b"global"], PUMP_PROGRAM)
    v = rpc.account(addr)
    if v is None:
        raise RuntimeError("pump.fun's global account %s is missing on %s" % (addr, rpc.host))
    raw = base64.b64decode(v["data"][0])
    if raw[:8] != bytes([167, 232, 232, 177, 200, 108, 114, 127]):
        raise RuntimeError("the account at %s is not pump.fun's Global" % addr)
    i = 8

    def take(n: int) -> bytes:
        nonlocal i
        if i + n > len(raw):
            raise RuntimeError(
                "pump.fun's Global is %d bytes and this layout wants %d — the program's "
                "account struct has changed and this script must not guess at the rest"
                % (len(raw), i + n))
        out = raw[i:i + n]
        i += n
        return out

    def u64():
        return int.from_bytes(take(8), "little")

    def flag():
        return bool(take(1)[0])

    def key():
        return b58encode(take(32))

    def keys(n):
        return [key() for _ in range(n)]

    g = {"address": addr, "initialized": flag(), "authority": key(), "fee_recipient": key(),
         "initial_virtual_token_reserves": u64(), "initial_virtual_sol_reserves": u64(),
         "initial_real_token_reserves": u64(), "token_total_supply": u64(),
         "fee_basis_points": u64(), "withdraw_authority": key(), "enable_migrate": flag(),
         "pool_migration_fee": u64(), "creator_fee_basis_points": u64(),
         "fee_recipients": keys(7), "set_creator_authority": key(),
         "admin_set_creator_authority": key(), "create_v2_enabled": flag(),
         "whitelist_pda": key(), "reserved_fee_recipient": key(),
         "mayhem_mode_enabled": flag(), "reserved_fee_recipients": keys(7),
         "is_cashback_enabled": flag(), "buyback_fee_recipients": keys(8),
         "buyback_basis_points": u64()}
    return g


def curve_buy_amount(lamports: int, g: dict) -> int:
    """Tokens a fresh curve gives for `lamports`, by pump.fun's own constant product.

    x*y=k on the VIRTUAL reserves: paying dl lamports moves the product, and the tokens out
    are the difference in the token reserve. Capped at the real token reserve, because the
    curve cannot sell tokens it does not hold.

    This is floor division on purpose. Asking for one token more than the curve will give is a
    failed transaction; asking for one less costs a rounding crumb and lands.
    """
    vt = g["initial_virtual_token_reserves"]
    vs = g["initial_virtual_sol_reserves"]
    if lamports <= 0 or vt <= 0 or vs <= 0:
        raise ValueError("a buy needs positive lamports and positive reserves")
    out = vt - (vt * vs) // (vs + lamports)
    return min(out, g["initial_real_token_reserves"])


def build_create_and_buy_direct(payer: str, mint: str, name: str, symbol: str, uri: str,
                                lamports: int, slippage_pct: float, g: dict,
                                compute_limit: int = 250_000,
                                compute_price_micro: int = 0,
                                init_user_volume: bool = False) -> tuple[bytes, dict]:
    """create + buy against pump.fun itself, in one legacy message.

    The creator is the payer, which is what makes the creator_vault PDA derivable here: on a
    buy the program reads it from the bonding curve, and the bonding curve does not exist yet.
    Since this transaction is what creates it, the value is known — it is whatever `create`
    was just told, and `create` is in the same message.
    """
    amount = curve_buy_amount(lamports, g)
    max_sol_cost = int(lamports * (1 + slippage_pct / 100.0))

    bonding_curve = find_program_address([b"bonding-curve", b58decode(mint)], PUMP_PROGRAM)
    abc = ata(bonding_curve, mint)
    associated_user = ata(payer, mint)
    metadata = find_program_address(
        [b"metadata", b58decode(MPL_TOKEN_METADATA), b58decode(mint)], MPL_TOKEN_METADATA)
    ixs = []
    if compute_limit:
        ixs.append((COMPUTE_BUDGET, [], bytes([2]) + compute_limit.to_bytes(4, "little")))
    if compute_price_micro:
        ixs.append((COMPUTE_BUDGET, [], bytes([3]) + _u64(compute_price_micro)))

    ixs.append((PUMP_PROGRAM, [
        Account(mint, signer=True, writable=True),
        Account(find_program_address([b"mint-authority"], PUMP_PROGRAM)),
        Account(bonding_curve, writable=True),
        Account(abc, writable=True),
        Account(g["address"]),
        Account(MPL_TOKEN_METADATA),
        Account(metadata, writable=True),
        Account(payer, signer=True, writable=True),
        Account(SYSTEM_PROGRAM),
        Account(TOKEN_PROGRAM),
        Account(ATA_PROGRAM),
        Account(SYSVAR_RENT),
        Account(find_program_address([b"__event_authority"], PUMP_PROGRAM)),
        Account(PUMP_PROGRAM),
    ], DISC_CREATE + _string(name) + _string(symbol) + _string(uri) + _pubkey(payer)))

    # The ATA the buy credits has to exist. create makes the curve's; this makes the buyer's,
    # idempotently (instruction 1), so a wallet that somehow already has one is not a failure.
    ixs.append((ATA_PROGRAM, [
        Account(payer, signer=True, writable=True),
        Account(associated_user, writable=True),
        Account(payer),
        Account(mint),
        Account(SYSTEM_PROGRAM),
        Account(TOKEN_PROGRAM),
    ], bytes([1])))

    # THE EIGHT TRAILING ACCOUNTS. When cashback is on, a buy must carry pump.fun's eight
    # buyback fee recipients after its named accounts — "exactly 8 remaining accounts (or
    # none)", per the program's own error 6061. Passing none while cashback is enabled is
    # error 6062, BuybackFeeRecipientMissing, which is where this landed. They take lamports,
    # so they are writable. Read from Global every time rather than pinned here: they are
    # configuration, and configuration that is copied into a script goes stale silently.
    # ONE buyback recipient, not eight. Two real legacy buys on mainnet each passed exactly
    # two trailing accounts — bonding_curve_v2, then a single recipient out of Global's eight
    # — where this was sending all eight. Error 6061's "exactly 8 remaining accounts (or
    # none)" describes some other caller's shape, and building to the error message instead of
    # to an observed transaction is how that happened.
    recipients = g.get("buyback_fee_recipients") or []
    buyback = ([Account(recipients[0], writable=True)]
               if g.get("is_cashback_enabled") and recipients else [])

    uva = find_program_address([b"user_volume_accumulator", b58decode(payer)], PUMP_PROGRAM)
    if init_user_volume:
        # A buy WRITES to this account, and pump.fun does not create it on the way past —
        # there is a separate instruction for that, and a wallet that has never bought on
        # pump.fun does not have one. Included only when it is actually missing: running it
        # against an account that already exists fails, which would break every launch after
        # the first from the same wallet.
        ixs.append((PUMP_PROGRAM, [
            Account(payer, signer=True, writable=True),
            Account(payer),
            Account(uva, writable=True),
            Account(SYSTEM_PROGRAM),
            Account(find_program_address([b"__event_authority"], PUMP_PROGRAM)),
            Account(PUMP_PROGRAM),
        ], DISC_INIT_USER_VOLUME))

    ixs.append((PUMP_PROGRAM, [
        Account(g["address"]),
        Account(g["fee_recipient"], writable=True),
        Account(mint),
        Account(bonding_curve, writable=True),
        Account(abc, writable=True),
        Account(associated_user, writable=True),
        Account(payer, signer=True, writable=True),
        Account(SYSTEM_PROGRAM),
        Account(TOKEN_PROGRAM),
        Account(find_program_address([b"creator-vault", b58decode(payer)], PUMP_PROGRAM),
                writable=True),
        Account(find_program_address([b"__event_authority"], PUMP_PROGRAM)),
        Account(PUMP_PROGRAM),
        Account(find_program_address([b"global_volume_accumulator"], PUMP_PROGRAM)),
        Account(uva, writable=True),
        # fee_config is a PDA of the FEE program whose second seed is the 32 bytes of the
        # BONDING CURVE program's id. Written as the decode rather than as a hex literal
        # because a literal is what went wrong: the IDL's seed was read off a debug print
        # that truncated it to 8 bytes, the derived address was not pump.fun's fee_config,
        # and the buy failed simulation with AccountNotInitialized. It cost nothing because
        # it failed in a dry run, which is the entire reason there is one.
        Account(find_program_address([b"fee_config", b58decode(PUMP_PROGRAM)],
                                     PUMP_FEE_PROGRAM)),
        Account(PUMP_FEE_PROGRAM),
    ] + buyback + [
        # bonding_curve_v2, LAST. A February upgrade made this a required trailing account on
        # every buy and sell, cashback or not, and it is in no published IDL — not the repo's
        # and not the one the deployed program stores about itself, both of which stop at
        # error 6071 while the program throws 6074, InvalidBondingCurveV2. The only reason
        # this is derivable at all is that the simulation's logs name it; the logs are worth
        # more here than the documentation.
        Account(find_program_address([b"bonding-curve-v2", b58decode(mint)], PUMP_PROGRAM),
                writable=True),
    ], DISC_BUY + _u64(amount) + _u64(max_sol_cost) + bytes([1, 1])))

    return ixs, {"amount": amount, "max_sol_cost": max_sol_cost,
                 "bonding_curve": bonding_curve, "associated_user": associated_user,
                 "metadata": metadata, "user_volume_accumulator": uva,
                 "init_user_volume": init_user_volume,
                 "bonding_curve_v2": find_program_address(
                     [b"bonding-curve-v2", b58decode(mint)], PUMP_PROGRAM)}

# Every program this launch is allowed to invoke. Anything else and the transaction is not the
# one that was asked for — a transfer to a stranger, a SetAuthority, a delegate — and it is
# refused with the offending id printed rather than signed and worried about afterwards.
BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"

# pump.fun publishes three programs and no others: the bonding curve, the AMM, and the fee
# program. They are listed here so a transaction can be told "this is not one of them" with
# something behind it — https://github.com/pump-fun/pump-public-docs/tree/main/idl.
PUMP_PUBLISHED = {
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun bonding curve (idl/pump.json)",
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ": "pump.fun fees (idl/pump_fees.json)",
}

# An Anchor instruction begins with sha256("global:<name>")[:8]. Printing that, and naming it
# when it matches an instruction pump.fun publishes, is how you find out what a foreign program
# is being asked to DO: a buy discriminator arriving at an address that is not pump.fun's means
# something is reimplementing pump.fun's interface, which is worth knowing before signing.
_PUMP_IX = (
    "add_quote_mint admin_set_creator admin_set_idl_authority admin_update_token_incentives "
    "buy buy_exact_quote_in_v2 buy_exact_sol_in buy_v2 claim_cashback claim_cashback_v2 "
    "claim_token_incentives close_user_volume_accumulator collect_creator_fee "
    "collect_creator_fee_v2 create create_v2 distribute_creator_fees "
    "distribute_creator_fees_v2 extend_account get_minimum_distributable_fee "
    "init_user_volume_accumulator initialize migrate migrate_bonding_curve_creator migrate_v2 "
    "remove_quote_mint sell sell_v2 set_creator set_mayhem_virtual_params set_metaplex_creator "
    "set_params set_reserved_fee_recipients set_virtual_quote_reserves "
    "sync_user_volume_accumulator toggle_cashback_enabled toggle_create_v2 toggle_mayhem_mode "
    "update_buyback_config update_global_authority"
).split()
DISCRIMINATORS = {
    hashlib.sha256(("global:" + n).encode()).digest()[:8].hex(): n for n in _PUMP_IX
}

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
        # v0 address-table lookups. Every entry names accounts that are NOT in account_keys,
        # so on its own this object cannot say what the transaction touches. This used to stop
        # at a count and refuse anything above zero, which is a fine default and a useless one
        # the moment a real builder returns a v0 transaction — "I can't see it" is not the same
        # finding as "it is dangerous", and a check that cannot tell them apart teaches you to
        # override it. The entries are now decoded here and resolved against the chain in
        # `Rpc.resolve_lookups`, which is the only place the addresses actually exist.
        self.lookup_tables = []
        self.lookups = 0
        self.lookups_truncated = False
        if self.version != "legacy" and i < len(m):
            try:
                n, i = _shortvec_decode(m, i)
                for _ in range(n):
                    key = b58encode(m[i:i + 32]); i += 32
                    nw, i = _shortvec_decode(m, i)
                    writable = list(m[i:i + nw]); i += nw
                    nr, i = _shortvec_decode(m, i)
                    readonly = list(m[i:i + nr]); i += nr
                    self.lookup_tables.append(
                        {"key": key, "writable": writable, "readonly": readonly})
                self.lookups = len(self.lookup_tables)
            except Exception:
                # A message this parser cannot finish reading is one it cannot vouch for.
                # Say so, rather than reporting the entries it managed to get.
                self.lookups_truncated = True
                self.lookups = max(self.lookups, len(self.lookup_tables))
        # Filled in by Rpc.resolve_lookups: static keys first, then every writable account
        # pulled from the tables in entry order, then every readonly one. That order is the
        # runtime's, not a convention — an index into it is what the instructions mean.
        self.resolved_keys = None

    @property
    def keys(self) -> list:
        """Every account the transaction touches, if the tables have been resolved."""
        return self.resolved_keys if self.resolved_keys is not None else self.account_keys

    def program_of(self, ix) -> str:
        idx = ix["program_index"]
        keys = self.keys
        return keys[idx] if idx < len(keys) else "(behind an unresolved lookup table)"

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
               "  accounts           %d%s"
               % (len(self.keys),
                  "" if self.resolved_keys is None
                  else " (%d named in the message, %d from lookup tables)"
                       % (len(self.account_keys),
                          len(self.resolved_keys) - len(self.account_keys))),
               "  instructions       %d" % len(self.instructions)]
        for t in self.lookup_tables:
            out.append("    lookup table     %s  (%d writable, %d readonly)"
                       % (t["key"], len(t["writable"]), len(t["readonly"])))
        for n, ix in enumerate(self.instructions):
            p = self.program_of(ix)
            out.append("    %d. %-44s %s  (%d accounts, %d bytes)"
                       % (n + 1, p, KNOWN_PROGRAMS.get(p, "UNKNOWN PROGRAM"),
                          len(ix["accounts"]), len(ix["data"])))
            disc = ix["data"][:8].hex()
            named = DISCRIMINATORS.get(disc)
            if named and p not in PUMP_PUBLISHED:
                out.append('       data %s  — this is pump.fun\'s "%s" instruction,'
                           % (disc, named))
                out.append("            being sent to a program that is not pump.fun's")
            elif named:
                out.append('       data %s  — "%s"' % (disc, named))
        return "\n".join(out)


def verify_transaction(tx: Transaction, payer: str, mint: str, authorised_lamports: int,
                       rpc: Rpc, fee_ceiling: int = 40_000_000) -> list[tuple[bool, str]]:
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
    checks = list(_structural_only(tx, payer, mint, rpc))

    def ok(cond, name, detail=""):
        checks.append((bool(cond), name + (("  — " + detail) if detail and not cond else "")))

    # ── the economic check, which needs no instruction layout at all
    #
    # THE CEILING HAS TO CLEAR THE SCRIPT'S OWN COST ESTIMATE. It was 0.02 SOL while --reserve
    # budgets 0.03 for exactly the same costs — mint rent, metadata rent, two token accounts,
    # pump.fun's fee, the priority fee. A correct create+buy landing anywhere in that band
    # failed its own verification, so the launch refused itself.
    #
    # AT THE SAME COMMITMENT AS THE SIMULATION. simulateTransaction below runs at "processed";
    # taking the before-balance at anything later means any transfer that is confirmed but not
    # yet included in the older view is counted as if this transaction spent it. That reads as
    # the launch spending more than it does, and it fails the ceiling on a correct transaction.
    before = rpc.balance(payer, "processed")
    sim = rpc.send("simulateTransaction", [
        base64.b64encode(tx.raw).decode(),
        {"sigVerify": False, "replaceRecentBlockhash": True, "encoding": "base64",
         "commitment": "processed", "accounts": {"encoding": "base64", "addresses": [payer]}},
    ])
    err = sim["value"].get("err")
    # THE LOGS ARE THE ANSWER AND THEY WERE BEING THROWN AWAY. A failing simulation returns
    # the program's own output, and an Anchor program prints the error's NAME there —
    # "AnchorError ... Error Number: 6074. Error Message: <what it is>". That works when no
    # IDL does: pump.fun's published IDL stops at 6071 and the deployed program has moved
    # past it, so for three rounds the only thing on offer was a bare number. It was in the
    # response the whole time.
    detail = repr(err)
    if err is not None:
        logs = sim["value"].get("logs") or []
        named = [l for l in logs if "Error Message:" in l or "AnchorError" in l
                 or "Program log: Error" in l]
        tail = named or logs[-12:]
        if tail:
            detail = repr(err) + "\n" + "\n".join("         " + l for l in tail)
    ok(err is None, "it executes against the live cluster without reverting", detail)
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


# ────────────────────────────────────────────────────── the launch record, and why
#
# NOTHING ABOUT A LAUNCH USED TO REACH DISK, and that is the difference between a recoverable
# accident and a second token. The mint is a keypair generated in memory; the metadata URI
# comes back from an upload; the signature comes back from a send. Close the terminal at the
# wrong moment and all three are gone at once — and the only way to "recover" is to run the
# command again, which generates a DIFFERENT mint and creates a SECOND token while the first
# one is live and being bought.
#
# So the record is written BEFORE the transaction is sent, not after. The usual rule is the
# opposite — record only what was READ BACK, never what was merely sent
# — and it is the right rule almost everywhere. It is wrong here for one specific reason: a
# lost mint keypair is not derivable from anything, so "we did not record it because we were
# not sure it worked" loses the only handle on a token that may well exist.
#
# IT CONTAINS THE MINT'S SECRET KEY, deliberately. That key signs the create and has no
# authority afterwards: it is not a mint authority, not a freeze authority, and it holds
# nothing. Its only value is that re-sending with the SAME mint is a retry and re-sending with
# a new one is a second token. It is written 0600 and it is not the launch wallet's key.

def record_path(keypair_path: str, mint_addr: str) -> Path:
    return Path(keypair_path).expanduser().resolve().parent / ("launch-%s.json" % mint_addr)


def existing_records(keypair_path: str) -> list[Path]:
    d = Path(keypair_path).expanduser().resolve().parent
    return sorted(d.glob("launch-*.json"))


def in_git_worktree(path: Path) -> Path | None:
    """The repository root above `path`, if there is one."""
    p = Path(path).expanduser().resolve()
    for d in [p if p.is_dir() else p.parent, *(p if p.is_dir() else p.parent).parents]:
        if (d / ".git").exists():
            return d
    return None


def warn_if_committable(path: Path) -> None:
    """A launch record holds a secret key. Say so, loudly, if git can see it.

    .gitignore is a backstop and not a plan: it only catches filenames somebody thought of, and
    `solana-keygen grind` writes a file named after an address nobody can predict. So the check
    that matters is at write time, when the path is known.
    """
    root = in_git_worktree(path)
    if root is None:
        return
    print("\n  ! THIS RECORD IS INSIDE A GIT REPOSITORY (%s)." % root)
    print("    It contains the mint's SECRET KEY. `git add -A` would commit it, and a secret")
    print("    key pushed to GitHub is scraped within minutes.")
    print("    Keep launch keys outside the repository:")
    print("        mkdir -p ~/.snooze && chmod 700 ~/.snooze")
    print("        solana-keygen new -o ~/.snooze/launch.json && chmod 600 ~/.snooze/launch.json")


def write_record(path: Path, data: dict) -> None:
    # 0600 before a byte is written, not after: a world-readable window of even a moment is a
    # window, and os.open with the mode is the only way to have none.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def read_record(path: Path) -> dict:
    return json.loads(Path(path).read_text())


# ────────────────────────────────────────────────────────── the mint address itself
#
# WHY THIS IS NOT JUST os.urandom. Essentially every pump.fun token a trader has ever seen has
# a mint address ending in "pump", because pump.fun's own frontend grinds for that suffix. A
# launch that does not have it looks unlike every other token on the site, at exactly the
# moment somebody is deciding in two seconds whether the address they were sent is real.
#
# The suffix is cosmetic and proves nothing — anybody can grind one, and treating it as
# evidence is a mistake the site should say out loud rather than exploit. But NOT having it is
# also not evidence, and being the only token on the page without it costs more than the grind
# does. Four base58 characters is 58^4 = 11.3M keypairs on average; each is an ed25519 public
# key derivation, so this is minutes where a native, threaded grinder takes seconds.

# Measured on this machine at import time would be a startup cost, so it is measured when a
# grind is actually asked for. Pure-Python ed25519 does roughly 500-700 derivations a second;
# solana-keygen does millions, because it is native and threaded.
GRIND_CEILING = 400_000          # about ten minutes here. Past this, use the real tool.


def grind_rate() -> float:
    """Keypairs per second, measured rather than assumed, so the estimate is this machine's."""
    n = 300
    t0 = time.monotonic()
    for _ in range(n):
        Keypair.generate()
    return n / max(time.monotonic() - t0, 1e-6)


def grind_mint(suffix: str, progress_every: int = 20000):
    """Generate keypairs until one's address ends in `suffix`.

    REFUSES RATHER THAN RUNS FOR HOURS. "pump" is four base58 characters, which is 58^4 =
    11.3 million keypairs on average — about five and a half hours of pure-Python ed25519 on
    this machine, against seconds for the native tool. A script that silently starts a
    five-hour loop on launch day is worse than one that will not do it at all.
    """
    if not suffix:
        return Keypair.generate(), 0
    bad = [c for c in suffix if c not in _B58]
    if bad:
        raise RuntimeError(
            "%r cannot appear in a base58 address: %s are not base58 characters. "
            "0, O, I and l are excluded from the alphabet."
            % (suffix, ", ".join(sorted(set(bad)))))
    expected = 58 ** len(suffix)
    rate = grind_rate()
    secs = expected / rate
    print("    %d base58 characters is 58^%d = %s keypairs on average;"
          % (len(suffix), len(suffix), f"{expected:,}"))
    print("    this machine does %d/s, so about %s." % (int(rate), _human(secs)))
    if expected > GRIND_CEILING:
        raise RuntimeError(
            "that is too long to grind here, and there is a tool that does it properly:\n\n"
            "      solana-keygen grind --ends-with %s:1\n"
            "      chmod 600 %s*.json\n"
            "      python3 pumpfun.py launch --mint-keypair ./%s....json ...\n\n"
            "  solana-keygen is native and threaded and will do this in seconds. Pass the file\n"
            "  it writes with --mint-keypair. (Pure Python here would take about %s.)"
            % (suffix, suffix, suffix, _human(secs)))
    tried = 0
    while True:
        kp = Keypair.generate()
        tried += 1
        if kp.address.endswith(suffix):
            return kp, tried
        if tried % progress_every == 0:
            print("    ground %s keypairs…" % f"{tried:,}")


def _human(secs: float) -> str:
    if secs < 90:
        return "%.0f seconds" % secs
    if secs < 5400:
        return "%.1f minutes" % (secs / 60)
    return "%.1f hours" % (secs / 3600)


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


# Metaplex's on-chain metadata struct, which pump.fun's create writes into. These are the
# real ceilings and they are measured in BYTES, not characters — an emoji is four. Over them
# the field is truncated or the instruction fails, and either way it is permanent.
MAX_NAME_BYTES = 32
MAX_SYMBOL_BYTES = 10


def check_metadata(name: str, symbol: str, description: str, website: str) -> list[str]:
    """What is wrong with the metadata, before a byte of it is pinned.

    EVERY ONE OF THESE IS PERMANENT. The URI is written into the mint's metadata account by
    the create instruction and the creator cannot edit it afterwards — so a blank description,
    a truncated symbol or a missing website is not a thing to fix later. There is no later.
    """
    bad = []
    n, y = len(name.encode()), len(symbol.encode())
    if not name.strip():
        bad.append("the name is empty")
    elif n > MAX_NAME_BYTES:
        bad.append("the name is %d bytes and Metaplex allows %d — it would be truncated on "
                   "chain, permanently (emoji are 4 bytes each)" % (n, MAX_NAME_BYTES))
    if not symbol.strip():
        bad.append("the symbol is empty")
    elif y > MAX_SYMBOL_BYTES:
        bad.append("the symbol is %d bytes and Metaplex allows %d — it would be truncated on "
                   "chain, permanently" % (y, MAX_SYMBOL_BYTES))
    if not description.strip():
        bad.append("the description is empty. It is the coin page's whole body, it cannot be "
                   "edited after the create, and a blank one reads as a bot launch")
    if not website.strip():
        bad.append("there is no --website. It is the only field that points back at a page you "
                   "control, which is what makes a copycat's token distinguishable from yours")
    return bad


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


def build_launch_tx(rpc, payer: str, mint: str, name: str, symbol: str, uri: str,
                    sol: float, slippage: float, priority_fee: float,
                    builder: str = "direct", table: dict | None = None) -> bytes:
    """Assemble the launch, either here or at PumpPortal. `direct` is the default and why.

    PumpPortal's create+buy addressed the BUY instruction to
    FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe — a program pump.fun does not publish, that
    no public source names, and whose code an unidentified key can replace at any time. That
    is not a transaction anybody can check into safety from the outside, so it stopped being
    the default. `--builder pumpportal` still exists because the allowlist, not this choice,
    is what refuses a bad transaction — and a refusal you can reproduce is worth more than a
    code path that was quietly deleted.
    """
    if builder == "pumpportal":
        return build_create_and_buy(payer, mint, name, symbol, uri, sol, slippage,
                                    priority_fee)
    if builder != "direct":
        raise RuntimeError("unknown builder %r" % builder)
    g = read_global(rpc)
    if not g["initialized"]:
        raise RuntimeError("pump.fun's global account reads as uninitialised; refusing")
    lamports = int(round(sol * LAMPORTS))
    # A priority fee is quoted in SOL for the whole transaction and paid in micro-lamports per
    # compute unit, so it has to be divided by the limit that is actually requested — not by a
    # nominal 200k. Getting this wrong overpays by whatever the two numbers differ by.
    limit = 250_000
    micro = int(priority_fee * LAMPORTS * 1_000_000 // limit) if priority_fee else 0
    # Ask the chain whether this wallet has ever bought on pump.fun, because that decides
    # whether the transaction needs an extra instruction. A guess in either direction is a
    # failed transaction: missing it fails the buy, adding it twice fails the init.
    uva = find_program_address([b"user_volume_accumulator", b58decode(payer)], PUMP_PROGRAM)
    needs_init = rpc.account(uva) is None
    ixs, detail = build_create_and_buy_direct(payer, mint, name, symbol, uri, lamports,
                                              slippage, g, limit, micro, needs_init)
    bh = rpc.blockhash()["blockhash"]
    msg = _compile(payer, bh, ixs)
    # A legacy message is preferred and does not always fit: with cashback on, a buy carries
    # eight trailing fee recipients and the launch touches 30 accounts. When it does not fit,
    # the fixed accounts move into this wallet's own lookup table — and are then resolved and
    # re-checked from the chain by verify_transaction exactly as anybody else's table would be.
    over = len(msg) + 1 + 128 - MAX_TX_BYTES
    if over > 0:
        if not table:
            raise RuntimeError(
                "this launch is %d bytes over the %d-byte transaction limit, because a buy\n"
                "  with cashback enabled carries eight extra fee recipients. Create the\n"
                "  lookup table it needs, once, and launch again:\n"
                "      python3 pumpfun.py table --keypair <your keypair file>"
                % (over, MAX_TX_BYTES))
        msg = _compile_v0(payer, bh, ixs, table["table"], table["accounts"])
        print("  built here, against pump.fun's own program — no third-party builder")
        print("  lookup table       %s  (yours, %d fixed accounts)"
              % (table["table"], len(table["accounts"])))
    else:
        print("  fee recipient      %s  (read from pump.fun's global account)" % g["fee_recipient"])
    if needs_init:
        print("  this wallet has never bought on pump.fun, so its volume account is created")
        print("  in the same transaction — pump.fun does not create it on the way past")
    print("  tokens expected    %s" % f"{detail['amount']:,}")
    print("  most it may spend  %.6f SOL  (%.1f%% slippage)"
          % (detail["max_sol_cost"] / LAMPORTS, slippage))
    # An unsigned transaction is still a transaction: empty slots, so Transaction() can parse
    # it and verify_transaction can read it before any key is involved.
    return _shortvec_encode(2) + bytes(64) * 2 + msg


# ──────────────────────────────────────────────────────────── asking, and what is not asked
#
# THE KEY IS NEVER PROMPTED FOR, and that is the one thing this file will not become
# interactive about. A prompt looks safer than an argument — getpass does not echo and does not
# reach shell history — but the risk it leaves is the one that actually happens: pasting secret
# key material somewhere. A clipboard holding a private key gets pasted into the wrong window,
# and "the wrong window" is a chat, an issue, a support thread. The file path is prompted for
# instead, because a path is not a secret and a file is already what solana-keygen writes.

def ask(question: str, default: str | None = None) -> str:
    suffix = " [%s]: " % default if default else ": "
    try:
        got = input("  " + question + suffix).strip()
    except EOFError:
        raise RuntimeError("no answer, and there is no default for this") from None
    return got or (default or "")


def ask_float(question: str) -> float:
    while True:
        raw = ask(question)
        try:
            v = float(raw)
        except ValueError:
            print("    that is not a number")
            continue
        if v <= 0:
            print("    it has to be more than zero")
            continue
        return v


# Roughly the shape of a base58-encoded 64-byte secret key, which is what a wallet's "export
# private key" gives you. If one of those arrives where a PATH was asked for, it has been
# pasted out of a wallet and it must not be accepted, echoed back, or written anywhere.
def looks_like_secret(text: str) -> bool:
    t = text.strip()
    return (len(t) >= 80 and "/" not in t and "." not in t
            and all(c in _B58 for c in t))


def ask_keypair_path(default: str) -> str:
    while True:
        got = ask("keypair FILE (a path, not a key)", default)
        if looks_like_secret(got):
            # Deliberately does not print what was typed.
            print("\n    That is a PRIVATE KEY, not a path. Nothing here accepts one and it has\n"
                  "    not been stored — but it is in your clipboard and your terminal now, so\n"
                  "    treat that wallet as compromised and move its funds.\n\n"
                  "    A launch wallet is a FILE, made fresh for one launch:\n"
                  "        solana-keygen new -o ~/.snooze/launch.json\n"
                  "        chmod 600 ~/.snooze/launch.json\n")
            continue
        if not got:
            print("    a path is needed")
            continue
        return got


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

    # PROMPTED WHEN NOT GIVEN. Both of these are things to decide, not defaults to inherit —
    # the dev buy is money and the keypair is which wallet gets spent — so the prompt has no
    # default for the amount and a conventional one for the path.
    if not args.keypair:
        args.keypair = ask_keypair_path("~/.snooze/launch.json")
    if args.dev_buy is None:
        print("\n  The dev buy is your opening position, taken in the same transaction that")
        print("  creates the token. R SOL takes R/(30+R) of the float: 1.0 is 3.2%, 1.5 is")
        print("  4.8%, 2.0 is 6.25% and starts reading as dev-owned. `size` has the table.")
        args.dev_buy = ask_float("dev buy, in SOL")

    kp = Keypair.load(args.keypair)
    print("\n  payer     %s" % kp.address)
    print("  cluster   %s" % rpc.host)
    bal = rpc.balance(kp.address)
    print("  balance   %.6f SOL" % (bal / LAMPORTS))

    # THE GATE USED TO ASK FOR THE DEV BUY AND NOTHING ELSE, which is not what a launch costs.
    # A create pays rent for the mint account, the associated token account and the metadata
    # account, plus pump.fun's creation fee, plus the priority fee, plus the signature fee. A
    # wallet funded with exactly the dev buy passes the old check and then the transaction
    # fails for lamports — after the metadata has already been pinned publicly.
    #
    # 0.03 SOL IS AN ESTIMATE AND IT IS NOT VERIFIED. It is deliberately a flag rather than a
    # constant, and the simulation in verify_transaction is what actually establishes the real
    # number: it reports what leaves the wallet before anything is signed.
    need = int(args.dev_buy * LAMPORTS)
    reserve = int(args.reserve * LAMPORTS)
    # THE MAIN-WALLET GUARD. The most expensive mistake available here is pointing this at a
    # wallet that holds everything. A launch wallet holds the launch and nothing else, so a
    # balance far above what the launch costs is evidence of the wrong file, not of headroom.
    ceiling = int((args.dev_buy + args.reserve + args.headroom) * LAMPORTS)
    if bal > ceiling:
        raise RuntimeError(
            "%s holds %.4f SOL, more than the %.4f this launch needs "
            "(dev buy %.2f + reserve %.2f + headroom %.2f).\n"
            "  That looks like a main wallet, and this refuses to sign with one. Fund a FRESH\n"
            "  keypair with the launch amount only:\n"
            "      solana-keygen new -o ./launch.json && chmod 600 ./launch.json\n"
            "  Raise --headroom only if you know exactly why."
            % (kp.address, bal / LAMPORTS,
               args.dev_buy + args.reserve + args.headroom,
               args.dev_buy, args.reserve, args.headroom))
    if bal < need + reserve:
        raise RuntimeError(
            "%s holds %.4f SOL. The dev buy is %.4f and a create also pays rent for the mint,\n"
            "  the token account and the metadata, plus pump.fun's creation fee and the\n"
            "  priority fee — budgeted here at %.4f SOL, which is an ESTIMATE.\n"
            "  Fund it with at least %.4f, or lower --reserve if you know the real number."
            % (kp.address, bal / LAMPORTS, args.dev_buy, args.reserve,
               (need + reserve) / LAMPORTS))

    # ── THE DOUBLE-LAUNCH GUARD, and it is the reason the record exists.
    #
    # A second run of this command with no memory of the first one mints a SECOND token while
    # the first is live and being bought — two contract addresses, two metadata URIs, and a
    # community split between them with no way to say which is canonical. So a leftover record
    # stops the command dead rather than being cleaned up silently.
    if not args.dry_run:
        for rec in existing_records(args.keypair):
            r = read_record(rec)
            m = r.get("mint", "?")
            info = rpc.send("getAccountInfo", [m, {"commitment": "confirmed",
                                                   "encoding": "base64"}])
            live = bool(info and info.get("value"))
            raise RuntimeError(
                "there is already a launch record beside that keypair:\n"
                "      %s\n"
                "      mint %s — %s\n\n"
                "  %s"
                % (rec, m,
                   "IT IS ON CHAIN. That token exists." if live
                   else "no account at that mint yet.",
                   ("Your token is already launched. Publish it rather than launching again:\n"
                    "      python3 pumpfun.py publish %s\n\n"
                    "  If you genuinely want a second, different token, move that record aside\n"
                    "  first — this will not do it for you." % m) if live
                   else ("The previous attempt did not land. Resume it with the SAME mint:\n"
                         "      python3 pumpfun.py resume --keypair %s --record %s\n\n"
                         "  Do not start a new launch: if that transaction is still in flight,\n"
                         "  a new one is a second token." % (args.keypair, rec))))

    # CHECKED BEFORE ANYTHING EXPENSIVE. A missing --image used to surface as an uncaught
    # FileNotFoundError from inside upload_metadata — after the mint was ground, which can be
    # minutes. And --dry-run never opened it at all, so the rehearsal passed and the real run
    # failed on the same typo.
    # BEFORE the grind and before the upload, because all of it is permanent.
    problems = check_metadata(args.name, args.symbol, args.description, args.website)
    if problems:
        raise RuntimeError(
            "the metadata is not launch-ready, and it CANNOT BE EDITED after the create:\n"
            + "\n".join("      · " + p for p in problems))

    img = Path(args.image).expanduser()
    if not img.is_file():
        raise RuntimeError("no image at %s — the launch needs one and pins it permanently" % img)
    if img.stat().st_size == 0:
        raise RuntimeError("%s is empty" % img)

    # ── the mint
    if args.mint_keypair:
        mint = Keypair.load(args.mint_keypair)
        print("  mint      %s   (from %s)" % (mint.address, args.mint_keypair))
    elif args.grind:
        print("\n  grinding a mint ending in %r…" % args.grind)
        mint, tried = grind_mint(args.grind)
        print("  mint      %s   (%s keypairs)" % (mint.address, f"{tried:,}"))
    else:
        mint = Keypair.generate()
        print("  mint      %s   (random)" % mint.address)
        # Said out loud because a trader decides in two seconds and this is what they look at.
        print("\n  ! THIS ADDRESS DOES NOT END IN 'pump', and essentially every pump.fun token")
        print("    anybody has seen does, because pump.fun's own frontend grinds for it. The")
        print("    suffix proves NOTHING — anyone can grind one — but not having it makes your")
        print("    address look unlike every other token on the site at the exact moment")
        print("    somebody is deciding whether the address they were sent is real.")
        print("        solana-keygen grind --ends-with pump:1")
        print("        python3 pumpfun.py launch --mint-keypair ./<that file>.json …\n")

    # THE MINT REACHES DISK NOW, before anything that can fail. It used to be written only
    # after the metadata upload and the build had both succeeded — so a grind of several
    # minutes, or a builder that returned a stale blockhash, lost the keypair entirely and the
    # only way forward was a NEW mint, which is a different token with a different address.
    rec_path = record_path(args.keypair, mint.address)
    record = {
        "mint": mint.address,
        "mint_keypair": list(mint._seed + mint.pub),
        "payer": kp.address,
        "name": args.name, "symbol": args.symbol, "uri": None,
        "dev_buy_sol": args.dev_buy,
        "slippage": args.slippage, "priority_fee": args.priority_fee,
        "blockhash": None, "balance_before": bal, "signature": None,
        "status": "mint-reserved",
    }
    if not args.dry_run:
        write_record(rec_path, record)
        print("\n  record    %s" % rec_path)
        warn_if_committable(rec_path)

    # ── metadata. A DRY RUN MUST NOT PUBLISH ANYTHING.
    #
    # The upload is permanent and public: name, ticker, image and socials pinned to IPFS the
    # moment it returns. "Rehearse first" that publishes the launch before the launch exists
    # is not a rehearsal, and anybody watching the pin set sees it early.
    if args.dry_run:
        uri = "https://example.invalid/dry-run-metadata.json"
        print("\n  --dry-run: NOT uploading metadata. Using a placeholder URI, because the")
        print("  upload is permanent and public and a rehearsal must not publish the launch.")
    else:
        print("\n  THIS IS PERMANENT. The mint carries this URI forever and you cannot edit it:")
        print("    name        %s  (%d/%d bytes)"
              % (args.name, len(args.name.encode()), MAX_NAME_BYTES))
        print("    symbol      %s  (%d/%d bytes)"
              % (args.symbol, len(args.symbol.encode()), MAX_SYMBOL_BYTES))
        print("    website     %s" % args.website)
        print("    twitter     %s" % (args.twitter or "(none)"))
        print("    telegram    %s" % (args.telegram or "(none)"))
        print("    image       %s (%s bytes)" % (img, f"{img.stat().st_size:,}"))
        print("    description")
        for line in args.description.splitlines() or [""]:
            print("      | %s" % line)
        print("\n  uploading metadata…")
        uri = upload_metadata(args.name, args.symbol, args.description, args.image,
                              args.twitter, args.telegram, args.website)
        print("  metadata  %s" % uri)
        record["uri"] = uri
        record["status"] = "metadata-pinned"
        write_record(rec_path, record)

    print("\n  building create + buy as ONE transaction…")
    tbl = None
    tp = table_path(args.keypair)
    if tp.exists():
        tbl = json.loads(tp.read_text())
    raw = build_launch_tx(rpc, kp.address, mint.address, args.name, args.symbol, uri,
                          args.dev_buy, args.slippage, args.priority_fee, args.builder, tbl)
    tx = Transaction(raw)
    # Resolve the lookup tables BEFORE describing it. Without this the description shows every
    # instruction as "(behind an unresolved lookup table) UNKNOWN PROGRAM", which is true and
    # useless — it is the display that has not looked yet, not a finding about the
    # transaction. A failure here is left alone: verify_transaction resolves again and reports
    # it as the refusal it is.
    if tx.lookups:
        try:
            rpc.resolve_lookups(tx)
        except RuntimeError:
            pass
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
        print("\n  --dry-run: verified and STOPPED. Nothing was signed, nothing was sent,")
        print("  and no metadata was published.\n")
        return 0

    # THE SIMULATION DID NOT CHECK THIS, and could not have: verify_transaction passes
    # replaceRecentBlockhash: True, which by design substitutes a fresh blockhash so the
    # simulation is not rejected for staleness. That means the blockhash the builder actually
    # put in the transaction — the one that will be sent — was never validated by anything.
    # A stale one is a send that fails after the metadata is already pinned.
    if not rpc.blockhash_valid(tx.recent_blockhash):
        raise RuntimeError(
            "the builder's blockhash (%s) has already expired, so this transaction can never\n"
            "  land. Nothing was signed and nothing was sent. Re-run to get a fresh one — the\n"
            "  metadata is already pinned, so pass --mint-keypair to keep the same mint."
            % tx.recent_blockhash)

    # THE LAST DOOR. Everything above this line is reversible — nothing has been signed and
    # the metadata, though pinned, is attached to no token. Everything below is permanent, so
    # it is confirmed by typing the ticker rather than by pressing a key, because a
    # yes/no prompt is answered reflexively and typing the symbol requires reading the summary.
    if not args.yes:
        print("\n  " + "─" * 68)
        print("  ABOUT TO CREATE THE TOKEN AND SPEND %.4f SOL. None of this can be edited,"
              % args.dev_buy)
        print("  reverted, or relaunched onto the same address.")
        print("    name        %s" % args.name)
        print("    symbol      %s" % args.symbol)
        print("    mint        %s" % mint.address)
        print("    dev buy     %.4f SOL from %s" % (args.dev_buy, kp.address))
        print("    website     %s" % args.website)
        print("    metadata    %s" % uri)
        print("  " + "─" * 68)
        if ask("type the ticker to launch, anything else to stop") != args.symbol:
            print("\n  Stopped. Nothing was signed and nothing was sent. The metadata is\n"
                  "  pinned and the mint is recorded, so re-running with --mint-keypair %s\n"
                  "  continues this launch rather than starting a different one.\n"
                  % rec_path)
            return 1

    # ── everything the send needs is now known
    record["blockhash"] = tx.recent_blockhash
    record["status"] = "about-to-send"
    write_record(rec_path, record)
    print("\n  record    %s   (written BEFORE sending, so a retry is a retry)" % rec_path)

    return _send_and_confirm(rpc, kp, mint, tx, record, rec_path, args.keypair)


def _send_and_confirm(rpc, kp, mint, tx, record, rec_path, keypair_path):
    """Sign, send, confirm, read back. Shared by launch and resume."""
    wire = tx.signed({kp.address: kp, mint.address: mint})
    # The bytes that get sent must be the bytes that were checked. signed() only fills
    # signature slots, so the message must be identical — asserted rather than assumed,
    # because everything verify_transaction proved was proved about this message.
    if Transaction(wire).message != tx.message:
        raise RuntimeError("signing changed the message. Refusing to send.")

    print("\n  signing and sending…")
    sig = None
    try:
        sig = rpc.send("sendTransaction", [base64.b64encode(wire).decode(),
                                           {"encoding": "base64", "skipPreflight": False,
                                            "preflightCommitment": "confirmed",
                                            "maxRetries": 3}])
    except RuntimeError as e:
        # THE WORST CASE, and it needs saying rather than raising bare. The node may have
        # accepted and forwarded the transaction before the response failed, so "the send
        # errored" is NOT "nothing was sent" — and the signature, which is the only handle on
        # it, is exactly what was lost.
        record["status"] = "send-failed-outcome-unknown"
        write_record(rec_path, record)
        raise RuntimeError(
            "%s\n\n"
            "  THE OUTCOME IS UNKNOWN, not failed. The node may have accepted and forwarded\n"
            "  the transaction before this call errored. Do NOT relaunch.\n"
            "      python3 pumpfun.py resume --keypair %s --record %s\n"
            "  will check whether the mint %s exists before doing anything."
            % (e, keypair_path, rec_path, mint.address))

    record["signature"] = sig
    record["status"] = "sent"
    write_record(rec_path, record)
    print("  signature %s" % sig)

    landed = _await_confirmation(rpc, sig, tx.recent_blockhash, mint.address, rec_path, record)
    if not landed:
        return 2
    return _read_back(rpc, kp, mint, record, rec_path)


class LaunchFailed(RuntimeError):
    """The transaction landed and reverted. A distinct type ON PURPOSE.

    The loop below catches RuntimeError to survive a transient RPC failure while a transaction
    is in flight — abandoning one that might have landed is what leads to a relaunch. But the
    "it landed and failed" raise was ALSO a RuntimeError, so the loop caught its own exception,
    printed it as "(rpc hiccup: … — still watching)", and went round again. Forever. On the one
    outcome where the operator most needs the command to stop and say what happened.
    """


def _await_confirmation(rpc, sig, blockhash, mint_addr, rec_path, record) -> bool:
    """Wait on the BLOCKHASH, not on a wall clock.

    A timer cannot tell "expired, never landed" from "landed and I did not see it", and
    guessing wrong in the second direction mints a second token. A blockhash is valid for 150
    blocks; once it is invalid and the signature is still not found, the transaction is dead
    beyond recovery and only then is a retry safe.
    """
    print("\n  confirming (waiting on the blockhash, not on a clock)…")
    while True:
        # ONLY the RPC calls are inside the guard. Everything decided from their answers is
        # outside it, so a decision this function makes can never be mistaken for a network
        # failure by this function.
        try:
            status = rpc.send("getSignatureStatuses",
                              [[sig], {"searchTransactionHistory": True}])
            still_possible = rpc.blockhash_valid(blockhash)
        except RuntimeError as e:
            print("    (rpc hiccup: %s — still watching)" % e)
            time.sleep(3)
            continue

        v = (status.get("value") or [None])[0]
        if v and v.get("confirmationStatus") in ("confirmed", "finalized"):
            if v.get("err"):
                record["status"] = "landed-and-failed"
                record["error"] = str(v["err"])
                write_record(rec_path, record)
                raise LaunchFailed(
                    "the transaction landed and FAILED on chain: %r\n"
                    "  Nothing was created and the dev buy was not spent — a Solana\n"
                    "  transaction is atomic. The fee was. Fix the cause and resume with the\n"
                    "  SAME mint:\n"
                    "      python3 pumpfun.py resume --keypair <yours> --record %s"
                    % (v["err"], rec_path))
            record["status"] = "landed"
            write_record(rec_path, record)
            return True

        if not still_possible and not v:
            # Dead beyond recovery: the blockhash can no longer be used, so those bytes can
            # never execute. THE SIGNATURE IS CLEARED — without that, resume finds a recorded
            # signature, re-checks a transaction that can never land, and reports the same dead
            # end forever instead of rebuilding.
            record["status"] = "expired-never-landed"
            record["signature"] = None
            write_record(rec_path, record)
            print("\n  THE BLOCKHASH EXPIRED AND THE TRANSACTION NEVER LANDED.")
            print("  This is the one outcome that is safe to retry, and it is safe because it")
            print("  is now KNOWN rather than assumed. Retry with the SAME mint:")
            print("      python3 pumpfun.py resume --keypair <yours> --record %s\n" % rec_path)
            return False

        # Either it is still in flight, or the blockhash is dead while a non-confirmed status
        # lingers (a minority fork, a node lagging its own promotion). Both are "keep looking",
        # and both need the sleep — without it this span polls as fast as the network allows.
        time.sleep(2)


def _read_back(rpc, kp, mint, record, rec_path):
    """Read the result at the SAME commitment the confirmation used."""
    print("\n  reading it back off the chain (at 'confirmed', matching the wait)…")
    after = rpc.balance(kp.address)
    # .get, not [], because resume reaches here on records written by an earlier run that may
    # not carry it — and a KeyError on a launch that HAS landed is a traceback at the worst
    # possible moment, over a number that is only used to print a cost basis.
    before = record.get("balance_before")
    spent = (before - after) if before is not None else None
    held, dec = 0, None
    for acc in (rpc.send("getTokenAccountsByOwner",
                         [kp.address, {"mint": mint.address},
                          {"commitment": "confirmed", "encoding": "jsonParsed"}])
                .get("value") or []):
        amt = acc["account"]["data"]["parsed"]["info"]["tokenAmount"]
        held += int(amt["amount"])
        dec = int(amt["decimals"])
    if dec is None:
        dec = 6
    tokens = held / (10 ** dec)
    print("  mint       %s" % mint.address)
    print("  spent      %s" % ("%.6f SOL" % (spent / LAMPORTS) if spent is not None
                               else "unknown (no pre-launch balance recorded)"))
    print("  you hold   %s tokens  (%d decimals, read from the chain)"
          % (f"{tokens:,.0f}", dec))
    if held == 0:
        # NOT "the buy did not land". A Solana transaction is ATOMIC: the create and the buy
        # are instructions in one transaction, so they both happened or neither did, and the
        # confirmation above already established that it succeeded. Zero here means the READ
        # is wrong, not the launch — and the previous version of this message said the
        # opposite and told the operator to investigate before resending, which is how a live,
        # trading token gets a twin.
        raise RuntimeError(
            "the transaction SUCCEEDED but this read returned no tokens.\n\n"
            "  DO NOT RELAUNCH. A Solana transaction is atomic — the create and the buy are\n"
            "  one transaction, so a create that succeeded with a buy that did not is not a\n"
            "  state that exists. The token is live at %s.\n\n"
            "  What is actually wrong is this read. Check it by hand:\n"
            "      solana balance --url $SOLANA_RPC %s\n"
            "      https://solscan.io/tx/%s\n"
            % (mint.address, mint.address, record.get("signature")))
    record["status"] = "verified"
    record["tokens"] = held
    record["decimals"] = dec
    record["spent_lamports"] = spent
    write_record(rec_path, record)
    if spent is not None:
        print("  cost basis %.12f SOL per token" % (spent / LAMPORTS / tokens))
    # /coin/<mint> is the current form. UNVERIFIED from here — pump.fun is not reachable
    # from this environment — so the solscan link beside it is the one that is certainly right.
    print("\n  https://pump.fun/coin/%s" % mint.address)
    print("  https://solscan.io/token/%s" % mint.address)
    print("\n  NOW PUBLISH THE CA. Copycats appear within minutes and the only defence is\n"
          "  being the first published address:")
    print("      python3 pumpfun.py publish %s\n" % mint.address)
    return 0


def cmd_resume(args):
    """Finish or safely retry a launch whose outcome was not seen."""
    rpc = Rpc()
    rec_path = Path(args.record).expanduser()
    record = read_record(rec_path)
    mint = Keypair(bytes(record["mint_keypair"][:32]), bytes(record["mint_keypair"][32:]))
    kp = Keypair.load(args.keypair)
    print("\n  record    %s" % rec_path)
    print("  mint      %s" % mint.address)
    print("  status    %s" % record.get("status"))

    info = rpc.send("getAccountInfo", [mint.address,
                                       {"commitment": "confirmed", "encoding": "base64"}])
    if info and info.get("value"):
        print("\n  THAT MINT IS ALREADY ON CHAIN. The launch happened.")
        record["balance_before"] = record.get("balance_before", rpc.balance(kp.address))
        return _read_back(rpc, kp, mint, record, rec_path)

    sig = record.get("signature")
    if sig:
        print("\n  the mint does not exist yet, and a signature was recorded. Checking it…")
        if not _await_confirmation(rpc, sig, record["blockhash"], mint.address,
                                   rec_path, record):
            print("  Re-run this command to rebuild and resend with the same mint.")
            return 2
        return _read_back(rpc, kp, mint, record, rec_path)

    print("\n  no signature was recorded and the mint does not exist, so nothing landed.")
    print("  Rebuilding the same launch with the SAME mint…")
    # FROM THE RECORD, not from this command's defaults. An operator who launched during
    # congestion with --priority-fee 0.01 --slippage 25, then followed the error message to
    # `resume`, silently got 0.0005 and 10 — the settings chosen because the defaults were not
    # working. Explicit flags on resume still win.
    slip = args.slippage if args.slippage is not None else record.get("slippage", 10)
    prio = (args.priority_fee if args.priority_fee is not None
            else record.get("priority_fee", 0.0005))
    print("  slippage  %s%%   priority fee %s SOL   (from the record unless overridden)"
          % (slip, prio))
    raw = build_launch_tx(rpc, kp.address, mint.address, record["name"], record["symbol"],
                          record["uri"], record["dev_buy_sol"], slip, prio,
                          record.get("builder", "direct"),
                          json.loads(table_path(args.keypair).read_text())
                          if table_path(args.keypair).exists() else None)
    tx = Transaction(raw)
    need = int(record["dev_buy_sol"] * LAMPORTS)
    checks = verify_transaction(tx, kp.address, mint.address, need, rpc)
    bad = sum(0 if g else 1 for g, _ in checks)
    for good, name in checks:
        print("    %s %s" % ("ok  " if good else "FAIL", name))
    if bad:
        raise RuntimeError("%d check(s) failed. Nothing was signed and nothing was sent." % bad)
    record["blockhash"] = tx.recent_blockhash
    record["balance_before"] = rpc.balance(kp.address)
    write_record(rec_path, record)
    return _send_and_confirm(rpc, kp, mint, tx, record, rec_path, args.keypair)


# The pages that carry the contract address, and the exact line each one holds it on. A
# line-anchored edit makes "fill a blank" and "overwrite a live address" different events,
# which is what lets this refuse the second one. It matters more on Solana than anywhere with
# checksummed addresses: a base58 pubkey carries no checksum at all, so a single wrong
# character is a valid-looking address and nothing detects it.
CA_PAGES = ["web/index.html"]
# The line publish rewrites. It is in the MARKUP rather than in a script, so the address
# renders with JavaScript off — an in-app webview, a content blocker, Brave on strict — which
# is a large share of the people who ever open a link to a token.
CA_MARK = 'id="ca" data-ca="'
import re as _re
CA_LINE = _re.compile(r'^(\s*)<div class="ca(?: none)?" id="ca" data-ca="([^"]*)">.*</div>\s*$')


def cmd_publish(args):
    rpc = Rpc()
    root = HERE
    mint = args.mint

    # THE ADDRESS IS NEVER TYPED IF A RECORD EXISTS. An address typed by hand verifies just as
    # happily against somebody else's token, or against a typo that happens to land on a real
    # account — so when the launch record is there, it is the source and a typed one that
    # disagrees is a refusal rather than an override.
    if args.record:
        rec = read_record(Path(args.record).expanduser())
        if mint and mint != rec["mint"]:
            raise RuntimeError("the record says %s and you typed %s. Refusing."
                               % (rec["mint"], mint))
        mint = rec["mint"]
        if rec.get("status") != "verified":
            raise RuntimeError(
                "that record is %r, not 'verified'. Publish an address only after it has been\n"
                "  read back off the chain — resume it first." % rec.get("status"))
    if not mint:
        raise RuntimeError("give a mint, or --record the launch record it came from")
    try:
        b58decode(mint)
    except ValueError as e:
        raise RuntimeError("%s is not base58: %s" % (mint, e)) from None
    if len(b58decode(mint)) != 32:
        raise RuntimeError("%s decodes to %d bytes; a Solana address is 32"
                           % (mint, len(b58decode(mint))))

    # ── read it back off the chain before a byte of the site changes
    print("\n  checking %s on %s…" % (mint, rpc.host))
    info = rpc.send("getAccountInfo", [mint, {"commitment": "confirmed",
                                              "encoding": "jsonParsed"}])
    val = info and info.get("value")
    if not val:
        raise RuntimeError("there is no account at %s. Refusing to publish it." % mint)
    parsed = ((val.get("data") or {}).get("parsed") or {})
    if parsed.get("type") != "mint":
        raise RuntimeError("the account at %s is not a token mint (it is %r). Refusing."
                           % (mint, parsed.get("type")))
    inf = parsed.get("info") or {}
    print("  it is a mint: %s decimals, supply %s"
          % (inf.get("decimals"), inf.get("supply")))
    # A mint that can still be minted is not a fixed supply, and the site must not imply one.
    if inf.get("mintAuthority"):
        print("  ! mintAuthority is STILL SET (%s). Supply is not fixed and the site must not"
              % inf["mintAuthority"])
        print("    say it is.")
    else:
        print("  mint authority is revoked — supply is fixed")
    if inf.get("freezeAuthority"):
        print("  ! freezeAuthority is SET (%s) — accounts can be frozen" % inf["freezeAuthority"])

    changed = []
    for rel in CA_PAGES:
        f = root / rel
        if not f.is_file():
            print("  -- %s does not exist, skipping" % rel)
            continue
        lines = f.read_text().splitlines(keepends=True)
        hit = None
        for i, line in enumerate(lines):
            m = CA_LINE.match(line.rstrip("\n"))
            if m:
                hit = (i, m)
                break
        if hit is None:
            print("  -- %s has no address line to fill, skipping" % rel)
            continue
        i, m = hit
        indent, existing = m.group(1), m.group(2)
        if existing and existing != mint:
            raise RuntimeError(
                "%s already publishes a DIFFERENT address:\n"
                "      %s\n"
                "  Refusing to overwrite it. Filling a blank and replacing a live address are\n"
                "  different events and only the first one is safe to do automatically."
                % (rel, existing))
        if existing == mint:
            print("  == %s already publishes it" % rel)
            continue
        new_line = '%s<div class="ca" id="ca" data-ca="%s">%s</div>\n' % (indent, mint, mint)

        # EVERY LINK, INTO THE MARKUP. data-url holds the base; the href becomes base+mint, so
        # pump.fun, Solscan and DexScreener all resolve with JavaScript off. They used to be
        # filled only by the page's script, which is the same hole the address itself had: a
        # visitor with JS blocked got a working address and three links to bare domains.
        wired = 0
        for j, line in enumerate(lines):
            m2 = _re.search(r'data-url="([^"]*)"', line)
            if not m2:
                continue
            base = m2.group(1)
            want = 'href="%s%s"' % (base, mint)
            if want in line:
                continue
            if _re.search(r'href="[^"]*"', line):
                lines[j] = _re.sub(r'href="[^"]*"', want, line, count=1)
            else:
                # No href yet: the buy/sell buttons, inert until there is something to point at.
                lines[j] = line.replace('data-url="%s"' % base,
                                        'data-url="%s" %s' % (base, want), 1)
            wired += 1

        if args.write:
            lines[i] = new_line
            f.write_text("".join(lines))
            changed.append(rel)
            print("  ++ %s  (address + %d link%s)"
                  % (rel, wired, "" if wired == 1 else "s"))
        else:
            print("  would write %s -> %s  (address + %d link%s)"
                  % (rel, mint, wired, "" if wired == 1 else "s"))

    if not args.write:
        print("\n  nothing was written. Re-run with --write.\n")
        return 0
    print("\n  wrote %d page(s). Commit and deploy — the address is not published until the"
          % len(changed))
    print("  site is:")
    print("      git add web/index.html && git commit -m 'publish the contract address'")
    print("      git push\n")
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
    # PAGED BACK TO THE GENESIS TRANSACTION, because getSignaturesForAddress returns the
    # NEWEST first. Taking one page and reversing it gives you the oldest of the newest 200 —
    # which on any launch busy enough to be worth watching is not the create, so the "creator"
    # was whoever happened to trade 200 transactions ago and every share below was measured
    # against the wrong wallet.
    sigs, before = [], None
    while True:
        params = {"limit": 1000}
        if before:
            params["before"] = before
        page = rpc.send("getSignaturesForAddress", [mint, params]) or []
        sigs.extend(page)
        if len(page) < 1000 or len(sigs) > 50000:
            break
        before = page[-1]["signature"]
    if not sigs:
        print("  no transactions for that mint.\n")
        return 0
    print("  %s signatures back to the create" % f"{len(sigs):,}")
    sigs = list(reversed(sigs))                      # oldest first: the launch is the first
    sigs = sigs[:args.limit]                         # and only the window we will read
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


def table_path(keypair_path: str) -> Path:
    return Path(keypair_path).expanduser().resolve().parent / "lookup-table.json"


def _send_until_landed(rpc, kp, ixs, label: str, priority_fee: float,
                       compute_limit: int = 200_000) -> str:
    """Send, and keep sending the SAME bytes until the chain accepts them or the slot dies.

    Everything here is a fix for a table creation that vanished:

    A transaction with no priority fee is a transaction validators may drop, and this one paid
    nothing at all while the launch beside it took --priority-fee. Under any load that is not
    a slow send, it is a send that never lands.

    Sending once and then watching is not how a transaction gets confirmed on Solana. The
    same signed bytes are rebroadcast every few seconds: the signature is deterministic, so a
    resend is the same transaction, and the cluster deduplicates it. One of them lands.

    And 90 seconds on a wall clock cannot tell "dropped" from "still in flight". A blockhash
    is valid for 150 blocks; while it is valid the transaction can still land, and once it is
    invalid it never can. That is the only honest test, and it is the one the launch path
    already used — this one had a timer instead.
    """
    micro = int(priority_fee * LAMPORTS * 1_000_000 // compute_limit) if priority_fee else 0
    head = [(COMPUTE_BUDGET, [], bytes([2]) + compute_limit.to_bytes(4, "little"))]
    if micro:
        head.append((COMPUTE_BUDGET, [], bytes([3]) + _u64(micro)))
    bh = rpc.blockhash()["blockhash"]
    msg = _compile(kp.address, bh, head + ixs)
    raw = _shortvec_encode(1) + kp.sign(msg) + msg
    if len(raw) > MAX_TX_BYTES:
        raise RuntimeError("%s is %d bytes, over the %d-byte limit"
                           % (label, len(raw), MAX_TX_BYTES))
    b64 = base64.b64encode(raw).decode()
    sig = rpc.send("sendTransaction",
                   [b64, {"encoding": "base64", "skipPreflight": False,
                          "preflightCommitment": "confirmed", "maxRetries": 0}])
    print("  %s  %s (%d bytes)" % (label, sig, len(raw)))
    last = 0.0
    while True:
        st = rpc.send("getSignatureStatuses", [[sig]])["value"][0]
        if st and st.get("err"):
            raise RuntimeError("%s failed on-chain: %s" % (label, st["err"]))
        if st and st.get("confirmationStatus") in ("confirmed", "finalized"):
            return sig
        if not rpc.blockhash_valid(bh):
            # Dead beyond recovery: these bytes can never land now, so retrying is safe.
            raise LaunchFailed(
                "%s did not land — its blockhash expired, so those bytes can never be\n"
                "  included now. Nothing happened. Run the same command again." % label)
        if time.time() - last > 4:
            rpc.send("sendTransaction",
                     [b64, {"encoding": "base64", "skipPreflight": True, "maxRetries": 0}])
            last = time.time()
        time.sleep(2)


def table_path(keypair_path: str) -> Path:
    return Path(keypair_path).expanduser().resolve().parent / "lookup-table.json"


def cmd_table(args):
    """Create the address lookup table this wallet's launches reference.

    Needed because a launch does not fit in a legacy transaction any more. With cashback
    enabled a buy carries eight trailing fee recipients, and the whole thing touches 30
    accounts — past the 1232-byte limit. The fixed accounts move in here; the per-launch ones
    stay in the message.

    RESUMABLE, because the first attempt at this stalled. The table's address is written down
    BEFORE anything is sent, and a re-run reads the chain to see how much of the work is
    already done: a create that landed after a timeout is not repeated, and extending picks up
    from however many addresses are actually in the table. Making a second table would only
    cost rent, but "run it again and hope" is not a thing a launch script should ask for.
    """
    rpc = Rpc()
    kp = Keypair.load(args.keypair)
    dest = table_path(args.keypair)
    g = read_global(rpc)
    addrs = launch_static_accounts(g)

    print()
    print("  payer     %s" % kp.address)
    print("  cluster   %s" % rpc.host)
    print("  balance   %.6f SOL" % (rpc.balance(kp.address) / LAMPORTS))

    pending = json.loads(dest.read_text()) if dest.exists() else None
    if pending and pending.get("accounts") != addrs:
        raise RuntimeError(
            "%s describes a table over different accounts than this launch needs.\n"
            "  pump.fun's configuration has changed since it was made. Delete it and run\n"
            "  this again to build a new one." % dest)
    if pending and pending.get("complete"):
        print()
        print("  A finished table already exists for this wallet: %s" % pending["table"])
        print("  Tables are append-only and reusable, so a second one is only rent.")
        print("  Delete %s to make another." % dest)
        return 0

    if pending:
        table, recent = pending["table"], pending["slot"]
        print()
        print("  resuming the table started earlier: %s" % table)
    else:
        # The slot is a seed of the address, so it fixes where the table will be before
        # anything is sent — which is what makes this resumable at all.
        recent = rpc.slot("finalized")
        _, table = alt_create_ix(kp.address, kp.address, recent)
        print()
        print("  table     %s" % table)
        print("  holding   %d accounts, none of them per-launch" % len(addrs))
        for a in addrs:
            print("      %s" % a)
        if not args.yes:
            if ask("create it? type CREATE").strip() != "CREATE":
                print("\n  stopped. Nothing was signed.\n")
                return 1
        dest.write_text(json.dumps({"table": table, "authority": kp.address,
                                    "accounts": addrs, "slot": recent,
                                    "complete": False}, indent=2))
        dest.chmod(0o600)

    # How much of this is already done, according to the chain rather than to a local guess.
    try:
        have = rpc.lookup_table(table)
    except RuntimeError:
        have = None
    if have is None:
        create_ix, _ = alt_create_ix(kp.address, kp.address, recent)
        print("\n  creating the table…")
        _send_until_landed(rpc, kp, [create_ix], "create", args.priority_fee)
        have = []
    elif have:
        print("\n  %d of %d addresses are already in it" % (len(have), len(addrs)))
    if have != addrs[:len(have)]:
        raise RuntimeError(
            "the table at %s holds addresses this did not put there. Refusing to extend it."
            % table)

    # Twelve at a time: 22 addresses plus the message overhead is close enough to the size
    # limit that one extend is not worth being the thing that fails.
    while len(have) < len(addrs):
        chunk = addrs[len(have):len(have) + 12]
        print("\n  adding %d addresses (%d of %d done)…"
              % (len(chunk), len(have), len(addrs)))
        _send_until_landed(rpc, kp, [alt_extend_ix(table, kp.address, kp.address, chunk)],
                           "extend", args.priority_fee)
        have = rpc.lookup_table(table)

    if have != addrs:
        raise RuntimeError("the table's contents are not what was sent")
    # A table cannot be used in the slot it was extended in. Waiting means the next command
    # works, rather than failing with something that reads like a bug.
    print("\n  waiting for the table to become usable (one slot)…")
    start = rpc.slot("confirmed")
    while rpc.slot("confirmed") <= start + 1:
        time.sleep(1)
    dest.write_text(json.dumps({"table": table, "authority": kp.address,
                                "accounts": addrs, "slot": recent,
                                "complete": True}, indent=2))
    dest.chmod(0o600)
    print("  verified  %d addresses, read back from the chain and identical" % len(have))
    print("  written   %s" % dest)
    print()
    print("  launch will use it automatically.")
    print()
    return 0


def anchor_idl_address(program: str) -> str:
    """Where an Anchor program keeps its own IDL, on chain.

    A PDA over no seeds gives a base; the IDL account is that base with the seed "anchor:idl",
    which is a plain sha256 rather than a PDA derivation — createWithSeed, not
    findProgramAddress.
    """
    base = find_program_address([], program)
    return b58encode(hashlib.sha256(b58decode(base) + b"anchor:idl"
                                    + b58decode(program)).digest())


def fetch_idl(rpc, program: str) -> dict:
    """The IDL the DEPLOYED program published, not the one a docs repo has.

    This exists because they disagreed. pump.fun's public IDL was last committed in May and
    the program running on mainnet returned error 6074, which that file's table stops short
    of at 6071 — so the account lists it describes cannot be trusted either. An IDL read from
    the chain is the program's own account of itself.

    Layout: an 8-byte discriminator, the authority, a u32 length, then zlib-compressed JSON.
    """
    addr = anchor_idl_address(program)
    v = rpc.account(addr)
    if v is None:
        raise RuntimeError("%s publishes no IDL account (%s does not exist)" % (program, addr))
    raw = base64.b64decode(v["data"][0])
    if len(raw) < 44:
        raise RuntimeError("the IDL account at %s is too short to be one" % addr)
    n = int.from_bytes(raw[40:44], "little")
    body = raw[44:44 + n]
    if len(body) < n:
        raise RuntimeError("the IDL account at %s claims %d bytes and holds %d"
                           % (addr, n, len(body)))
    try:
        return json.loads(zlib.decompress(body))
    except Exception as e:
        raise RuntimeError("the IDL at %s did not decompress as one: %s" % (addr, e)) from None


def cmd_idl(args):
    """Read a program's IDL off the chain, and say what an error code or instruction means.

    The docs repo lags the deployment. That is not a complaint about pump.fun — it is a
    reason not to build a transaction from a file in a repo and assume it matches the program
    that will execute it.
    """
    rpc = Rpc()
    idl = fetch_idl(rpc, args.address)
    errs = {e["code"]: e for e in idl.get("errors", [])}
    print()
    print("  program     %s" % args.address)
    print("  idl account %s" % anchor_idl_address(args.address))
    print("  instructions %d, errors %d (%d–%d)"
          % (len(idl.get("instructions", [])), len(errs),
             min(errs) if errs else 0, max(errs) if errs else 0))
    if args.out:
        Path(args.out).write_text(json.dumps(idl, indent=2))
        print("  written     %s" % args.out)
    if args.error is not None:
        e = errs.get(args.error)
        print()
        if e is None:
            print("  %d is not an error this program declares." % args.error)
        else:
            print("  %d  %s" % (args.error, e["name"]))
            if e.get("msg"):
                print("      %s" % e["msg"])
    if args.instruction:
        for ix in idl.get("instructions", []):
            if ix["name"] == args.instruction:
                print()
                print("  %s  discriminator %s"
                      % (ix["name"], bytes(ix["discriminator"]).hex()))
                for n, a in enumerate(ix["accounts"]):
                    bits = "".join(("w" if a.get("writable") else "-",
                                    "s" if a.get("signer") else "-",
                                    "?" if a.get("optional") else "-"))
                    print("    %2d. %-36s %s" % (n, a["name"], bits))
                print("    args: %s" % ", ".join(a["name"] for a in ix["args"]))
                break
        else:
            print("\n  %s is not an instruction this program declares." % args.instruction)
    print()
    return 0


WSOL = "So11111111111111111111111111111111111111112"
SHARING_CONFIG_SEED = b"sharing-config"

# The account list of every instruction this script needs to READ or BUILD, in order, from
# pump.fun's IDL. Positional, because an account's position is its meaning — the trace that
# unblocked this printed 27 addresses and 27 question marks until it had these names.
IX_ACCOUNTS = {
    "buy": [
        "global", "fee_recipient", "mint", "bonding_curve", "associated_bonding_curve",
        "associated_user", "user", "system_program", "token_program", "creator_vault",
        "event_authority", "program", "global_volume_accumulator", "user_volume_accumulator",
        "fee_config", "fee_program"],
    "buy_v2": [
        "global", "base_mint", "quote_mint", "base_token_program", "quote_token_program",
        "associated_token_program", "fee_recipient", "associated_quote_fee_recipient",
        "buyback_fee_recipient", "associated_quote_buyback_fee_recipient", "bonding_curve",
        "associated_base_bonding_curve", "associated_quote_bonding_curve", "user",
        "associated_base_user", "associated_quote_user", "creator_vault",
        "associated_creator_vault", "sharing_config", "global_volume_accumulator",
        "user_volume_accumulator", "associated_user_volume_accumulator", "fee_config",
        "fee_program", "system_program", "event_authority", "program"],
    "create": [
        "mint", "mint_authority", "bonding_curve", "associated_bonding_curve", "global",
        "mpl_token_metadata", "metadata", "user", "system_program", "token_program",
        "associated_token_program", "rent", "event_authority", "program"],
    "create_v2": [
        "mint", "mint_authority", "bonding_curve", "associated_bonding_curve", "global",
        "user", "system_program", "token_program", "associated_token_program",
        "mayhem_program_id", "global_params", "sol_vault", "mayhem_state",
        "mayhem_token_vault", "event_authority", "program"],
    "init_user_volume_accumulator": [
        "payer", "user", "user_volume_accumulator", "system_program", "event_authority",
        "program"],
}
IX_ACCOUNTS["buy_exact_quote_in_v2"] = IX_ACCOUNTS["buy_v2"]
IX_ACCOUNTS["buy_exact_sol_in"] = IX_ACCOUNTS["buy"]
IX_ACCOUNTS["sell_v2"] = [a for a in IX_ACCOUNTS["buy_v2"] if a != "global_volume_accumulator"]


def derive_v2_accounts(base_mint: str, user: str, g: dict, base_token_program: str,
                       buyback_recipient: str) -> dict:
    """Every account buy_v2 takes, derived.

    VERIFIED AGAINST A REAL MAINNET BUY, not against the IDL that describes one — all ten
    derivable accounts in transaction 4tq5fgiY… reproduce exactly. That check found the one
    that was wrong: sharing_config is a PDA of the FEE program, not of pump.fun. The IDL says
    so, in a field naming the program by its raw bytes, which is exactly the kind of thing
    that is read past.
    """
    bc = find_program_address([b"bonding-curve", b58decode(base_mint)], PUMP_PROGRAM)
    uva = find_program_address([b"user_volume_accumulator", b58decode(user)], PUMP_PROGRAM)
    creator_vault = find_program_address([b"creator-vault", b58decode(user)], PUMP_PROGRAM)
    return {
        "global": g["address"], "base_mint": base_mint, "quote_mint": WSOL,
        "base_token_program": base_token_program, "quote_token_program": TOKEN_PROGRAM,
        "associated_token_program": ATA_PROGRAM,
        "fee_recipient": g["fee_recipient"],
        "associated_quote_fee_recipient": ata(g["fee_recipient"], WSOL),
        "buyback_fee_recipient": buyback_recipient,
        "associated_quote_buyback_fee_recipient": ata(buyback_recipient, WSOL),
        "bonding_curve": bc,
        "associated_base_bonding_curve": ata(bc, base_mint, base_token_program),
        "associated_quote_bonding_curve": ata(bc, WSOL),
        "user": user,
        "associated_base_user": ata(user, base_mint, base_token_program),
        "associated_quote_user": ata(user, WSOL),
        "creator_vault": creator_vault,
        "associated_creator_vault": ata(creator_vault, WSOL),
        "sharing_config": find_program_address(
            [SHARING_CONFIG_SEED, b58decode(base_mint)], PUMP_FEE_PROGRAM),
        "global_volume_accumulator": find_program_address(
            [b"global_volume_accumulator"], PUMP_PROGRAM),
        "user_volume_accumulator": uva,
        "associated_user_volume_accumulator": ata(uva, WSOL),
        "fee_config": find_program_address([b"fee_config", b58decode(PUMP_PROGRAM)],
                                           PUMP_FEE_PROGRAM),
        "fee_program": PUMP_FEE_PROGRAM, "system_program": SYSTEM_PROGRAM,
        "event_authority": find_program_address([b"__event_authority"], PUMP_PROGRAM),
        "program": PUMP_PROGRAM,
    }


# Candidate seeds for an account nobody documents. Guessing is not a method, but a guess
# CHECKED against a real transaction is just a lookup with extra steps — and the checking is
# what `trace` does.
BCV2_CANDIDATES = [(t, t.encode()) for t in (
    "bonding-curve-v2", "bonding_curve_v2", "bonding-curve-2", "bonding-curve2",
    "bonding_curve-v2", "curve-v2", "curve_v2", "bcv2", "bonding-curve-sol",
    "bonding-curve-quote", "quote-bonding-curve", "bonding-curve-state", "v2-bonding-curve",
    "bonding-curve-extension", "bonding_curve_extension", "curve-extension",
)]


def solve_pda(target: str, mint: str, programs=(), seeds=()) -> str:
    """Which seed and program produce `target` for this mint, if any of the candidates do.

    Brute force over a list is not elegant and it is honest: bonding_curve_v2 is required by
    the deployed program and named in no IDL, so the only way to derive it is to find a real
    transaction that used it and work out what produces the same address. A candidate that
    reproduces a real mainnet account is not a guess any more.
    """
    programs = programs or (PUMP_PROGRAM, PUMP_FEE_PROGRAM)
    seeds = seeds or BCV2_CANDIDATES
    m = b58decode(mint)
    for prog in programs:
        for label, raw in seeds:
            for order in ((raw, m), (m, raw), (raw,)):
                try:
                    if find_program_address(list(order), prog) == target:
                        which = "pump.fun" if prog == PUMP_PROGRAM else "the fee program"
                        return 'PDA[%s] of %s' % (
                            ", ".join('"%s"' % label if x is raw else "mint" for x in order),
                            which)
                except Exception:
                    pass
    return ""


def global_pubkeys(g: dict) -> dict:
    """Every pubkey stored in Global, addressed by where it sits.

    An account a transaction passes that is not a PDA and not a program is very often just a
    VALUE out of this account — the fee recipient in a real buy was not the canonical one but
    one of the seven in `fee_recipients`, and the trailing account was one of the eight
    buyback recipients. Searching PDA seeds for those would never have found them, because
    they are not derived from anything.
    """
    out = {}
    for k in ("authority", "fee_recipient", "withdraw_authority", "set_creator_authority",
              "admin_set_creator_authority", "whitelist_pda", "reserved_fee_recipient"):
        if g.get(k):
            out[g[k]] = "global.%s" % k
    for k in ("fee_recipients", "reserved_fee_recipients", "buyback_fee_recipients"):
        for n, a in enumerate(g.get(k) or []):
            out.setdefault(a, "global.%s[%d]" % (k, n))
    return out


def known_buy_accounts(mint: str, user: str, g: dict) -> dict:
    """Every account in a buy this script can already name, so `trace` can show the rest."""
    bc = find_program_address([b"bonding-curve", b58decode(mint)], PUMP_PROGRAM)
    return {
        g["address"]: "global", g["fee_recipient"]: "fee_recipient", mint: "mint",
        bc: "bonding_curve", ata(bc, mint): "associated_bonding_curve",
        ata(user, mint): "associated_user", user: "user",
        SYSTEM_PROGRAM: "system_program", TOKEN_PROGRAM: "token_program",
        find_program_address([b"creator-vault", b58decode(user)], PUMP_PROGRAM):
            "creator_vault (if the creator is the buyer)",
        find_program_address([b"__event_authority"], PUMP_PROGRAM): "event_authority",
        PUMP_PROGRAM: "program",
        find_program_address([b"global_volume_accumulator"], PUMP_PROGRAM):
            "global_volume_accumulator",
        find_program_address([b"user_volume_accumulator", b58decode(user)], PUMP_PROGRAM):
            "user_volume_accumulator",
        find_program_address([b"fee_config", b58decode(PUMP_PROGRAM)], PUMP_FEE_PROGRAM):
            "fee_config",
        PUMP_FEE_PROGRAM: "fee_program",
    }


def _pump_instructions_in(tx) -> list:
    """Every pump.fun instruction in a transaction, top-level or reached through a CPI.

    Inner instructions matter more than top-level ones here. Most volume on this program
    arrives underneath a router, so a scan that reads only top-level instructions sees
    routers and reports that nothing is happening.
    """
    msg = tx["transaction"]["message"]
    loaded = (tx.get("meta") or {}).get("loadedAddresses") or {}
    # Static keys, then writable from tables, then readonly: the runtime's order, which is
    # what an instruction's indices mean.
    keys = (list(msg.get("accountKeys", []))
            + list(loaded.get("writable", [])) + list(loaded.get("readonly", [])))
    out = []

    def look(ix, where):
        try:
            prog = keys[ix["programIdIndex"]]
            data = b58decode(ix["data"])
            accs = [keys[i] for i in ix["accounts"]]
        except Exception:
            return
        if prog == PUMP_PROGRAM and len(data) >= 8:
            out.append({"disc": data[:8].hex(), "accounts": accs, "data": data, "where": where})

    for ix in msg.get("instructions", []):
        look(ix, "top level")
    for group in (tx.get("meta") or {}).get("innerInstructions", []) or []:
        for ix in group.get("instructions", []):
            look(ix, "CPI under instruction %d" % group.get("index", -1))
    return out


def cmd_trace(args):
    """What pump.fun is ACTUALLY being asked to do, read off the chain.

    THIS SHOULD HAVE EXISTED FIRST. Four required accounts were found by deriving from a
    published IDL, sending, and reading the error — a loop that only works when the IDL
    matches the program, and pump.fun's does not, in the repo or in the copy the program
    stores about itself. Then a scan for the `buy` instruction across 41 successful
    transactions found none at all, which is the more useful fact: the legacy instruction is
    not what anybody calls any more, so no amount of patching its account list was going to
    converge.

    So this counts what IS called, by discriminator, and then prints the accounts one real
    instance passed. A census first, because the question "which instruction should I be
    building" has to be answered before "what accounts does it take".
    """
    rpc = Rpc()
    g = read_global(rpc)
    if args.signature:
        sigs, source = [args.signature], "the transaction you named"
    elif args.mint:
        bc = find_program_address([b"bonding-curve", b58decode(args.mint)], PUMP_PROGRAM)
        source = "the bonding curve of %s" % args.mint
        sigs = [x["signature"] for x in
                rpc.send("getSignaturesForAddress", [bc, {"limit": args.limit}])
                if not x.get("err")]
    else:
        source = "pump.fun's own recent transactions"
        sigs = [x["signature"] for x in
                rpc.send("getSignaturesForAddress", [PUMP_PROGRAM, {"limit": args.limit}])
                if not x.get("err")]
    print("\n  looking at %s" % source)
    if not sigs:
        raise RuntimeError("no successful transactions found there")

    seen, examples, checked = {}, {}, 0
    for sig in sigs:
        tx = rpc.send("getTransaction",
                      [sig, {"encoding": "json", "maxSupportedTransactionVersion": 0,
                             "commitment": "confirmed"}])
        if not tx or (tx.get("meta") or {}).get("err"):
            continue
        checked += 1
        for ix in _pump_instructions_in(tx):
            seen[ix["disc"]] = seen.get(ix["disc"], 0) + 1
            examples.setdefault(ix["disc"], (sig, ix))
    if not seen:
        raise RuntimeError(
            "checked %d successful transaction(s) and none invoked pump.fun at all, at the\n"
            "  top level or under a CPI. Try a larger --limit." % checked)

    print("  %d transaction(s) checked. What they asked pump.fun to do:" % checked)
    for disc, n in sorted(seen.items(), key=lambda kv: -kv[1]):
        name = DISCRIMINATORS.get(disc, "(not an instruction any published IDL names)")
        print("    %4d x  %-16s %s" % (n, disc, name))

    want = args.instruction
    if want:
        pick = next((d for d in seen if DISCRIMINATORS.get(d) == want), None)
        if pick is None:
            raise RuntimeError("no transaction here called %r" % want)
    else:
        # Default to the busiest instruction that buys something.
        buyish = [d for d in seen if (DISCRIMINATORS.get(d) or "").startswith("buy")]
        pick = max(buyish or seen, key=lambda d: seen[d])

    sig, ix = examples[pick]
    accs = ix["accounts"]
    name = DISCRIMINATORS.get(pick, pick)
    names = IX_ACCOUNTS.get(name, [])
    print("\n  one real %s, %s" % (name, ix["where"]))
    print("  signature  %s" % sig)
    print("  data       %d bytes" % len(ix["data"]))
    print("  it passed %d accounts%s:"
          % (len(accs), "" if not names else
             ", and the IDL names %d of them" % len(names)))
    named = dict(zip(names, accs))
    mint = named.get("mint") or named.get("base_mint")
    user = named.get("user")
    # Derive what this script would have passed, and compare position by position. A name is
    # a guess; an address that matches a real transaction is not.
    mine = {}
    if name.endswith("_v2") or name in ("buy_v2", "buy_exact_quote_in_v2"):
        if mint and user:
            mine = derive_v2_accounts(mint, user, g, named.get("base_token_program",
                                                              TOKEN_PROGRAM),
                                      named.get("buyback_fee_recipient", g["fee_recipient"]))
    elif mint and user:
        mine = {k: v for v, k in known_buy_accounts(mint, user, g).items()}
    extra = []
    for n, a in enumerate(accs):
        label = names[n] if n < len(names) else "(past the IDL's list — a remaining account)"
        mark = ""
        if label in mine:
            mark = "  == mine" if mine[label] == a else "  != mine (%s)" % mine[label]
        if not mark or "!= mine" in mark:
            where = global_pubkeys(g).get(a)
            if where:
                mark = "  %s" % where
        if n >= len(names):
            extra.append((n, a))
        print("    %2d. %-44s %-38s%s" % (n, a, label, mark))
    if extra and mint:
        print("\n  accounts past the IDL's list, which is where the undocumented ones are:")
        for n, a in extra:
            inglobal = global_pubkeys(g).get(a, "")
            print("    %2d. %s  %s"
                  % (n, a, inglobal or solve_pda(a, mint) or "no candidate reproduces it"))
        print("\n  mint for these: %s" % mint)
    print()
    return 0


def cmd_program(args):
    """What an unidentified program id actually is, from the chain and nothing else.

    This exists because `launch` refused a transaction whose buy was routed through a program
    that is not pump.fun's and that no public source named. The useful answer to that is not a
    flag to skip the check — it is the four facts below, which come from the cluster itself:
    whether the id is even executable, which loader owns it, when the code was last deployed,
    and who can replace it. A program with a live upgrade authority can become different code
    after you read it, which matters more than what it does today.
    """
    rpc = Rpc()
    info = rpc.program_provenance(args.address)
    print()
    print("  address     %s" % args.address)
    print("  cluster     %s" % rpc.host)
    if not info["exists"]:
        print()
        print("  NO ACCOUNT AT THIS ADDRESS on %s." % rpc.host)
        print("  Nothing is deployed here. A transaction invoking it cannot succeed.")
        print()
        return 1
    known = KNOWN_PROGRAMS.get(args.address)
    print("  known to me %s" % (known if known else "NO — not on this launch's allowlist"))
    print("  executable  %s" % ("yes" if info["executable"] else "NO — this is data, not code"))
    print("  owner       %s" % info["owner"])
    if info.get("programdata"):
        print("  programdata %s" % info["programdata"])
    if info["slot"] is not None:
        print("  deployed    slot %d" % info["slot"])
    if info["authority_known"]:
        if info["authority"] is None:
            print("  upgradable  no — the authority is revoked and this code is frozen")
        else:
            print("  upgradable  YES, by %s" % info["authority"])
            print("              that key can replace this code after you have read it")
    print()
    if known:
        print("  This is a program the launch needs.")
        return 0
    print("  pump.fun publishes three programs and this is not one of them:")
    for a, what in sorted(PUMP_PUBLISHED.items()):
        print("      %-44s %s" % (a, what))
    print()
    print("  THIS IS NOT ONE OF THE SIX PROGRAMS A LAUNCH USES. Being deployed, being")
    print("  upgrade-frozen and being busy are not evidence that it is safe — every drainer")
    print("  on this chain is all three. Read it on an explorer, and if you cannot find out")
    print("  what it is from a source that is not the thing that handed you the transaction,")
    print("  do not sign.")
    print("      https://solscan.io/account/%s" % args.address)
    print()
    return 1


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
    # Against PUBLISHED addresses, not against this file's own output. The previous version
    # of this line asserted 33 ones because that is what the encoder produced, so the test
    # confirmed the bug rather than catching it.
    ok("the system program is 32 zero bytes and encodes to its real address",
       b58encode(bytes(32)) == "11111111111111111111111111111111", b58encode(bytes(32)))
    ok("and that address is the one in the program allowlist",
       b58encode(bytes(32)) in KNOWN_PROGRAMS)
    ok("one zero byte is one '1', not two", b58encode(b"\x00") == "1", b58encode(b"\x00"))
    ok("no bytes is no characters", b58encode(b"") == "")
    ok("a leading zero byte before real data keeps exactly one '1'",
       b58encode(b"\x00" + b"\x01" * 31)[0] == "1"
       and b58encode(b"\x00" + b"\x01" * 31)[1] != "1")
    ok("every published address in the allowlist round-trips through both directions",
       all(b58encode(b58decode(a)) == a for a in KNOWN_PROGRAMS))
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
    fake.sig_count = 2
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


def _structural_only(tx, payer: str, mint: str, rpc=None):
    """The half of verify_transaction that needs no cluster, so selftest can exercise it.

    `rpc` is optional and is used for one thing: resolving address lookup tables, which is the
    only part of "what does this transaction touch" that cannot be answered from the bytes.
    Without it a transaction that uses tables is REFUSED rather than waved through, because
    the accounts behind them are exactly the ones an attacker would put there.
    """
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
    # A v0 transaction hides most of its accounts behind lookup tables, and the old check
    # simply refused any. That reads as a security property and is not one: it fires on every
    # v0 transaction a real builder returns, whatever is in it, so the only thing it can teach
    # an operator is to stop reading. What matters is whether the hidden accounts can be
    # SHOWN. They are pulled from the chain here and folded into tx.resolved_keys, so the
    # program check below sees the whole transaction; only a table that cannot be read is a
    # refusal, and it says which one and why.
    if tx.lookups and rpc is None:
        add(False, "every account behind an address lookup table was resolved and shown",
            "%d table(s) and no cluster to resolve them against" % tx.lookups)
    elif tx.lookups:
        try:
            pulled = rpc.resolve_lookups(tx)
            add(True, "every account behind an address lookup table was resolved and shown",
                "%d table(s), %d account(s) pulled" % (tx.lookups, len(pulled)))
        except RuntimeError as e:
            add(False, "every account behind an address lookup table was resolved and shown",
                str(e))
    else:
        add(True, "no address-table lookups, so every account is named in the message itself")
    # A program id must be named in the message itself. The runtime resolves lookup tables
    # while loading the transaction and has to know which programs to load first, so it will
    # not follow a table to find one. Compiling the programs into the table produced a message
    # that parsed fine here and came back from the cluster as "failed to sanitize accounts
    # offsets correctly" — a message that names the symptom and not the rule. Checked here so
    # it is caught before a round trip, and stated as the rule it is.
    n_static = len(tx.account_keys)
    off = sorted({tx.keys[i["program_index"]] if i["program_index"] < len(tx.keys)
                  else "index %d" % i["program_index"]
                  for i in tx.instructions if i["program_index"] >= n_static})
    add(not off, "every program it invokes is named in the message, not reached through a table",
        ", ".join(off))
    progs = {tx.program_of(i) for i in tx.instructions}
    unresolved = sorted(x for x in progs if x.startswith("("))
    unknown = sorted(progs - set(KNOWN_PROGRAMS) - set(unresolved))
    add(not unresolved, "every program it invokes could be named at all",
        ", ".join(unresolved))
    # THE ALLOWLIST IS NOT A NUISANCE. A launch invokes six programs and they are all listed;
    # anything else is a transaction that does something nobody asked for. `program` prints
    # the provenance of an id this refuses, and the answer to a program you cannot identify
    # is not to add it here — it is to not sign.
    add(not unknown, "every program it invokes is one this launch needs",
        "unknown: " + ", ".join(unknown) + "\n"
        "       identify it before signing:  python3 pumpfun.py program " + (unknown[0] if unknown else ""))
    # The wire must carry exactly as many signature slots as the message requires. A mismatch
    # means the bytes that get SENT are not the bytes that were simulated — the message shifts
    # by 64 bytes per missing slot and every check above was performed on a different
    # transaction from the one the cluster would run.
    add(tx.sig_count == tx.num_required_signatures,
        "the wire has exactly one signature slot per required signer",
        "%d slots for %d signers" % (tx.sig_count, tx.num_required_signatures))
    return checks


def build_parser():
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
    s.add_argument("--keypair", default=None,
                   help="path to a Solana CLI keypair JSON file. Prompted for if omitted. A "
                        "PATH — never a key; nothing here accepts key material typed or pasted")
    s.add_argument("--dev-buy", type=float, default=None, dest="dev_buy",
                   help="SOL to spend on the opening buy. Prompted for if omitted, and there "
                        "is no default either way because this is money — see `size`")
    s.add_argument("--name", required=True)
    s.add_argument("--symbol", required=True)
    s.add_argument("--image", required=True, help="path to the token image")
    s.add_argument("--description", default=None,
                   help="the coin page's body. REQUIRED and permanent. Use @path to read it "
                        "from a file, which is what you want for anything with newlines")
    s.add_argument("--twitter", default="")
    s.add_argument("--telegram", default="")
    s.add_argument("--website", default="")
    s.add_argument("--slippage", type=int, default=10, help="percent (default 10)")
    s.add_argument("--priority-fee", type=float, default=0.0005, dest="priority_fee")
    s.add_argument("--reserve", type=float, default=0.03,
                   help="SOL budgeted for rent, pump.fun's creation fee and priority fees on "
                        "top of the dev buy. An ESTIMATE (default 0.03); the dry-run "
                        "simulation reports the real number")
    s.add_argument("--headroom", type=float, default=0.5,
                   help="SOL the launch wallet may hold above the dev buy before this refuses "
                        "to sign with it (default 0.5)")
    s.add_argument("--yes", action="store_true",
                   help="skip the final confirmation. For a scripted launch; if you are typing "
                        "this by hand you want to read the summary instead")
    s.add_argument("--builder", choices=["direct", "pumpportal"], default="direct",
                   help="who assembles the transaction. 'direct' builds it here against "
                        "pump.fun's own program from their published IDL, so nothing "
                        "third-party is in the signing path; 'pumpportal' asks their API, "
                        "which is what routed a buy through an unidentified program")
    s.add_argument("--dry-run", action="store_true",
                   help="build and verify, then STOP. Nothing is signed, nothing is sent, and "
                        "no metadata is published")
    s.add_argument("--mint-keypair", default=None, dest="mint_keypair",
                   help="use a pre-ground mint keypair file, e.g. from "
                        "'solana-keygen grind --ends-with pump:1'")
    s.add_argument("--grind", default=None,
                   help="grind a mint address ending in this suffix, in-process. Refuses "
                        "anything long enough to be slow and names the native tool instead")

    s = sub.add_parser(
        "resume", help="finish or safely retry a launch whose outcome was not seen",
        epilog="Checks whether the mint already exists BEFORE doing anything, so this can "
               "never create a second token. This is the command to run after a timeout, a "
               "crash, or a send that errored — never 'launch' again.")
    s.set_defaults(fn=cmd_resume)
    s.add_argument("--keypair", required=True)
    s.add_argument("--record", required=True, help="the launch-<mint>.json written before send")
    s.add_argument("--slippage", type=int, default=None,
                   help="override the slippage the launch used (default: whatever the record says)")
    s.add_argument("--priority-fee", type=float, default=None, dest="priority_fee",
                   help="override the priority fee the launch used (default: from the record)")

    s = sub.add_parser(
        "publish", help="put the contract address on the website, after reading it back")
    s.set_defaults(fn=cmd_publish)
    s.add_argument("mint", nargs="?", default=None)
    s.add_argument("--record", default=None,
                   help="the launch record to take the mint from, so it is never typed")
    s.add_argument("--write", action="store_true", help="actually edit the pages")

    s = sub.add_parser("watch", help="who actually bought, from public data")
    s.set_defaults(fn=cmd_watch)
    s.add_argument("mint")
    s.add_argument("--minutes", type=int, default=5)
    s.add_argument("--limit", type=int, default=200)

    s = sub.add_parser("table", help="create the lookup table a launch needs to fit")
    s.add_argument("--keypair", required=True)
    s.add_argument("--priority-fee", type=float, default=0.0005,
                   help="SOL. A table transaction that pays nothing is one validators may "
                        "drop, which is exactly what happened the first time")
    s.add_argument("--yes", action="store_true")
    s.set_defaults(fn=cmd_table)
    s = sub.add_parser("trace", help="the accounts a REAL successful buy passed, from the chain")
    s.add_argument("--mint", help="any pump.fun token that is currently trading")
    s.add_argument("--signature", help="a specific transaction instead")
    s.add_argument("--limit", type=int, default=60)
    s.add_argument("--instruction", help="show this one instead of the busiest buy")
    s.set_defaults(fn=cmd_trace)
    s = sub.add_parser("idl", help="a program's IDL, read from the chain rather than a repo")
    s.add_argument("address")
    s.add_argument("--out", help="write the whole IDL here")
    s.add_argument("--error", type=int, help="explain this error code")
    s.add_argument("--instruction", help="show this instruction's accounts, in order")
    s.set_defaults(fn=cmd_idl)
    s = sub.add_parser("program", help="what an unidentified program id is, from the chain")
    s.add_argument("address")
    s.set_defaults(fn=cmd_program)
    sub.add_parser("size", help="what a dev buy actually buys").set_defaults(fn=cmd_size)
    sub.add_parser("selftest", help="against published vectors").set_defaults(fn=cmd_selftest)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    # @file for the description, so a paragraph does not have to survive shell quoting — and
    # so what gets pinned is a file you can read back and diff, not something retyped.
    d = getattr(args, "description", None)
    if isinstance(d, str) and d.startswith("@"):
        args.description = Path(d[1:]).expanduser().read_text().strip()
    elif d is None and getattr(args, "fn", None) is cmd_launch:
        raise SystemExit(
            "\n  --description is required. It is the coin page's whole body and it cannot be\n"
            "  edited after the create. Write it in a file and pass @that file:\n"
            "      python3 pumpfun.py launch --description @description.txt …\n")

    if not getattr(args, "fn", None):
        p.print_help()
        return 0
    try:
        return args.fn(args) or 0
    except (RuntimeError, ValueError, OSError) as e:
        # OSError too: a missing --image or --record is an ordinary mistake and deserves one
        # line, not a traceback. RuntimeError covers LaunchFailed, which subclasses it.
        print("\n  %s\n" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
