#!/bin/sh
# Does a browser at totalworlddomination.xyz have any Base endpoint it can actually read?
#
# This is the one open question the test suite cannot answer from CI: it needs egress to
# real Base RPC hosts. Run it from a machine that has that.
#
#   sh test/cors-check.sh
#   sh test/cors-check.sh https://my-endpoint.example    # test one specific endpoint
#
# What matters, in order:
#   1. The preflight (OPTIONS) must be answered with access-control-allow-origin covering
#      our origin. application/json is not a CORS-safelisted content type, so every one of
#      these requests IS preflighted - an endpoint that only sets the header on POST fails.
#   2. The POST must carry access-control-allow-origin too.
#   3. Batching must work, or the tool falls back to ~40 sequential calls and gets throttled.
#
# An endpoint that fails 1 or 2 is unusable from the browser at ANY rate limit, and the
# relay in relay/ becomes necessary rather than optional.

ORIGIN="https://totalworlddomination.xyz"
ENDPOINTS="${1:-https://mainnet.base.org https://base.llamarpc.com https://base-rpc.publicnode.com https://1rpc.io/base https://base.drpc.org}"

pass_any=0
for u in $ENDPOINTS; do
  echo "── $u"

  pre=$(curl -sS -m 15 -X OPTIONS "$u" \
        -H "Origin: $ORIGIN" \
        -H 'Access-Control-Request-Method: POST' \
        -H 'Access-Control-Request-Headers: content-type' \
        -D - -o /dev/null 2>&1)
  if [ $? -ne 0 ]; then
    echo "   preflight  UNREACHABLE — $(echo "$pre" | head -1)"
    echo
    continue
  fi
  acao=$(echo "$pre" | tr 'A-Z' 'a-z' | sed -n 's/^access-control-allow-origin:[ ]*//p' | tr -d '\r')
  if [ -z "$acao" ]; then
    echo "   preflight  NO access-control-allow-origin  -> browsers CANNOT use this endpoint"
  elif [ "$acao" = "*" ] || [ "$acao" = "$ORIGIN" ]; then
    echo "   preflight  ok ($acao)"
  else
    echo "   preflight  allows '$acao', not $ORIGIN  -> unusable from our origin"
  fi

  post=$(curl -sS -m 15 -X POST "$u" \
         -H "Origin: $ORIGIN" -H 'content-type: application/json' \
         --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
         -D /tmp/.cors_h -o /tmp/.cors_b 2>&1)
  if [ $? -ne 0 ]; then
    echo "   post       UNREACHABLE"
    echo
    continue
  fi
  pacao=$(tr 'A-Z' 'a-z' < /tmp/.cors_h | sed -n 's/^access-control-allow-origin:[ ]*//p' | tr -d '\r')
  chain=$(sed -n 's/.*"result":"\([^"]*\)".*/\1/p' /tmp/.cors_b)
  [ -z "$pacao" ] && echo "   post       NO access-control-allow-origin" \
                  || echo "   post       ok ($pacao)"
  [ "$chain" = "0x2105" ] && echo "   chain      Base 8453 ok" \
                          || echo "   chain      reported '$chain' (expected 0x2105)"

  # Batching: one HTTP request for many calls. Without it the tool degrades to sequential.
  bat=$(curl -sS -m 15 -X POST "$u" -H 'content-type: application/json' \
        --data '[{"jsonrpc":"2.0","id":0,"method":"eth_chainId","params":[]},
                 {"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}]' 2>/dev/null)
  case "$bat" in
    \[*) echo "   batch      supported" ;;
    *)   echo "   batch      NOT supported — the tool will fall back to sequential reads" ;;
  esac

  if [ -n "$pacao" ] && [ -n "$acao" ]; then pass_any=1; fi
  echo
done

rm -f /tmp/.cors_h /tmp/.cors_b
if [ "$pass_any" = "1" ]; then
  echo "RESULT: at least one endpoint is browser-usable. The relay is NOT needed."
else
  echo "RESULT: no endpoint answered with a usable access-control-allow-origin."
  echo "        Deploy relay/ (see README) — direct browser reads are impossible."
fi
