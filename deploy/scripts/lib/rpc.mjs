// A read-only JSON-RPC client. It can call, it can look at code, it cannot send.
//
// THE THREE THINGS THIS FILE REFUSES TO DO, and they are the whole point of it:
//
//   1. It never signs and never sends. `eth_sendTransaction`, `eth_sendRawTransaction` and
//      every signing method are absent, and test/run-deploy.mjs greps this directory for them.
//      A script that could send is a script that needs a key, and a key in a build environment
//      is a key you have given away. These scripts build the bytes; your wallet sends them.
//
//   2. It never reads an endpoint out of a committed file. A keyed URL in the repository is a
//      bearer credential handed to everyone who can read the repository — deploy/config.json
//      says so at the top and says it about itself.
//
//   3. It never takes the endpoint from the command line either, which was the first version
//      and was worse than the thing it replaced. `--rpc https://…/v2/<key>` lands in
//      ~/.bash_history and in /proc/<pid>/cmdline, where every other process on the machine
//      can read it — including the grinder's own child processes. SNOOZE_RPC in the
//      environment is the one door.
//
// And it never prints the URL. `redact` is applied to every message that leaves this file,
// because Node's fetch attaches the full URL to the `cause` of a network error, so the naive
// `console.error(err)` in a caller is enough to publish the key to a terminal log.
const ALLOWED = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode",
                         "eth_getBalance", "eth_getTransactionReceipt",
                         "eth_getTransactionByHash"]);

/// Base, and the testnet LAUNCH.md calls the highest-value step in the whole document.
/// Anything else is refused: every address in deploy/config.json is a Base address, and
/// reading them on another chain returns "no code here" for all of them, which is
/// indistinguishable from "not deployed yet".
export const CHAINS = { 8453: "Base", 84532: "Base Sepolia" };

/// Everything after the host is dropped. A vendor key lives in the path or the query, and the
/// host alone is enough for an operator to recognise which endpoint they are talking to.
export function redact(text) {
  return String(text ?? "").replace(/https?:\/\/[^\s"'<>]+/g, (u) => {
    try { return new URL(u).origin + "/…"; } catch { return "<endpoint>"; }
  });
}

export class Rpc {
  constructor(url) {
    if (!url) throw new Error(NO_ENDPOINT);
    this.url = url;
    this.id = 0;
  }

  /// The host, for printing. Never `this.url`.
  get label() { try { return new URL(this.url).host; } catch { return "<endpoint>"; } }

  async send(method, params = []) {
    // An allowlist rather than a comment. The read set is small and known, so anything outside
    // it is a bug or a change of purpose, and both should stop here rather than reach a node.
    if (!ALLOWED.has(method)) throw new Error(`${method} is not in this client's read set`);
    const body = { jsonrpc: "2.0", id: ++this.id, method, params };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let r;
    try {
      r = await fetch(this.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: ctl.signal,
      });
    } catch (e) {
      throw new Error(`${method} via ${this.label}: ` +
        (e.name === "AbortError" ? "timed out" : redact(e.message)));
    } finally { clearTimeout(timer); }
    if (!r.ok) throw new Error(`${method} via ${this.label}: HTTP ${r.status}`);
    const j = await r.json();
    // A node error is returned, not thrown, because for eth_call a revert IS the result — and
    // treating it as a transport failure loses the difference between "the oracle reverted"
    // and "the node is down". Those two need opposite responses.
    if (j.error) return { ok: false, error: redact(j.error.message || String(j.error.code)) };
    return { ok: true, result: j.result };
  }

  /// eth_call. Returns {ok, data} or {ok:false, error} — a revert is a result, not a throw, so
  /// a verify step can assert that something reverts without wrapping it in try/catch.
  async call(to, data, block = "latest") {
    const r = await this.send("eth_call", [{ to, data }, block]);
    return r.ok ? { ok: true, data: r.result } : { ok: false, error: r.error };
  }

  async chainId() {
    const r = await this.send("eth_chainId");
    if (!r.ok) throw new Error("eth_chainId: " + r.error);
    return Number(BigInt(r.result));
  }

  /// The runtime bytecode at an address, lower-cased hex with no 0x. "" means no contract.
  async code(addr) {
    const r = await this.send("eth_getCode", [addr, "latest"]);
    if (!r.ok) throw new Error("eth_getCode: " + r.error);
    return String(r.result || "0x").replace(/^0x/, "").toLowerCase();
  }

  /// The receipt, or null while it is still pending. This is how an address is learned: an
  /// address typed in by hand verifies just as happily against SOMEBODY ELSE'S deployment of
  /// the same contract with the same constructor argument, and a stranger's SnoozeDeployer
  /// owned by you is a thing anybody can make.
  async receipt(txHash) {
    const r = await this.send("eth_getTransactionReceipt", [txHash]);
    if (!r.ok) throw new Error("eth_getTransactionReceipt: " + r.error);
    return r.result || null;
  }

  async blockNumber() {
    const r = await this.send("eth_blockNumber");
    if (!r.ok) throw new Error("eth_blockNumber: " + r.error);
    return Number(BigInt(r.result));
  }

  async requireChain(want) {
    const got = await this.chainId();
    if (got !== want)
      throw new Error(`${this.label} is chain ${got} (${CHAINS[got] || "unknown"}), and this ` +
        `run is set to ${want} (${CHAINS[want]}). Point SNOOZE_RPC at ${want}, or set ` +
        `SNOOZE_CHAIN=${got} if that is really what you meant.`);
    return got;
  }
}

export const NO_ENDPOINT =
  "No RPC endpoint. Set SNOOZE_RPC in your environment:\n" +
  "  export SNOOZE_RPC=https://mainnet.base.org        # public, rate-limited, fine for reads\n" +
  "There is deliberately no --rpc flag and no default in any file here. A committed endpoint " +
  "is a credential published to everyone who can read the repository; an endpoint on the " +
  "command line is one published to everyone with a shell on the machine.";

/// The chain this run targets. Base unless the operator opts in to the testnet rehearsal
/// LAUNCH.md 4.0 calls the highest-value item in the document.
export function chainFromEnv() {
  const raw = process.env.SNOOZE_CHAIN;
  if (raw === undefined) return 8453;
  const n = Number(raw);
  if (!CHAINS[n])
    throw new Error(`SNOOZE_CHAIN=${raw} is not one of ` +
      Object.entries(CHAINS).map(([k, v]) => `${k} (${v})`).join(", "));
  return n;
}

/// Returns null rather than throwing so a command that only BUILDS a transaction still works
/// with no endpoint at all — building is offline, and only verifying needs a node.
export function rpcFromEnv() {
  return process.env.SNOOZE_RPC ? new Rpc(process.env.SNOOZE_RPC) : null;
}
