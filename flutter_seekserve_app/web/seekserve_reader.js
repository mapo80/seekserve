/**
 * SeekServe Byte Reader Worker
 *
 * Dedicated Web Worker that handles byte read requests from the Service Worker.
 * Calls ss_read_bytes() via the WASM module (which may block waiting for pieces).
 * Communicates with the main thread via MessageChannel ports.
 */
'use strict';

self.onmessage = function(e) {
  const { type, engine, torrentId, fileIndex, offset, length, port } = e.data;

  if (type === 'readBytes') {
    try {
      const result = self.SeekServeWasm.readBytes(engine, torrentId, fileIndex, offset, length);
      port.postMessage({ error: result.error, data: result.data });
    } catch (err) {
      port.postMessage({ error: -5, data: null, message: err.toString() });
    }
  } else if (type === 'getFileSize') {
    try {
      const result = self.SeekServeWasm.getFileSize(engine, torrentId, fileIndex);
      port.postMessage({ error: result.error, size: result.size });
    } catch (err) {
      port.postMessage({ error: -5, size: 0, message: err.toString() });
    }
  }
};
