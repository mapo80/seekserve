#!/usr/bin/env bash
# Copies WASM build artifacts + JS glue files into the Flutter web app directory.
# Usage: ./scripts/deploy-wasm-to-app.sh [wasm-build-dir]
#
# Default wasm-build-dir: build/wasm-out (Docker output) or first argument.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

WASM_BUILD="${1:-$ROOT_DIR/build/wasm-out}"
APP_WEB="$ROOT_DIR/flutter_seekserve_app/web"
PLUGIN_WEB="$ROOT_DIR/flutter_seekserve/web"

echo "=== Deploy WASM artifacts to Flutter web app ==="
echo "  WASM build dir: $WASM_BUILD"
echo "  App web dir:    $APP_WEB"
echo "  Plugin web dir: $PLUGIN_WEB"

# 1. Copy Emscripten output (seekserve.js, seekserve.wasm, seekserve.worker.js)
for f in seekserve.js seekserve.wasm seekserve.worker.js; do
    # Try flat layout (docker/build-wasm.sh output) first, then nested
    if [ -f "$WASM_BUILD/$f" ]; then
        cp "$WASM_BUILD/$f" "$APP_WEB/"
        echo "  Copied $f"
    elif [ -f "$WASM_BUILD/seekserve-capi/$f" ]; then
        cp "$WASM_BUILD/seekserve-capi/$f" "$APP_WEB/"
        echo "  Copied $f (from seekserve-capi/)"
    else
        echo "  WARNING: $f not found in $WASM_BUILD, skipping"
    fi
done

# 2. Copy JS glue files from the plugin
for f in seekserve_wasm.js seekserve_reader.js seekserve_sw.js; do
    src="$PLUGIN_WEB/$f"
    if [ -f "$src" ]; then
        cp "$src" "$APP_WEB/"
        echo "  Copied $f"
    else
        echo "  WARNING: $src not found, skipping"
    fi
done

echo "=== Done. Run: cd flutter_seekserve_app && flutter build web ==="
