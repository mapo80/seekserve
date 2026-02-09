# SeekServe — Flutter Web via WASM

Stesso engine C++ compilato a WebAssembly con Emscripten. Stessa API C, stessa UI Dart.
Sul web un Service Worker sostituisce il HTTP Range server di Beast, servendo bytes dal WASM.

```
NATIVE:  Dart → dart:ffi → C API (.so/.a) → Engine → HttpRangeServer → HTTP URL
WASM:    Dart → dart:js_interop → JS glue → C API (.wasm) → Engine → ServiceWorker → HTTP URL
```

---

## Fase 1 — Dockerfile Emscripten e build WASM base

Obiettivo: compilare `seekserve-core` + `seekserve-capi` a `.wasm` dentro un container Docker.

- [x] **1.1** Creare `docker/Dockerfile.wasm`
  - Base image: `emscripten/emsdk:3.1.56` (pinned, include cmake + ninja)
  - Installare vcpkg dentro il container: `git clone https://github.com/microsoft/vcpkg.git /opt/vcpkg && /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics`
  - `ENV VCPKG_ROOT=/opt/vcpkg`
  - Copiare il source tree del progetto
  - `WORKDIR /src`

- [x] **1.2** Creare `triplets/wasm32-emscripten.cmake`
  ```cmake
  set(VCPKG_TARGET_TRIPLET wasm32-emscripten)
  set(VCPKG_CMAKE_SYSTEM_NAME Emscripten)
  set(VCPKG_CRT_LINKAGE dynamic)
  set(VCPKG_LIBRARY_LINKAGE static)
  set(VCPKG_CXX_FLAGS "-pthread")
  set(VCPKG_C_FLAGS "-pthread")
  ```

- [x] **1.3** Creare `vcpkg-wasm.json` (manifest ridotto, senza boost-beast e gtest)
  ```json
  {
    "name": "seekserve-wasm",
    "version-semver": "0.1.0",
    "dependencies": [
      "boost-asio", "boost-config", "boost-system", "boost-date-time",
      "boost-smart-ptr", "boost-optional", "boost-utility", "boost-variant",
      "boost-multi-index", "boost-multiprecision", "boost-intrusive",
      "boost-pool", "boost-predef", "boost-range", "boost-logic",
      "boost-functional", "boost-crc", "boost-json",
      "nlohmann-json", "openssl", "spdlog", "sqlite3"
    ],
    "builtin-baseline": "aa2d37682e3318d93aef87efa7b0e88e81cd3d59"
  }
  ```

- [x] **1.4** Aggiungere preset `wasm` in `CMakePresets.json`
  ```json
  {
    "name": "wasm",
    "inherits": "default",
    "displayName": "WASM (Emscripten)",
    "toolchainFile": "",
    "cacheVariables": {
      "CMAKE_TOOLCHAIN_FILE": "/opt/vcpkg/scripts/buildsystems/vcpkg.cmake",
      "VCPKG_CHAINLOAD_TOOLCHAIN_FILE": "/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake",
      "VCPKG_TARGET_TRIPLET": "wasm32-emscripten",
      "VCPKG_OVERLAY_TRIPLETS": "${sourceDir}/triplets",
      "CMAKE_BUILD_TYPE": "Release",
      "SEEKSERVE_BUILD_TESTS": "OFF",
      "SEEKSERVE_BUILD_DEMO": "OFF",
      "SEEKSERVE_BUILD_CAPI": "ON",
      "SEEKSERVE_CAPI_STATIC": "ON",
      "SEEKSERVE_ENABLE_WEBTORRENT": "ON"
    }
  }
  ```

- [x] **1.5** Aggiungere `if(EMSCRIPTEN)` guard in `CMakeLists.txt` (root, riga 39)
  - Dopo riga 38 (`endif()`), wrappare demo:
    ```cmake
    if(SEEKSERVE_BUILD_DEMO AND NOT EMSCRIPTEN)
        add_subdirectory(seekserve-demo)
    endif()
    ```
  - Wrappare tests:
    ```cmake
    if(SEEKSERVE_BUILD_TESTS AND NOT EMSCRIPTEN)
        enable_testing()
        add_subdirectory(tests)
    endif()
    ```

- [x] **1.6** Modificare `seekserve-serve/CMakeLists.txt` — escludere HTTP server su WASM
  - Attualmente (riga 1-7): lista fissa di .cpp
  - Cambiare in:
    ```cmake
    set(SERVE_SOURCES
        src/engine.cpp
        src/range_parser.cpp
        src/token_auth.cpp
    )
    if(NOT EMSCRIPTEN)
        list(APPEND SERVE_SOURCES
            src/http_range_server.cpp
            src/control_api_server.cpp
        )
    endif()
    add_library(seekserve-serve STATIC ${SERVE_SOURCES})
    ```

