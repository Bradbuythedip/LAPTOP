#!/bin/sh
# Every test in the repo. No network is touched.
set -e
cd "$(dirname "$0")/.."
echo "=== python: laptop_base edge cases ==="
python3 test/test_laptop_base.py
echo
echo "=== python: patched script integration ==="
python3 test/test_scripts.py
echo
echo "=== python: size-curve reference math ==="
python3 test/test_size_math.py
echo
echo "=== browser: web/index.html ==="
node test/run.mjs
echo
echo "=== browser: web/size.html ==="
node test/run-size.mjs
