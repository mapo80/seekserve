#pragma once

#include <memory>
#include <string>
#include <unordered_map>
#include <mutex>
#include <vector>

#include <libtorrent/session.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/add_torrent_params.hpp>

#include "seekserve/types.hpp"
#include "seekserve/error.hpp"
#include "seekserve/config.hpp"
#include "seekserve/alert_dispatcher.hpp"

namespace seekserve {

struct AddTorrentParams {
    std::string uri;              // magnet: URI or .torrent file path
    std::string save_path;        // override default save path (optional)
};

class TorrentSessionManager {
public:
    explicit TorrentSessionManager(const SessionConfig& config);
    ~TorrentSessionManager();

    TorrentSessionManager(const TorrentSessionManager&) = delete;
    TorrentSessionManager& operator=(const TorrentSessionManager&) = delete;

    Result<TorrentId> add_torrent(const AddTorrentParams& params);
    Result<void> remove_torrent(const TorrentId& id, bool delete_files = false);

    lt::torrent_handle get_handle(const TorrentId& id) const;
    bool has_torrent(const TorrentId& id) const;
    std::vector<TorrentId> list_torrents() const;

    lt::session& session() { return *session_; }
    AlertDispatcher& alert_dispatcher() { return dispatcher_; }

    /// Store a handle from an add_torrent_alert (used on Emscripten where
    /// add_torrent() is non-blocking via async_add_torrent).
    void store_handle(const lt::torrent_handle& h);
    void store_handle(const lt::torrent_handle& h, const TorrentId& id);

    /// Reverse lookup: torrent_handle → TorrentId.
    /// Uses torrent_handle::operator== (weak_ptr comparison, no sync_call).
    /// Safe to call from any thread including AlertDispatcher on Emscripten.
    TorrentId id_from_handle(const lt::torrent_handle& h) const;

private:
    static lt::settings_pack make_settings(const SessionConfig& config);
    TorrentId torrent_id_from_handle(const lt::torrent_handle& h) const;

    SessionConfig config_;
    std::unique_ptr<lt::session> session_;
    AlertDispatcher dispatcher_;
    std::unordered_map<TorrentId, lt::torrent_handle> handles_;
    mutable std::mutex mu_;
};

} // namespace seekserve
