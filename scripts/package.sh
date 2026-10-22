#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION_DIR="$ROOT_DIR/extension"
MANIFEST="$EXTENSION_DIR/manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "manifest.json not found" >&2
  exit 1
fi

VERSION="$(node -e "const m=require(process.argv[1]); process.stdout.write(m.version)" "$MANIFEST")"
OUTPUT_DIR="$ROOT_DIR/release"
OUTPUT_FILE="$OUTPUT_DIR/CommitZip-v${VERSION}.zip"

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

(
  cd "$EXTENSION_DIR"
  zip -q -r "$OUTPUT_FILE" . \
    -x "test/*" \
    -x "*.DS_Store"
)

echo "Created: $OUTPUT_FILE"