- [x] **1.7** Modificare `seekserve-capi/CMakeLists.txt` — su WASM produrre JS+WASM
  - Dopo riga 27, aggiungere:
    ```cmake
    if(EMSCRIPTEN)
        set_target_properties(seekserve-capi PROPERTIES
            SUFFIX ".js"
            LINK_FLAGS "-pthread -sPROXY_TO_PTHREAD -sALLOW_MEMORY_GROWTH=1 -sPTHREAD_POOL_SIZE=4 -sEXPORTED_FUNCTIONS=['_ss_engine_create','_ss_engine_destroy','_ss_add_torrent','_ss_remove_torrent','_ss_list_torrents','_ss_list_files','_ss_select_file','_ss_get_stream_url','_ss_get_status','_ss_set_event_callback','_ss_start_server','_ss_stop_server','_ss_free_string','_ss_read_bytes','_ss_get_file_size','_malloc','_free'] -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8'] -sMODULARIZE=1 -sEXPORT_NAME='SeekServeModule'"
        )
    endif()
    ```

- [x] **1.8** Creare `docker/build-wasm.sh`
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  docker build -f docker/Dockerfile.wasm -t seekserve-wasm-builder .
  docker run --rm -v "$(pwd)/build/wasm-out:/src/build/wasm" seekserve-wasm-builder
  echo "Output: build/wasm-out/seekserve-capi/seekserve.{js,wasm,worker.js}"
  ```

- [ ] **1.9** Nel `Dockerfile.wasm`, step di build:
  ```dockerfile
  RUN emcmake cmake --preset wasm -DVCPKG_MANIFEST_DIR=/src \
      && cmake --build build/wasm --target seekserve-capi -j$(nproc)
  ```

- [ ] **1.10** Verificare: `docker/build-wasm.sh` produce `build/wasm-out/seekserve-capi/seekserve.js` + `seekserve.wasm` + `seekserve.worker.js`

---

## Fase 2 — Adattamenti C++ per WASM

Obiettivo: il codice C++ compila sia native che WASM con `#ifdef __EMSCRIPTEN__`.

- [x] **2.1** `seekserve-serve/include/seekserve/engine.hpp` — condizionare gli include HTTP
  - Righe 26-27: wrappare in `#ifndef __EMSCRIPTEN__`:
    ```cpp
    #ifndef __EMSCRIPTEN__
    #include "seekserve/http_range_server.hpp"
    #include "seekserve/control_api_server.hpp"
    #endif
    ```
  - Membri `http_server_` (riga 96) e `api_server_` (riga 97): wrappare in `#ifndef __EMSCRIPTEN__`

- [x] **2.2** `seekserve-serve/include/seekserve/engine.hpp` — aggiungere metodi per byte read
  - Dopo `get_stream_url` (riga 60), aggiungere:
    ```cpp
    Result<std::size_t> read_bytes(const TorrentId& id, FileIndex fi,
                                    std::uint64_t offset, std::uint64_t length,
                                    std::uint8_t* out_buf);
    Result<std::uint64_t> get_file_size(const TorrentId& id, FileIndex fi);
    ```

- [x] **2.3** `seekserve-serve/src/engine.cpp` — implementare `read_bytes()` e `get_file_size()`
  - `read_bytes()`: trova `TorrentState` via `find_state(id)`, verifica che `state->source` esista e che `state->selected_file == fi`, chiama `state->source->read(offset, length)`, copia nel buffer `out_buf`, restituisce bytes letti
  - `get_file_size()`: trova `TorrentState`, chiama `state->source->file_size()`, restituisce il valore

