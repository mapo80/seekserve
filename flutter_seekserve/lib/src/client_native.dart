import 'dart:async';
import 'dart:convert';
import 'dart:developer' as dev;
import 'dart:ffi';

import 'package:ffi/ffi.dart';

import 'bindings_generated.dart';
import 'native_library.dart';
import 'seekserve_client.dart';
import 'seekserve_exception.dart';
import 'models/file_info.dart';
import 'models/pieces_info.dart';
import 'models/torrent_status.dart';
import 'models/seekserve_config.dart';
import 'models/seekserve_event.dart';

/// Top-level factory for conditional import.
SeekServeClient createClient({SeekServeConfig? config}) =>
    SeekServeClientNative(config: config);

/// Native (dart:ffi) implementation of [SeekServeClient].
class SeekServeClientNative implements SeekServeClient {
  final SeekServeBindings _bindings;
  late final Pointer<SeekServeEngine> _engine;
  bool _disposed = false;

  final StreamController<SeekServeEvent> _eventController =
      StreamController<SeekServeEvent>.broadcast();

  NativeCallable<ss_event_callback_tFunction>? _nativeCallback;

  SeekServeClientNative({SeekServeConfig? config})
      : _bindings = nativeBindings {
    final configJson = config?.toJsonString() ?? '{}';
    final configPtr = configJson.toNativeUtf8().cast<Char>();
    try {
      _engine = _bindings.ss_engine_create(configPtr);
      if (_engine == nullptr) {
        throw const SeekServeException(-1, 'Failed to create engine');
      }
    } finally {
      calloc.free(configPtr);
    }
    _setupEventCallback();
  }

  @override
  Future<void> initialize() async {}

  @override
  Stream<SeekServeEvent> get events => _eventController.stream;

  @override
  Future<int> startServer({int port = 0}) async {
    _ensureNotDisposed();
    final outPort = calloc<Uint16>();
    try {
      final err = _bindings.ss_start_server(_engine, port, outPort);
      checkError(err);
      return outPort.value;
    } finally {
      calloc.free(outPort);
    }
  }

  @override
  void stopServer() {
    _ensureNotDisposed();
    final err = _bindings.ss_stop_server(_engine);
    checkError(err);
  }

  @override
  String addTorrent(String uri) {
    _ensureNotDisposed();
    final uriPtr = uri.toNativeUtf8().cast<Char>();
    final outId = calloc<Char>(64);
    try {
      final err = _bindings.ss_add_torrent(_engine, uriPtr, outId, 64);
      checkError(err);
      return outId.cast<Utf8>().toDartString();
    } finally {
      calloc.free(uriPtr);
      calloc.free(outId);
    }
  }

  @override
  List<String> listTorrents() {
    _ensureNotDisposed();
    final outJson = calloc<Pointer<Char>>();
    try {
      final err = _bindings.ss_list_torrents(_engine, outJson);
      checkError(err);
      final jsonStr = outJson.value.cast<Utf8>().toDartString();
      final decoded = jsonDecode(jsonStr) as List<dynamic>;
      return decoded.cast<String>();
    } finally {
      if (outJson.value != nullptr) {
        _bindings.ss_free_string(outJson.value);
      }
      calloc.free(outJson);
    }
  }

  @override
  void removeTorrent(String torrentId, {bool deleteFiles = false}) {
    _ensureNotDisposed();
    final idPtr = torrentId.toNativeUtf8().cast<Char>();
    try {
      final err = _bindings.ss_remove_torrent(_engine, idPtr, deleteFiles);
      checkError(err);
    } finally {
      calloc.free(idPtr);
    }
  }

  @override
  List<FileInfo> listFiles(String torrentId) {
    _ensureNotDisposed();
    final idPtr = torrentId.toNativeUtf8().cast<Char>();
    final outJson = calloc<Pointer<Char>>();
    try {
      final err = _bindings.ss_list_files(_engine, idPtr, outJson);
      checkError(err);
      final jsonStr = outJson.value.cast<Utf8>().toDartString();
      final decoded = jsonDecode(jsonStr);
      final List<dynamic> list;
      if (decoded is Map<String, dynamic> && decoded.containsKey('files')) {
        list = decoded['files'] as List<dynamic>;
      } else if (decoded is List<dynamic>) {
        list = decoded;
      } else {
        return [];
      }
      return list
          .map((e) => FileInfo.fromJson(e as Map<String, dynamic>))
          .toList();
    } finally {
      if (outJson.value != nullptr) {
        _bindings.ss_free_string(outJson.value);
      }
      calloc.free(outJson);
      calloc.free(idPtr);
    }
  }

