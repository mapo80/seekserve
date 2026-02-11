#include "seekserve/offline_cache.hpp"

#include <sqlite3.h>
#include <spdlog/spdlog.h>

namespace seekserve {

OfflineCacheManager::OfflineCacheManager(const CacheConfig& config)
    : config_(config)
{
    init_db();
}

OfflineCacheManager::~OfflineCacheManager() {
    if (db_) {
        sqlite3_close(db_);
        db_ = nullptr;
    }
}

void OfflineCacheManager::init_db() {
    int rc = sqlite3_open(config_.db_path.c_str(), &db_);
    if (rc != SQLITE_OK) {
        spdlog::error("OfflineCacheManager: failed to open db '{}': {}",
                      config_.db_path, sqlite3_errmsg(db_));
        return;
    }

#ifdef __EMSCRIPTEN__
    sqlite3_exec(db_, "PRAGMA journal_mode=MEMORY;", nullptr, nullptr, nullptr);
#else
    sqlite3_exec(db_, "PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);
#endif

    const char* sql = R"(
        CREATE TABLE IF NOT EXISTS cache_entries (
            torrent_id TEXT NOT NULL,
            file_index INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            progress REAL DEFAULT 0.0,
            offline_ready INTEGER DEFAULT 0,
            last_access INTEGER NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (torrent_id, file_index)
        );
    )";

    char* err = nullptr;
    rc = sqlite3_exec(db_, sql, nullptr, nullptr, &err);
    if (rc != SQLITE_OK) {
        spdlog::error("OfflineCacheManager: failed to create table: {}", err ? err : "unknown");
        sqlite3_free(err);
    }

    const char* torrents_sql = R"(
        CREATE TABLE IF NOT EXISTS torrents (
            torrent_id TEXT PRIMARY KEY,
            uri TEXT NOT NULL,
            added_at INTEGER NOT NULL
        );
    )";

    err = nullptr;
    rc = sqlite3_exec(db_, torrents_sql, nullptr, nullptr, &err);
    if (rc != SQLITE_OK) {
        spdlog::error("OfflineCacheManager: failed to create torrents table: {}", err ? err : "unknown");
        sqlite3_free(err);
    }

    // Migrate: add resume_data and selected_file columns if missing
    sqlite3_exec(db_, "ALTER TABLE torrents ADD COLUMN resume_data BLOB;",
                 nullptr, nullptr, nullptr);
    sqlite3_exec(db_, "ALTER TABLE torrents ADD COLUMN selected_file INTEGER DEFAULT -1;",
                 nullptr, nullptr, nullptr);
}

static std::int64_t now_epoch() {
    return std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

void OfflineCacheManager::on_torrent_added(const TorrentId& id, const std::vector<FileInfo>& files) {
    std::lock_guard lock(mu_);
    if (!db_) return;

    const char* sql = R"(
        INSERT OR IGNORE INTO cache_entries
            (torrent_id, file_index, file_path, file_size, progress, offline_ready, last_access, added_at)
        VALUES (?, ?, ?, ?, 0.0, 0, ?, ?);
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        spdlog::error("OfflineCacheManager: prepare failed: {}", sqlite3_errmsg(db_));
        return;
    }

    auto now = now_epoch();
    for (const auto& f : files) {
        sqlite3_reset(stmt);
        sqlite3_bind_text(stmt, 1, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt, 2, f.index);
        sqlite3_bind_text(stmt, 3, f.path.c_str(), static_cast<int>(f.path.size()), SQLITE_TRANSIENT);
        sqlite3_bind_int64(stmt, 4, f.size);
        sqlite3_bind_int64(stmt, 5, now);
        sqlite3_bind_int64(stmt, 6, now);

        if (sqlite3_step(stmt) != SQLITE_DONE) {
            spdlog::warn("OfflineCacheManager: insert failed for {}/{}: {}",
                         id, f.index, sqlite3_errmsg(db_));
        }
    }

    sqlite3_finalize(stmt);
}

void OfflineCacheManager::on_progress_update(const TorrentId& id, FileIndex fi, float progress) {
    std::lock_guard lock(mu_);
    if (!db_) return;

    const char* sql = R"(
        UPDATE cache_entries SET progress = ?, last_access = ?
        WHERE torrent_id = ? AND file_index = ?;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        spdlog::error("OfflineCacheManager: prepare failed: {}", sqlite3_errmsg(db_));
        return;
    }

    sqlite3_bind_double(stmt, 1, static_cast<double>(progress));
    sqlite3_bind_int64(stmt, 2, now_epoch());
    sqlite3_bind_text(stmt, 3, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 4, fi);

    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

