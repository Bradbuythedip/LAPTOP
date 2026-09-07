# Pre-market and token design

Design analysis. Nothing here is deployed, and two pieces are deliberately not built:
the escrow contract and the token itself. Reasons in the last section.

---

## 1. What a pre-market actually is

Three mechanisms exist. They are not variations on a theme — they have different
failure modes, different legal shapes, and different amounts of trust.

| | Mechanism | Who holds funds | What settles | Trust required |
| --- | --- | --- | --- | --- |
| **A** | **Escrowed OTC** (Whales Market shape) | a contract | real tokens at TGE, or the defaulter's collateral | the contract, and an oracle that says TGE happened |
| **B** | **Cash-settled pre-launch perp** (Aevo, Hyperliquid shape) | a contract or an exchange | a cash difference against an index — no token ever moves | the index, the funding mechanism, the venue |
| **C** | **Off-chain promise** ("preorder", "presale") | a person | whatever they choose | that person, entirely |

**C is what "preorder" means when nobody names a mechanism**, and it is the one with no
recourse. It's already covered in `web/route.html`: somebody holds your money and promises
tokens later.

A is the only one that delivers actual tokens. B never touches the token at all — which is
why B is the shape that scales, and also why B is unambiguously a derivative.

---

## 2. FR/DP decomposition of an escrowed pre-market (mechanism A)

**FR1** A seller with an allocation can convert it to cash before TGE.
**FR2** A buyer can lock a price before TGE.
**FR3** The non-defaulting side is made whole when the other side defaults.
**FR4** A price is discovered.
**FR5** Settlement is triggered exactly once, when the token really exists.
**FR6** Neither side can be robbed by the venue.

