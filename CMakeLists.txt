cmake_minimum_required(VERSION 3.21)
project(SeekServe VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# --- Options ---
option(SEEKSERVE_ENABLE_WEBTORRENT "Build libtorrent with WebTorrent (WebRTC)" ON)
option(SEEKSERVE_BUILD_TESTS "Build tests" ON)
option(SEEKSERVE_BUILD_DEMO "Build demo CLI" ON)
option(SEEKSERVE_BUILD_CAPI "Build C API library" ON)
option(SEEKSERVE_CAPI_STATIC "Build C API as static library (for iOS XCFramework)" OFF)

# --- libtorrent (submodule) ---
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(deprecated-functions OFF CACHE BOOL "" FORCE)
if(SEEKSERVE_ENABLE_WEBTORRENT)
    set(webtorrent ON CACHE BOOL "" FORCE)
endif()
add_subdirectory(extern/libtorrent EXCLUDE_FROM_ALL)

# --- vcpkg-managed dependencies ---
find_package(Boost REQUIRED COMPONENTS system)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(spdlog CONFIG REQUIRED)
find_package(unofficial-sqlite3 CONFIG REQUIRED)

# --- Subdirectories ---
add_subdirectory(seekserve-core)
add_subdirectory(seekserve-serve)

if(SEEKSERVE_BUILD_CAPI)
    add_subdirectory(seekserve-capi)
endif()

if(SEEKSERVE_BUILD_DEMO AND NOT EMSCRIPTEN)
    add_subdirectory(seekserve-demo)
endif()

if(NOT EMSCRIPTEN)
    add_subdirectory(tools)
endif()

if(SEEKSERVE_BUILD_TESTS AND NOT EMSCRIPTEN)
    enable_testing()
    add_subdirectory(tests)
endif()
