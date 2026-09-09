# LAPTOP tooling (Base)

On-chain tooling built while tracing the `$LAPTOP` token before its Sept 9, 2026 launch on Base.

Two halves:

- **`web/`** — eight pages for people who are about to buy, at
  [totalworlddomination.xyz](https://totalworlddomination.xyz). One self-contained HTML file
  each. They connect to Phantom to read your Base balances and they never ask you to sign
  anything. **`index.html` is the buy screen** — *which venue fills best* — and it is the
  landing page. Then `checker.html` answers *is this the right contract*, `size.html` *what
  does my size get me*, `order.html` *can I commit before launch*, `slot.html` *is this
  preorder real*, `route.html` *what should I be holding*, and `launch.html` — for whoever
  sets the parameters, not for buyers — *what does a fee design actually earn*.

  The buy screen was moved to the front on request. It used to be the contract checker, and
  that is a real trade: the checker is the anti-scam tool and it is now one click away rather
  than the first thing a visitor sees. Every page still links to it, and the verdict's primary
  action still points at the buy screen, so the two are one hop apart in both directions.
- **`*.py`** — the tracing and execution tooling: find the pools, watch for the first real
  liquidity, execute a Uniswap v4 swap, execute a classic V2/V3/Aerodrome swap.

**This is not a signal and not advice.** It's a map plus the plumbing to act on it. Read the
"Failure modes" section before you send anything.

---

## `web/checker.html` — the contract checker

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

Or just open any of them from disk — it has no build step and no dependencies. Saving the
file and opening it locally removes the hosting party from the trust question entirely.

Published build `2026-09-09a`:

```
sha256(web/index.html)   = 2653a731b9758d2403f3a164ceeee34a16315c1887fd43c14b315b2fb0f11ce7
sha256(web/buy.html)     = 3f7d5bdb8a1c57e2ea36ce8411f93e4a40c904d6cf0a0b22c034217b1680500a
sha256(web/checker.html) = 8501ac5675f3d6edc7cfc55bc00b219448744f12ec8c91b2c6c54597cb99d845
sha256(web/size.html)    = 9089eb5de402b6d54290c0b4eb69f64ab710d42dc9cce9d5e033f5e9ad892299
sha256(web/route.html)   = 575b24cfa04c1180f77885b9ebc726f29c8aa9be917a4de65254ea412fc3a9bf
sha256(web/order.html)   = a9f0fee7f0cb4c3c7b503c1ce03ddbb3312c067a918024ed9dcad5729bcd8ddd
sha256(web/slot.html)    = bbe664806f87849fd3e051ef4485a65b6cdf2668694db6c9a1e6790dcfe8e97f
sha256(web/launch.html)  = d31b0383d50bad770d16ac0b66a1a7f77f3af1eb8c6e3fa33ee283270ba404e9
sha256(web/snooze.html)  = 202b84b582ee0deac9767b0c55b654f099cca07a64f712e079ad6f03a1964933
sha256(web/dream.html)   = 01bd15f5d8b89d6cdd1c1cb1a4966ba14b67eb4e7cfcb8a5d3bcdc2b741145b7
```

### Tests

```bash
sh test/run-all.sh         # everything below, no network touched
```

**2447 assertions across twenty-six suites.**

`test/run.mjs` — 397, drives the real page in Chromium against `test/mock-rpc.mjs`: Keccak vectors,
the four EIP-55 reference addresses, the v4 poolId derivation checked against a real Base pool
id, ABI-string decoding (including a 10-character name, whose length word contains a hex
letter, and truncated/absurd offsets), result-length discipline, and full flows for the happy
path, pools present, wrong chain, a flaky rate-limited node, and an endpoint that refuses
JSON-RPC batches. It also holds the cross-page invariants: that every page says it does not ask
you to sign and mentions no `eth_*` method outside the read set, that any page touching
`window.phantom` uses its EVM side, that they all state the same build tag and that the README
publishes that tag and the current hash of every page, and that `web/` serves nothing but the
eight pages and the artwork. Plus the Phantom provider matrix (no wallet, Solana-only, both
sides, injected as `window.ethereum`, inside a multi-provider array, and a non-Phantom wallet)
and balance formatting and read discipline. Needs `playwright`.

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

`test/run-index.mjs` — 231, drives the $SNOOZE landing page. Most of it is about one
distinction: a plot of a FORMULA and a plot of a MARKET look identical from three feet away, so
the suite asserts which one is on screen. With nothing deployed the chart shows Rule 1 itself —
exact, checkable against `burnBps()` in the contract, labelled *this is arithmetic, not a
market* — and `window.__CHART.marketSeries` is empty. It only becomes a market series when a
chain read produced one, and a single deposit is never drawn as a line. The launch-day path is
driven before launch day against a mock node, including one that refuses `eth_getLogs`, one that
serves a short window, and one that is not there at all — none of which may produce a number.

It also pins what the page must NOT say: an earlier version claimed "$SNOOZE is the launchpad,
LAPTOP is the first launch on it", which was invented here and is wrong — they are separate
tokens, and what is true is that holding one gets you into the other. The words "launchpad" and
"first launch on it" are now asserted absent, because an assertion that only checks for the right
sentence lets the wrong one sit beside it.

The rest is the MVP's own rules. The depth-versus-speed table is checked against
`bond_model.py`'s closed form rather than against the copy that quotes it. Every term with a
definition attached must be a real `<button>` with an aria-label, must define itself in thirty
words or fewer, and must carry no border — a word with a box round it is a control, and the
page is not a control panel. Base blue is asserted to appear as a fill and never as text or a
border, because #0052ff is 2.91:1 on this ground. The tool links are asserted to have no
border, no fill and a 36px tap target: an icon in a box reads as *press me*, and these are
places to go. And the whole rendered page has to come in under 700 words.

`test/run-buy.mjs` — 33, drives the venue comparison against a three-venue fixture with
deliberately different depths and asserts the ranking follows depth, the spread is quantified,
and that the page connects and reads but holds no signing, sending or approval code.

`test/run-slot.mjs` — 83, drives the deposit-contract checker against fixtures for an EOA, each of the three proxy patterns, a contract with no reachable exit, and every way a read can fail — asserting that a failure never becomes a finding, and that the page says outright that connecting buys you no slot.

`test/run-order.mjs` — 102, drives the standing-order page: the ceiling formula against an
implementation written from the pool identity rather than the page's algebra, the two
splitting laws below, refusal of ceilings under the fee floor, and the promises the page
declines to make.

`test/run-route.mjs` — 44, asserts `web/route.html` originates no request on load, computes its
routing table locally, offers no deposit address, reaches only for Phantom's EVM provider, and
gets the Solana-is-not-EVM distinction right.

`test/run-size.mjs` — 68, asserts `web/size.html` agrees with that Python fixture to 1e-12,
then drives the page against constant-product, concentrated, capped, dry, stable, foreign-token
and no-code pool fixtures.

`test/run-launch.mjs` — 154, checks `web/launch.html` against a fixture `launch_model.py`
emits: 18 cases across three ramp units, two seed depths and three starting rates, agreeing to
1e-9 on buyer count, take, volume and round trip, with the 81-world histogram matching exactly.
The rest guards the page's refusal to recommend — a page that quietly starts recommending again
is the regression that matters — plus the unit warnings and a check that changing a pure guess
does not move what a buyer pays.

`test/run-contract.mjs` — 70, compiles `contracts/LaunchTaxRamp.sol` with solc and executes its
opcodes in an in-process EVM. Off-by-one on the first buy, tax-on-tax against the pool fee,
sell-tax interaction, the seed-LP exemption and whether an exempt trade advances the ramp, the
cap and its construction-time validation, the turn-off, rounding that conserves every wei, the
freezable exemption list, and the three ramp units measured against each other for splitting
evasion and same-block fairness.

`test/run-snooze.mjs` — 87, compiles `contracts/Snooze.sol` and executes both rules. Most of it
tests the SPEC rather than the code: that a dump is free, that sleeping does not bank the
spike, that the dial is also the buyer's instant loss, that an unregistered venue is outside
both rules, that the oracle fails open, and that "no lock" is false.

`test/run-dream.mjs` — 87, compiles `contracts/SnoozeDream.sol` with `Snooze.sol` and executes
Rule 3, which is the only rule in this launch pointed at holding rather than at leaving. The
claim it exists to make a number of is the headline one: **one $SNOOZE held untouched for the
90-day ramp accrues exactly one $DREAM**, asserted as an equality at the same nine decimals on
both tokens rather than as a bound. The rest is the shape of the ramp — which is QUADRATIC, so
half the time is a quarter of the reward and not half, and that is the reading almost everybody
takes — every way a streak can be broken or faked, and the hole that would otherwise let a
wallet farm the ramp while holding none of the token. It also measures what the rule costs
everybody who never claims it: 57,262 execution gas on an ordinary transfer, paid by every
holder. And it checks `web/dream.html` against the contract it reads, because two of the three
selectors on that page were written by hand and both were wrong — a wrong selector is not a
failed read, it is a call to whatever function shares the prefix.

`test/test_snooze_py.py` — 93, `snooze.py` from outside itself. The script's own `selftest`
proves its arithmetic against published vectors, which it has to, because the premise is that
somebody downloads one file and runs it on a machine with nothing else on it. This is the other
half: that the Rule 3 arithmetic in Python is the SAME INTEGER EXPRESSION as the Solidity and
not a float model of it, checked over 50 cases; that the curve identities agree with
`bond_model.py`, which derived them independently; that the read allowlist has no method that
can send and no import that could sign; and that the console page references no external origin.
It also pins the optimizer's two scoring bugs as regressions — see **`snooze.py`** below.

`test/test_pumpfun_py.py` — 44, `pumpfun.py`, which is the one script here that **holds a
private key** — Solana has no browser-signing path, so a script that submits a transaction must
sign it. The narrower rules that replaced "no key anywhere" are therefore all driven here rather
than asserted in a comment: that no flag takes a key, a seed or a mnemonic; that a malformed,
inconsistent or world-readable keypair file is refused; and that a wallet holding 40 SOL is
refused outright, because that is a main wallet and not headroom. It also drives the decoder
against transactions built byte by byte in the suite — one paying from a stranger's wallet, one
wanting a third signature, one invoking a program the launch does not need, one hiding accounts
behind an address-table lookup — and checks that no flag exists for a wallet fleet, a bundle or
volume, and that the only action ever requested of the builder is `create`.

`test/run-wiring.mjs` — 36, Snooze and PooledLaunchBuy joined. Both pass alone and the
distribution still cannot complete: `claim()` is an outbound transfer and the 20%/day cap
applies to it. Also carries the axiomatics — the decay condition, depth-versus-appreciation,
and what a large supply does and does not buy.

`test/run-curve.mjs` — 87, compiles `contracts/SnoozeCurve.sol` and executes it. The virtual
curve's ETH side starts imaginary, so most of this suite is one property attacked from several
directions: **the curve can only ever pay out ETH that arrived.** That rests entirely on it never
buying back more than it sold — tokens exist outside the curve, and on a Snooze launch the
launcher holds the whole supply from block one — so the sell path refuses above `sold` and the
test drives that attack. It also checks the closed forms against `bond_model.py`'s (three
implementations, one answer), that the leftover at graduation is exactly `curveSupply/m`, that
the pool opens AT the curve's closing price rather than below it, and that a token which burns
part of a sale on its way in is priced on what arrived rather than on what was sent.

