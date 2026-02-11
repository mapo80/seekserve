add_executable(seekserve-seed
    seed.cpp
)

target_link_libraries(seekserve-seed
    PRIVATE
        seekserve-capi
)
