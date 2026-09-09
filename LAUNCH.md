# Preparing $SNOOZE for launch

Read the next three paragraphs before anything else.

Four contracts in this repository compile with solc 0.8.36 and execute against an in-process
EVM. **They have never been on a testnet and no human has audited them.** They have never met a
real AMM, a real mempool, a real gas market or a reorg. `PooledLaunchBuy` is a pooled-custody
contract, which is the exact shape in which unaudited code loses everybody's money at once, and
its worst bug so far — an `execute()` window with no upper bound, which made the refund promise
false — was invisible until somebody went looking for it adversarially.

**There are two hard blockers that no choice of parameters can work around**, and one design
finding that changes what you can honestly claim. All three are below. Nothing in this document
is a recommendation to launch; it is what launching would actually require.

Everything here was checked against the code rather than against the comments. Where a claim is
proved by a test, the test is named.

---

## 0. The shape of this launch, as you specified it

| | |
| --- | --- |
| Owner, and the only address that may deploy | `0x4296e9A65582358221EEd0e9A2B4EC94ad4F5929` |
| Every fee | the same address, immutable everywhere it appears |
| First token | **Snooze Bear**, ticker **SNOOZE** |
| Second | **LAPTOP**, on its own curve, gated on holding SNOOZE at launch |
| Chain | Base, 8453, and nothing else |
| Site | snoozebear.xyz |
| Vanity | `…8453` — Base's chain id, per `deploy/config.json`. See 2c: PUMP, BEAR, MOON and ZZZ cannot exist in an address |

All of it is in `deploy/config.json`, which `test/run-owner.mjs` reads and checks against the
compiled contracts. That file deliberately holds no RPC key.

### What is still open

1. **The TWAP oracle** (2.1). Not in this repo, and a reverting one is a permanent honeypot.
2. **`devBps`: zero or up to 2000?** Above zero, "supply only falls" is false and the contract
   says so through `supplyOnlyFalls()`. Immutable.
3. **The seed price**, which sets `minTokensPerEth` — immutable, and the thing that stops a
   stranger buying the pool out.

---

## 0b. The RPC key, which is not a thing you can hide

You sent a key and asked for it to be obfuscated. It cannot be. A key in a static file is read
by the browser, so it is read by anyone: `curl snoozebear.xyz | grep -i alchemy` finds it,
minified or not. Referrer restriction does not help either — every fetch on this site sets
`no-referrer`, so your provider sees nothing to check.

What does work:

1. **Rotate the key you pasted.** Assume it is public.
2. Put the new one behind **`/api/rpc`** as a server-side environment variable. Every page
   already asks that path first and falls through to the public endpoint if it is not there, so
   nothing breaks before you wire it and nothing needs redeploying after.
3. **Allowlist snoozebear.xyz as an origin** at the provider. That is the restriction that
   works on a browser request.

`relay/server.mjs` is the shape of the thing behind the path, and its allowlist is now exactly
this site's read set.

## 1. The design finding: one wallet is outside both rules

`SnoozeLaunchpad.launch()` cap-exempts `msg.sender` and then freezes. That exemption has to
exist — seeding a pool means sending tokens *into* it, which is byte-for-byte what selling looks
like, so a launcher who was not exempt could not seed at all.

But `Snooze._move()` guards the haircut like this:

```solidity
if (isPool[to] && !capExempt[from]) {
```

**The flag that skips the cap skips the burn as well.** So the launcher's wallet is outside Rule
1 *and* Rule 2, permanently, and it is the wallet holding 100% of the supply the moment
`launch()` returns.

Measured, not inferred (`test/run-snooze.mjs`, with the dial at 50%):

| | can sell its whole balance? | burned |
| --- | --- | ---: |
| ordinary holder | no — reverts at 20% | 10 of the 20 it could sell |
| cap-exempt holder | yes, all 100 at once | **0** |

Every page that said the rules applied "to everyone, including whoever deployed it" was wrong.
That copy is gone and `test/run-index.mjs` now fails if it comes back.

**What you can do about it.** Nothing removes the exemption — `freeze()` is final. But you can
move the supply out from behind it: immediately after seeding, send the residual treasury from
the launcher wallet to a fresh address. Outbound from an exempt address is uncapped so it is one
transaction, the receiving address is *not* exempt, and from then on your treasury is subject to
both rules like everyone else's. Publish both addresses and that transaction. Keep in the exempt
wallet only what future LP operations need.

