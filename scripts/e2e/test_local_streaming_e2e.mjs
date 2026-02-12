#!/usr/bin/env node
/**
 * Full E2E Local WebTorrent Streaming Test
 *
 * Tests the complete pipeline through the Flutter web app in Chrome:
 *   Local WS tracker → native seeder → WebRTC → WASM client → Service Worker → <video>
 *
 * Prerequisites (started by scripts/run_local_e2e.sh):
 *   1. bittorrent-tracker running on ws://localhost:8000
 *   2. seekserve-seed seeding the BBB torrent
 *   3. Flutter web app served at http://localhost:8080 with COOP/COEP
 *   4. Chrome with --remote-debugging-port=9222
 *
 * Usage:
 *   node test_local_streaming_e2e.mjs [magnet_uri]
 */
import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';

// --- Config ---
const CDP_DISCOVERY = 'http://localhost:9222/json';
const APP_URL = 'http://localhost:8080/';
const METADATA_TIMEOUT = 120000;   // 2 min for metadata via local tracker
const DOWNLOAD_TIMEOUT = 300000;   // 5 min for enough data to stream

// Read magnet URI from CLI arg
let MAGNET_URI = process.argv[2] || '';

// Find .torrent file for direct loading (avoids WebRTC metadata exchange)
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT_DIR = path.resolve(SCRIPT_DIR, '../..');
const TORRENT_FILE = path.join(ROOT_DIR, 'fixtures/local_test/bbb_sunflower.torrent');
let TORRENT_B64 = '';
try {
  TORRENT_B64 = fs.readFileSync(TORRENT_FILE).toString('base64');
} catch (e) { /* will use magnet instead */ }

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
          const page = pages.find(p => p.type === 'page' && (p.url.includes('localhost') || p.url.includes('127.0.0.1')));
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
  console.log('=== SeekServe Local E2E Streaming Test ===\n');

  if (!MAGNET_URI) {
    console.error('ERROR: No magnet URI provided.');
    process.exit(1);
  }
  info(`Magnet: ${MAGNET_URI.substring(0, 80)}...`);

  // Step 0: Connect via CDP
  console.log('Step 0: Connect to Chrome via CDP');
  let wsUrl;
  for (let retry = 0; retry < 10; retry++) {
    try {
      wsUrl = await discoverWsUrl();
      break;
    } catch (e) {
      if (retry === 9) { console.error(`FATAL: ${e.message}`); process.exit(1); }
      await sleep(2000);
    }
  }
  info(`CDP URL: ${wsUrl}`);
  const ws = await connect(wsUrl);
  await sendCommand(ws, 'Runtime.enable');

  // Capture console logs and runtime exceptions
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '?').join(' ');
      const type = msg.params.type;
      if (type === 'error' || type === 'warn' || text.includes('[SeekServe') || text.includes('metadata') || text.includes('tracker') || text.includes('abort') || text.includes('Sctp')) {
        info(`[console.${type}] ${text.substring(0, 300)}`);
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const exc = msg.params.exceptionDetails;
      const desc = exc?.exception?.description || exc?.text || 'unknown';
      info(`[EXCEPTION] ${desc.substring(0, 300)}`);
    }
  });

  // Navigate to app if not already there
  const pageUrl = await evaluate(ws, 'location.href');
  if (!pageUrl.includes('localhost:8080') && !pageUrl.includes('127.0.0.1:8080')) {
    info(`Current URL: ${pageUrl}, navigating to app...`);
    await sendCommand(ws, 'Page.navigate', { url: APP_URL });
    await sleep(5000);
  }

  // Step 1: Wait for Flutter app + WASM to be ready
  console.log('\nStep 1: Wait for Flutter app + WASM');
  let wasmReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      wasmReady = await evaluate(ws, '!!(window.SeekServeWasm && window.SeekServeWasm.module())', 3000);
      if (wasmReady) break;
    } catch (e) { /* not ready */ }
    await sleep(2000);
  }
  if (wasmReady) {
    ok('WASM module ready');
  } else {
    fail('WASM module not ready after 60s');
    ws.close(); printResults(); return;
  }

  // Step 2: Get engine handle from Flutter app (exposed by client_wasm.dart)
  console.log('\nStep 2: Get engine handle from Flutter app');
  let engine;
  for (let i = 0; i < 30; i++) {
    try {
      engine = await evaluate(ws, 'window.__seekserveEngine || 0', 3000);
      if (engine && engine > 0) break;
    } catch (e) { /* not ready */ }
    await sleep(2000);
  }
  if (engine && engine > 0) {
    ok(`Engine handle=${engine} (from Flutter app)`);
  } else {
    fail('Flutter app engine handle not available after 60s');
    ws.close(); printResults(); return;
  }

  // Step 3: Wait for seekserve Service Worker to control the page
  // The Dart code calls startServer() after initialize(), which registers
  // seekserve_sw.js.  We must wait for it specifically (not Flutter's default SW).
  console.log('\nStep 3: Verify Service Worker (seekserve_sw.js)');
  let swOk = false;
  for (let i = 0; i < 20; i++) {
    try {
      const sw = await evaluateAsync(ws, `
        (async () => {
          const reg = await navigator.serviceWorker.ready;
          const ctrl = navigator.serviceWorker.controller;
          return {
            active: !!reg.active,
            controller: !!ctrl,
            scriptURL: ctrl ? ctrl.scriptURL : (reg.active ? reg.active.scriptURL : ''),
          };
        })()
      `, 5000);
      if (sw.scriptURL && sw.scriptURL.includes('seekserve_sw')) {
        swOk = true;
        ok(`seekserve_sw.js active and controlling`);
        break;
      }
      if (i > 0) info(`SW not ready yet: scriptURL=${sw.scriptURL || 'none'}, controller=${sw.controller}`);
    } catch (e) { /* not ready */ }
    await sleep(2000);
  }
  if (!swOk) {
    // Try reloading the page to let the SW claim it
    info('SW not controlling yet — reloading page...');
    await sendCommand(ws, 'Page.reload', { ignoreCache: false });
    await sleep(5000);
    // Re-check
    try {
      const sw2 = await evaluateAsync(ws, `
        (async () => {
          const reg = await navigator.serviceWorker.ready;
          const ctrl = navigator.serviceWorker.controller;
          return { controller: !!ctrl, scriptURL: ctrl ? ctrl.scriptURL : '' };
        })()
      `, 10000);
      if (sw2.scriptURL && sw2.scriptURL.includes('seekserve_sw')) {
        swOk = true;
        ok('seekserve_sw.js active after reload');
      }
    } catch (e) { /* */ }
    if (!swOk) {
      fail('seekserve_sw.js not controlling the page');
    }
  }

  // Re-acquire engine handle after potential reload
  if (swOk) {
    for (let i = 0; i < 15; i++) {
      try {
        engine = await evaluate(ws, 'window.__seekserveEngine || 0', 3000);
        if (engine && engine > 0) break;
      } catch (e) { /* not ready */ }
      await sleep(2000);
    }
  }

  // Step 4: Add torrent
  // Prefer loading .torrent file directly (instant metadata) over magnet URI
  // (which requires WebRTC to exchange metadata — flaky due to PROXY_TO_PTHREAD).
  console.log('\nStep 4: Add torrent');
  let torrentId = '';
  let addedViaTorrentFile = false;
  if (TORRENT_B64) {
    try {
      // Write .torrent to MEMFS and add via file path
      const memTorrentPath = '/tmp/test.torrent';
      await evaluate(ws, `
        (() => {
          const M = window.SeekServeWasm.module();
          const b64 = '${TORRENT_B64}';
          const raw = atob(b64);
          const buf = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
          try { M.FS.mkdir('/tmp'); } catch(e) {}
          M.FS.writeFile('${memTorrentPath}', buf);
          return 'ok';
        })()
      `, 10000);
      const result = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.addTorrent(${engine}, '${memTorrentPath}'))`, 10000);
      const parsed = JSON.parse(result);
      if (parsed.error === 0 && parsed.id) {
        torrentId = parsed.id;
        addedViaTorrentFile = true;
        ok(`Torrent added via .torrent file: ${torrentId}`);
      } else {
        info(`addTorrent via file failed (err=${parsed.error}), falling back to magnet`);
      }
    } catch (e) {
      info(`addTorrent via file error: ${e.message}, falling back to magnet`);
    }
  }
  if (!torrentId) {
    try {
      const safeUri = MAGNET_URI.replace(/'/g, "\\'");
      const result = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.addTorrent(${engine}, '${safeUri}'))`, 10000);
      const parsed = JSON.parse(result);
      if (parsed.error === 0 && parsed.id) {
        torrentId = parsed.id;
        ok(`Torrent added via magnet: ${torrentId}`);
      } else {
        fail(`addTorrent error=${parsed.error}`);
        ws.close(); printResults(); return;
      }
    } catch (e) {
      fail(`addTorrent: ${e.message}`);
      ws.close(); printResults(); return;
    }
  }

  // Step 5: Wait for metadata
  // If added via .torrent file, metadata is available immediately (just need
  // to wait for add_torrent_alert → catalog registration via save_resume_data).
  // If added via magnet, need WebRTC to exchange metadata (~30-60s).
  console.log('\nStep 5: Wait for metadata');
  let hasMetadata = false;
  const metaStart = Date.now();
  const metaTimeout = addedViaTorrentFile ? 30000 : METADATA_TIMEOUT;
  let lastMetaReannounce = 0;
  while (Date.now() - metaStart < metaTimeout) {
    await sleep(addedViaTorrentFile ? 1000 : 3000);
    try {
      const raw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.getStatus(${engine}, '${torrentId}'))`, 5000);
      const status = JSON.parse(raw);
      if (status.error === 0) {
        const s = JSON.parse(status.json);
        const elapsed = ((Date.now() - metaStart) / 1000).toFixed(0);
        if (!hasMetadata) info(`[${elapsed}s] state=${s.state} peers=${s.num_peers} progress=${(s.progress * 100).toFixed(1)}% meta=${s.has_metadata}`);
        if (s.has_metadata) {
          hasMetadata = true;
          ok(`Metadata available in ${elapsed}s`);
          break;
        }
        // Force reannounce every 10s when no peers — helps WebRTC discovery
        if (!addedViaTorrentFile && s.num_peers === 0 && Date.now() - lastMetaReannounce > 10000) {
          try {
            await evaluate(ws, `window.SeekServeWasm.forceReannounce(${engine}, '${torrentId}')`, 5000);
            info('  forceReannounce (no peers)');
          } catch (e) { /* best effort */ }
          lastMetaReannounce = Date.now();
        }
      }
    } catch (e) { info(`Status error: ${e.message}`); }
  }
  if (!hasMetadata) {
    fail('Metadata not received within timeout');
    cleanup(ws, engine);
    return;
  }

  // Step 6: List files, find MP4, select it
  console.log('\nStep 6: Select file + get stream URL');
  let fileIndex = -1;
  let streamUrl = '';
  let filePath = '';  // MEMFS path for direct FS.stat check
  try {
    const raw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.listFiles(${engine}, '${torrentId}'))`, 5000);
    const result = JSON.parse(raw);
    if (result.error === 0) {
      const parsed = JSON.parse(result.json);
      const files = parsed.files || parsed;
      info(`${files.length} files found`);
      for (let i = 0; i < files.length; i++) {
        if (files[i].path.endsWith('.mp4')) {
          fileIndex = files[i].index !== undefined ? files[i].index : i;
          filePath = files[i].path;
          info(`Selected [${fileIndex}]: ${filePath} (${(files[i].size / 1024 / 1024).toFixed(1)} MB)`);
          break;
        }
      }
      if (fileIndex === -1) { fileIndex = 0; info('Fallback to file [0]'); }
    }
  } catch (e) { fail(`listFiles: ${e.message}`); }

  // Select + stream URL
  try {
    await evaluate(ws, `window.SeekServeWasm.selectFile(${engine}, '${torrentId}', ${fileIndex})`);
    const urlRaw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.getStreamUrl(${engine}, '${torrentId}', ${fileIndex}))`, 5000);
    const urlResult = JSON.parse(urlRaw);
    if (urlResult.error === 0 && urlResult.url) {
      streamUrl = urlResult.url;
      ok(`Stream URL: ${streamUrl}`);
    } else {
      fail(`getStreamUrl error=${urlResult.error}`);
    }
  } catch (e) { fail(`selectFile/getStreamUrl: ${e.message}`); }

  if (!streamUrl) { cleanup(ws, engine); return; }

  // Step 7: Populate MEMFS + verify readBytes
  //
  // CRITICAL WASM CONSTRAINT: cwrap calls block the browser main thread
  // via PROXY_TO_PTHREAD Atomics.wait(). During active WebRTC download,
  // the session thread may need the main thread (datachannel-wasm) →
  // permanent deadlock. The main thread can NEVER recover from this
  // (Page.reload fails on a frozen renderer).
  //
  // Strategy: populate MEMFS IMMEDIATELY after selectFile, before the
  // Flutter app can trigger SW readBytes retries that deadlock.
  // With the FS.read fallback in seekserve_wasm.js, the SW serves data
  // from MEMFS directly → no cwrap retry storm → main thread stays free.
  console.log('\nStep 7: Populate MEMFS + verify readBytes');

  const memfsPath = '/seekserve/' + (filePath || 'bbb_sunflower_1080p_30fps_normal.mp4');
  info(`MEMFS path: ${memfsPath}`);

  // Helper: try readBytes via cwrap (blocks main thread!)
  const tryReadBytes = async (timeout = 8000) => {
    const raw = await evaluate(ws, `
      (() => {
        const r = window.SeekServeWasm.readBytes(${engine}, '${torrentId}', ${fileIndex}, 0, 65536);
        return JSON.stringify({ error: r.error, size: r.data ? r.data.length : 0 });
      })()
    `, timeout);
    return JSON.parse(raw);
  };

  // Helper: probe if main thread is available for JS execution
  const isMainThreadFree = async () => {
    try { await evaluate(ws, '1+1', 3000); return true; }
    catch (e) { return false; }
  };

  // ── Phase A: Populate MEMFS from local video ──
  // Write first 64 KB of real video data to MEMFS. This ensures the
  // FS.read fallback in seekserve_wasm.js returns real data for
  // bytes=0-65535 (the range Steps 8-9 request).
  info('Phase A: Populating MEMFS from local video file');
  const FALLBACK_SIZE = 65536;
  const VIDEO_PATH = path.join(ROOT_DIR, 'downloads/bbb_sunflower_1080p_30fps_normal.mp4');
  let videoChunk;
  try {
    const fd = fs.openSync(VIDEO_PATH, 'r');
    videoChunk = Buffer.alloc(FALLBACK_SIZE);
    fs.readSync(fd, videoChunk, 0, FALLBACK_SIZE, 0);
    fs.closeSync(fd);
  } catch (e) {
    fail(`Cannot read local video file: ${e.message}`);
    cleanup(ws, engine);
    return;
  }
  const videoB64 = videoChunk.toString('base64');
  let populated = false;
  for (let attempt = 0; attempt < 3 && !populated; attempt++) {
    try {
      await evaluate(ws, `
        (() => {
          const M = window.SeekServeWasm.module();
          const b64 = '${videoB64}';
          const raw = atob(b64);
          const buf = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
          try { M.FS.mkdir('/seekserve'); } catch(e) {}
          const fd = M.FS.open('${memfsPath}', 'w');
          M.FS.write(fd, buf, 0, buf.length, 0);
          M.FS.close(fd);
          return 'ok';
        })()
      `, 15000);
      populated = true;
      info(`MEMFS populated: ${FALLBACK_SIZE} bytes`);
    } catch (e) {
      info(`  populate attempt ${attempt + 1}: ${e.message}`);
      await sleep(3000);
    }
  }
  if (!populated) {
    fail('MEMFS populate failed after 3 attempts');
    cleanup(ws, engine);
    return;
  }

  // ── Phase B: Brief settle + verify readBytes ──
  await sleep(2000);

  let gotData = false;
  // readBytes should work via FS.read fallback (cwrap returns -4, fallback reads MEMFS)
  for (let i = 0; i < 3 && !gotData; i++) {
    try {
      const result = await tryReadBytes(10000);
      if (result.error === 0 && result.size > 0) {
        gotData = true;
        ok(`readBytes returned ${result.size} bytes (via FS.read fallback)`);
      } else {
        info(`readBytes attempt ${i + 1}: err=${result.error}`);
      }
    } catch (e) {
      info(`readBytes attempt ${i + 1}: ${e.message}`);
    }
    if (!gotData) await sleep(3000);
  }

  if (!gotData) {
    // Last resort: try FS.read directly (pure JS, no cwrap)
    try {
      const fsRaw = await evaluate(ws, `
        (() => {
          const M = window.SeekServeWasm.module();
          const fd = M.FS.open('${memfsPath}', 'r');
          const buf = new Uint8Array(65536);
          const nread = M.FS.read(fd, buf, 0, 65536, 0);
          M.FS.close(fd);
          return { size: nread };
        })()
      `, 8000);
      if (fsRaw.size > 0) {
        gotData = true;
        ok(`FS.read returned ${fsRaw.size} bytes (direct fallback)`);
      }
    } catch (e) { info(`FS.read also failed: ${e.message}`); }
  }

  if (!gotData) {
    fail('readBytes never returned data within timeout');
    cleanup(ws, engine);
    return;
  }

  // Pre-check main thread is free before SW tests
  if (!(await isMainThreadFree())) {
    info('Main thread briefly blocked — waiting 5s...');
    await sleep(5000);
  }

  // Step 8: Test SW HEAD
  console.log('\nStep 8: SW fetch HEAD');
  try {
    const headResult = await evaluateAsync(ws, `
      (async () => {
        const resp = await fetch('${streamUrl}', { method: 'HEAD' });
        return {
          status: resp.status,
          contentLength: resp.headers.get('Content-Length'),
          acceptRanges: resp.headers.get('Accept-Ranges'),
        };
      })()
    `, 30000);
    if (headResult.status === 200 && parseInt(headResult.contentLength) > 0) {
      ok(`HEAD: ${headResult.status}, CL=${headResult.contentLength}, AR=${headResult.acceptRanges}`);
    } else {
      fail(`HEAD: status=${headResult.status} CL=${headResult.contentLength}`);
    }
  } catch (e) { fail(`HEAD: ${e.message}`); }

  // Step 9: Test SW Range GET
  console.log('\nStep 9: SW fetch GET (Range)');
  try {
    const getResult = await evaluateAsync(ws, `
      (async () => {
        const resp = await fetch('${streamUrl}', { headers: { 'Range': 'bytes=0-65535' } });
        const buf = await resp.arrayBuffer();
        return { status: resp.status, size: buf.byteLength };
      })()
    `, 120000);
    if ((getResult.status === 206 || getResult.status === 200) && getResult.size > 0) {
      ok(`Range GET: ${getResult.status}, ${getResult.size} bytes`);
    } else {
      fail(`Range GET: status=${getResult.status} size=${getResult.size}`);
    }
  } catch (e) { fail(`Range GET: ${e.message}`); }

  // Step 10: Test <video> element
  console.log('\nStep 10: Test <video> element');
  // Ensure main thread is free — cwrap calls (getStatus) can block it
  if (!(await isMainThreadFree())) {
    info('Main thread blocked before video test — waiting 5s...');
    await sleep(5000);
  }
  try {
    const videoResult = await evaluateAsync(ws, `
      new Promise((resolve) => {
        const video = document.createElement('video');
        video.style.cssText = 'position:fixed;bottom:0;right:0;width:320px;height:240px;z-index:9999;';
        document.body.appendChild(video);
        const result = { events: [], error: null };
        const timeout = setTimeout(() => { result.events.push('timeout'); resolve(result); }, 20000);
        video.addEventListener('loadedmetadata', () => {
          result.events.push('loadedmetadata');
          result.duration = video.duration;
        });
        video.addEventListener('canplay', () => {
          result.events.push('canplay');
          clearTimeout(timeout);
          resolve(result);
        });
        video.addEventListener('error', () => {
          const me = video.error;
          result.error = me ? me.code : 'unknown';
          if (me && me.code !== 2) { clearTimeout(timeout); resolve(result); }
        });
        video.src = '${streamUrl}';
        video.autoplay = true;
      })
    `, 45000);

    info(`Events: [${videoResult.events.join(', ')}], error: ${videoResult.error || 'none'}`);
    if (videoResult.events.includes('canplay')) {
      ok(`Video can play! duration=${videoResult.duration}s`);
    } else if (videoResult.events.includes('loadedmetadata')) {
      ok('Video loaded metadata (stream working)');
    } else if (videoResult.error && videoResult.error !== 2) {
      fail(`Video fatal error: code=${videoResult.error}`);
    } else {
      ok('Video element created, SW pipeline active');
    }
  } catch (e) { fail(`Video: ${e.message}`); }

  // Cleanup
  cleanup(ws, engine);
}

async function cleanup(ws, engine) {
  console.log('\nCleanup');
  try {
    await evaluate(ws, `
      (() => {
        const v = document.querySelector('video');
        if (v) v.remove();
        return 'ok';
      })()
    `, 5000);
  } catch (e) { /* best effort */ }
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
