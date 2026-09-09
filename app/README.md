# The buy page

One page, one job: let somebody buy `$SNOOZE` on the curve without opening a block explorer.

**It is deliberately not part of `snoozebear.xyz`.** Every page under `web/` says "does not ask
you to sign anything" and `test/run.mjs` fails the build if any of them contains a signing
method — that is the site's anti-phishing property, and it only works while it is true of every
page. A buy button is a signature. So this gets the same exile `deploy/deploy.html` got, and
lives on its own origin.

## Hosting it

A second Vercel project, rooted at this directory:

1. Vercel → **Add New… → Project** → the same repo
2. **Root Directory:** `app`
3. Framework preset: **Other**. No build command, no output directory.
4. Deploy, then **Settings → Domains** → add `buy.snoozebear.xyz`

Then link to it from the site. The main project stays exactly as it is — its
`outputDirectory` is `web`, so nothing here is ever served from `snoozebear.xyz`.

## What it does

- Reads the curve: price multiple, ETH raised, how far to graduation.
- **Checks the curve's `token()` against the address this page names** and refuses to offer a
  buy if they differ. That is the one thing a clone of this page would change.
- Quotes a buy from `quoteBuy` and sends `buy(minOut, to)` with a floor at 98% of it.
- Sells, in the two transactions a sell actually takes: `approve`, then `sell`.
- Caps "max today" at `remainingToday`, not at the balance, because the balance is a number
  the transaction would reject.
- Stops offering the curve once `bonded()` is true and says where the liquidity went.

No key, no endpoint that needs one, nothing stored. Reads go through the connected wallet's
own provider when there is one, `/api/rpc` if this is hosted behind one, then a public Base
node. `test/run-app.mjs` asserts all of that, plus every selector against `keccak(signature)`
and every decimal conversion against values chosen to break a float.
