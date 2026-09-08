# Deploying $SNOOZE from your own wallet

Six steps. Each one builds a transaction, shows you exactly what it is and what about it can
never be undone, waits for you to send it from your own wallet, and then reads the result back
off the chain before it will build the next one.

**Nothing here holds a key, asks for one, or can send anything.** There is no `--send`, no
signer and no signing library in `package.json`; the RPC client's method allowlist contains no
sending method at all, and `test/run-deploy.mjs` greps this directory for every one of them. The
scripts build bytes. Your wallet signs them.

```
export SNOOZE_RPC=https://mainnet.base.org      # reads only. Never put a keyed URL in a file here
node deploy/scripts/artifacts.mjs               # compile, once, and after any contracts/ change
node deploy/scripts/plan.mjs                    # the whole sequence and where you are in it
```

`deploy/deploy.html` is the same thing with buttons — open it locally and it builds and sends
the identical bytes. It is the convenience; this is the mechanism.

## The endpoint

Only from `SNOOZE_RPC` in your environment. There is deliberately no `--rpc` flag: an endpoint
on the command line lands in your shell history and in `/proc/<pid>/cmdline`, where every other
process on the machine can read it, which is worse than the committed file `deploy/config.json`
already refuses to be. Nothing here ever prints the URL — errors carry the host only, because
Node's `fetch` attaches the full URL to a network error's cause and one `console.error(err)`
would publish the key to a terminal log.

`SNOOZE_CHAIN=84532` targets Base Sepolia for the rehearsal `LAUNCH.md` §4.0 calls the
highest-value item in the whole document. The launch state file records which chain it was
written on and refuses to be read on another, so a rehearsal cannot leave mainnet steps marked
verified from testnet answers.

## Two things this sequence does that LAUNCH.md does not

Both were found by executing the steps rather than reading them, and both are measured in
`test/run-deploy.mjs` so they cannot quietly stop being true.

### The token is deployed from your wallet, not through `SnoozeDeployer`

`Snooze`'s constructor spends `msg.sender` twice:

```solidity
admin = msg.sender;
balanceOf[msg.sender] = supply;
```

Through `SnoozeDeployer.deploy`, `msg.sender` inside the constructor is **the deployer
contract**. Deployed that way, measured against the real compiled contracts:

| | |
| --- | --- |
| `balanceOf(SnoozeDeployer)` | the entire supply |
| `balanceOf(your wallet)` | 0 |
| `admin()` | the SnoozeDeployer contract |
| that contract's ABI | `addressOf, count, deploy, deployed, owner, seal, sealed_` |

No transfer, no approve, no arbitrary call, no rescue. **The supply is unrecoverable by anybody,
forever**, the funding transfer the next step needs reverts on a zero balance, and `setPool` —
the call that switches the rules on — reverts `NotAdmin` for you and for everyone else. Nothing
reverts at deployment time, so you find all of this out afterwards.

So the token comes from your own wallet, where `admin` and the supply both land on you, and the
ground address goes to **the curve** instead. `SnoozeCurve` takes nothing from `msg.sender` and
has no admin, and it is the address buyers paste and send ETH to — which is the one worth making
recognisable. `deploy/config.json` carries this as `vanity.target`, and `"token"` is refused with
the reason rather than silently unavailable.

It also makes *grind last* a hard constraint instead of advice: the curve's constructor arguments
contain the token's address, so there is nothing to grind against until the token exists.

### The curve is registered as the pool, and that is what turns the rules on

`Snooze._move` fires **both** rules on one condition:

```solidity
if (isPool[to] && !capExempt[from]) {
```

A launch that never calls `setPool` has no haircut and no daily cap, whatever the oracle says —
`burnBps()`, `quoteSell()` and `remainingToday()` all keep returning numbers, and none of them
happens. So step 5 registers the curve, and step 6 freezes.

**The order inside step 5 is load-bearing.** Once `isPool[curve]` is true, a transfer *into* the
curve is a sell: sending the whole float reverts on the daily cap, and retrying at the cap
**succeeds** while Rule 1 burns part of it — the curve silently ends up holding a fraction of
what it should, with immutable parameters. So `5.register` refuses to build until the chain says
the curve already holds its whole allocation. That is a read, not a comment, because a
precondition nobody checks is not one.

## The sequence

| | | |
| --- | --- | --- |
| 1 | `oracle` | Record the oracle, and prove all three views answer without reverting with no history yet. Sends nothing. |
| 2 | `deployer` | Deploy `SnoozeDeployer`. Anyone may send it; only the owner can deploy from it after. |
| 3 | `token` | Deploy `Snooze` from your wallet. `oracle` and `devBps` become immutable here. |
| 4 | `salt` | Grind the vanity salt for the curve. Last, and it could not have been earlier. |
| 5 | `curve` | Deploy the curve at the ground address → fund it → register it as the pool. |
| 6 | `lock` | `freeze()` the token, `seal()` the deployer. Two one-way doors. |

