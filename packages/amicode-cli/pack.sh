#!/usr/bin/env bash
# Build the archive remote-install.sh downloads. Run from a checkout that already
# has the vendored opencode binary. Does not precompile Julia.
#
#   bash packages/amicode-cli/pack.sh
#   bash packages/amicode-cli/pack.sh --out dist/amicode-linux-x64.tar.gz
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="${2:?}"; shift 2 ;;
    *) echo "amicode pack: unknown argument $1" >&2; exit 64 ;;
  esac
done

KEY="$(node -p "process.platform + '-' + process.arch")"
VERSION="$(node -p "require(process.argv[1]).version" "$PKG/package.json")"
if [[ -z "$OUT" ]]; then
  OUT="$PKG/dist/amicode-${KEY}.tar.gz"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
bash "$PKG/install.sh" --prefix "$STAGE/prefix" --julia-dir "$STAGE/julia" --no-instantiate
TREE="$STAGE/prefix/share/amicode/$VERSION"
[[ -f "$TREE/VERSION" ]] || { echo "amicode pack: staged tree has no VERSION" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
tar -C "$TREE" -czf "$OUT" .
echo "packed $OUT"