`bond_model.py` — 32, the curve's arithmetic derived and checked against a simulated walk up it:
the price multiple `((E0+R)/E0)²`, the real ETH to reach a multiple `E0(√m−1)`, the fraction sold
`1−1/√m`, and the graduation leftover `1/m`. It also settles the depth question, and not
the way the question is usually asked: a buy of `dE` at reserve `E` costs exactly `dE/E`, so the
number of buys it takes to bond is `ceil((√m−1)/x)` for a slippage `x` per buy — **and `E0` is
not in that formula.** Halving everyone's slippage exactly doubles the raise and leaves the
count untouched at 109 buys. Virtual ETH sets what a comfortable ticket is denominated in; it
does not buy depth. It also records the cliff that runs the wrong way: slippage improves all the
way up the curve and then gets 1.46× *worse* at graduation, because only the real ETH goes into
the pool and the virtual part does not exist to move.

`test/run-gate.mjs` — 45, compiles `contracts/SnoozeGate.sol`, which is the reason you need
$SNOOZE to get LAPTOP: an allocation claimable in proportion to what you held at one block. The
design question the suite is really about is that **a gate which makes people buy a token that
is expensive to exit is a trap** — so it checks there is no way for the contract to hold, lock
or take anybody's $SNOOZE at all (no `transferFrom`, nothing payable, no deposit or stake or
vault, and none of it in the ABI), alongside the ordinary Merkle work: somebody else's proof
does not work for you, a bigger number with a real proof does not work, there is no
`claimFor`, and after every attempt the gate still holds the whole allocation. The snapshot's
honest weakness — a balance at a block can be borrowed for one block — is written into the
contract rather than left for somebody to find.

`test/run-owner.mjs` — 39, the first launch driven as the owner's wallet would drive it. Two
claims, both about one address: **only** `0x4296…5929` can deploy the first token — not "should
not", cannot, checked by a stranger trying — and **every fee lands there**, in the same
transaction, with no call anywhere that could repoint it. It also refuses a vanity suffix an address cannot contain — PUMP, BEAR, MOON and ZZZ all need
letters that are not hex digits, and finding that out at grind time means waiting on a search
that can never finish. It drives the SNOOZE-to-bid gate too:
a holder buys, somebody holding none reverts, a stranger may pay *for* a holder because the
check is on who receives, and after the window anybody buys. The deployer's owner cannot be
transferred or renounced, a salt cannot be redeployed over, and after `seal()` not even the
owner can deploy again.

