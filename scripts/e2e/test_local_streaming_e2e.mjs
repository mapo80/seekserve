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

// Read magnet URI from CLI arg or from the torrent file
let MAGNET_URI = process.argv[2] || '';

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
  console.log('=== SeekServe Local E2E Streaming Test ===\n');

  if (!MAGNET_URI) {
    console.error('ERROR: No magnet URI provided. Run scripts/create_test_torrent.py first and pass the magnet URI.');
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

  // Capture console logs
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '?').join(' ');
      if (text.includes('[SeekServe') || text.includes('metadata') || text.includes('WebRTC') || text.includes('tracker') || text.includes('Error')) {
        info(`[console] ${text.substring(0, 200)}`);
      }
    }
  });

  // Navigate to app if not already there
  const pageUrl = await evaluate(ws, 'location.href');
  if (!pageUrl.includes('localhost:8080')) {
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

  // Step 3: Verify Service Worker
  console.log('\nStep 3: Verify Service Worker');
  try {
    const sw = await evaluateAsync(ws, `
      (async () => {
        const reg = await navigator.serviceWorker.ready;
        return { active: !!reg.active, controller: !!navigator.serviceWorker.controller };
      })()
    `, 10000);
    if (sw.active) ok('Service Worker active');
    else fail('Service Worker not active');
  } catch (e) { fail(`SW: ${e.message}`); }

  // Step 4: Add torrent via magnet
  console.log('\nStep 4: Add torrent');
  let torrentId = '';
  try {
    const safeUri = MAGNET_URI.replace(/'/g, "\\'");
    const result = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.addTorrent(${engine}, '${safeUri}'))`, 10000);
    const parsed = JSON.parse(result);
    if (parsed.error === 0 && parsed.id) {
      torrentId = parsed.id;
      ok(`Torrent added: ${torrentId}`);
    } else {
      fail(`addTorrent error=${parsed.error}`);
      ws.close(); printResults(); return;
    }
  } catch (e) {
    fail(`addTorrent: ${e.message}`);
    ws.close(); printResults(); return;
  }

  // Step 5: Wait for metadata (from native seeder via WS tracker)
  console.log('\nStep 5: Wait for metadata');
  let hasMetadata = false;
  const metaStart = Date.now();
  while (Date.now() - metaStart < METADATA_TIMEOUT) {
    await sleep(3000);
    try {
      const raw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.getStatus(${engine}, '${torrentId}'))`, 5000);
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
          info(`Selected [${fileIndex}]: ${files[i].path} (${(files[i].size / 1024 / 1024).toFixed(1)} MB)`);
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

  // Step 7: Wait for data to arrive (readBytes returns real data)
  console.log('\nStep 7: Wait for download (readBytes)');
  let gotData = false;
  const dlStart = Date.now();
  while (Date.now() - dlStart < DOWNLOAD_TIMEOUT) {
    try {
      const raw = await evaluate(ws, `
        (() => {
          const r = window.SeekServeWasm.readBytes(${engine}, '${torrentId}', ${fileIndex}, 0, 65536);
          return JSON.stringify({ error: r.error, size: r.data ? r.data.length : 0 });
        })()
      `, 10000);
      const result = JSON.parse(raw);
      if (result.error === 0 && result.size > 0) {
        gotData = true;
        ok(`readBytes returned ${result.size} bytes`);
        break;
      }
      // Also log download progress
      const statusRaw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.getStatus(${engine}, '${torrentId}'))`, 5000);
      const status = JSON.parse(statusRaw);
      if (status.error === 0) {
        const s = JSON.parse(status.json);
        const elapsed = ((Date.now() - dlStart) / 1000).toFixed(0);
        info(`[${elapsed}s] progress=${(s.progress * 100).toFixed(1)}% peers=${s.num_peers} dl=${s.download_rate} readBytes.err=${result.error}`);
      }
    } catch (e) { info(`readBytes poll error: ${e.message}`); }
    await sleep(5000);
  }
  if (!gotData) {
    fail('readBytes never returned data within timeout');
    cleanup(ws, engine);
    return;
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
    `, 30000);

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
        // Don't destroy engine — it belongs to the Flutter app.
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