```
node deploy/scripts/build.mjs 2                   # the next unsent transaction of a step
node deploy/scripts/build.mjs 5.fund              # a particular one
node deploy/scripts/record.mjs 2.deploy 0x<hash>  # learn the address from the RECEIPT
node deploy/scripts/verify.mjs 2                  # read it back; this is what unlocks step 3
node deploy/scripts/grind.mjs                     # step 4
```

`record.mjs` takes the address from the transaction receipt rather than from you. An address
typed by hand verifies just as happily against somebody else's deployment of the same contract
with the same constructor argument — a `SnoozeDeployer` owned by you is a thing any stranger can
deploy — and against a typo that happens to land on one.

Steps 3, 5 and 6 refuse to build until you repeat back a phrase naming what becomes permanent.
The phrase is not a formality: it is the smallest thing that requires reading the list above it.

## The oracle

`deploy/config.json` has `oracle.choice: ""` and nothing can be built while it is blank. There is
no default, because both real choices are real:

- **`observational`** — a genuine, ownerless price observation on Base. Rule 1 works once 24
  hours of history exists.
- **`never-ready`** — an oracle whose `ready()` is false forever. Legitimate, and it means **Rule
  1 never fires**: no sale is ever haircut, at any price, on any day. `$SNOOZE` is then an
  ordinary ERC-20 with a 20%/day cap on selling into the curve, and nothing else. When this is
  the choice, `deploy/deploy.html` says so on its face.

Step 1 refuses a settable oracle by looking at the deployed bytecode, both as an exact match
against `contracts/test/SnoozeMocks.sol:MockOracle` with the compiler metadata tail stripped, and
by the presence of `set(uint256,uint256,bool)`'s selector in the dispatcher — a recompile changes
the hash and cannot remove the function. It refuses a reverting one by calling all three views.

**What it does not claim.** It cannot show an oracle is ownerless: an owner check is a comparison
like any other, and a setter can wear a different name. The strongest honest statement is "it is
not the repo's mock and it has no `set(uint256,uint256,bool)`", which is what the page prints.
Read the oracle's verified source yourself; nothing here can do that for you.

## What the six steps do not cover

- **`bond()` is a race you can lose.** `SnoozeCurve.bond(pool)` is permissionless *and the caller
  names the destination*. The moment `reserveEth` reaches `bondTarget`, the first stranger to
  call it receives the whole raise and the pool's token side, at an address they chose. The
  contract's own comment calls this a real trust edge and says a launchpad is meant to pin the
  pool — this sequence has no launchpad, so nothing pins it. Nothing in these scripts can prevent
  it. The fix is a contract change.
- **A holder cannot sell 100% of a position back to the curve.** `quoteSell` rounds the gross up
  against `reserveEth` by one wei at the boundary, so selling exactly `sold` reverts with an
  arithmetic panic and `sold - 1` succeeds. A rounding edge, not a lost balance — but it looks
  like a honeypot to whoever hits it first.
- **The site still points at nothing.** `web/index.html` holds `const POOL = ""` and
  `const TOKEN = ""`. Filling them in changes those files, so `node tools/stamp.mjs` has to
  republish the hashes.
- **Nothing is verified on Basescan.** solc 0.8.36, optimizer on, 200 runs, flattened. The curve
  was created *by a contract*, so it verifies at its own address with its own re-encoded
  arguments; `deploy/artifacts.json` lists them in order.
- **`SnoozeGate` is not part of this.** Its constructor wants a Merkle root over a snapshot that
  has not been taken and a `claimUntil` in the future, none of which is known here, so it is not
  even in the compiled set — a compiled-but-undeployable blob is an invitation to paste bytecode
  by hand. Note that a sealed `SnoozeDeployer` cannot deploy it later: the gate needs its own.
- **This is the curve launch, not the launchpad one.** `deploy/README.md` and `LAUNCH.md` §4
  describe deploying `SnoozeLaunchpad` and calling `launch()`, which needs a venue answering
  `0x1930789c` — and `LAUNCH.md` §2.2 records that nothing on Base is one. This is the other
  path: the curve is its own venue. The two runbooks diverge, and neither is wrong.
- **None of it has been on a testnet.** `SNOOZE_CHAIN=84532` exists so it can be.

## The files

```
lib/abi.mjs      encoding and decoding, written out rather than imported — a library's bugs
                 would be indistinguishable from the contract's, and a wrong word in a
                 constructor is an immutable address holding the wrong parameter forever
lib/rpc.mjs      reads only: an allowlist of seven methods, none of which can send
lib/solc.mjs     solc 0.8.36 / optimizer / 200 runs, recorded beside the bytes it produced
lib/config.mjs   every `revert BadConfig()` copied out, so it costs nothing to discover
lib/oracle.mjs   what bytecode can and cannot prove about an oracle
lib/state.mjs    what has been READ BACK, bound to one chain and one owner
lib/steps.mjs    the six steps as data — the page and the CLI render these, not their own copy
lib/run.mjs      the refusals every entry point shares
```

`deploy/launch-state.json` is not committed: it is one wallet's progress through one launch, it
is regenerable from the chain, and a stale one in the repository would be a set of addresses
somebody might trust.
