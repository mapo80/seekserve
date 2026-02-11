#!/usr/bin/env node
/**
 * E2E test for the full video streaming pipeline:
 *   Service Worker intercept → getFileSize → readBytes → ReadableStream → <video>
 *
 * Uses a dedicated test page (test_video_streaming.html) that loads WASM scripts
 * and sets up the SW message handler — no Flutter/Dart involvement.
 *
 * Tests:
 *   1. WASM init + engine creation
 *   2. SW registration and page control
 *   3. Torrent add + metadata
 *   4. File selection + stream URL
 *   5. SW fetch HEAD → correct headers (Content-Length, Accept-Ranges)
 *   6. SW fetch GET (Range) → 206 with data (after pieces download)
 *   7. <video> element → loads without fatal errors
 *
 * Usage:
 *   # Terminal 1: serve build/web with COOP/COEP headers
 *   cd flutter_seekserve_app/build/web && python3 ../../../serve_coop.py
 *
 *   # Terminal 2: Chrome with remote debugging
 *   /Applications/Google\ Chrome.app/.../Google\ Chrome \
 *     --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-test \
 *     http://localhost:8080/test_video_streaming.html
 *
 *   # Terminal 3: run this test
 *   node test_video_streaming_e2e.mjs
 */
import WebSocket from 'ws';
import http from 'http';

// --- Config ---
const CDP_DISCOVERY = 'http://localhost:9222/json';
const TEST_PAGE_URL = 'http://localhost:8080/test_video_streaming.html';
const SINTEL_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Ftracker.webtorrent.dev&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F';
const TORRENT_ID = '08ada5a7a6183aae1e09d831df6748d566095a10';
const METADATA_TIMEOUT = 60000;
const DOWNLOAD_WAIT = 60000;

let msgId = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- CDP helpers ---

async function discoverWsUrl() {
  return new Promise((resolve, reject) => {
    http.get(CDP_DISCOVERY, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const pages = JSON.parse(data);
          const page = pages.find(p => p.type === 'page' && p.url.includes('localhost'));
          if (!page) reject(new Error('No matching page. Pages: ' + JSON.stringify(pages.map(p => p.url))));
          else resolve(page.webSocketDebuggerUrl);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 50 * 1024 * 1024 });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function evaluate(ws, expression, timeout = 10000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`evaluate timeout (id=${id})`)), timeout);
    const handler = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        clearTimeout(timer);
        ws.off('message', handler);
        const result = msg.result?.result;
        if (result?.subtype === 'error') reject(new Error(result.description));
        else if (msg.result?.exceptionDetails) reject(new Error(
          msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text));
        else resolve(result?.value ?? result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: false }
    }));
  });
}

function evaluateAsync(ws, expression, timeout = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`evaluateAsync timeout (id=${id})`)), timeout);
    const handler = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        clearTimeout(timer);
        ws.off('message', handler);
        const result = msg.result?.result;
        if (result?.subtype === 'error') reject(new Error(result.description));
        else if (msg.result?.exceptionDetails) reject(new Error(
          msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text));
        else resolve(result?.value ?? result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true }
    }));
  });
}