**The alternative is a contract change**, and it is not large: split `capExempt` into a cap
exemption and a fee exemption, grant the launcher both at launch, and add a permissionless
one-way `renounceExemption()` that any address can call on itself. You seed, you renounce, and
anybody can verify you did. Say the word and I will write it — but it is a change to a contract
you are about to deploy, so it is your call, not mine.

---

## 2. The two hard blockers

### 2.1 The TWAP oracle is not in this repository

`Snooze` takes an `ITwapOracle` address, immutable, in its constructor:

```solidity
interface ITwapOracle {
    function spot()   external view returns (uint256);
    function twap24() external view returns (uint256);
    function ready()  external view returns (bool);   // true once 24h of history exists
}
```

The only implementation here is `MockOracle` in `contracts/test/`, which is **settable**.
Deploying that to mainnet hands whoever holds its key a dial that sets every sale's burn to
anything up to the 90% cap, forever. Do not do it "temporarily". There is no temporarily.

What a real one must satisfy, beyond the signatures:

- **`spot()` and `twap24()` in the same units.** Only the ratio is used, so any fixed-point
  scale works as long as both share it.
- **Nothing may ever revert.** `ready()` runs on every sell. If it reverts, **sells revert and
  buys do not** — which is the textbook signature of a honeypot, will be flagged as one by every
  scanner within the hour, and cannot be fixed, because the oracle address is immutable. If your
  implementation calls a Uniswap V3 pool's `observe()`, that reverts with `OLD` whenever the
  observation ring does not reach back 24 hours: wrap it in `try/catch` and return
  `ready() == false`. Fail to *the rule is off*, never to *the token cannot be sold*.
- **Genuinely observational, not settable, and ownerless.** An oracle with an owner who can
  repoint it is a settable oracle wearing a costume.
- **Cheap.** It runs inside every sell.

Two shapes are realistic on Base:

- **A V3/Slipstream `observe()` adapter.** Stateless, no keeper. But the observation ring has to
  span 24h, and `increaseObservationCardinalityNext` costs gas per slot; a pool quiet enough for
  a few thousand slots to cover a day stops being quiet exactly when your token gets busy, and
  that transition is invisible until Rule 1 has already switched itself off.
- **A V2-style cumulative-price adapter with your own checkpoints.** Needs a keeper calling
  `update()` a few times a day, forever. If the keeper stops, `ready()` eventually goes false and
  Rule 1 turns off. **That is the failure direction you want** — off, not honeypot.

There is no Chainlink feed for a token that does not exist.

**The manipulation you are signing up for either way:** `spot()` is instantaneous and it is the
numerator of the burn. On a thin new pool, pushing spot up is cheap, and everyone selling in that
block eats up to a 90% haircut. The 24-hour average is expensive to move. The spot leg is not.
`MAX_BURN_BPS` caps the damage at 90% of a sale, which is a cap, not a defence.

### 2.2 No router on Base implements the interface, and the launchpad needs router and pool to be the same address

`PooledLaunchBuy` calls exactly one function with the pooled money:

```solidity
function swapExactETHForTokens(address token, uint256 minOut, address to)
    external payable returns (uint256 out);
```

Selector `0x1930789c`. The Uniswap-V2 family — Aerodrome included — has
`swapExactETHForTokens(uint256,address[],address,uint256)`, selector `0x7ff36ab5`. Different
function. The Universal Router is `execute(bytes,bytes[],uint256)`, `0x3593564c`. **Nothing
deployed on Base answers `0x1930789c`**; the only implementations are the mocks in
`contracts/test/`.

It is worse than a signature mismatch. `launch()` passes **one address for two jobs** —
the router `PooledLaunchBuy` calls, *and* the address Rule 1 taxes sells into:

```solidity
t.setPool(address(p.router), true);   // isPool[router] = true, capExempt[router] = true
```

Look at what the test mock actually is: `SnoozeRouter` implements the swap **and holds the token
float it pays out of**. It is not a router standing in for Uniswap — it is an entire venue. The
design assumes router == pool == reserve holder, in one contract. Nothing on Base is that.

So you are choosing between three shapes, and the choice is not cosmetic:

**Shape A — deploy a bespoke single-pair venue.** One contract that implements the interface,
holds both reserves, and is therefore both where sells land and where buyers get paid.
Both rules work, the pooled buy works, the whole test suite maps onto reality. But you are
running an unaudited AMM holding all of your liquidity, and **no aggregator, screener or wallet
swap UI will route to it** — nobody can find your market. It must also price on the balance
delta it actually *received*, not on the amount the seller passed in, or it overpays every seller
by exactly the burn.

