#!/usr/bin/env bash
# Local WebTorrent Streaming — start all services for manual testing.
#
# Starts tracker, seeder, web server, and Chrome, then waits.
# Press Ctrl+C to stop everything.
#
# Usage:
#   ./scripts/run_local_e2e.sh [--build] [--e2e] [--screenshots]
#
# Options:
#   --build        Build native + Flutter web before running
#   --e2e          Run automated CDP E2E test instead of waiting
#   --screenshots  Take screenshots after E2E test (implies --e2e)
#
# Prerequisites:
#   - Video file: downloads/bbb_sunflower_1080p_30fps_normal.mp4
#   - Native build: ./setup.sh debug  (or pass --build)
#   - WASM artifacts deployed to Flutter app
#   - Flutter web: cd flutter_seekserve_app && flutter build web  (or pass --build)
#   - npm: ws package (npm install ws)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TRACKER_PORT=8000
WEB_PORT=8080
CDP_PORT=9222
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
VIDEO_NAME="bbb_sunflower_1080p_30fps_normal.mp4"

DO_BUILD=false
DO_E2E=false
DO_SCREENSHOTS=false

for arg in "$@"; do
    case "$arg" in
        --build) DO_BUILD=true ;;
        --e2e) DO_E2E=true ;;
        --screenshots) DO_SCREENSHOTS=true; DO_E2E=true ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

PIDS=()

cleanup() {
    echo ""
    echo "=== Cleaning up ==="
    for pid in "${PIDS[@]+"${PIDS[@]}"}"; do
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            echo "  Killed PID $pid"
        fi
    done
    # Kill Chrome test profile
    pkill -f "user-data-dir=/tmp/chrome-e2e-local" 2>/dev/null || true
    echo "Done."
}

trap cleanup EXIT

# ============================================================
# Kill stale processes on required ports
# ============================================================

