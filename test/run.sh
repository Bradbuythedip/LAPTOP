#!/bin/sh
# Every test here. No network is touched, and nothing needs installing.
set -e
cd "$(dirname "$0")/.."
echo "=== pumpfun.py selftest (what a downloaded copy can run) ==="
python3 pumpfun.py selftest
echo
echo "=== test/test_pumpfun_py.py (the script from outside itself) ==="
python3 test/test_pumpfun_py.py
echo
echo "=== test/page-smoke.mjs (the site's script, against a stub DOM) ==="
node test/page-smoke.mjs