`test/run-deployable.mjs` — 32, the go/no-go before a wallet is opened: every runtime under
EIP-170 and every init code under EIP-3860 (the launchpad is the big one at 52.9% of the
limit), every constructor run with real encoded arguments, a full `launch()` sent from an
ordinary externally-owned account rather than from another contract, and gas measured against
the block limit — `launch()` deploys two contracts and makes five state-changing calls in one
transaction, and comes in at 7.2% of a 30M block. It writes `deploy/`.

`test/run-deploy.mjs` — 362, the deployment sequence in `deploy/scripts` sent step by step into
an in-process EVM, using the exact bytes `build.mjs` prints and `deploy/deploy.html` sends. It is
an execution rather than a grep because that is what found the thing that decides the shape of
the whole sequence: **`Snooze` deployed through `SnoozeDeployer` mints the entire supply to the
deployer contract and makes that contract the admin** — the constructor does
`balanceOf[msg.sender] = supply` and `admin = msg.sender`, and through CREATE2 `msg.sender` is
the deployer, whose ABI has no transfer, no rescue and no way to call `setPool`. The supply
would be unrecoverable and neither Snooze rule could ever fire, since `_move` gates the haircut
and the daily cap on the same `isPool[to] && !capExempt[from]`. So the suite measures that
outcome, and then drives the sequence that works: token from the owner's wallet, ground address
to the curve, fund before `setPool` (measured: the other order does not revert, it burns), then
`freeze()` and `seal()`, and finally a real buy that settles with `burnBps()` at 5000. It also
pins the two halves that keep the deploy button out of `web/`, checks every selector the page
hardcodes against keccak of its signature (nineteen of thirty-six were wrong when first
written), and asserts all eight transactions are byte-identical between the page and the
scripts.

`test/run-launchpad.mjs` — 37, `launch()` end to end: the wiring granted before any deposit
can arrive, the three-way distribution that could not settle by hand settling in one block,
every admin call from every party reverting afterwards, and the parameters it refuses.

`test/run-pooled.mjs` — 77, compiles `contracts/PooledLaunchBuy.sol` and executes it against a
hostile token (fee-on-transfer, returns-false, reentrant), a router that lies about its output
or keeps the ETH, a depositor that refuses ETH and one that reenters on receive. It reads the
ABI and fails if a sweep, rescue, withdraw or ownership function ever appears.

`test/test_launch_model.py` — 79, the reference model's properties: the knee is not a slope,
the size mix is normalised so no order can exceed the elicited total, destinations stay in
their own units, seed changes the answer at all (it did not before impact entered demand), the
round trip is identical across every deterrence guess, and the optimum is bimodal with almost
nothing where the old linear model put its recommendation.

## `web/launch.html` — and why it stops short of a recommendation

For whoever sets the launch parameters, not for buyers.

The first version swept a starting tax against one elasticity number and reported an optimum:
2% at the defaults. That number is gone, and what replaced it is worth stating plainly because
it is a negative result.

Two buyer types, each with a knee rather than a slope: snipers are near-unit-elastic to the buy
tax and nearly indifferent to the sell tax, since they are out in minutes; people are the
reverse, because a buy tax is a fee and a sell tax is a trap. Run that across 81 worlds — every
guessed parameter halved, kept, doubled — and the best starting tax is **bimodal**:

```
  0%  ############################################  44 worlds
  7%  ######                                         6
  8%  ##############                                14
  9%  #########                                      9
 10%  ########                                       8
```

Nothing between 1% and 6%. The old 2% sits in the gap: it is the answer a straight-line model
returns when the real surface is bimodal. `org_buy_knee` alone, halved or doubled, moves the
recommendation across the whole search range — and nothing in this environment can fit it,
because there is no network access and therefore no observed book.

So the page reports the histogram and refuses the rate. What it still reports without any
guess is what a buyer pays: the round trip is schedule arithmetic and is identical in all 81
worlds. A test changes a knee and asserts that section does not move.

**The ramp unit matters more than the rate**, and that is executed rather than argued in
`test/run-contract.mjs`:

| Unit | Splitting | Same-block fairness |
| --- | --- | --- |
| per buy | evaded — 11% split vs 2% whole for the same 10 ETH | four buys in one block, four rates |
| per volume | not evadable, prices splitter and whale alike | four buys in one block, four rates |
| per block | evaded by waiting instead | everyone in a block pays the same rate |

No unit is free. A per-buy ramp lands on the retail tail and barely prices the snipe, which is
backwards from the usual intent.

**Recycling does not change the rate.** The expectation was that routing the tax back into
the book would weaken the zero-tax result, since deeper liquidity improves later fills and so
changes later tax. Measured across all 81 worlds, treasury and recycling pick the *identical*
starting rate in 81 of 81. Recycling changes who benefits, not which rate is best — which is
also why the destinations are reported separately rather than compared.

**A broken world must not vote.** NaN fails every comparison, so a non-finite input was
skipped by the `>` that finds the best rate and dropped by the filter that builds the band —
reading as "nobody bought, take is zero" and then casting a ballot for the 0% mode, the exact
mode that carries the headline. Non-finite inputs are now flagged, score NaN rather than zero,
and are reported as excluded instead of counted. Found by an adversarial reviewer, not by the
suite, which is worth noting: the suite tested that degenerate inputs did not *crash*, not
that they did not silently *vote*.

**Two things that felt like findings and are not.** "Deeper seed beats a tax" wins in 47 of 81
worlds and loses 26 — not robust. And an early draft's LP and burn "wealth" figures were
circular: they marked holdings at a price the model itself moved, reduced algebraically to
exactly `2E`, and reported 11,214 ETH at an end price 11,000× the start. Destinations are now
reported in their own units — ETH withdrawn, depth added, supply removed — and never summed.

Seed did nothing at all until price impact entered the demand decision. A buyer prices tax plus
pool fee plus the impact of their own size against the depth on offer, and impact is the only
channel through which seed and tax are substitutes.

`launch_model.py` is the reference implementation and the page mirrors it; where they disagree
the Python is right, the same arrangement `size.html` has with `test_size_math.py`.

The page is not linked from the buyer navigation — operator tool, reachable by URL. Still a
static file on a public site, so not secret, just not advertised.

## Launching — read `deploy/scripts/README.md` first

**The runbook for the launch this repository can actually perform is
[`deploy/scripts/README.md`](deploy/scripts/README.md)** — seven steps, sent from your own
wallet, through `deploy/scripts` or `deploy/deploy.html`. `LAUNCH.md` below is the design
record and the launchpad path, which `LAUNCH.md` §2.2 itself shows cannot complete on Base.

### The design record — `LAUNCH.md`

[`LAUNCH.md`](LAUNCH.md) is the runbook: what only you can decide, what has to exist before the
launch transaction, the sequence, and what can still go wrong afterwards. Three things in it are
worth naming here because they change what is possible rather than what is advisable.

**One wallet is outside both rules.** `launch()` cap-exempts the launcher so it can seed the
pool — seeding and selling are the same transfer — and `_move()` guards the haircut with
`if (isPool[to] && !capExempt[from])`, so the flag that skips the cap skips the burn too. That
wallet holds 100% of supply the moment the token exists. Measured at a 50% dial: an ordinary
holder is refused above 20% and burns half of what it does sell; the exempt one sells its entire
balance and burns nothing. Every page that said the rules applied "to everyone, including whoever
deployed it" was wrong; `test/run-snooze.mjs` now pins the behaviour and `test/run-index.mjs`
fails if the sentence comes back.

