set(SERVE_SOURCES
    src/engine.cpp
    src/range_parser.cpp
    src/token_auth.cpp
)
if(NOT EMSCRIPTEN)
    list(APPEND SERVE_SOURCES
        src/http_range_server.cpp
        src/control_api_server.cpp
    )
endif()
add_library(seekserve-serve STATIC ${SERVE_SOURCES})

target_include_directories(seekserve-serve
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

target_link_libraries(seekserve-serve
    PUBLIC
        seekserve-core
        Boost::system
        nlohmann_json::nlohmann_json
        spdlog::spdlog
)
