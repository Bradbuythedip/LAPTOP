# Launching $SNOOZE

Eight steps. Each one says what it sends, what it makes permanent, and what has to be true
before it can run. **Almost everything is decided in a single transaction and none of it can be
edited afterwards**, so read this once before doing step 1.

```
python3 pumpfun.py size          # what a dev buy actually buys
python3 pumpfun.py selftest      # 33 checks against published vectors
python3 pumpfun.py --help
```

---

---

## 0 · If a check fails, nothing was signed

`launch` verifies the transaction before a key touches it, and a failure means it stopped —
no token, no spend, nothing to undo. Two of those checks are about what the transaction
actually contains:

**"every program it invokes is one this launch needs"** — a create+buy uses six programs and
they are all on the allowlist in `pumpfun.py`. Anything else means the builder returned a
transaction that does something nobody asked for. Find out what the id is before deciding:

```
python3 pumpfun.py program <the id it printed>
```

That reports, from the cluster and not from anybody's documentation: whether the address holds
executable code at all, which loader owns it, the slot it was last deployed at, and **who can
upgrade it**. A live upgrade authority means the code can be replaced after you have read it.

Being deployed, being frozen and being busy are not evidence of anything. If you cannot
identify a program from a source that is *not* the service that handed you the transaction,
do not sign it. Adding the id to `KNOWN_PROGRAMS` to get past the refusal is the one thing
that turns this check into decoration.

**"every account behind an address lookup table was resolved and shown"** — a v0 transaction
names most of its accounts by index into an on-chain table. The script fetches those tables
and folds the addresses in, so the program check above sees the whole transaction. This fails
only when a table cannot be read, which is its own answer.


## 1 · Pick the dev buy

pump.fun's curve opens at ~30 virtual SOL, so a buy of `R` SOL takes `R/(30+R)` of the float.
The token side cancels — this depends on `R` alone.

| dev buy | share of the float | |
| ---: | ---: | --- |
| 0.5 SOL | 1.64% | clean |
| **1.0 SOL** | **3.23%** | **clean** |
| **1.5 SOL** | **4.76%** | **top of the band** |
| 2.0 SOL | 6.25% | starts reading as dev-owned |
| 5.0 SOL | 14.29% | flagged |

There is no size that is both a meaningful position and invisible. `--dev-buy` is required and
has no default, because it is money.

---

## 2 · A fresh wallet, holding only the launch

```
mkdir -p ~/.snooze && chmod 700 ~/.snooze
solana-keygen new -o ~/.snooze/launch.json
chmod 600 ~/.snooze/launch.json
# fund it with the dev buy + ~0.03 SOL. Nothing else, ever.
```

**Not in this directory.** The launch record written in step 6 sits beside the keypair and
contains the mint's secret key; a keypair file contains the wallet's outright. Inside the repo,
one `git add -A` publishes either to GitHub, where it is scraped in minutes. `.gitignore` covers
the predictable names as a backstop, but `solana-keygen grind` writes a file named after an
address nobody can predict — so keep them out of the tree instead of relying on a pattern.
`pumpfun.py` warns if it ever writes a record inside a git repository.

`launch` reads the balance first and **refuses to sign with a wallet holding more than the
launch needs** — that is evidence of the wrong file, not of headroom.

**Permanent:** nothing yet.

---

## 3 · Grind the mint address

```
cd ~/.snooze && solana-keygen grind --ends-with pump:1
chmod 600 ~/.snooze/<the file it writes>.json
```

Almost every pump.fun token ends in `pump`, because pump.fun's frontend grinds for it. **The
suffix proves nothing** — it is four characters anyone can grind, and scammers grind it because
people read it as a credential — but not having it makes your address look unlike every other
token on the site at the moment somebody decides in two seconds whether it is real.

`pumpfun.py --grind` will do it in-process and **refuses past four characters**: pure Python
does ~570 keypairs/second, so `pump` is 5.6 hours against seconds for the native tool.

**Permanent:** nothing. An unused ground keypair costs nothing.

---

## 4 · The endpoint

```
export SOLANA_RPC='https://…your-provider…/your-key'
```

From the environment and nowhere else. There is no `--rpc` flag: an endpoint on a command line
lands in shell history and in `/proc/<pid>/cmdline`. **A keyed URL is a credential and never
goes in a file in this repo.** Nothing here prints it back; errors carry the host only.

`launch` refuses to run against the public endpoint, which is rate-limited and drops
transactions under load.

---

## 5 · The metadata

This is the coin page: the name, the ticker, the picture and the body text. **The create
instruction writes its URI into the mint and the creator cannot edit it afterwards.** There is
no later.

`description.txt` in this repo is the copy, so it is reviewable and diffable rather than retyped
into a shell. Edit it there and pass `@description.txt` — `@` reads a file, which is what you
want for anything with newlines.

The script refuses to launch without it, and checks the limits that bite:

| field | limit | why |
| --- | --- | --- |
| name | **32 bytes** | Metaplex's struct. Over it, truncated on chain, permanently |
| symbol | **10 bytes** | same |
| description | must not be empty | it is the page body, and blank reads as a bot launch |
| website | must not be empty | the only field pointing back at a page you control |