void OfflineCacheManager::on_file_completed(const TorrentId& id, FileIndex fi) {
    std::lock_guard lock(mu_);
    if (!db_) return;

    const char* sql = R"(
        UPDATE cache_entries SET offline_ready = 1, progress = 1.0, last_access = ?
        WHERE torrent_id = ? AND file_index = ?;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        spdlog::error("OfflineCacheManager: prepare failed: {}", sqlite3_errmsg(db_));
        return;
    }

    sqlite3_bind_int64(stmt, 1, now_epoch());
    sqlite3_bind_text(stmt, 2, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 3, fi);

    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    spdlog::info("OfflineCacheManager: file {}/{} marked offline-ready", id, fi);
}

void OfflineCacheManager::on_access(const TorrentId& id, FileIndex fi) {
    std::lock_guard lock(mu_);
    if (!db_) return;

    const char* sql = R"(
        UPDATE cache_entries SET last_access = ?
        WHERE torrent_id = ? AND file_index = ?;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return;

    sqlite3_bind_int64(stmt, 1, now_epoch());
    sqlite3_bind_text(stmt, 2, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 3, fi);

    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

std::vector<CacheEntry> OfflineCacheManager::list_cached() const {
    std::lock_guard lock(mu_);
    std::vector<CacheEntry> entries;
    if (!db_) return entries;

    const char* sql = R"(
        SELECT torrent_id, file_index, file_path, file_size,
               progress, offline_ready, last_access, added_at
        FROM cache_entries ORDER BY last_access DESC;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return entries;

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        CacheEntry e;
        e.torrent_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        e.file_index = sqlite3_column_int(stmt, 1);
        e.file_path = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
        e.file_size = sqlite3_column_int64(stmt, 3);
        e.progress = static_cast<float>(sqlite3_column_double(stmt, 4));
        e.offline_ready = sqlite3_column_int(stmt, 5) != 0;
        e.last_access = std::chrono::system_clock::time_point(
            std::chrono::seconds(sqlite3_column_int64(stmt, 6)));
        e.added = std::chrono::system_clock::time_point(
            std::chrono::seconds(sqlite3_column_int64(stmt, 7)));
        entries.push_back(std::move(e));
    }

    sqlite3_finalize(stmt);
    return entries;
}

bool OfflineCacheManager::is_offline_ready(const TorrentId& id, FileIndex fi) const {
    std::lock_guard lock(mu_);
    if (!db_) return false;

    const char* sql = R"(
        SELECT offline_ready FROM cache_entries
        WHERE torrent_id = ? AND file_index = ?;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;

    sqlite3_bind_text(stmt, 1, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 2, fi);

    bool ready = false;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        ready = sqlite3_column_int(stmt, 0) != 0;
    }

    sqlite3_finalize(stmt);
    return ready;
}

void OfflineCacheManager::enforce_quota() {
    std::lock_guard lock(mu_);
    if (!db_ || config_.max_storage_bytes <= 0) return;

    const char* total_sql = R"(
        SELECT COALESCE(SUM(file_size), 0) FROM cache_entries;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, total_sql, -1, &stmt, nullptr) != SQLITE_OK) return;

    std::int64_t total = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        total = sqlite3_column_int64(stmt, 0);
    }
    sqlite3_finalize(stmt);

    if (total <= config_.max_storage_bytes) return;

    // Evict LRU entries until under quota
    const char* lru_sql = R"(
        SELECT torrent_id, file_index, file_size FROM cache_entries
        ORDER BY last_access ASC;
    )";

    if (sqlite3_prepare_v2(db_, lru_sql, -1, &stmt, nullptr) != SQLITE_OK) return;

    std::vector<std::pair<TorrentId, FileIndex>> to_delete;
    while (sqlite3_step(stmt) == SQLITE_ROW && total > config_.max_storage_bytes) {
        auto tid = std::string(reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0)));
        auto fi = sqlite3_column_int(stmt, 1);
        auto size = sqlite3_column_int64(stmt, 2);
        to_delete.emplace_back(tid, fi);
        total -= size;
    }
    sqlite3_finalize(stmt);

    const char* del_sql = R"(
        DELETE FROM cache_entries WHERE torrent_id = ? AND file_index = ?;
    )";

    if (sqlite3_prepare_v2(db_, del_sql, -1, &stmt, nullptr) != SQLITE_OK) return;

    for (const auto& [tid, fi] : to_delete) {
        sqlite3_reset(stmt);
        sqlite3_bind_text(stmt, 1, tid.c_str(), static_cast<int>(tid.size()), SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt, 2, fi);
        sqlite3_step(stmt);
        spdlog::info("OfflineCacheManager: evicted {}/{} (LRU)", tid, fi);
    }
    sqlite3_finalize(stmt);
}