  @override
  void selectFile(String torrentId, int fileIndex) {
    _ensureNotDisposed();
    final idPtr = torrentId.toNativeUtf8().cast<Char>();
    try {
      final err = _bindings.ss_select_file(_engine, idPtr, fileIndex);
      checkError(err);
    } finally {
      calloc.free(idPtr);
    }
  }

  @override
  String getStreamUrl(String torrentId, int fileIndex) {
    _ensureNotDisposed();
    final idPtr = torrentId.toNativeUtf8().cast<Char>();
    final outUrl = calloc<Pointer<Char>>();
    try {
      final err =
          _bindings.ss_get_stream_url(_engine, idPtr, fileIndex, outUrl);
      checkError(err);
      return outUrl.value.cast<Utf8>().toDartString();
    } finally {
      if (outUrl.value != nullptr) {
        _bindings.ss_free_string(outUrl.value);
      }
      calloc.free(outUrl);
      calloc.free(idPtr);
    }
  }

  @override
  TorrentStatus getStatus(String torrentId) {
    _ensureNotDisposed();
    final idPtr = torrentId.toNativeUtf8().cast<Char>();
    final outJson = calloc<Pointer<Char>>();
    try {
      final err = _bindings.ss_get_status(_engine, idPtr, outJson);
      checkError(err);
      final jsonStr = outJson.value.cast<Utf8>().toDartString();
      final map = jsonDecode(jsonStr) as Map<String, dynamic>;
      return TorrentStatus.fromJson(map);
    } finally {
      if (outJson.value != nullptr) {
        _bindings.ss_free_string(outJson.value);
      }
      calloc.free(outJson);
      calloc.free(idPtr);
    }
  }

  @override
  PiecesInfo? getPieces(String torrentId) {
    _ensureNotDisposed();
    final idPtr = torrentId.toNativeUtf8().cast<Char>();
    final outJson = calloc<Pointer<Char>>();
    try {
      final err = _bindings.ss_get_pieces(_engine, idPtr, outJson);
      checkError(err);
      final jsonStr = outJson.value.cast<Utf8>().toDartString();
      final map = jsonDecode(jsonStr) as Map<String, dynamic>;
      if (map.containsKey('error')) return null;
      return PiecesInfo.fromJson(map);
    } finally {
      if (outJson.value != nullptr) {
        _bindings.ss_free_string(outJson.value);
      }
      calloc.free(outJson);
      calloc.free(idPtr);
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;

    _nativeCallback?.close();
    _nativeCallback = null;
    _eventController.close();
    _bindings.ss_engine_destroy(_engine);
  }

  void _setupEventCallback() {
    _nativeCallback = NativeCallable<ss_event_callback_tFunction>.listener(
      _handleNativeEvent,
    );

    final err = _bindings.ss_set_event_callback(
      _engine,
      _nativeCallback!.nativeFunction,
      nullptr,
    );
    checkError(err);
  }

  void _handleNativeEvent(Pointer<Char> eventJsonPtr, Pointer<Void> userData) {
    if (_disposed) return;
    try {
      final jsonStr = eventJsonPtr.cast<Utf8>().toDartString();
      if (jsonStr.isEmpty) return;
      dev.log('SeekServe event: $jsonStr', name: 'SeekServe');
      final map = jsonDecode(jsonStr) as Map<String, dynamic>;
      final event = SeekServeEvent.fromJson(map);
      _eventController.add(event);
    } catch (e) {
      dev.log('SeekServe event parse error: $e', name: 'SeekServe');
    }
  }

  void _ensureNotDisposed() {
    if (_disposed) {
      throw StateError('SeekServeClient has been disposed');
    }
  }
}
