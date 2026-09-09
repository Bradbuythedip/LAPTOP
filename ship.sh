#!/bin/sh
# Put the contract address on the site and push it, in one command.
#
#   ./ship.sh launch-<mint>.json
#
# Adds ONLY web/index.html. The launch record next to it holds the mint's secret
# key, and `git add -A` after a launch would commit it — .gitignore covers it,
# but this never relies on that.
set -e

REC="$1"
[ -n "$REC" ] || { echo "usage: ./ship.sh launch-<mint>.json" >&2; exit 2; }
[ -f "$REC" ] || { echo "no such launch record: $REC" >&2; exit 2; }

BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "── what would change"
python3 pumpfun.py publish --record "$REC"

printf '\npush this to %s? [y/N] ' "$BRANCH"
read ANS
case "$ANS" in y|Y|yes|YES) ;; *) echo "stopped, nothing written."; exit 1 ;; esac

python3 pumpfun.py publish --record "$REC" --write

git add web/index.html
git commit -m "publish the contract address"

N=0
until git push -u origin "$BRANCH"; do
  N=$((N + 1)); [ "$N" -lt 4 ] || { echo "push failed 4 times." >&2; exit 1; }
  echo "push failed, retrying in $((1 << N))s..."; sleep $((1 << N))
done

echo
echo "live in ~30s at https://snoozebear.xyz"
