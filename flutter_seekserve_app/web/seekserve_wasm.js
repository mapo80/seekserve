/**
 * SeekServe WASM JS Glue Layer
 *
 * Wraps the Emscripten-compiled C API module and exposes helper functions
 * for Dart (via dart:js_interop) and the Service Worker.
 */
'use strict';

let _module = null;
let _cw = {};

// --- OPFS Worker ---
let _opfsWorker = null;
let _opfsAvailable = false;
let _opfsMsgId = 0;
const _opfsPending = new Map();
const _filePaths = new Map(); // "torrentId/fileIndex" → "/seekserve/filename.mp4"

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

  // Mount IDBFS at /seekserve so SQLite DB persists to IndexedDB.
  // Gracefully degrade if WASM was built without -lidbfs.js.
  const FS = _module.FS;
  const IDBFS = _module.IDBFS || (FS.filesystems && FS.filesystems.IDBFS);
  if (IDBFS) {
    try { FS.mkdir('/seekserve'); } catch (e) { /* already exists */ }
    FS.mount(IDBFS, {}, '/seekserve');

    // Populate MEMFS from IndexedDB (read=true means IDB→MEMFS).
    await new Promise((resolve) => {
      FS.syncfs(true, (err) => {
        if (err) { console.warn('[SeekServe] IDBFS initial sync failed:', err); }
        resolve();
      });
    });
    console.log('[SeekServe] IDBFS mounted and synced from IndexedDB');
  } else {
    console.warn('[SeekServe] IDBFS not available — torrents will not persist across reloads');
    try { FS.mkdir('/seekserve'); } catch (e) { /* already exists */ }
  }

  // --- OPFS Worker init ---
  try {
    _opfsWorker = new Worker('seekserve_opfs.js');
    _opfsWorker.onmessage = (e) => {
      const msg = e.data;
      const resolve = _opfsPending.get(msg.msgId);
      if (resolve) {
        _opfsPending.delete(msg.msgId);
        resolve(msg);
      }
    };
    _opfsWorker.onerror = (e) => {
      console.warn('[SeekServe] OPFS worker error:', e.message || e);
      // Resolve all pending promises so _initSeekServe doesn't hang
      for (const [id, resolve] of _opfsPending.entries()) {
        _opfsPending.delete(id);
        resolve({ ok: false, error: 'worker-error' });
      }
    };
    // Test OPFS availability (with timeout to prevent init hang)
    const testResult = await _postToOpfs({ type: 'list' }, 5000);
    _opfsAvailable = testResult.ok;
    console.log('[SeekServe] OPFS available:', _opfsAvailable);
  } catch (e) {
    console.warn('[SeekServe] OPFS not available:', e.message || e);
    _opfsAvailable = false;
  }

  // --- OPFS → MEMFS boot restore ---
  // Reads piece data from OPFS and writes to MEMFS so libtorrent can
  // hash-verify and resume. Guard against huge files (previous truncate bug)
  // by capping restore size.
  const MAX_RESTORE_BYTES = 100 * 1024 * 1024; // 100 MB cap per file
  if (_opfsAvailable) {
    try {
      const stored = await _postToOpfs({ type: 'list' });
      if (stored.ok && stored.data && stored.data.length > 0) {
        console.log('[SeekServe] Restoring', stored.data.length, 'file(s) from OPFS to MEMFS');
        for (const file of stored.data) {
          // Skip files that are too large (likely pre-allocated but mostly empty)
          if (file.size > MAX_RESTORE_BYTES) {
            console.warn('[SeekServe] Skipping oversized OPFS file:', file.torrentId,
              'index', file.fileIndex, '(' + (file.size / 1024 / 1024).toFixed(1) + ' MB)');
            continue;
          }
          // Skip empty files (0 bytes = no actual data written)
          if (!file.size || file.size === 0) continue;

          // Read __meta.json to get the correct MEMFS path
          const metaResult = await _postToOpfs({
            type: 'readMeta',
            torrentId: file.torrentId,
          });
          let memfsPath;
          if (metaResult.ok && metaResult.meta && metaResult.meta.memfsPath) {
            memfsPath = metaResult.meta.memfsPath;
          } else {
            console.warn('[SeekServe] No __meta.json for', file.torrentId, '— skipping restore');
            continue;
          }

          const result = await _postToOpfs({
            type: 'restore',
            torrentId: file.torrentId,
            fileIndex: file.fileIndex,
          }, 30000);
          if (result.ok && result.data && result.data.length > 0) {
            _ensureDir(FS, memfsPath);
            try {
              const fd = FS.open(memfsPath, 'w');
              FS.write(fd, result.data, 0, result.data.length, 0);
              FS.close(fd);
              console.log('[SeekServe] OPFS restored:', memfsPath, '(' + result.data.length + ' bytes)');
            } catch (e) {
              console.warn('[SeekServe] OPFS restore write failed:', memfsPath, e);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[SeekServe] OPFS boot restore failed:', e);
    }
  }

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
    ss_get_pieces: _module.cwrap('ss_get_pieces', 'number', ['number', 'string', 'number']),
    ss_set_event_callback: _module.cwrap('ss_set_event_callback', 'number', ['number', 'number', 'number']),
    ss_start_server: _module.cwrap('ss_start_server', 'number', ['number', 'number', 'number']),
    ss_stop_server: _module.cwrap('ss_stop_server', 'number', ['number']),
    ss_free_string: _module.cwrap('ss_free_string', null, ['number']),
    ss_read_bytes_wasm: _module.cwrap('ss_read_bytes_wasm', 'number', ['number', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'number']),
    ss_get_file_size: _module.cwrap('ss_get_file_size', 'number', ['number', 'string', 'number', 'number']),
    ss_force_reannounce: _module.cwrap('ss_force_reannounce', 'number', ['number', 'string']),
  };
}

// --- FS helpers ---

/**
 * Recursively create all directories in a file path.
 * e.g. _ensureDir(FS, "/seekserve/Sintel/video.mp4") creates /seekserve and /seekserve/Sintel.
 */
function _ensureDir(FS, filePath) {
  const parts = filePath.split('/').filter(Boolean);
  // Remove the filename (last part)
  parts.pop();
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try { FS.mkdir(current); } catch (e) { /* already exists */ }
  }
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
  const err = _cw.ss_select_file(engine, torrentId, fileIndex);
  if (err === 0) {
    try {
      const filesResult = listFiles(engine, torrentId);
      if (filesResult.error === 0 && filesResult.json) {
        const parsed = JSON.parse(filesResult.json);
        const files = parsed.files || parsed;
        const file = files.find(f => f.index === fileIndex);
        if (file && file.path) {
          _filePaths.set(torrentId + '/' + fileIndex, '/seekserve/' + file.path);
        }
      }
    } catch (e) { /* non-fatal: FS.read fallback simply not available */ }
  }
  return err;
}

function forceReannounce(engine, torrentId) {
  return _cw.ss_force_reannounce(engine, torrentId);
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

function getPieces(engine, torrentId) {
  const outPtr = _module._malloc(4);
  const err = _cw.ss_get_pieces(engine, torrentId, outPtr);
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

/**
 * Validate that a buffer contains no all-zero 256-byte blocks.
 * Compressed video (H.264/AAC) has high entropy — 256 consecutive zero bytes
 * is impossible in real video data. A zero block indicates either:
 * - Pre-allocated MEMFS space (file created but piece not downloaded)
 * - Partially downloaded piece (some 16KB blocks arrived, others still zeros)
 */
function _validateNonZero(buf, nread) {
  const BLOCK = 256;
  for (let pos = 0; pos < nread; pos += BLOCK) {
    const end = Math.min(pos + BLOCK, nread);
    let blockNonZero = false;
    for (let i = pos; i < end; i++) {
      if (buf[i] !== 0) { blockNonZero = true; break; }
    }
    if (!blockNonZero) return false;
  }
  return true;
}

function readBytes(engine, torrentId, fileIndex, offset, length) {
  const buf = _module._malloc(length);
  const outBytesRead = _module._malloc(8);
  // Split uint64_t offset/length into (lo, hi) pairs for WASM ABI compatibility.
  // Emscripten splits uint64_t VALUE params into two i32s, but cwrap('number')
  // only passes one i32. ss_read_bytes_wasm accepts explicit (lo, hi) pairs.
  const offsetLo = offset >>> 0;
  const offsetHi = Math.floor(offset / 0x100000000) >>> 0;
  const lengthLo = length >>> 0;
  const lengthHi = Math.floor(length / 0x100000000) >>> 0;
  const err = _cw.ss_read_bytes_wasm(engine, torrentId, fileIndex, offsetLo, offsetHi, lengthLo, lengthHi, buf, outBytesRead);

  if (err === 0) {
    const bytesRead = _module.HEAPU32[outBytesRead >> 2];
    const data = new Uint8Array(_module.HEAPU8.buffer, buf, bytesRead).slice();
    _module._free(buf);
    _module._free(outBytesRead);
    return { error: 0, data: data };
  }

  _module._free(buf);
  _module._free(outBytesRead);

  // FS.read fallback: data may be on MEMFS (written by WebRTC) but avail not updated yet.
  // Only for err=-4 (SS_ERR_TIMEOUT = PieceAvailabilityIndex lag).
  if (err === -4) {
    const memfsPath = _filePaths.get(torrentId + '/' + fileIndex);
    if (memfsPath) {
      try {
        const FS = _module.FS;
        const fd = FS.open(memfsPath, 'r');
        const readBuf = new Uint8Array(length);
        const nread = FS.read(fd, readBuf, 0, length, offset);
        FS.close(fd);
        if (nread > 0 && _validateNonZero(readBuf, nread)) {
          return { error: 0, data: readBuf.slice(0, nread) };
        }
      } catch (e) { /* file not on MEMFS yet — return original error */ }
    }
  }

  return { error: err, data: null };
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

// --- OPFS helpers ---

/**
 * Send a message to the OPFS Worker and wait for a response.
 * @param {Object} msg - Message object with `type` and params.
 * @param {number} [timeoutMs=10000] - Timeout in milliseconds (0 = no timeout).
 * @returns {Promise<Object>} Response from OPFS Worker.
 */
function _postToOpfs(msg, timeoutMs = 10000) {
  if (!_opfsWorker) return Promise.resolve({ ok: false, error: 'no-worker' });
  const id = ++_opfsMsgId;
  msg.msgId = id;
  // Transfer Uint8Array buffers if present
  const transfer = [];
  if (msg.data instanceof Uint8Array) {
    transfer.push(msg.data.buffer);
  }
  const sendPromise = new Promise((resolve) => {
    _opfsPending.set(id, resolve);
    _opfsWorker.postMessage(msg, transfer);
  });
  if (timeoutMs <= 0) return sendPromise;
  return Promise.race([
    sendPromise,
    new Promise((resolve) => setTimeout(() => {
      _opfsPending.delete(id);
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs)),
  ]);
}

/**
 * Persist a piece to OPFS. Called from the piece_finished event handler.
 * Reads piece data from MEMFS and sends it to the OPFS Worker.
 */
function opfsWritePiece(torrentId, fileIndex, pieceOffset, pieceLength, memfsPath) {
  if (!_opfsAvailable || !_opfsWorker || !_module) return;
  try {
    const FS = _module.FS;
    const fd = FS.open(memfsPath, 'r');
    const buf = new Uint8Array(pieceLength);
    FS.read(fd, buf, 0, pieceLength, pieceOffset);
    FS.close(fd);

    // Fire-and-forget: transfer buffer to worker (no copy)
    _postToOpfs({
      type: 'writePiece',
      torrentId: torrentId,
      fileIndex: fileIndex,
      offset: pieceOffset,
      data: buf,
    });
  } catch (e) {
    // File may not exist yet if piece is before selected file range
  }
}

/**
 * Download a completed file from OPFS to the user's filesystem.
 * Uses createObjectURL + <a download> trick.
 * @returns {Promise<boolean>} true if download initiated
 */
async function downloadFile(torrentId, fileIndex, fileName) {
  if (!_opfsAvailable || !_opfsWorker) {
    throw new Error('OPFS not available');
  }
  const result = await _postToOpfs({ type: 'getFile', torrentId, fileIndex });
  if (!result.ok) throw new Error(result.error || 'getFile failed');

  const url = URL.createObjectURL(result.file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || ('file_' + fileIndex);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

// --- OPFS Polling Sync ---

let _opfsSyncState = null; // { engine, torrentId, fileIndex, memfsPath, fileSize, pieceLength, firstPiece, endPiece, syncedPieces: Set }
let _opfsSyncTimer = null;
let _opfsSyncCycle = 0;

/**
 * Start periodic OPFS sync for a selected file.
 * Polls getPieces() every 3s, diffs bitfield, writes new pieces from MEMFS to OPFS.
 */
function opfsStartSync(engine, torrentId, fileIndex) {
  // Stop any existing sync
  opfsStopSync();

  if (!_opfsAvailable || !_opfsWorker || !_module) return;

  // Gather metadata for the file
  const piecesResult = getPieces(engine, torrentId);
  if (piecesResult.error !== 0 || !piecesResult.json) return;
  const piecesData = JSON.parse(piecesResult.json);

  const filesResult = listFiles(engine, torrentId);
  if (filesResult.error !== 0 || !filesResult.json) return;
  const filesData = JSON.parse(filesResult.json);

  const sizeResult = getFileSize(engine, torrentId, fileIndex);
  if (sizeResult.error !== 0) return;

  // Find file info from pieces data
  const fileInfo = piecesData.files
    ? piecesData.files.find(f => f.index === fileIndex)
    : null;
  if (!fileInfo) return;

  // Get file path from listFiles
  const filesList = filesData.files || filesData;
  const fileEntry = Array.isArray(filesList)
    ? filesList.find(f => f.index === fileIndex)
    : null;
  if (!fileEntry) return;

  const memfsPath = '/seekserve/' + fileEntry.path;
  const fileSize = sizeResult.size;
  const pieceLength = piecesData.piece_length;
  const firstPiece = fileInfo.first_piece;
  const endPiece = fileInfo.end_piece;

  _opfsSyncState = {
    engine, torrentId, fileIndex,
    memfsPath, fileSize, pieceLength,
    firstPiece, endPiece,
    syncedPieces: new Set(),
  };
  _opfsSyncCycle = 0;

  // Init OPFS file handle
  _postToOpfs({
    type: 'init',
    torrentId: torrentId,
    fileIndex: fileIndex,
    fileSize: fileSize,
  });

  // Save metadata for boot restore
  _postToOpfs({
    type: 'writeMeta',
    torrentId: torrentId,
    meta: { memfsPath, fileSize, pieceLength, firstPiece, endPiece },
  });

  console.log('[SeekServe] OPFS sync started:', torrentId, 'file', fileIndex,
    'pieces', firstPiece, '-', endPiece, 'path:', memfsPath);

  // Start polling
  _opfsSyncTimer = setInterval(_opfsSyncPieces, 3000);
}

function opfsStopSync() {
  if (_opfsSyncTimer) {
    clearInterval(_opfsSyncTimer);
    _opfsSyncTimer = null;
  }
  if (_opfsSyncState) {
    // Final flush (fire-and-forget)
    _postToOpfs({
      type: 'flush',
      torrentId: _opfsSyncState.torrentId,
      fileIndex: _opfsSyncState.fileIndex,
    }, 0);
    _opfsSyncState = null;
  }
}

function _opfsSyncPieces() {
  if (!_opfsSyncState || !_module) return;
  const s = _opfsSyncState;

  try {
    // Get current bitfield
    const piecesResult = getPieces(s.engine, s.torrentId);
    if (piecesResult.error !== 0 || !piecesResult.json) return;
    const piecesData = JSON.parse(piecesResult.json);
    const bitfield = piecesData.bitfield;
    if (!bitfield) return;

    const FS = _module.FS;
    let wrote = 0;

    for (let p = s.firstPiece; p < s.endPiece; p++) {
      if (s.syncedPieces.has(p)) continue;
      if (!_bitfieldHasPiece(bitfield, p)) continue;

      // This piece is complete and not yet synced
      const fileOffset = (p - s.firstPiece) * s.pieceLength;
      const actualLen = Math.min(s.pieceLength, s.fileSize - fileOffset);
      if (actualLen <= 0) continue;

      let fd = -1;
      try {
        fd = FS.open(s.memfsPath, 'r');
        const buf = new Uint8Array(actualLen);
        FS.read(fd, buf, 0, actualLen, fileOffset);
        FS.close(fd);
        fd = -1;

        _postToOpfs({
          type: 'writePiece',
          torrentId: s.torrentId,
          fileIndex: s.fileIndex,
          offset: fileOffset,
          data: buf,
        }, 0); // fire-and-forget, no timeout
        s.syncedPieces.add(p);
        wrote++;
      } catch (e) {
        // Close FD if open (prevents leak when FS.read throws)
        if (fd !== -1) try { FS.close(fd); } catch (_) {}
        // File may not exist yet in MEMFS
        break;
      }
    }

    if (wrote > 0) {
      console.log('[SeekServe] OPFS synced', wrote, 'piece(s), total:', s.syncedPieces.size,
        '/', (s.endPiece - s.firstPiece));
    }

    // Flush every ~30s (10 cycles * 3s)
    _opfsSyncCycle++;
    if (_opfsSyncCycle % 10 === 0) {
      _postToOpfs({
        type: 'flush',
        torrentId: s.torrentId,
        fileIndex: s.fileIndex,
      }, 0); // fire-and-forget
      // Also persist SQLite resume_data to IndexedDB
      syncFs();
    }
  } catch (e) {
    console.warn('[SeekServe] OPFS sync error:', e);
  }
}

/**
 * Check if a piece is set in a hex-encoded bitfield string.
 * @param {string} hex - Hex-encoded bitfield (e.g. "ff00...")
 * @param {number} piece - Piece index
 * @returns {boolean}
 */
function _bitfieldHasPiece(hex, piece) {
  const byteIndex = piece >> 3;
  const bitIndex = 7 - (piece & 7);
  const charIndex = byteIndex * 2;
  if (charIndex + 1 >= hex.length) return false;
  const byte = parseInt(hex.substr(charIndex, 2), 16);
  return ((byte >> bitIndex) & 1) === 1;
}

function opfsAvailable() {
  return _opfsAvailable;
}

/**
 * Flush MEMFS changes to IndexedDB (IDBFS persist).
 * Call after any operation that mutates the SQLite DB (add/remove torrent).
 * @returns {Promise<void>}
 */
function syncFs() {
  if (!_module) return Promise.resolve();
  const IDBFS = _module.IDBFS || (_module.FS.filesystems && _module.FS.filesystems.IDBFS);
  if (!IDBFS) return Promise.resolve(); // No persistence available
  return new Promise((resolve) => {
    _module.FS.syncfs(false, (err) => {
      if (err) console.warn('[SeekServe] IDBFS sync failed:', err);
      resolve();
    });
  });
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
  forceReannounce: forceReannounce,
  getStreamUrl: getStreamUrl,
  getStatus: getStatus,
  getPieces: getPieces,
  startServer: startServer,
  stopServer: stopServer,
  readBytes: readBytes,
  getFileSize: getFileSize,
  syncFs: syncFs,
  module: () => _module,
  // OPFS persistence
  opfsAvailable: opfsAvailable,
  opfsWritePiece: opfsWritePiece,
  opfsStartSync: opfsStartSync,
  opfsStopSync: opfsStopSync,
  downloadFile: downloadFile,
};
