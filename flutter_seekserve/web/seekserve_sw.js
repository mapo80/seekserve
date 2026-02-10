/**
 * SeekServe Service Worker
 *
 * Intercepts fetch requests to /seekserve-stream/{torrentId}/{fileIndex}
 * and serves bytes from the WASM engine via the main thread.
 * Acts as a virtual HTTP Range server in the browser.
 */
'use strict';

const STREAM_URL_PATTERN = /^\/seekserve-stream\/([a-fA-F0-9]+)\/(\d+)$/;

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
};

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = STREAM_URL_PATTERN.exec(url.pathname);
  if (!match) return; // Let other requests pass through

  const torrentId = match[1];
  const fileIndex = parseInt(match[2], 10);

  const name = url.searchParams.get('name') || '';
  event.respondWith(handleStreamRequest(event.request, torrentId, fileIndex, name));
});

/**
 * Handle a stream request by communicating with the main thread.
 */
async function handleStreamRequest(request, torrentId, fileIndex, fileName) {
  try {
    // Get file size first
    const sizeResult = await sendToClient({
      type: 'seekserve-getFileSize',
      torrentId: torrentId,
      fileIndex: fileIndex,
    });

    if (sizeResult.error !== 0) {
      return new Response('File not ready', { status: 503 });
    }

    const totalSize = sizeResult.size;

    // Handle HEAD request
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Length': totalSize.toString(),
          'Content-Type': guessMimeType(fileName),
          'Accept-Ranges': 'bytes',
        },
      });
    }

    // Parse Range header
    const rangeHeader = request.headers.get('Range');
    let start = 0;
    let end = totalSize - 1;
    let isPartial = false;

    if (rangeHeader) {
      const rangeMatch = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (rangeMatch) {
        if (rangeMatch[1] !== '') {
          start = parseInt(rangeMatch[1], 10);
        }
        if (rangeMatch[2] !== '') {
          end = parseInt(rangeMatch[2], 10);
        } else {
          end = totalSize - 1;
        }
        isPartial = true;
      }
    }

    // Clamp range
    if (start >= totalSize) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${totalSize}` },
      });
    }
    if (end >= totalSize) end = totalSize - 1;

    const length = end - start + 1;

    // Read bytes from WASM via main thread
    const readResult = await sendToClient({
      type: 'seekserve-readBytes',
      torrentId: torrentId,
      fileIndex: fileIndex,
      offset: start,
      length: length,
    });

    if (readResult.error !== 0) {
      return new Response('Read error', { status: 500 });
    }

    const headers = {
      'Content-Length': length.toString(),
      'Content-Type': guessMimeType(fileName),
      'Accept-Ranges': 'bytes',
    };

    if (isPartial) {
      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
      return new Response(readResult.data, { status: 206, headers: headers });
    }

    return new Response(readResult.data, { status: 200, headers: headers });
  } catch (err) {
    return new Response('Internal error: ' + err.message, { status: 500 });
  }
}

/**
 * Send a message to the first controlled client and wait for a response.
 */
function sendToClient(message) {
  return new Promise(async (resolve, reject) => {
    const allClients = await self.clients.matchAll({ type: 'window' });
    if (allClients.length === 0) {
      reject(new Error('No controlled clients'));
      return;
    }

    const client = allClients[0];
    const channel = new MessageChannel();

    channel.port1.onmessage = (event) => {
      resolve(event.data);
    };

    client.postMessage(message, [channel.port2]);
  });
}

/**
 * Guess MIME type from file extension (torrent files may have extensions).
 * Falls back to video/mp4 as default.
 */
function guessMimeType(fileName) {
  if (fileName) {
    const dot = fileName.lastIndexOf('.');
    if (dot !== -1) {
      const ext = fileName.substring(dot).toLowerCase();
      if (MIME_TYPES[ext]) return MIME_TYPES[ext];
    }
  }
  return 'video/mp4';
}
