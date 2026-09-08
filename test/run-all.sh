#!/bin/sh
# Every test in the repo. No network is touched.
# Needs `npm install` first — playwright drives the pages, solc and @ethereumjs/evm compile
# and execute the contract. Both are pinned in package.json; nothing in web/ depends on them.
set -e
cd "$(dirname "$0")/.."
echo "=== solidity: contracts/LaunchTaxRamp.sol (compiled and executed) ==="
node test/run-contract.mjs
echo
echo "=== python: laptop_base edge cases ==="
python3 test/test_laptop_base.py
echo
echo "=== python: patched script integration ==="
python3 test/test_scripts.py
echo
echo "=== python: size-curve reference math ==="
python3 test/test_size_math.py
echo
echo "=== python: launch-fee reference model ==="
python3 test/test_launch_model.py
echo
echo "=== browser: web/index.html ==="
node test/run.mjs
echo
echo "=== browser: web/size.html ==="
node test/run-size.mjs
echo
echo "=== browser: web/route.html ==="
node test/run-route.mjs
echo
echo "=== browser: web/buy.html ==="
node test/run-buy.mjs
echo
echo "=== browser: web/order.html ==="
node test/run-order.mjs
echo
echo "=== browser: web/slot.html ==="
node test/run-slot.mjs
echo
echo "=== browser: web/launch.html ==="
node test/run-launch.mjs
echo
