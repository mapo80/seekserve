/**
 * SeekServe Service Worker
 *
 * Intercepts fetch requests to /seekserve-stream/{torrentId}/{fileIndex}
 * and serves bytes from the WASM engine via the main thread.
 * Acts as a virtual HTTP Range server in the browser.
 *
 * On WASM, ByteSource::read() cannot block the main thread (Emscripten
 * condition_variable::wait_for is a no-op on the browser main thread).
 * So readBytes may fail if pieces aren't downloaded yet. The SW retries
 * with exponential backoff until data becomes available.
 */
'use strict';

const SW_VERSION = 4; // Bump to verify browser picked up new SW
console.log(`[SeekServe SW v${SW_VERSION}] loaded`);

const STREAM_URL_PATTERN = /^\/seekserve-stream\/([a-fA-F0-9]+)\/(\d+)$/;
const MAX_RETRY_MS = 5 * 60 * 1000; // 5 minutes total retry window
const INITIAL_DELAY_MS = 200;
const MAX_DELAY_MS = 2000;
const CHUNK_SIZE = 256 * 1024; // 256 KB chunks for streaming

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

  console.log(`[SeekServe SW v${SW_VERSION}] intercepted: ${url.pathname} range=${event.request.headers.get('Range') || 'none'}`);
  event.respondWith(handleStreamRequest(event.request, torrentId, fileIndex, name));
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Retry a sendToClient call with exponential backoff.
 * Uses a time-based limit (MAX_RETRY_MS) instead of a fixed retry count,
 * since WebTorrent (WebRTC) downloads can be slow.
 */
async function sendWithRetry(message) {
  let delay = INITIAL_DELAY_MS;
  const deadline = Date.now() + MAX_RETRY_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const result = await sendToClient(message);
      if (result.error === 0) return result;
    } catch (e) {
      // No controlled clients yet — retry after delay
      if (attempt <= 3 || attempt % 20 === 0) {
        console.log(`[SeekServe SW] sendToClient failed (attempt ${attempt}): ${e.message}`);
      }
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, MAX_DELAY_MS);
  }
  return { error: -1 };
}

/**
 * Handle a stream request by communicating with the main thread.
 */
async function handleStreamRequest(request, torrentId, fileIndex, fileName) {
  try {
    // Get file size (retry until metadata is ready)
    const sizeResult = await sendWithRetry({
      type: 'seekserve-getFileSize',
      torrentId: torrentId,
      fileIndex: fileIndex,
    });

    if (sizeResult.error !== 0) {
      return new Response('File not ready', { status: 503 });
    }

    const totalSize = sizeResult.size;
    const mimeType = guessMimeType(fileName);

    // Handle HEAD request
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Length': totalSize.toString(),
          'Content-Type': mimeType,
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

    // Use a ReadableStream to deliver data in chunks.
    // Each chunk retries until the WASM engine has the pieces.
    const stream = new ReadableStream({
      start(controller) {
        let offset = start;
        const remaining = () => end - offset + 1;

        async function pull() {
          while (remaining() > 0) {
            const chunkLen = Math.min(CHUNK_SIZE, remaining());
            const readResult = await sendWithRetry({
              type: 'seekserve-readBytes',
              torrentId: torrentId,
              fileIndex: fileIndex,
              offset: offset,
              length: chunkLen,
            });

            if (readResult.error !== 0) {
              controller.error(new Error('Read failed after retries'));
              return;
            }

            controller.enqueue(new Uint8Array(readResult.data));
            offset += chunkLen;
          }
          controller.close();
        }

        pull();
      },
    });

    const headers = {
      'Content-Length': length.toString(),
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    };

    if (isPartial) {
      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
      return new Response(stream, { status: 206, headers: headers });
    }

    return new Response(stream, { status: 200, headers: headers });
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
      console.warn(`[SeekServe SW] No controlled clients for ${message.type}`);
      reject(new Error('No controlled clients'));
      return;
    }

    const client = allClients[0];
    const channel = new MessageChannel();

    // Timeout: if main thread doesn't respond in 10s, return error
    const timer = setTimeout(() => {
      console.warn(`[SeekServe SW] Timeout waiting for ${message.type} response`);
      resolve({ error: -2 });
    }, 10000);

    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
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
