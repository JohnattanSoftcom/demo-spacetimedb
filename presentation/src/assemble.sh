#!/bin/bash
# assemble.sh [OUT]  — head + parts/NN-*.html (name order) + foot -> OUT (default index.html, relative to this folder)
B="$(cd "$(dirname "$0")" && pwd)"; OUT="$B/${1:-index.html}"
{ cat "$B/head.html"; for f in "$B"/parts/[0-9][0-9]-*.html; do cat "$f"; echo; done; cat "$B/foot.html"; } > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
echo "assembled $(ls "$B"/parts/[0-9][0-9]-*.html | wc -l | tr -d ' ') slides -> $OUT"
