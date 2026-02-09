set(VCPKG_TARGET_TRIPLET wasm32-emscripten)
set(VCPKG_CMAKE_SYSTEM_NAME Emscripten)
set(VCPKG_TARGET_ARCHITECTURE wasm32)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
# Emscripten supports pthreads but Boost.Asio doesn't auto-detect it.
# BOOST_ASIO_HAS_PTHREADS makes Asio use the POSIX code path (pthread_sigmask
# is stubbed in Emscripten, which is fine — signal_blocker becomes a no-op).
set(VCPKG_CXX_FLAGS "-pthread -DBOOST_ASIO_HAS_PTHREADS")
set(VCPKG_C_FLAGS "-pthread")

# Emscripten toolchain — resolve via EMSDK env var
if(DEFINED ENV{EMSDK})
    set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "$ENV{EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake")
endif()