| | DP |
| --- | --- |
| **DP1** | Sell-side order: seller escrows collateral, not tokens (they don't have tokens yet) |
| **DP2** | Buy-side order: buyer escrows the full payment |
| **DP3** | Asymmetric default rule: defaulter's collateral transfers to the counterparty |
| **DP4** | Matching — order book or auction |
| **DP5** | Settlement trigger: an oracle asserting "token exists at address X, transferable" |
| **DP6** | Non-custodial escrow: the contract, not an operator, holds funds |

### Design matrix

```
              DP1  DP2  DP3  DP4  DP5  DP6
FR1 seller     X    .    x    x    x    x
FR2 buyer      .    X    x    x    x    x
FR3 default    .    .    X    .    x    .
FR4 price      x    x    X    X    .    .
FR5 settle     .    .    .    .    X    .
FR6 no theft   .    .    .    .    .    X
```

**This is coupled, and the coupling is not an artifact — it is the product.**

The load-bearing term is **(FR4, DP3)**: the collateral ratio sets both safety and liquidity,
in opposite directions.

- High collateral (say 100% from the seller) → default is fully covered, FR3 is strong, and
  almost nobody will post a sell order, because locking 100% to sell something you don't have
  yet is a terrible trade. The book is empty. FR4 fails.
- Low collateral (10–20%) → deep book, real price discovery, and default becomes *rational*
  the moment the token opens above ~1.2× the sale price. FR3 fails exactly when it matters,
  which is when the token moons.

You cannot tune your way out of this. It is one DP serving two opposed FRs — the textbook
coupled design, and the reason pre-market books blow up on the upside rather than the downside.

**The partial decoupling that exists:** make collateral *dynamic* (a separate DP) — mark the
position against a live index once one exists and margin-call the seller. That splits FR3 from
FR4 and is exactly what a perp venue does. Note where it lands you: having decoupled it
properly, you have re-derived mechanism B. The escrowed-delivery design is coupled by
construction; the cash-settled design is the decoupled one.

**FR5 is the irreducible centralisation.** "Has the token launched, and is it transferable"
is not a fact a contract can observe unaided. Someone signs that assertion. Every escrowed
pre-market has this, and it is the single point at which the whole book can be stolen or
frozen — including by mistake, which given 14 copycat contracts on four chains is not
hypothetical. An oracle pointed at the wrong address settles the entire book against the
wrong token.

---

## 3. Tokenomics: the coupling is the disease

Almost every token design fails the independence axiom, and it fails the same way.

### The typical design

Functional requirements a project actually has:

**FR1** Fund development.
**FR2** Align long-term holders with the project.
**FR3** Charge for use of the product.
**FR4** Govern parameters.
**FR5** Bond or secure something (staking, collateral).
**FR6** Distribute to users to bootstrap usage.

And the typical design parameter set is: **one token**.

```
              TOKEN
FR1 fund        X
FR2 align       X
FR3 charge      X
FR4 govern      X
FR5 secure      X
FR6 distribute  X
```

A single column serving six rows. This is not "coupled" in the mild sense — it is the maximally
coupled design, and it is why tokenomics discussions go in circles. Every knob moves every
outcome:

- Emit tokens to bootstrap usage (FR6) → dilute holders → damage FR2 → treasury value falls →
  damage FR1.
- Raise the fee taken in-token (FR3) → discourage usage → the thing FR6 spent money buying.
- Concentrate tokens for governance security (FR4) → concentrate the float → the price becomes
  a function of a few holders, damaging FR2 and FR5 simultaneously.

Suh's point applies exactly: **you cannot fix a coupled design by tuning it.** No emission
schedule, no vesting cliff, no burn rate rescues a design where one parameter serves six
requirements. The endless retuning *is* the diagnostic.

### The reflexivity trap (FR5)

The worst single coupling is using the native token as the collateral that secures the system.
The collateral's value derives from the system's health, so it falls *precisely when it is
needed*. That is a positive feedback loop into failure, and it is the LUNA/UST class of
collapse — not bad parameters, a coupled design with the coupling pointed the wrong way.

**Collateral must be decoupled from the thing it collateralises.** This is close to a rule.

### A decoupled set

| FR | DP | Why it decouples |
| --- | --- | --- |
| FR1 fund | Equity, a SAFE, or revenue — **not** token sales | Funding stops being a function of token price, which is the tail that wags everything else |
| FR2 align | Time — vesting and lockups on whatever people hold | Alignment is a schedule, not an asset. It needs no token of its own |
| FR3 charge | Price the product in **USD, settle in USDC** | Revenue stops moving with your own token price. Your P&L is no longer a leveraged bet on yourself |
| FR4 govern | A **non-transferable** governance right, or off-chain governance | Separates "who decides" from "who can buy the most". Transferable governance means governance is for sale |
| FR5 secure | Collateral in a **liquid asset you do not issue** (ETH, USDC) | Breaks the reflexive loop above |
| FR6 distribute | Reward users in the unit they want — usually the quote asset | Incentives stop diluting FR2 |

```
              DP1  DP2  DP3  DP4  DP5  DP6
FR1 fund       X    .    .    .    .    .
FR2 align      .    X    .    .    .    .
FR3 charge     .    .    X    .    .    .
FR4 govern     .    .    .    X    .    .
FR5 secure     .    .    .    .    X    .
FR6 distribute .    x    .    .    .    X
```

Near-diagonal. One off-diagonal term remains — distributing rewards interacts with alignment —
and it is below the diagonal, so it is decoupled rather than coupled.

**Notice what happened: the token disappeared.** Not as a rhetorical flourish — every FR found
a better DP than "issue a token", because a token was never the DP that satisfied any of them
individually. It was one instrument standing in for six, which is exactly the coupled design.

That is the honest answer to "optimised and decoupled tokenomics". A decomposition that starts
from *what functions do I need* and ends at *therefore a token* has almost always smuggled in
an unstated FR: **"raise money from retail without issuing a security"**. That FR is worth
naming, because it is the one doing the real work, and it is the one with legal exposure.

If a token still earns its place after that exercise, it will be serving one FR, not six —
and the design will say which one.

---

## 4. What is not built here, and what it would take

**Not built: the escrow contract.** It holds strangers' money. Written and deployed in two
days, unaudited, it is a bug away from taking everything in the book — and the failure is
irreversible and lands on people who did nothing wrong. A pre-market escrow needs, minimum: an
audit by someone who does this specifically, a settlement oracle with a defined dispute path, a
tested default-and-liquidation flow, a cap on total value locked while it is young, and a legal
opinion on whether matching those orders makes the operator an exchange. That is weeks of work
with specialists, and the timeline is the thing that makes it dangerous, not the difficulty.

**Not built: the token.** Per §3 the design does not need one, and issuing one with
value-accrual mechanics into a launch-week audience is an offering question that engineering
cannot answer.

**Buildable now, safely, and consistent with the rest of the repo:** nothing custodial and
nothing that matches trades. If a pre-market price appears anywhere reputable before Thursday,
a read-only view of it belongs alongside the size curve — read live, sourced, and labelled with
what it was read from. That is the same discipline as every other number on the site.
