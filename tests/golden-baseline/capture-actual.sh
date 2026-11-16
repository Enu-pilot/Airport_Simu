#!/bin/bash
# 使い方: tests/golden-baseline/capture-actual.sh <出力先ディレクトリ>
# HEAD の複製の中でゴールデンを採取し、tests/golden と異なるファイルだけを <出力先>/actual に置く。リポジトリは変更しない。
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git -C "$ROOT" archive HEAD | tar -x -C "$TMP"
ln -s "$ROOT/node_modules" "$TMP/node_modules"
(cd "$TMP" && GOLDEN_UPDATE=1 npx vitest run tests/unit/golden) | grep -E "Test Files|Tests " || true
mkdir -p "$OUT/actual"
for f in "$TMP"/tests/golden/*.json; do
  b=$(basename "$f")
  if ! cmp -s "$f" "$ROOT/tests/golden/$b"; then cp "$f" "$OUT/actual/$b"; fi
done
ls "$OUT/actual"
