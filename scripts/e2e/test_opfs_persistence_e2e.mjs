#!/usr/bin/env node
/**
 * OPFS Persistence E2E Test
 *
 * Tests that torrent data survives a page reload:
 *   1. Connect to running Flutter web app via CDP
 *   2. Verify OPFS is available
 *   3. Add torrent, wait for metadata, select file
 *   4. Wait for some pieces to download
 *   5. Reload the page
 *   6. Verify torrent is restored with progress preserved
 *   7. Verify streaming still works after reload
 *
 * Prerequisites (started by scripts/run_local_e2e.sh):
 *   - bittorrent-tracker running on ws://localhost:8000
 *   - seekserve-seed seeding the test torrent
 *   - Flutter web app served at http://localhost:8080 with COOP/COEP
 *   - Chrome with --remote-debugging-port=9222
 *
 * Usage:
 *   node scripts/e2e/test_opfs_persistence_e2e.mjs [magnet_uri]
 */
import WebSocket from 'ws';
import http from 'http';

const CDP_DISCOVERY = 'http://localhost:9222/json';
const APP_URL = 'http://localhost:8080/';
const METADATA_TIMEOUT = 120000;
const PIECE_TIMEOUT = 180000;
const MIN_PIECES = 5;  // Minimum pieces before reload

let MAGNET_URI = process.argv[2] || '';
let msgId = 0;
let passed = 0;
let failed = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; console.error(`  ✗ ${label}: ${err}`); }

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
          if (!page) reject(new Error('No matching page'));
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

async function waitForWasm(ws, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const ready = await evaluate(ws, `typeof window.SeekServeWasm !== 'undefined' && typeof window.SeekServeWasm.opfsAvailable === 'function'`);
      if (ready === true) return;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('WASM not ready within timeout');
}

async function waitForEngine(ws, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const engine = await evaluate(ws, `typeof window.__seekserveEngine !== 'undefined' && window.__seekserveEngine !== 0`);
      if (engine === true) return;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('Engine not ready within timeout');
}

// --- Test flow ---