**Shape B — register the future pair address as `router`.** Predict the token address, derive the
Uniswap V2 pair by CREATE2, pass that as `router`. Rule 1 fires on real sells into a real pair,
and you get a market people can find. **But `PooledLaunchBuy` is then dead on arrival** — a pair
does not answer `0x1930789c`, so `execute()` reverts forever and every deposit refunds at
`refundAfter`. Take this shape and the preorder must not open at all, and the front page's
preorder section comes down. Also: the nonce prediction is a race, and third-party LPs adding
liquidity get haircut, because adding is a transfer into `isPool`.

**Shape C — an adapter in front of Uniswap. This is the intuitive choice and it is broken.** The
pooled buy would work, but the real pair would be neither `isPool` nor `capExempt`, so Rule 2
applies to it: it could pay out only 20% of its token reserves per rolling day, and buying breaks
within a day. Meanwhile sells go to the pair, which is unregistered, so Rule 1 never fires. You
would ship a token whose advertised rule is off and whose market stops working. (And if the
adapter takes custody and forwards, the forward is itself a capped outbound transfer and
reverts — any adapter must have the underlying router deliver straight to `to`.)

**There is no shape that gives you both the pooled preorder and a routable public market**
without a contract change. That is the finding. If you want both, the fix is to stop conflating
the two roles: give `PooledLaunchBuy` its own adapter address and register the *pair* as the
pool, separately. That is a change to `SnoozeLaunchpad.Params` and about twenty lines. Ask and I
will write it.

---

## 3. The parameters

Call `SnoozeLaunchpad.validate(params)` first. It is `pure`, it is free from any node with no
wallet, and it returns the reason a launch would be refused instead of making you buy that answer
with gas.

**Nothing in this table is reversible.** There is no admin, no upgrade path and no key anywhere
— including yours — that can revise any of it after `launch()` returns. "Fixing" one means a new
token at a new address, and everyone holding the old one keeps holding the old one.

| Field | Suggested | Why, and what goes wrong |
| --- | --- | --- |
| `supply` | `1e30` base units (1e12 whole tokens) | Pure units choice: price is E/T, so supply changes the unit price and nobody's share. Higher makes floor-division dust proportionally smaller in `claim()` and in the cap. Hard ceiling: the rolling-window baseline is stored as `uint192`, so above ≈6.3e57 base units Rule 2 silently stops meaning anything — 27 orders of magnitude away, a note rather than a risk. |
| `oracle` | **you must build it** | §2.1. The single most dangerous field. Settable = a burn dial someone else holds. Reverting = a permanent honeypot. |
| `dev` | `0x0` | Decorative at `devBps = 0`, and the zero address makes that unambiguous to anyone reading `dev()`. A live-looking address with no cut invites the question. |
| `devBps` | `0` | `supplyOnlyFalls()` returns `devBps == 0` and the site reads it. At zero, "supply only goes down" is exactly true. Above zero it is false and the contract will say so. Capped at 2000, and it is a share **of the haircut**, never of the trade: at the cap with a 41% burn the dev gets 8.2% of the sale. |
| `router` | §2.2 | Registered then frozen. A venue created afterwards is permanently outside both rules and there is no call that adds one. |
| `executeAfter` | 48–72h after launch | Long enough to publish and be checked; short enough that money is not parked. |
| `refundAfter` | ≥ 24h after `executeAfter` | `validate()` refuses less. It is also the **upper** bound on `execute()` — the buy window closes here, which is what makes the refund promise true. |
| `minDeposit` | `0`, or ~0.005 ETH | Zero is allowed. A small floor keeps the claim list from filling with dust that costs more gas to claim than it is worth. |
| `exitFeeBps` | `500` (5%) | Charged only on leaving early, and it stays in the pool for the depositors who did not leave. It is never paid to you. |
| `minTokensPerEth` | from your seed price, minus the slippage you will accept | **Cannot be zero — `validate()` refuses it.** `execute()` is permissionless, so the caller may be an attacker and the caller chooses `minOut`; this immutable floor is what stops them moving the price, calling `execute(1)` and taking the other side. Too tight and honest execution reverts; too loose and you have reopened the hole by degrees. |

---

## 4. The sequence

Every step is sent from your deployer wallet. Verify before moving on; several steps cannot be
undone by anyone.

