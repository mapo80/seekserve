import 'dart:async';

import 'models/file_info.dart';
import 'models/pieces_info.dart';
import 'models/torrent_status.dart';
import 'models/seekserve_config.dart';
import 'models/seekserve_event.dart';

import 'client_stub.dart'
    if (dart.library.ffi) 'client_native.dart'
    if (dart.library.js_interop) 'client_wasm.dart';

/// High-level Dart API for the SeekServe torrent streaming engine.
///
/// On native platforms (iOS/Android/desktop), the implementation uses dart:ffi.
/// On web, it uses dart:js_interop to call the WASM-compiled C API.
abstract class SeekServeClient {
  factory SeekServeClient({SeekServeConfig? config}) =>
      createClient(config: config);

  /// Async initialisation hook (must be awaited before calling other methods).
  ///
  /// On web, this loads the WASM module and creates the C engine.
  /// On native, this is a no-op.
  Future<void> initialize();

  /// Stream of events from the engine (metadata, file completions, errors).
  Stream<SeekServeEvent> get events;

  /// Starts the streaming server. Returns the assigned port (0 on web).
  Future<int> startServer({int port = 0});

  /// Stops the streaming server.
  void stopServer();

  /// Adds a torrent by magnet URI or .torrent file path. Returns the torrent ID.
  String addTorrent(String uri);

  /// Returns the list of active torrent IDs.
  List<String> listTorrents();

  /// Removes a torrent. Optionally deletes downloaded files.
  void removeTorrent(String torrentId, {bool deleteFiles = false});

  /// Lists all files in the torrent. Requires metadata.
  List<FileInfo> listFiles(String torrentId);

  /// Selects a file for streaming.
  void selectFile(String torrentId, int fileIndex);

  /// Returns the stream URL for a file. On native: HTTP URL. On web: SW-intercepted URL.
  String getStreamUrl(String torrentId, int fileIndex);

  /// Gets the current status of a torrent.
  TorrentStatus getStatus(String torrentId);

  /// Gets piece-level status: bitfield + per-file ranges.
  /// Returns null if metadata is not yet available.
  PiecesInfo? getPieces(String torrentId);

  /// Releases all resources.
  void dispose();
}
