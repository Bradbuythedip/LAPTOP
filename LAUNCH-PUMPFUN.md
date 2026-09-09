# Launching $SNOOZE on pump.fun

The Base sequence in [`deploy/scripts/README.md`](deploy/scripts/README.md) is seven steps
because seven things become permanent. This one is shorter and the permanence is worse: **on
pump.fun almost everything is decided in a single transaction, and none of it can be edited
afterwards.** There is no `validate()` to call for free first, no step 4 that sends nothing,
and no freeze at the end — because there was never a key to give up.

Each step below says what it sends, what it makes permanent, and what has to be true before
it can run at all. Read the whole thing once before doing step 1.

---

## What this launch is not

**None of the three rules exist on a pump.fun token, and that is not a configuration choice.**

`create` takes four arguments — name, symbol, URI, creator — and there is no parameter for
supply, decimals, authorities, transfer hooks or fees. Rules 1 and 2 are enforced *inside*
`Snooze._move` by taking a haircut and by reverting; a pump.fun mint has no transfer path the
launcher can extend. Rule 3's clock is storage written inside that same function, and after
the create the launcher holds neither mint nor freeze authority, so nothing could be minted to
pay it even if it accrued.

So a pump.fun launch is **a plain SPL token on a bonding curve**. No haircut, no daily cap, no
`$DREAM`. `contracts/` does not deploy. `web/snooze.html` and `web/dream.html` describe a token
that will not exist, and `web/index.html` still says so on its front page.

That is a decision, not an oversight, and it is worth taking deliberately:

| | Base (`snooze.py`) | pump.fun (`pumpfun.py`) |
| --- | --- | --- |
| the three rules | all three, in the token | none, and none are possible |
| $DREAM | on-chain, exact | only as an off-chain airdrop (below) |
| liquidity | you seed it | the curve, immediately |
| audience | has to be brought | already there |
| time to live | six transactions and a grind | one transaction |

**If Rule 3 matters, it survives the move — but only as a snapshot airdrop.** A pump.fun sell
is reliably distinguishable from a wallet-to-wallet transfer in public history, because the
counterparty of a curve trade is the bonding curve's own token account. So held-seconds can be
computed off-chain from public data exactly the way `dreamBetween` computes them on-chain, and
paid out by a Merkle claim. It is weaker in one specific way and the site must say so: an
on-chain rule cannot be quietly not-run, and an indexer can.

---

## 0 · Before anything, decide the dev buy

```
python3 pumpfun.py size
```

pump.fun's curve opens at ~30 virtual SOL, so a buy of `R` takes `R/(30+R)` of the float. The
token side cancels — this depends on `R` alone.

| dev buy | share of the float | |
| ---: | ---: | --- |
| 0.5 SOL | 1.64% | clean |
| **1.0 SOL** | **3.23%** | **clean** |
| **1.5 SOL** | **4.76%** | **clean, and the top of the band** |
| 2.0 SOL | 6.25% | starts reading as dev-owned |
| 5.0 SOL | 14.29% | flagged |

There is no size that is both a meaningful position and invisible.

**Permanent:** the dev buy is spent in the launch transaction and there is no undo.

---

## 1 · A fresh wallet, holding only the launch

```
solana-keygen new -o ./launch.json
chmod 600 ./launch.json
# fund it with the dev buy + ~0.05 SOL for fees and rent. Nothing else, ever.
```

`pumpfun.py launch` reads the balance first and **refuses to sign with a wallet holding more
than the launch needs**, because that is evidence of the wrong file rather than of headroom.
`--headroom` moves the line; the default is 0.5 SOL above the dev buy.

**Blocked by:** nothing. **Permanent:** nothing yet.

---

## 2 · Grind the mint address

```
solana-keygen grind --ends-with pump:1
chmod 600 ./<the file it writes>.json
```

Almost every pump.fun token anybody has seen ends in `pump`, because pump.fun's own frontend
grinds for it. **The suffix proves nothing** — it is four base58 characters and scammers grind
it precisely because people read it as a credential — but *not* having it makes your address
look unlike every other token on the site at the exact moment somebody is deciding in two
seconds whether the address they were sent is real.

`pumpfun.py` will grind in-process with `--grind`, and **refuses** past four characters: pure
Python does ~570 keypairs/second, so `pump` would take about 5.6 hours against seconds for the
native tool. It prints the arithmetic rather than starting the loop.

**Blocked by:** nothing. **Permanent:** nothing — an unused ground keypair costs nothing.

---

## 3 · The endpoint

```
export SOLANA_RPC='https://…your-provider…/your-key'
```

From the environment and nowhere else. There is no `--rpc` flag: an endpoint on a command line
lands in your shell history and in `/proc/<pid>/cmdline`. **A keyed URL is a credential — it
never goes in a file in this repository**, and nothing here ever prints it back; errors carry
the host only.

`launch` **refuses to run against the public endpoint**, which is rate-limited and drops
transactions under load.

---

## 4 · Rehearse

