# LAPTOP tooling (Base)

On-chain tooling built while tracing the `$LAPTOP` token before its Sept 9, 2026 launch on Base.

Two halves:

- **`web/`** — two read-only tools for people who are about to buy, at
  [totalworlddomination.xyz](https://totalworlddomination.xyz). One self-contained HTML file each,
  no wallet, no transactions: `index.html` answers *is this the right contract*, `size.html`
  answers *what does my size actually get me*.
- **`*.py`** — the tracing and execution tooling: find the pools, watch for the first real
  liquidity, execute a Uniswap v4 swap, execute a classic V2/V3/Aerodrome swap.

**This is not a signal and not advice.** It's a map plus the plumbing to act on it. Read the
"Failure modes" section before you send anything.

---

## `web/` — the contract checker

The problem it solves: within an hour of the launch being reported, at least 14 copycat tokens
using the LAPTOP name appeared across four chains and traded $6.9M between them. One was deployed
on Robinhood Chain about 60 seconds before the news post. People will lose money on launch day by
pasting the wrong address into a swap.

The tool answers exactly one question well — *is this the address that was published?* — and is
careful about everything it cannot answer.

### What it does

| Requirement | How |
| --- | --- |
| Is this the published contract? | Byte comparison against a displayed reference. **Zero network calls.** |
| What is actually at that address? | `eth_getCode`, codehash, name/symbol/decimals/supply, existence 24h ago |
| Can the published LAPTOP be traded yet? | 30 venue/quote cells + the v4 PoolManager balance gate |
| Is this a non-buy venue? | Quote-asset rule: anything not ETH/WETH/USDC/USDbC is flagged |
| Can I check the tool's own claims? | Every address is full-length and links to basescan.org |
| Does it work on a bad connection? | JSON-RPC batching, per-row failure states, honest partials |

### Design rules it actually enforces

- **The identity verdict never touches the network.** A hostile or broken RPC can corrupt the
  supporting evidence but *cannot* flip `MATCHES` ↔ `DOES NOT MATCH`. This is the single most
  important property in the tool and it falls out of doing the comparison offline.
- **Four verdict strings, as literals.** `MATCHES PUBLISHED CONTRACT` / `MATCHES YOUR REFERENCE` /
  `DOES NOT MATCH` / `NO CONTRACT AT THIS ADDRESS` / `CANNOT VERIFY`. No template can produce a
  fifth. The tool never says "safe", "legit", or "buy".
- **A failed read is never a pass.** 32 zero bytes means *the contract answered "none"*. A bare
  `0x`, a short return, or an error means **could not check**. Conflating them turns an
  unreachable endpoint into a confident "no pool exists".
- **Every negative is scoped.** "No pool found in 30 of 30 venue/quote combinations checked" —
  never "no liquidity anywhere". The coverage ledger lists what was and wasn't checked, including
  the gaps that cannot be closed.
- **Wrong chain suppresses results entirely** rather than showing them qualified. The Uniswap V2
  factory is deployed at the same address on Base *and* BNB Chain, so an address match proves
  nothing about which chain you are on.
- **The reference address is contestable.** If this page were cloned with a swapped address it
  would be self-consistent and confidently wrong. Overriding the reference is how you defeat that;
  doing so strips the word "PUBLISHED" from the verdict.

### Run it locally

```bash
python3 -m http.server -d web 8000     # then open http://localhost:8000
```

Or just open `web/index.html` from disk — it has no build step and no dependencies. Saving the
file and opening it locally removes the hosting party from the trust question entirely.

Published build `2026-09-07f`:

```
sha256(web/index.html) = 7f87e882aeb28634c5b5568df77487e120c823a1f9b8af84e9ce89485cebb18b
sha256(web/size.html)  = ff9eeb89846cc47f6d2be46a5e61622a10f2676c015a4d1df5695b55bfd1640b
sha256(web/route.html) = c8674ade8957556faac73d2c3a079cc9f9ddb41a11b626691d5dfba48db55638
```

### Tests

```bash
sh test/run-all.sh         # everything below, no network touched
```

**322 assertions across six suites.**

`test/run.mjs` — 93, drives the real page in Chromium against `test/mock-rpc.mjs`: Keccak
vectors, the four EIP-55 reference addresses, the v4 poolId derivation checked against a real
Base pool id, ABI-string decoding (including a 10-character name, whose length word contains a
hex letter, and truncated/absurd offsets), result-length discipline, and full flows for the
happy path, pools present, wrong chain, a flaky rate-limited node, and an endpoint that refuses
JSON-RPC batches. Needs `playwright`.

`test/test_laptop_base.py` — 65, pure functions against a fake `call`, so every failure mode is
directly reachable: none-vs-unknown, Aerodrome's reverting `getPair`, the V3/Aerodrome selector
collision, tier-enabled vs pool-absent, the three-way v4 state including a packed `slot0`, and
decoder edge cases.

`test/test_scripts.py` — 28, the patched scripts against a fake node where the *only* pool is
USDC-quoted — the exact shape that used to print "no liquidity anywhere".

`test/test_size_math.py` — 35, a reference implementation of the swap math written independently
of the JavaScript, plus properties a size curve lives or dies on: output rises with size,
effective price strictly worsens, a fee costs exactly its rate at the limit, deeper liquidity
fills better, and no fill can exceed the output-side virtual reserve. Emits the fixture below.

`test/run-route.mjs` — 35, asserts `web/route.html` makes no network request of any
kind, offers no wallet or deposit address, and gets the Solana-is-not-EVM distinction right.

`test/run-size.mjs` — 66, asserts `web/size.html` agrees with that Python fixture to 1e-12,
then drives the page against constant-product, concentrated, capped, dry, stable, foreign-token
and no-code pool fixtures.

## `web/route.html` — get ready before launch

**There is no auto-buyer here, and there will not be one.** Buying is a swap against a pool;
until someone funds a LAPTOP pool there is nothing to swap against, so no transaction can be
sent on anyone's behalf. That is not a missing feature — the counterparty does not exist yet.

Which means every "preorder" is the same arrangement: somebody holds your money and promises
tokens later. Building that would mean accepting deposits from the public against a delivery
promise — money transmission at minimum, plausibly an unregistered offering — and it is
structurally identical to a presale rug regardless of intent. On a site whose entire purpose is
stopping people getting fleeced on launch day, it would be the most damaging thing in the repo.

What you can genuinely do is **pre-position**: arrive at launch already holding spendable funds
on Base, in your own wallet, one transaction from a fill rather than one bridge plus one
transaction. That is what this page plans.

It takes your chain and asset and lays out the path, including the parts people get wrong:

- **Solana is not an EVM chain**, so an EVM-only bridge cannot route it. The bridge table hides
  the ones that cannot see Solana when you select it.
- **Bridge before launch, not during.** Bridging is the slow, congested, failure-prone step and
  it is entirely removable from the critical path. The fee is the same at a calmer moment.
- **Keep ETH on Base for gas.** Arriving with only a stablecoin is the most common way people
  find they are not actually ready — the swap itself costs ETH.
- **Arrive in the asset the deepest pool quotes.** WETH, USDC and USDbC pools are not
  interchangeable; buying a USDC pool with WETH costs another hop and another fee.

The page **makes no network request of any kind** — a test asserts nothing leaves the origin.
No wallet connection, no deposit address, no fetch. It quotes no bridge fees, because it reads
nothing live and will not print a number it has not measured. Bridges are listed because they
are non-custodial and widely used, explicitly **not** because this tool has verified any of
them; it has not.

## `web/size.html` — the size curve

The number that decides your size, and unlike leverage it exists on day one. Feed it a pool and
it prices a ladder — 0.1 / 0.25 / 0.5 / 1 / 2 / 5 / 10 / 25 / 50 of the quote asset — showing
tokens out, effective price and how much worse than spot each fill lands. Plus a box for your
own size.

Leverage is not the alternative on launch day and this repo does not pretend otherwise. Lending
markets onboard an asset by governance vote, weeks at minimum; perp venues list after volume
proves out, not before. The workarounds all fail on day one: borrowing against ETH to buy LAPTOP
is leverage on your ETH, not on LAPTOP, and gives you two uncorrelated ways to be liquidated; a
permissionless isolated market needs someone to supply the loan capital, which for an hours-old
memecoin means you, lending yourself money with extra steps and an oracle you have to stand up.
An isolated market with a TWAP oracle is a real product about a week after launch, once there is
enough depth that manipulating the pool to liquidate borrowers is expensive. Thin-pool oracle
manipulation is the standard attack on exactly that setup, so depth has to come first.

**How trustworthy each number is, by pool type:**

| Pool | Status | Why |
| --- | --- | --- |
| Uniswap V2, Aerodrome volatile | **exact** | the same constant-product arithmetic the pool runs, in integers |
| Uniswap V3, Slipstream | **best case** | assumes current in-range liquidity extends across the whole trade |
| Aerodrome stable | **declined** | the x³y+y³x curve is not implemented, so it prices nothing rather than pricing it wrong |
| Uniswap v4 | not supported | a v4 pool is a key in the PoolManager, not an address |

The concentrated-liquidity caveat is the important one. Real pools thin out at range boundaries
the tool does not read, and when that happens you get **less** than shown — so for a new pool
with one position, a large size is very likely worse than the number on screen. Every such row
is labelled a best case rather than an answer.

Two guards on top of the arithmetic: no fill can exceed the pool's actual balance of LAPTOP
(rows that would are marked as unfillable, whatever the formula says), and the result box is
graded by severity — a 30%-worse fill is never rendered in the colour that means "fine".

The math is computed over the *virtual* reserves `x = L/√P`, `y = L·√P`, because for a single
range with constant `L` concentrated liquidity is exactly constant product over those. The
textbook closed form `L·(√P − √P_next)` is algebraically identical but subtracts two nearly-equal
large numbers, losing ~1e-10 of relative precision to cancellation and underflowing to zero
outright on small probes. `test/test_size_math.py` holds both forms and asserts they agree.

## Design notes

`docs/premarket-and-tokenomics.md` — an FR/DP treatment of a pre-market order book and of
token design. Two conclusions worth pulling out:

**An escrowed pre-market is coupled by construction.** The collateral ratio sets both safety
and liquidity in opposite directions: high collateral means nobody posts a sell order and the
book is empty; low collateral means defaulting becomes rational exactly when the token moons.
One DP, two opposed FRs. Decoupling it properly — mark positions against a live index and
margin-call — re-derives the cash-settled perp, which is to say the escrowed-delivery design
is the coupled one and the derivative is the decoupled one. Its settlement oracle is also an
irreducible centralisation, and given 14 copycat contracts across four chains, an oracle
pointed at the wrong address settles the whole book against the wrong token.

**Single-token designs are maximally coupled.** One instrument typically serves funding,
alignment, fee capture, governance, collateral and incentives — six rows, one column. That is
why emissions to bootstrap usage dilute the holders you were trying to align, and why raising
the in-token fee discourages the usage you paid to acquire. It cannot be tuned out; the endless
retuning is the diagnostic. Decomposed properly each FR finds a better DP than "issue a token"
— fund with equity or revenue, align with vesting, price in USD and settle in USDC, govern with
a non-transferable right, and collateralise with an asset you do not issue, since collateral
whose value derives from the system it secures falls exactly when it is needed. A design that
starts from *what functions do I need* and ends at *therefore a token* has usually smuggled in
an unstated requirement worth naming out loud.

## The flow, and why it is this short

Working back from what the person actually needs at the moment they are deciding:

- **CN1** — don't let me buy the wrong token.
- **CN2** — don't let me get a terrible fill.
- **CN3** — don't let this tool fool me.

The first version served CN1 and CN2 across two pages with **a manual copy of a 42-character
hex string in the middle**: read the checker, find a pool in the venue table, select and copy
its address, navigate to the size page, paste, read. The user was the data bus between two
tools.

That is not merely friction. Transporting an address by hand is *the exact failure this
project exists to prevent* — so the flow for CN2 was actively attacking CN1. In information
terms the manual step has some probability of success below one, and every bit of `log2(1/p)`
it contributes is information the design is asking the user to supply. Deleting the step drives
that term to zero, which is a stronger result than making the step easier.

So every pool the checker finds now links straight into the size curve as
`/size.html?pool=0x…`. Nobody types or copies a pool address, and the class of error disappears
rather than being mitigated. The deep link gets **no shortcut past validation** — a URL is an
untrusted input, anyone can send one, so it runs the same address parse and the same refusal
when neither side of the pool is the published LAPTOP.

The same pass found that `size.html` had no chain anchoring at all. It would happily price a
pool on Ethereum, because an address exists on every chain. It now checks `eth_chainId` before
reading anything and prices nothing at all on a mismatch, matching the checker.

And a recovery path that was invisible in the one state that needed it: when every read is
CORS-blocked, the tool offers a relay — but the offer sat inside a collapsed "Change endpoint"
disclosure the user had no reason to open, while the rest of the page was empty. The disclosure
now opens itself when the offer appears.

## CORS: the one question the suite cannot answer alone

Whether a browser at totalworlddomination.xyz can read *any* Base endpoint directly is the
single thing that decides whether `relay/` gets deployed, and it needs egress to real Base
hosts. Run it from a machine that has that:

```bash
sh test/cors-check.sh                          # the usual public endpoints
sh test/cors-check.sh https://my-endpoint.example
```

It checks the three things that matter, in order: the **preflight** must carry
`access-control-allow-origin` covering our origin (`application/json` is not a CORS-safelisted
content type, so every one of these requests is preflighted — an endpoint that sets the header
only on POST still fails), the POST must carry it too, and batching must work or the tool falls
back to roughly forty sequential reads and gets throttled. It ends with a plain verdict on
whether the relay is needed.

What the suite *does* test is the code path, with a real browser-level CORS failure rather than
a simulated one: the mock serves a scenario with no `access-control-allow-origin` from a
different origin, so Chromium blocks it exactly as it would block a real endpoint. Under that
block the checker still renders its identity verdict — the property the whole design rests on —
suppresses every on-chain claim rather than guessing, and surfaces the relay. The browser cannot
distinguish CORS from "host is down", so the tool does not claim to either; it says so.

## Branding: `web/bg.png` and the $TWD watermark

Both pages carry a full-bleed background image and a tiled `$TWD` watermark. The watermark is
an inline SVG data URI — no request, no third-party asset — and the ticker also appears in each
page header and footer.

**`web/bg.png` is not in the repo. Drop your artwork there and it appears on both pages.**
It is the only external asset either page loads, it is same-origin, and it is referenced from
exactly one decorative CSS rule and never from script. So if the file is missing, blocked by
CSP, or the HTML is saved and opened offline, the pages lose a picture and nothing else — every
verdict, number and failure state is untouched. A test asserts that no script references it.

Recommended: a wide image (roughly 16:9), under ~300KB. It renders at 13% opacity, inverted in
dark mode, behind cards that sit on a 90%-opaque ground, so nothing ever competes with a verdict
someone is reading in a hurry. Tests assert the art stays below 20% opacity, the watermark below
10%, both layers sit behind the content with `pointer-events:none`, and the verdict box keeps an
effectively opaque background.

`test/fixture-bg.png` is a generated stand-in used only so the test suite exercises the
background code path. It is not artwork and is not served in production.

Note the CSP in `vercel.json` had `img-src 'none'`, which would have silently blocked the
background. It is now `img-src 'self' data:` — same-origin images and inline SVG only, still no
third-party image loads.

### Deploying

Vercel, static, no build step. `vercel.json` sets `outputDirectory: web` and a strict CSP.

**Turn off Vercel Analytics and Speed Insights** — both inject a first-party script that phones
home, which breaks the no-tracking rule this tool is built on.

One CSP compromise worth knowing about: `connect-src https:` is deliberately broad, because the
RPC endpoint is user-editable and locking it to one host would break that. It still blocks
plaintext HTTP, `data:`, and websockets.

`relay/` holds an **optional** read-only JSON-RPC relay for Railway. Deploy it *only* if browsers
turn out not to be able to reach a Base endpoint directly (a CORS failure). The tool defaults to
direct reads, the relay is opt-in behind a toggle, and the UI states plainly that the relay sees
every address you check. It refuses any method that is not a read.

---

## Python scripts

```bash
python3 -m venv env && source env/bin/activate
pip install web3 requests
export BASE_RPC=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY   # public RPCs rate-limit and refuse eth_getLogs
export LAPTOP_PK=0xyour_private_key                              # or leave unset; scripts prompt, hidden
```

Use a wallet holding only what you intend to spend.

### `laptop_scan.py` — where the supply is and which pools exist

```bash
python3 laptop_scan.py                       # uses $BASE_RPC
python3 laptop_scan.py --vault 0x...         # skip the mint search if you already know the vault
```

- **A.** Finds the mint (block-timestamp binary search, or `--vault`), reads the vault balance. If the
  vault still holds all 1B, nothing circulates and no pool can exist anywhere.
- **A2.** Every LAPTOP transfer since the mint, plus current holders, each labeled
  mint / vault / known DEX contract / other contract / EOA.
- **B.** Every Uniswap v4 pool containing LAPTOP. v4 has no factory, so this reads PoolManager
  `Initialize` events filtered on currency0 **and** currency1 (LAPTOP sorts either way depending on the
  quote token — filtering only one slot misses half the pools). For each pool it prints the quote
  token's symbol, fee (flagging the `0x800000` dynamic-fee sentinel), tickSpacing, decoded hook
  permissions from the hook address's low 14 bits, the initial price from `sqrtPriceX96`, who sent the
  initialize tx, and live liquidity read from PoolManager storage via `extsload`.

### `laptop_watch.py` — alert/fire when a real market opens

```bash
python3 laptop_watch.py                       # alert only
python3 laptop_watch.py --auto --eth 0.01     # hands off to laptop_buy.py on a classic pool
```

Polls **one quote asset per cycle**, rotating through WETH, USDC and USDbC, so full coverage
takes three cycles. Probing all three every cycle would roughly quadruple this loop's RPC cost
on an endpoint that already rate-limits; rotating keeps the per-cycle budget flat and costs a
few seconds of latency instead. Only WETH-quoted pools are handed to `laptop_buy.py --send`.

Polls: classic pools crossing `--min-liq-eth`; new v4 pools (flagging whether the quote is tradable
ETH/WETH/USDC or a sidecar token); PoolManager's LAPTOP balance, which is the single number that says
whether any LAPTOP has been deposited into v4 at all; and every new transfer, flagging any into a known
DEX contract — that lands one block before a pool goes live.

### `laptop_v4.py` — buy from a Uniswap v4 pool

```bash
python3 laptop_v4.py prep --quote USDC --send        # once: token -> Permit2, Permit2 -> Universal Router
python3 laptop_v4.py arm \
  --c0 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --c1 0xB095274743941e953c746F9C228DA9c18Bb6ec29 \
  --fee 250000 --spacing 200 \
  --hooks 0x0000000000000000000000000000000000000000 \
  --quote USDC --amount 25                          # add --send to broadcast
```

Derives the pool id (`keccak(currency0, currency1, fee, tickSpacing, hooks)`), encodes one Universal
Router `execute` with v4 actions SWAP_EXACT_IN_SINGLE / SETTLE_ALL / TAKE_ALL, polls that pool's
liquidity, and fires when it's non-zero. `--now` skips the wait. `--quote ETH` needs no approvals.
Without `--send` it prints the pool id and calldata and stops — run that first and check the id against
the pool you actually mean to trade.

### `laptop_base.py` — shared constants and read discipline

One source of truth for Base addresses, selectors, fee tiers and quote assets, plus the read
helpers the other scripts use. Every read returns `("found", x)`, `("none", None)` or
`("unknown", reason)` — never a bare value. The distinction between *none* and *unknown* is the
point: 32 zero bytes means the contract answered, while a revert, an empty return or a rate
limit means we do not know, and code that conflates them turns an unreachable endpoint into a
confident negative.

### `laptop_buy.py` — buy from V2 / V3 / Aerodrome

Surveys **every venue against every quote asset** (WETH, USDC, USDbC) including all seven Base
V3 tiers and Aerodrome Slipstream, then quotes each, refuses
pools below `--min-liq-eth` (default 1 ETH), simulates with `eth_call` + `estimate_gas`, then requires
`--send` plus typing `BUY`. Also asks the DEX Screener API, which surfaces v4 pools the factories can't
see (it reports them; it does not route v4 — that's `laptop_v4.py`).

Only WETH-quoted pools are offered as buyable: this script spends ETH and does not build
multi-hop routes. A USDC- or USDbC-quoted pool is reported loudly with the reason it is not
tradable here, so a filling pool is never invisible — it just is not something the script will
trade for you.

`mock_rpc.py` / `mock_rpc2.py` are local JSON-RPC mocks used to test both code paths (pools present and
absent, supply vaulted and moved) without touching mainnet.

---

## Addresses

Confirmed against protocol source (Uniswap, Aerodrome, Optimism/Superchain and Circle
repositories) while building the checker:

| What | Address |
| --- | --- |
| Uniswap v4 PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` |
| Uniswap V2 factory | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` |
| Uniswap V3 factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| Aerodrome PoolFactory (v2-style) | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` |
| Aerodrome FactoryRegistry | `0x5C3F18F06CC09CA1910767A34a20F771039E37C0` |
| Aerodrome Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| Universal Router | `0x6fF5693b99212Da76ad316178A184AB56D299b43` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| WETH (OP Stack predeploy) | `0x4200000000000000000000000000000000000006` |
| USDC — **native**, Circle-issued | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDbC — **bridged**, a different token | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` |

Verified against block explorers during the original tracing work:

| What | Address |
| --- | --- |
| LAPTOP (official, per laptoptoken.com) | `0xB095274743941e953c746F9C228DA9c18Bb6ec29` |
| Mint vault | `0xf859bF7A72a282eAC0e99E1ca0D1b814Ccd8B24d` |
| Deployer | `0x0FB557378b64D3084f9DEDc633E8B03cFa7F5592` |
| Create2 factory used | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| Doppler Airlock (Whetstone) | `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12` |
| HUNTER (Doppler sidecar token) | `0xfcac02ca1bead66b91405042063fbce85fd42009` |

Still unverified: the Aerodrome Slipstream CL factory addresses, and the V3 quoter/router02
addresses. The checker discovers Aerodrome factories at runtime via `FactoryRegistry.poolFactories()`
rather than hardcoding a guess, and reports any factory it does not know how to read.

Note that `0xfcac02…` is all-lowercase and therefore carries **no EIP-55 checksum protection** — a
typo in it cannot be detected. Every other address above is checksummed.

### Function selectors

All computed from their signatures, not recalled:

```
getPair(address,address)              0xe6a43905    Uniswap V2 factory
getPool(address,address,uint24)       0x1698ee82    Uniswap V3 factory  (also Aerodrome, see below)
getPool(address,address,bool)         0x79bc57d5    Aerodrome PoolFactory
getPool(address,address,int24)        0x28af8d0b    Aerodrome Slipstream CLFactory
feeAmountTickSpacing(uint24)          0x22afcccb    is a V3 tier enabled at all?
poolFactories()                       0x06121cd5    Aerodrome FactoryRegistry
extsload(bytes32)                     0x1e2eaeaf    Uniswap v4 PoolManager
extsload(bytes32,uint256)             0x35fd631a    batch form — 4 slots in one call
```

---

## Corrections — found, then fixed

These were defects in the Python scripts, found by checking their constants against protocol
source. **All are now fixed**, and each has a regression test in `test/test_scripts.py` or
`test/test_laptop_base.py`.

The root cause of most of them was duplication: the same addresses, fee tiers and quote assets
were copy-pasted across three scripts and drifted apart. They now live in one place,
`laptop_base.py`, which also holds the shared read discipline. A test asserts the scripts really
do read their constants from it, so this cannot silently drift again.

1. **`laptop_buy.py:43` — `V3_FEES = (100, 500, 3000, 10000)` is incomplete for Base.** Base
   uniquely enables three extra tiers: 200, 300 and 400 bps (tick spacings 4, 6, 8). Uniswap's own
   frontend gates exactly those three behind `supportedChainIds: [Base]`. Probing four tiers and
   printing "no V3 pool" is an *unearned negative verdict* on three tiers never queried. The full
   Base set is `(100, 200, 300, 400, 500, 3000, 10000)`.

2. **Quote-asset blindness — the highest-impact one.** Both `laptop_buy.py` and `laptop_watch.py`
   check only the LAPTOP/**WETH** pair on every venue. But the only real LAPTOP pools observed so
   far are **USDC**-quoted. A WETH-only sweep prints "no liquidity anywhere" while a USDC pool is
   filling. Check `{WETH, USDC, USDbC}` at minimum.

3. **`laptop_watch.py:40` `TRADABLE_QUOTES` omits USDbC.** A USDbC-quoted pool would be flagged as
   an untradable sidecar. Bridged USDbC is a real, tradable Base asset — just a different contract
   from native USDC. Never render a bare "USDC" for `0xd9aAEc86…`; that substitution is exactly the
   class of error this project exists to catch.

4. **Aerodrome has no `getPair` of any arity, and no fallback function.** An `eth_call` to
   `getPair` on `0x420DD381…` *reverts* — it does not return the zero address. Code that treats a
   revert as "no pool" is wrong there.

5. **Selector collision.** Aerodrome's `PoolFactory` also exposes
   `getPool(address,address,uint24)` — byte-for-byte the same selector `0x1698ee82` as Uniswap V3.
   It answers without reverting and returns `address(0)` for any fee > 1. A V3-shaped call aimed at
   the wrong factory therefore produces a silent false negative rather than an error.

6. **Aerodrome Slipstream is a whole second AMM** (concentrated liquidity,
   `getPool(address,address,int24)`, tick spacings 1/50/100/200/2000) whose pools are invisible to
   `0x420DD381…`. Nothing in the Python tooling looks at it.

7. **`laptop_scan.py` reads only offset +3 (`liquidity`) of the v4 pool state.** Reading an
   unwritten slot returns 32 zero bytes with no error, so `liquidity == 0` cannot distinguish
   *"this pool key never existed"* from *"initialized but empty"*. v4's own initialization sentinel
   is `slot0.sqrtPriceX96` at offset +0. Read both and you get a defensible three-way answer.
   Also worth stating plainly: `liquidity` is **active in-range** liquidity — a pool holding real
   deposits entirely out of range reads zero.

The v4 storage derivation itself was correct all along: `POOLS_SLOT` really is 6, the base slot
really is `keccak256(poolId ‖ uint256(6))`, and `liquidity` really is at offset +3.

Two more, found while writing the tests rather than by inspection:

8. **An out-of-bounds ABI string offset decoded to `""` and was reported as a successfully-read
   name** — a guess wearing an answer's clothes. Both the Python and JavaScript decoders now
   bounds-check the offset and the declared length before slicing. The same test exists in both
   languages.

9. **In the first version of the patched watcher, one failing `balanceOf` took down the whole
   sweep**, losing every other venue for that cycle. Measuring a pool's depth is now allowed to
   fail on its own: the pool still gets reported, its depth reads "unknown", and a pool whose
   depth could not be read can never trip the `--auto` buy.

---

## Findings as of Sept 7, 2026

- LAPTOP deployed Apr 27 via Create2. LayerZero OFT, 1B minted only on Base by a constructor chain-ID
  check. Ownable2Step; `setPeer` authorizes cross-chain mints. Hacken audit dated Apr 23 covers the OFT
  only — not vesting, airdrop or prediction-burn contracts.
- 800M still in the vault. 200M left in two 100M tranches (each preceded by a 1-wei test send) to two
  Safes, which have since paid a handful of EOAs. Allocations, not liquidity.
- No LAPTOP in any AMM. Two USDC/LAPTOP v4 pools initialized and empty. A third v4 pool pairs LAPTOP
  against a new token, HUNTER, launched through Doppler — that book sells HUNTER **for** LAPTOP, so it
  is not a way to buy LAPTOP.
- 14+ copycats across four chains appeared within an hour of the WSJ story. The largest, on Robinhood
  Chain, was deployed ~1 minute before WSJ's post; its bytecode is a stock Pons launchpad ERC-20 with
  none of the announced mechanics.

## Failure modes

**Of the checker:**

- **A cloned site is the unfixable one.** A copy at another domain could show a different reference
  address and be perfectly self-consistent. Mitigations are partial: the reference is always
  displayed in full, the build hash is published above, the reference is user-overridable, and the
  file works offline. None of that is airtight. Check the URL.
- **`eth_chainId` catches misconfiguration, not malice.** It stops you reading Ethereum or Robinhood
  Chain by mistake. A hostile endpoint can simply claim 8453 and lie about everything after.
- **A pool can be funded seconds after a reading.** Every result is timestamped for that reason.
- **A CREATE2 address that is empty now can hold code in ten minutes.** "No contract here" is a
  statement about right now.
- **Coverage is bounded.** v4 pools with custom hooks cannot be enumerated at all; only the
  PoolManager balance is decisive. Base V2-forks other than Uniswap are not checked. Quote assets
  are limited to WETH/USDC/USDbC.
- **The "existed 24h ago" check needs an archive node.** Most public endpoints are not, and the row
  says "could not check" rather than guessing.

**Of the trading scripts:**

- Base has a private mempool and a single sequencer. There is nothing to front-run; this is reaction
  speed, and anyone with colocated infra reacts faster.
- The team may fund a pool none of these scripts is armed on, or a different quote token.
- A hook with a snipe tax or a start-time gate can tax or revert an early buy. The two USDC pools
  currently show no hook; that can change if the team uses different pools.
- A simulation that passes can still revert when pool state changes in the same block.
- Public RPCs rate-limit (429), refuse `eth_getLogs` (403), and cap log ranges (413).
- The unfixed defects listed under "Corrections" above will produce false negatives.

MIT. No warranty. You are responsible for anything you sign.