**Bytes, not characters.** An emoji is four, so a name that looks short can be over.
`Snooze Bear` is 11 bytes and `SNOOZE` is 6 — both fine.

### The image

`web/token.jpg` — 1408×1408, full resolution, pinned to IPFS by the launch.

**Everything the site shows is the same picture**, generated from that one file: the hero, the
favicon, the link-preview image. That is not tidiness. A buyer who is being careful compares
the picture on pump.fun to the picture on the site, and two different bears is exactly the
signal a copycat produces.

To change the artwork, replace `web/token.jpg` and run `python3 tools/art.py --write`. **Do not
upload over one of the derived images** — that leaves the site and the token showing different
pictures, and `test/run.sh` will fail on it.

---

## 6 · Rehearse

**`--keypair` and `--dev-buy` are prompted for if you leave them out**, so the short form is
fine and the summary before the irreversible step is the same either way. The keypair prompt
asks for a **path**; nothing here accepts a pasted private key, and it says so if one arrives.

```
python3 pumpfun.py launch \
  --keypair ~/.snooze/launch.json \
  --mint-keypair ~/.snooze/<ground>.json \
  --dev-buy 1.0 \
  --name "Snooze Bear" \
  --symbol SNOOZE \
  --description @description.txt \
  --image ./web/token.jpg \
  --website https://snoozebear.xyz \
  --twitter https://x.com/snoozebearxyz \
  --dry-run
```

Builds the real transaction, decodes it, **simulates it against the live cluster**, prints what
your balance actually does, and stops. Nothing signed, nothing sent, and **no metadata
uploaded** — the upload is permanent and public, so a rehearsal must not publish the launch
before the launch exists.

It refuses if the fee payer is not you, if anything but you and the mint must sign, if it
invokes a program this launch does not need, if it hides accounts behind an address-table
lookup, or if it spends more than you authorised.

**Permanent:** nothing. Do this at least once.

---

## 7 · Launch

Same command without `--dry-run`.

**`--website https://snoozebear.xyz` is permanent.** The metadata is pinned before the token
exists and cannot be edited after. A copycat can put your name and picture on their token; they
cannot put their address on your site. Get it right now or it is wrong forever.

In order: metadata is pinned → the transaction is built, verified and simulated → **a launch
record is written to disk before a byte is sent** → it is signed and sent → it waits on the
**blockhash, not a clock** → it reads back and prints your cost basis and the mint.

Before it uploads, it prints the metadata back at you with byte counts. **Read it.** That is the
last moment any of it can change.

**Permanent:** the mint address, the metadata URI, the name, the symbol, the creator and the
dev buy. All of it, in one transaction, with no edit path.

### If anything goes wrong, do not run `launch` again

```
python3 pumpfun.py resume --keypair ~/.snooze/launch.json \
    --record ~/.snooze/launch-<mint>.json
```

`resume` checks whether the mint already exists **before doing anything**, so it cannot create a
second token. `launch` refuses to start at all while a record exists.

A timeout is not a failure. Only an expired blockhash with no signature on chain means it never
landed, and that is what `resume` establishes rather than assumes.

---

## 8 · Publish the contract address

```
python3 pumpfun.py publish --record ~/.snooze/launch-<mint>.json          # dry run
python3 pumpfun.py publish --record ~/.snooze/launch-<mint>.json --write
git add web/index.html && git commit -m "publish the contract address" && git push
```

**The window is minutes.** Copycats appear inside it and the only defence is being the first
published address.

`publish` never takes the address by hand when a record exists. It reads the account off the
chain first, refuses it if there is no account or it is not a token mint, warns if the mint
authority is still set, and **refuses to overwrite a different address that is already
published**.

**Do not publish before the launch lands.** The mint address is knowable in advance — it is a
keypair you generated — and that is the trap: publish early and a failed launch leaves your
canonical page pointing at nothing.

---

## 9 · Watch

```
python3 pumpfun.py watch <mint> --minutes 5
```

Public data only. It reads token-balance deltas out of transaction metadata rather than decoding
pump.fun's instructions, so it cannot be wrong about a trade because a program changed its
encoding. Distinct buyers, how fast the first one after you arrived, what share the top ten took.

**Concentration is a fact, not a verdict.** A high top-10 share this early is usually snipers.

---

## Not verified — check before you rely on this

No Solana cluster is reachable from where this was written, so the following are from
documentation and secondary sources. Settle each with a devnet rehearsal or a `--dry-run`
against a real endpoint:

- whether mint and freeze authority are actually null after `create`
- whether the metadata update authority is genuinely beyond the creator's reach — the "permanent
  website field" in step 6 rests on it
- whether the builder calls `create` (SPL) or `create_v2` (Token-2022)
- that `VIRTUAL_SOL = 30` is still the opening reserve, which the step 1 table depends on
- that the six program ids in `KNOWN_PROGRAMS` still cover a current create+buy — **a stale one
  here means the verifier refuses the correct transaction on launch day**
- that the coin page is `pump.fun/coin/<mint>`

**None of this has run against mainnet.** The signing, decoding and arithmetic are checked
against RFC 8032 and against transactions built byte by byte in `test/`. The live path is not,
and it moves real money.
