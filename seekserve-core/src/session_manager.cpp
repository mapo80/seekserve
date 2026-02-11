#include "seekserve/session_manager.hpp"

#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/load_torrent.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/session_params.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/hex.hpp>

#include <spdlog/spdlog.h>

#include <fstream>

namespace seekserve {

TorrentSessionManager::TorrentSessionManager(const SessionConfig& config)
    : config_(config)
{
    auto sp = make_settings(config);
    session_ = std::make_unique<lt::session>(lt::session_params{sp});
    dispatcher_.start(*session_);

    spdlog::info("TorrentSessionManager: session created (save_path={})", config_.save_path);
}

TorrentSessionManager::~TorrentSessionManager() {
    spdlog::info("TorrentSessionManager: shutting down");
    dispatcher_.stop();
    session_->abort();
}

lt::settings_pack TorrentSessionManager::make_settings(const SessionConfig& config) {
    lt::settings_pack sp;

    sp.set_int(lt::settings_pack::alert_mask,
        lt::alert_category::status
        | lt::alert_category::piece_progress
        | lt::alert_category::error
        | lt::alert_category::storage
        | lt::alert_category::dht
        | lt::alert_category::peer
        | lt::alert_category::tracker
        | lt::alert_category::torrent_log
        | lt::alert_category::session_log);

    sp.set_str(lt::settings_pack::listen_interfaces,
        "0.0.0.0:" + std::to_string(config.listen_port_start) +
        ",[::0]:" + std::to_string(config.listen_port_start));

    sp.set_int(lt::settings_pack::request_timeout, 10);
    sp.set_int(lt::settings_pack::peer_timeout, 30);
    sp.set_bool(lt::settings_pack::strict_end_game_mode, false);
    sp.set_bool(lt::settings_pack::announce_to_all_tiers, true);
    sp.set_bool(lt::settings_pack::announce_to_all_trackers, true);
    sp.set_bool(lt::settings_pack::enable_dht, true);

    sp.set_int(lt::settings_pack::alert_queue_size, config.alert_queue_size);

#ifdef TORRENT_USE_RTC
    if (config.enable_webtorrent) {
        if (!config.stun_server.empty()) {
            sp.set_str(lt::settings_pack::webtorrent_stun_server, config.stun_server);
        }
        spdlog::info("WebTorrent enabled (STUN: {})", config.stun_server.empty() ? "(none)" : config.stun_server);
    }
#endif

    return sp;
}

Result<TorrentId> TorrentSessionManager::add_torrent(const AddTorrentParams& params) {
    lt::add_torrent_params atp;

    if (!params.resume_data.empty()) {
        lt::error_code ec;
        atp = lt::read_resume_data(params.resume_data, ec);
        if (ec) {
            spdlog::warn("Failed to read resume data: {}, falling back to URI", ec.message());
            atp = {};
        } else {
            spdlog::info("TorrentSessionManager: using resume data");
        }
    }

    // If resume data wasn't provided or failed to parse, use URI
    if (!atp.ti && atp.info_hashes == lt::info_hash_t{}) {
        if (params.uri.substr(0, 7) == "magnet:") {
            lt::error_code ec;
            lt::parse_magnet_uri(params.uri, atp, ec);
            if (ec) {
                spdlog::error("Failed to parse magnet URI: {}", ec.message());
                return make_error_code(errc::invalid_argument);
            }
        } else {
            lt::error_code ec;
            atp = lt::load_torrent_file(params.uri, ec, lt::load_torrent_limits{});
            if (ec) {
                spdlog::error("Failed to load .torrent file '{}': {}", params.uri, ec.message());
                return make_error_code(errc::invalid_argument);
            }
        }
    }

    atp.save_path = params.save_path.empty() ? config_.save_path : params.save_path;

    for (const auto& tracker : config_.extra_trackers) {
        atp.trackers.push_back(tracker);
    }

#ifdef __EMSCRIPTEN__
    // On Emscripten, use async_add_torrent to avoid blocking the main thread
    // (which would deadlock with __proxy:'sync' datachannel-wasm calls).
    auto ih = atp.info_hashes;
    session_->async_add_torrent(std::move(atp));

    TorrentId id;
    if (ih.has_v2()) {
        id = lt::aux::to_hex({ih.v2.data(), static_cast<ptrdiff_t>(ih.v2.size())});
    } else {
        id = lt::aux::to_hex({ih.v1.data(), static_cast<ptrdiff_t>(ih.v1.size())});
    }
    // Handle stored asynchronously via add_torrent_alert handler in constructor
#else
    lt::torrent_handle h = session_->add_torrent(std::move(atp));
    auto id = torrent_id_from_handle(h);

    {
        std::lock_guard lock(mu_);
        handles_[id] = h;
    }
#endif

    spdlog::info("TorrentSessionManager: added torrent {}", id);
    return id;
}

Result<void> TorrentSessionManager::remove_torrent(const TorrentId& id, bool delete_files) {
    std::lock_guard lock(mu_);
    auto it = handles_.find(id);
    if (it == handles_.end()) {
        return make_error_code(errc::torrent_not_found);
    }

    lt::remove_flags_t flags{};
    if (delete_files) {
        flags = lt::session::delete_files;
    }

    session_->remove_torrent(it->second, flags);
    handles_.erase(it);
    spdlog::info("TorrentSessionManager: removed torrent {}", id);
    return Result<void>{};
}

lt::torrent_handle TorrentSessionManager::get_handle(const TorrentId& id) const {
    std::lock_guard lock(mu_);
    auto it = handles_.find(id);
    if (it == handles_.end()) {
        return {};
    }
    return it->second;
}

bool TorrentSessionManager::has_torrent(const TorrentId& id) const {
    std::lock_guard lock(mu_);
    return handles_.count(id) > 0;
}

std::vector<TorrentId> TorrentSessionManager::list_torrents() const {
    std::lock_guard lock(mu_);
    std::vector<TorrentId> ids;
    ids.reserve(handles_.size());
    for (const auto& [id, _] : handles_) {
        ids.push_back(id);
    }
    return ids;
}

void TorrentSessionManager::store_handle(const lt::torrent_handle& h) {
    // On Emscripten, torrent_id_from_handle() calls h.status() which is a
    // blocking sync_call to the session thread. When called from the
    // AlertDispatcher thread this deadlocks. Use info_hashes() from the
    // handle's internal weak_ptr directly — but that's also a sync_call.
    // So use the overload with pre-computed id instead.
    auto id = torrent_id_from_handle(h);
    std::lock_guard lock(mu_);
    handles_[id] = h;
    spdlog::debug("TorrentSessionManager: stored handle for {}", id);
}

void TorrentSessionManager::store_handle(const lt::torrent_handle& h, const TorrentId& id) {
    std::lock_guard lock(mu_);
    handles_[id] = h;
    spdlog::debug("TorrentSessionManager: stored handle for {}", id);
}

TorrentId TorrentSessionManager::torrent_id_from_handle(const lt::torrent_handle& h) const {
    auto status = h.status(lt::torrent_handle::query_name);
    auto ih = status.info_hashes;
    if (ih.has_v2()) {
        return lt::aux::to_hex({ih.v2.data(), static_cast<ptrdiff_t>(ih.v2.size())});
    }
    return lt::aux::to_hex({ih.v1.data(), static_cast<ptrdiff_t>(ih.v1.size())});
}

TorrentId TorrentSessionManager::id_from_handle(const lt::torrent_handle& h) const {
    std::lock_guard lock(mu_);
    for (const auto& [id, stored_h] : handles_) {
        if (stored_h == h) return id;
    }
    return {};
}

} // namespace seekserve