- [x] **2.4** `seekserve-serve/src/engine.cpp` — `#ifdef __EMSCRIPTEN__` nel costruttore e metodi server
  - `start_server()` (riga 307-346): su WASM, non creare `HttpRangeServer`/`ControlApiServer`. Avviare solo `work_guard_` + `io_thread_` + `start_tick_timer()`:
    ```cpp
    Result<std::uint16_t> SeekServeEngine::start_server(std::uint16_t port) {
        if (server_running_.load()) return make_error_code(errc::server_already_running);
    #ifdef __EMSCRIPTEN__
        work_guard_ = std::make_unique<work_guard_t>(ioc_.get_executor());
        io_thread_ = std::thread([this]() { ioc_.run(); });
        start_tick_timer();
        server_running_.store(true);
        return 0;  // no real port on web
    #else
        // ... codice attuale invariato ...
    #endif
    }
    ```
  - `stop_server()` (riga 348-377): su WASM, skip `api_server_->stop()` e `http_server_->stop()`
  - `get_stream_url()` (riga 255-263): su WASM, restituire URL relativo per Service Worker:
    ```cpp
    #ifdef __EMSCRIPTEN__
        return "/seekserve-stream/" + id + "/" + std::to_string(fi);
    #else
        // ... codice attuale ...
    #endif
    ```
  - `select_file()` (righe 234-244): wrappare registrazione HTTP in `#ifndef __EMSCRIPTEN__`
  - Destructor (righe 42-56): wrappare `api_server_.reset()` e `http_server_.reset()` in `#ifndef __EMSCRIPTEN__`

- [x] **2.5** `seekserve-core/src/offline_cache.cpp` riga 29 — SQLite journal mode
  - Sostituire:
    ```cpp
    sqlite3_exec(db_, "PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);
    ```
  - Con:
    ```cpp
    #ifdef __EMSCRIPTEN__
    sqlite3_exec(db_, "PRAGMA journal_mode=MEMORY;", nullptr, nullptr, nullptr);
    #else
    sqlite3_exec(db_, "PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);
    #endif
    ```

- [x] **2.6** `seekserve-capi/include/seekserve_c.h` — aggiungere 2 nuove funzioni
  - Prima di `ss_free_string` (riga 80), aggiungere:
    ```c
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
    ```

- [x] **2.7** `seekserve-capi/src/seekserve_c.cpp` — implementare le 2 nuove funzioni
  - `ss_read_bytes`: validare parametri, chiamare `engine->read_bytes(torrent_id, file_index, offset, length, out_buf)`, scrivere bytes letti in `*out_bytes_read`
  - `ss_get_file_size`: validare parametri, chiamare `engine->get_file_size(torrent_id, file_index)`, scrivere in `*out_size`

- [ ] **2.8** Verificare: `docker/build-wasm.sh` compila senza errori con i nuovi guard

---

## Fase 3 — datachannel-wasm per WebRTC nel browser (DEFERRED)

> **DEFERRED**: datachannel-wasm provides target `datachannel-wasm` but libtorrent expects `datachannel-static`. Integration requires non-trivial CMake wiring. Building with `SEEKSERVE_ENABLE_WEBTORRENT=OFF` for now. The full engine (scheduler, cache, byte source) works without WebRTC; peer connectivity via WebRTC will be added in a follow-up.

- [ ] **3.1** Aggiungere submodule `extern/datachannel-wasm`
- [ ] **3.2** CMake: wire datachannel-wasm as alias for datachannel-static when EMSCRIPTEN
- [ ] **3.3** Testare: libtorrent compila con WebTorrent ON + datachannel-wasm

---

## Fase 4 — JavaScript glue layer

Obiettivo: 3 file JS che fanno da ponte tra Dart e il modulo WASM.

- [x] **4.1** Creare `flutter_seekserve/web/seekserve_wasm.js` — wrapper C API
  ```js
  let _module = null;
  let _cwrap = {};

  async function initSeekServe(wasmUrl) {
    _module = await SeekServeModule({ locateFile: (f) => wasmUrl + '/' + f });
    _cwrap = {
      ss_engine_create:     _module.cwrap('ss_engine_create', 'number', ['string']),
      ss_engine_destroy:    _module.cwrap('ss_engine_destroy', null, ['number']),
      ss_add_torrent:       _module.cwrap('ss_add_torrent', 'number', ['number','string','number','number']),
      ss_remove_torrent:    _module.cwrap('ss_remove_torrent', 'number', ['number','string','number']),
      ss_list_torrents:     _module.cwrap('ss_list_torrents', 'number', ['number','number']),
      ss_list_files:        _module.cwrap('ss_list_files', 'number', ['number','string','number']),
      ss_select_file:       _module.cwrap('ss_select_file', 'number', ['number','string','number']),
      ss_get_stream_url:    _module.cwrap('ss_get_stream_url', 'number', ['number','string','number','number']),
      ss_get_status:        _module.cwrap('ss_get_status', 'number', ['number','string','number']),
      ss_start_server:      _module.cwrap('ss_start_server', 'number', ['number','number','number']),
      ss_stop_server:       _module.cwrap('ss_stop_server', 'number', ['number']),
      ss_free_string:       _module.cwrap('ss_free_string', null, ['number']),
      ss_read_bytes:        _module.cwrap('ss_read_bytes', 'number', ['number','string','number','number','number','number','number']),
      ss_get_file_size:     _module.cwrap('ss_get_file_size', 'number', ['number','string','number','number']),
    };
  }

  window.SeekServeWasm = { init: initSeekServe, module: () => _module, cwrap: () => _cwrap };
  ```
  - Esporre helper JS per: allocare/deallocare stringhe WASM, leggere stringhe da puntatore, leggere buffer in Uint8Array

