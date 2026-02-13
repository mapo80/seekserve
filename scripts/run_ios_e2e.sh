#!/usr/bin/env bash
# iOS Local Torrent Streaming E2E Test
#
# Starts tracker + native seeder, then runs the Flutter integration test
# on the booted iOS Simulator.
#
# Usage:
#   ./scripts/run_ios_e2e.sh              # run test (requires pre-built XCFramework)
#   ./scripts/run_ios_e2e.sh --build      # rebuild native + Flutter before test
#
# Prerequisites:
#   - Video file: downloads/bbb_sunflower_1080p_30fps_normal.mp4
#   - Booted iOS Simulator
#   - XCFramework built (or pass --build)
#   - Node.js + npm: ws, bittorrent-tracker

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TRACKER_PORT=8000
VIDEO_NAME="bbb_sunflower_1080p_30fps_normal.mp4"

DO_BUILD=false

for arg in "$@"; do
    case "$arg" in
        --build) DO_BUILD=true ;;
        -h|--help)
            head -14 "$0" | tail -12
            exit 0
            ;;
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
    echo "Done."
}

trap cleanup EXIT

# ============================================================
# Detect booted iOS Simulator
# ============================================================

echo "=== Detecting iOS Simulator ==="
SIM_UDID=$(xcrun simctl list devices booted -j 2>/dev/null \
    | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    for d in devices:
        if d.get('state') == 'Booted':
            print(d['udid'])
            sys.exit(0)
sys.exit(1)
" 2>/dev/null) || true

if [ -z "$SIM_UDID" ]; then
    echo "  ERROR: No booted iOS Simulator found."
    echo "  Boot one with: xcrun simctl boot <DEVICE_ID>"
    echo "  Or open Simulator.app from Xcode."
    exit 1
fi

SIM_NAME=$(xcrun simctl list devices booted | grep "$SIM_UDID" | sed 's/ (Booted)//;s/^[[:space:]]*//' | head -1)
echo "  Simulator: $SIM_NAME ($SIM_UDID)"

# ============================================================
# Kill stale processes on required ports
# ============================================================

echo ""
echo "=== Freeing ports ==="
pid=$(lsof -ti :"$TRACKER_PORT" 2>/dev/null || true)
if [ -n "$pid" ]; then
    echo "  Killing PID $pid on port $TRACKER_PORT"
    kill "$pid" 2>/dev/null || true
fi
# Clean stale seeder cache
rm -f /tmp/seekserve_seeder_cache.db /tmp/seekserve_seeder_cache.db-wal /tmp/seekserve_seeder_cache.db-shm 2>/dev/null || true
sleep 1

# ============================================================
# Prerequisite checks
# ============================================================

echo ""
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

# npm dependencies
if [ ! -d "$ROOT_DIR/node_modules/ws" ] || [ ! -d "$ROOT_DIR/node_modules/bittorrent-tracker" ]; then
    echo "  Installing npm dependencies..."
    cd "$ROOT_DIR" && npm install ws bittorrent-tracker
fi
echo "  npm deps: OK (ws, bittorrent-tracker)"

# Seeder binary
SEEDER="$ROOT_DIR/build/debug/tools/seekserve-seed"
if [ ! -f "$SEEDER" ]; then
    SEEDER="$ROOT_DIR/build/release/tools/seekserve-seed"
fi
if [ ! -f "$SEEDER" ]; then
    echo "  ERROR: Seeder binary not found. Run: ./setup.sh debug"
    exit 1
fi
echo "  Seeder binary: OK"

# XCFramework
XCF="$ROOT_DIR/flutter_seekserve/ios/Frameworks/seekserve.xcframework"
if [ ! -d "$XCF" ]; then
    echo "  ERROR: XCFramework not found at $XCF"
    echo "  Run: ./scripts/build-ios.sh  (or pass --build)"
    exit 1
fi
echo "  XCFramework: OK"

# ============================================================
# Optional build step
# ============================================================

if [ "$DO_BUILD" = true ]; then
    echo ""
    echo "=== Building native + XCFramework ==="
    "$ROOT_DIR/scripts/dev-ios-sim.sh" --native

    echo ""
    echo "=== Flutter pub get ==="
    cd "$ROOT_DIR/flutter_seekserve_app" && flutter pub get
fi

# ============================================================
# Step 1: Generate .torrent
# ============================================================

TORRENT="$ROOT_DIR/fixtures/local_test/bbb_sunflower.torrent"
if [ ! -f "$TORRENT" ]; then
    echo ""
    echo "=== Step 1: Generate .torrent ==="
    python3 "$ROOT_DIR/scripts/create_test_torrent.py"
else
    echo ""
    echo "=== Step 1: .torrent exists ==="
fi

# Extract infohash
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

echo ""
echo "============================================================"
echo "  iOS E2E Test Configuration"
echo "============================================================"
echo "  Simulator:  $SIM_NAME ($SIM_UDID)"
echo "  Tracker:    ws://127.0.0.1:${TRACKER_PORT}/announce"
echo "  Infohash:   $INFOHASH"
echo "  Video:      $VIDEO_NAME"
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
# Step 4: Run Flutter integration test
# ============================================================

echo ""
echo "=== Step 4: Run Flutter integration test ==="
cd "$ROOT_DIR/flutter_seekserve_app"

flutter test integration_test/local_streaming_e2e_test.dart \
    -d "$SIM_UDID" \
    --dart-define="INFOHASH=$INFOHASH" \
    --dart-define="TRACKER_URL=ws://127.0.0.1:${TRACKER_PORT}/announce" \
    --dart-define="VIDEO_NAME=$VIDEO_NAME"

echo ""
echo "=== iOS E2E test complete ==="
