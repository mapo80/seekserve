if(EMSCRIPTEN)
    # Emscripten needs an executable target to produce .js + .wasm + .worker.js.
    # A static/shared library would only produce a .a/.wasm side module.
    add_executable(seekserve-capi
        src/seekserve_c.cpp
    )
elseif(SEEKSERVE_CAPI_STATIC)
    add_library(seekserve-capi STATIC
        src/seekserve_c.cpp
    )
else()
    add_library(seekserve-capi SHARED
        src/seekserve_c.cpp
    )
endif()

target_include_directories(seekserve-capi
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

target_link_libraries(seekserve-capi
    PRIVATE
        seekserve-core
        seekserve-serve
)

set_target_properties(seekserve-capi PROPERTIES
    OUTPUT_NAME "seekserve"
    C_VISIBILITY_PRESET hidden
    CXX_VISIBILITY_PRESET hidden
)

if(EMSCRIPTEN)
    set_target_properties(seekserve-capi PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "-pthread -sPROXY_TO_PTHREAD -sALLOW_MEMORY_GROWTH=1 -sPTHREAD_POOL_SIZE=4 -sEXPORTED_FUNCTIONS=['_ss_engine_create','_ss_engine_destroy','_ss_add_torrent','_ss_remove_torrent','_ss_list_torrents','_ss_list_files','_ss_select_file','_ss_get_stream_url','_ss_get_status','_ss_set_event_callback','_ss_start_server','_ss_stop_server','_ss_free_string','_ss_read_bytes','_ss_get_file_size','_malloc','_free'] -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8'] -sMODULARIZE=1 -sEXPORT_NAME='SeekServeModule'"
    )
endif()
