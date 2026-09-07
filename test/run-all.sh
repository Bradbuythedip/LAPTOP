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
echo "=== browser: web/index.html ==="
node test/run.mjs
