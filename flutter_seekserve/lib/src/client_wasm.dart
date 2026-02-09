import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

import 'seekserve_client.dart';
import 'seekserve_exception.dart';
import 'wasm_interop.dart';
import 'models/file_info.dart';
import 'models/torrent_status.dart';
import 'models/seekserve_config.dart';
import 'models/seekserve_event.dart';

/// Top-level factory for conditional import.
SeekServeClient createClient({SeekServeConfig? config}) =>
    SeekServeClientWasm(config: config);

/// WASM (dart:js_interop) implementation of [SeekServeClient].
///
/// Calls the C API through the JS glue layer (seekserve_wasm.js) which wraps
/// the Emscripten-compiled WASM module.
class SeekServeClientWasm implements SeekServeClient {
  late final JSNumber _engine;
  bool _disposed = false;
  final StreamController<SeekServeEvent> _eventController =
      StreamController<SeekServeEvent>.broadcast();

  Timer? _pollTimer;

  SeekServeClientWasm({SeekServeConfig? config}) {
    final configJson = config?.toJsonString() ?? '{}';
    _engine = seekServeWasm.engineCreate(configJson.toJS);
  }

  @override
  Stream<SeekServeEvent> get events => _eventController.stream;

  @override
  int startServer({int port = 0}) {
    _ensureNotDisposed();
    final result =
        seekServeWasm.startServer(_engine, port.toJS) as JsPortResult;
    final err = result.error.toDartInt;
    checkError(err);

    // Register Service Worker
    _registerServiceWorker();

    // Set up message listener for Service Worker byte requests
    _setupSwMessageHandler();

    // Start polling for events (metadata changes, etc.)
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(milliseconds: 500), (_) {
      _pollEvents();
    });

    return result.port.toDartInt;
  }

  @override
  void stopServer() {
    _ensureNotDisposed();
    _pollTimer?.cancel();
    _pollTimer = null;
    final err = seekServeWasm.stopServer(_engine);
    checkError(err.toDartInt);
  }

  @override
  String addTorrent(String uri) {
    _ensureNotDisposed();
    final result =
        seekServeWasm.addTorrent(_engine, uri.toJS) as JsStringResult;
    final err = result.error.toDartInt;
    checkError(err);
    return result.id!.toDart;
  }

  @override
  List<String> listTorrents() {
    _ensureNotDisposed();
    final result = seekServeWasm.listTorrents(_engine) as JsStringResult;
    final err = result.error.toDartInt;
    checkError(err);
    final jsonStr = result.json?.toDart;
    if (jsonStr == null) return [];
    final decoded = jsonDecode(jsonStr) as List<dynamic>;
    return decoded.cast<String>();
  }

  @override
  void removeTorrent(String torrentId, {bool deleteFiles = false}) {
    _ensureNotDisposed();
    final err = seekServeWasm.removeTorrent(
        _engine, torrentId.toJS, deleteFiles.toJS);
    checkError(err.toDartInt);
  }

  @override
  List<FileInfo> listFiles(String torrentId) {
    _ensureNotDisposed();
    final result =
        seekServeWasm.listFiles(_engine, torrentId.toJS) as JsStringResult;
    final err = result.error.toDartInt;
    checkError(err);
    final jsonStr = result.json?.toDart;
    if (jsonStr == null) return [];
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
  }

  @override
  void selectFile(String torrentId, int fileIndex) {
    _ensureNotDisposed();
    final err =
        seekServeWasm.selectFile(_engine, torrentId.toJS, fileIndex.toJS);
    checkError(err.toDartInt);
  }

  @override
  String getStreamUrl(String torrentId, int fileIndex) {
    _ensureNotDisposed();
    final result = seekServeWasm.getStreamUrl(
        _engine, torrentId.toJS, fileIndex.toJS) as JsStringResult;
    final err = result.error.toDartInt;
    checkError(err);
    return result.url!.toDart;
  }

  @override
  TorrentStatus getStatus(String torrentId) {
    _ensureNotDisposed();
    final result =
        seekServeWasm.getStatus(_engine, torrentId.toJS) as JsStringResult;
    final err = result.error.toDartInt;
    checkError(err);
    final jsonStr = result.json!.toDart;
    final map = jsonDecode(jsonStr) as Map<String, dynamic>;
    return TorrentStatus.fromJson(map);
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _pollTimer?.cancel();
    _pollTimer = null;
    _eventController.close();
    seekServeWasm.engineDestroy(_engine);
  }

  void _registerServiceWorker() {
    final sw = web.window.navigator.serviceWorker;
    sw.register('seekserve_sw.js'.toJS);
  }

  void _setupSwMessageHandler() {
    // Listen for messages from the Service Worker requesting byte reads
    web.window.navigator.serviceWorker.addEventListener(
      'message',
      ((web.MessageEvent event) {
        final data = event.data as JSObject;
        final type =
            (data.getProperty<JSString?>('type'.toJS))?.toDart;
        if (type == null) return;

        if (type == 'seekserve-readBytes') {
          _handleSwReadBytes(data, event.ports);
        } else if (type == 'seekserve-getFileSize') {
          _handleSwGetFileSize(data, event.ports);
        }
      }).toJS,
    );
  }

  void _handleSwReadBytes(JSObject data, JSArray<web.MessagePort> ports) {
    final torrentId =
        data.getProperty<JSString>('torrentId'.toJS).toDart;
    final fileIndex =
        data.getProperty<JSNumber>('fileIndex'.toJS).toDartInt;
    final offset =
        data.getProperty<JSNumber>('offset'.toJS).toDartInt;
    final length =
        data.getProperty<JSNumber>('length'.toJS).toDartInt;

    final result = seekServeWasm.readBytes(
        _engine, torrentId.toJS, fileIndex.toJS, offset.toJS, length.toJS)
        as JsReadResult;

    final port = ports.toDart[0];
    final response = JSObject();
    response.setProperty('error'.toJS, result.error);
    response.setProperty('data'.toJS, result.data);
    port.postMessage(response);
  }

  void _handleSwGetFileSize(JSObject data, JSArray<web.MessagePort> ports) {
    final torrentId =
        data.getProperty<JSString>('torrentId'.toJS).toDart;
    final fileIndex =
        data.getProperty<JSNumber>('fileIndex'.toJS).toDartInt;

    final result = seekServeWasm.getFileSize(
        _engine, torrentId.toJS, fileIndex.toJS) as JsSizeResult;

    final port = ports.toDart[0];
    final response = JSObject();
    response.setProperty('error'.toJS, result.error);
    response.setProperty('size'.toJS, result.size);
    port.postMessage(response);
  }

  /// Track known metadata state per torrent for change detection.
  final Map<String, bool> _knownMetadata = {};

  void _pollEvents() {
    if (_disposed) return;
    try {
      final ids = listTorrents();
      for (final id in ids) {
        try {
          final status = getStatus(id);
          final hadMetadata = _knownMetadata[id] ?? false;
          if (status.hasMetadata && !hadMetadata) {
            _knownMetadata[id] = true;
            _eventController
                .add(MetadataReceived(torrentId: id));
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  void _ensureNotDisposed() {
    if (_disposed) {
      throw StateError('SeekServeClient has been disposed');
    }
  }
}
