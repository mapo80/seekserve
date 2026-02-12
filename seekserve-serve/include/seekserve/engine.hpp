#pragma once

#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <mutex>
#include <atomic>
#include <functional>
#include <thread>

#include <boost/asio/io_context.hpp>
#include <boost/asio/steady_timer.hpp>
#include <boost/asio/executor_work_guard.hpp>

#include "seekserve/types.hpp"
#include "seekserve/error.hpp"
#include "seekserve/config.hpp"
#include "seekserve/session_manager.hpp"
#include "seekserve/metadata_catalog.hpp"
#include "seekserve/piece_availability.hpp"
#include "seekserve/byte_range_mapper.hpp"
#include "seekserve/byte_source.hpp"
#include "seekserve/streaming_scheduler.hpp"
#include "seekserve/offline_cache.hpp"
#ifndef __EMSCRIPTEN__
#include "seekserve/http_range_server.hpp"
#include "seekserve/control_api_server.hpp"
#endif

namespace net = boost::asio;

namespace seekserve {

/// High-level facade that owns and wires all SeekServe modules.
/// Designed as the single entry point for the C API / Flutter FFI.
class SeekServeEngine {
public:
    struct Config {
        SessionConfig session;
        ServerConfig server;
        CacheConfig cache;
        SchedulerConfig scheduler;
        std::string auth_token;
    };

    explicit SeekServeEngine(const Config& config);
    ~SeekServeEngine();

    SeekServeEngine(const SeekServeEngine&) = delete;
    SeekServeEngine& operator=(const SeekServeEngine&) = delete;

    // Torrent management
    Result<TorrentId> add_torrent(const std::string& uri,
                                  const std::string& save_path = "");
    Result<void> remove_torrent(const TorrentId& id, bool delete_files);
    std::vector<TorrentId> list_torrents() const;

    // File management
    Result<std::vector<FileInfo>> list_files(const TorrentId& id);
    Result<void> select_file(const TorrentId& id, FileIndex fi);

    // Streaming
    Result<std::string> get_stream_url(const TorrentId& id, FileIndex fi);
    std::string get_status_json(const TorrentId& id);
    std::string get_pieces_json(const TorrentId& id);

    // Direct byte access (used by WASM via Service Worker)
    Result<std::size_t> read_bytes(const TorrentId& id, FileIndex fi,
                                    std::uint64_t offset, std::uint64_t length,
                                    std::uint8_t* out_buf);
    Result<std::uint64_t> get_file_size(const TorrentId& id, FileIndex fi);

    // Tracker
    Result<void> force_reannounce(const TorrentId& id);

    // Server lifecycle
    Result<std::uint16_t> start_server(std::uint16_t port = 0);
    void stop_server();

    // Event callbacks (fired from alert thread or timer thread)
    using EventCallback = std::function<void(const std::string& event_json)>;
    void set_event_callback(EventCallback cb);

private:
    struct TorrentState {
        PieceAvailabilityIndex avail;
        std::unique_ptr<ByteRangeMapper> mapper;
        std::shared_ptr<ByteSource> source;
        std::unique_ptr<StreamingScheduler> scheduler;
        FileIndex selected_file{-1};
    };

    void wire_alerts();
    void start_tick_timer();
    void on_tick(const boost::system::error_code& ec);
    static std::string infohash_to_hex(const lt::info_hash_t& ih);
    TorrentState* find_state(const TorrentId& id);
    void fire_event(const std::string& type, const std::string& data);

    Config config_;
    net::io_context ioc_;
    using work_guard_t = net::executor_work_guard<net::io_context::executor_type>;
    std::unique_ptr<work_guard_t> work_guard_;
    std::thread io_thread_;

    std::unique_ptr<TorrentSessionManager> sessions_;
    MetadataCatalog catalog_;
    std::unique_ptr<OfflineCacheManager> cache_;
#ifndef __EMSCRIPTEN__
    std::unique_ptr<HttpRangeServer> http_server_;
    std::unique_ptr<ControlApiServer> api_server_;
#endif
    std::unique_ptr<net::steady_timer> tick_timer_;

    std::unordered_map<TorrentId, std::unique_ptr<TorrentState>> states_;
    std::unordered_set<TorrentId> removed_ids_;  // guards alert handlers against late alerts
    std::unordered_map<TorrentId, FileIndex> pending_file_selections_;  // deferred select_file on restore
    mutable std::mutex mu_;

    EventCallback event_cb_;
    mutable std::mutex event_mu_;
    std::atomic<bool> has_event_cb_{false};  // fast-path check without locking event_mu_

    std::atomic<bool> server_running_{false};
    int resume_save_counter_{0};

#ifdef __EMSCRIPTEN__
    // On Emscripten, handle.status() is a sync_call that can deadlock when
    // called from the browser main thread (thread 0) because the session
    // thread may be blocked on __proxy:'sync' waiting for thread 0.
    // Solution: cache status from state_update_alert, return from cache.
    struct CachedStatus {
        std::string name;
        float progress{0};
        int download_rate{0}, upload_rate{0};
        int num_peers{0}, num_seeds{0};
        std::int64_t total_download{0}, total_upload{0};
        int state{0};  // lt::torrent_status::state_t
        bool has_metadata{false};
    };
    std::unordered_map<TorrentId, CachedStatus> cached_statuses_;
    mutable std::mutex status_mu_;

    // Accumulate piece completions per torrent so that select_file() can
    // pre-populate PieceAvailabilityIndex.  On WASM we skip handle.status(query_pieces)
    // (would deadlock), and piece_finished_alerts that fire before TorrentState
    // creation are otherwise lost.  Protected by mu_.
    std::unordered_map<TorrentId, std::unordered_set<PieceIndex>> completed_pieces_;
#endif
};

} // namespace seekserve