**The TWAP oracle is not in this repository**, and a reverting one is a permanent honeypot —
sells revert, buys do not, and the address is immutable.

**No router on Base implements the interface `PooledLaunchBuy` calls.** It wants
`swapExactETHForTokens(address,uint256,address)`, selector `0x1930789c`; the Uniswap-V2 family
and Aerodrome have `0x7ff36ab5`. Worse, `launch()` passes one address as both the router the
pooled buy calls and the pool Rule 1 taxes, and nothing deployed is both. `LAUNCH.md` §2.2 works
through the three shapes that follow from that, one of which is broken in a way that looks
correct.

## Snooze — the launch machinery

> **The relationship between $SNOOZE and LAPTOP is not settled, and this section describes the
> contracts, not the product.** An earlier version of the site said "LAPTOP is the first launch
> on $SNOOZE". That was invented here and it is wrong — the two are separate tokens on Base,
> and what is actually known is that holding $SNOOZE is how you get into LAPTOP. The contracts
> below deploy a token that carries the two rules; whether LAPTOP is one of them is an open
> question, not a fact this repo should be asserting.

Every token launched through `SnoozeLaunchpad` carries the two rules, and `$SNOOZE` is
the first ticker on it.

**`contracts/SnoozeLaunchpad.sol` exists for exactly one reason,** and it is not convenience.
`test/run-wiring.mjs` showed that a launcher who wires `Snooze` to `PooledLaunchBuy` by hand
produces a distribution that **cannot complete**: `claim()` is an outbound transfer, so the
20%/day cap applies, and anyone owed more than 20% of the bag is refused forever. Both
contracts pass their own suites throughout. The launcher finds out on distribution day, with
the money already in.

`launch()` grants the exemption in the same transaction that deploys both contracts, before a
single deposit can arrive. The bug is not documented, it is unmakeable.

**Zero discretion after launch.** The launchpad holds the token's admin rights for the length
of one transaction and gives them up inside it: register the venue, exempt the distributor,
hand the supply to the launcher, freeze. After `launch()` returns there is no address — not
the launcher, not the launchpad, not its deployer — that can change a pool, an exemption or a
rule. Asserted from both sides: every admin call from every party reverts, and the launchpad's
ABI contains no admin surface at all, with `launch` as its only state-changing function.

The trade is stated rather than hidden: a venue created after the freeze is permanently
outside the rules, because the only alternative is keeping a key that can rewrite them.

**What it refuses, before the money is in.** Zero supply, a dev cut above 20% of the haircut,
a refund window that closes before it opens or is shorter than a day, an exit fee that
confiscates the deposit, a missing oracle. `validate()` is `pure`, so a page can check a
proposed launch without sending anything.

**`earlyStaysBetter()`** puts the decay condition on chain:
`spot(n+1)·(10000−τ(n)) > spot(n)·(10000−τ(n+1))`. A tax that decays faster than the price
climbs makes later buyers cheaper all-in, so waiting becomes dominant — and because the tax
only decays *on buys*, the relief needs the buys that waiting prevents. It deadlocks. A
launcher and a page now check that with the same arithmetic instead of a spreadsheet.

**The bug was so easy to make that I made it again writing the fix.** The `Snooze` constructor
mints to the launchpad, and the launchpad is subject to Rule 2 like everything else — so
handing the supply on is an outbound transfer of 100% of a balance and reverts at 20%. The
contract whose entire purpose is preventing that bug hit it on its own first transaction. It
now exempts itself, and the exemption dies with the freeze three lines later.

## `$SNOOZE` — the mechanism, and where it does not do what it says

*You snooze, you win.* Two rules, in `contracts/Snooze.sol`, compiled and executed by
`test/run-snooze.mjs`:

1. **You sell at yesterday's price.** If spot is above the 24-hour average, only `twap/spot`
   of what you send reaches the pool and the rest burns. `burnBps = (spot − twap)/spot`. At
   spot 70% over the average that is **41%** — the number on the dial.
2. **Nobody can nuke it.** No wallet *sells* more than 20% of its balance per rolling day,
   baselined on the balance at the *start* of the window. Charging 20% of the current balance
   each time would allow 20%, then 20% of the remaining 80%, and so on.

   It used to cap every outbound transfer, and that had to change. The cap is 20% of a balance
   that INCLUDES the amount being sent, so a contract receiving N and forwarding N needs
   `N ≤ 0.2(B+N)`, i.e. four times the trade parked permanently — which is the shape of every
   router, aggregator, settler and wallet swap widget, so they reverted on **buys** as well as
   sells. A deposit address sweeping 100% of its balance could never be emptied: measured, it
   stranded 400 of 500 tokens and then the allowance floored to zero. What the wider rule
   bought was "moving to a fresh wallet is throttled too", and it bought nothing, because the
   cap is split-invariant either way — one wallet with B sells 0.2B a day, and n wallets
   holding B/n each sell 0.2B/n, the same 0.2B. It cost every integration on Base to prevent
   something that was never possible. `run-snooze.mjs` drives both halves of that.

   One consequence worth recording: this removed the wiring bug the launchpad was built to
   prevent. `claim()` is a transfer to a plain address, not a sell, so a distribution completes
   with no exemption at all. `capExempt` now means exactly one thing — this holder may sell
   without the cap and without the burn — which is the launcher's exemption and nothing else.

**Three of the pitch's claims are false as written, and the tests say so rather than the
marketing.** Each is asserted in `run-snooze.mjs` and stated on the page itself.

- **A dump is free.** `burnBps` is zero whenever spot ≤ twap, which is what a downtrend *is*.
  Selling into a crash costs nothing. Rule 1 taxes selling into strength only, so "dumpers
  fund the burn" is not true of the dumpers that matter. Rule 2 is the only brake on a dump.
- **Sleeping on it does not bank the spike.** Tomorrow you are paid `min(spot, twap)` again.
  If the price fell back overnight you get the fallen price. Waiting swaps a certain haircut
  for an uncertain price — a real trade, but not the one the slogan describes.
- **"A five-day drip" is a decay rate, not a deadline.** A wallet moving its full 20% daily
  still holds 32.8% after five days and 10.7% after ten. Tokens are uncapped at rest and each
  fresh wallet gets its own 20%, so a determined exit spreads and drips in parallel.

And two more the tests pin: **day one has no Rule 1 at all**, because a 24-hour average needs
24 hours — so "snipers get nothing" fails on exactly the day snipers care about, and the dial
shows *warming up* rather than a reassuring 0%. And the two rules **compose**: a 30% sale
reverts on Rule 2 before Rule 1 is ever computed, so the dial's percentage is not the whole
cost of leaving.

**The dev-pay contradiction is resolved by refusing it.** Supply-only-falls and
dev-paid-from-the-burn cannot both hold, because burnt tokens are gone. `devBps` defaults to
zero, is capped at 20% *of the haircut* (never of the trade), and is immutable. The contract
answers the question itself: `supplyOnlyFalls()` returns false the moment any part of the
haircut is paid out instead of destroyed, so the page cannot claim it by accident.

