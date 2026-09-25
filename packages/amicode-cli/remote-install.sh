#!/usr/bin/env bash
# Install amicode from a packed tree. No git checkout.
#
#   curl -fsSL https://raw.githubusercontent.com/Jecinoris/amicode/feat/amicode-cli/packages/amicode-cli/remote-install.sh | bash
#
# The archive is a release asset on that fork, named amicode-<platform>.tar.gz.
# It does not use harmoniqs/amicode releases. Override the repo with
# AMICODE_INSTALL_REPO, or the file with AMICODE_INSTALL_URL / --url / --archive.
# This script does not precompile Julia. It copies Project.toml and Manifest.toml
# into ~/.amico/julia when the archive contains them.
set -euo pipefail

PREFIX="${HOME}/.local"
JULIA_DIR="${HOME}/.amico/julia"
ARCHIVE=""
URL="${AMICODE_INSTALL_URL:-}"
DOWNLOADED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:?}"; shift 2 ;;
    --julia-dir) JULIA_DIR="${2:?}"; shift 2 ;;
    --archive) ARCHIVE="${2:?}"; shift 2 ;;
    --url) URL="${2:?}"; shift 2 ;;
    *) echo "amicode install: unknown argument $1" >&2; exit 64 ;;
  esac
done

die() { echo "amicode install: $*" >&2; exit 1; }

platform_key() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in
    x86_64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "unsupported architecture $(uname -m)" ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

if [[ -z "$ARCHIVE" ]]; then
  if [[ -z "$URL" ]]; then
    REPO="${AMICODE_INSTALL_REPO:-Jecinoris/amicode}"
    URL="https://github.com/${REPO}/releases/latest/download/amicode-$(platform_key).tar.gz"
  fi
  command -v curl >/dev/null 2>&1 || die "curl not found on PATH"
  ARCHIVE="$(mktemp)"
  DOWNLOADED=1
  trap 'rm -f "$ARCHIVE"' EXIT
  curl -fsSL "$URL" -o "$ARCHIVE" || die "could not download $URL"
fi

[[ -f "$ARCHIVE" ]] || die "archive not found ($ARCHIVE)"

EXTRACT="$(mktemp -d)"
cleanup() {
  rm -rf "$EXTRACT"
  if [[ "$DOWNLOADED" == 1 ]]; then
    rm -f "$ARCHIVE"
  fi
}
trap cleanup EXIT
tar -xzf "$ARCHIVE" -C "$EXTRACT"

[[ -f "$EXTRACT/VERSION" ]] || die "archive has no VERSION file"
[[ -x "$EXTRACT/bin/amicode" ]] || die "archive has no bin/amicode"
VERSION="$(tr -d '[:space:]' < "$EXTRACT/VERSION")"
[[ "$VERSION" != */* && -n "$VERSION" ]] || die "version must be a single path segment (got ${VERSION})"

DEST="$PREFIX/share/amicode/$VERSION"
mkdir -p "$PREFIX/share/amicode" "$PREFIX/bin"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$EXTRACT"/. "$DEST"/
ln -sfn "$DEST/bin/amicode" "$PREFIX/bin/amicode"

if [[ -f "$DEST/julia/Project.toml" && -f "$DEST/julia/Manifest.toml" ]]; then
  mkdir -p "$JULIA_DIR"
  cp -a "$DEST/julia/Project.toml" "$JULIA_DIR/Project.toml"
  cp -a "$DEST/julia/Manifest.toml" "$JULIA_DIR/Manifest.toml"
  echo "julia project files are in $JULIA_DIR"
fi

echo "installed $DEST"
echo "linked $PREFIX/bin/amicode"