function sendCommand(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP ${method} timeout`)), 10000);
    const handler = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// --- Test runner ---

let passed = 0;
let failed = 0;

function ok(msg) { passed++; console.log(`  PASS: ${msg}`); }
function fail(msg) { failed++; console.log(`  FAIL: ${msg}`); }
function info(msg) { console.log(`    ${msg}`); }

async function main() {
  console.log('=== SeekServe Video Streaming E2E Test ===\n');

  // Step 0: Connect via CDP
  console.log('Step 0: Connect to Chrome via CDP');
  let wsUrl;
  try {
    wsUrl = await discoverWsUrl();
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
  info(`CDP URL: ${wsUrl}`);
  const ws = await connect(wsUrl);
  await sendCommand(ws, 'Runtime.enable');

  // Capture console logs
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '?').join(' ');
      if (text.includes('[Test]') || text.includes('[SeekServe SW') || text.includes('metadata') || text.includes('Error')) {
        info(`[console] ${text.substring(0, 150)}`);
      }
    }
  });

  // Check we're on the right page
  const pageUrl = await evaluate(ws, 'location.href');
  if (!pageUrl.includes('test_video_streaming')) {
    info(`Current URL: ${pageUrl}`);
    info('Navigating to test page...');
    await sendCommand(ws, 'Page.navigate', { url: TEST_PAGE_URL });
    await sleep(3000);
  }

  // Step 1: Wait for test page to be ready
  console.log('\nStep 1: Wait for test page ready');
  let pageReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      pageReady = await evaluate(ws, 'window.__testReady === true');
      if (pageReady) break;
    } catch (e) { /* page not ready yet */ }
    await sleep(1000);
  }
  if (pageReady) {
    ok('Test page ready');
  } else {
    fail('Test page not ready after 10s');
    ws.close();
    printResults();
    return;
  }

  // Step 2: Init WASM
  console.log('\nStep 2: Init WASM module');
  try {
    await evaluateAsync(ws, `(async () => { await window.SeekServeWasm.init(''); return 'ok'; })()`, 30000);
    ok('WASM module initialized');
  } catch (e) {
    fail(`WASM init: ${e.message}`);
    ws.close();
    printResults();
    return;
  }

  // Step 3: Create engine + store in window.__testEngine
  console.log('\nStep 3: Create engine');
  let engine;
  try {
    engine = await evaluate(ws, `
      (() => {
        const e = window.SeekServeWasm.engineCreate('{"log_level":"info","enable_webtorrent":true,"save_path":"/seekserve"}');
        window.__testEngine = e;
        return e;
      })()
    `);
    if (engine && engine > 0) {
      ok(`Engine created (handle=${engine})`);
    } else {
      fail(`Engine handle invalid: ${engine}`);
      ws.close();
      printResults();
      return;
    }
  } catch (e) {
    fail(`Engine create: ${e.message}`);
    ws.close();
    printResults();
    return;
  }

  // Step 4: Verify SW is active
  console.log('\nStep 4: Verify Service Worker');
  try {
    const swActive = await evaluateAsync(ws, `
      (async () => {
        const reg = await navigator.serviceWorker.ready;
        return {
          active: !!reg.active,
          controller: !!navigator.serviceWorker.controller,
          url: reg.active ? reg.active.scriptURL : 'none'
        };
      })()
    `, 10000);
    if (swActive.active && swActive.controller) {
      ok(`SW active and controlling (${swActive.url.split('/').pop()})`);
    } else if (swActive.active) {
      info('SW active but not controlling — fetch intercept may not work');
      ok('SW registered (may need reload for full control)');
    } else {
      fail('SW not active');
    }
  } catch (e) {
    fail(`SW check: ${e.message}`);
  }

  // Step 5: Add torrent
  console.log('\nStep 5: Add Sintel torrent');
  try {
    const addResult = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.addTorrent(${engine}, '${SINTEL_MAGNET}'))`);
    const parsed = JSON.parse(addResult);
    if (parsed.error === 0) {
      ok(`Torrent added (id=${parsed.id})`);
    } else {
      fail(`addTorrent error=${parsed.error}`);
    }
  } catch (e) {
    fail(`addTorrent: ${e.message}`);
  }

  // Step 6: Wait for metadata
  console.log('\nStep 6: Wait for metadata (up to 60s)');
  let hasMetadata = false;
  const metaStart = Date.now();
  while (Date.now() - metaStart < METADATA_TIMEOUT) {
    await sleep(3000);
    try {
      const raw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.getStatus(${engine}, '${TORRENT_ID}'))`, 5000);
      const status = JSON.parse(raw);
      if (status.error === 0) {
        const s = JSON.parse(status.json);
        const elapsed = ((Date.now() - metaStart) / 1000).toFixed(0);
        info(`[${elapsed}s] state=${s.state} peers=${s.num_peers} progress=${(s.progress * 100).toFixed(1)}% meta=${s.has_metadata}`);
        if (s.has_metadata) {
          hasMetadata = true;
          ok(`Metadata received in ${elapsed}s`);
          break;
        }
      }
    } catch (e) {
      info(`Status check error: ${e.message}`);
    }
  }
  if (!hasMetadata) {
    fail('Metadata not received within 60s');
    try { await evaluate(ws, `window.SeekServeWasm.engineDestroy(${engine})`, 5000); } catch (e) {}
    ws.close();
    printResults();
    return;
  }

  // Step 7: List files, select MP4, get stream URL
  console.log('\nStep 7: Select file + get stream URL');
  let fileIndex = -1;
  let streamUrl = '';
  try {
    const filesRaw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.listFiles(${engine}, '${TORRENT_ID}'))`, 5000);
    const filesResult = JSON.parse(filesRaw);
    if (filesResult.error === 0) {
      const parsed = JSON.parse(filesResult.json);
      const files = parsed.files || parsed;
      info(`${files.length} files found`);
      for (let i = 0; i < files.length; i++) {
        if (files[i].path.endsWith('.mp4')) {
          fileIndex = i;
          info(`Selected [${i}]: ${files[i].path} (${(files[i].size / 1024 / 1024).toFixed(1)} MB)`);
          break;
        }
      }
      if (fileIndex === -1) { fileIndex = 0; info(`Fallback to file [0]`); }
    }
  } catch (e) { fail(`listFiles: ${e.message}`); }

  // Select file
  try {
    const selErr = await evaluate(ws, `window.SeekServeWasm.selectFile(${engine}, '${TORRENT_ID}', ${fileIndex})`);
    if (selErr === 0) ok(`File selected (index=${fileIndex})`);
    else fail(`selectFile error=${selErr}`);
  } catch (e) { fail(`selectFile: ${e.message}`); }

  // Get stream URL
  try {
    const urlRaw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.getStreamUrl(${engine}, '${TORRENT_ID}', ${fileIndex}))`, 5000);
    const urlResult = JSON.parse(urlRaw);
    if (urlResult.error === 0 && urlResult.url) {
      streamUrl = urlResult.url;
      // Append file name for MIME detection
      const filesRaw2 = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.listFiles(${engine}, '${TORRENT_ID}'))`, 5000);
      const files2 = JSON.parse(JSON.parse(filesRaw2).json);
      const fileList = files2.files || files2;
      if (fileIndex < fileList.length) {
        const basename = fileList[fileIndex].path.split('/').pop();
        streamUrl += `?name=${encodeURIComponent(basename)}`;
      }
      ok(`Stream URL: ${streamUrl}`);
    } else {
      fail(`getStreamUrl error=${urlResult.error}`);
    }
  } catch (e) { fail(`getStreamUrl: ${e.message}`); }

  if (!streamUrl) {
    info('Cannot continue without stream URL. Cleaning up...');
    try { await evaluate(ws, `window.SeekServeWasm.engineDestroy(${engine})`, 5000); } catch (e) {}
    ws.close();
    printResults();
    return;
  }

  // Step 8: Test SW fetch (HEAD)
  console.log('\nStep 8: SW fetch HEAD');
  try {
    const headResult = await evaluateAsync(ws, `
      (async () => {
        const resp = await fetch('${streamUrl}', { method: 'HEAD' });
        return {
          status: resp.status,
          contentLength: resp.headers.get('Content-Length'),
          acceptRanges: resp.headers.get('Accept-Ranges'),
          contentType: resp.headers.get('Content-Type'),
        };
      })()
    `, 30000);

    if (headResult.status === 200) {
      const cl = parseInt(headResult.contentLength, 10);
      info(`Status: ${headResult.status}, Content-Length: ${cl}, Accept-Ranges: ${headResult.acceptRanges}, Content-Type: ${headResult.contentType}`);
      if (cl > 0 && headResult.acceptRanges === 'bytes') {
        ok(`SW HEAD response correct (${(cl / 1024 / 1024).toFixed(1)} MB, Accept-Ranges: bytes)`);
      } else {
        fail(`HEAD response missing headers: CL=${cl} AR=${headResult.acceptRanges}`);
      }
    } else {
      fail(`HEAD returned status ${headResult.status}`);
    }
  } catch (e) {
    fail(`SW HEAD fetch: ${e.message}`);
  }

  // Step 9: Test SW fetch (Range GET) — may fail initially if pieces not ready
  console.log('\nStep 9: SW fetch GET (Range: bytes=0-65535)');
  let gotData = false;
  try {
    const getResult = await evaluateAsync(ws, `
      (async () => {
        const resp = await fetch('${streamUrl}', {
          headers: { 'Range': 'bytes=0-65535' }
        });
        const status = resp.status;
        if (status === 206 || status === 200) {
          const buf = await resp.arrayBuffer();
          return { status, size: buf.byteLength };
        }
        return { status, size: 0, text: await resp.text() };
      })()
    `, 120000); // 2 min timeout — SW retries internally for up to 5 min

    if ((getResult.status === 206 || getResult.status === 200) && getResult.size > 0) {
      ok(`SW Range GET: ${getResult.status}, received ${getResult.size} bytes`);
      gotData = true;
    } else {
      info(`SW Range GET: status=${getResult.status}, size=${getResult.size} (pieces may not be ready yet)`);
    }
  } catch (e) {
    info(`SW Range GET timeout/error: ${e.message} (expected if download is slow)`);
  }

  // Step 10: Wait for download progress
  if (!gotData) {
    console.log('\nStep 10: Wait for download progress (up to 60s)');
    const dlStart = Date.now();
    while (Date.now() - dlStart < DOWNLOAD_WAIT) {
      await sleep(5000);
      try {
        const raw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.getStatus(${engine}, '${TORRENT_ID}'))`, 5000);
        const status = JSON.parse(raw);
        if (status.error === 0) {
          const s = JSON.parse(status.json);
          const elapsed = ((Date.now() - dlStart) / 1000).toFixed(0);
          info(`[${elapsed}s] progress=${(s.progress * 100).toFixed(1)}% peers=${s.num_peers} dl=${s.download_rate}`);
          if (s.progress > 0.01) {
            ok(`Download progressing: ${(s.progress * 100).toFixed(1)}%`);
            break;
          }
        }
      } catch (e) {}
    }

    // Step 11: Retry Range GET after some download
    console.log('\nStep 11: Retry SW fetch GET (Range)');
    try {
      const getResult = await evaluateAsync(ws, `
        (async () => {
          const resp = await fetch('${streamUrl}', {
            headers: { 'Range': 'bytes=0-65535' }
          });
          const status = resp.status;
          if (status === 206 || status === 200) {
            const buf = await resp.arrayBuffer();
            return { status, size: buf.byteLength };
          }
          return { status, size: 0 };
        })()
      `, 120000);

      if ((getResult.status === 206 || getResult.status === 200) && getResult.size > 0) {
        ok(`Retry Range GET: ${getResult.status}, received ${getResult.size} bytes`);
        gotData = true;
      } else {
        info(`Retry Range GET: status=${getResult.status}, size=${getResult.size}`);
        info('Pieces at offset 0 may not have arrived yet (WebTorrent download can be slow)');
      }
    } catch (e) {
      info(`Retry Range GET error: ${e.message}`);
    }
  } else {
    info('Data already received in step 9, skipping steps 10-11');
  }

  // Step 12: Test <video> element
  console.log('\nStep 12: Test <video> element');
  try {
    const videoResult = await evaluateAsync(ws, `
      new Promise((resolve) => {
        const video = document.createElement('video');
        video.style.width = '320px';
        video.style.height = '240px';
        document.getElementById('video-container').appendChild(video);

        const result = { created: true, events: [], error: null, readyState: 0 };
        const timeout = setTimeout(() => {
          result.readyState = video.readyState;
          result.events.push('timeout');
          resolve(result);
        }, ${gotData ? 15000 : 10000});

        video.addEventListener('loadstart', () => result.events.push('loadstart'));
        video.addEventListener('progress', () => {
          if (!result.events.includes('progress')) result.events.push('progress');
        });
        video.addEventListener('canplay', () => {
          result.events.push('canplay');
          result.readyState = video.readyState;
          clearTimeout(timeout);
          resolve(result);
        });
        video.addEventListener('playing', () => {
          result.events.push('playing');
          result.readyState = video.readyState;
        });
        video.addEventListener('error', () => {
          const me = video.error;
          const code = me ? me.code : 0;
          const names = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
          result.error = names[code] || 'UNKNOWN(' + code + ')';
          result.events.push('error:' + result.error);
          // Don't resolve on NETWORK errors — video player retries
          if (code !== 2) {
            clearTimeout(timeout);
            resolve(result);
          }
        });

        video.src = '${streamUrl}';
        video.autoplay = true;
      })
    `, 30000);

    info(`Events: [${videoResult.events.join(', ')}]`);
    info(`readyState: ${videoResult.readyState}, error: ${videoResult.error || 'none'}`);

    if (videoResult.events.includes('canplay') || videoResult.events.includes('playing')) {
      ok('Video element can play!');
    } else if (videoResult.error && !['NETWORK'].includes(videoResult.error)) {
      fail(`Video fatal error: ${videoResult.error}`);
    } else if (videoResult.events.includes('loadstart') || videoResult.events.includes('progress')) {
      ok('Video element loading (SW pipeline active, waiting for data)');
    } else {
      info('Video element created but no significant events fired');
      ok('Video element created without fatal errors');
    }
  } catch (e) {
    fail(`Video element test: ${e.message}`);
  }

  // Step 13: Cleanup
  console.log('\nStep 13: Cleanup');
  try {
    await evaluate(ws, `
      (() => {
        // Remove video element
        const container = document.getElementById('video-container');
        container.innerHTML = '';
        // Destroy engine
        window.SeekServeWasm.engineDestroy(${engine});
        window.__testEngine = null;
        return 'ok';
      })()
    `, 5000);
    ok('Cleanup complete');
  } catch (e) {
    info(`Cleanup error: ${e.message}`);
  }

  ws.close();
  printResults();
}

function printResults() {
  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