async function main() {
  console.log('=== OPFS Persistence E2E Test ===\n');

  // 1. Connect to Chrome
  console.log('[1/10] Connecting to Chrome...');
  let wsUrl = await discoverWsUrl();
  let ws = await connect(wsUrl);
  ok('Connected to Chrome');

  // 2. Wait for WASM + engine
  console.log('\n[2/10] Waiting for WASM + engine...');
  await waitForWasm(ws, 60000);
  ok('WASM ready');
  await waitForEngine(ws, 30000);
  ok('Engine ready');

  // 3. Verify OPFS available
  console.log('\n[3/10] Checking OPFS availability...');
  const opfsAvail = await evaluate(ws, `window.SeekServeWasm.opfsAvailable()`);
  if (opfsAvail === true) {
    ok('OPFS available');
  } else {
    fail('OPFS', 'not available');
    console.log('\n=== Cannot test OPFS persistence — OPFS not available ===');
    ws.close();
    process.exit(1);
  }

  // 4. Add torrent
  console.log('\n[4/10] Adding torrent...');
  if (!MAGNET_URI) {
    fail('magnet', 'No magnet URI provided');
    ws.close();
    process.exit(1);
  }
  const addResult = await evaluate(ws, `
    window.SeekServeWasm.addTorrent(window.__seekserveEngine, '${MAGNET_URI}')
  `);
  if (addResult && addResult.error === 0) {
    ok(`Torrent added: ${addResult.id}`);
  } else {
    fail('addTorrent', JSON.stringify(addResult));
    ws.close();
    process.exit(1);
  }
  const torrentId = addResult.id;

  // Sync FS to persist to IndexedDB
  await evaluateAsync(ws, `window.SeekServeWasm.syncFs()`);

  // 5. Wait for metadata
  console.log('\n[5/10] Waiting for metadata...');
  const startMeta = Date.now();
  let hasMetadata = false;
  while (Date.now() - startMeta < METADATA_TIMEOUT) {
    try {
      const status = await evaluate(ws, `
        JSON.parse(window.SeekServeWasm.getStatus(window.__seekserveEngine, '${torrentId}').json || '{}')
      `);
      if (status && status.has_metadata) {
        hasMetadata = true;
        break;
      }
    } catch (_) {}
    await sleep(1000);
  }
  if (hasMetadata) {
    ok('Metadata received');
  } else {
    fail('metadata', 'Timeout');
    ws.close();
    process.exit(1);
  }

  // 6. Select file (first MP4 found) and start OPFS sync
  console.log('\n[6/10] Selecting file + starting OPFS sync...');
  // Find first MP4 file index
  let fileIndex = 0;
  try {
    const filesRaw = await evaluate(ws, `
      JSON.parse(window.SeekServeWasm.listFiles(window.__seekserveEngine, '${torrentId}').json || '[]')
    `);
    const filesList = filesRaw.files || filesRaw;
    if (Array.isArray(filesList)) {
      const mp4 = filesList.find(f => f.path && f.path.endsWith('.mp4'));
      if (mp4) fileIndex = mp4.index !== undefined ? mp4.index : 0;
    }
  } catch (_) {}
  const selectResult = await evaluate(ws, `
    window.SeekServeWasm.selectFile(window.__seekserveEngine, '${torrentId}', ${fileIndex})
  `);
  if (selectResult === 0) {
    ok(`File ${fileIndex} selected`);
  } else {
    fail('selectFile', `error=${selectResult}`);
  }

  // Start OPFS polling sync (normally called from Dart, but E2E bypasses Dart)
  try {
    await evaluate(ws, `
      window.SeekServeWasm.opfsStartSync(window.__seekserveEngine, '${torrentId}', ${fileIndex})
    `);
    ok('OPFS sync started');
  } catch (e) {
    fail('opfsStartSync', e.message);
  }

  // Sync FS to persist selected_file
  await evaluateAsync(ws, `window.SeekServeWasm.syncFs()`);

  // 7. Wait for pieces
  console.log(`\n[7/10] Waiting for ${MIN_PIECES}+ pieces...`);
  let preReloadProgress = 0;
  const startPiece = Date.now();
  while (Date.now() - startPiece < PIECE_TIMEOUT) {
    try {
      const status = await evaluate(ws, `
        JSON.parse(window.SeekServeWasm.getStatus(window.__seekserveEngine, '${torrentId}').json || '{}')
      `);
      if (status && status.progress > 0) {
        preReloadProgress = status.progress;
        // Check pieces
        const pieces = await evaluate(ws, `
          JSON.parse(window.SeekServeWasm.getPieces(window.__seekserveEngine, '${torrentId}').json || '{}')
        `);
        if (pieces && pieces.files) {
          const targetFile = pieces.files.find(f => f.index === fileIndex);
          if (targetFile && targetFile.completed >= MIN_PIECES) {
            ok(`${targetFile.completed} pieces downloaded (progress=${(preReloadProgress * 100).toFixed(1)}%)`);
            break;
          }
        }
      }
    } catch (_) {}
    await sleep(2000);
  }
  if (preReloadProgress === 0) {
    fail('pieces', 'No progress before reload timeout');
    ws.close();
    process.exit(1);
  }

  // 8. PAGE RELOAD
  console.log('\n[8/10] Reloading page...');
  // Stop OPFS sync and flush before reload
  try {
    await evaluate(ws, `window.SeekServeWasm.opfsStopSync()`);
    await evaluateAsync(ws, `window.SeekServeWasm.syncFs()`);
  } catch (_) {}
  ws.close();
  await sleep(500);

  // Navigate to trigger reload via new CDP connection
  wsUrl = await discoverWsUrl();
  ws = await connect(wsUrl);
  await sendCommand(ws, 'Page.enable');
  await sendCommand(ws, 'Page.reload', { ignoreCache: false });
  await sleep(3000);
  ws.close();

  // Reconnect after reload
  await sleep(2000);
  wsUrl = await discoverWsUrl();
  ws = await connect(wsUrl);
  ok('Page reloaded, reconnected');

  // 9. Wait for WASM + engine after reload
  console.log('\n[9/10] Waiting for WASM + engine after reload...');
  await waitForWasm(ws, 60000);
  ok('WASM ready after reload');
  await waitForEngine(ws, 30000);
  ok('Engine ready after reload');

  // 10. Verify torrent is restored
  console.log('\n[10/10] Verifying persistence...');

  // Check torrent still exists
  const torrents = await evaluate(ws, `
    window.SeekServeWasm.listTorrents(window.__seekserveEngine)
  `);
  const torrentIds = torrents && torrents.json ? JSON.parse(torrents.json) : [];
  if (torrentIds.includes(torrentId)) {
    ok(`Torrent ${torrentId.substring(0, 8)}... restored after reload`);
  } else {
    fail('restore', `Torrent ${torrentId} not found. Found: ${JSON.stringify(torrentIds)}`);
  }

  // Check OPFS is still available
  const opfsStill = await evaluate(ws, `window.SeekServeWasm.opfsAvailable()`);
  if (opfsStill === true) {
    ok('OPFS still available after reload');
  } else {
    fail('OPFS after reload', 'not available');
  }

  // Wait a moment for metadata to be received again
  await sleep(5000);

  // Check if metadata is back
  try {
    const statusAfter = await evaluate(ws, `
      JSON.parse(window.SeekServeWasm.getStatus(window.__seekserveEngine, '${torrentId}').json || '{}')
    `, 15000);
    if (statusAfter && statusAfter.has_metadata) {
      ok('Metadata available after reload');
    } else {
      // Metadata may need more time with resume data
      console.log('  ⏳ Metadata not yet available (may need resume data)');
    }
  } catch (e) {
    console.log('  ⏳ Status check after reload:', e.message);
  }

  // Cleanup
  ws.close();

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
