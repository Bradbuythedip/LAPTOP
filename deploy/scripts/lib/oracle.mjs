// What can and cannot be established about an oracle from outside it.
//
// This file exists because the first version of the guard computed a blocklist and never
// consulted it, which is the worst of both: a page that shows a green tick for a check that
// never ran. So each function here returns what it actually proved, in the words that are
// true, and nothing here claims more than it can.
//
// WHAT IS DECIDABLE FROM BYTECODE:
//   - "this is byte-for-byte the mock in contracts/test/" — yes, by comparing runtimes.
//   - "this has a set(uint256,uint256,bool) function" — yes, by looking for its selector in
//     the dispatcher. Recompiling under a different solc changes the metadata tail and so the
//     hash, but it cannot remove the selector from a contract that still has the function.
//   - "this reverts" — yes, by calling it.
//
// WHAT IS NOT DECIDABLE:
//   - "this is ownerless." An owner check is `if (msg.sender != x) revert`, which looks like
//     any other comparison. A contract can hold a setter under a different name, behind a
//     different selector, or reachable only from one address. So the strongest honest claim
//     is "it is not the repo's mock and it has no set(uint256,uint256,bool)", and that is
//     exactly the sentence the page prints. Anything stronger has to come from reading the
//     oracle's own verified source, which is a human act and is named as one.
import { readUint, readBool, strip } from "./abi.mjs";

/// Solidity appends a CBOR metadata blob whose last two bytes are its own length. Stripping it
/// makes two builds of the same source from different machines comparable. Returns the input
/// unchanged when the tail does not look like a length that fits, which is the safe direction:
/// a failed strip makes a comparison stricter, never looser.
export function stripMetadata(runtimeHex) {
  const h = strip(runtimeHex).toLowerCase();
  if (h.length < 8) return h;
  const len = parseInt(h.slice(-4), 16);
  if (!Number.isFinite(len)) return h;
  const bytes = (len + 2) * 2;
  if (bytes >= h.length) return h;
  return h.slice(0, h.length - bytes);
}

/// The three things a deployed oracle can be caught being, before the token exists and while
/// refusing still costs nothing. `code` is the runtime hex (no 0x); `results` maps a signature
/// to {ok, data, error} exactly as lib/rpc.mjs returns.
export function inspectOracle({ code, results, refuse, choice }) {
  const out = [];
  const add = (ok, name, detail = "") => out.push({ ok: !!ok, name, detail });
  const runtime = strip(code || "").toLowerCase();

  add(runtime.length > 0, "there is a contract at the oracle address",
      runtime.length ? "" :
      "no code. Every call to an address with no code returns empty and succeeds, so an " +
      "oracle that is not there reads as an oracle that works and then makes ready() decode " +
      "as false forever.");
  if (!runtime.length) return out;

  const mock = refuse && refuse.MockOracle;
  if (mock) {
    const same = stripMetadata(mock.runtime) === stripMetadata(runtime);
    add(!same, "it is not contracts/test/SnoozeMocks.sol:MockOracle",
        same ? "This is the settable mock, compared with the compiler metadata stripped so a " +
               "rebuild does not sneak past. It is a dial that sets every sale's burn to " +
               "anything up to 90%, held by whoever holds its key, at an address the token " +
               "can never stop pointing at." : "");
    const selectors = Object.entries(mock.selectors || {});
    for (const [sig, sel] of selectors) {
      const present = runtime.includes(sel.toLowerCase());
      add(!present, `it has no ${sig} in its dispatcher`,
          present ? `the selector ${sel} appears in the runtime. That is a setter, and a ` +
                    "settable oracle is an admin key with a different name." : "");
    }
  }

  for (const sig of ["ready()", "spot()", "twap24()"]) {
    const r = results[sig];
    // The node's own reason first, then what it means. The first version printed only the
    // reason, so the one sentence explaining why a reverting oracle is unfixable — the thing
    // the operator has to know before the address becomes immutable — was the half that got
    // dropped exactly when it applied.
    add(!!r && r.ok, `${sig} returns without reverting`,
        r && r.ok ? "" :
        ((r && r.error ? r.error + ". " : "") +
         "a revert here is a permanent honeypot: ready() runs inside every sell, so sells " +
         "revert while buys work, and the address cannot be changed"));
    if (r && r.ok) {
      let decoded = true;
      try { sig === "ready()" ? readBool(r.data) : readUint(r.data); } catch { decoded = false; }
      add(decoded, `${sig} returns a full 32-byte word`,
          decoded ? "" : "short return data. An address with no code, or one with a fallback " +
                         "that returns nothing, answers every call like this.");
    }
  }

  // Unconditional, for both choices. The first version exempted "never-ready" from this, which
  // switched the check off for the one choice whose entire definition is that ready() is false.
  let ready = null;
  try { ready = results["ready()"]?.ok ? readBool(results["ready()"].data) : null; } catch {}
  add(ready === false, "ready() is false, which is what an oracle with no history behind it is",
      ready === true
        ? (choice === "never-ready"
            ? "this was declared never-ready and it is ready. One of the two is wrong, and the " +
              "one written into the token is the address."
            : "ready() is already true before 24 hours of history can exist. That is a " +
              "settable oracle already set, or one that lies about what it has seen.")
        : (ready === null ? "ready() could not be read" : ""));

  return out;
}

/// The sentence that goes on the page's face, not in a comment. Both halves are needed: an
/// oracle that never becomes ready is a legitimate choice AND it is a different token.
export const NEVER_READY_MEANS =
  "Rule 1 never fires. No sale is ever haircut, at any price, on any day — $SNOOZE is an " +
  "ordinary ERC-20 with a 20%/day cap on selling into the curve, and nothing else.";