**It is not a novel mechanism.** A transfer haircut plus a max-transaction limit is one of the
most-deployed token shapes there is; it was everywhere in 2021. The reason it is out of favour
is not missing tooling — it is that the same shape is what honeypots are built from, and every
scanner flags it. What is different here is that the parameters are published, the admin keys
are freezable, and `quoteSell()` is the same code the transfer path runs, so the dial and the
trade cannot drift apart. That is a real difference and it is not a different mechanism.

The daily cap also breaks things that are not attacks: exchange deposits, bridges, aggregator
routes, lending markets and LP withdrawals routinely move more than 20% of a balance at once.
They fail, and a failed sell looks exactly like a honeypot to someone who does not know the
rule.

## Rule 3 — `$DREAM`, and being paid for not selling

Rules 1 and 2 are both frictions on leaving, and the section above is mostly an account of how
little either really does: Rule 1's haircut is **zero in exactly the downtrend you would most
want it to bite in**, and Rule 2 reshapes an exit rather than stopping it. Neither pays anybody
for staying. Rule 3 is the only mechanism here pointed the other way, and it is the only one
whose value can be stated as arithmetic rather than as a hope.

**Hold `$SNOOZE` without sending any out and you accrue `$DREAM`.** Nothing is staked, nothing
is escrowed, no approval is given and no transaction starts it — the accrual runs inside the
token's own `_move`, so holding *is* the position. `contracts/SnoozeDream.sol` is the reward
token and does nothing but mint when `Snooze` tells it to; the clock, the ramp and the reset
all live in `Snooze` itself.

### The one number, and it is exact

**One `$SNOOZE` held untouched for the 90-day ramp accrues exactly one `$DREAM`.** Both tokens
have nine decimals, so that is a count and not a conversion — an equivalent token, for doing
nothing. It is an equality rather than an approximation, and `test/run-dream.mjs` asserts it as
one against the compiled contract.

The rate ramps linearly for `RAMP` and is flat after, so the accrual from age 0 to age `a` is

```
(min(a,R)² + 2R·max(a−R,0)) / R²        R = 90 days = 7,776,000 seconds
```

which is `1` at `a = R` by construction. Three consequences, and the second is the one people
get wrong:

| held | DREAM per SNOOZE | |
| ---: | ---: | --- |
| 1 day | 0.000123 | the first day is worth 1/8100th of the bag |
| 45 days | 0.250000 | **a quarter, not a half** |
| 90 days | 1.000000 | one for one |
| 180 days | 3.000000 | not two |
| 360 days | 7.000000 | it never stops |

**The ramp is quadratic and almost everybody reads it as linear.** Half the time is a quarter
of the reward. It is back-loaded deliberately — the reward is for the ninetieth day, not the
first — but a launch that lets people discover that at day 45 has mis-sold it, so the page
leads with the table rather than with the headline.

### What breaks a streak, and what it costs

**Any outbound transfer, and "any" is meant.** A sale, a move to your own second wallet, an
exchange deposit, sending a friend one base unit. From inside a transfer those are the same
event and no attempt is made to tell them apart — a rule that took your word for which was
which would be farmed with two wallets before lunch.

**What is lost is the RATE, not the bank.** Everything accrued is banked and stays claimable
forever; the clock goes back to zero. A matured streak earns exactly twice what a fresh one
does, forever, so breaking one costs one SNOOZE-equivalent per SNOOZE held over a 90-day
look-ahead. That gap is the entire mechanism.

**Emptying the wallet ends it properly.** Sell everything, wait three months, buy back, and you
start from zero rather than from where you left off — a wallet holding none of the token has no
streak to resume. Without that, the ramp is farmable while holding none of it, and
`test/run-dream.mjs` drives exactly that attack.

**Claiming does not break it.** Nothing leaves your wallet, so there is nothing to break.
Neither does receiving more, and a top-up rides the clock you already have on the whole bag —
which is why adding to a streaked wallet beats starting a fresh one.

### What it is not, and what it costs everybody

- **`$DREAM` is not capped.** After the ramp the rate is flat rather than zero, so emission
  continues for as long as anybody holds — two per SNOOZE every 90 days, forever. Anyone
  describing it as scarce is describing a different token, and `SnoozeDream.sol` says so on its
  own face rather than only on the site.
- **It is not backed and not a claim on anything.** No ETH, no treasury, no redemption, no
  share of fees, no claim on the curve or the pool. The contract mints a count; it cannot mint
  a bid.
- **Every holder pays for it.** The bookkeeping runs inside every transfer, so an ordinary
  wallet-to-wallet send costs **57,262 execution gas** whether or not that holder ever claims.
  That is measured in the suite, not estimated.
- **The pool and the launcher earn none of it.** Registered pools and the one cap-exempt owner
  wallet accrue nothing, so the launcher cannot farm the reward for holding its own float.
- **It can be left switched off, permanently.** `setDream` is callable once, before `freeze()`,
  and never repointable. Skipping it is a real choice and not a recoverable one: accrual keeps
  running for every holder and `claimDream()` reverts `DreamNotSet()` forever. Step 6 of the
  deploy sequence exists to make that a decision rather than an oversight.

**And none of it is a reason to expect a price.** Three rules that slow exits and pay for
patience do not make anybody want the token. They are plumbing.

## `snooze.py` — the launch in one file

```
python3 snooze.py                 # the deploy console, in a browser
python3 snooze.py selftest        # 45 checks against published vectors
python3 snooze.py optimize        # the parameters, and the price of each trade-off
python3 snooze.py simulate        # what Rule 3 is worth, under named assumptions
```

One file, standard library only — no pip install, no node, no wallet library, no build step.
It opens a localhost console that walks the seven-step launch, draws the curve and the Rule 3
ramp, and solves for the parameters before any of them become immutable. Keccak-256, RLP, ABI
encoding and both address derivations are written out in it rather than imported, for the same
reason `deploy/scripts/lib/abi.mjs` writes out its own: a library's bug in that position is
indistinguishable from a bug in the contract, and what it produces is a correct-looking address
holding the wrong parameter forever.

**It never touches a private key.** There is no `--key`, no keystore reader, no mnemonic
prompt, and no import that *could* sign — `selftest` parses its own AST and asserts every
import is on a standard-library allowlist, which is a stronger check than grepping for
`secp256k1` and does not fail itself the way the first version did. The RPC client has eight
read methods and calling anything else raises before a socket opens. It builds `{to, data,
value}`; your wallet signs.

**`optimize` is not a pump button, and its two scoring bugs are worth recording** because both
are ways a weighted sum of plausible terms produces nonsense:

1. It scored the launcher's end share *and* the graduation multiple. The launcher share is
   `0.2 + 0.8/m` — a monotone function of the multiple, so the same axis was counted twice and
   outvoted whether the raise was plausible at all. It recommended a virtual reserve of 0.5 ETH,
   where **one buyer with 1 ETH takes two-thirds of everything the curve will ever sell**.