**0. Rehearse all of it on Base Sepolia (chain 84532).** This is the highest-value item in this
document. Deploy the oracle, deploy a launchpad, launch, seed, deposit from two addresses,
`execute()`, `claim()` from both, then try to sell. Confirm a sell burns once the oracle is 24h
old, and that a claimer can move exactly 20% of their bag and is refused at 21%.

**1. Deploy the oracle.** Then, before anything else, check all three of `ready()`, `spot()` and
`twap24()` return **without reverting even with no history yet** — that is the state they will be
in at the moment of launch.

**2. Deploy the venue** (Shape A) **or compute the pair address** (Shape B). For Shape B, derive
the predicted address twice, independently, and only proceed if both agree.

**2b. Deploy `SnoozeDeployer`** with your address as `owner`. Anyone may send this
transaction — the owner is the constructor argument, not the sender — but only that owner can
deploy anything from it afterwards, and the owner cannot be transferred or renounced.

**2c. Grind the vanity salt, last.** `node deploy/scripts/grind.mjs` — and not `tools/vanity-par.mjs` by hand. `grind.mjs` computes the real init-code hash from the token that actually landed and passes the `--max` the grinder needs; run by hand against a hand-supplied hash the grinder produces a salt for an address the deployment will not land on, and without `--max` it reads the suffix as its budget and finds nothing. `deploy/scripts/predict.mjs --grind` does the same thing before the token exists.

**Most words cannot be ground at any price.** An address is hex, so it contains only `0-9` and
`a-f`. `PUMP` needs P, U and M; `BEAR` needs R; `MOON` needs M, O and N; `ZZZ` needs Z. None of
those letters exist in an address and no amount of searching invents one — this is not a matter
of difficulty, it is a matter of the alphabet.

What is reachable, with roughly the same energy: `ba5ed` (BASED), `bada55` (BADASS), `1337`,
`600d`, `beabed` (BEA-BED), `5eeded`, `acce55`, and the classics `f00d`, `face`, `dead`, `cafe`,
`beef`. `8453` is four characters — about 65,000 salts, a second — and is what
`deploy/config.json` currently names. Changing it is one word in that file; the suite refuses a
suffix that is not hex, so an impossible one fails the build rather than a grind that can never
finish.

**If you want a word the address cannot hold, it goes in a Base name.** `pump.snoozebear.eth`
resolves to whatever hex you deploy to, and a name is what a wallet actually shows somebody —
the hex underneath it is the part nobody reads aloud.

**3. Deploy `SnoozeLaunchpad`.** No constructor arguments; `deploy/SnoozeLaunchpad.bin` is the
bytecode. Expect `count() == 0` and `MAX_DEV_BPS() == 2000`. This address is the launchpad
forever.

**4. Call `validate(params)`.** Free. Expect `(true, "")`. Do not skip this because you are
confident — it is the only free check of the whole parameter set. Then re-read every address in
the tuple character by character against where you got it from.

**5. Send `launch(params)`.** One transaction: deploys the token, deploys the pooled buy,
registers the venue, exempts the distributor, exempts itself, exempts you, transfers the whole
supply to you, freezes. Then verify **all** of this before telling anybody anything:

```
frozen()                     true
isPool(router)               true
capExempt(pooledBuy)         true     ← without this, distribution can never complete
oracle()                     exactly your oracle
totalSupply(), balanceOf(you)  both your supply
supplyOnlyFalls()            true if devBps == 0
pooledBuy.router()/token()/minTokensPerEth()/executeAfter()/refundAfter()
```

If any is wrong, **stop**. It cannot be fixed. Abandoning and relaunching is far cheaper before
anyone has deposited.

**6. Seed the venue** from your cap-exempt wallet, before any deposit and before `executeAfter`.
Then check the implied rate against `minTokensPerEth` and write down the ETH size at which the
round starts reverting.

**7. Move the residual treasury out of the launcher wallet** (§1), and publish the transaction.

**8. Start the oracle's clock and wait 24 hours.** `ready()` stays false until then. **Rule 1
does not exist during the first day after liquidity exists** — which is the day snipers care
about. `snooze.html` already says so; do not let anyone imply otherwise on launch day.

**9. Publish the pooled buy's address** and paste it into `web/index.html` (§5).

**10. After `executeAfter`, call `execute(minOut)`.** Anyone can; do it yourself so it happens on
time. Your `minOut` can only tighten the immutable floor. If it reverts with `SwapFailed` the
price is below your floor — you have until `refundAfter` to try again. If it never succeeds,
everyone refunds and the launch did not happen.

