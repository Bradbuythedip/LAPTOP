#!/bin/sh
# Every test in the repo. No network is touched.
# Needs `npm install` first — playwright drives the pages, solc and @ethereumjs/evm compile
# and execute the contracts. Both are pinned in package.json; nothing in web/ depends on them.
#
# The last step checks the README against what actually just ran. The README's per-suite
# counts drifted twice in one afternoon (run.mjs listed at 225 when it was 239, run-pooled at
# 65 when it was 72) and the headline was the sum of the stale numbers, so it read as
# self-consistent while being wrong in three places. This is the only place that knows every
# real count, so it is the only place that can check them.
set -e
cd "$(dirname "$0")/.."

LOG=$(mktemp); OUT=$(mktemp)
trap 'rm -f "$LOG" "$OUT"' EXIT

# Runs one suite, shows its output, records its count, and stops the run if it fails.
# Deliberately not a pipeline: `node x | tee` reports tee's exit status, so a failing suite
# would scroll past and the script would carry on and finish green.
suite() {
  desc=$1; script=$2; shift 2
  echo "=== $desc ==="
  if "$@" "$script" > "$OUT" 2>&1; then
    cat "$OUT"
    n=$(sed -n 's/^\([0-9][0-9]*\) passed, .*/\1/p' "$OUT" | tail -1)
    echo "$script $n" >> "$LOG"
  else
    cat "$OUT"; echo; echo "FAILED: $script"; exit 1
  fi
  echo
}

suite "solidity: contracts/LaunchTaxRamp.sol (compiled and executed)" test/run-contract.mjs node
suite "solidity: contracts/PooledLaunchBuy.sol (compiled and executed)" test/run-pooled.mjs node
suite "solidity: contracts/Snooze.sol (compiled and executed)" test/run-snooze.mjs node
suite "solidity: Snooze + PooledLaunchBuy wired together" test/run-wiring.mjs node
suite "solidity: contracts/SnoozeLaunchpad.sol (compiled and executed)" test/run-launchpad.mjs node
suite "solidity: contracts/SnoozeCurve.sol (virtual liquidity, compiled and executed)" test/run-curve.mjs node
suite "solidity: contracts/SnoozeGate.sol (why you need SNOOZE to get LAPTOP)" test/run-gate.mjs node
suite "solidity: the first launch, driven from the owner's wallet" test/run-owner.mjs node
suite "solidity: is any of it deployable? (EIP-170/3860, real ctor args)" test/run-deployable.mjs node
suite "solidity: the deploy sequence in deploy/scripts, sent step by step" test/run-deploy.mjs node
suite "python: laptop_base edge cases" test/test_laptop_base.py python3
suite "python: patched script integration" test/test_scripts.py python3
suite "python: size-curve reference math" test/test_size_math.py python3
suite "python: launch-fee reference model" test/test_launch_model.py python3
suite "python: bonding-curve reference maths" bond_model.py python3
suite "browser: web/index.html (the \$SNOOZE landing page)" test/run-index.mjs node
suite "browser: web/checker.html" test/run.mjs node
suite "browser: web/size.html" test/run-size.mjs node
suite "browser: web/route.html" test/run-route.mjs node
suite "browser: web/buy.html (the venue comparison)" test/run-buy.mjs node
suite "browser: web/order.html" test/run-order.mjs node
suite "browser: web/slot.html" test/run-slot.mjs node
suite "browser: web/launch.html" test/run-launch.mjs node

echo "=== the README against what just ran ==="
awk -v readme=README.md '
  { count[$1] = $2; total += $2; suites++ }
  END {
    bad = 0
    while ((getline line < readme) > 0) {
      # [a-z]+ does not match "twenty-one", so the headline read as absent rather than as
      # wrong — a check reporting the wrong failure is worse than one reporting none.
      if (match(line, /^\*\*[0-9]+ assertions across [a-z-]+ suites\.\*\*/)) {
        said = line; gsub(/[^0-9]/, "", said) + 0
        headline = said + 0; seenhead = 1
      }
      # The name has to be followed by the count, not merely appear at the start of a line.
      # run-wiring.mjs is named twice: once in the inventory with its count, and once in the
      # prose about the wiring bug. Matching on the name alone read the prose line second and
      # recorded the suite as zero.
      # The pattern accepts any script path, not only test/: bond_model.py is a reference
      # implementation that lives at the root beside launch_model.py and self-checks.
      for (s in count)
        if (index(line, "`" s "` ") == 1 && !(s in listed)) {
          rest = substr(line, length(s) + 3)
          if (match(rest, /^[^0-9]+[0-9]+,/)) {
            n = rest; sub(/^[^0-9]+/, "", n); sub(/[^0-9].*/, "", n)
            listed[s] = n + 0
          }
        }
    }
    for (s in count) {
      if (!(s in listed)) { printf "  FAIL %s ran but the README does not list it\n", s; bad++ }
      else if (listed[s] != count[s]) {
        printf "  FAIL README says %s is %d, it is %d\n", s, listed[s], count[s]; bad++
      } else printf "  ok   README has %s at %d\n", s, count[s]
    }
    if (!seenhead) { print "  FAIL the README states no headline total"; bad++ }
    else if (headline != total) {
      printf "  FAIL README headline is %d, the suites just produced %d\n", headline, total
      bad++
    } else printf "  ok   README headline is %d, and that is what just ran\n", total
    printf "\n%d assertions across %d suites\n", total, suites
    exit bad ? 1 : 0
  }
' "$LOG"
