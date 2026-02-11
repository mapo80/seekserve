# SeekServe

**Edge-first torrent streaming SDK with HTTP Range support, intelligent piece scheduling, offline caching, WebTorrent, and a full Flutter toolkit.**

SeekServe is a C++17 library that downloads torrent content and serves it locally via an HTTP Range-compliant server on loopback. Video players like VLC can connect to it and play, seek, and scrub through torrent video as if it were a regular HTTP stream. An intelligent piece scheduler ensures the right pieces are downloaded first for instant playback and fast seek.

The SDK ships with three Flutter packages:
- **`flutter_seekserve`** — FFI plugin: Dart bindings to the C++ engine
- **`flutter_seekserve_ui`** — UI widget library: theme system, atoms, composites, player, torrent manager (no Material dependency)
- **`flutter_seekserve_app`** — Example app: demonstrates how to integrate the SDK into a complete application

### Screenshots

<table>
  <tr>
    <td align="center"><b>Torrent List</b></td>
    <td align="center"><b>Torrent Detail</b></td>
    <td align="center"><b>Video Player</b></td>
  </tr>
  <tr>
    <td><img src="docs/images/list.jpeg" width="250" alt="Home screen with torrent list, status badges, and add button"/></td>
    <td><img src="docs/images/item.jpeg" width="250" alt="Torrent detail with metadata, progress, and file tree with play button"/></td>
    <td><img src="docs/images/video.jpeg" width="250" alt="Video player with seek controls, buffering overlay, and live torrent status bar"/></td>
  </tr>
  <tr>
    <td>Home screen: active torrents with progress, download/upload rates, peer count, and state badge (SEED). The purple FAB adds new torrents via magnet URI or .torrent path.</td>
    <td>Torrent detail: full metadata panel (infohash, total size, file count), progress bar, transfer stats. File tree with tap-to-play button for instant streaming.</td>
    <td>Built-in video player (media_kit/mpv) streaming directly from torrent peers. Seek bar, skip ±10s, play/pause controls. Live status bar shows DL/UL rates, peer count, and STREAM mode.</td>
  </tr>
</table>

---

## Table of Contents

