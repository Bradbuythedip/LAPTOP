# LAPTOP tooling (Base)

On-chain tooling built while tracing the `$LAPTOP` token before its Sept 9, 2026 launch on Base.
Four scripts: find the pools, watch for the first real liquidity, execute a Uniswap v4 swap, execute a
classic V2/V3/Aerodrome swap.

**This is not a signal and not advice.** It's a map plus the plumbing to act on it. Read the
"Failure modes" section before you send anything. Verify every address below on basescan.org
yourself — several were written from memory and are marked unverified.

## Install

```bash
python3 -m venv env && source env/bin/activate
pip install web3 requests
export BASE_RPC=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY   # public RPCs rate-limit and refuse eth_getLogs
export LAPTOP_PK=0xyour_private_key                              # or leave unset; scripts prompt, hidden
```

Use a wallet holding only what you intend to spend.

## Scripts

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

Finds a LAPTOP/WETH pair across Uniswap V2, all four V3 fee tiers and Aerodrome, quotes each, refuses
pools below `--min-liq-eth` (default 1 ETH), simulates with `eth_call` + `estimate_gas`, then requires
`--send` plus typing `BUY`. Also asks the DEX Screener API, which surfaces v4 pools the factories can't
see (it reports them; it does not route v4 — that's `laptop_v4.py`).

`mock_rpc.py` / `mock_rpc2.py` are local JSON-RPC mocks used to test both code paths (pools present and
absent, supply vaulted and moved) without touching mainnet.

## Addresses

Verified against block explorers during this work:

| What | Address |
| --- | --- |
| LAPTOP (official, per laptoptoken.com) | `0xB095274743941e953c746F9C228DA9c18Bb6ec29` |
| Mint vault | `0xf859bF7A72a282eAC0e99E1ca0D1b814Ccd8B24d` |
| Deployer | `0x0FB557378b64D3084f9DEDc633E8B03cFa7F5592` |
| Create2 factory used | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| Doppler Airlock (Whetstone) | `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12` |
| HUNTER (Doppler sidecar token) | `0xfcac02ca1bead66b91405042063fbce85fd42009` |

Written from memory, **verify before use**: Uniswap v4 PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b`,
Universal Router `0x6fF5693b99212Da76ad316178A184AB56D299b43`, Permit2
`0x000000000022D473030F116dDEE9F6B43aC78BA3`, V2 factory/router, V3 factory/quoter/router02,
Aerodrome factory/router, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
WETH `0x4200000000000000000000000000000000000006`.

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

- Base has a private mempool and a single sequencer. There is nothing to front-run; this is reaction
  speed, and anyone with colocated infra reacts faster.
- The team may fund a pool none of these scripts is armed on, or a different quote token.
- A hook with a snipe tax or a start-time gate can tax or revert an early buy. The two USDC pools
  currently show no hook; that can change if the team uses different pools.
- A simulation that passes can still revert when pool state changes in the same block.
- Public RPCs rate-limit (429), refuse `eth_getLogs` (403), and cap log ranges (413).
- Unverified addresses above will silently send funds to the wrong contract if any is wrong.

MIT. No warranty. You are responsible for anything you sign.