2. Fixing that, it pinned the bond target to the top of the grid. `reach` was `1/(1+(R/ref)²)`,
   which for a large raise is already so near zero that going from 15 ETH to 30 costs almost
   nothing while the multiple kept paying. **A sum lets a term that has run out of room stop
   objecting.**

The score is now a product: `reach` is a probability and the rest is a value, and a graduation
multiple you only reach in a world that does not arrive is worth its multiple times zero.
Cornering and the launcher share are hard disqualifiers rather than scores. On the shipped curve
it reports what `deploy/config.json`'s own `_relaunch` note already admits — that at
`virtualEth` 2 ETH **a single 1 ETH buy takes a third of the float** — and prints the frontier
rather than one answer, because there is no setting that is both hard to corner and quick to
graduate. When the optimum lands exactly on a constraint it says so, since then the constraint
picked it and the score only broke the tie.

**What it does not have, deliberately:** no order placement, no multi-wallet fleet, no volume
generation, and no scheduler that buys from itself to draw a shape on a chart. Manufactured
volume works by convincing somebody the demand is real, which makes the person on the other
side of it the product.

## `pumpfun.py` — the Solana launch, and the one script that holds a key

```
export SOLANA_RPC='https://…your-provider…/your-key'     # never in a file, never in argv
python3 pumpfun.py size                                  # what a dev buy actually buys
python3 pumpfun.py launch --keypair ./launch.json --dev-buy 1.0 \
    --name "Snooze Bear" --symbol SNOOZE --image ./snooze.png --dry-run
python3 pumpfun.py watch <mint> --minutes 5              # who really bought
```

**Create and buy in ONE transaction, and that is the whole design.** Snipers buy in the block
the mint is created in; you cannot out-race them and this does not try. Putting the create and
your buy in the same transaction means there is no gap to occupy — you hold the first slice at
the opening price by construction rather than by winning a race. Everything after that block is
a real market and this script has no opinion about it.

### What it refuses, and why they are refusals rather than gaps

- **No child wallets.** Splitting the opening buy across wallets you own exists to make the
  top-holders view look distributed when one person holds the float. Bundle checkers and bubble
  maps find it in seconds, and *bundled* is a label that does not come off. There is no
  `--wallets` flag, and `test/test_pumpfun_py.py` asserts no flag of that shape exists.
- **No self-trading.** Selling from wallets you control does not remove a sniper — by the time
  you sell they already hold, and your sell is their cheaper re-entry. What it does is
  manufacture volume that retail reads as organic, which makes the person on the other side of
  it the product. The suite asserts the only action ever requested of the builder is `create`.
- **`--dev-buy` has no default.** pump.fun opens at ~30 virtual SOL, so a buy of `R` takes
  `R/(30+R)` of the float — the same identity as the SNOOZE curve, and it depends on `R` alone.
  1 SOL is 3.2%, 1.5 is 4.8%, 2 is 6.25% and starts reading as dev-owned. There is no size that
  is both a meaningful position and invisible, so the script prints the table and makes you
  choose.

### The key, which is the part that changed

Every other tool here holds no key — Base's deploy console never did, because a browser wallet
signed and the scripts only built bytes. **Solana has no equivalent path**: a script that
submits a transaction must sign it. So the rule got narrower rather than weaker, and each part
is tested rather than promised:

- read from a **file** in the standard Solana CLI format and from nowhere else — never an
  argument, never an environment variable, never a prompt, none of which stay out of shell
  history or `/proc/<pid>/cmdline`;
- the file's halves must agree, and a **world-readable** key file is refused;
- **a wallet holding more than the launch needs is refused outright.** 40 SOL is not headroom,
  it is the wrong file, and pointing this at a main wallet is the most expensive mistake
  available. `--headroom` moves the line; the default is 0.5 SOL above the dev buy;
- the secret half is never printed, logged, or in a `repr`.

### And nothing is signed blind

pump.fun's builder composes the transaction, which means a third party writes the bytes your key
is about to authorise. So they are taken apart first — this is the reason the file is worth more
than a `curl`:

- **structural**: the fee payer is you, the only signers are you and the mint you just
  generated, every program it invokes is one this launch needs, and a v0 transaction carrying
  **address-table lookups is refused** because those name accounts it cannot show you;
- **economic, and layout-independent**: the transaction is **simulated against the live
  cluster** and the payer's balance change is read back. An instruction encoding nobody here can
  decode still cannot move more lamports than the simulation says it moves. Over your authorised
  amount plus a fee ceiling, it refuses.

`--dry-run` stops there: built, decoded, simulated, printed, nothing signed. Run it once before
you ever run it without.

After sending it reads the result back, because *it confirmed* is not *you hold tokens* — the
buy is a separate instruction inside the same transaction and a slippage failure there is a
create with no position. Zero tokens is a loud error naming the signature, not a success.

**`watch` reads public data only** and is deliberately layout-independent: it takes token
balance deltas out of transaction metadata rather than decoding pump.fun's instructions, so it
cannot be wrong about a trade because a program changed its encoding. It reports distinct
buyers, how fast the first one after you arrived, and what share the top ten took — the snipers,
seen rather than guessed at.

**It has never touched mainnet.** The signing, the decoding and the arithmetic are checked
against RFC 8032 and against transactions built byte by byte in the suite. The live path is not,
and it moves real money. Rehearse, then use the smallest dev buy you are willing to lose.

## `contracts/PooledLaunchBuy.sol` — consolidate, buy once, distribute

Customers deposit, the orders consolidate, one buy happens at launch, tokens are distributed
pro-rata. That is the arrangement `slot.html` warns about — *somebody holds your money and
promises* — so this is written to make the warning not apply: the funds sit in a contract
nobody can divert, including whoever deployed it.

- no sweep, rescue, withdraw, drain or redirectable fee address, and a test reads the ABI and
  fails if one ever appears
- `execute()` is permissionless, so the operator cannot hold the round hostage and it still
  completes if they vanish
- `refund()` is permissionless and unconditional after the deadline
- router, token and both deadlines immutable, set at construction
- the early-exit fee stays in the pool for the people who did **not** leave. It is not paid to
  the operator: an exit fee that pays the operator gives the party holding the money a reason
  to want people gone. Tested — the deployer's token balance is asserted to be exactly zero.

**The limit that cannot be engineered away.** The deployer chooses the router and the token,
and `execute()` hands the router the entire pooled balance. A deployer who points `router` at
a contract they control takes every deposit and returns a `token` they also control. Nothing
inside the contract fixes that. What it does instead is make both addresses immutable and
public *before* anyone deposits, so the check is external and belongs to the depositor: read
`router()` and `token()`, confirm they are the real ones, then send money.

**Two fund-loss bugs, both caught before this was ever deployable.**

The first I found by writing the test for a case I suspected: if every depositor exits early,
`totalDeposited` is zero but the forfeited fees remain, and `execute()` would spend them and
mint tokens nobody could ever claim — `claim()` divides by `totalDeposited` and `refund()` is
closed once `executed` is set. `execute()` now refuses a round with no depositors.