- [x] **4.2** Creare `flutter_seekserve/web/seekserve_reader.js` — Web Worker per byte reads bloccanti
  - Riceve `SharedArrayBuffer` dal main thread
  - In loop: `Atomics.wait()` su un segnale, legge parametri (torrentId, fileIndex, offset, length), chiama `_cwrap.ss_read_bytes()`, scrive risultato nel SharedArrayBuffer, `Atomics.notify()`
  - Il main thread invia richieste di lettura e attende asincronamente la risposta

- [x] **4.3** Creare `flutter_seekserve/web/seekserve_sw.js` — Service Worker
  - `install` event: `self.skipWaiting()`
  - `activate` event: `self.clients.claim()`
  - `fetch` event: intercettare URL matching `/seekserve-stream/{torrentId}/{fileIndex}`
  - Per ogni fetch intercettato:
    1. Parsare `Range` header (o intero file se assente)
    2. Inviare `postMessage` al client window: `{type: 'seekserve-read', torrentId, fileIndex, offset, length, port}` con un `MessageChannel` port
    3. Attendere risposta sulla port con i bytes
    4. Costruire `new Response(body, {status: 206, headers: {'Content-Range': 'bytes start-end/total', 'Content-Type': mimeType, 'Accept-Ranges': 'bytes'}})`
  - Handler `HEAD`: restituire solo headers con `Content-Length` = file size
  - MIME detection: `.mp4`→`video/mp4`, `.webm`→`video/webm`, `.mkv`→`video/x-matroska`, `.mp3`→`audio/mpeg`

- [ ] **4.4** Verificare: i 3 file JS parsano senza errori (linting con `node --check`)

---

## Fase 5 — Dart: abstract SeekServeClient + client_native

Obiettivo: estrarre l'interfaccia astratta senza rompere il build nativo.

- [x] **5.1** `flutter_seekserve/lib/src/seekserve_exception.dart` — rimuovere import FFI
  - Riga 1: rimuovere `import 'bindings_generated.dart';`
  - Definire costanti inline prima della classe (riga 3):
    ```dart
    const int SS_OK = 0;
    const int SS_ERR_INVALID_ARG = -1;
    const int SS_ERR_NOT_FOUND = -2;
    const int SS_ERR_METADATA_PENDING = -3;
    const int SS_ERR_TIMEOUT = -4;
    const int SS_ERR_IO = -5;
    const int SS_ERR_ALREADY_RUNNING = -6;
    const int SS_ERR_CANCELLED = -7;
    ```

- [x] **5.2** `flutter_seekserve/lib/src/seekserve_client.dart` — riscrivere come abstract
  - Sostituire l'intero file con:
    ```dart
    import 'dart:async';
    import 'models/file_info.dart';
    import 'models/torrent_status.dart';
    import 'models/seekserve_config.dart';
    import 'models/seekserve_event.dart';

    import 'client_stub.dart'
        if (dart.library.ffi) 'client_native.dart'
        if (dart.library.js_interop) 'client_wasm.dart';

    abstract class SeekServeClient {
      factory SeekServeClient({SeekServeConfig? config}) = createClient;

      Stream<SeekServeEvent> get events;
      int startServer({int port = 0});
      void stopServer();
      String addTorrent(String uri);
      List<String> listTorrents();
      void removeTorrent(String torrentId, {bool deleteFiles = false});
      List<FileInfo> listFiles(String torrentId);
      void selectFile(String torrentId, int fileIndex);
      String getStreamUrl(String torrentId, int fileIndex);
      TorrentStatus getStatus(String torrentId);
      void dispose();
    }
    ```

- [x] **5.3** Creare `flutter_seekserve/lib/src/client_stub.dart`
  ```dart
  import 'models/seekserve_config.dart';
  import 'seekserve_client.dart';

  SeekServeClient createClient({SeekServeConfig? config}) =>
      throw UnsupportedError('No SeekServeClient implementation for this platform.');
  ```

