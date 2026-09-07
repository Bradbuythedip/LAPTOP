# LAPTOP tooling (Base)

On-chain tooling built while tracing the `$LAPTOP` token before its Sept 9, 2026 launch on Base.

Two halves:

- **`web/`** — a contract checker for people who are about to buy. One self-contained HTML file,
  no wallet, no transactions. Deployed at [totalworlddomination.xyz](https://totalworlddomination.xyz).
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

Published build `2026-09-07a`:

```
sha256(web/index.html) = d832e9160633a7255253e9b3a417ce5f9a33060edfc5833b397ca72177c14bc6
```

### Tests

```bash
npm i -D playwright        # or reuse a global install
node test/run.mjs          # starts the mock node itself
```

69 assertions: Keccak against published vectors, the four EIP-55 reference addresses, the v4
poolId derivation checked against a real Base pool id, result-length discipline, and full browser
flows against `test/mock-rpc.mjs` covering the happy path, pools present, wrong chain, a flaky
rate-limited node, and an endpoint that refuses JSON-RPC batches.

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

### `laptop_buy.py` — buy from V2 / V3 / Aerodrome

Finds a LAPTOP/WETH pair across Uniswap V2, V3 fee tiers and Aerodrome, quotes each, refuses
pools below `--min-liq-eth` (default 1 ETH), simulates with `eth_call` + `estimate_gas`, then requires
`--send` plus typing `BUY`. Also asks the DEX Screener API, which surfaces v4 pools the factories can't
see (it reports them; it does not route v4 — that's `laptop_v4.py`).

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

## Corrections found while building the checker

These are defects in the Python scripts above, found by checking their constants against protocol
source. They are **not yet fixed in the `.py` files**.

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

The v4 storage derivation itself is correct: `POOLS_SLOT` really is 6, the base slot really is
`keccak256(poolId ‖ uint256(6))`, and `liquidity` really is at offset +3.

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
