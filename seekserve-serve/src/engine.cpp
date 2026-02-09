#include "seekserve/engine.hpp"

#include <spdlog/spdlog.h>
#include <nlohmann/json.hpp>

#include <libtorrent/alert_types.hpp>
#include <libtorrent/hex.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/file_storage.hpp>

#include <filesystem>

namespace seekserve {

namespace net = boost::asio;
using json = nlohmann::json;

SeekServeEngine::SeekServeEngine(const Config& config)
    : config_(config)
{
    sessions_ = std::make_unique<TorrentSessionManager>(config_.session);
    cache_ = std::make_unique<OfflineCacheManager>(config_.cache);
    wire_alerts();

    // Auto-restore persisted torrents
    auto saved = cache_->list_torrent_uris();
    for (const auto& [id, uri] : saved) {
        AddTorrentParams atp;
        atp.uri = uri;
        atp.save_path = config_.session.save_path;
        auto result = sessions_->add_torrent(atp);
        if (!result) {
            spdlog::warn("Engine: failed to restore torrent {}: {}", id, result.error().message());
            cache_->remove_torrent_uri(id);
        }
    }
    if (!saved.empty()) {
        spdlog::info("Engine: restored {} torrent(s)", saved.size());
    }
}

SeekServeEngine::~SeekServeEngine() {
    stop_server();

    // CRITICAL: Stop alert dispatcher FIRST — handlers reference catalog_, cache_, states_.
    // Must stop before those members are destroyed.
    if (sessions_) {
        sessions_->alert_dispatcher().stop();
    }

#ifndef __EMSCRIPTEN__
    api_server_.reset();
    http_server_.reset();
#endif
    states_.clear();
    cache_.reset();
    // catalog_ and sessions_ destroyed implicitly in member order
}

void SeekServeEngine::wire_alerts() {
    // metadata_received_alert → catalog + event
    sessions_->alert_dispatcher().on<lt::metadata_received_alert>(
        [this](const lt::metadata_received_alert& a) {
            auto ti = a.handle.torrent_file();
            auto st = a.handle.status(lt::torrent_handle::query_name);
            auto id = infohash_to_hex(st.info_hashes);

            // Guard: skip if torrent was explicitly removed
            {
                std::lock_guard lock(mu_);
                if (removed_ids_.count(id)) return;
            }

            catalog_.on_metadata_received(id, ti);

            auto files_result = catalog_.list_files(id);
            if (files_result) {
                cache_->on_torrent_added(id, files_result.value());
            }

            fire_event("metadata_received", "{\"torrent_id\":\"" + id + "\"}");
        });

    // add_torrent_alert → catalog (for .torrent files with embedded metadata)
    sessions_->alert_dispatcher().on<lt::add_torrent_alert>(
        [this](const lt::add_torrent_alert& a) {
            if (a.error) {
                spdlog::error("Engine: add_torrent error: {}", a.error.message());
                fire_event("error", "{\"message\":\"" + a.error.message() + "\"}");
                return;
            }
            auto ti = a.handle.torrent_file();
            if (ti) {
                auto st = a.handle.status(lt::torrent_handle::query_name);
                auto id = infohash_to_hex(st.info_hashes);

                // Guard: skip if torrent was explicitly removed
                {
                    std::lock_guard lock(mu_);
                    if (removed_ids_.count(id)) return;
                }

                catalog_.on_metadata_received(id, ti);

                auto files_result = catalog_.list_files(id);
                if (files_result) {
                    cache_->on_torrent_added(id, files_result.value());
                }

                fire_event("metadata_received", "{\"torrent_id\":\"" + id + "\"}");
            }
        });

    // piece_finished_alert → availability + scheduler + byte_source
    sessions_->alert_dispatcher().on<lt::piece_finished_alert>(
        [this](const lt::piece_finished_alert& a) {
            auto st = a.handle.status(lt::torrent_handle::query_name);
            auto id = infohash_to_hex(st.info_hashes);
            auto piece = static_cast<PieceIndex>(a.piece_index);

            std::lock_guard lock(mu_);
            auto* state = find_state(id);
            if (state) {
                state->avail.mark_complete(piece);
                if (state->source) state->source->notify_piece_complete();
                if (state->scheduler) state->scheduler->on_piece_complete(piece);
            }
        });

    // file_completed_alert → cache
    sessions_->alert_dispatcher().on<lt::file_completed_alert>(
        [this](const lt::file_completed_alert& a) {
            auto st = a.handle.status(lt::torrent_handle::query_name);
            auto id = infohash_to_hex(st.info_hashes);
            auto fi = static_cast<FileIndex>(a.index);

            cache_->on_file_completed(id, fi);
            fire_event("file_completed",
                "{\"torrent_id\":\"" + id + "\",\"file_index\":" + std::to_string(fi) + "}");
        });
}

Result<TorrentId> SeekServeEngine::add_torrent(const std::string& uri,
                                                const std::string& save_path) {
    AddTorrentParams atp;
    atp.uri = uri;
    atp.save_path = save_path;
    auto result = sessions_->add_torrent(atp);
    if (result) {
        cache_->save_torrent_uri(result.value(), uri);
    }
    return result;
}

Result<void> SeekServeEngine::remove_torrent(const TorrentId& id, bool delete_files) {
    cache_->remove_torrent_uri(id);

    // Mark as removed FIRST so alert handlers skip late alerts for this torrent
    {
        std::lock_guard lock(mu_);
        removed_ids_.insert(id);
        states_.erase(id);
    }
    catalog_.remove(id);
    return sessions_->remove_torrent(id, delete_files);
}

std::vector<TorrentId> SeekServeEngine::list_torrents() const {
    // Return from DB (ordered by added_at) rather than the session's
    // unordered_map so the UI shows torrents in insertion order.
    auto saved = cache_->list_torrent_uris();
    std::vector<TorrentId> ids;
    ids.reserve(saved.size());
    for (auto& [id, uri] : saved) {
        ids.push_back(std::move(id));
    }
    return ids;
}

Result<std::vector<FileInfo>> SeekServeEngine::list_files(const TorrentId& id) {
    return catalog_.list_files(id);
}

Result<void> SeekServeEngine::select_file(const TorrentId& id, FileIndex fi) {
    auto handle = sessions_->get_handle(id);
    if (!handle.is_valid()) {
        return make_error_code(errc::torrent_not_found);
    }

    auto result = catalog_.select_file(id, fi, handle);
    if (!result) return result;

    auto ti = catalog_.torrent_info(id);
    if (!ti) {
        return make_error_code(errc::metadata_not_ready);
    }

    // Create per-torrent state for this file selection
    auto state = std::make_unique<TorrentState>();

    int num_pieces = ti->num_pieces();
    int piece_length = ti->piece_length();
    int last_piece_size = static_cast<int>(
        ti->total_size() - static_cast<std::int64_t>(num_pieces - 1) * piece_length);

    state->avail.reset(num_pieces, piece_length, last_piece_size);

    // Pre-populate availability with already-downloaded pieces.
    // Without this, ByteSource::read() would block waiting for pieces
    // that are already on disk, since piece_finished_alert only fires
    // for NEW completions after this point.
    {
        auto st = handle.status(lt::torrent_handle::query_pieces);
        for (int p = 0; p < num_pieces; ++p) {
            if (st.pieces.get_bit(lt::piece_index_t{p})) {
                state->avail.mark_complete(static_cast<PieceIndex>(p));
            }
        }
    }

    state->mapper = std::make_unique<ByteRangeMapper>(ti->layout(), fi);
    state->selected_file = fi;

    // Build file path on disk
    auto file_info = catalog_.get_file(id, fi);
    auto file_path = (std::filesystem::path(config_.session.save_path) /
                      file_info.value().path).string();

    state->source = std::make_shared<ByteSource>(
        handle, fi, file_path, *state->mapper, state->avail,
        std::chrono::duration_cast<std::chrono::milliseconds>(config_.server.read_timeout));

    state->scheduler = std::make_unique<StreamingScheduler>(
        config_.scheduler, state->avail, *state->mapper);

    // Register byte source on HTTP server if running
#ifndef __EMSCRIPTEN__
    if (http_server_) {
        http_server_->set_byte_source(state->source, id, fi, file_info.value().path);

        // Wire range callback → scheduler
        auto* sched_ptr = state->scheduler.get();
        http_server_->set_range_callback(
            [sched_ptr, handle](const ByteRange& range,
                                const TorrentId&, FileIndex) mutable {
                sched_ptr->on_range_request(range, handle);
            });
    }
#endif

    {
        std::lock_guard lock(mu_);
        states_[id] = std::move(state);
    }

    return {};
}

Result<std::string> SeekServeEngine::get_stream_url(const TorrentId& id, FileIndex fi) {
    if (!sessions_->has_torrent(id)) {
        return make_error_code(errc::torrent_not_found);
    }
#ifdef __EMSCRIPTEN__
    return "/seekserve-stream/" + id + "/" + std::to_string(fi);
#else
    if (!http_server_) {
        return make_error_code(errc::session_not_started);
    }
    return http_server_->stream_url(id, fi);
#endif
}

std::string SeekServeEngine::get_status_json(const TorrentId& id) {
    json status_json;

    auto handle = sessions_->get_handle(id);
    if (!handle.is_valid()) {
        status_json["error"] = "torrent not found";
        return status_json.dump();
    }

    auto st = handle.status();
    auto selected = catalog_.selected_file(id);

    status_json["torrent_id"] = id;
    status_json["name"] = st.name;
    status_json["progress"] = st.progress;
    status_json["download_rate"] = st.download_rate;
    status_json["upload_rate"] = st.upload_rate;
    status_json["num_peers"] = st.num_peers;
    status_json["num_seeds"] = st.num_seeds;
    status_json["total_download"] = st.total_download;
    status_json["total_upload"] = st.total_upload;
    status_json["state"] = static_cast<int>(st.state);
    status_json["has_metadata"] = catalog_.has_metadata(id);
    status_json["selected_file"] = selected.has_value() ? json(*selected) : json(nullptr);

    if (selected.has_value()) {
        status_json["offline_ready"] = cache_->is_offline_ready(id, *selected);
    }

    {
        std::lock_guard lock(mu_);
        auto* state = find_state(id);
        if (state && state->scheduler) {
            status_json["stream_mode"] = static_cast<int>(state->scheduler->current_mode());
            status_json["playhead_piece"] = state->scheduler->playhead_piece();
            status_json["active_deadlines"] = state->scheduler->active_deadlines();
        }
    }

    return status_json.dump();
}

Result<std::uint16_t> SeekServeEngine::start_server(std::uint16_t port) {
    if (server_running_.load()) {
        return make_error_code(errc::server_already_running);
    }

#ifdef __EMSCRIPTEN__
    // On WASM: no HTTP servers, just start io_context for tick timer
    work_guard_ = std::make_unique<work_guard_t>(ioc_.get_executor());
    io_thread_ = std::thread([this]() { ioc_.run(); });
    start_tick_timer();
    server_running_.store(true);
    spdlog::info("Engine: WASM mode started (no HTTP servers)");
    return 0;  // no real port on web
#else
    // Create servers
    http_server_ = std::make_unique<HttpRangeServer>(ioc_, config_.server);
    http_server_->set_auth_token(config_.auth_token);

    api_server_ = std::make_unique<ControlApiServer>(
        ioc_, *sessions_, catalog_, *http_server_, *cache_, config_.auth_token);

    api_server_->set_shutdown_callback([this]() {
        stop_server();
    });

    // Start HTTP range server
    auto stream_result = http_server_->start(config_.server.stream_port);
    if (!stream_result) return stream_result;

    // Start control API server
    auto api_result = api_server_->start(port);
    if (!api_result) {
        http_server_->stop();
        return api_result;
    }

    // Start io_context with work guard
    work_guard_ = std::make_unique<work_guard_t>(ioc_.get_executor());
    io_thread_ = std::thread([this]() { ioc_.run(); });

    // Start scheduler tick timer
    start_tick_timer();

    server_running_.store(true);
    spdlog::info("Engine: servers started (stream:{}, api:{})",
                 http_server_->port(), api_server_->port());

    return api_result.value();
#endif
}

void SeekServeEngine::stop_server() {
    if (!server_running_.exchange(false)) return;

    if (tick_timer_) {
        tick_timer_->cancel();
        tick_timer_.reset();
    }

#ifndef __EMSCRIPTEN__
    if (api_server_) api_server_->stop();
    if (http_server_) http_server_->stop();
#endif

    // Cancel all active ByteSources so in-flight reads unblock immediately
    {
        std::lock_guard lock(mu_);
        for (auto& [id, state] : states_) {
            if (state->source) state->source->cancel();
        }
    }

    if (work_guard_) {
        work_guard_.reset();
    }
    ioc_.stop();

    if (io_thread_.joinable()) {
        io_thread_.join();
    }

    spdlog::info("Engine: servers stopped");
}

void SeekServeEngine::set_event_callback(EventCallback cb) {
    std::lock_guard lock(event_mu_);
    event_cb_ = std::move(cb);
}

void SeekServeEngine::start_tick_timer() {
    tick_timer_ = std::make_unique<net::steady_timer>(ioc_);
    on_tick({});
}

void SeekServeEngine::on_tick(const boost::system::error_code& ec) {
    if (ec) return;

    {
        std::lock_guard lock(mu_);
        for (auto& [id, state] : states_) {
            if (!state->scheduler) continue;
            auto handle = sessions_->get_handle(id);
            if (!handle.is_valid()) continue;
            auto st = handle.status();
            state->scheduler->tick(handle, st);

            // Update cache progress for selected file
            if (state->selected_file >= 0 && state->mapper) {
                int first = state->mapper->first_piece();
                int end = state->mapper->end_piece();
                int completed = 0;
                for (int p = first; p < end; ++p) {
                    if (state->avail.is_complete(p)) ++completed;
                }
                int total = end - first;
                float progress = total > 0
                    ? static_cast<float>(completed) / static_cast<float>(total)
                    : 0.0f;
                cache_->on_progress_update(id, state->selected_file, progress);
            }
        }
    }

    tick_timer_->expires_after(std::chrono::seconds(1));
    tick_timer_->async_wait([this](const boost::system::error_code& ec2) {
        on_tick(ec2);
    });
}

Result<std::size_t> SeekServeEngine::read_bytes(const TorrentId& id, FileIndex fi,
                                                 std::uint64_t offset, std::uint64_t length,
                                                 std::uint8_t* out_buf) {
    // Grab source pointer under lock, then release — read() blocks on cv_
    // and piece_finished_alert handler also takes mu_, so holding mu_ here
    // would deadlock.
    std::shared_ptr<ByteSource> source;
    {
        std::lock_guard lock(mu_);
        auto* state = find_state(id);
        if (!state) return make_error_code(errc::torrent_not_found);
        if (state->selected_file != fi) return make_error_code(errc::file_not_found);
        if (!state->source) return make_error_code(errc::metadata_not_ready);
        source = state->source;
    }

    auto result = source->read(static_cast<std::int64_t>(offset),
                                static_cast<std::int64_t>(length));
    if (!result) return result.error();

    const auto& data = result.value();
    std::memcpy(out_buf, data.data(), data.size());
    return data.size();
}

Result<std::uint64_t> SeekServeEngine::get_file_size(const TorrentId& id, FileIndex fi) {
    std::lock_guard lock(mu_);
    auto* state = find_state(id);
    if (!state) return make_error_code(errc::torrent_not_found);
    if (state->selected_file != fi) return make_error_code(errc::file_not_found);
    if (!state->source) return make_error_code(errc::metadata_not_ready);

    return static_cast<std::uint64_t>(state->source->file_size());
}

std::string SeekServeEngine::infohash_to_hex(const lt::info_hash_t& ih) {
    if (ih.has_v2()) {
        return lt::aux::to_hex({ih.v2.data(), static_cast<ptrdiff_t>(ih.v2.size())});
    }
    return lt::aux::to_hex({ih.v1.data(), static_cast<ptrdiff_t>(ih.v1.size())});
}

SeekServeEngine::TorrentState* SeekServeEngine::find_state(const TorrentId& id) {
    auto it = states_.find(id);
    return it != states_.end() ? it->second.get() : nullptr;
}

void SeekServeEngine::fire_event(const std::string& type, const std::string& data) {
    std::lock_guard lock(event_mu_);
    if (event_cb_) {
        std::string event = "{\"type\":\"" + type + "\",\"data\":" + data + "}";
        event_cb_(event);
    }
}

} // namespace seekserve
