import 'dart:js_interop';

/// JS interop bridge to window.SeekServeWasm (loaded from seekserve_wasm.js).
@JS('SeekServeWasm')
extension type SeekServeWasmBridge._(JSObject _) implements JSObject {
  external JSPromise<JSAny?> init(JSString wasmBaseUrl);
  external JSNumber engineCreate(JSString configJson);
  external void engineDestroy(JSNumber engine);
  external JSObject addTorrent(JSNumber engine, JSString uri);
  external JSNumber removeTorrent(
      JSNumber engine, JSString torrentId, JSBoolean deleteFiles);
  external JSObject listTorrents(JSNumber engine);
  external JSObject listFiles(JSNumber engine, JSString torrentId);
  external JSNumber selectFile(
      JSNumber engine, JSString torrentId, JSNumber fileIndex);
  external JSObject getStreamUrl(
      JSNumber engine, JSString torrentId, JSNumber fileIndex);
  external JSObject getStatus(JSNumber engine, JSString torrentId);
  external JSObject startServer(JSNumber engine, JSNumber port);
  external JSNumber stopServer(JSNumber engine);
  external JSObject readBytes(JSNumber engine, JSString torrentId,
      JSNumber fileIndex, JSNumber offset, JSNumber length);
  external JSObject getFileSize(
      JSNumber engine, JSString torrentId, JSNumber fileIndex);
  external JSPromise<JSAny?> syncFs();
}

/// Helper to access window.SeekServeWasm.
@JS('SeekServeWasm')
external SeekServeWasmBridge get seekServeWasm;

/// Result type from JS glue functions that return {error, ...}.
extension type JsResult._(JSObject _) implements JSObject {
  external JSNumber get error;
}

extension type JsStringResult._(JSObject _) implements JSObject {
  external JSNumber get error;
  external JSString? get id;
  external JSString? get url;
  external JSString? get json;
}

extension type JsReadResult._(JSObject _) implements JSObject {
  external JSNumber get error;
  external JSAny? get data;
}

extension type JsSizeResult._(JSObject _) implements JSObject {
  external JSNumber get error;
  external JSNumber get size;
}

extension type JsPortResult._(JSObject _) implements JSObject {
  external JSNumber get error;
  external JSNumber get port;
}
