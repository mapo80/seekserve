#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$PROJECT_DIR/build/wasm-out"

echo "=== SeekServe WASM Build (Docker) ==="
echo "Project: $PROJECT_DIR"
echo ""

# Build Docker image
echo "[1/3] Building Docker image..."
docker build -f "$SCRIPT_DIR/Dockerfile.wasm" -t seekserve-wasm-builder "$PROJECT_DIR"

# Extract artifacts
echo ""
echo "[2/3] Extracting WASM artifacts..."
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

CONTAINER_ID=$(docker create seekserve-wasm-builder)
docker cp "$CONTAINER_ID:/out/." "$OUT_DIR/"
docker rm "$CONTAINER_ID" > /dev/null

# Report
echo ""
echo "[3/3] Build complete."
echo ""
ls -lh "$OUT_DIR/"
echo ""
echo "Artifacts: $OUT_DIR/"