The second came from an adversarial review across six attacker lenses, and it was worse:
`execute()` had no upper time bound, so it could be called long after `refundAfter` and
convert everyone's refundable ETH into tokens. The unconditional-refund promise — the thing
that makes the contract safe to deposit into at all — **was false**. The buy window now closes
at `refundAfter`.

The same review killed two more: `tokensReceived` took `min(actual, reported)`, so an
under-reporting router stranded the difference forever; and `receive()` rejecting all ETH
would have bricked execution against any real router that returns change.

**Not audited, not on a testnet.** An in-process EVM has no PoolManager, no real router, no
mempool, no gas market and no reorgs. Pooled-custody contracts are where unaudited code loses
everything at once, and the critical bug above was invisible until six adversarial readers
went at it.

## `contracts/LaunchTaxRamp.sol` — the tax, executed

LAPTOP as shipped is a plain OFT with no tax, so any tax lives in a v4 hook, and the hook is
the thing that has to be right. This contract is only the fee arithmetic — the schedule, its
cap, its turn-off, its exemptions. It holds no funds and cannot move a token.

solc ships as WASM and `@ethereumjs/evm` is a real interpreter, so it compiles and its opcodes
execute with no network. **This is not a testnet.** There is no PoolManager here, so the hook
integration — unlock/settle accounting, the delta the hook returns, reentrancy across the lock
— is untested, and that is where the risk lives. Audit the hook, not the OFT.

What execution pins: the first taxed buy pays exactly the starting rate because counters are
read before they advance; the pool prices the net so the fee never lands on the tax; the sell
tax is flat and applies to pool output rather than the typed notional; the seed LP is exempt
from the constructor with no window before it, and an exempt trade does not advance the ramp,
so the operator's own seeding cannot push the first real buyer past the published rate.

The exemption list is freezable, and should be frozen. An exemption list the operator can edit
after launch is one they can lift for their own wallets, and a buyer cannot tell that from the
outside.


## `web/slot.html` — getting a slot

The demand is real and it keeps coming back: *people want to buy before launch, or at least put
money in to guarantee a slot.* The page answers it rather than refusing it.

**You cannot buy a token that does not exist.** There is no contract, no supply and no pool, so
nothing can be transferred to you. Sending money before launch is not a purchase — it is
**unsecured lending to whoever will control the launch**, against a promise to deliver later.
That is a credit decision, and the only questions that matter are what forces them to deliver and
what happens to your money if they don't. That is not an argument against preorders; it is the
question a preorder has to answer, and most don't answer it at all.

Four mechanisms, ranked by who has to be trusted:

| | Mechanism | You must trust | If they don't deliver |
| --- | --- | --- | --- |
| 1 | **Allowlist** — your address in a root the launch contract checks | that they honour the list | you lost nothing; you never sent anything |
| 2 | **Standing order** — a signed off-chain order | nobody | you keep the money |
| 3 | **Deposit contract with a unilateral exit** — *you* call withdraw | the code, and that it can't change | your money is stuck or gone |
| 4 | **Sending money to somebody** | everything, with no recourse | there is no step after this one |

### The argument that settles it

Everything people actually want from a preorder — a guaranteed allocation, a known price, not
having to win a gas war at the open — **an allowlist delivers all three without anyone holding
your money.** So there is exactly one thing a deposit adds: the launcher gets the money early.
That can be a legitimate need, but it means when someone insists on custody, custody *is* the
feature, and the depositor is financing it. The page says that once and moves on.

### The checker

Paste an address someone told you to deposit into, and it reports facts about whether you could
get your money back. Never a safety rating — a contract can pass every check here and still be
built to take your money, and the page says so on every result.

- **Is there code at all** — an EOA cannot enforce a refund, a deadline or an allocation.
- **Upgradeability**, via all four proxy storage slots (EIP-1967 implementation, admin and
  beacon, plus the legacy OpenZeppelin slot). This is the check that outweighs the rest: if the
  logic can be swapped, the rules you deposited under can be rewritten afterwards.
- **A reachable exit**, by scanning the dispatch table for `withdraw()`, `refund()`,
  `claimRefund()` and friends. Absence on a non-proxy is strong evidence there is no way out;
  four specific bytes colliding by chance is about 1 in 2³². Presence is reported as *the
  function exists*, never as *you can get a refund*.
- **Privileged controls and ownership** — with `owner()` returning nothing, returning the zero
  address, and reverting kept as three distinct states rather than collapsed into one.

The interaction that matters most is encoded rather than left to the reader: **on a proxy the
exit scan is suppressed entirely**, because the bytecode at the address is a stub and the real
logic lives somewhere that can be replaced. Reporting a `withdraw()` found in a proxy stub would
be reading the wrong contract.

Same result-length discipline as the rest of the repo: 32 zero bytes means the contract answered
*none*; a short answer, a revert or a transport failure means *could not check*. They are never
merged, because merging them is how a tool invents a fact. A blocked endpoint reports "nothing
was checked" and explicitly says that is not a statement about the address.

### The launcher's checklist

The mirror image, since the same properties that protect a buyer are what let a launcher be
believed: publish a merkle root rather than a deposit address; fix price and per-address cap on
chain before anyone commits; if you must take deposits make the exit caller-initiated with an
on-chain deadline and no single-key drain; don't deploy it behind a proxy.

## `web/order.html` — sign once and walk away

The need this answers, in the customer's words: *put money in before launch, don't be awake for
it, get filled near the opening price, and take the money back if it doesn't happen.*

**Three of those four are deliverable. The fill is not.** A fill needs a counterparty, and no
signature, contract or service conjures one. Guaranteed fill and guaranteed price are opposites:
a market buy at open guarantees you end up holding something, at whatever price the first blocks
decide; a signed standing order guarantees you never pay above your number, and may simply not
fill. The page puts both halves side by side and refuses to pretend otherwise.

The mechanism is an **off-chain EIP-712 order on an established settlement protocol** — not a
contract written for one launch, including one written here, which is why there isn't one. It
decomposes cleanly, which is the whole argument for it:

| FR | DP |
| --- | --- |
| Commit without a second signature at execution | A signed off-chain order on an existing settlement layer |
| Bound the price paid | The order's limit price |
| Recover the funds at any time | Cancellation — and beneath it, funds that never left the wallet |
| Know that it executed | The protocol's own notifications, the wallet, or an explorer watch |

That matrix is **decoupled**: pick the settlement layer first and the other three follow from it.
An escrow contract holding deposits routes *every* FR through one DP — it is **coupled**, with a
single point of failure and an operator you have to trust — which is the principled version of
why this repo doesn't ship one. "Withdraw at any time" is also not a withdrawal in the signed
design: the money never moved, so there is nothing to withdraw.

### The ceiling has to clear your own slippage

The quiet failure mode is setting the ceiling at the price you saw, so your own order pushes the
price past it and it can never fill. For a constant-product pool seeded with `E` on the quote
side, a buy of `S` pays

```
effective price = seed price × ( 1/(1-fee) + S/E )
```

