#include "seekserve_c.h"
#include "seekserve/engine.hpp"

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

#include <cstring>
#include <string>

using json = nlohmann::json;

// The opaque handle is just a SeekServeEngine pointer.
struct SeekServeEngine : public seekserve::SeekServeEngine {
    using seekserve::SeekServeEngine::SeekServeEngine;
};

static ss_error_t map_error(const std::error_code& ec) {
    if (!ec) return SS_OK;

    using seekserve::errc;
    auto val = static_cast<errc>(ec.value());
    switch (val) {
        case errc::success:                return SS_OK;
        case errc::invalid_argument:       return SS_ERR_INVALID_ARG;
        case errc::torrent_not_found:
        case errc::file_not_found:         return SS_ERR_NOT_FOUND;
        case errc::metadata_not_ready:     return SS_ERR_METADATA_PENDING;
        case errc::timeout_waiting_for_piece: return SS_ERR_TIMEOUT;
        case errc::io_error:               return SS_ERR_IO;
        case errc::server_already_running: return SS_ERR_ALREADY_RUNNING;
        case errc::cancelled:              return SS_ERR_CANCELLED;
        default:                           return SS_ERR_IO;
    }
}

static char* alloc_string(const std::string& s) {
    char* buf = new (std::nothrow) char[s.size() + 1];
    if (buf) {
        std::memcpy(buf, s.c_str(), s.size() + 1);
    }
    return buf;
}

static seekserve::SeekServeEngine::Config parse_config(const char* config_json) {
    seekserve::SeekServeEngine::Config config;

    if (!config_json || config_json[0] == '\0') {
        return config;
    }

    try {
        auto j = json::parse(config_json);

        if (j.contains("save_path"))
            config.session.save_path = j["save_path"].get<std::string>();
        if (j.contains("auth_token"))
            config.auth_token = j["auth_token"].get<std::string>();
        if (j.contains("enable_webtorrent"))
            config.session.enable_webtorrent = j["enable_webtorrent"].get<bool>();
        if (j.contains("stream_port"))
            config.server.stream_port = j["stream_port"].get<std::uint16_t>();
        if (j.contains("control_port"))
            config.server.control_port = j["control_port"].get<std::uint16_t>();
        if (j.contains("max_storage_bytes"))
            config.cache.max_storage_bytes = j["max_storage_bytes"].get<std::int64_t>();
        if (j.contains("cache_db_path"))
            config.cache.db_path = j["cache_db_path"].get<std::string>();
        if (j.contains("log_level")) {
            auto level = j["log_level"].get<std::string>();
            if (level == "debug") spdlog::set_level(spdlog::level::debug);
            else if (level == "warn") spdlog::set_level(spdlog::level::warn);
            else if (level == "error") spdlog::set_level(spdlog::level::err);
            else spdlog::set_level(spdlog::level::info);
        }
        if (j.contains("extra_trackers")) {
            config.session.extra_trackers.clear();
            for (const auto& t : j["extra_trackers"]) {
                config.session.extra_trackers.push_back(t.get<std::string>());
            }
        }
    } catch (const std::exception& e) {
        spdlog::warn("C API: failed to parse config JSON: {}", e.what());
    }

    return config;
}

