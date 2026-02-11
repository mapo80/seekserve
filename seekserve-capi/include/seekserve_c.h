#ifndef SEEKSERVE_C_H
#define SEEKSERVE_C_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SeekServeEngine SeekServeEngine;

typedef int32_t ss_error_t;
#define SS_OK                    0
#define SS_ERR_INVALID_ARG      -1
#define SS_ERR_NOT_FOUND        -2
#define SS_ERR_METADATA_PENDING -3
#define SS_ERR_TIMEOUT          -4
#define SS_ERR_IO               -5
#define SS_ERR_ALREADY_RUNNING  -6
#define SS_ERR_CANCELLED        -7

typedef void (*ss_event_callback_t)(const char* event_json, void* user_data);

__attribute__((visibility("default")))
SeekServeEngine* ss_engine_create(const char* config_json);

__attribute__((visibility("default")))
void ss_engine_destroy(SeekServeEngine* engine);

__attribute__((visibility("default")))
ss_error_t ss_add_torrent(SeekServeEngine* engine,
                          const char* uri,
                          char* out_torrent_id,
                          int32_t out_torrent_id_len);

__attribute__((visibility("default")))
ss_error_t ss_remove_torrent(SeekServeEngine* engine,
                             const char* torrent_id,
                             bool delete_files);

__attribute__((visibility("default")))
ss_error_t ss_list_torrents(SeekServeEngine* engine,
                            char** out_json);

__attribute__((visibility("default")))
ss_error_t ss_list_files(SeekServeEngine* engine,
                         const char* torrent_id,
                         char** out_json);

__attribute__((visibility("default")))
ss_error_t ss_select_file(SeekServeEngine* engine,
                          const char* torrent_id,
                          int32_t file_index);

__attribute__((visibility("default")))
ss_error_t ss_get_stream_url(SeekServeEngine* engine,
                             const char* torrent_id,
                             int32_t file_index,
                             char** out_url);

__attribute__((visibility("default")))
ss_error_t ss_get_status(SeekServeEngine* engine,
                         const char* torrent_id,
                         char** out_json);

__attribute__((visibility("default")))
ss_error_t ss_get_pieces(SeekServeEngine* engine,
                         const char* torrent_id,
                         char** out_json);

__attribute__((visibility("default")))
ss_error_t ss_set_event_callback(SeekServeEngine* engine,
                                 ss_event_callback_t callback,
                                 void* user_data);

__attribute__((visibility("default")))
ss_error_t ss_start_server(SeekServeEngine* engine,
                           uint16_t port,
                           uint16_t* out_port);

__attribute__((visibility("default")))
ss_error_t ss_stop_server(SeekServeEngine* engine);

__attribute__((visibility("default")))
ss_error_t ss_read_bytes(SeekServeEngine* engine,
                          const char* torrent_id,
                          int32_t file_index,
                          uint64_t offset,
                          uint64_t length,
                          uint8_t* out_buf,
                          uint64_t* out_bytes_read);

__attribute__((visibility("default")))
ss_error_t ss_get_file_size(SeekServeEngine* engine,
                             const char* torrent_id,
                             int32_t file_index,
                             uint64_t* out_size);

__attribute__((visibility("default")))
void ss_free_string(char* str);

#ifdef __EMSCRIPTEN__
/* WASM-only wrapper: Emscripten splits uint64_t VALUE params into two i32s at
   the ABI level, but cwrap('number') only passes one i32 per param.  This
   wrapper accepts offset and length as explicit (lo, hi) pairs so that JS
   cwrap can call it correctly with 'number' arguments. */
__attribute__((visibility("default")))
ss_error_t ss_read_bytes_wasm(SeekServeEngine* engine,
                               const char* torrent_id,
                               int32_t file_index,
                               uint32_t offset_lo, uint32_t offset_hi,
                               uint32_t length_lo, uint32_t length_hi,
                               uint8_t* out_buf,
                               uint64_t* out_bytes_read);
#endif

#ifdef __cplusplus
}
#endif

#endif /* SEEKSERVE_C_H */
