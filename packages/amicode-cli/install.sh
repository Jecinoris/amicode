#!/usr/bin/env bash
# Install the standalone amicode CLI into ~/.local without the VS Code extension.
# Idempotent: a second run replaces the same version tree and relinks the command.
#
#   bash packages/amicode-cli/install.sh
#   bash packages/amicode-cli/install.sh --prefix "$HOME/.local"
#
# The tree is the round-1 asset list plus the bundled CLI at bin/dist/amicode.cjs
# (CJS; the session config loader cannot be ESM). Node stays on PATH. The whole
# opencode-plugin/ directory is copied.
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
PREFIX="${HOME}/.local"
ASSET_ROOT="$REPO/packages/extension"
LAUNCHER_DIR="$REPO/packages/amico-run/launcher"
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:?}"; shift 2 ;;
    --asset-root) ASSET_ROOT="${2:?}"; shift 2 ;;
    --launcher-dir) LAUNCHER_DIR="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    *) echo "amicode install: unknown argument $1" >&2; exit 64 ;;
  esac
done

die() { echo "amicode install: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node >= 20 not found on PATH"
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[[ "$NODE_MAJOR" -ge 20 ]] || die "node >= 20 is required (found $(node -v))"

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require(process.argv[1]).version" "$PKG/package.json")"
fi
[[ "$VERSION" != */* && -n "$VERSION" ]] || die "version must be a single path segment (got ${VERSION})"

# Always rebuild so a re-install ships the CLI that is in this checkout.
(cd "$PKG" && node esbuild.config.mjs)
[[ -f "$PKG/dist/amicode.cjs" ]] || die "CLI bundle missing after build ($PKG/dist/amicode.cjs)"

KEY="$(node -p "process.platform + '-' + process.arch")"
for path in \
  "$ASSET_ROOT/AGENTS.md" \
  "$ASSET_ROOT/opencode-plugin/amicode_context.ts" \
  "$ASSET_ROOT/bin/dist/mcp-amico.mjs" \
  "$ASSET_ROOT/vendor/opencode/$KEY/opencode" \
  "$LAUNCHER_DIR/amico" \
  "$LAUNCHER_DIR/amico-run"
do
  [[ -e "$path" ]] || die "missing $path"
done
for dir in scores packs skills templates opencode-plugin; do
  [[ -d "$ASSET_ROOT/$dir" ]] || die "missing $ASSET_ROOT/$dir"
done

DEST="$PREFIX/share/amicode/$VERSION"
mkdir -p "$PREFIX/share/amicode" "$PREFIX/bin"
STAGE="$(mktemp -d "$PREFIX/share/amicode/.staging.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

mkdir -p "$STAGE/bin/dist" "$STAGE/bin/launcher" "$STAGE/vendor/opencode/$KEY"
cp -a "$ASSET_ROOT/AGENTS.md" "$STAGE/AGENTS.md"
for dir in scores packs skills templates opencode-plugin; do
  mkdir -p "$STAGE/$dir"
  cp -a "$ASSET_ROOT/$dir"/. "$STAGE/$dir"/
done
cp -a "$ASSET_ROOT/vendor/opencode/$KEY/opencode" "$STAGE/vendor/opencode/$KEY/opencode"
cp -a "$ASSET_ROOT/bin/dist/mcp-amico.mjs" "$STAGE/bin/dist/mcp-amico.mjs"
cp -a "$LAUNCHER_DIR/amico" "$LAUNCHER_DIR/amico-run" "$STAGE/bin/launcher/"
chmod +x "$STAGE/bin/launcher/amico" "$STAGE/bin/launcher/amico-run" "$STAGE/vendor/opencode/$KEY/opencode"
if [[ -f "$LAUNCHER_DIR/../dist/amico.js" ]]; then
  cp -a "$LAUNCHER_DIR/../dist/amico.js" "$STAGE/bin/dist/amico.js"
fi
if [[ -f "$LAUNCHER_DIR/../dist/amico-run.js" ]]; then
  cp -a "$LAUNCHER_DIR/../dist/amico-run.js" "$STAGE/bin/dist/amico-run.js"
fi
cp -a "$PKG/dist/amicode.cjs" "$STAGE/bin/dist/amicode.cjs"

cat > "$STAGE/bin/amicode" <<'EOF'
#!/usr/bin/env bash
# Installed shim. AMICODE_ASSET_ROOT is this version's tree, one level above bin/.
set -euo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
ROOT="$(cd -P "$DIR/.." && pwd)"
export AMICODE_ASSET_ROOT="$ROOT"
if ! command -v node >/dev/null 2>&1; then
  echo "amicode: node >= 20 not found on PATH" >&2
  exit 64
fi
exec node "$ROOT/bin/dist/amicode.cjs" "$@"
EOF
chmod +x "$STAGE/bin/amicode"

rm -rf "$DEST"
mv "$STAGE" "$DEST"
trap - EXIT
ln -sfn "$DEST/bin/amicode" "$PREFIX/bin/amicode"
echo "installed $DEST"
echo "linked $PREFIX/bin/amicode"
