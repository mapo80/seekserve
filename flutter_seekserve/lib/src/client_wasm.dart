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
  final String _configJson;

  SeekServeClientWasm({SeekServeConfig? config})
      : _configJson = config?.toJsonString() ?? '{}';

  @override
  Future<void> initialize() async {
    // SharedArrayBuffer is required for Emscripten pthreads.
    // It's only available when the page is served with proper COOP/COEP headers.
    if (!_hasSharedArrayBuffer()) {
      throw StateError(
        'SharedArrayBuffer not available. '
        'The server must send headers: '
        'Cross-Origin-Opener-Policy: same-origin, '
        'Cross-Origin-Embedder-Policy: require-corp. '
        'Use: flutter run -d chrome '
        '--web-header=Cross-Origin-Opener-Policy=same-origin '
        '--web-header=Cross-Origin-Embedder-Policy=require-corp',
      );
    }
    try {
      await seekServeWasm.init(''.toJS).toDart;
    } catch (e) {
      throw StateError('WASM module init failed: ${_jsErrorMessage(e)}');
    }
    try {
      _engine = seekServeWasm.engineCreate(_configJson.toJS);
    } catch (e) {
      throw StateError('Engine create failed: ${_jsErrorMessage(e)}');
    }
    if (_engine.toDartInt == 0) {
      throw StateError(
        'Engine creation returned null. '
        'Check browser console (F12) for C++ errors.',
      );
    }
  }

  @override
  Stream<SeekServeEvent> get events => _eventController.stream;

  @override
  int startServer({int port = 0}) {
    _ensureNotDisposed();
    final result = _jsCall(
      () => seekServeWasm.startServer(_engine, port.toJS) as JsPortResult,
      'startServer',
    );
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
    final err = _jsCall(
      () => seekServeWasm.stopServer(_engine),
      'stopServer',
    );
    checkError(err.toDartInt);
  }

  @override
  String addTorrent(String uri) {
    _ensureNotDisposed();
    final result = _jsCall(
      () => seekServeWasm.addTorrent(_engine, uri.toJS) as JsStringResult,
      'addTorrent',
    );
    final err = result.error.toDartInt;
    checkError(err);
    return result.id!.toDart;
  }

  @override
  List<String> listTorrents() {
    _ensureNotDisposed();
    final result = _jsCall(
      () => seekServeWasm.listTorrents(_engine) as JsStringResult,
      'listTorrents',
    );
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
    final err = _jsCall(
      () => seekServeWasm.removeTorrent(
          _engine, torrentId.toJS, deleteFiles.toJS),
      'removeTorrent',
    );
    checkError(err.toDartInt);
  }

  @override
  List<FileInfo> listFiles(String torrentId) {
    _ensureNotDisposed();
    final result = _jsCall(
      () =>
          seekServeWasm.listFiles(_engine, torrentId.toJS) as JsStringResult,
      'listFiles',
    );
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
    final err = _jsCall(
      () =>
          seekServeWasm.selectFile(_engine, torrentId.toJS, fileIndex.toJS),
      'selectFile',
    );
    checkError(err.toDartInt);
  }

  @override
  String getStreamUrl(String torrentId, int fileIndex) {
    _ensureNotDisposed();
    final result = _jsCall(
      () => seekServeWasm.getStreamUrl(
          _engine, torrentId.toJS, fileIndex.toJS) as JsStringResult,
      'getStreamUrl',
    );
    final err = result.error.toDartInt;
    checkError(err);
    return result.url!.toDart;
  }

  @override
  TorrentStatus getStatus(String torrentId) {
    _ensureNotDisposed();
    final result = _jsCall(
      () =>
          seekServeWasm.getStatus(_engine, torrentId.toJS) as JsStringResult,
      'getStatus',
    );
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
    try {
      seekServeWasm.engineDestroy(_engine);
    } catch (_) {}
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

  // --- Helpers ---

  static bool _hasSharedArrayBuffer() {
    final sab = globalContext.getProperty<JSAny?>('SharedArrayBuffer'.toJS);
    return sab != null && sab.isA<JSFunction>();
  }

  /// Wrap a JS interop call so that JS exceptions become readable Dart errors.
  static T _jsCall<T>(T Function() fn, String context) {
    try {
      return fn();
    } catch (e) {
      throw StateError('WASM $context: ${_jsErrorMessage(e)}');
    }
  }

  /// Extract a human-readable message from a JS error object.
  static String _jsErrorMessage(Object e) {
    try {
      final jsVal = e.jsify();
      if (jsVal != null && jsVal.isA<JSObject>()) {
        final obj = jsVal as JSObject;
        // Try .message (Error objects)
        final msg = obj.getProperty<JSAny?>('message'.toJS);
        if (msg != null && msg.isA<JSString>()) {
          return (msg as JSString).toDart;
        }
        // Try .toString()
        final str = obj.callMethod<JSAny?>('toString'.toJS);
        if (str != null && str.isA<JSString>()) {
          final s = (str as JSString).toDart;
          if (s != '[object Object]') return s;
        }
      }
    } catch (_) {}
    return '$e';
  }
}
