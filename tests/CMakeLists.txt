find_package(GTest CONFIG REQUIRED)

include(GoogleTest)

# --- Unit tests ---
add_executable(seekserve-unit-tests
    unit/test_byte_range_mapper.cpp
    unit/test_piece_availability.cpp
    unit/test_metadata_catalog.cpp
    unit/test_byte_source.cpp
    unit/test_streaming_scheduler.cpp
    unit/test_range_parser.cpp
    unit/test_offline_cache.cpp
    unit/test_resume_data.cpp
)

target_link_libraries(seekserve-unit-tests
    PRIVATE
        seekserve-core
        seekserve-serve
        GTest::gtest
        GTest::gtest_main
        GTest::gmock
)

target_compile_definitions(seekserve-unit-tests PRIVATE
    SEEKSERVE_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/fixtures"
)

gtest_discover_tests(seekserve-unit-tests)

# --- Integration tests ---
add_executable(seekserve-integration-tests
    integration/test_session_lifecycle.cpp
    integration/test_http_range_server.cpp
    integration/test_end_to_end_stream.cpp
    integration/test_stress.cpp
)

target_link_libraries(seekserve-integration-tests
    PRIVATE
        seekserve-core
        seekserve-serve
        GTest::gtest
        GTest::gtest_main
        GTest::gmock
)

target_compile_definitions(seekserve-integration-tests PRIVATE
    SEEKSERVE_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/fixtures"
)

gtest_discover_tests(seekserve-integration-tests)

# --- C API tests ---
add_executable(seekserve-capi-tests
    unit/test_capi.cpp
)

target_link_libraries(seekserve-capi-tests
    PRIVATE
        seekserve-capi
        GTest::gtest
        GTest::gtest_main
)

target_compile_definitions(seekserve-capi-tests PRIVATE
    SEEKSERVE_FIXTURE_DIR="${CMAKE_SOURCE_DIR}/fixtures"
)

gtest_discover_tests(seekserve-capi-tests)
