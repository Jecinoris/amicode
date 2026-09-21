#!/bin/bash
# #1290 e2e bundle: mock hub + headless chrome + the never-blank assertions.
# Usage: ops/e2e-fleet/run_all.sh [dist-dir]
# Runs at localhost-latency and at 800ms (simulated intercontinental).
set -u
DIST="${1:-$(repo_root="$(cd "$(dirname "$0")/../.." && pwd)"; echo "$repo_root/packages/app-bundle/.materialized/packages/app/dist")}"
PORT=4180; DBG=9334

# #1306: each pass gets a FRESH Chrome profile — a shared profile carries
# restored tabs/routes from the previous pass, and under 800ms latency the
# restored route's fetcher races the snapshot seeding (an open-tab wire fetch
# the zero-fetch assertion rightly rejects). The restore race itself is
# covered inside each pass by the reload-mid-session flow (same profile).
run_pass() {
  LAT=$1
  pkill -f "remote-debugging-port=$DBG" 2>/dev/null; sleep 1
  rm -f /tmp/e2e_mock_requests.log
  python3 "$(dirname "$0")/mock_hub.py" --dist "$DIST" --port $PORT --latency $LAT & MOCK=$!
  sleep 1
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
    --remote-debugging-port=$DBG --remote-allow-origins=* \
    --user-data-dir="$(mktemp -d)" --window-size=1680,1000 --no-first-run about:blank >/dev/null 2>&1 & CHROME=$!
  sleep 3
  python3 "$(dirname "$0")/drive_test.py" --debug-port $DBG --app-port $PORT --latency $LAT
  RC=$?
  kill $MOCK $CHROME 2>/dev/null
  return $RC
}

FAILED=0
run_pass 0 || FAILED=1
run_pass 800 || FAILED=1
exit $FAILED