void OfflineCacheManager::save_torrent_uri(const TorrentId& id, const std::string& uri) {
    std::lock_guard lock(mu_);
    if (!db_) return;

    const char* sql = R"(
        INSERT OR REPLACE INTO torrents (torrent_id, uri, added_at)
        VALUES (?, ?, ?);
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        spdlog::error("OfflineCacheManager: prepare failed: {}", sqlite3_errmsg(db_));
        return;
    }

    sqlite3_bind_text(stmt, 1, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, uri.c_str(), static_cast<int>(uri.size()), SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 3, now_epoch());

    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

void OfflineCacheManager::remove_torrent_uri(const TorrentId& id) {
    std::lock_guard lock(mu_);
    if (!db_) return;

    const char* sql = R"(
        DELETE FROM torrents WHERE torrent_id = ?;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return;

    sqlite3_bind_text(stmt, 1, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);

    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

std::vector<std::pair<TorrentId, std::string>> OfflineCacheManager::list_torrent_uris() const {
    std::lock_guard lock(mu_);
    std::vector<std::pair<TorrentId, std::string>> result;
    if (!db_) return result;

    const char* sql = R"(
        SELECT torrent_id, uri FROM torrents ORDER BY added_at;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return result;

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        auto tid = std::string(reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0)));
        auto uri = std::string(reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1)));
        result.emplace_back(std::move(tid), std::move(uri));
    }

    sqlite3_finalize(stmt);
    return result;
}

void OfflineCacheManager::save_resume_data(const TorrentId& id, const std::vector<char>& data) {
    std::lock_guard lock(mu_);
    if (!db_) return;

    const char* sql = R"(
        UPDATE torrents SET resume_data = ? WHERE torrent_id = ?;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        spdlog::error("OfflineCacheManager: prepare failed: {}", sqlite3_errmsg(db_));
        return;
    }

    sqlite3_bind_blob(stmt, 1, data.data(), static_cast<int>(data.size()), SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);

    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

std::vector<char> OfflineCacheManager::load_resume_data(const TorrentId& id) const {
    std::lock_guard lock(mu_);
    if (!db_) return {};

    const char* sql = R"(
        SELECT resume_data FROM torrents WHERE torrent_id = ?;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return {};

    sqlite3_bind_text(stmt, 1, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);

    std::vector<char> result;
    if (sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_type(stmt, 0) != SQLITE_NULL) {
        auto blob = static_cast<const char*>(sqlite3_column_blob(stmt, 0));
        auto size = sqlite3_column_bytes(stmt, 0);
        result.assign(blob, blob + size);
    }

    sqlite3_finalize(stmt);
    return result;
}

void OfflineCacheManager::save_selected_file(const TorrentId& id, FileIndex fi) {
    std::lock_guard lock(mu_);
    if (!db_) return;

    const char* sql = R"(
        UPDATE torrents SET selected_file = ? WHERE torrent_id = ?;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        spdlog::error("OfflineCacheManager: prepare failed: {}", sqlite3_errmsg(db_));
        return;
    }

    sqlite3_bind_int(stmt, 1, fi);
    sqlite3_bind_text(stmt, 2, id.c_str(), static_cast<int>(id.size()), SQLITE_TRANSIENT);

    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

std::vector<SavedTorrent> OfflineCacheManager::list_saved_torrents() const {
    std::lock_guard lock(mu_);
    std::vector<SavedTorrent> result;
    if (!db_) return result;

    const char* sql = R"(
        SELECT torrent_id, uri, resume_data, selected_file FROM torrents ORDER BY added_at;
    )";

    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) return result;

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        SavedTorrent t;
        t.id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        t.uri = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));

        if (sqlite3_column_type(stmt, 2) != SQLITE_NULL) {
            auto blob = static_cast<const char*>(sqlite3_column_blob(stmt, 2));
            auto size = sqlite3_column_bytes(stmt, 2);
            t.resume_data.assign(blob, blob + size);
        }

        t.selected_file = sqlite3_column_int(stmt, 3);
        result.push_back(std::move(t));
    }

    sqlite3_finalize(stmt);
    return result;
}

} // namespace seekserve
