#pragma once

#include <string>
#include <vector>
#include <mutex>
#include <chrono>

#include "seekserve/types.hpp"
#include "seekserve/config.hpp"

struct sqlite3;

namespace seekserve {

struct CacheEntry {
    TorrentId torrent_id;
    FileIndex file_index;
    std::string file_path;
    std::int64_t file_size;
    float progress;
    bool offline_ready;
    std::chrono::system_clock::time_point last_access;
    std::chrono::system_clock::time_point added;
};

struct SavedTorrent {
    TorrentId id;
    std::string uri;
    std::vector<char> resume_data;
    FileIndex selected_file = -1;
};

class OfflineCacheManager {
public:
    explicit OfflineCacheManager(const CacheConfig& config);
    ~OfflineCacheManager();

    OfflineCacheManager(const OfflineCacheManager&) = delete;
    OfflineCacheManager& operator=(const OfflineCacheManager&) = delete;

    void on_torrent_added(const TorrentId& id, const std::vector<FileInfo>& files);
    void on_progress_update(const TorrentId& id, FileIndex fi, float progress);
    void on_file_completed(const TorrentId& id, FileIndex fi);
    void on_access(const TorrentId& id, FileIndex fi);

    std::vector<CacheEntry> list_cached() const;
    bool is_offline_ready(const TorrentId& id, FileIndex fi) const;
    void enforce_quota();

    // Torrent URI persistence
    void save_torrent_uri(const TorrentId& id, const std::string& uri);
    void remove_torrent_uri(const TorrentId& id);
    std::vector<std::pair<TorrentId, std::string>> list_torrent_uris() const;

    // Resume data persistence
    void save_resume_data(const TorrentId& id, const std::vector<char>& data);
    std::vector<char> load_resume_data(const TorrentId& id) const;
    void save_selected_file(const TorrentId& id, FileIndex fi);
    std::vector<SavedTorrent> list_saved_torrents() const;

private:
    void init_db();

    CacheConfig config_;
    sqlite3* db_ = nullptr;
    mutable std::mutex mu_;
};

} // namespace seekserve
