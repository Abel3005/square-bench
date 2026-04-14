#!/usr/bin/env bash
# Build the step-1 squarecode image.
#
# Usage:
#   docker/build-squarecode.sh [squarecode-src-dir] [image-tag]
#
# Defaults:
#   squarecode-src-dir = /home/dev/workspace/squarecode
#   image-tag          = square-bench/squarecode:latest
set -euo pipefail

SRC="${1:-/home/dev/workspace/squarecode}"
TAG="${2:-square-bench/squarecode:latest}"

if [[ ! -d "$SRC/dist" ]]; then
  echo "error: $SRC/dist not found." >&2
  echo "Run 'bun run build' in the squarecode source tree first." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker build \
  -f "$SCRIPT_DIR/squarecode.Dockerfile" \
  -t "$TAG" \
  "$SRC"

echo
echo "built: $TAG"
echo "smoke test:"
echo "  docker run --rm --platform=linux/x86_64 \\"
echo "    -v \$HOME/.local/share/squarecode/auth.json:/root/.local/share/squarecode/auth.json:ro \\"
echo "    -v \$HOME/.config/squarecode/squarecode.json:/root/.config/squarecode/squarecode.json:ro \\"
echo "    -v \$HOME/.local/state/squarecode/model.json:/root/.local/state/squarecode/model.json:ro \\"
echo "    $TAG squarecode --version"
