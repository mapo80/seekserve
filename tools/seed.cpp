/**
 * seekserve-seed — Minimal CLI seeder using the SeekServe C API.
 *
 * Usage:
 *   seekserve-seed <torrent_file> <save_path> [tracker_url]
 *
 * Example:
 *   ./build/debug/seekserve-seed fixtures/local_test/bbb_sunflower.torrent downloads/ ws://localhost:8000/announce
 *
 * Seeds until Ctrl+C.
 */
#include "seekserve_c.h"

#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

static volatile sig_atomic_t g_running = 1;

static void signal_handler(int) { g_running = 0; }

static void event_callback(const char* event_json, void* /*user_data*/) {
    printf("[event] %s\n", event_json);
}

int main(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <torrent_file> <save_path> [tracker_url]\n", argv[0]);
        return 1;
    }

    const char* torrent_file = argv[1];
    const char* save_path = argv[2];
    const char* tracker = argc > 3 ? argv[3] : "ws://localhost:8000/announce";
    const char* stun = argc > 4 ? argv[4] : nullptr;

    // Build config JSON
    std::string config = std::string("{") +
        "\"save_path\":\"" + save_path + "\"," +
        "\"enable_webtorrent\":true," +
        "\"extra_trackers\":[\"" + tracker + "\"]," +
        "\"cache_db_path\":\"/tmp/seekserve_seeder_cache.db\"," +
        "\"log_level\":\"info\"";
    if (stun) {
        config += std::string(",\"stun_server\":\"") + stun + "\"";
    }
    config += "}";

    printf("=== SeekServe Seeder ===\n");
    printf("Torrent:  %s\n", torrent_file);
    printf("Save:     %s\n", save_path);
    printf("Tracker:  %s\n", tracker);
    printf("Config:   %s\n", config.c_str());

    // Create engine
    SeekServeEngine* engine = ss_engine_create(config.c_str());
    if (!engine) {
        fprintf(stderr, "ERROR: ss_engine_create() failed\n");
        return 1;
    }

    // Set event callback
    ss_set_event_callback(engine, event_callback, nullptr);

    // Add torrent
    char torrent_id[256] = {};
    ss_error_t err = ss_add_torrent(engine, torrent_file, torrent_id, sizeof(torrent_id));
    if (err != SS_OK) {
        fprintf(stderr, "ERROR: ss_add_torrent() = %d\n", err);
        ss_engine_destroy(engine);
        return 1;
    }
    printf("Torrent ID: %s\n", torrent_id);

    // Start HTTP server (needed for engine alert loop)
    uint16_t port = 0;
    err = ss_start_server(engine, 0, &port);
    if (err != SS_OK) {
        fprintf(stderr, "WARNING: ss_start_server() = %d (continuing without HTTP server)\n", err);
    } else {
        printf("HTTP server on port %d\n", port);
    }

    printf("\nSeeding... Press Ctrl+C to stop.\n\n");

    // Wait for signal
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    int no_peers_ticks = 0;
    bool has_metadata = false;

    while (g_running) {
        // Poll status every 5 seconds
        char* status_json = nullptr;
        err = ss_get_status(engine, torrent_id, &status_json);
        if (err == SS_OK && status_json) {
            printf("\r[status] %s", status_json);
            fflush(stdout);

            // Track metadata state
            if (!has_metadata && strstr(status_json, "\"has_metadata\":true")) {
                has_metadata = true;
            }

            // Parse num_peers to detect disconnection
            const char* peers_key = strstr(status_json, "\"num_peers\":");
            int num_peers = 0;
            if (peers_key) {
                num_peers = atoi(peers_key + strlen("\"num_peers\":"));
            }

            if (num_peers > 0) {
                no_peers_ticks = 0;
            } else if (has_metadata) {
                no_peers_ticks++;
                // After 3 ticks (15s) with no peers, force re-announce to
                // send fresh SDP offers through the tracker
                if (no_peers_ticks >= 3) {
                    printf("\n[seeder] No peers for %ds, forcing re-announce\n", no_peers_ticks * 5);
                    ss_force_reannounce(engine, torrent_id);
                    no_peers_ticks = 0;
                }
            }

            ss_free_string(status_json);
        }

        for (int i = 0; i < 50 && g_running; i++) {
            struct timespec ts = {0, 100000000}; // 100ms
            nanosleep(&ts, nullptr);
        }
    }

    printf("\n\nShutting down...\n");
    ss_engine_destroy(engine);
    printf("Done.\n");
    return 0;
}
