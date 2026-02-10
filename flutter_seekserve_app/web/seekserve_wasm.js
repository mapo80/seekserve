/**
 * SeekServe WASM JS Glue Layer
 *
 * Wraps the Emscripten-compiled C API module and exposes helper functions
 * for Dart (via dart:js_interop) and the Service Worker.
 */
'use strict';

let _module = null;
let _cw = {};

/**
 * Initialise the WASM module.
 * @param {string} wasmBaseUrl - Base URL for .wasm/.worker.js files.
 * @returns {Promise<void>}
 */
async function _initSeekServe(wasmBaseUrl) {
  if (_module) return;

  _module = await SeekServeModule({
    locateFile: (path) => (wasmBaseUrl ? wasmBaseUrl + '/' + path : path),
  });

  _cw = {
    ss_engine_create: _module.cwrap('ss_engine_create', 'number', ['string']),
    ss_engine_destroy: _module.cwrap('ss_engine_destroy', null, ['number']),
    ss_add_torrent: _module.cwrap('ss_add_torrent', 'number', ['number', 'string', 'number', 'number']),
    ss_remove_torrent: _module.cwrap('ss_remove_torrent', 'number', ['number', 'string', 'number']),
    ss_list_torrents: _module.cwrap('ss_list_torrents', 'number', ['number', 'number']),
    ss_list_files: _module.cwrap('ss_list_files', 'number', ['number', 'string', 'number']),
    ss_select_file: _module.cwrap('ss_select_file', 'number', ['number', 'string', 'number']),
    ss_get_stream_url: _module.cwrap('ss_get_stream_url', 'number', ['number', 'string', 'number', 'number']),
    ss_get_status: _module.cwrap('ss_get_status', 'number', ['number', 'string', 'number']),
    ss_set_event_callback: _module.cwrap('ss_set_event_callback', 'number', ['number', 'number', 'number']),
    ss_start_server: _module.cwrap('ss_start_server', 'number', ['number', 'number', 'number']),
    ss_stop_server: _module.cwrap('ss_stop_server', 'number', ['number']),
    ss_free_string: _module.cwrap('ss_free_string', null, ['number']),
    ss_read_bytes: _module.cwrap('ss_read_bytes', 'number', ['number', 'string', 'number', 'number', 'number', 'number', 'number']),
    ss_get_file_size: _module.cwrap('ss_get_file_size', 'number', ['number', 'string', 'number', 'number']),
  };
}

// --- String helpers ---

/** Read a C string from the WASM heap and free it. */
function _readAndFreeString(ptr) {
  if (!ptr) return null;
  const str = _module.UTF8ToString(ptr);
  _cw.ss_free_string(ptr);
  return str;
}

/** Read a C string from a char** out-parameter pointer and free it. */
function _readOutString(outPtr) {
  const strPtr = _module.HEAPU32[outPtr >> 2];
  if (!strPtr) return null;
  const str = _module.UTF8ToString(strPtr);
  _cw.ss_free_string(strPtr);
  return str;
}

// --- Public API ---

function engineCreate(configJson) {
  return _cw.ss_engine_create(configJson);
}

function engineDestroy(engine) {
  _cw.ss_engine_destroy(engine);
}

function addTorrent(engine, uri) {
  // Allocate buffer for torrent ID output (40 hex chars + null)
  const idBuf = _module._malloc(64);
  const err = _cw.ss_add_torrent(engine, uri, idBuf, 64);
  if (err !== 0) {
    _module._free(idBuf);
    return { error: err, id: null };
  }
  const id = _module.UTF8ToString(idBuf);
  _module._free(idBuf);
  return { error: 0, id: id };
}

function removeTorrent(engine, torrentId, deleteFiles) {
  return _cw.ss_remove_torrent(engine, torrentId, deleteFiles ? 1 : 0);
}