**11. Tell depositors to call `claim()` — each of them, themselves.** There is no `claim(address)`
and no sweep. Same for `refund()`. Nothing collects what nobody comes back for.

**12. Verify the source on Basescan.** solc 0.8.36, optimizer on, 200 runs, flattened.
`deploy/manifest.json` lists each constructor's inputs. Note that `Snooze` and `PooledLaunchBuy`
were created *by a contract*, so each is verified at its own address with its own re-encoded
arguments. Regenerate `deploy/` with `node test/run-deployable.mjs` first if `contracts/` has
changed.

---

## 5. The endpoints, which is the one thing you said you would provide

Every page now reads Base through **`/api/rpc`**, a same-origin path, and falls through to
`https://mainnet.base.org` once if that path is not deployed yet. So the site works today and
starts using your endpoint the moment the rewrite exists — no code change, no redeploy of the
pages.

**Why a path and not the URL.** A keyed endpoint pasted into a static file is a bearer
credential handed to everyone who views source. No obfuscation changes that, because the
browser has to read it to use it. Referrer restriction cannot save it either: every fetch on
this site sets `no-referrer`, so your provider sees nothing to check. **Origin allowlisting is
what works**, and it only works if the key is server-side.

What to do with the endpoints when you have them:

1. Add a rewrite so `/api/rpc` reaches a function or service holding the key. `vercel.json` has
   no `rewrites` block today; `relay/server.mjs` is the shape of the thing behind it, and its
   allowlist is now exactly this site's read set — `eth_chainId`, `eth_blockNumber`,
   `eth_call`, `eth_getCode`, `eth_getStorageAt`, `eth_getLogs`, `eth_getBalance`. It was
   missing the last two, which meant switching it on used to break the chart and the wallet
   balances.
2. Allowlist your own origin at the provider.
3. Leave the pages alone. If you ever want to point them somewhere else,
   `node tools/endpoint.mjs <url-or-path>` sets all five in one go and
   `node tools/stamp.mjs` republishes the hashes.

**Why you need one at all**, since the public endpoint is free: it is not about volume. The one
method the landing page depends on is `eth_getLogs`, and that is the method public endpoints
refuse outright (403) or range-cap (413). This repo's own README has said so about the Python
scripts since before the live chart existed; it was never carried across to the pages. Thirty-two
`eth_call`s per venue scan are not the problem. One `eth_getLogs` is.

## 6. The site

- `web/index.html` holds `const POOL = ""` and `const TOKEN = ""`. Filling them in changes the
  file, which changes its hash, which `node tools/stamp.mjs` republishes in the README. The
  address arrives through the same door as everything else rather than out of a config nobody
  reads.
- Run `node tools/stamp.mjs 2026-09-08b` (or whatever the next tag is) to set the build tag on
  every page and republish every hash. `sh test/run-all.sh` fails if they drift.
- The site is eight static files plus artwork. Any static host works. Point
  `totalworlddomination.xyz` at it and serve `web/` as the root.
- `bg.png` is **a WebP file with a `.png` extension.** Browsers sniff and render it, so it works,
  but if a host ever serves it strictly by extension somewhere strict, that is where to look.

---

## 7. What can still go wrong afterwards

- **Liquidity migrates to a venue with neither rule.** `freeze()` means exactly one address is
  ever `isPool`. Anyone can make a pair, a v4 pool or a wrapper and trade there, untaxed and
  effectively uncapped. The capped venue becomes a reference price rather than the market. There
  is no call that registers a new venue, because the only alternative is keeping a key that can
  rewrite the rules.
- **The 20%/day cap breaks things that are not attacks.** Exchange deposits, bridges, aggregator
  routes, lending markets and LP withdrawals routinely move more than 20% of a balance at once,
  and will fail. **A failed sell is indistinguishable from a honeypot to someone who does not know
  the rule**, and every claimer's first instinct is to sell the whole position. Expect this on day
  one and have the explanation up before it happens.
- **A dump is free.** `burnBps` is zero whenever spot ≤ twap, which is what a downtrend is. Rule 1
  taxes selling into strength only.
- **Sleeping does not bank the spike.** Tomorrow you are paid against the average again.
- **A cap is not a lock.** 20% a day compounds: 67% out in five days, effectively empty in a
  fortnight.
- **No audit. No testnet run.** Still true at the bottom of this document.