Exact, not an approximation — `out = T·S'/(E+S')` with `S' = S(1-f)`, so the ratio to `E/T`
collapses to `1/(1-f) + S/E`. Spend a tenth of the quote side and you pay about a tenth over
seed, plus the fee; spend the whole depth and you pay more than double. The page inverts it too:
given a ceiling you like, the largest order that still fits under it is `E·(C - 1/(1-f))`, and a
ceiling below `1/(1-f)` admits nothing at any size, because the fee alone exceeds it.

The seed depth is a guess, so the page always shows the answer across a range of depths rather
than one number.

### Splitting: the tests corrected the page

The first draft claimed constant-product pricing is path-independent, so splitting an order into
tranches costs nothing. **The test suite caught that as false.** The fee stays *in* the pool, so
each tranche deepens it against the next one and the input reserve grows by the full input rather
than the post-fee amount. Splitting against an untouched pool is therefore slightly **worse**:

| Tranches | vs one order |
| --- | --- |
| 2 | −0.0065% |
| 4 | −0.0098% |
| 10 | −0.0118% |
| 100 | −0.0131% |

Two laws come out of it, and both are asserted rather than described: **n tranches pay
`(1 − 1/n)` of a ceiling**, and that ceiling is about **half the pool fee times your share of the
pool** while the share is small (the rule over-predicts badly once your share approaches the
whole pool — also tested). So the folklore is wrong twice: a split is not free, and against a
static pool it is never the cheaper path. Split to reduce how wrong you can be — an open spikes
and settles, and one order at the top fills at the top — and price it as insurance you pay a
little for, not as a discount.

### What it refuses to do

No wallet, no signing, no network request of any kind — same rule as the buy screen, for the same
reason: this domain cannot defend against being cloned, and a clone that can ask for a wallet
drains people rather than merely misleading them. It hands off to CoW Swap and 1inch with the
LAPTOP address printed for character-by-character comparison, and **every deep link is marked
unverified from here** and paired with a manual recipe, because this environment has no egress
and could not check any of them.

It also states the parts nobody puts in the UI: the approval is the real risk surface, not the
order (approve the exact amount, never unlimited); cancellation is a race only when the order is
fillable right now, which is the one asterisk on "withdraw at any time"; the page cannot notify
you of a fill because it only runs while you're looking at it, so the notification has to come
from the order book, the wallet, or an explorer watch — set up *before* signing, since "your
order filled, click to claim" is a message to expect and ignore. And the likeliest way a
launch-day order dies is not price at all: **fillers route through liquidity they have indexed,
and a pool minutes old may not be in that set.**

## `web/index.html` — where to buy, and the landing page

The go-to question on launch day is not "can I swap here", it is **"which venue actually gives
me the most LAPTOP for the size I intend"** — and nobody answers that for a new pool. Every
aggregator routes for you and shows one number; none of them show you what the alternatives
would have paid, and on a thin launch pool the gap is large.

Enter an amount, and it reads the Uniswap V2 pair, all seven Base V3 fee tiers, both Aerodrome
pools and the v4 PoolManager, prices your exact size against each using the same math as the
size curve, and ranks them by what you end up holding. It then states the spread in the terms
that matter: *picking the best venue instead of the worst is worth N LAPTOP on this size — X%
more for the same money.*

Everything the rest of the repo insists on carries over. The chain is confirmed before anything
is priced. Constant-product venues are exact; concentrated ones are labelled a best case. A fill
can never exceed what the pool actually holds. Aerodrome stable pools are declined rather than
priced with the wrong curve. Venues that could not be read are listed under "not priced" instead
of quietly dropped, so the ranking is always scoped to what was actually read. The v4 gate is
reported either way — an empty PoolManager proves the branch negative in one call, and a
non-empty one says plainly that hooked v4 pools cannot be enumerated and may hold a better or
worse fill than anything listed.

**The pages connect to Phantom, and still cannot spend your money.** This was a deliberate
reversal, and the cost is real, so it is written down rather than quietly dropped.

The old position was that the site should never prompt for a wallet at all. The argument was
that the one thing this repo cannot defend against is being cloned at another address; while
the site never prompts, a clone can only lie to you, and the moment the domain teaches people
to connect, a clone's identical prompt drains them instead. That argument has not been refuted
— it was overruled, because customers need to connect, and a tool nobody can use protects
nobody.

What replaces it is a narrower rule chosen because it can be enforced rather than promised:
**these pages connect and read, and never ask you to sign.** They call `eth_requestAccounts`,
`eth_chainId`, `eth_getBalance` and `eth_call`, and nothing else. A test parses every page for
every `eth_*` method it mentions and fails on anything outside that list, so a signing or
sending call cannot be added to any page without the suite going red. That is a weaker defence
than "we never prompt" and it is worth being plain about why: a clone can now copy the connect
button too. The remaining check is the one that was always doing the real work — the URL.

**Phantom ships two wallets, and only one of them can see Base.** `window.phantom.solana` and
`window.phantom.ethereum` hold different keys and see different chains. LAPTOP is on Base,
which is EVM, so a customer who connects or bridges to their Phantom *Solana* address has put
money somewhere that cannot buy the token. Every page reaches for the EVM provider, detects the
Solana-only case specifically, and says so in those words instead of reporting "no wallet
found" — which would be a lie that costs a bridge to the wrong chain.

Balance reads follow the same discipline as every other read here: 32 bytes is an answer, and
a bare `0x`, short data, a revert or a throw is "could not read", never zero.

Venue links carry the contract address so nobody retypes it, and the pool address is printed
beside each link so what the venue loaded can be checked against what was read here.

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

## Branding: `web/bg.png`

All eight pages carry a full-bleed background image. It is the only piece of branding on them —
no ticker chips, no watermark layer, and no token named anywhere but LAPTOP. A test asserts
that across every page.

**`web/bg.png` is in the repo** (added in `bed883f`) and appears on all eight pages.
It is the only external asset any page loads, it is same-origin, and it is referenced from
exactly one decorative CSS rule and never from script. So if the file is missing, blocked by
CSP, or the HTML is saved and opened offline, the pages lose a picture and nothing else — every
verdict, number and failure state is untouched. A test asserts that no script references it.

Recommended: a wide image (roughly 16:9), under ~300KB. It renders at 12% opacity under a light
scrim, on cards that sit on a 92%-opaque white, so nothing ever competes with a verdict someone
is reading in a hurry. Tests assert the art stays below 35% opacity, sits behind the content with
`pointer-events:none`, the scrim exists on its own layer at full strength (on the art layer it
would inherit that layer's opacity and do nothing), and — rather than any proxy for legibility —
that the verdict text, the heading and the sub-line each clear **WCAG AA contrast** once every
translucent layer between the glyph and the page is actually composited, against the darkest
artwork the page could be given.

The six LAPTOP pages are one light theme in the Ethereum register: a lavender-white ground, dark
slate text, and the ETH blue-violet as the single accent, used for the primary action and nothing
else. Every colour in `:root` was chosen against the composited ground rather than against a
swatch, which is the only reason they are the exact values they are — the contrast assertion
fails on a regression, and it was verified to fail by lightening `--dim` and watching the
sub-line assertion break.

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