function listTorrents(engine) {
  const outPtr = _module._malloc(4);
  const err = _cw.ss_list_torrents(engine, outPtr);
  if (err !== 0) {
    _module._free(outPtr);
    return { error: err, json: null };
  }
  const json = _readOutString(outPtr);
  _module._free(outPtr);
  return { error: 0, json: json };
}

function listFiles(engine, torrentId) {
  const outPtr = _module._malloc(4);
  const err = _cw.ss_list_files(engine, torrentId, outPtr);
  if (err !== 0) {
    _module._free(outPtr);
    return { error: err, json: null };
  }
  const json = _readOutString(outPtr);
  _module._free(outPtr);
  return { error: 0, json: json };
}

function selectFile(engine, torrentId, fileIndex) {
  return _cw.ss_select_file(engine, torrentId, fileIndex);
}

function getStreamUrl(engine, torrentId, fileIndex) {
  const outPtr = _module._malloc(4);
  const err = _cw.ss_get_stream_url(engine, torrentId, fileIndex, outPtr);
  if (err !== 0) {
    _module._free(outPtr);
    return { error: err, url: null };
  }
  const url = _readOutString(outPtr);
  _module._free(outPtr);
  return { error: 0, url: url };
}

function getStatus(engine, torrentId) {
  const outPtr = _module._malloc(4);
  const err = _cw.ss_get_status(engine, torrentId, outPtr);
  if (err !== 0) {
    _module._free(outPtr);
    return { error: err, json: null };
  }
  const json = _readOutString(outPtr);
  _module._free(outPtr);
  return { error: 0, json: json };
}

function startServer(engine, port) {
  const outPtr = _module._malloc(2);
  const err = _cw.ss_start_server(engine, port, outPtr);
  if (err !== 0) {
    _module._free(outPtr);
    return { error: err, port: 0 };
  }
  const assignedPort = _module.HEAPU16[outPtr >> 1];
  _module._free(outPtr);
  return { error: 0, port: assignedPort };
}

function stopServer(engine) {
  return _cw.ss_stop_server(engine);
}

function readBytes(engine, torrentId, fileIndex, offset, length) {
  const buf = _module._malloc(length);
  const outBytesRead = _module._malloc(8);
  const err = _cw.ss_read_bytes(engine, torrentId, fileIndex, offset, length, buf, outBytesRead);
  if (err !== 0) {
    _module._free(buf);
    _module._free(outBytesRead);
    return { error: err, data: null };
  }
  // Read uint64 bytes_read (low 32 bits sufficient for practical read sizes)
  const bytesRead = _module.HEAPU32[outBytesRead >> 2];
  const data = new Uint8Array(_module.HEAPU8.buffer, buf, bytesRead).slice();
  _module._free(buf);
  _module._free(outBytesRead);
  return { error: 0, data: data };
}

function getFileSize(engine, torrentId, fileIndex) {
  const outPtr = _module._malloc(8);
  const err = _cw.ss_get_file_size(engine, torrentId, fileIndex, outPtr);
  if (err !== 0) {
    _module._free(outPtr);
    return { error: err, size: 0 };
  }
  // Read uint64 (low 32 bits — files up to 4GB)
  const sizeLo = _module.HEAPU32[outPtr >> 2];
  const sizeHi = _module.HEAPU32[(outPtr >> 2) + 1];
  _module._free(outPtr);
  return { error: 0, size: sizeLo + sizeHi * 0x100000000 };
}

// Expose on window for dart:js_interop access
window.SeekServeWasm = {
  init: _initSeekServe,
  engineCreate: engineCreate,
  engineDestroy: engineDestroy,
  addTorrent: addTorrent,
  removeTorrent: removeTorrent,
  listTorrents: listTorrents,
  listFiles: listFiles,
  selectFile: selectFile,
  getStreamUrl: getStreamUrl,
  getStatus: getStatus,
  startServer: startServer,
  stopServer: stopServer,
  readBytes: readBytes,
  getFileSize: getFileSize,
  module: () => _module,
};