echo "=== Freeing ports ==="
for p in $TRACKER_PORT $WEB_PORT $CDP_PORT; do
    pid=$(lsof -ti :"$p" 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "  Killing PID $pid on port $p"
        kill "$pid" 2>/dev/null || true
    fi
done
# Clean stale Chrome profile to avoid cached bad Service Workers
rm -rf /tmp/chrome-e2e-local 2>/dev/null || true
sleep 1

# ============================================================
# Prerequisite checks
# ============================================================

echo "=== Checking prerequisites ==="

# Video file
VIDEO_PATH="$ROOT_DIR/downloads/$VIDEO_NAME"
if [ ! -f "$VIDEO_PATH" ]; then
    echo "  ERROR: Video file not found: $VIDEO_PATH"
    echo "  Place an MP4 file (e.g. Big Buck Bunny) at that path."
    exit 1
fi
echo "  Video file: OK ($(du -h "$VIDEO_PATH" | cut -f1))"

# Node.js
if ! command -v node &>/dev/null; then
    echo "  ERROR: node not found. Install Node.js."
    exit 1
fi
echo "  Node.js: OK ($(node --version))"

# npm dependencies (ws + bittorrent-tracker)
if [ ! -d "$ROOT_DIR/node_modules/ws" ] || [ ! -d "$ROOT_DIR/node_modules/bittorrent-tracker" ]; then
    echo "  Installing npm dependencies..."
    cd "$ROOT_DIR" && npm install ws bittorrent-tracker
fi
echo "  npm deps: OK (ws, bittorrent-tracker)"

# Chrome
if [ ! -f "$CHROME" ]; then
    echo "  ERROR: Chrome not found at $CHROME"
    exit 1
fi
echo "  Chrome: OK"

# ============================================================
# Optional build step
# ============================================================

if [ "$DO_BUILD" = true ]; then
    echo ""
    echo "=== Building native (debug) ==="
    cd "$ROOT_DIR" && ./setup.sh debug

    echo ""
    echo "=== Building Flutter web ==="
    cd "$ROOT_DIR/flutter_seekserve_app" && flutter build web
fi

# Seeder binary
SEEDER="$ROOT_DIR/build/debug/tools/seekserve-seed"
if [ ! -f "$SEEDER" ]; then
    echo "  ERROR: Seeder binary not found at $SEEDER"
    echo "  Run: ./setup.sh debug  (or pass --build)"
    exit 1
fi
echo "  Seeder binary: OK"

# Flutter web build
WEB_DIR="$ROOT_DIR/flutter_seekserve_app/build/web"
if [ ! -d "$WEB_DIR" ]; then
    echo "  ERROR: Flutter web build not found at $WEB_DIR"
    echo "  Run: cd flutter_seekserve_app && flutter build web  (or pass --build)"
    exit 1
fi
echo "  Flutter web build: OK"

echo ""

# ============================================================
# Step 1: Generate .torrent
# ============================================================

TORRENT="$ROOT_DIR/fixtures/local_test/bbb_sunflower.torrent"
if [ ! -f "$TORRENT" ]; then
    echo "=== Step 1: Generate .torrent ==="
    python3 "$ROOT_DIR/scripts/create_test_torrent.py"
else
    echo "=== Step 1: .torrent exists ==="
fi

# Extract infohash from torrent
INFOHASH=$(python3 -c "
import hashlib
def bdecode_info_hash(path):
    with open(path, 'rb') as f:
        data = f.read()
    idx = data.find(b'4:infod')
    if idx == -1:
        import sys; print('ERROR: no info dict', file=sys.stderr); sys.exit(1)
    info_start = idx + 6
    depth = 0
    i = info_start
    while i < len(data):
        c = data[i:i+1]
        if c == b'd' or c == b'l':
            depth += 1; i += 1
        elif c == b'e':
            depth -= 1; i += 1
            if depth == 0: break
        elif c == b'i':
            i = data.index(b'e', i) + 1
        elif c.isdigit():
            colon = data.index(b':', i)
            slen = int(data[i:colon])
            i = colon + 1 + slen
        else:
            i += 1
    print(hashlib.sha1(data[info_start:i]).hexdigest())
bdecode_info_hash('$TORRENT')
")

MAGNET="magnet:?xt=urn:btih:${INFOHASH}&dn=${VIDEO_NAME}&tr=ws://127.0.0.1:${TRACKER_PORT}/announce"

echo ""
echo "============================================================"
echo "  URLs & Endpoints"
echo "============================================================"
echo "  Tracker:    ws://127.0.0.1:${TRACKER_PORT}/announce"
echo "  Web app:    http://127.0.0.1:${WEB_PORT}/"
echo "  Chrome CDP: http://127.0.0.1:${CDP_PORT}/json"
echo "  Infohash:   $INFOHASH"
echo "  Magnet URI: $MAGNET"
echo "============================================================"
echo ""

# ============================================================
# Step 2: Start WebSocket tracker
# ============================================================

echo "=== Step 2: Start WebSocket tracker (port $TRACKER_PORT) ==="
npx bittorrent-tracker --ws --ws-port "$TRACKER_PORT" &
PIDS+=($!)
sleep 2
echo "  Tracker PID: ${PIDS[${#PIDS[@]}-1]}"

# ============================================================
# Step 3: Start native seeder
# ============================================================

echo ""
echo "=== Step 3: Start native seeder ==="
"$SEEDER" "$TORRENT" "$ROOT_DIR/downloads" "ws://127.0.0.1:${TRACKER_PORT}/announce" &
PIDS+=($!)
sleep 3
echo "  Seeder PID: ${PIDS[${#PIDS[@]}-1]}"

# ============================================================
# Step 4: Serve Flutter web app
# ============================================================

echo ""
echo "=== Step 4: Serve Flutter web app (port $WEB_PORT) ==="
python3 "$ROOT_DIR/serve_coop.py" "$WEB_PORT" "$WEB_DIR" &
PIDS+=($!)
sleep 2
# Health check
if curl -sf -o /dev/null "http://127.0.0.1:${WEB_PORT}/"; then
    echo "  Server PID: ${PIDS[${#PIDS[@]}-1]} (verified)"
else
    echo "  ERROR: Web server not responding at http://127.0.0.1:${WEB_PORT}/"
    exit 1
fi

# ============================================================
# Step 5: Launch Chrome
# ============================================================

echo ""
echo "=== Step 5: Launch Chrome ==="
"$CHROME" \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir=/tmp/chrome-e2e-local \
    --no-first-run \
    --no-default-browser-check \
    --disable-extensions \
    "http://127.0.0.1:${WEB_PORT}/" &
PIDS+=($!)
sleep 5
echo "  Chrome PID: ${PIDS[${#PIDS[@]}-1]}"

# ============================================================
# Step 6: Run E2E test or wait for manual testing
# ============================================================

if [ "$DO_E2E" = true ]; then
    echo ""
    echo "=== Step 6: Run E2E test ==="
    cd "$ROOT_DIR"
    node "$ROOT_DIR/scripts/e2e/test_local_streaming_e2e.mjs" "$MAGNET"

    if [ "$DO_SCREENSHOTS" = true ]; then
        echo ""
        echo "=== Step 7: Taking screenshots ==="
        node "$ROOT_DIR/scripts/e2e/take_screenshots.mjs"
        echo "  Screenshots saved to /tmp/seekserve-screenshots/"
    fi
else
    echo ""
    echo "============================================================"
    echo "  All services running. Open Chrome and test manually."
    echo ""
    echo "  Web app:    http://127.0.0.1:${WEB_PORT}/"
    echo "  Magnet URI: $MAGNET"
    echo ""
    echo "  Press Ctrl+C to stop everything."
    echo "============================================================"
    # Wait until interrupted
    wait
fi