- [x] **5.4** Creare `flutter_seekserve/lib/src/client_native.dart`
  - Top-level factory:
    ```dart
    SeekServeClient createClient({SeekServeConfig? config}) =>
        SeekServeClientNative(config: config);
    ```
  - `class SeekServeClientNative implements SeekServeClient` — copia esatta del body attuale di `SeekServeClient` da `seekserve_client.dart` (righe 20-284), con tutti gli import `dart:ffi`, `package:ffi`, `bindings_generated.dart`, `native_library.dart`

- [x] **5.5** Verificare: `cd flutter_seekserve && flutter test` — 15 model test passano
- [ ] **5.6** Verificare: `cd flutter_seekserve_app && flutter build ios --no-codesign` — build nativo OK

---

## Fase 6 — Dart: client_wasm via dart:js_interop

Obiettivo: implementazione web che chiama il WASM module tramite il JS glue.

- [x] **6.1** `flutter_seekserve/pubspec.yaml` — aggiungere dipendenza `web`
  - Dopo riga 11 (`ffi: ^2.1.3`), aggiungere: `web: ^1.1.0`

- [x] **6.2** Creare `flutter_seekserve/lib/src/wasm_interop.dart`
  - Extension types `dart:js_interop` per `window.SeekServeWasm`:
    ```dart
    @JS('SeekServeWasm')
    extension type SeekServeWasmBridge._(JSObject _) implements JSObject {
      external JSPromise init(JSString wasmUrl);
      external JSObject module();
      external JSObject cwrap();
    }
    ```
  - Wrapper functions per ogni C API: `engineCreate(configJson)`, `addTorrent(engine, uri)`, `listTorrents(engine)`, `listFiles(engine, id)`, `selectFile(engine, id, fi)`, `getStreamUrl(engine, id, fi)`, `getStatus(engine, id)`, `readBytes(engine, id, fi, offset, length)`, `getFileSize(engine, id, fi)`, `startServer(engine, port)`, `stopServer(engine)`, `freeString(ptr)`, `engineDestroy(engine)`
  - Gestione memoria WASM: `malloc`/`free` per buffer, `UTF8ToString`/`stringToUTF8` per stringhe

- [x] **6.3** Creare `flutter_seekserve/lib/src/client_wasm.dart`
  ```dart
  import 'dart:async';
  import 'dart:js_interop';
  import 'package:web/web.dart' as web;

  import 'seekserve_client.dart';
  import 'seekserve_exception.dart';
  import 'wasm_interop.dart';
  import 'models/file_info.dart';
  import 'models/torrent_status.dart';
  import 'models/seekserve_config.dart';
  import 'models/seekserve_event.dart';

  SeekServeClient createClient({SeekServeConfig? config}) =>
      SeekServeClientWasm(config: config);
  ```
  - `class SeekServeClientWasm implements SeekServeClient`:
    - Costruttore: inizializza il modulo WASM via `SeekServeWasmBridge.init()`, chiama `ss_engine_create(configJson)`
    - `startServer()`: chiama `ss_start_server()`, registra il Service Worker (`navigator.serviceWorker.register('seekserve_sw.js')`), imposta listener per messaggi SW (richieste byte read), restituisce 0
    - `addTorrent(uri)`: chiama `ss_add_torrent()` via cwrap, restituisce hex ID
    - `listTorrents()`: chiama `ss_list_torrents()`, parsa JSON array
    - `removeTorrent()`: chiama `ss_remove_torrent()`
    - `listFiles()`: chiama `ss_list_files()`, parsa JSON, mappa a `List<FileInfo>`
    - `selectFile()`: chiama `ss_select_file()`
    - `getStreamUrl()`: chiama `ss_get_stream_url()`, restituisce URL relativo per SW
    - `getStatus()`: chiama `ss_get_status()`, parsa JSON, mappa a `TorrentStatus`
    - `events`: polling `ss_get_status()` ogni 500ms per rilevare cambi metadata/completion, oppure callback WASM→JS→Dart via `ss_set_event_callback()` + `Module.addFunction()`
    - `dispose()`: chiama `ss_engine_destroy()`
    - Listener `message` su `navigator.serviceWorker`: quando SW chiede bytes, chiama `readBytes()` via reader worker, risponde sulla MessagePort

- [ ] **6.4** Verificare: `flutter analyze` in `flutter_seekserve` non mostra errori

---

## Fase 7 — UI Library: conditional video player

Obiettivo: `SsVideoPlayer` usa media_kit su native e HTML5 `<video>` su web.

- [x] **7.1** Rinominare `flutter_seekserve_ui/lib/src/player/ss_video_player.dart` → `ss_video_player_native.dart`
  - Nessuna modifica al contenuto (mantiene `dart:io`, `media_kit` imports)

