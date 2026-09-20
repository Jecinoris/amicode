#!/bin/bash
# #1290 e2e bundle: mock hub + headless chrome + the never-blank assertions.
# Usage: ops/e2e-fleet/run_all.sh [dist-dir]
# Runs at localhost-latency and at 800ms (simulated intercontinental).
set -u
DIST="${1:-$(repo_root="$(cd "$(dirname "$0")/../.." && pwd)"; echo "$repo_root/packages/app-bundle/.materialized/packages/app/dist")}"
PORT=4180; DBG=9334
pkill -f "remote-debugging-port=$DBG" 2>/dev/null; sleep 1
python3 "$(dirname "$0")/mock_hub.py" --dist "$DIST" --port $PORT & MOCK=$!
sleep 1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=$DBG --remote-allow-origins=* \
  --user-data-dir="$(mktemp -d)" --window-size=1680,1000 --no-first-run about:blank >/dev/null 2>&1 & CHROME=$!
sleep 3
FAILED=0
python3 "$(dirname "$0")/drive_test.py" --debug-port $DBG --app-port $PORT --latency 0 || FAILED=1
kill $MOCK 2>/dev/null
# second pass with simulated wire latency
python3 "$(dirname "$0")/mock_hub.py" --dist "$DIST" --port $PORT --latency 800 & MOCK=$!
sleep 1
python3 "$(dirname "$0")/drive_test.py" --debug-port $DBG --app-port $PORT --latency 800 || FAILED=1
kill $MOCK $CHROME 2>/dev/null
exit $FAILED
