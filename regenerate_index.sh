#!/bin/bash
# Regenerate data/mosques/index.json from all JSON configs
# Usage: ./regenerate_index.sh

cd "$(dirname "$0")/data/mosques"

if ! ls *.json 1> /dev/null 2>&1; then
    echo "⚠️  No mosque config files found in data/mosques/"
    exit 1
fi

# List all JSON files except index.json, extract slugs, create JSON array
ls *.json | grep -v "index.json" | sed 's/\.json$//' | sort | jq -R -s -c 'split("\n") | map(select(length > 0))' > index.json

echo "✅ Regenerated data/mosques/index.json"
echo "📋 Mosques:"
cat index.json | jq -r '.[]' | sed 's/^/  - /'
