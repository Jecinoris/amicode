#!/usr/bin/env bash
# rebuild_amicode_from_main.sh — thin shim: sync to origin/main, then rebuild.
#
# Delegates to rebuild_amicode.sh with the MAIN mode forced (sync to origin/main
# first, then rebuild). Renamed from rebuild_amicode_remotely.sh for clarity.
# The forced mode wins over any forwarded --mode (OB5). All other args are
# forwarded unchanged.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec env FORCE_MODE=main "$SCRIPT_DIR/rebuild_amicode.sh" --mode main "$@"
