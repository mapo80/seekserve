/**
 * SeekServe OPFS Worker
 *
 * Dedicated Web Worker that persists torrent piece data to the
 * Origin Private File System (OPFS) using FileSystemSyncAccessHandle.
 *
 * OPFS provides random-access writes at byte offset — ideal for
 * incremental piece persistence without rewriting entire files.
 *
 * File layout in OPFS:
 *   seekserve/<torrentId>/<fileIndex>
 */
'use strict';

/** @type {Map<string, FileSystemSyncAccessHandle>} key = "torrentId/fileIndex" */
const _handles = new Map();

/** @type {FileSystemDirectoryHandle|null} */
let _rootDir = null;

function _key(torrentId, fileIndex) {
  return torrentId + '/' + fileIndex;
}

async function _getRoot() {
  if (_rootDir) return _rootDir;
  const root = await navigator.storage.getDirectory();
  try {
    _rootDir = await root.getDirectoryHandle('seekserve', { create: true });
  } catch (e) {
    throw new Error('opfs-unavailable');
  }
  return _rootDir;
}

async function _getTorrentDir(torrentId) {
  const root = await _getRoot();
  return root.getDirectoryHandle(torrentId, { create: true });
}

// --- Message handlers ---

async function handleInit({ torrentId, fileIndex, fileSize }) {
  const key = _key(torrentId, fileIndex);
  if (_handles.has(key)) {
    // Already open
    return { ok: true };
  }
  const dir = await _getTorrentDir(torrentId);
  const fileHandle = await dir.getFileHandle(String(fileIndex), { create: true });
  const accessHandle = await fileHandle.createSyncAccessHandle();
  // Pre-allocate file to expected size
  accessHandle.truncate(fileSize);
  _handles.set(key, accessHandle);
  return { ok: true };
}

async function handleWritePiece({ torrentId, fileIndex, offset, data }) {
  const key = _key(torrentId, fileIndex);
  let accessHandle = _handles.get(key);
  if (!accessHandle) {
    // Auto-init: open the file (may not be pre-allocated)
    const dir = await _getTorrentDir(torrentId);
    const fileHandle = await dir.getFileHandle(String(fileIndex), { create: true });
    accessHandle = await fileHandle.createSyncAccessHandle();
    _handles.set(key, accessHandle);
  }
  accessHandle.write(data, { at: offset });
  return { ok: true };
}

function handleFlush({ torrentId, fileIndex }) {
  const key = _key(torrentId, fileIndex);
  const accessHandle = _handles.get(key);
  if (!accessHandle) return { ok: false, error: 'not-open' };
  accessHandle.flush();
  return { ok: true };
}

function handleClose({ torrentId, fileIndex }) {
  const key = _key(torrentId, fileIndex);
  const accessHandle = _handles.get(key);
  if (accessHandle) {
    accessHandle.close();
    _handles.delete(key);
  }
  return { ok: true };
}

async function handleRestore({ torrentId, fileIndex }) {
  const key = _key(torrentId, fileIndex);

  // Close existing handle if open (need exclusive access for getFile)
  let accessHandle = _handles.get(key);
  if (accessHandle) {
    accessHandle.close();
    _handles.delete(key);
  }

  try {
    const dir = await _getTorrentDir(torrentId);
    const fileHandle = await dir.getFileHandle(String(fileIndex));
    // Read via sync access handle for Worker context
    accessHandle = await fileHandle.createSyncAccessHandle();
    const size = accessHandle.getSize();
    const buf = new Uint8Array(size);
    accessHandle.read(buf, { at: 0 });
    accessHandle.close();
    return { ok: true, data: buf, size: size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleGetFile({ torrentId, fileIndex }) {
  const key = _key(torrentId, fileIndex);

  // Must close sync access handle before getFile()
  const accessHandle = _handles.get(key);
  if (accessHandle) {
    accessHandle.close();
    _handles.delete(key);
  }

  try {
    const dir = await _getTorrentDir(torrentId);
    const fileHandle = await dir.getFileHandle(String(fileIndex));
    const file = await fileHandle.getFile();
    return { ok: true, file: file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleDelete({ torrentId, fileIndex }) {
  const key = _key(torrentId, fileIndex);

  // Close if open
  const accessHandle = _handles.get(key);
  if (accessHandle) {
    accessHandle.close();
    _handles.delete(key);
  }

  try {
    const dir = await _getTorrentDir(torrentId);
    await dir.removeEntry(String(fileIndex));
    return { ok: true };
  } catch (e) {
    // File may not exist — that's fine
    return { ok: true };
  }
}

async function handleWriteMeta({ torrentId, meta }) {
  try {
    const dir = await _getTorrentDir(torrentId);
    const fh = await dir.getFileHandle('__meta.json', { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(meta));
    await writable.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleReadMeta({ torrentId }) {
  try {
    const dir = await _getTorrentDir(torrentId);
    const fh = await dir.getFileHandle('__meta.json');
    const file = await fh.getFile();
    const text = await file.text();
    return { ok: true, meta: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleList() {
  try {
    const root = await _getRoot();
    const result = [];

    for await (const [torrentId, torrentHandle] of root.entries()) {
      if (torrentHandle.kind !== 'directory') continue;
      for await (const [fileIndexStr, fileHandle] of torrentHandle.entries()) {
        if (fileHandle.kind !== 'file') continue;
        // Skip metadata files — not actual piece data
        if (fileIndexStr === '__meta.json') continue;
        const file = await fileHandle.getFile();
        result.push({
          torrentId: torrentId,
          fileIndex: parseInt(fileIndexStr, 10),
          size: file.size,
        });
      }
    }

    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Message router ---

let _msgId = 0;
const _pending = new Map();

self.onmessage = async (e) => {
  const msg = e.data;
  let response;

  try {
    switch (msg.type) {
      case 'init':       response = await handleInit(msg); break;
      case 'writePiece': response = await handleWritePiece(msg); break;
      case 'flush':      response = handleFlush(msg); break;
      case 'close':      response = handleClose(msg); break;
      case 'restore':    response = await handleRestore(msg); break;
      case 'getFile':    response = await handleGetFile(msg); break;
      case 'delete':     response = await handleDelete(msg); break;
      case 'list':       response = await handleList(); break;
      case 'writeMeta':  response = await handleWriteMeta(msg); break;
      case 'readMeta':   response = await handleReadMeta(msg); break;
      default:
        response = { ok: false, error: 'unknown-type: ' + msg.type };
    }
  } catch (e) {
    response = { ok: false, error: e.message || String(e) };
  }

  // Include msgId for request/response correlation
  response.msgId = msg.msgId;
  response.type = msg.type;

  // Transfer Uint8Array buffers to avoid copying
  const transfer = [];
  if (response.data instanceof Uint8Array) {
    transfer.push(response.data.buffer);
  }

  self.postMessage(response, transfer);
};
