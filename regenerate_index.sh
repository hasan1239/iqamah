#!/bin/bash
# Regenerate data/mosques/index.json (full configs) and
# data/mosques/index-slim.json (lightweight list-view entries) from all
# JSON configs. Shared logic lives in providers/__init__.py:regenerate_index.
# Usage: ./regenerate_index.sh

cd "$(dirname "$0")"

# Find a working interpreter (on Windows, `python3` may be the inert
# Microsoft Store stub — probe by actually running it).
PY=""
for cand in python3 python py; do
    if "$cand" -c "" > /dev/null 2>&1; then
        PY="$cand"
        break
    fi
done
if [ -z "$PY" ]; then
    echo "⚠️  Python not found on PATH"
    exit 1
fi

"$PY" -c "
from pathlib import Path
from providers import regenerate_index

count = regenerate_index(Path('data/mosques'))
print(f'{count} masjids')
" || exit 1

echo "✅ Regenerated data/mosques/index.json + index-slim.json"