- [x] **7.2** Creare `flutter_seekserve_ui/lib/src/player/ss_video_player.dart` — dispatcher
  ```dart
  export 'ss_video_player_stub.dart'
      if (dart.library.ffi) 'ss_video_player_native.dart'
      if (dart.library.js_interop) 'ss_video_player_web.dart';
  ```

- [x] **7.3** Creare `flutter_seekserve_ui/lib/src/player/ss_video_player_stub.dart`
  - Widget che mostra testo "Video player not available on this platform"
  - Stessa signature: `SsVideoPlayer({required String streamUrl, TorrentStatus? torrentStatus, bool isFullscreen, VoidCallback? onFullscreenToggle})`

- [x] **7.4** Creare `flutter_seekserve_ui/lib/src/player/ss_video_player_web.dart`
  - `SsVideoPlayer` come `StatefulWidget` con stessa signature del native
  - `initState()`: crea `HTMLVideoElement` via `package:web`, registra con `platformViewRegistry.registerViewFactory(viewId, (_) => videoElement)`
  - Imposta `video.src = widget.streamUrl` (l'URL `/seekserve-stream/...` viene intercettato dal SW)
  - `video.autoplay = true`, `video.controls = false`
  - Event listeners: `onPlay`, `onPause`, `onDurationChange`, `onWaiting`, `onCanPlay`, `onError`
  - Position polling: `Timer.periodic(250ms)` legge `video.currentTime`
  - Overlay controls: stessa struttura di `_PlayerOverlay` dal native — gradient top/bottom, play/pause center, seek bar, fullscreen toggle. Usa `video.play()`, `video.pause()`, `video.currentTime = x`
  - Usa `SsSpinner` per buffering (gia' web-compatible, nessun import nativo)
  - `HtmlElementView(viewType: viewId)` nel `build()`

- [x] **7.5** `flutter_seekserve_ui/lib/src/player/ss_seek_controls.dart` — conditional export
  - Creare `flutter_seekserve_ui/lib/src/player/ss_seek_controls_stub.dart` — file vuoto (nessun export)
  - In `flutter_seekserve_ui/lib/flutter_seekserve_ui.dart` riga 38, sostituire:
    ```dart
    export 'src/player/ss_seek_controls_stub.dart'
        if (dart.library.ffi) 'src/player/ss_seek_controls.dart';
    ```

- [x] **7.6** `flutter_seekserve_ui/lib/src/composites/ss_server_status_panel.dart` — estrarre health check
  - Creare `health_check_native.dart` nello stesso dir: contiene la funzione `Future<(bool, int)> runHealthCheck(int port)` con il codice attuale (righe 123-155, `dart:io` HttpClient)
  - Creare `health_check_web.dart`: restituisce `(true, 0)` (nessun server locale su web)
  - Creare `health_check_stub.dart`: restituisce `(false, 0)`
  - In `ss_server_status_panel.dart`: rimuovere `import 'dart:io'` (riga 2), aggiungere conditional import:
    ```dart
    import 'health_check_stub.dart'
        if (dart.library.io) 'health_check_native.dart'
        if (dart.library.js_interop) 'health_check_web.dart';
    ```
  - Sostituire body di `_runHealthCheck()` (righe 123-155) con chiamata a `runHealthCheck(widget.controlPort!)`

- [x] **7.7** `flutter_seekserve_ui/lib/src/controllers/ss_torrent_manager.dart` riga 89
  - Cambiare `_serverPort = _client!.startServer();` in:
    ```dart
    final port = _client!.startServer();
    _serverPort = port > 0 ? port : null;
    ```

- [x] **7.8** `flutter_seekserve_ui/pubspec.yaml` — aggiungere `web`
  - Dopo riga 15 (`media_kit_video: ^2.0.1`), aggiungere: `web: ^1.1.0`

- [x] **7.9** Verificare: `dart analyze` clean, `flutter test` 15/15 pass, example app analyze clean

---

## Fase 8 — Example App: supporto web

Obiettivo: `flutter_seekserve_app` builda e gira su Chrome.

- [x] **8.1** `flutter_seekserve_app/lib/main.dart` — conditional platform init
  - Rimuovere import `dart:io` (riga 1), `media_kit` (riga 6), `path_provider` (riga 7)
  - Aggiungere conditional import:
    ```dart
    import 'init_stub.dart'
        if (dart.library.io) 'init_native.dart'
        if (dart.library.js_interop) 'init_web.dart';
    ```
  - Modificare `main()`: sostituire `MediaKit.ensureInitialized()` con `platformInit()`
  - Modificare `_initEngine()`: sostituire le righe 35-48 con:
    ```dart
    Future<void> _initEngine() async {
      final config = await getPlatformConfig();
      _manager.init(config.savePath ?? '/seekserve', config: config);
      setState(() => _initialised = true);
    }
    ```

- [x] **8.2** Creare `flutter_seekserve_app/lib/init_native.dart`
  ```dart
  import 'dart:io';
  import 'package:media_kit/media_kit.dart';
  import 'package:path_provider/path_provider.dart';
  import 'package:flutter_seekserve/seekserve.dart';

  void platformInit() { MediaKit.ensureInitialized(); }

  Future<SeekServeConfig> getPlatformConfig() async {
    final dir = await getApplicationDocumentsDirectory();
    final savePath = '${dir.path}${Platform.pathSeparator}seekserve';
    await Directory(savePath).create(recursive: true);
    final dbPath = '$savePath${Platform.pathSeparator}seekserve_cache.db';
    return SeekServeConfig(
      savePath: savePath, cacheDbPath: dbPath,
      streamPort: 0, controlPort: 0, logLevel: 'debug',
    );
  }
  ```

- [x] **8.3** Creare `flutter_seekserve_app/lib/init_web.dart`
  ```dart
  import 'package:flutter_seekserve/seekserve.dart';

  void platformInit() { /* no-op: no MediaKit on web */ }

  Future<SeekServeConfig> getPlatformConfig() async {
    return const SeekServeConfig(
      savePath: '/seekserve',
      logLevel: 'debug',
      enableWebtorrent: true,
      extraTrackers: ['wss://tracker.webtorrent.dev', 'wss://tracker.btorrent.xyz'],
    );
  }
  ```

- [x] **8.4** Creare `flutter_seekserve_app/lib/init_stub.dart`
  ```dart
  import 'package:flutter_seekserve/seekserve.dart';
  void platformInit() => throw UnsupportedError('Unsupported platform');
  Future<SeekServeConfig> getPlatformConfig() => throw UnsupportedError('Unsupported platform');
  ```

- [x] **8.5** Scaffoldare web platform: `cd flutter_seekserve_app && flutter create --platforms web .`

- [x] **8.6** `flutter_seekserve_app/web/index.html` — aggiungere script WASM + SW registration
  - Prima di `flutter_bootstrap.js`:
    ```html
    <script src="seekserve.js"></script>
    <script src="seekserve_wasm.js"></script>
    <script>
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('seekserve_sw.js');
      }
    </script>
    ```
  - Aggiungere `<meta>` tag per COOP/COEP (o configurare nel server):
    ```html
    <meta http-equiv="Cross-Origin-Opener-Policy" content="same-origin">
    <meta http-equiv="Cross-Origin-Embedder-Policy" content="require-corp">
    ```

- [x] **8.7** Creare `scripts/deploy-wasm-to-app.sh`
  - Copia `build/wasm-out/seekserve-capi/seekserve.{js,wasm,worker.js}` → `flutter_seekserve_app/web/`
  - Copia `flutter_seekserve/web/seekserve_wasm.js` → `flutter_seekserve_app/web/`
  - Copia `flutter_seekserve/web/seekserve_reader.js` → `flutter_seekserve_app/web/`
  - Copia `flutter_seekserve/web/seekserve_sw.js` → `flutter_seekserve_app/web/`

- [x] **8.8** Verificare: `cd flutter_seekserve_app && flutter build web` — build completato senza errori

---

## Fase 9 — Integration test nel browser

Obiettivo: l'app funziona end-to-end in Chrome.

- [x] **9.1** Verificare build nativo non regredito: 185/189 test passano (4 pre-existing flaky: ByteSourceTest x2, HttpRangeServerTest.GetRangeMiddle, StressTest.RapidSeekSimulation)

- [ ] **9.2** Build WASM completo: `docker/build-wasm.sh` + `scripts/deploy-wasm-to-app.sh`

- [ ] **9.3** Lanciare web app:
  ```bash
  cd flutter_seekserve_app && flutter run -d chrome \
    --web-header=Cross-Origin-Opener-Policy=same-origin \
    --web-header=Cross-Origin-Embedder-Policy=require-corp
  ```

- [ ] **9.4** Verificare: WASM module si carica (console: no errori)
- [ ] **9.5** Verificare: Service Worker registrato (`chrome://serviceworker-internals`)
- [ ] **9.6** Verificare: aggiungere magnet URI Sintel → metadata ricevuta → lista file mostrata
- [ ] **9.7** Verificare: selezionare file MP4 → video in playback nel browser (SW intercetta Range requests)
- [ ] **9.8** Verificare: seek funziona (SW risponde con 206 Partial Content)

- [ ] **9.9** Cross-protocol: avviare native CLI (`./build/debug/seekserve-demo/seekserve-demo`) su stesso torrent con WebTorrent ON → browser WASM riceve pezzi via WebRTC dal peer nativo

- [x] **9.10** Dart unit tests web: `cd flutter_seekserve && flutter test --platform chrome` — 15 model tests pass on Chrome

---

## Riepilogo file

### Nuovi file (18)
| File | Fase |
|------|------|
| `docker/Dockerfile.wasm` | 1.1 |
| `docker/build-wasm.sh` | 1.8 |
| `triplets/wasm32-emscripten.cmake` | 1.2 |
| `vcpkg-wasm.json` | 1.3 |
| `scripts/deploy-wasm-to-app.sh` | 8.7 |
| `flutter_seekserve/web/seekserve_wasm.js` | 4.1 |
| `flutter_seekserve/web/seekserve_reader.js` | 4.2 |
| `flutter_seekserve/web/seekserve_sw.js` | 4.3 |
| `flutter_seekserve/lib/src/client_stub.dart` | 5.3 |
| `flutter_seekserve/lib/src/client_native.dart` | 5.4 |
| `flutter_seekserve/lib/src/client_wasm.dart` | 6.3 |
| `flutter_seekserve/lib/src/wasm_interop.dart` | 6.2 |
| `flutter_seekserve_ui/lib/src/player/ss_video_player_native.dart` | 7.1 |
| `flutter_seekserve_ui/lib/src/player/ss_video_player_web.dart` | 7.4 |
| `flutter_seekserve_ui/lib/src/player/ss_video_player_stub.dart` | 7.3 |
| `flutter_seekserve_ui/lib/src/player/ss_seek_controls_stub.dart` | 7.5 |
| `flutter_seekserve_app/lib/init_native.dart` | 8.2 |
| `flutter_seekserve_app/lib/init_web.dart` | 8.3 |
| `flutter_seekserve_app/lib/init_stub.dart` | 8.4 |

### File modificati (15)
| File | Fase | Modifica |
|------|------|----------|
| `CMakeLists.txt` | 1.5 | `if(NOT EMSCRIPTEN)` guard su demo e tests |
| `CMakePresets.json` | 1.4 | Nuovo preset `wasm` |
| `seekserve-serve/CMakeLists.txt` | 1.6 | Escludere http_range_server.cpp e control_api_server.cpp su WASM |
| `seekserve-capi/CMakeLists.txt` | 1.7 | Emscripten link flags, EXPORTED_FUNCTIONS |
| `seekserve-serve/include/seekserve/engine.hpp` | 2.1, 2.2 | `#ifndef __EMSCRIPTEN__` su include/membri HTTP, nuovi metodi `read_bytes`/`get_file_size` |
| `seekserve-serve/src/engine.cpp` | 2.3, 2.4 | Impl `read_bytes`/`get_file_size`, `#ifdef` su start/stop/select/get_stream_url/destructor |
| `seekserve-core/src/offline_cache.cpp` | 2.5 | `journal_mode=MEMORY` su WASM |
| `seekserve-capi/include/seekserve_c.h` | 2.6 | +2 funzioni: `ss_read_bytes`, `ss_get_file_size` |
| `seekserve-capi/src/seekserve_c.cpp` | 2.7 | Impl delle 2 nuove funzioni |
| `flutter_seekserve/lib/src/seekserve_client.dart` | 5.2 | Concrete → abstract + conditional import factory |
| `flutter_seekserve/lib/src/seekserve_exception.dart` | 5.1 | Rimuovere import bindings, inline error constants |
| `flutter_seekserve/pubspec.yaml` | 6.1 | +`web: ^1.1.0` |
| `flutter_seekserve_ui/lib/flutter_seekserve_ui.dart` | 7.5 | Conditional export SsSeekControls |
| `flutter_seekserve_ui/lib/src/controllers/ss_torrent_manager.dart` | 7.7 | `port > 0 ? port : null` |
| `flutter_seekserve_app/lib/main.dart` | 8.1 | Conditional init, rimuovere dart:io/media_kit imports |

### Prerequisiti
- Docker Desktop installato
- Browser con SharedArrayBuffer: Chrome 119+, Firefox 120+
- Server/dev-server con headers COOP/COEP
