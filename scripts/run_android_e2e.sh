#!/usr/bin/env bash
# Android Local Torrent Streaming E2E Test
#
# Pushes the .torrent + video file to the emulator/device, then runs the
# Flutter integration test.  The app loads metadata from the .torrent,
# finds the pre-seeded video, verifies pieces, and tests HTTP Range streaming.
#
# Usage:
#   ./scripts/run_android_e2e.sh              # run test (requires pre-built .so files)
#   ./scripts/run_android_e2e.sh --build      # rebuild native .so + jniLibs before test
#
# Prerequisites:
#   - Video file: downloads/bbb_sunflower_1080p_30fps_normal.mp4
#   - Android emulator booted or device connected via USB
#   - Pre-built .so files in flutter_seekserve/android/src/main/jniLibs/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VIDEO_NAME="bbb_sunflower_1080p_30fps_normal.mp4"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
DEVICE_SAVE_PATH="/data/local/tmp/seekserve_e2e"

# Add Android SDK tools to PATH if not already there
if ! command -v adb &>/dev/null && [ -f "$ANDROID_HOME/platform-tools/adb" ]; then
    export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
fi

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

DEVICE_ID=""

cleanup() {
    echo ""
    echo "=== Cleaning up ==="
    if [ -n "$DEVICE_ID" ]; then
        adb -s "$DEVICE_ID" shell "rm -rf $DEVICE_SAVE_PATH" 2>/dev/null || true
        echo "  Removed $DEVICE_SAVE_PATH on device"
    fi
    echo "Done."
}

trap cleanup EXIT

# ============================================================
# Detect connected Android device/emulator
# ============================================================

echo "=== Detecting Android device ==="
if ! command -v adb &>/dev/null; then
    echo "  ERROR: adb not found. Install Android SDK platform-tools."
    exit 1
fi

# Parse adb devices output, skip header line and empty lines
DEVICE_ID=$(adb devices -l 2>/dev/null | awk 'NR>1 && $2=="device" {print $1; exit}')

if [ -z "$DEVICE_ID" ]; then
    echo "  ERROR: No connected Android device/emulator found."
    echo "  Start an emulator or connect a device with USB debugging enabled."
    echo ""
    echo "  Available emulators:"
    if command -v emulator &>/dev/null; then
        emulator -list-avds 2>/dev/null | sed 's/^/    /'
    else
        echo "    (emulator command not found)"
    fi
    exit 1
fi

DEVICE_INFO=$(adb -s "$DEVICE_ID" devices -l 2>/dev/null | grep "$DEVICE_ID" | sed "s/$DEVICE_ID *device *//")
echo "  Device: $DEVICE_ID ($DEVICE_INFO)"

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

# Android native libraries
JNILIBS="$ROOT_DIR/flutter_seekserve/android/src/main/jniLibs"
if [ ! -d "$JNILIBS/arm64-v8a" ] && [ ! -d "$JNILIBS/x86_64" ]; then
    echo "  ERROR: Android .so files not found at $JNILIBS"
    echo "  Run: ./scripts/build-flutter-natives.sh  (or pass --build)"
    exit 1
fi
echo "  Android .so files: OK"

# ============================================================
# Optional build step
# ============================================================

if [ "$DO_BUILD" = true ]; then
    echo ""
    echo "=== Building Android native libraries ==="
    "$ROOT_DIR/scripts/build-flutter-natives.sh"
fi

# ============================================================
# Step 1: Generate .torrent (if needed)
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

# ============================================================
# Step 2: Push .torrent + video to device
# ============================================================

echo ""
echo "=== Step 2: Push files to device ==="
adb -s "$DEVICE_ID" shell "mkdir -p $DEVICE_SAVE_PATH"
echo "  Pushing .torrent..."
adb -s "$DEVICE_ID" push "$TORRENT" "$DEVICE_SAVE_PATH/bbb_sunflower.torrent"
echo "  Pushing video ($(du -h "$VIDEO_PATH" | cut -f1))..."
adb -s "$DEVICE_ID" push "$VIDEO_PATH" "$DEVICE_SAVE_PATH/$VIDEO_NAME"
# Make files world-readable so the app can access them
adb -s "$DEVICE_ID" shell "chmod -R 777 $DEVICE_SAVE_PATH"
echo "  Files pushed."

echo ""
echo "============================================================"
echo "  Android E2E Test Configuration"
echo "============================================================"
echo "  Device:       $DEVICE_ID"
echo "  Mode:         file (pre-seeded)"
echo "  Torrent:      $DEVICE_SAVE_PATH/bbb_sunflower.torrent"
echo "  Video:        $DEVICE_SAVE_PATH/$VIDEO_NAME"
echo "  Save path:    $DEVICE_SAVE_PATH"
echo "============================================================"
echo ""

# ============================================================
# Step 3: Run Flutter integration test
# ============================================================

echo "=== Step 3: Run Flutter integration test ==="
cd "$ROOT_DIR/flutter_seekserve_app"

flutter test integration_test/local_streaming_e2e_test.dart \
    -d "$DEVICE_ID" \
    --dart-define="TORRENT_PATH=$DEVICE_SAVE_PATH/bbb_sunflower.torrent" \
    --dart-define="SAVE_PATH=$DEVICE_SAVE_PATH" \
    --dart-define="VIDEO_NAME=$VIDEO_NAME"

echo ""
echo "=== Android E2E test complete ==="