extern "C" {

SeekServeEngine* ss_engine_create(const char* config_json) {
    try {
        auto config = parse_config(config_json);
        return new (std::nothrow) SeekServeEngine(config);
    } catch (const std::exception& e) {
        spdlog::error("C API: ss_engine_create failed: {}", e.what());
        return nullptr;
    }
}

void ss_engine_destroy(SeekServeEngine* engine) {
    delete engine;
}

ss_error_t ss_add_torrent(SeekServeEngine* engine, const char* uri,
                          char* out_torrent_id, int32_t out_torrent_id_len) {
    if (!engine || !uri) return SS_ERR_INVALID_ARG;

    auto result = engine->add_torrent(uri);
    if (!result) return map_error(result.error());

    const auto& id = result.value();
    if (out_torrent_id && out_torrent_id_len > 0) {
        auto copy_len = std::min(static_cast<std::size_t>(out_torrent_id_len - 1), id.size());
        std::memcpy(out_torrent_id, id.c_str(), copy_len);
        out_torrent_id[copy_len] = '\0';
    }

    return SS_OK;
}

ss_error_t ss_remove_torrent(SeekServeEngine* engine, const char* torrent_id,
                             bool delete_files) {
    if (!engine || !torrent_id) return SS_ERR_INVALID_ARG;

    auto result = engine->remove_torrent(torrent_id, delete_files);
    return result ? SS_OK : map_error(result.error());
}

ss_error_t ss_list_torrents(SeekServeEngine* engine, char** out_json) {
    if (!engine || !out_json) return SS_ERR_INVALID_ARG;

    auto ids = engine->list_torrents();
    json arr = json::array();
    for (const auto& id : ids) {
        arr.push_back(id);
    }

    *out_json = alloc_string(arr.dump());
    return *out_json ? SS_OK : SS_ERR_IO;
}

ss_error_t ss_list_files(SeekServeEngine* engine, const char* torrent_id,
                         char** out_json) {
    if (!engine || !torrent_id || !out_json) return SS_ERR_INVALID_ARG;

    auto result = engine->list_files(torrent_id);
    if (!result) return map_error(result.error());

    json arr = json::array();
    for (const auto& f : result.value()) {
        arr.push_back(json{
            {"index", f.index},
            {"path", f.path},
            {"size", f.size},
            {"first_piece", f.first_piece},
            {"end_piece", f.end_piece}
        });
    }

    json response = {{"files", arr}};
    *out_json = alloc_string(response.dump());
    return *out_json ? SS_OK : SS_ERR_IO;
}

ss_error_t ss_select_file(SeekServeEngine* engine, const char* torrent_id,
                          int32_t file_index) {
    if (!engine || !torrent_id) return SS_ERR_INVALID_ARG;

    auto result = engine->select_file(torrent_id, file_index);
    return result ? SS_OK : map_error(result.error());
}

ss_error_t ss_get_stream_url(SeekServeEngine* engine, const char* torrent_id,
                             int32_t file_index, char** out_url) {
    if (!engine || !torrent_id || !out_url) return SS_ERR_INVALID_ARG;

    auto result = engine->get_stream_url(torrent_id, file_index);
    if (!result) return map_error(result.error());

    *out_url = alloc_string(result.value());
    return *out_url ? SS_OK : SS_ERR_IO;
}

ss_error_t ss_get_status(SeekServeEngine* engine, const char* torrent_id,
                         char** out_json) {
    if (!engine || !torrent_id || !out_json) return SS_ERR_INVALID_ARG;

    auto status_str = engine->get_status_json(torrent_id);
    *out_json = alloc_string(status_str);
    return *out_json ? SS_OK : SS_ERR_IO;
}

ss_error_t ss_set_event_callback(SeekServeEngine* engine,
                                 ss_event_callback_t callback, void* user_data) {
    if (!engine) return SS_ERR_INVALID_ARG;

    if (!callback) {
        engine->set_event_callback(nullptr);
        return SS_OK;
    }

    // Heap-allocate the event string so it survives until the Dart side
    // processes it (NativeCallable.listener dispatches asynchronously).
    // The callee frees via ss_free_string().
    engine->set_event_callback([callback, user_data](const std::string& event_json) {
        char* buf = alloc_string(event_json);
        if (buf) {
            callback(buf, user_data);
        }
    });

    return SS_OK;
}

ss_error_t ss_start_server(SeekServeEngine* engine, uint16_t port,
                           uint16_t* out_port) {
    if (!engine) return SS_ERR_INVALID_ARG;

    auto result = engine->start_server(port);
    if (!result) return map_error(result.error());

    if (out_port) *out_port = result.value();
    return SS_OK;
}

ss_error_t ss_stop_server(SeekServeEngine* engine) {
    if (!engine) return SS_ERR_INVALID_ARG;

    engine->stop_server();
    return SS_OK;
}

ss_error_t ss_read_bytes(SeekServeEngine* engine, const char* torrent_id,
                          int32_t file_index, uint64_t offset, uint64_t length,
                          uint8_t* out_buf, uint64_t* out_bytes_read) {
    if (!engine || !torrent_id || !out_buf || !out_bytes_read) return SS_ERR_INVALID_ARG;

    auto result = engine->read_bytes(torrent_id, file_index, offset, length, out_buf);
    if (!result) return map_error(result.error());

    *out_bytes_read = result.value();
    return SS_OK;
}

ss_error_t ss_get_file_size(SeekServeEngine* engine, const char* torrent_id,
                             int32_t file_index, uint64_t* out_size) {
    if (!engine || !torrent_id || !out_size) return SS_ERR_INVALID_ARG;

    auto result = engine->get_file_size(torrent_id, file_index);
    if (!result) return map_error(result.error());

    *out_size = result.value();
    return SS_OK;
}

#ifdef __EMSCRIPTEN__
ss_error_t ss_read_bytes_wasm(SeekServeEngine* engine, const char* torrent_id,
                               int32_t file_index,
                               uint32_t offset_lo, uint32_t offset_hi,
                               uint32_t length_lo, uint32_t length_hi,
                               uint8_t* out_buf, uint64_t* out_bytes_read) {
    uint64_t offset = static_cast<uint64_t>(offset_lo) | (static_cast<uint64_t>(offset_hi) << 32);
    uint64_t length = static_cast<uint64_t>(length_lo) | (static_cast<uint64_t>(length_hi) << 32);
    return ss_read_bytes(engine, torrent_id, file_index, offset, length, out_buf, out_bytes_read);
}
#endif

void ss_free_string(char* str) {
    delete[] str;
}

} // extern "C"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// Emscripten executable entry point (required for PROXY_TO_PTHREAD).
// Must NOT return — returning from main() with PROXY_TO_PTHREAD calls exit().
// emscripten_exit_with_live_runtime() keeps the runtime alive for ccall/cwrap.
int main() { emscripten_exit_with_live_runtime(); }
#endif
