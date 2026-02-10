#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VCPKG_DIR="${VCPKG_ROOT:-$HOME/vcpkg}"
BUILD_TYPE="${1:-debug}"

echo "=== SeekServe Setup ==="
echo "Project dir: $SCRIPT_DIR"
echo "Build type:  $BUILD_TYPE"
echo ""

# --- 1. System dependencies (macOS) ---
if [[ "$(uname)" == "Darwin" ]]; then
    echo "[1/6] Checking system dependencies..."
    for tool in cmake ninja git; do
        if ! command -v "$tool" &>/dev/null; then
            echo "  Installing $tool via Homebrew..."
            brew install "$tool"
        else
            echo "  $tool: OK ($(command -v "$tool"))"
        fi
    done
else
    echo "[1/6] Checking system dependencies..."
    for tool in cmake ninja git; do
        if ! command -v "$tool" &>/dev/null; then
            echo "  ERROR: $tool not found. Install it and retry."
            exit 1
        else
            echo "  $tool: OK"
        fi
    done
fi

# --- 2. vcpkg ---
echo ""
echo "[2/6] Setting up vcpkg at $VCPKG_DIR..."
if [ ! -f "$VCPKG_DIR/vcpkg" ]; then
    if [ ! -d "$VCPKG_DIR" ]; then
        echo "  Cloning vcpkg (full clone, required for baselines)..."
        git clone https://github.com/microsoft/vcpkg.git "$VCPKG_DIR"
    else
        # Ensure it's not shallow
        if git -C "$VCPKG_DIR" rev-parse --is-shallow-repository 2>/dev/null | grep -q true; then
            echo "  Unshallowing existing vcpkg clone..."
            git -C "$VCPKG_DIR" fetch --unshallow
        fi
    fi
    echo "  Bootstrapping vcpkg..."
    "$VCPKG_DIR/bootstrap-vcpkg.sh" -disableMetrics
else
    echo "  vcpkg already bootstrapped."
fi
export VCPKG_ROOT="$VCPKG_DIR"

# --- 3. Git submodules (libtorrent master + all deps) ---
echo ""
echo "[3/6] Initializing git submodules..."
cd "$SCRIPT_DIR"
git submodule update --init
# libtorrent's own submodules (libdatachannel, json, try_signal, asio-gnutls)
# --force ensures working trees are restored even if .git files already exist
cd extern/libtorrent
git submodule update --init --recursive --force
cd "$SCRIPT_DIR"

# --- 4. WebTorrent deps (libdatachannel) ---
echo ""
echo "[4/6] Checking WebTorrent dependencies..."
WEBTORRENT="OFF"
if [ -f "extern/libtorrent/deps/libdatachannel/CMakeLists.txt" ]; then
    echo "  libdatachannel found. WebTorrent: ON"
    WEBTORRENT="ON"
else
    echo "  libdatachannel NOT found. WebTorrent: OFF"
    echo "  Nested submodule init may have failed. Try:"
    echo "    cd extern/libtorrent && git submodule update --init --recursive"
fi

# --- 5. CMake configure ---
echo ""
echo "[5/6] CMake configure (preset: $BUILD_TYPE)..."
rm -rf "$SCRIPT_DIR/build/$BUILD_TYPE"

# Map build type to CMake build type and optional sanitizer flags
CMAKE_BUILD_TYPE="Debug"
EXTRA_C_FLAGS=""
EXTRA_CXX_FLAGS=""
EXTRA_LINKER_FLAGS=""

case "$BUILD_TYPE" in
    debug)
        CMAKE_BUILD_TYPE="Debug"
        ;;
    release)
        CMAKE_BUILD_TYPE="Release"
        ;;
    asan)
        CMAKE_BUILD_TYPE="Debug"
        EXTRA_C_FLAGS="-fsanitize=address -fno-omit-frame-pointer"
        EXTRA_CXX_FLAGS="-fsanitize=address -fno-omit-frame-pointer"
        EXTRA_LINKER_FLAGS="-fsanitize=address"
        echo "  AddressSanitizer enabled"
        ;;
    tsan)
        CMAKE_BUILD_TYPE="Debug"
        EXTRA_C_FLAGS="-fsanitize=thread"
        EXTRA_CXX_FLAGS="-fsanitize=thread"
        EXTRA_LINKER_FLAGS="-fsanitize=thread"
        echo "  ThreadSanitizer enabled"
        ;;
    wasm)
        echo "  WASM build via Docker (Emscripten)"
        echo ""
        echo "Running docker/build-wasm.sh ..."
        exec "$SCRIPT_DIR/docker/build-wasm.sh"
        ;;
    *)
        echo "  Unknown build type '$BUILD_TYPE', using Debug"
        ;;
esac

cmake -S "$SCRIPT_DIR" -B "$SCRIPT_DIR/build/$BUILD_TYPE" \
    -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$VCPKG_DIR/scripts/buildsystems/vcpkg.cmake" \
    -DCMAKE_BUILD_TYPE="$CMAKE_BUILD_TYPE" \
    -DCMAKE_C_FLAGS="$EXTRA_C_FLAGS" \
    -DCMAKE_CXX_FLAGS="$EXTRA_CXX_FLAGS" \
    -DCMAKE_EXE_LINKER_FLAGS="$EXTRA_LINKER_FLAGS" \
    -DCMAKE_SHARED_LINKER_FLAGS="$EXTRA_LINKER_FLAGS" \
    -DSEEKSERVE_ENABLE_WEBTORRENT="$WEBTORRENT" \
    -DSEEKSERVE_BUILD_TESTS=ON \
    -DSEEKSERVE_BUILD_DEMO=ON \
    -DSEEKSERVE_BUILD_CAPI=ON

# --- 6. Build ---
echo ""
echo "[6/6] Building..."
cmake --build "$SCRIPT_DIR/build/$BUILD_TYPE" -- -j "$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

echo ""
echo "=== Build complete ==="
echo "Demo:  $SCRIPT_DIR/build/$BUILD_TYPE/seekserve-demo/seekserve-demo"
echo "Tests: $SCRIPT_DIR/build/$BUILD_TYPE/tests/seekserve-unit-tests"
echo ""
echo "Usage:"
echo "  ./build/$BUILD_TYPE/seekserve-demo/seekserve-demo <torrent-file-or-magnet>"
