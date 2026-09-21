#!/bin/bash
# amicode ops/hub/ship.sh — publish the built app to the fleet's three
# destinations and VERIFY. Born from #1310: the old ritual shipped
# index.html + the one new hashed JS — builds whose CSS hash changed
# shipped an index referencing a CSS the hub never received ("the whole
# UI with no CSS loading"). The shipper now parses every referenced
# asset, ships each one missing on the hub, and proves the hub complete.
#
# Destinations:
#   1. hub   ~/.amico/server/app-dist/   (surgical: index.html + missing
#        referenced assets only — the dir is huge, rsync is impractical)
#   2. shelf ~/.amico/shelf/app-dist/     (full rsync)
#   3. extension dist/app                (full rsync)
#
# Usage: ops/hub/ship.sh [dist-dir]   (default: the materialized app dist)
set -euo pipefail
DIST="${1:-$(cd "$(dirname "$0")/../../packages/app-bundle/.materialized/packages/app/dist" && pwd)}"
HUB=amico-hub
HUB_DIST='.amico/server/app-dist'

[ -f "$DIST/index.html" ] || { echo "no index.html in $DIST — build first"; exit 1; }

echo "== shipping index.html + referenced assets to hub =="
scp "$DIST/index.html" "$HUB:$HUB_DIST/index.html"
REFS=$(python3 - "$DIST" <<'PYEOF'
import re, sys
html = open(sys.argv[1] + "/index.html").read()
for ref in re.findall(r'(?:src|href)="/assets/([^"]+)"', html):
    print(ref)
PYEOF
)
for ref in $REFS; do
  echo "  asset: $ref"
  scp -q "$DIST/assets/$ref" "$HUB:$HUB_DIST/assets/$ref"
done

echo "== full rsync: shelf + extension dist/app =="
rsync -a "$DIST/" "$HOME/.amico/shelf/app-dist/"
rsync -a "$DIST/" "$HOME/.vscode/extensions/harmoniqs.amicode-0.3.7/dist/app/"

echo "== verify hub completeness =="
ssh "$HUB" "python3 - <<'PYEOF'
import re, os, sys
html = open('$HUB_DIST/index.html').read()
refs = set(re.findall(r'(?:src|href)=\"/assets/([^\"\\']+)[\"\\']', html))
missing = [r for r in refs if not os.path.exists('$HUB_DIST/assets/' + r)]
print('  hub assets referenced:', len(refs), '| missing:', missing or 'NONE — complete')
sys.exit(1 if missing else 0)
PYEOF"

echo "shipped: $(grep -oE 'index-[A-Za-z0-9_-]+\.js' "$DIST/index.html" | head -1)"
