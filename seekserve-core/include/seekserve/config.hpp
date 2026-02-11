#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <chrono>

namespace seekserve {

struct SessionConfig {
    std::string save_path = "./downloads";
    bool enable_webtorrent = true;
    std::string stun_server = "stun:stun.l.google.com:19302";
    std::vector<std::string> extra_trackers;
    int listen_port_start = 6881;
    int listen_port_end = 6891;
    int alert_queue_size = 5000;
};

struct SchedulerConfig {
    int hot_window_pieces = 5;
    int lookahead_pieces = 20;
    int seek_boost_pieces = 10;
    int deadline_budget = 30;
    int seek_boost_duration_ms = 3000;

    std::int64_t min_contiguous_bytes = 2 * 1024 * 1024;  // 2 MB
    int stall_count_threshold = 3;
    double min_sustained_rate = 500'000;  // 500 KB/s
};

struct ServerConfig {
    std::string bind_address = "127.0.0.1";
    std::uint16_t stream_port = 0;   // 0 = auto
    std::uint16_t control_port = 0;  // 0 = auto
    int max_concurrent_streams = 4;
    std::chrono::seconds read_timeout{30};
    std::chrono::seconds connection_timeout{60};
};

struct CacheConfig {
    std::string db_path = "seekserve_cache.db";
    std::int64_t max_storage_bytes = 0;  // 0 = unlimited
    std::chrono::hours ttl{24 * 30};     // 30 days
    bool offline_download_enabled = true;
};

} // namespace seekserve