- [Features](#features)
- [Architecture Overview](#architecture-overview)
- [Flutter Package Architecture](#flutter-package-architecture)
- [High-Level Data Flow](#high-level-data-flow)
- [End-to-End User Flow](#end-to-end-user-flow)
- [Module Dependency Graph](#module-dependency-graph)
- [Thread Model](#thread-model)
- [Streaming Pipeline](#streaming-pipeline)
- [Piece Scheduling Strategy](#piece-scheduling-strategy)
- [Project Structure](#project-structure)
- [Build & Run](#build--run)
- [Build Commands Reference](#build-commands-reference)
- [Flutter Plugin](#flutter-plugin)
- [Flutter UI Package](#flutter-ui-package)
- [Flutter App (Example)](#flutter-app-example)
- [Usage](#usage)
- [Testing the System](#testing-the-system)
- [C API (FFI)](#c-api-ffi)
- [REST Control API](#rest-control-api)
- [Configuration](#configuration)
- [Testing](#testing)
- [Cross-Compilation](#cross-compilation)
- [WebTorrent](#webtorrent)
- [Web (WASM)](#web-wasm)
- [Documentation Index](#documentation-index)
- [Dependencies](#dependencies)
- [License](#license)

---

## Features

### C++ SDK
- **HTTP Range streaming** (RFC 7233) — 200 OK, 206 Partial Content, 416 Range Not Satisfiable
- **Intelligent piece scheduler** — hot window, lookahead, seek boost, adaptive mode switching
- **Multi-file torrent support** — enumerate files, select one for streaming, correct per-file byte mapping
- **Offline cache** — SQLite-backed, LRU eviction, quota enforcement, offline-ready detection
- **Pieces map API** — per-piece bitfield + per-file piece ranges with completion counts, hex-encoded for compact transfer
- **C API** — opaque handle, JSON data exchange, callback events — ready for Flutter FFI / Dart `ffigen`
- **REST control API** — add/remove torrents, list files, select streams, monitor status via JSON
- **Hardened servers** — connection limits, socket timeouts, body size limits, token auth, CORS
- **Loopback-only binding** — secure by default, no network exposure
- **Sanitizer support** — ASan and TSan build presets out of the box
- **189 tests** — 138 unit + 32 integration + 19 C API

### Flutter Plugin
- **FFI bindings** — auto-generated via `ffigen` from `seekserve_c.h`
- **Native builds** — pre-built XCFramework (iOS) and `.so` (Android arm64-v8a, armeabi-v7a, x86_64)
- **Dart API** — `SeekServeClient` with async methods, `Stream<SeekServeEvent>` for real-time events
- **Event system** — `NativeCallable.listener` bridges C callbacks to Dart isolate
- **Example app** — torrent input, file selection, `media_kit` video player, live status display
- **15 Dart unit tests** for model classes

### Flutter UI Package
- **No Material/Cupertino dependency** — only `flutter/widgets.dart`, `painting.dart`, `gestures.dart`
- **Theme system** — `SsThemeData` + `SsTheme` (InheritedWidget), dark/light presets, torrent-semantic colours, `copyWith()` customization
- **9 atom widgets** — `SsButton`, `SsIconButton`, `SsTextField`, `SsProgressBar`, `SsBadge`, `SsChip`, `SsSlider`, `SsCard`, `SsDialog`
- **12 composite widgets** — `SsTorrentTile`, `SsFileTile`, `SsFileTree`, `SsPiecesMap`, `SsTransferStats`, `SsStreamModeBadge`, `SsAddTorrentBar`, `SsAddTorrentDialog`, `SsTorrentList`, `SsTorrentDetail`, `SsDeleteConfirm`, `SsServerStatusPanel`
- **4 player widgets** — `SsSeekControls`, `SsBufferingOverlay`, `SsPlayerStatusBar`, `SsVideoPlayer`
- **1 controller** — `SsTorrentManager` (ChangeNotifier wrapping `SeekServeClient`)
- **32 Dart unit tests** for theme, atoms, utils

### Flutter App (Example)
- **Example application** — demonstrates SDK integration with `WidgetsApp` (no MaterialApp), 3 screens, full torrent management
- **Home screen** — add torrent bar, torrent list with swipe-to-delete, status badges, error banner
- **Torrent detail screen** — full metadata panel, pieces map (per-file grid), file tree with folder navigation, tap-to-stream
- **Player screen** — `SsVideoPlayer` with seek controls, buffering overlay, torrent status bar
- **ManagerScope** — InheritedWidget providing `SsTorrentManager` to the entire widget tree

### WebTorrent
- **WebRTC peer connections** via libdatachannel (libtorrent master branch)
- **STUN server** configured automatically (`stun.l.google.com:19302`)
- **WebTorrent trackers** supported via `extra_trackers` config (e.g. `wss://tracker.webtorrent.dev`)
- **Compile-time toggle** — `SEEKSERVE_ENABLE_WEBTORRENT=ON/OFF`, graceful fallback to standard BitTorrent

---

## Architecture Overview

```
+------------------------------------------------------------------+
|                        SeekServeEngine                            |
|                       (facade / entry point)                      |
+------------------------------------------------------------------+
|                                                                    |
|  +---------------------------+    +----------------------------+  |
|  |  TorrentSessionManager    |    |     MetadataCatalog        |  |
|  |  - lt::session lifecycle  |    |  - torrent -> file list    |  |
|  |  - add/remove torrents    |    |  - file selection          |  |
|  |  - handle registry        |    |  - priority management     |  |
|  |                           |    +----------------------------+  |
|  |  +---------------------+  |                                    |
|  |  |  AlertDispatcher    |  |    +----------------------------+  |
|  |  |  - dedicated thread |  |    |  PieceAvailabilityIndex    |  |
|  |  |  - pop_alerts loop  |  |    |  - vector<atomic<bool>>    |  |
|  |  |  - typed handlers   |  |    |  - lock-free, monotonic    |  |
|  |  +---------------------+  |    |  - contiguous byte calc    |  |
|  +---------------------------+    +----------------------------+  |
|                                                                    |
|  +---------------------------+    +----------------------------+  |
|  |   ByteRangeMapper        |    |  StreamingScheduler        |  |
|  |  - bytes -> piece spans  |    |  - set_piece_deadline()    |  |
|  |  - file_storage::map()   |    |  - hot/lookahead/seek      |  |
|  |  - per-file offset aware |    |  - 3 adaptive modes        |  |
|  +---------------------------+    +----------------------------+  |
|                                                                    |
|  +---------------------------+    +----------------------------+  |
|  |     ByteSource            |    |  OfflineCacheManager       |  |
|  |  - read(offset, len)     |    |  - SQLite WAL index        |  |
|  |  - cv wait for pieces    |    |  - LRU eviction            |  |
|  |  - direct disk read      |    |  - quota enforcement       |  |
|  |  - cancel() for seek     |    |  - offline-ready tracking  |  |
|  +---------------------------+    +----------------------------+  |
|                                                                    |
|  +---------------------------+    +----------------------------+  |
|  |   HttpRangeServer         |    |  ControlApiServer          |  |
|  |  - GET /stream/{id}/{fi} |    |  - REST JSON endpoints     |  |
|  |  - 206 Partial Content   |    |  - POST/GET/DELETE routes  |  |
|  |  - 64KB streaming chunks |    |  - CORS preflight          |  |
|  |  - token auth            |    |  - Bearer + query auth     |  |
|  |  - connection limits     |    |  - body size limits        |  |
|  +---------------------------+    +----------------------------+  |
|                                                                    |
+------------------------------------------------------------------+
          |                                          |
          v                                          v
   +-------------+                           +--------------+
   | VLC / Player |                          | curl / UI    |
   | HTTP Range   |                          | REST JSON    |
   +-------------+                           +--------------+
          ^
          |
   +------+-----------+
   | Flutter Packages  |
   |                   |
   | flutter_seekserve |    flutter_seekserve_ui    flutter_seekserve_app
   | (dart:ffi)        |<----(widgets, theme)  <----(screens, routing)
   | SeekServeClient   |    SsTorrentManager        HomeScreen
   | native bindings   |    SsVideoPlayer           TorrentDetailScreen
   +-------------------+    SsSeekControls          AppPlayerScreen
                            SsTorrentList
                            SsFileTree
                            SsTheme (dark/light)
```

---

## Flutter Package Architecture

Three Flutter packages form a layered architecture. Each layer depends only on the layer below, never sideways or upward.

### Package Dependency Graph

```
+-----------------------------------------------------------------------+
|                     flutter_seekserve_app                              |
|                     (example app)                                      |
|                                                                       |
|   main.dart          router.dart         screens/                     |
|   SeekServeApp       AppRouter           HomeScreen                   |
|   ManagerScope       /  |  \             TorrentDetailScreen          |
|   (InheritedWidget)  /detail /player     AppPlayerScreen              |
+----------+--------------------+-----------------------------------+---+
           |                    |
           | depends on         | depends on
           v                    v
+----------+--------------------+-----------------------------------+---+
|                     flutter_seekserve_ui                              |
|                     (UI widget library)                               |
|                                                                       |
|   THEME                     ATOMS                                     |
|   +-------------------+    +---------+---------+---------+            |
|   | SsThemeData       |    | SsButton| SsSlider|SsDialog |            |
|   |  .dark() .light() |    | SsIcon  |SsProgBar|SsCard   |            |
|   |  .copyWith()      |    | SsField |SsBadge  |SsChip   |            |
|   | SsTheme (Inherit) |    +---------+---------+---------+            |
|   +-------------------+                                               |
|                                                                       |
|   COMPOSITES                            PLAYER                        |
|   +-------------------+  +----------+  +---------------------------+  |
|   | SsTorrentTile     |  |SsTransfer|  | SsVideoPlayer             |  |
|   | SsTorrentList     |  |  Stats   |  |  +-- SsSeekControls       |  |
|   | SsTorrentDetail   |  +----------+  |  +-- SsBufferingOverlay   |  |
|   | SsAddTorrentBar   |  |SsStream  |  |  +-- SsPlayerStatusBar   |  |
|   | SsAddTorrentDialog|  |ModeBadge |  +---------------------------+  |
|   | SsFileTile        |  +----------+                                 |
|   | SsFileTree        |  |SsServer  |                                 |
|   | SsDeleteConfirm   |  |StatusPnl |                                 |
|   +-------------------+  +----------+                                 |
|                                                                       |
|   CONTROLLER                           UTILS                          |
|   +-------------------+               +---------------------------+   |
|   | SsTorrentManager  |               | formatBytes/Rate/Duration |   |
|   |  (ChangeNotifier) |               | fileCategoryFromExtension |   |
|   |  entries, statuses|               +---------------------------+   |
|   |  addTorrent()     |                                               |
|   |  removeTorrent()  |                                               |
|   |  selectAndStream()|                                               |
|   |  poll + events    |                                               |
|   +--------+----------+                                               |
+------------|----------------------------------------------------------+
             |
             | depends on
             v
+-----------------------------------------------------------------------+
|                     flutter_seekserve                                  |
|                     (FFI plugin)                                       |
|                                                                       |
|   +-------------------+    +------------------------------------------+
|   | SeekServeClient   |    | Models                                   |
|   |  addTorrent()     |    |  TorrentStatus  (progress, rates, peers) |
|   |  removeTorrent()  |    |  FileInfo        (path, size, isVideo)   |
|   |  listFiles()      |    |  SeekServeConfig (savePath, auth, etc.)  |
|   |  selectFile()     |    |  SeekServeEvent  (sealed class)          |
|   |  getStreamUrl()   |    |    MetadataReceived                      |
|   |  getStatus()      |    |    FileCompleted                         |
|   |  startServer()    |    |    TorrentError                          |
|   |  events (Stream)  |    |    UnknownEvent                          |
|   +--------+----------+    +------------------------------------------+
             |
             | dart:ffi (NativeCallable.listener)
             v
+-----------------------------------------------------------------------+
|                     seekserve-capi (C API)                             |
|                     libseekserve.dylib / .so / .a                     |
+-----------------------------------------------------------------------+
             |
             | links
             v
+-----------------------------------------------------------------------+
|              C++ SDK  (seekserve-serve + seekserve-core)              |
|              libtorrent + Boost.Beast + SQLite + WebTorrent           |
+-----------------------------------------------------------------------+
```

### Data Flow Through the Flutter Layers

```
  User pastes magnet URI
       |
       v
  [flutter_seekserve_app]
  HomeScreen
    +-- SsAddTorrentBar (ui)  ---- onAdd(uri) ---->  ManagerScope.manager
       |                                                    |
       |                                                    v
       |                                           [flutter_seekserve_ui]
       |                                           SsTorrentManager
       |                                             .addTorrent(uri)
       |                                                    |
       |                                                    v
       |                                           [flutter_seekserve]
       |                                           SeekServeClient
       |                                             .addTorrent(uri)
       |                                                    |
       |                                                    | dart:ffi
       |                                                    v
       |                                           [seekserve-capi]
       |                                           ss_add_torrent()
       |                                                    |
       |                                                    v
       |                                           [C++ Engine]
       |                                           libtorrent -> peers -> download
       |
       |   <---- notifyListeners() ----+
       |                               |
       v                               |
  SsTorrentList (ui)                   |
    +-- SsTorrentTile (ui)             |  1-second poll timer
         progress, rates, peers        |  SsTorrentManager._pollStatus()
                                       |       |
  User taps torrent                    |       v
       |                               |  SeekServeClient.getStatus()
       v                               |       |
  TorrentDetailScreen                  |       | dart:ffi
    +-- SsTorrentDetail (ui)           |       v
    +-- SsPiecesMap (ui)               |  ss_get_status() -> JSON
    +-- SsFileTree (ui)                |  ss_get_pieces() -> JSON
         |                             |
         | User taps video file        |
         v                             |
  SsTorrentManager                     |
    .selectAndStream(id, fileIdx)      |
       |                               |
       v                               |
  SeekServeClient                      |
    .selectFile() + .getStreamUrl()    |
       |                               |
       | returns http://127.0.0.1:PORT/stream/...
       v
  AppPlayerScreen
    +-- SsVideoPlayer (ui)
         |
         +-- HTTP HEAD probe
         +-- media_kit Player.open(url)
         +-- SsSeekControls
         |    +-- SsSlider (atom)
         |    +-- SsIconButton (atom) x3
         +-- SsBufferingOverlay
         +-- SsPlayerStatusBar
              +-- SsProgressBar (atom)
              +-- SsTransferStats (composite)
              +-- SsStreamModeBadge (composite)
```

### Widget Hierarchy (Atomic Design)

```
ATOMS (basic building blocks, no business logic)
  SsButton ─────────── GestureDetector + Container + Text
  SsIconButton ──────── GestureDetector + Opacity + Icon
  SsTextField ───────── Container + EditableText
  SsProgressBar ─────── ClipRRect + CustomPaint (_ProgressPainter)
  SsBadge ───────────── Container + Text (pill shape)
  SsChip ────────────── Row + Icon + Text
  SsSlider ──────────── GestureDetector + CustomPaint (_SliderPainter)
  SsCard ────────────── GestureDetector + Container (rounded, themed)
  SsDialog ──────────── PageRouteBuilder + Center + Container

COMPOSITES (combine atoms + business data)
  SsTorrentTile ──────── SsBadge + SsProgressBar + Text (rates, peers)
  SsTorrentList ──────── ListView + Dismissible + SsTorrentTile
  SsTorrentDetail ────── SsBadge + SsProgressBar + SsTransferStats + _DetailRow
  SsFileTile ─────────── Row + Icon + Text (file name, size, type icon)
  SsFileTree ─────────── ListView + _FolderRow + SsFileTile (recursive tree)
  SsTransferStats ────── Wrap + SsChip (DL rate, UL rate, peers)
  SsStreamModeBadge ──── SsBadge (STREAM / ASSIST / DOWNLOAD)
  SsAddTorrentBar ────── SsIconButton (paste, add) + EditableText
  SsAddTorrentDialog ─── PageRouteBuilder overlay, URI input + paste + submit
  SsDeleteConfirm ────── SsDialog (Cancel / Keep files / Delete all)
  SsServerStatusPanel ── Server health, ports, auth, rates, endpoint list

PLAYER (media_kit + streaming widgets)
  SsVideoPlayer ─────── Column + Stack
    SsSeekControls ──── Row + SsSlider + SsIconButton (skip±10s, play/pause)
    SsBufferingOverlay ─ Positioned.fill + _SpinningIndicator
    SsPlayerStatusBar ── SsProgressBar + SsTransferStats + SsStreamModeBadge

CONTROLLER (business logic, ChangeNotifier)
  SsTorrentManager ──── wraps SeekServeClient
    entries ──────────── Map<String, SsTorrentEntry>
    addTorrent() ─────── client.addTorrent() + track entry
    removeTorrent() ──── client.removeTorrent() + remove entry
    selectAndStream() ── client.selectFile() + getStreamUrl()
    _pollStatus() ────── Timer.periodic(1s) -> getStatus() for each entry
    _onEvent() ───────── Stream<SeekServeEvent> -> metadata/file/error
```

### Theme System

```
SsThemeData
  |
  +-- Base colours:     primary, onPrimary, surface, onSurface,
  |                     background, onBackground, error, onError
  |
  +-- Torrent colours:  downloading (blue), seeding (green), paused (grey),
  |                     checking (yellow), buffering (orange), completed (dk green)
  |
  +-- Text styles:      headingStyle (18, w600), bodyStyle (14),
  |                     captionStyle (11, grey), monoStyle (12, monospace)
  |
  +-- Dimensions:       borderRadius (8), cardPadding (12), iconSize (24)
  |
  +-- Presets:
  |     SsThemeData.dark()   -- bg:#121212, surface:#1E1E1E, primary:#7C4DFF
  |     SsThemeData.light()  -- bg:#F5F5F5, surface:#FFFFFF, primary:#6200EA
  |
  +-- Customization:
        theme.copyWith(primary: Color(0xFFFF5722), borderRadius: 16.0)

SsTheme (InheritedWidget)
  |
  +-- SsTheme(data: SsThemeData.dark(), child: ...)
  +-- SsTheme.of(context) -> SsThemeData  (fallback: dark)
```

---

## High-Level Data Flow

```
  .torrent file                        Video Player (VLC / media_kit)
  or magnet URI                              |
       |                                     | GET /stream/{id}/{fi}
       v                                     | Range: bytes=X-Y
+------+-------+                             |
| add_torrent() |                            v
+------+-------+              +-----------------------------+
       |                      |       HttpRangeServer       |
       v                      |  parse range, find source   |
+------+---------+            +---------+-------------------+
| lt::session    |                      |
| (BitTorrent    |                      | notify scheduler
|  + WebTorrent) |                      v
|  downloads     |            +---------+-------------------+
|  pieces        |            |    StreamingScheduler       |
+------+---------+            |  set_piece_deadline() on    |
       |                      |  hot window + lookahead     |
       | piece_finished       +---------+-------------------+
       | alert                          |
       v                                v
+------+---------+            +---------+-------------------+
| AlertDispatcher|            |       ByteSource            |
|  marks piece   |  signals   |  read(offset, len)          |
|  complete in   +----------->|  waits for pieces if needed |
|  availability  |    cv      |  reads from disk            |
|  index         |            +---------+-------------------+
+----------------+                      |
                                        | 64KB chunks
                                        v
                              +---------+-------------------+
                              |   TCP socket (loopback)     |
                              |   -> Player renders video   |
                              +-----------------------------+
```

---

## End-to-End User Flow

What happens when a user pastes a magnet link and hits play:

### 1. Add torrent

The user provides a magnet URI (or `.torrent` file path). The app calls `addTorrent()` which passes through Dart FFI -> C API -> `SeekServeEngine::add_torrent()`. libtorrent creates a torrent handle and starts peer discovery via **DHT**, **UDP/HTTP trackers**, and **Local Peer Discovery** (LAN multicast). At this point only the infohash is known -- no file names or sizes yet.

### 2. Metadata arrives

Once a peer is found, libtorrent downloads the torrent metadata (the `.torrent` info dictionary). The `AlertDispatcher` catches `metadata_received_alert` and:
- `MetadataCatalog` stores the file list (names, sizes, piece layout)
- A `MetadataReceived` event fires through the FFI callback to Dart
- The provider calls `listFiles()` to cache the file list

Typical time: 5-30 seconds depending on tracker/DHT speed.

### 3. File selection

The UI displays all files with icons, sizes, and a play button for video files. The user taps a video file (e.g. `sintel-2048-stereo_512kb.mp4`).

### 4. Stream setup

`selectFile(torrentId, fileIndex)` triggers the C++ engine to:
- Create a **ByteSource** — maps byte offsets to torrent pieces for this specific file
- Create a **StreamingScheduler** — sets piece deadlines so libtorrent downloads pieces in playback order
- Register the ByteSource in the **HttpRangeServer** under the route `/stream/{infohash}/{fileIndex}`

`getStreamUrl()` returns the local URL: `http://127.0.0.1:{port}/{infohash}/{fileIndex}?token={auth}`

### 5. Player opens stream

The video player (media_kit/mpv on mobile, VLC on desktop) opens the URL as a standard HTTP video stream. It sends an initial `Range: bytes=0-` request.

### 6. HTTP Range serving loop

For each Range request:

```
Player: GET /stream/{id}/{fi}  Range: bytes=1000000-
   |
   v
HttpRangeServer: parse range, look up ByteSource
   |
   v
StreamingScheduler: set_piece_deadline() on pieces near the read position
   |                (hot window = immediate, lookahead = 2s+)
   v
ByteSource::read(offset, 65536):
   |
   +-- piece available on disk?  --> read and return 64KB chunk
   +-- piece not yet downloaded? --> wait (condition_variable, up to 30s)
   |                                  AlertDispatcher signals on piece_finished
   v
Server: 206 Partial Content, streams 64KB chunks until range complete
```

The player decodes and renders the video as chunks arrive. Playback typically starts within 2-5 seconds of buffering.

### 7. Seek

When the user scrubs to a new position, the player sends a new Range request at the new byte offset. The StreamingScheduler activates **seek boost** — downloading extra pieces around the new position with aggressive deadlines — so playback resumes quickly (1-2 seconds).

### 8. Continuous download

While the video plays, libtorrent keeps downloading in the background. The scheduler adapts its strategy based on conditions:

| Mode | Condition | Behavior |
|------|-----------|----------|
| `STREAMING_FIRST` | Default | Prioritize pieces near playhead |
| `DOWNLOAD_ASSIST` | Frequent stalls (>3) | Widen download window |
| `DOWNLOAD_FIRST` | Very slow connection (<500 KB/s) | Maximize overall download rate |

The status bar updates every second showing progress, download rate, peer count, and current scheduling mode.

---

## Module Dependency Graph

```
              flutter_seekserve_app (example Dart app)
                    |
                    | depends on
                    v
              flutter_seekserve_ui (widget library)
              /     |
  media_kit  /      | depends on
  (video)   /       v
              flutter_seekserve (FFI plugin)
                    |
                    | dart:ffi + NativeCallable.listener
                    v
              seekserve-capi  (shared/static lib, C API)
                    |
                    | links
                    v
              seekserve-serve (static lib)
              /          \
             /            \
            v              v
    seekserve-core    Boost.Beast
    (static lib)      Boost.Asio
         |
         v
    libtorrent (submodule, master branch)
    /          \
   v            v
 Boost       libdatachannel (WebTorrent, native)
 OpenSSL     /       |       \
           libjuice usrsctp  plog

 On WASM: libdatachannel is replaced by datachannel-wasm
          (browser-native WebRTC via JS interop)
```

Build targets:

```
seekserve-core     -->  libseekserve-core.a
seekserve-serve    -->  libseekserve-serve.a    (depends on core)
seekserve-capi     -->  libseekserve.dylib/.so  (depends on serve)
                   -->  libseekserve.a           (iOS static, with SEEKSERVE_CAPI_STATIC=ON)
seekserve-demo     -->  seekserve-demo           (depends on serve)
seekserve-*-tests  -->  test executables          (depends on serve + capi)
```

---

## Thread Model

```
+-------------------------------------------------------------------+
|                         THREAD DOMAINS                             |
+-------------------------------------------------------------------+
|                                                                     |
|  [1] libtorrent internal          (network I/O, disk I/O)          |
|      - never touched directly                                       |
|      - managed by lt::session                                       |
|      - includes WebRTC data channels when WebTorrent is ON         |
|                                                                     |
|  [2] AlertDispatcher              (dedicated thread)                |
|      - pop_alerts() loop, 100ms poll                                |
|      - dispatches typed handlers                                    |
|      - handlers must NOT block                                      |
|      +                                                              |
|      |  fires:                                                      |
|      |    add_torrent_alert    -> MetadataCatalog                   |
|      |    metadata_received    -> MetadataCatalog + Cache           |
|      |    piece_finished       -> Availability + ByteSource + Sched |
|      |    file_completed       -> OfflineCache                      |
|                                                                     |
|  [3] Boost.Asio io_context        (1 thread)                       |
|      - HTTP accept loops (async)                                    |
|      - tick timer (1s periodic)                                     |
|      - thread-per-connection for streams (detached std::thread)     |
|                                                                     |
|  [4] Caller thread                (user's thread / Dart isolate)   |
|      - creates SeekServeEngine                                      |
|      - calls add_torrent, select_file, start_server, etc.          |
|                                                                     |
+-------------------------------------------------------------------+

Synchronization:

  PieceAvailabilityIndex   vector<atomic<bool>>    lock-free (monotonic)
  MetadataCatalog          std::mutex              alert writes, user reads
  StreamingScheduler       std::mutex              alert + HTTP threads
  ByteSource::read()       condition_variable      HTTP waits, alert signals
  OfflineCacheManager      std::mutex              SQLite WAL underneath
  Engine states/events     std::mutex (x2)         separate for states_, event_cb_
```

---

## Streaming Pipeline

When a player sends an HTTP Range request, the following pipeline executes:

```
  Player Request: GET /stream/abc123/8?token=XXX  Range: bytes=1000000-1999999
         |
         v
  [1] HttpRangeServer::handle_connection()
         |
         +-- parse_target() -> torrent_id=abc123, file_index=8
         +-- constant_time_compare(token, expected)
         +-- parse_range_header("bytes=1000000-1999999", file_size)
         |
         v
  [2] RangeCallback -> StreamingScheduler::on_range_request()
         |
         +-- ByteRangeMapper::map({1000000, 1999999}) -> PieceSpan{p42..p46}
         +-- set_piece_deadline(p42, 100ms)  // hot window
         +-- set_piece_deadline(p43, 150ms)
         +-- set_piece_deadline(p44, 200ms)
         +-- set_piece_deadline(p45..p65, 2000ms+)  // lookahead
         |
         v
  [3] ByteSource::read(offset=1000000, len=65536)  // 64KB chunk
         |
         +-- ByteRangeMapper::map({1000000, 1065535}) -> PieceSpan
         +-- PieceAvailabilityIndex::is_span_complete() ?
         |     |
         |     +-- YES -> read from disk, return data
         |     +-- NO  -> condition_variable::wait(30s timeout)
         |                  (alert thread signals on piece_finished)
         |
         v
  [4] net::write(socket, data)  // raw Asio write, 64KB
         |
         +-- repeat [3]-[4] until range fully served
         |
         v
  [5] Connection complete (RAII ConnGuard decrements active_connections_)
```

---

## Piece Scheduling Strategy

```
  File on disk (linear byte order):
  [===============================================================]
   ^                                                              ^
   byte 0                                                    file_size

  Piece layout mapped from byte range:
  [p0][p1][p2][p3][p4][p5][p6][p7][p8][p9][p10][p11]...[pN]

  When playhead is at piece p4:

  Deadline zones:
  [  bg  ][  bg  ][ bg  ][ bg ][HOT ][HOT ][HOT ][LOOK][LOOK][LOOK][LOOK][ bg ]
   p0      p1      p2     p3    p4    p5    p6    p7    p8    p9    p10    p11
                                 ^
                             playhead
                           deadline: 100ms ------>  2000ms+ -------->
                           |<- hot_window ->|<----- lookahead ----->|

  On SEEK (playhead jumps from p4 to p30):

  [  bg  ]...[bg][BOOST][BOOST][HOT ][HOT ][HOT ][LOOK][LOOK]...[LOOK][ bg ]
                  p28    p29    p30   p31   p32   p33   p34       p50
                  |<-- seek_boost -->|<- hot_window ->|<-- lookahead -->|
                  extra pieces for 3 seconds

  Mode switching (evaluated every 1s tick):

    STREAMING_FIRST  --[stalls > 3]-->  DOWNLOAD_ASSIST
    DOWNLOAD_ASSIST  --[rate < 500KB/s]-->  DOWNLOAD_FIRST
    DOWNLOAD_FIRST   --[buffer >= 2MB && rate OK]-->  STREAMING_FIRST
```

---

## Project Structure

```
seekserve/
|
|-- CMakeLists.txt              Root build: project options, subdirs, libtorrent
|-- CMakePresets.json           Build presets: debug, release, asan, tsan
|-- vcpkg.json                  Dependency manifest (Boost, spdlog, sqlite3, OpenSSL, etc.)
|-- setup.sh                    One-command bootstrap: vcpkg + submodules + build
|-- .gitmodules                 libtorrent submodule (master branch)
|
|-- extern/
|   |-- libtorrent/             Git submodule (arvidn/libtorrent@master)
|   |   +-- deps/
|   |       +-- libdatachannel/ WebRTC Data Channels (native WebTorrent)
|   |       +-- libjuice/       ICE / NAT traversal
|   |       +-- usrsctp/        SCTP protocol
|   |       +-- plog/           Logging (header-only)
|   +-- datachannel-wasm/       Git submodule (WebRTC for WASM/Emscripten)
|
|-- seekserve-core/             STATIC LIB: torrent engine + scheduling
|   |-- include/seekserve/
|   |   |-- types.hpp               TorrentId, FileIndex, PieceSpan, ByteRange, FileInfo
|   |   |-- error.hpp               errc enum, Result<T>, error category
|   |   |-- config.hpp              SessionConfig, SchedulerConfig, ServerConfig, CacheConfig
|   |   |-- session_manager.hpp     lt::session lifecycle, add/remove, handle registry
|   |   |-- alert_dispatcher.hpp    Dedicated thread, pop_alerts(), typed handler registry
|   |   |-- metadata_catalog.hpp    Torrent -> file list, file selection, priority
|   |   |-- byte_range_mapper.hpp   HTTP byte ranges -> PieceSpan via file_storage::map_file()
|   |   |-- piece_availability.hpp  Lock-free atomic bitfield, contiguous byte calc
|   |   |-- byte_source.hpp         read(offset, len) with cv wait, disk read, cancel
|   |   |-- streaming_scheduler.hpp Hot window, lookahead, seek boost, mode switching
|   |   +-- offline_cache.hpp       SQLite index, LRU eviction, quota, offline-ready
|   +-- src/*.cpp
|
|-- seekserve-serve/            STATIC LIB: HTTP servers + engine facade
|   |-- include/seekserve/
|   |   |-- engine.hpp              SeekServeEngine facade (single entry point)
|   |   |-- http_range_server.hpp   Beast HTTP, /stream/{id}/{fi}, Range/206
|   |   |-- control_api_server.hpp  Beast HTTP, REST JSON API, CORS
|   |   +-- range_parser.hpp        RFC 7233 Range header parser
|   +-- src/*.cpp
|
|-- seekserve-capi/             SHARED/STATIC LIB: C API for FFI
|   |-- include/seekserve_c.h       Opaque handle, extern "C", error codes, callbacks
|   +-- src/seekserve_c.cpp         Bridge: JSON config, map_error, alloc_string
|
|-- seekserve-demo/             EXECUTABLE: CLI demo
|   +-- src/main.cpp                Add torrent, list files, select, stream URL
|
|-- tests/                      189 tests (138 unit + 32 integration + 19 C API)
|   |-- unit/                       ByteRangeMapper, PieceAvailability, Scheduler, etc.
|   +-- integration/                HTTP server, session lifecycle, stress tests
|
|-- flutter_seekserve/          FLUTTER PLUGIN: Dart API + native bindings
|   |-- pubspec.yaml                ffiPlugin: true, dependencies
|   |-- ffigen.yaml                 Config for dart run ffigen
|   |-- native_header/
|   |   +-- seekserve_c.h           Copy of C API header (ffigen input)
|   |-- lib/
|   |   |-- seekserve.dart          Public barrel export
|   |   +-- src/
|   |       |-- bindings_generated.dart  Auto-generated FFI bindings (DO NOT EDIT)
|   |       |-- native_library.dart      Platform DynamicLibrary loader
|   |       |-- seekserve_client.dart    High-level Dart API
|   |       |-- seekserve_exception.dart Error code mapping
|   |       +-- models/
|   |           |-- file_info.dart       FileInfo with isVideo, extension
|   |           |-- torrent_status.dart  TorrentStatus with all metrics
|   |           |-- seekserve_config.dart Config -> JSON serialization
|   |           +-- seekserve_event.dart  Sealed class: MetadataReceived, FileCompleted, etc.
|   |-- ios/
|   |   |-- flutter_seekserve.podspec    Vendored XCFramework, static_framework
|   |   +-- Frameworks/                  Pre-built seekserve.xcframework (gitignored)
|   |-- android/
|   |   |-- build.gradle                 minSdk=28, abiFilters, jniLibs
|   |   +-- src/main/jniLibs/            Pre-built .so files (gitignored)
|   |       |-- arm64-v8a/libseekserve.so
|   |       |-- armeabi-v7a/libseekserve.so
|   |       +-- x86_64/libseekserve.so
|   |-- test/
|   |   +-- models_test.dart             15 unit tests for Dart models
|   +-- example/                     EXAMPLE APP
|       |-- lib/
|       |   |-- main.dart                MediaKit init, Provider setup
|       |   |-- providers/
|       |   |   +-- seekserve_provider.dart  State management, polling, events
|       |   |-- screens/
|       |   |   |-- home_screen.dart     Torrent URL input, active torrent list
|       |   |   |-- file_selection_screen.dart  File list, tap to stream
|       |   |   +-- player_screen.dart   media_kit video player + status overlay
|       |   +-- widgets/
|       |       |-- torrent_card.dart    Progress bar, rates, peer count
|       |       +-- status_bar.dart      Download/upload rates, mode badge
|       |-- ios/                         Xcode project, Info.plist (ATS localhost)
|       +-- android/                     Gradle, network_security_config.xml
|
|-- flutter_seekserve_ui/           FLUTTER PACKAGE: UI widget library
|   |-- pubspec.yaml                No Material dependency, depends on flutter_seekserve
|   |-- lib/
|   |   |-- flutter_seekserve_ui.dart  Public barrel export (all widgets)
|   |   +-- src/
|   |       |-- theme/
|   |       |   |-- ss_theme_data.dart     SsThemeData: colours, text styles, dimensions
|   |       |   +-- ss_theme.dart          SsTheme: InheritedWidget + dark/light presets
|   |       |-- atoms/
|   |       |   |-- ss_button.dart         Primary/secondary/danger button
|   |       |   |-- ss_icon_button.dart    Icon button with press feedback
|   |       |   |-- ss_text_field.dart     Themed text input
|   |       |   |-- ss_progress_bar.dart   Linear progress (CustomPaint)
|   |       |   |-- ss_badge.dart          Pill-shaped status badge
|   |       |   |-- ss_chip.dart           Icon + label info chip
|   |       |   |-- ss_slider.dart         Drag slider (CustomPaint)
|   |       |   |-- ss_card.dart           Themed container card
|   |       |   +-- ss_dialog.dart         Overlay confirmation dialog
|   |       |-- composites/
|   |       |   |-- ss_torrent_tile.dart     Torrent row: name, progress, rates, badge
|   |       |   |-- ss_torrent_list.dart     Scrollable list + swipe-to-delete
|   |       |   |-- ss_torrent_detail.dart   Full metadata panel
|   |       |   |-- ss_file_tile.dart        File row with type icon
|   |       |   |-- ss_file_tree.dart        Expandable folder tree
|   |       |   |-- ss_transfer_stats.dart   DL/UL rates + peer chips
|   |       |   |-- ss_stream_mode_badge.dart    Stream mode indicator
|   |       |   |-- ss_add_torrent_bar.dart      URI input + paste + add
|   |       |   |-- ss_add_torrent_dialog.dart   Full-screen overlay for magnet/path input
|   |       |   |-- ss_server_status_panel.dart  Server health + diagnostics panel
|   |       |   +-- ss_delete_confirm.dart       3-option remove dialog
|   |       |-- player/
|   |       |   |-- ss_seek_controls.dart      Slider + skip±10s + play/pause
|   |       |   |-- ss_buffering_overlay.dart  Animated spinner overlay
|   |       |   |-- ss_player_status_bar.dart  Progress + stats + mode badge
|   |       |   +-- ss_video_player.dart       Complete player (probe + media_kit)
|   |       |-- controllers/
|   |       |   +-- ss_torrent_manager.dart    ChangeNotifier: poll, events, CRUD
|   |       +-- utils/
|   |           +-- format.dart                formatBytes, formatRate, formatDuration
|   +-- test/
|       |-- theme_test.dart                    Dark/light, copyWith, InheritedWidget
|       |-- format_test.dart                   Bytes, rate, duration, file categories
|       +-- atoms_test.dart                    Button, badge, progress, card, chip
|
|-- flutter_seekserve_app/             FLUTTER APP: example / SDK integration reference
|   |-- pubspec.yaml                   Depends on flutter_seekserve + flutter_seekserve_ui
|   |-- lib/
|   |   |-- main.dart                  WidgetsApp, SsTheme, ManagerScope, engine init
|   |   |-- router.dart                3 routes: /, /detail, /player
|   |   +-- screens/
|   |       |-- home_screen.dart       Add torrent bar + torrent list + error banner
|   |       |-- torrent_detail_screen.dart  Metadata panel + file tree
|   |       +-- player_screen.dart     SsVideoPlayer + top bar
|   +-- test/
|       +-- widget_test.dart           App startup smoke test
|
|-- scripts/
|   |-- build-ios.sh                 iOS arm64 (device + simulator) -> XCFramework
|   |-- build-android.sh            Android 3 ABIs via NDK -> .so files
|   |-- build-flutter-natives.sh    Orchestrator: build + copy to plugin
|   |-- deploy-wasm-to-app.sh       Copy WASM artifacts to Flutter web app
|   +-- dev-ios-sim.sh              Incremental build + run on iOS Simulator
|
|-- docker/
|   |-- Dockerfile.wasm              3-stage Emscripten WASM build
|   +-- build-wasm.sh               Docker build + extract artifacts
|
|-- triplets/
|   |-- arm-neon-android.cmake       Custom vcpkg triplet (NDK 29 NEON=ON)
|   +-- wasm32-emscripten.cmake      Custom vcpkg triplet for Emscripten
|
|-- docs/                            Specification & design documents
|   |-- ARCHITECTURE.md, HTTP_RANGE_SPEC.md, SCHEDULER_POLICY.md
|   |-- STORAGE_POLICY.md, SECURITY.md, C_API.md
|
+-- fixtures/
    +-- Sintel_archive.torrent       Test torrent (CC BY 3.0, 12 files, 4 MP4s)
```

---

## Build & Run

### Prerequisites

- CMake >= 3.21
- Ninja
- C++17 compiler (Clang or GCC)
- Git (for submodules + vcpkg)

### One-Command Setup

```bash
./setup.sh debug       # Full bootstrap: vcpkg + submodules + cmake + build
```

This will:
1. Install missing tools via Homebrew (macOS) or check availability (Linux)
2. Clone and bootstrap vcpkg at `~/vcpkg`
3. Initialize the libtorrent git submodule + recursive deps (libdatachannel for WebTorrent)
4. Detect WebTorrent availability (libdatachannel present -> `WEBTORRENT=ON`)
5. Configure CMake with vcpkg toolchain
6. Build all targets (core, serve, capi, demo, tests)

### Build Variants

```bash
./setup.sh debug       # Debug build (default)
./setup.sh release     # Optimized release build
./setup.sh asan        # Debug + AddressSanitizer
./setup.sh tsan        # Debug + ThreadSanitizer
./setup.sh wasm        # WebAssembly build via Docker (Emscripten)
```

### Manual CMake

```bash
cmake --preset debug
cmake --build --preset debug
```

### Run Demo

```bash
./build/debug/seekserve-demo/seekserve-demo fixtures/Sintel_archive.torrent
```

The demo will:
1. Load the torrent and display all files
2. Auto-select the smallest MP4
3. Print a stream URL you can paste into VLC

### Run Tests

```bash
cd build/debug && ctest    # All 189 tests
```

---

## Build Commands Reference

All build scripts are in the project root (`setup.sh`) or in the `scripts/` directory. Below is a complete reference of which commands to run for each scenario.

### Quick Reference

| Scenario | Command |
|----------|---------|
| First-time C++ SDK build | `./setup.sh debug` |
| Release build (optimized) | `./setup.sh release` |
| WASM build (Docker) | `./setup.sh wasm` |
| Run C++ tests | `cd build/debug && ctest` |
| Build iOS native libs | `scripts/build-flutter-natives.sh ios` |
| Build Android native libs | `scripts/build-flutter-natives.sh android` |
| Build all native libs | `scripts/build-flutter-natives.sh all` |
| Dev loop on iOS Simulator | `scripts/dev-ios-sim.sh` |
| Deploy WASM to Flutter web | `scripts/deploy-wasm-to-app.sh` |
| Run Flutter plugin tests | `cd flutter_seekserve && flutter test` |
| Run Flutter UI tests | `cd flutter_seekserve_ui && flutter test` |
| Build Flutter app (iOS) | `cd flutter_seekserve_app && flutter build ios` |
| Build Flutter app (Android) | `cd flutter_seekserve_app && flutter build apk` |
| Build Flutter app (Web) | `cd flutter_seekserve_app && flutter build web` |

### `setup.sh` -- C++ SDK Bootstrap

The main entry point for building the C++ SDK from scratch. It handles all dependencies (vcpkg, git submodules, CMake configure, and compile).

```bash
./setup.sh debug       # Debug build with tests + demo + WebTorrent auto-detect
./setup.sh release     # Optimized release build (no tests)
./setup.sh asan        # Debug + AddressSanitizer (memory errors)
./setup.sh tsan        # Debug + ThreadSanitizer (data races)
./setup.sh wasm        # WebAssembly build via Docker (Emscripten + WebTorrent)
```

**When to use:** First-time setup, after pulling changes, or when you need a clean rebuild of the native C++ SDK for desktop (macOS/Linux).

**What it does (6 steps):**
1. Checks system dependencies (cmake, ninja, git) -- installs via Homebrew on macOS
2. Clones and bootstraps vcpkg at `~/vcpkg` (full clone, not shallow)
3. Initializes libtorrent submodule + recursive deps (libdatachannel for WebTorrent)
4. Detects WebTorrent availability (auto-enables if libdatachannel found)
5. Configures CMake with vcpkg toolchain
6. Builds all targets (core, serve, capi, demo, tests)

**Output:**
```
build/{debug|release|asan|tsan}/
  seekserve-demo/seekserve-demo           # CLI demo executable
  tests/seekserve-unit-tests              # 138 unit tests
  tests/seekserve-integration-tests       # 32 integration tests
  tests/seekserve-capi-tests              # 19 C API tests
  seekserve-capi/libseekserve.dylib       # Shared library (macOS)
```

**Note:** `setup.sh` auto-detects WebTorrent and enables it (`WEBTORRENT=ON`) if libdatachannel is present. The CMake presets in `CMakePresets.json` have `WEBTORRENT=OFF` by default -- use `setup.sh` or pass `-DSEEKSERVE_ENABLE_WEBTORRENT=ON` manually.

### `scripts/build-ios.sh` -- iOS Cross-Compilation

Builds the C++ SDK as a static XCFramework for iOS (device arm64 + simulator arm64).

```bash
scripts/build-ios.sh
```

**When to use:** When you need to rebuild native libraries for the iOS Flutter plugin.

**Prerequisites:** Xcode command-line tools, vcpkg at `~/vcpkg`.

**What it does:**
1. Builds for `iphoneos` (arm64-ios vcpkg triplet, `SEEKSERVE_CAPI_STATIC=ON`)
2. Builds for `iphonesimulator` (arm64-ios-simulator vcpkg triplet)
3. Combines 22+ static libraries per slice via `libtool -static`
4. Wraps each in a `.framework` bundle with module map and header
5. Creates XCFramework via `xcodebuild -create-xcframework`

**Output:**
```
build/ios-xcframework/seekserve.xcframework
```

**Build details:**
- Deployment target: iOS 15.0
- Build type: Release
- WebTorrent: ON
- Each slice: ~85 MB (static, all deps combined)

### `scripts/build-android.sh` -- Android Cross-Compilation

Builds the C++ SDK as shared libraries for 3 Android ABIs.

```bash
export ANDROID_NDK_HOME=/path/to/ndk    # optional, auto-detected from ~/Library/Android/sdk/ndk/
scripts/build-android.sh
```

**When to use:** When you need to rebuild native libraries for the Android Flutter plugin.

**Prerequisites:** Android NDK (auto-detected from `ANDROID_NDK_HOME`, `ANDROID_HOME`, or `~/Library/Android/sdk/ndk/`), vcpkg at `~/vcpkg`.

**What it does:**
For each ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`):
1. Configures CMake with NDK toolchain + vcpkg
2. Builds shared library (`SEEKSERVE_CAPI_STATIC=OFF`)
3. Uses custom triplet `arm-neon-android` for armeabi-v7a (NDK 29 compatibility)

**Output:**
```
build/android-arm64-v8a/seekserve-capi/libseekserve.so
build/android-armeabi-v7a/seekserve-capi/libseekserve.so
build/android-x86_64/seekserve-capi/libseekserve.so
```

**Build details:**
- Android platform: API 28 (required for `std::aligned_alloc` in Boost.Asio)
- Build type: Release
- WebTorrent: ON
- Libraries are ~100 MB unstripped

### `scripts/build-flutter-natives.sh` -- All-in-One Plugin Build

Orchestrator script that builds native libraries and copies them to the Flutter plugin directories.

```bash
scripts/build-flutter-natives.sh all       # iOS + Android
scripts/build-flutter-natives.sh ios       # iOS only
scripts/build-flutter-natives.sh android   # Android only
```

**When to use:** The primary command for preparing the Flutter plugin for deployment. Run this before `flutter build` or `flutter run`.

**What it does:**
1. Calls `build-ios.sh` and/or `build-android.sh`
2. Copies XCFramework to `flutter_seekserve/ios/Frameworks/seekserve.xcframework`
3. Copies `.so` files to `flutter_seekserve/android/src/main/jniLibs/{abi}/libseekserve.so`
4. Strips Android `.so` debug symbols via `llvm-strip` (~109 MB -> 6-15 MB)

**Output after build:**
```
flutter_seekserve/
  ios/Frameworks/seekserve.xcframework          # ~170 MB (2 slices)
  android/src/main/jniLibs/
    arm64-v8a/libseekserve.so                   # ~15 MB (stripped)
    armeabi-v7a/libseekserve.so                 # ~10 MB (stripped)
    x86_64/libseekserve.so                      # ~15 MB (stripped)
```

### `scripts/dev-ios-sim.sh` -- iOS Simulator Dev Loop

Fast incremental development script for testing on the iOS Simulator.

```bash
./scripts/dev-ios-sim.sh              # Incremental build + run
./scripts/dev-ios-sim.sh --full       # Clean rebuild of native libs
./scripts/dev-ios-sim.sh --native     # Rebuild native libs only (no Flutter)
./scripts/dev-ios-sim.sh --flutter    # Flutter build + install only (skip native)
./scripts/dev-ios-sim.sh --run        # Install + launch only (skip build)
```

**When to use:** During active development to quickly iterate on changes and test on the simulator. Much faster than a full `build-flutter-natives.sh` because it does incremental builds and only targets the simulator.

**Prerequisites:** Booted iOS Simulator, Xcode CLI tools, vcpkg, Flutter SDK.

**What it does (4 steps):**
1. Builds native library for simulator arm64 (incremental, Debug)
2. Packages XCFramework (builds device slice if needed, one-time cost)
3. Builds Flutter example app (`flutter build ios --simulator --debug`)
4. Installs and launches on the booted simulator

### Typical Build Workflows

**First-time setup (from clean clone):**
```bash
# 1. Build C++ SDK (desktop)
./setup.sh debug

# 2. Run C++ tests to verify
cd build/debug && ctest && cd ../..

# 3. Build native libs for mobile
scripts/build-flutter-natives.sh all

# 4. Run Flutter app
cd flutter_seekserve_app
flutter pub get
flutter run
```

**After C++ code changes (iterating on iOS Simulator):**
```bash
scripts/dev-ios-sim.sh
```

**After C++ code changes (full rebuild for both platforms):**
```bash
scripts/build-flutter-natives.sh all
cd flutter_seekserve_app && flutter run
```

**After Dart-only changes (no native rebuild needed):**
```bash
cd flutter_seekserve_app && flutter run
```

**Running all tests:**
```bash
# C++ tests
cd build/debug && ctest && cd ../..

# Dart plugin tests
cd flutter_seekserve && flutter test && cd ..

# Dart UI tests
cd flutter_seekserve_ui && flutter test && cd ..
```

---

## Flutter Plugin

### Overview

The `flutter_seekserve` plugin wraps the C API via `dart:ffi`, providing a high-level Dart API with async events. It supports iOS and Android with pre-built native libraries.

### Building Native Libraries

Native libraries are **not committed** to the repository (they are 200+ MB). Build them with:

```bash
# Build for all platforms
scripts/build-flutter-natives.sh all

# Or build individually
scripts/build-flutter-natives.sh ios       # XCFramework (device + simulator)
scripts/build-flutter-natives.sh android   # 3 ABIs (.so files, stripped)
```

This builds the C++ SDK with all dependencies (libtorrent, Boost, OpenSSL, libdatachannel) and copies the artifacts to the plugin directories:
- iOS: `flutter_seekserve/ios/Frameworks/seekserve.xcframework`
- Android: `flutter_seekserve/android/src/main/jniLibs/{abi}/libseekserve.so`

### Library Sizes

| Platform | Architecture | Size (stripped) |
|----------|-------------|----------------|
| iOS | arm64 (device) | ~85 MB (static, combined with all deps) |
| iOS | arm64 (simulator) | ~85 MB |
| Android | arm64-v8a | ~15 MB |
| Android | armeabi-v7a | ~10 MB |
| Android | x86_64 | ~15 MB |

### Dart API

```dart
import 'package:flutter_seekserve/seekserve.dart';

// Create client with config
final client = SeekServeClient(config: SeekServeConfig(
  savePath: '/path/to/downloads',
  authToken: 'my_secret',
  enableWebtorrent: true,
  extraTrackers: ['wss://tracker.webtorrent.dev'],
));

// Start HTTP servers
final port = await client.startServer();

// Add torrent
final torrentId = await client.addTorrent('magnet:?xt=urn:btih:...');

// Listen for events
client.events.listen((event) {
  switch (event) {
    case MetadataReceived(:final torrentId):
      print('Metadata ready for $torrentId');
    case FileCompleted(:final torrentId, :final fileIndex):
      print('File $fileIndex completed');
    case TorrentError(:final message):
      print('Error: $message');
  }
});

// List files and select one
final files = await client.listFiles(torrentId);
final videoFile = files.firstWhere((f) => f.isVideo);
await client.selectFile(torrentId, videoFile.index);

// Get stream URL for video player
final url = await client.getStreamUrl(torrentId, videoFile.index);
// -> http://127.0.0.1:54321/stream/{id}/{fi}?token=...

// Monitor progress
final status = await client.getStatus(torrentId);
print('Progress: ${(status.progress * 100).toStringAsFixed(1)}%');
print('Peers: ${status.numPeers}, Rate: ${status.downloadRate} B/s');

// Cleanup
client.dispose();
```

### Example App

The example app demonstrates all plugin capabilities:

```bash
cd flutter_seekserve/example

# iOS (requires native libs built first)
flutter build ios --no-codesign

# Android (requires native libs built first)
flutter build apk
```

**Screens:**
1. **Home** — paste torrent URL/magnet, see active torrents with progress, rates, peer count
2. **File Selection** — browse all files, video files highlighted, tap to stream
3. **Player** — `media_kit` video player with live status bar (progress, rates, peers, mode)

### Flutter Tests

```bash
cd flutter_seekserve
flutter test          # 15 Dart unit tests
flutter analyze       # Static analysis
```

### Requirements

| Platform | Minimum |
|----------|---------|
| iOS | 15.0 |
| Android | API 28 (Android 9) |
| Dart | 3.2+ |
| Flutter | 3.19+ |

---

## Flutter UI Package

The `flutter_seekserve_ui` package provides a complete set of themed widgets for torrent management and video playback. It has **zero Material/Cupertino dependency** — all widgets are built from `flutter/widgets.dart` only.

### Design Principles

- **Atomic Design** — atoms (buttons, badges) compose into composites (torrent tiles, file trees), which compose into player and screen-level widgets
- **Theme-driven** — every widget reads colours and styles from `SsTheme.of(context)`, no hardcoded values
- **No Material** — uses `WidgetsApp` instead of `MaterialApp`, `EditableText` instead of `TextField`, `GestureDetector` instead of `InkWell`
- **Custom painting** — `SsProgressBar` and `SsSlider` use `CustomPaint` for full control

### Widget Inventory

| Category | Widget | Purpose |
|----------|--------|---------|
| **Atom** | `SsButton` | Primary / secondary / danger button with press feedback |
| **Atom** | `SsIconButton` | Icon button with opacity feedback |
| **Atom** | `SsTextField` | Themed text input field |
| **Atom** | `SsProgressBar` | Linear progress bar (CustomPaint) |
| **Atom** | `SsBadge` | Pill-shaped coloured status badge |
| **Atom** | `SsChip` | Icon + label info chip |
| **Atom** | `SsSlider` | Horizontal drag slider (CustomPaint) |
| **Atom** | `SsCard` | Themed container card with optional tap |
| **Atom** | `SsDialog` | Overlay confirmation dialog (PageRouteBuilder) |
| **Composite** | `SsTorrentTile` | Torrent row: name, progress bar, DL/UL rates, peer count, state badge |
| **Composite** | `SsTorrentList` | Scrollable list with swipe-to-delete via `Dismissible` |
| **Composite** | `SsTorrentDetail` | Full metadata panel: infohash, size, files, playhead, deadlines |
| **Composite** | `SsPiecesMap` | Per-file pieces grid (CustomPaint), playhead indicator, streaming file highlight |
| **Composite** | `SsFileTile` | File row with type icon (video/audio/subtitle/image/doc) |
| **Composite** | `SsFileTree` | Expandable folder tree, auto-skips single root dir |
| **Composite** | `SsTransferStats` | DL rate, UL rate, peer/seed count as `SsChip` widgets |
| **Composite** | `SsStreamModeBadge` | STREAM / ASSIST / DOWNLOAD badge with mode colour |
| **Composite** | `SsAddTorrentBar` | URI text input + paste from clipboard + add button |
| **Composite** | `SsAddTorrentDialog` | Full-screen overlay dialog for magnet URI / .torrent path input |
| **Composite** | `SsDeleteConfirm` | 3-option dialog: Cancel / Keep files / Delete all |
| **Composite** | `SsServerStatusPanel` | Server health diagnostics: ports, auth, rates, endpoints |
| **Player** | `SsSeekControls` | Slider + skip ±10s + play/pause via `media_kit` streams |
| **Player** | `SsBufferingOverlay` | Animated spinning arc overlay |
| **Player** | `SsPlayerStatusBar` | Download progress + transfer stats + stream mode |
| **Player** | `SsVideoPlayer` | Complete video player with HTTP probe, `media_kit`, all sub-widgets |
| **Controller** | `SsTorrentManager` | `ChangeNotifier` wrapping `SeekServeClient`, poll + events |

### Usage

```dart
import 'package:flutter_seekserve_ui/flutter_seekserve_ui.dart';

// Wrap your app with the theme
SsTheme(
  data: SsThemeData.dark(),
  child: MyApp(),
);

// Custom theme
SsTheme(
  data: SsThemeData.dark().copyWith(
    primary: Color(0xFFFF5722),
    downloading: Color(0xFF00BCD4),
  ),
  child: MyApp(),
);

// Use widgets anywhere
SsTorrentList(
  torrents: manager.statuses,
  onTap: (status) => navigateToDetail(status.torrentId),
  onDelete: (status) => manager.removeTorrent(status.torrentId),
);

// File tree with auto-play
SsFileTree(
  files: fileList,
  onFileTap: (file) => manager.selectAndStream(torrentId, file.index),
);

// Complete video player
SsVideoPlayer(
  streamUrl: 'http://127.0.0.1:54321/stream/abc.../8?token=xxx',
  torrentStatus: currentStatus,  // optional, shows status bar
);
```

### Tests

```bash
cd flutter_seekserve_ui
flutter test          # 32 unit tests (theme, format, atoms)
flutter analyze       # 0 errors
```

---

## Flutter App (Example)

The `flutter_seekserve_app` is an **example application** that demonstrates how to integrate the SeekServe SDK into a real Flutter project. It serves as a reference implementation showing the recommended patterns for torrent management, file browsing, and video playback using `flutter_seekserve` and `flutter_seekserve_ui`. Built entirely with `WidgetsApp` (not `MaterialApp`) to showcase the Material-free widget library.

### Screens

| Screen | Route | Widgets Used |
|--------|-------|-------------|
| **Home** | `/` | `SsAddTorrentBar`, `SsTorrentList`, `SsBadge`, `SsDeleteConfirm` |
| **Torrent Detail** | `/detail` | `SsTorrentDetail`, `SsFileTree`, `SsIconButton` |
| **Player** | `/player` | `SsVideoPlayer`, `SsSeekControls`, `SsBufferingOverlay`, `SsPlayerStatusBar` |

### State Management

The app uses `SsTorrentManager` (from the UI package) as a `ChangeNotifier`, injected via `ManagerScope` (`InheritedWidget`):

```dart
// Access from any widget
final manager = context.manager;
manager.addTorrent('magnet:?xt=urn:btih:...');
manager.selectAndStream(torrentId, fileIndex);
```

### Running

```bash
cd flutter_seekserve_app

# iOS (requires native libs built first)
flutter run --device-id <simulator_or_device>

# Android
flutter run
```

---

## Usage

### Typical Workflow

```
1. Create engine        ->  ss_engine_create(config_json)
2. Start HTTP servers   ->  ss_start_server(engine, 0, &port)
3. Add torrent          ->  ss_add_torrent(engine, "path.torrent", id_buf, 128)
4. Wait for metadata    ->  (event callback fires "metadata_received")
5. List files           ->  ss_list_files(engine, id, &json)
6. Select file          ->  ss_select_file(engine, id, file_index)
7. Get stream URL       ->  ss_get_stream_url(engine, id, file_index, &url)
8. Open in VLC          ->  vlc <url>
9. Cleanup              ->  ss_engine_destroy(engine)
```

### VLC Example

```bash
# Start the demo
./build/debug/seekserve-demo/seekserve-demo fixtures/Sintel_archive.torrent

# Output:
#   Stream URL: http://127.0.0.1:54321/stream/e4d37e62.../8?token=abc123
#
# Open in VLC:
vlc "http://127.0.0.1:54321/stream/e4d37e62.../8?token=abc123"
```

VLC will:
- Send `HEAD` to discover file size and `Accept-Ranges: bytes`
- Send `Range: bytes=0-` to start playback
- Send seek requests (`Range: bytes=N-`) when scrubbing

---

## Testing the System

### Test Torrent: Sintel (CC BY 3.0)

SeekServe ships with a reference torrent for end-to-end testing:

**Sintel** is an open-source short film by the [Blender Foundation](https://durian.blender.org/), released under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

| Property | Value |
|----------|-------|
| Infohash | `e4d37e62d14ba96d29b9e760148803b458aee5b6` |
| Files | 12 total (4 MP4, 1 MKV, 1 OGV, 1 AVI, subtitles, poster) |
| Test target | Index 8 — `sintel-2048-stereo_512kb.mp4` (73.8 MB) |

```
Index  Size       File
-----  ---------  ------------------------------------------
  0       483 B   Sintel.de.srt
  1       549 B   Sintel.en.srt
  2       471 B   Sintel.es.srt
  3       487 B   Sintel.fr.srt
  4       459 B   Sintel.it.srt
  5       466 B   Sintel.nl.srt
  6       466 B   Sintel.pl.srt
  7       509 B   Sintel.pt.srt
  8    73.8 MB    sintel-2048-stereo_512kb.mp4    <-- test target
  9   296.1 MB    Sintel (Surround).mp4
 10   269.3 MB    Sintel.2010.720p.mkv
 11   129.5 KB    poster.jpg
```

### Quick Functional Test

```bash
# 1. Build and run the demo
./setup.sh debug
./build/debug/seekserve-demo/seekserve-demo fixtures/Sintel_archive.torrent

# 2. Open the stream URL in VLC
vlc "http://127.0.0.1:PORT/stream/TORRENT_ID/8?token=TOKEN"

# 3. Verify:
#    - Playback starts within seconds (streaming-first mode)
#    - Seek forward/backward responds within 1-2s (seek boost activates)
#    - Piece scheduler prioritizes hot window around playhead
```

### Manual HTTP Verification

```bash
# HEAD request
curl -I "http://127.0.0.1:PORT/stream/TORRENT_ID/8?token=TOKEN"
# -> 200 OK, Accept-Ranges: bytes, Content-Length: 77395579, Content-Type: video/mp4

# Range request (first 1KB)
curl -r 0-1023 -o /dev/null -w "%{http_code}" \
  "http://127.0.0.1:PORT/stream/TORRENT_ID/8?token=TOKEN"
# -> 206

# Invalid token
curl -I "http://127.0.0.1:PORT/stream/TORRENT_ID/8?token=wrong"
# -> 403 Forbidden
```

### Control API Verification

```bash
TOKEN="your_auth_token"
BASE="http://127.0.0.1:CONTROL_PORT"

curl -H "Authorization: Bearer $TOKEN" "$BASE/api/torrents"
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/torrents/TORRENT_ID/files"
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/torrents/TORRENT_ID/status"
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/torrents/TORRENT_ID/stream-url"
```

---

## C API (FFI)

The C API (`seekserve_c.h`) provides a stable, FFI-friendly interface:

```c
// Lifecycle
SeekServeEngine* ss_engine_create(const char* config_json);
void             ss_engine_destroy(SeekServeEngine* engine);

// Torrents
ss_error_t ss_add_torrent(engine, uri, out_id, id_len);
ss_error_t ss_remove_torrent(engine, torrent_id, delete_files);

// Files
ss_error_t ss_list_files(engine, torrent_id, &out_json);
ss_error_t ss_select_file(engine, torrent_id, file_index);
ss_error_t ss_get_stream_url(engine, torrent_id, file_index, &out_url);
ss_error_t ss_get_status(engine, torrent_id, &out_json);
ss_error_t ss_get_pieces(engine, torrent_id, &out_json);

// Server
ss_error_t ss_start_server(engine, port, &out_port);
ss_error_t ss_stop_server(engine);

// Events
ss_error_t ss_set_event_callback(engine, callback_fn, user_data);

// Memory
void ss_free_string(char* str);  // MUST call on all library-allocated strings
```

Error codes: `SS_OK` (0), `SS_ERR_INVALID_ARG`, `SS_ERR_NOT_FOUND`, `SS_ERR_METADATA_PENDING`, `SS_ERR_TIMEOUT`, `SS_ERR_IO`, `SS_ERR_ALREADY_RUNNING`, `SS_ERR_CANCELLED`.

See [docs/C_API.md](docs/C_API.md) for the full reference.

---

## REST Control API

```
POST   /api/torrents                      Add torrent (body: {"uri":"..."})
GET    /api/torrents                      List all torrents
GET    /api/torrents/{id}/files           List files in torrent
POST   /api/torrents/{id}/files/{fi}/select   Select file for streaming
GET    /api/torrents/{id}/status          Torrent status + metrics
GET    /api/torrents/{id}/stream-url      Get stream URL for selected file
DELETE /api/torrents/{id}                 Remove torrent
GET    /api/cache                         List cached files
POST   /api/server/stop                   Graceful shutdown
```

Authentication: `Authorization: Bearer <token>` header or `?token=<token>` query parameter.

All responses include `Access-Control-Allow-Origin: *` for CORS.

---

## Configuration

Engine configuration is passed as JSON to `ss_engine_create()` (C API) or via `SeekServeConfig` (Dart):

```json
{
    "save_path": "./downloads",
    "auth_token": "my_secret_token",
    "stream_port": 0,
    "control_port": 0,
    "max_storage_bytes": 0,
    "cache_db_path": "seekserve_cache.db",
    "log_level": "info",
    "enable_webtorrent": true,
    "extra_trackers": [
        "udp://tracker.opentrackr.org:1337/announce",
        "wss://tracker.webtorrent.dev"
    ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `save_path` | `./downloads` | Download directory |
| `auth_token` | (empty) | Auth token for HTTP servers |
| `stream_port` | `0` (auto) | HTTP Range server port |
| `control_port` | `0` (auto) | Control API server port |
| `max_storage_bytes` | `0` (unlimited) | Offline cache quota |
| `cache_db_path` | `seekserve_cache.db` | SQLite database path |
| `log_level` | `info` | `debug`, `info`, `warn`, `error` |
| `enable_webtorrent` | `false` | Enable WebRTC-based BitTorrent peers |
| `extra_trackers` | `[]` | Additional tracker URLs (including `wss://` for WebTorrent) |

---

## Testing

### Run All Tests

```bash
cd build/debug && ctest          # All 189 tests at once

# Or individually:
./build/debug/tests/seekserve-unit-tests          # 138 unit tests
./build/debug/tests/seekserve-integration-tests    # 32 integration tests
./build/debug/tests/seekserve-capi-tests           # 19 C API tests
```

### Test Breakdown

```
189 tests total
|
+-- Unit (138)
|   +-- ByteRangeMapper       Byte-to-piece mapping, cross-boundary, multi-file offset
|   +-- PieceAvailability     Atomic bitfield, contiguous calc, progress, reset
|   +-- MetadataCatalog       File enumeration, selection, priorities, Sintel torrent
|   +-- ByteSource            Read available/unavailable, wait, cancel, timeout
|   +-- StreamingScheduler    Deadlines, seek boost, budget, mode switching
|   +-- RangeParser           20+ cases: closed, open, suffix, malformed, edge cases
|   +-- OfflineCache          CRUD, LRU eviction, quota, persistence, Sintel files
|   +-- C API                 Lifecycle, null guards, buffer handling, full lifecycle
|
+-- Integration (32)
|   +-- SessionLifecycle      Real lt::session, metadata, file selection
|   +-- HttpRangeServer       HTTP GET/HEAD, 200/206/403/404/416, data verification
|   +-- EndToEndStream        Control API + torrent + file selection
|   +-- Stress                20-thread concurrency, 50-request seek, connection limits
|
+-- C API (19)
    +-- Engine lifecycle, add/remove torrent, list files, server start/stop
```

### Sanitizer Builds

```bash
./setup.sh asan    # AddressSanitizer
./build/asan/tests/seekserve-unit-tests

./setup.sh tsan    # ThreadSanitizer
./build/tsan/tests/seekserve-unit-tests
```

### Flutter Tests

```bash
cd flutter_seekserve
flutter test          # 15 Dart unit tests for model classes
flutter analyze       # Static analysis (0 issues)

cd flutter_seekserve_ui
flutter test          # 32 Dart unit tests for theme, atoms, utils
flutter analyze       # Static analysis (0 errors)
```

---

## Cross-Compilation

### iOS (arm64 device + arm64 simulator)

```bash
scripts/build-ios.sh
```

Builds a static XCFramework combining 22+ static libraries (libtorrent, Boost, OpenSSL, libdatachannel, seekserve) per architecture slice. Output:

```
build/ios-xcframework/seekserve.xcframework
```

### Android (arm64-v8a, armeabi-v7a, x86_64)

```bash
export ANDROID_NDK_HOME=/path/to/ndk   # or auto-detected from ~/Library/Android/sdk/ndk/
scripts/build-android.sh
```

Builds shared libraries for 3 ABIs. Output:

```
build/android-arm64-v8a/seekserve-capi/libseekserve.so
build/android-armeabi-v7a/seekserve-capi/libseekserve.so
build/android-x86_64/seekserve-capi/libseekserve.so
```

### Flutter Native Build (all-in-one)

```bash
scripts/build-flutter-natives.sh all     # iOS + Android
scripts/build-flutter-natives.sh ios     # iOS only
scripts/build-flutter-natives.sh android # Android only
```

Builds for all platforms, strips Android `.so` files (109 MB -> 6-15 MB), and copies artifacts into the Flutter plugin directories.

### Cross-Compile Notes

- **iOS**: uses vcpkg `arm64-ios` / `arm64-ios-simulator` triplets. Static library (`SEEKSERVE_CAPI_STATIC=ON`).
- **Android**: uses vcpkg `arm64-android` / `arm-neon-android` / `x64-android` triplets. Shared library.
- **Android NDK 29**: requires `ANDROID_ARM_NEON=ON` for armeabi-v7a (custom triplet `triplets/arm-neon-android.cmake`).
- **Android minSdk 28**: required because Boost.Asio uses `std::aligned_alloc` (API 28+).
- **WebTorrent ON**: both scripts pass `SEEKSERVE_ENABLE_WEBTORRENT=ON`. OpenSSL is in vcpkg.json for cross-compile.

---

## WebTorrent

SeekServe supports WebTorrent (WebRTC-based BitTorrent) via libtorrent's master branch and libdatachannel.

### How It Works

When WebTorrent is enabled:
1. libtorrent is compiled with `TORRENT_USE_RTC` define
2. The STUN server (`stun.l.google.com:19302`) is configured for NAT traversal
3. WebTorrent trackers (e.g. `wss://tracker.webtorrent.dev`) can be added via `extra_trackers`
4. The SDK can connect to both standard BitTorrent peers AND WebRTC-based browser peers

### Enabling WebTorrent

**Build time** (CMake):
```bash
-DSEEKSERVE_ENABLE_WEBTORRENT=ON    # Default when libdatachannel is detected
```

**Runtime** (config JSON):
```json
{
    "enable_webtorrent": true,
    "extra_trackers": ["wss://tracker.webtorrent.dev"]
}
```

**Dart API:**
```dart
SeekServeConfig(
  enableWebtorrent: true,
  extraTrackers: ['wss://tracker.webtorrent.dev'],
)
```

### WebTorrent Build Requirements

WebTorrent pulls additional dependencies via recursive git submodules:
- **libdatachannel** — WebRTC Data Channels
- **libjuice** — ICE / NAT traversal
- **usrsctp** — SCTP protocol
- **plog** — Logging (header-only)

These are automatically initialized by `setup.sh` (`git submodule update --init --recursive --force`).

### Disabling WebTorrent

```bash
-DSEEKSERVE_ENABLE_WEBTORRENT=OFF
```

The SDK falls back to standard BitTorrent only. Binary size decreases by ~30%.

---

## Web (WASM)

SeekServe runs in the browser by compiling the **same C++ engine** to WebAssembly via Emscripten. The native HTTP Range server is replaced by a **Service Worker** that intercepts fetch requests and serves bytes directly from the WASM module. This means the entire torrent pipeline — piece scheduling, byte source, offline cache, alert handling — is identical across native and web.

### Architecture

```
NATIVE:  Dart → dart:ffi → C API (.so/.a) → Engine → HttpRangeServer → HTTP URL → Player
WASM:    Dart → dart:js_interop → JS glue → C API (.wasm) → Engine → Service Worker → HTTP URL → <video>
```

```
+-----------------------------------------------------------------------+
|                          Browser (Chrome)                              |
|                                                                       |
|  +----------------------------+    +-------------------------------+  |
|  |  Flutter Web App (Dart)    |    |  HTML5 <video> element        |  |
|  |                            |    |  src=/seekserve-stream/{id}/{fi}  |
|  |  SeekServeClientWasm       |    +-------------+-----------------+  |
|  |   dart:js_interop          |                  |                    |
|  +--------+-------------------+                  | fetch (Range)      |
|           |                                      v                    |
|           | cwrap calls             +----------------------------+    |
|           v                         |  Service Worker            |    |
|  +----------------------------+     |  seekserve_sw.js           |    |
|  |  JS Glue Layer             |     |                            |    |
|  |  seekserve_wasm.js         |     |  intercepts /seekserve-    |    |
|  |                            |     |  stream/* URLs             |    |
|  |  cwrap() wrappers for      |<----+  sends MessageChannel to  |    |
|  |  all ss_* C API functions  |     |  main thread for bytes     |    |
|  +--------+-------------------+     |                            |    |
|           |                         |  returns 206 Partial       |    |
|           v                         |  Content to <video>        |    |
|  +----------------------------+     +----------------------------+    |
|  |  WASM Module               |                                       |
|  |  seekserve.wasm (4.5 MB)  |                                       |
|  |                            |                                       |
|  |  +----------------------+  |     +----------------------------+    |
|  |  |  SeekServeEngine     |  |     |  Emscripten pthreads       |    |
|  |  |  (same C++ code)     |  |     |  (Web Workers +            |    |
|  |  |                      |  |     |   SharedArrayBuffer)        |    |
|  |  |  SessionManager      |  |     |                            |    |
|  |  |  MetadataCatalog     |  |     |  libtorrent session thread |    |
|  |  |  PieceAvailability   |  |     |  AlertDispatcher thread    |    |
|  |  |  StreamingScheduler  |  |     |  ioc_ (tick timer) thread  |    |
|  |  |  ByteSource          |  |     +----------------------------+    |
|  |  |  OfflineCache        |  |                                       |
|  |  +----------+-----------+  |                                       |
|  |             |              |                                       |
|  +-------------|--+-----------+                                       |
|                |  |                                                    |
|                v  v                                                    |
|  +----------------------------+     +----------------------------+    |
|  |  datachannel-wasm          |     |  WebSocket (ws://)         |    |
|  |  (browser-native WebRTC)   |     |  tracker connection        |    |
|  |                            |     |  (wasm_websocket_tracker)  |    |
|  |  RTCPeerConnection API     |     +-------------+--------------+    |
|  |  RTCDataChannel API        |                   |                   |
|  +--------+-------------------+                   |                   |
|           |                                       |                   |
+-----------+---------------------------------------+-------------------+
            |                                       |
            v                                       v
     WebRTC Data Channels                   WebSocket Tracker
     (peer-to-peer BitTorrent)              (peer discovery)
     STUN: stun.l.google.com:19302          ws://tracker.example.com
```

### Native vs Web — Differences and Why

The C++ engine is the same binary. Everything around it changes because browsers expose a different set of primitives than an OS process.

```
                      NATIVE (iOS/Android)                      WEB (WASM)
                      ──────────────────                        ──────────

  ┌─────────┐         dart:ffi → C API (.so/.a)                dart:js_interop → JS glue → cwrap
  │ Binding │
  └─────────┘         WHY: dart:ffi links a shared library     WHY: no .so on the web — Emscripten
                      directly into the Dart process            compiles to .wasm, called via cwrap()

  ┌─────────┐         TCP/UDP sockets                          WebRTC Data Channels
  │ Network │         standard BitTorrent peers                 + WebSocket trackers (ws://)
  └─────────┘
                      WHY: OS gives the process raw             WHY: browsers forbid TCP/UDP sockets.
                      socket access                             WebRTC is the only peer-to-peer path

  ┌─────────┐         libdatachannel (C++)                     datachannel-wasm (JS bridge)
  │ WebRTC  │         full DTLS/SCTP stack in native code      thin wrapper over browser RTCPeerConnection
  └─────────┘
                      WHY: native process links OpenSSL         WHY: on WASM there is no OpenSSL —
                      and handles DTLS itself                   the browser already speaks DTLS/SCTP

  ┌─────────┐         HttpRangeServer (Beast, loopback TCP)    Service Worker (seekserve_sw.js)
  │ HTTP    │         real HTTP server on 127.0.0.1:PORT       intercepts fetch → MessageChannel → WASM
  │ Range   │
  └─────────┘         WHY: media_kit/VLC fetches a real        WHY: no TCP listen in browser.
                      HTTP URL via localhost                    <video>.src triggers a fetch event that
                                                               the SW intercepts and serves from WASM

  ┌─────────┐         pthreads (native OS threads)             Emscripten pthreads (Web Workers
  │ Threads │         4 domains: libtorrent, alert,            + SharedArrayBuffer)
  │         │         io_context, caller                       + byte reader JS Worker
  └─────────┘
                      WHY: OS provides real threads             WHY: browser threads = Web Workers.
                                                               SharedArrayBuffer for shared memory.
                                                               COOP/COEP headers required

  ┌─────────┐         real filesystem + SQLite WAL             Emscripten MEMFS (RAM)
  │ Storage │         LRU eviction, persists across sessions   lost on page refresh
  └─────────┘
                      WHY: the app has a writable               WHY: no real filesystem. MEMFS is an
                      document directory                        in-memory emulation. (IDBFS for
                                                               persistence is possible but not wired)

  ┌─────────┐         media_kit (libmpv) — SsVideoPlayer      HTML5 <video> — SsVideoPlayerWeb
  │ Player  │         SsSeekControls (slider, timestamps)      native browser controls
  └─────────┘
                      WHY: OS process can embed mpv             WHY: no native video decoder in WASM.
                      via platform view                        Browser's <video> already decodes MP4,
                                                               WebM, etc. natively

  ┌─────────┐         ss_read_bytes(engine, id, fi,            ss_read_bytes_wasm(engine, id, fi,
  │ uint64  │           offset, length, buf, out_n)              off_lo, off_hi, len_lo, len_hi,
  │ ABI     │                                                    buf, out_n)
  └─────────┘
                      WHY: 64-bit pointers, uint64_t            WHY: WASM is 32-bit. uint64_t VALUE
                      passes in one register                    params are split into two i32s by the
                                                               ABI. cwrap('number') only passes one
                                                               → all subsequent params shift → crash.
                                                               Wrapper with explicit (lo, hi) pairs
```

**What stays identical across both:** `SeekServeEngine`, `TorrentSessionManager`, `MetadataCatalog`, `PieceAvailabilityIndex`, `StreamingScheduler`, `ByteRangeMapper`, `ByteSource`, `OfflineCacheManager`, `AlertDispatcher` — all the same C++ compiled once for ARM (mobile) and once for WASM (web). The Dart UI layer (`flutter_seekserve_ui`) is also 100% shared; only 5 conditional-import split points handle the platform boundary (see [Conditional Import System](#conditional-import-system)).

### How It Works

1. The WASM module (`seekserve.js` + `seekserve.wasm`) is loaded as a `<script>` tag
2. A JS glue layer (`seekserve_wasm.js`) wraps all C API functions for Dart via `dart:js_interop`
3. A byte reader Web Worker (`seekserve_reader.js`) handles blocking `ss_read_bytes()` calls off the main thread
4. A Service Worker (`seekserve_sw.js`) intercepts fetch requests matching `/seekserve-stream/*`
5. When the `<video>` element requests a byte range, the Service Worker asks the main thread, which calls into the WASM module, and returns a `206 Partial Content` response
6. Dart code uses **conditional imports** (`dart.library.js_interop`) to automatically switch between FFI (native) and JS interop (web)

### WASM Thread Model

On native, the engine runs 4 thread domains (see [Thread Model](#thread-model)). On WASM, each pthread is a **Web Worker** with `SharedArrayBuffer` for shared memory. The mapping:

```
+-----------------------------------------------------------------------+
|                        Browser Thread Layout                           |
+-----------------------------------------------------------------------+
|                                                                        |
|  [Main Thread]  (browser UI thread)                                    |
|      - Flutter Dart app (compiled to JS)                               |
|      - JS glue layer (seekserve_wasm.js)                               |
|      - Service Worker MessageChannel handler                           |
|      - MUST NOT call blocking WASM functions (deadlock)                |
|                                                                        |
|  [Web Worker 1]  Emscripten main → PROXY_TO_PTHREAD                   |
|      - C++ main() runs here (not on browser main thread)               |
|      - ss_create_engine(), ss_add_torrent(), etc.                      |
|      - cwrap() calls from JS proxy to this worker                      |
|                                                                        |
|  [Web Worker 2]  libtorrent session                                    |
|      - network I/O (WebRTC data channels via datachannel-wasm)         |
|      - piece management, peer protocol                                 |
|      - WebSocket tracker connections                                   |
|                                                                        |
|  [Web Worker 3]  AlertDispatcher                                       |
|      - pop_alerts() loop, 100ms poll                                   |
|      - fires piece_finished, metadata_received, etc.                   |
|      - posts deferred work to ioc_ via boost::asio::post()            |
|                                                                        |
|  [Web Worker 4]  io_context (tick timer)                               |
|      - 1s periodic tick (status caching, scheduler)                    |
|      - deferred metadata/piece work from AlertDispatcher               |
|      - auto-started in constructor (not start_server)                  |
|                                                                        |
|  [Web Worker 5]  Byte reader (seekserve_reader.js)                     |
|      - dedicated JS worker for blocking ss_read_bytes_wasm()           |
|      - Service Worker → Main Thread → Reader Worker → WASM            |
|      - avoids blocking the main thread during video playback           |
|                                                                        |
+-----------------------------------------------------------------------+

Key differences from native:
  - No HttpRangeServer (replaced by Service Worker)
  - No socket I/O (replaced by WebRTC DataChannel + WebSocket)
  - Status caching: handle.status() deadlocks from main thread
    → cached via state_update_alert, read from cached_statuses_
  - id_from_handle(): safe handle→ID lookup without sync_call
  - uint64_t ABI: WASM is 32-bit, uint64_t VALUE params split
    into two i32s → ss_read_bytes_wasm() with explicit (lo, hi)
```

### Service Worker Streaming Flow

```
<video src="/seekserve-stream/{id}/{fi}">
    |
    | fetch event (Range: bytes=X-Y)
    v
+-------------------------------+
|  Service Worker               |
|  seekserve_sw.js              |
|                               |
|  1. parse Range header        |
|  2. compute chunk offset/len  |
+-------+-----------------------+
        |
        | MessageChannel postMessage
        | {type:'seekserve-readBytes', torrentId, fileIndex, offset, length}
        v
+-------------------------------+
|  Main Thread (Dart)           |
|  client_wasm.dart             |
|  _handleSwReadBytes()         |
|                               |
|  calls seekServeWasm          |
|  .readBytes(engine, ...)      |
+-------+-----------------------+
        |
        | cwrap → ss_read_bytes_wasm()
        v
+-------------------------------+
|  WASM Module                  |
|  ss_read_bytes_wasm()         |
|                               |
|  ByteSource::read()           |
|    waits for pieces (cv)      |
|    reads from MEMFS           |
|    returns byte[]             |
+-------+-----------------------+
        |
        | Uint8Array via MessagePort
        v
+-------------------------------+
|  Service Worker               |
|                               |
|  new Response(body, {         |
|    status: 206,               |
|    headers: {                 |
|      Content-Range,           |
|      Content-Length,           |
|      Content-Type,            |
|      Accept-Ranges: bytes     |
|    }                          |
|  })                           |
+-------------------------------+
        |
        | 206 Partial Content
        v
    <video> plays
```

### WebTorrent Browser Pipeline

```
+-------------------+          +--------------------+
|  WebSocket        |          |  Native Seeder     |
|  Tracker          |          |  (libdatachannel)  |
|  ws://tracker:80  |          |                    |
+--------+----------+          +---------+----------+
         |                               |
         | announce (offer SDP)          | announce (answer SDP)
         v                               v
+------------------------------------------------------+
|                    SDP Exchange                        |
|  Browser sends offer → tracker → seeder gets offer   |
|  Seeder sends answer → tracker → browser gets answer |
+------------------------------------------------------+
         |                               |
         v                               v
+-------------------+          +--------------------+
|  Browser Peer     |  WebRTC  |  Native Peer       |
|  datachannel-wasm |<-------->|  libdatachannel    |
|                   |  Data    |                    |
|  RTCPeerConnection|  Channel |  RTCPeerConnection |
+--------+----------+          +--------------------+
         |
         | BitTorrent protocol over DataChannel
         v
+------------------------------------------------------+
|  libtorrent (WASM)                                    |
|                                                       |
|  piece_finished_alert → PieceAvailabilityIndex        |
|  StreamingScheduler → set_piece_deadline()            |
|  ByteSource::read() → pieces from MEMFS              |
|                        → Service Worker → <video>     |
+------------------------------------------------------+
```

### Prerequisites

- **Docker** — the WASM build uses an Emscripten Docker image (`emscripten/emsdk`)
- **Flutter** >= 3.19 with web support enabled
- **Modern browser** with `SharedArrayBuffer` support (Chrome 119+, Firefox 120+)

### Build Steps

#### Step 1: Build the WASM Module (Docker)

```bash
docker/build-wasm.sh
```

This uses the `emscripten/emsdk:3.1.56` Docker image to cross-compile the C++ SDK to WebAssembly. Output:

```
build/wasm-out/
  seekserve.js          # Emscripten JS loader (~147 KB)
  seekserve.wasm        # Compiled WebAssembly module (~4.2 MB)
  seekserve.worker.js   # Emscripten pthread worker (~2.7 KB)
```

#### Step 2: Deploy WASM Artifacts to Flutter App

```bash
scripts/deploy-wasm-to-app.sh
```

This copies the WASM build output and JS glue files into `flutter_seekserve_app/web/`:

```
flutter_seekserve_app/web/
  seekserve.js           # Emscripten output
  seekserve.wasm         # WASM binary
  seekserve.worker.js    # pthread worker
  seekserve_wasm.js      # JS glue (Dart ↔ WASM bridge)
  seekserve_reader.js    # Byte reader Web Worker
  seekserve_sw.js        # Service Worker (HTTP Range proxy)
```

#### Step 3: Build the Flutter Web App

```bash
cd flutter_seekserve_app
flutter build web
```

#### Step 4: Run in Chrome

```bash
cd flutter_seekserve_app
flutter run -d chrome \
  --web-header=Cross-Origin-Opener-Policy=same-origin \
  --web-header=Cross-Origin-Embedder-Policy=require-corp
```

The `COOP/COEP` headers are **required** for `SharedArrayBuffer`, which Emscripten pthreads depend on. These headers are also set as `<meta>` tags in `index.html`, but some browsers require them as actual HTTP headers.

### Conditional Import System

The codebase uses Dart's conditional imports to dispatch between native and web at compile time:

| Package | File | Native | Web |
|---------|------|--------|-----|
| `flutter_seekserve` | `seekserve_client.dart` | `client_native.dart` (dart:ffi) | `client_wasm.dart` (dart:js_interop) |
| `flutter_seekserve_ui` | `ss_video_player.dart` | `ss_video_player_native.dart` (media_kit) | `ss_video_player_web.dart` (HTML5 `<video>`) |
| `flutter_seekserve_ui` | `ss_seek_controls.dart` | Full media_kit controls | Stub (not available on web) |
| `flutter_seekserve_ui` | `health_check_*.dart` | `dart:io` HttpClient | No-op (SW always "online") |
| `flutter_seekserve_app` | `init_*.dart` | MediaKit init + path_provider | No-op + MEMFS config |

Pattern used in each split:
```dart
export 'thing_stub.dart'
    if (dart.library.io) 'thing_native.dart'
    if (dart.library.js_interop) 'thing_web.dart';
```

### COOP/COEP Headers

`SharedArrayBuffer` (required by Emscripten pthreads) needs two HTTP headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These are set in `flutter_seekserve_app/web/index.html` as meta tags. When deploying to production, also configure your web server to send these as actual HTTP response headers.

**Note:** COEP `require-corp` means all sub-resources must either be same-origin or include a `Cross-Origin-Resource-Policy` header. This may affect loading third-party resources (CDN images, fonts, etc.).

### Service Worker Details

The Service Worker (`seekserve_sw.js`) acts as a virtual HTTP Range server:

1. Intercepts `fetch` events matching `/seekserve-stream/{torrentId}/{fileIndex}`
2. Parses the `Range` header (same logic as the C++ `HttpRangeServer`)
3. Sends a `MessageChannel` request to the main thread window
4. The main thread delegates to the byte reader Worker, which calls `ss_read_bytes()` on the WASM module
5. Returns a `Response` with `status: 206`, `Content-Range`, and the requested bytes

Supported responses: `200 OK` (full file), `206 Partial Content` (range request), `HEAD` (size query).

### Quick Reference

| Scenario | Command |
|----------|---------|
| Build WASM module | `docker/build-wasm.sh` |
| Deploy to Flutter web | `scripts/deploy-wasm-to-app.sh` |
| Build Flutter web app | `cd flutter_seekserve_app && flutter build web` |
| Run in Chrome (dev) | `flutter run -d chrome --web-header=Cross-Origin-Opener-Policy=same-origin --web-header=Cross-Origin-Embedder-Policy=require-corp` |
| Run Dart tests on Chrome | `cd flutter_seekserve && flutter test --platform chrome` |

### Current Limitations

- **WebTorrent peers only** — browser WASM connects via WebRTC data channels, not standard TCP/UDP BitTorrent. Seeds must have WebTorrent enabled to be reachable.
- **MEMFS storage** — all downloaded data is in memory (lost on page refresh); IDBFS persistence is not yet wired
- **No `SsSeekControls`** — the `media_kit` `Player` type doesn't exist on web; the HTML5 video player has its own built-in controls
- **COOP/COEP restrictions** — `SharedArrayBuffer` requires strict cross-origin isolation, which may block some third-party resources
- **Binary size** — the WASM module is ~4-5 MB; consider lazy loading and `-Oz` optimization for production

### Local E2E WebTorrent Test

Fully local test of the complete streaming pipeline: WebSocket tracker + native seeder + WASM browser client downloading via WebRTC + video playback in the Flutter web app. **No external network required** — all traffic stays on localhost.

```
Tracker WS (:8000)
    ↕                    ↕
Native seeder          Flutter Web App (Chrome)
(libdatachannel)  ←WebRTC→  (datachannel-wasm/WASM)
seeds video            downloads pieces → StreamingScheduler → SW → <video>
```

#### Prerequisites

| # | What | Command |
|---|------|---------|
| 1 | **Video file** (any MP4, e.g. Big Buck Bunny 263 MB) | Place in `downloads/bbb_sunflower_1080p_30fps_normal.mp4` |
| 2 | **Native C++ build** (seeder binary) | `./setup.sh debug` |
| 3 | **WASM build** (seekserve.wasm) | `docker/build-wasm.sh && scripts/deploy-wasm-to-app.sh` |
| 4 | **Flutter web app** | `cd flutter_seekserve_app && flutter build web` |
| 5 | **Node.js + npm** | `npm install ws` (CDP client) |
| 6 | **Generate .torrent** (once) | `python3 scripts/create_test_torrent.py` |

After step 6, the torrent file is at `fixtures/local_test/bbb_sunflower.torrent` and the script prints the infohash + magnet URI.

#### Option A: One command (recommended)

```bash
./scripts/run_local_e2e.sh
```

Starts tracker, seeder, web server, and Chrome. Then **waits** — you test manually in the browser. Press **Ctrl+C** to stop everything.

Flags:

| Flag | Description |
|------|-------------|
| `--build` | Build native + Flutter web before starting |
| `--e2e` | Run automated CDP test (10 checks) instead of waiting |
| `--screenshots` | Take PNG screenshots after E2E test (implies `--e2e`) |

Examples:

```bash
# Manual testing (default): starts services, opens Chrome, waits
./scripts/run_local_e2e.sh

# Build everything first, then manual testing
./scripts/run_local_e2e.sh --build

# Automated E2E test with screenshots
./scripts/run_local_e2e.sh --e2e --screenshots
```

Screenshots are saved in `/tmp/seekserve-screenshots/`.

#### Option B: Manual (5 terminals)

Open 5 terminal windows:

**Terminal 1 — WebSocket tracker**

```bash
npx bittorrent-tracker --ws --ws-port 8000
```

**Terminal 2 — Native seeder**

```bash
./build/debug/tools/seekserve-seed \
  fixtures/local_test/bbb_sunflower.torrent \
  downloads/ \
  ws://localhost:8000/announce
```

Wait for `Seeding...` and status updates every 5 seconds.

**Terminal 3 — Web server (COOP/COEP headers)**

```bash
python3 serve_coop.py 8080 flutter_seekserve_app/build/web
```

The COOP/COEP headers are required for `SharedArrayBuffer` (Emscripten pthreads).

**Terminal 4 — Chrome**

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-e2e-local \
  --no-first-run \
  http://localhost:8080/
```

The app loads, WASM initializes (~5s), engine starts. Check the Console (F12) for `[SeekServe Dart]` logs.

**Terminal 5 — CDP test (automated)**

```bash
node scripts/e2e/test_local_streaming_e2e.mjs \
  "magnet:?xt=urn:btih:31ed292ddb90f45afcbf3b4c9009b84aacee5de6&dn=bbb_sunflower_1080p_30fps_normal.mp4&tr=ws://127.0.0.1:8000/announce"
```

Or for screenshots only:

```bash
node scripts/e2e/take_screenshots.mjs
```

#### Option C: Manual browser test (no CDP, no Node)

After starting terminals 1-4 above, open Chrome DevTools (F12) and paste in the Console:

**1. Add torrent:**

```javascript
SeekServeWasm.addTorrent(
  window.__seekserveEngine,
  'magnet:?xt=urn:btih:31ed292ddb90f45afcbf3b4c9009b84aacee5de6&dn=bbb_sunflower_1080p_30fps_normal.mp4&tr=ws://localhost:8000/announce'
)
```

**2. Monitor download progress:**

```javascript
setInterval(() => {
  const r = SeekServeWasm.getStatus(
    window.__seekserveEngine,
    '31ed292ddb90f45afcbf3b4c9009b84aacee5de6'
  );
  const s = JSON.parse(r.json);
  console.log(
    `${(s.progress * 100).toFixed(1)}% ` +
    `peers=${s.num_peers} ` +
    `dl=${(s.download_rate / 1024).toFixed(0)} KB/s ` +
    `meta=${s.has_metadata}`
  );
}, 3000);
```

Wait until you see `peers=1` and `progress > 3%`.

**3. Select file and stream video:**

```javascript
const ID = '31ed292ddb90f45afcbf3b4c9009b84aacee5de6';
SeekServeWasm.selectFile(window.__seekserveEngine, ID, 0);
const url = SeekServeWasm.getStreamUrl(window.__seekserveEngine, ID, 0);

const v = document.createElement('video');
v.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background:black;object-fit:contain;';
v.src = url.url;
v.autoplay = true;
v.muted = true;
v.controls = true;
document.body.appendChild(v);
```

The video should start playing within a few seconds. To remove it: `document.querySelector('video').remove()`.

#### What It Tests

| Step | What | Pass criteria |
|------|------|---------------|
| 1. WASM init | Module loads in Flutter app | `SeekServeWasm.module()` exists |
| 2. Engine | Flutter app creates engine with WebTorrent | `window.__seekserveEngine > 0` |
| 3. Service Worker | SW active and controlling page | `navigator.serviceWorker.controller` not null |
| 4. Add torrent | Magnet URI → engine | `torrentId` returned |
| 5. Metadata | Received from seeder via WS tracker → WebRTC | `has_metadata: true` |
| 6. Download | Pieces arrive via WebRTC data channel | `readBytes(offset=0)` returns data |
| 7. SW HEAD | Service Worker intercepts fetch | `200 OK` + `Accept-Ranges: bytes` |
| 8. SW Range | Byte-range streaming via SW | `206 Partial Content` with body |
| 9. Video | HTML5 `<video>` plays from SW stream | `canplay` or `loadedmetadata` event |
| 10. Playback | Video rendering frames | `currentTime > 0` |

#### Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `SharedArrayBuffer not available` | Missing COOP/COEP headers | Use `serve_coop.py`, not `python3 -m http.server` |
| `peers=0`, no download | Seeder or tracker not running | Check terminals 1-2 are up, seeder shows `Seeding...` |
| `readBytes err=-4` | Pieces at file start not yet downloaded | Wait longer, StreamingScheduler prioritizes start pieces |
| WASM not loading | Stale service worker cache | Clear SW: DevTools → Application → Service Workers → Unregister, then hard refresh |
| Video black / no playback | Offset 0 pieces not ready | Wait for `readBytes(offset=0)` to return data before creating `<video>` |

---

## Documentation Index

| Document | Description |
|----------|-------------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module overview, data flow, thread model, design decisions |
| [docs/HTTP_RANGE_SPEC.md](docs/HTTP_RANGE_SPEC.md) | HTTP endpoint format, Range handling (RFC 7233), response codes, MIME types |
| [docs/SCHEDULER_POLICY.md](docs/SCHEDULER_POLICY.md) | Hot window, lookahead, seek boost, deadline budget, mode switching |
| [docs/STORAGE_POLICY.md](docs/STORAGE_POLICY.md) | Piece storage, file selection, SQLite cache, LRU eviction, quota |
| [docs/SECURITY.md](docs/SECURITY.md) | Loopback binding, token auth, connection limits, logging safety |
| [docs/C_API.md](docs/C_API.md) | C function reference, error codes, config JSON, memory management |

---

## Dependencies

| Dependency | Source | Purpose |
|------------|--------|---------|
| [libtorrent](https://github.com/arvidn/libtorrent) | Git submodule (master) | BitTorrent protocol, piece management, WebTorrent |
| [libdatachannel](https://github.com/paullouisageneau/libdatachannel) | Nested submodule (via libtorrent) | WebRTC Data Channels for WebTorrent (native) |
| [datachannel-wasm](https://github.com/paullouisageneau/datachannel-wasm) | Git submodule | WebRTC Data Channels for WebTorrent (WASM/browser) |
| Boost (Asio, Beast, JSON, System) | vcpkg | HTTP server, async I/O, JSON parsing |
| [OpenSSL](https://www.openssl.org/) | vcpkg | TLS for libtorrent + libdatachannel |
| [nlohmann/json](https://github.com/nlohmann/json) | vcpkg | JSON serialization (C++ side) |
| [spdlog](https://github.com/gabime/spdlog) | vcpkg | Structured logging |
| [SQLite3](https://www.sqlite.org/) | vcpkg | Offline cache persistence |
| [Google Test](https://github.com/google/googletest) | vcpkg | Unit and integration testing |
| [media_kit](https://github.com/media-kit/media-kit) | pub.dev (UI + app) | Video player for Flutter (libmpv-based) |
| [path_provider](https://pub.dev/packages/path_provider) | pub.dev (app) | Platform-specific document directory |

---

## License

SeekServe is proprietary software. All rights reserved.

Test torrent (`fixtures/Sintel_archive.torrent`) is [Sintel](https://durian.blender.org/) by the Blender Foundation, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
