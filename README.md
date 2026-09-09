# $SNOOZE

Snooze Bear, on Solana, launched through pump.fun. Two things live here:

- **`web/`** — the site. One page: the contract address, buy, sell. Served at
  [snoozebear.xyz](https://snoozebear.xyz).
- **`pumpfun.py`** — the launch script. One file, standard library only, no pip install.

**[`LAUNCH.md`](LAUNCH.md) is the runbook.** Read it before you spend anything.
**[`description.txt`](description.txt)** is the coin page's body text — it lives in the repo so
it is reviewable and diffable rather than retyped into a shell, and `--description @that file`
is how it reaches the launch.

```
python3 pumpfun.py size          # what a dev buy actually buys
python3 pumpfun.py selftest      # 33 checks against published vectors
python3 pumpfun.py --help
sh test/run.sh                   # the whole test suite
```

---

## The site

`web/index.html`, and there is nothing else. It shows the contract address, copies it, and sends
you to pump.fun to buy or sell. It holds no liquidity, takes no fee, connects to no wallet and
cannot send a transaction — pump.fun has the liquidity and the trading UI, and a worse copy of
that in front of it would help nobody.

The address is not typed into the page by hand. `pumpfun.py publish` writes it from the launch
record after reading the account back off the chain, and **refuses to overwrite a different
address that is already published** — filling a blank and replacing a live value are different
events and only the first one happens automatically.

The one thing the page insists on: **a Solana address has no checksum.** An EVM address carries
EIP-55 capitalisation, so a mistyped character is detectable before you send. Base58 carries
nothing, so a typo that lands on a real account is indistinguishable from the address you meant.
Copy it from the page. Never retype it and never take it from a screenshot.

## The launch script

Create the token and take the first slice **in one transaction**. Snipers buy in the block the
mint is created in — you cannot out-race them and this does not try. In one transaction there is
no gap to occupy, so the first buy is yours by construction rather than by winning a race.

What it refuses, and these are refusals rather than gaps:

- **No child wallets.** Splitting the opening buy across wallets you own exists to make the
  top-holders view look distributed when one person holds the float. Bundle checkers and bubble
  maps find it in seconds and *bundled* does not come off. There is no flag for it and the test
  suite asserts none exists.
- **No self-trading.** Selling from wallets you control does not remove a sniper — by the time
  you sell they already hold, and your sell is their cheaper re-entry. What it does is
  manufacture volume, which makes the person on the other side of it the product.
- **`--dev-buy` has no default.** 1 SOL is 3.2% of the float, 1.5 is 4.8%, 2.0 starts reading as
  dev-owned. There is no size that is both meaningful and invisible, so the script prints the
  table and makes you choose.

**It holds a private key, and that is the one place the rules are narrower rather than absent.**
Solana has no browser-signing path for this, so a script that submits a transaction must sign
it. So: read from a **file** and never an argument, never an environment variable, never a
prompt; the halves must agree; a world-readable key file is refused; and **a wallet holding more
than the launch needs is refused outright**, because 40 SOL is not headroom, it is the wrong
file.

**Nothing is signed blind.** pump.fun's builder composes the transaction, so it is taken apart
first — fee payer, signer set, every program invoked, no address-table lookups — and then
**simulated against the live cluster** to see what your balance actually does. That last check
needs no instruction layout at all: an encoding nobody here can decode still cannot move more
lamports than the simulation says it moves. `--dry-run` stops there.

## Bugs it shipped with, and how they were found

None of these were findable by reading, and every one would have cost the launch:

1. **base58 encoded the System Program as 33 `1`s instead of 32.** That address is in every
   transaction that creates an account — every launch — so the verifier would have called it an
   UNKNOWN PROGRAM and **refused the correct transaction, every time.** It survived because the
   self-test asserted the buggy output: the assertion was written to match the implementation
   instead of to match base58.
2. **The confirmation waited at `confirmed` and the read-back queried the default, `finalized`**,
   which lags ~13 blocks. A launch that had *just succeeded* read back as zero tokens and printed
   "THE BUY DID NOT LAND" — a state that cannot exist, since a Solana transaction is atomic. The
   next move would have been a second token. Every read names its commitment now.
3. **The funding gate asked for the dev buy and nothing else** — no rent, no fees. An
   exactly-funded wallet passed, then failed on chain *after* the metadata was permanently pinned.
4. **`watch` called the wrong wallet the creator.** `getSignaturesForAddress` returns
   newest-first, so taking one page and reversing it gave the oldest of the newest 200. It pages
   back to the create now.
5. **`publish` referenced an undefined `HERE` and died with a `NameError`** before reading
   anything — on the one command whose entire job is launch day.
6. **The confirmation loop caught its own verdict.** It wrapped the RPC calls in
   `except RuntimeError` so a transient network failure would not abandon a transaction in
   flight — but "it landed and reverted" was raised as a `RuntimeError` too, so the loop caught
   its own exception, printed it as `(rpc hiccup: … — still watching)`, and went round again.
   **Forever**, on the one outcome where the operator most needs it to stop. It has its own
   exception type now, and only the RPC calls are inside the guard.
7. **`resume` could never rebuild.** When a blockhash expired with nothing on chain it left the
   dead signature in the record, so every subsequent `resume` re-checked a transaction that
   could never land and reported the same dead end instead of resending. The signature is
   cleared now.
8. **The verifier's fee ceiling was below the script's own cost estimate** — 0.02 SOL against a
   `--reserve` of 0.03 for exactly the same costs. A correct launch failed its own verification.
9. **The address only existed inside JavaScript.** With JS off or blocked — an in-app webview
   from X or Telegram, a content blocker, Brave on strict — the canonical page for a launched
   token said "Not launched yet" and Buy pointed at pump.fun's homepage. The address is in the
   markup now and `publish` rewrites that line.
10. **`aria-disabled` does not make an anchor inert.** Tab, Enter, and a new tab opened on
    pump.fun's homepage with no token. The buttons have no `href` until one is published.
11. **The site said "no allocation"** while the launch takes 3–5% of the float for the creator
    in the create transaction. One false sentence on the page a buyer checks against Solscan.
12. **`web/bg.png` was a WebP file**, served as `image/png` under `X-Content-Type-Options:
    nosniff`.
13. **The test suite went red the moment the address was published.** Both publish tests seeded
    their fixture by copying the live `web/`, so once the real page carried an address the
    fixture started pre-published and the test's own dry publish tripped `cmd_publish`'s
    overwrite refusal as an *uncaught* exception — killing the run at LAUNCH.md step 7, in the
    window the runbook calls minutes long, with a traceback reading "Refusing to overwrite it"
    that looks exactly like the publish having corrupted the page. **This was the second time
    this file had that bug**: an assertion was hardened for it and the fixture thirty lines
    below was missed. The suite now passes identically published or not, and there is a test
    that says so.

Two more were closed by design. **Nothing reached disk**, so a crash lost the mint keypair, the
signature and the metadata URI at once, and the only "recovery" was a command that mints a twin —
hence a launch record written *before* the send, and a `resume` that checks whether the mint
exists before doing anything. And **`--dry-run` uploaded the real metadata before stopping**,
publishing the name and image permanently before the launch existed.

## What used to be here

This repository was a Base (EVM) project: Solidity contracts implementing a sell haircut, a
20%/day transfer cap and a hold-to-earn reward token, a seven-step deploy sequence, and nine
pages describing them. **None of it can exist on a pump.fun token** — `create` takes name,
symbol, URI and creator, pump.fun allocates the mint itself, and the creator holds neither mint
nor freeze authority afterwards. There is no transfer path to extend and no extension to
initialise.

It is all removed rather than left to rot into false claims about a token that works differently.
It is in the git history if it is ever wanted.

## Keys never go in this directory

`pumpfun.py` writes a launch record beside your keypair, and **it contains the mint's secret
key** — it has to, because re-sending with the same mint is a retry and re-sending with a new
one is a second token. A Solana CLI keypair file contains the launch wallet's key outright.

Inside a git repository, one `git add -A` publishes either to GitHub, where it is scraped in
minutes. So `LAUNCH.md` puts them in `~/.snooze`, `.gitignore` covers the predictable filenames
as a **backstop rather than a plan** — a pattern only catches names somebody thought of, and
`solana-keygen grind` writes a file named after an address nobody can predict — and the script
warns at write time if a record ever lands inside a repository.

This was a real hole until it was tested for: `launch-*.json` was not ignored, and neither were
`launch.json` or `id.json`, which are what `solana-keygen new` writes by default.

## Tests

```
sh test/run.sh
```

**143 assertions, no network touched, nothing to install** (plus the script's own 33-check
`selftest`, which is what a downloaded copy can run on its own). They cover the arithmetic against
RFC 8032 and published base58 vectors, every way a keypair file is refused, the transaction
decoder against transactions built byte by byte, the publish flow end-to-end against the real
page, that the site says what it must and mentions no chain it is not on, the page's own script
executed against a stub DOM so a broken link is a failed test rather than a dead button on
launch day, and — the one with the worst consequence — that a launch record can never be
committed.

`node` is used for the page smoke test only. Everything else is Python and the standard library.