```
python3 pumpfun.py launch \
  --keypair ./launch.json --mint-keypair ./<ground>.json \
  --dev-buy 1.0 --name "Snooze Bear" --symbol SNOOZE \
  --image ./web/snooze.png --website https://snoozebear.xyz \
  --dry-run
```

Builds the real transaction, decodes it, **simulates it against the live cluster**, prints
exactly what your balance does, and stops. Nothing is signed, nothing is sent, and **no
metadata is uploaded** — the upload is permanent and public, so a rehearsal that pinned the
name and image would publish the launch before the launch existed.

Read the verification block. It refuses if the fee payer is not you, if anything but you and
the mint must sign, if it invokes a program this launch does not need, if it hides accounts
behind an address-table lookup, or if it spends more than you authorised.

**Permanent:** nothing. Run this at least once.

---

## 5 · Launch

Same command, without `--dry-run`.

**`--website https://snoozebear.xyz` is hop 1 of the verification loop and it is permanent.**
The metadata is pinned before the token exists and cannot be edited afterwards. A copycat can
put your name and your picture on their token; they cannot put their address on your site. Get
this field right now or it is wrong forever.

What happens, in order:

1. the metadata is pinned to IPFS — **permanent and public from this moment**
2. the transaction is built, decoded, verified and simulated
3. **a launch record is written to disk before a byte is sent** — `launch-<mint>.json`, mode
   0600, containing the mint keypair. That key has no authority after the create; its only
   value is that re-sending with the *same* mint is a retry and re-sending with a new one is a
   second token
4. it is signed and sent
5. it waits on the **blockhash**, not on a clock — a timer cannot tell "expired, never landed"
   from "landed and I did not see it", and guessing wrong in the second direction mints a twin
6. it reads back at the same commitment it waited at, and prints your cost basis

**Permanent:** the mint address, the metadata URI, the name, the symbol, the creator, and the
dev buy. All of it, in one transaction, with no edit path.

### If anything goes wrong, do not run `launch` again

```
python3 pumpfun.py resume --keypair ./launch.json --record ./launch-<mint>.json
```

`resume` checks whether the mint already exists **before doing anything**, so it cannot create
a second token. `launch` refuses to start at all while a record exists.

Two things the previous version of this script got wrong, both of which would have caused a
double launch on a *successful* launch:

- it waited at `confirmed` and then read back at the default `finalized`, which lags by ~13
  blocks — so a launch that had just succeeded read back as zero tokens
- it then printed "THE BUY DID NOT LAND", which **describes a state that cannot exist**: a
  Solana transaction is atomic, so the create and the buy both happened or neither did

---

## 6 · Publish the CA, immediately

```
python3 pumpfun.py publish --record ./launch-<mint>.json          # says what it would write
python3 pumpfun.py publish --record ./launch-<mint>.json --write
node tools/stamp.mjs
git commit -am "launch: publish the contract address" && git push
```

**The window is minutes.** Copycats appear within them, and the only defence is being the first
published address. This project's own README records 14 copycat LAPTOP tokens across four
chains trading $6.9M within an hour of the launch being reported.

`publish` never takes an address by hand when a record exists. It reads the account off the
chain first, refuses it if it is not a token mint, warns if the mint authority is still set,
and **refuses to overwrite a different address that is already published** — filling a blank
and replacing a live value are different events and only the first happens automatically.

**Do not publish a predicted mint before the launch lands.** The address is knowable in advance
on Solana — the mint is a keypair you generated — and that is exactly the trap: publish it
early and a failed launch leaves the canonical page pointing at an account that does not exist,
which is unrecoverable in reputation terms.

---

## 7 · Watch what actually happened

```
python3 pumpfun.py watch <mint> --minutes 5
```

Public data only, and layout-independent: it reads token-balance deltas out of transaction
metadata rather than decoding pump.fun's instructions, so it cannot be wrong about a trade
because a program changed its encoding. It reports distinct buyers, how fast the first one
after you arrived, and what share the top ten took.

**Concentration is a fact, not a verdict.** A high top-10 share this early is usually snipers
rather than anything you did. What it tells you is how much of the float is in hands looking
for an exit inside the hour.

---

## What is still unverified, and must be checked before this is relied on

Everything below was researched and could **not** be confirmed from a machine with no cluster
access. Each one should be checked against a real transaction — a devnet rehearsal, or the
smallest possible mainnet launch — before this runbook is trusted:

- the exact instruction sequence inside pump.fun's `create`, including whether mint authority
  is revoked in the create transaction or at graduation. pump.fun's program source is not
  published; only an IDL and prose.
- whether `create` or `create_v2` (Token-2022) is used by the builder this script calls, and
  what that changes.
- whether the Metaplex update authority for the metadata is genuinely beyond the creator's
  reach after create — the "permanent metadata" claim in hop 1 of the verification loop rests
  on it.
- whether pump.fun's IPFS endpoint is publicly enumerable, which would determine whether step
  5's pin leaks the launch before it happens.
- that the `pump` suffix comes from a frontend vanity grind rather than from the program.

**None of this has been run against mainnet.** The signing, decoding and arithmetic are checked
against RFC 8032 vectors and against transactions built byte by byte in `test/`. The live path
is not, and it moves real money.
