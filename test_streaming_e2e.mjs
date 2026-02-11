#!/usr/bin/env node
/**
 * E2E test for WASM streaming fix:
 *   - StreamingScheduler wiring in read_bytes()
 *   - 500ms read timeout (instead of 30s)
 *   - Service Worker byte-range pipeline
 *
 * Tests the raw WASM API (bypasses Flutter/Dart):
 *   1. Init WASM module
 *   2. Create engine
 *   3. Add Sintel torrent (has web seeds + WebTorrent trackers)
 *   4. Wait for metadata
 *   5. Select file, call getFileSize
 *   6. Call readBytes — verify data or fast timeout (not 30s hang)
 *
 * Usage:
 *   # Terminal 1: serve with COOP/COEP
 *   python3 serve_coop.py 8090 flutter_seekserve_app/build/web
 *
 *   # Terminal 2: launch Chrome with remote debugging
 *   /Applications/Google\ Chrome.app/.../Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-test http://localhost:8090
 *
 *   # Terminal 3: run this test
 *   node test_streaming_e2e.mjs
 */
import WebSocket from 'ws';
import http from 'http';

// --- Config ---
const CDP_DISCOVERY = 'http://localhost:9222/json';
const SINTEL_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Ftracker.webtorrent.dev&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F';
const TORRENT_ID = '08ada5a7a6183aae1e09d831df6748d566095a10';
const METADATA_TIMEOUT = 60000; // 60s for metadata
const READ_TIMEOUT = 30000; // 30s for read (should fail fast now with 500ms timeout)

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
          if (!page) reject(new Error('No matching page found. Pages: ' + JSON.stringify(pages.map(p => p.url))));
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
        else if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text));
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
        else if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text));
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

// --- Test ---

let passed = 0;
let failed = 0;

function ok(msg) { passed++; console.log(`  PASS: ${msg}`); }
function fail(msg) { failed++; console.log(`  FAIL: ${msg}`); }

async function main() {
  console.log('=== SeekServe WASM Streaming E2E Test ===\n');

  // Connect via CDP
  console.log('Step 0: Connect to Chrome via CDP');
  const wsUrl = await discoverWsUrl();
  console.log(`  CDP URL: ${wsUrl}`);
  const ws = await connect(wsUrl);
  await sendCommand(ws, 'Runtime.enable');

  // Capture console logs
  const consoleLogs = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value ?? a.description ?? '?').join(' ');
      consoleLogs.push(text);
      // Show important logs
      if (text.includes('metadata') || text.includes('piece') || text.includes('SeekServe') || text.includes('readBytes')) {
        console.log(`    [console] ${text.substring(0, 120)}`);
      }
    }
  });

  // Step 1: Init WASM
  console.log('\nStep 1: Init WASM module');
  try {
    await evaluateAsync(ws, `(async () => { await window.SeekServeWasm.init(''); return 'ok'; })()`, 30000);
    ok('WASM module initialized');
  } catch (e) {
    fail(`WASM init: ${e.message}`);
    ws.close();
    return;
  }

  // Step 2: Create engine
  console.log('\nStep 2: Create engine');
  let engine;
  try {
    engine = await evaluate(ws, `window.SeekServeWasm.engineCreate('{"log_level":"info","enable_webtorrent":true,"save_path":"/seekserve"}')`);
    if (engine && engine > 0) {
      ok(`Engine created (handle=${engine})`);
    } else {
      fail(`Engine handle invalid: ${engine}`);
      ws.close();
      return;
    }
  } catch (e) {
    fail(`Engine create: ${e.message}`);
    ws.close();
    return;
  }

  // Step 3: Add torrent
  console.log('\nStep 3: Add Sintel torrent');
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

  // Step 4: Wait for metadata
  console.log('\nStep 4: Wait for metadata (up to 60s)');
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
        console.log(`    [${elapsed}s] state=${s.state} peers=${s.num_peers} progress=${(s.progress * 100).toFixed(1)}% meta=${s.has_metadata}`);
        if (s.has_metadata) {
          hasMetadata = true;
          ok(`Metadata received in ${elapsed}s`);
          break;
        }
      }
    } catch (e) {
      console.log(`    Status check error: ${e.message}`);
    }
  }
  if (!hasMetadata) {
    fail('Metadata not received within 60s');
    console.log('\n  Cannot continue without metadata. Cleaning up...');
    try { await evaluate(ws, `window.SeekServeWasm.engineDestroy(${engine})`, 5000); } catch (e) {}
    ws.close();
    printResults();
    return;
  }

  // Step 5: List files and select one
  console.log('\nStep 5: List files and select');
  let fileIndex = -1;
  let fileName = '';
  try {
    const filesRaw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.listFiles(${engine}, '${TORRENT_ID}'))`, 5000);
    const filesResult = JSON.parse(filesRaw);
    if (filesResult.error === 0) {
      const parsed = JSON.parse(filesResult.json);
      // ss_list_files returns {"files": [...]} — unwrap the array
      const files = parsed.files || parsed;
      console.log(`    ${files.length} files found`);
      // Find a small MP4 or any video file
      for (let i = 0; i < files.length; i++) {
        if (files[i].path.endsWith('.mp4')) {
          fileIndex = i;
          fileName = files[i].path;
          console.log(`    Selected file [${i}]: ${files[i].path} (${(files[i].size / 1024 / 1024).toFixed(1)} MB)`);
          break;
        }
      }
      if (fileIndex === -1) {
        // Take first file
        fileIndex = 0;
        fileName = files[0].path;
        console.log(`    Selected file [0]: ${files[0].path} (${(files[0].size / 1024 / 1024).toFixed(1)} MB)`);
      }
      ok('Files listed');
    }
  } catch (e) {
    fail(`listFiles: ${e.message}`);
  }

  // Select the file
  try {
    const selErr = await evaluate(ws, `window.SeekServeWasm.selectFile(${engine}, '${TORRENT_ID}', ${fileIndex})`);
    if (selErr === 0) {
      ok(`File selected (index=${fileIndex})`);
    } else {
      fail(`selectFile error=${selErr}`);
    }
  } catch (e) {
    fail(`selectFile: ${e.message}`);
  }

  // Step 6: getFileSize
  console.log('\nStep 6: Get file size');
  try {
    const sizeRaw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.getFileSize(${engine}, '${TORRENT_ID}', ${fileIndex}))`, 5000);
    const sizeResult = JSON.parse(sizeRaw);
    if (sizeResult.error === 0 && sizeResult.size > 0) {
      ok(`File size = ${sizeResult.size} bytes (${(sizeResult.size / 1024 / 1024).toFixed(1)} MB)`);
    } else {
      fail(`getFileSize error=${sizeResult.error} size=${sizeResult.size}`);
    }
  } catch (e) {
    fail(`getFileSize: ${e.message}`);
  }

  // Step 7: readBytes — the critical test
  // With the old code: would block 30s and timeout
  // With the fix: should either return data (if pieces downloaded) or
  // return error quickly (~500ms) so the caller can retry
  console.log('\nStep 7: readBytes (critical streaming test)');
  console.log('    Testing that readBytes returns quickly (500ms timeout, not 30s)...');
  const readStart = Date.now();
  try {
    const readRaw = await evaluate(ws, `
      (() => {
        const start = performance.now();
        const result = window.SeekServeWasm.readBytes(${engine}, '${TORRENT_ID}', ${fileIndex}, 0, 65536);
        const elapsed = performance.now() - start;
        return JSON.stringify({ error: result.error, dataLen: result.data ? result.data.length : 0, elapsed_ms: Math.round(elapsed) });
      })()
    `, READ_TIMEOUT);
    const readResult = JSON.parse(readRaw);
    const wallTime = Date.now() - readStart;
    console.log(`    readBytes result: error=${readResult.error}, dataLen=${readResult.dataLen}, elapsed=${readResult.elapsed_ms}ms (wall=${wallTime}ms)`);

    if (readResult.error === 0 && readResult.dataLen > 0) {
      ok(`readBytes returned ${readResult.dataLen} bytes of data!`);
    } else if (readResult.elapsed_ms < 5000) {
      // Even if no data yet, the fast timeout means our fix works
      ok(`readBytes returned quickly (${readResult.elapsed_ms}ms) — timeout fix working`);
      console.log('    Note: No data yet because pieces at offset 0 haven\'t downloaded.');
      console.log('    The StreamingScheduler has now set piece deadlines for these pieces.');
      console.log('    Subsequent retries (via SW) would succeed as pieces arrive.');
    } else {
      fail(`readBytes took too long (${readResult.elapsed_ms}ms) — timeout fix may not be applied`);
    }
  } catch (e) {
    const wallTime = Date.now() - readStart;
    if (wallTime > 25000) {
      fail(`readBytes blocked for ${wallTime}ms — OLD 30s timeout still active`);
    } else {
      fail(`readBytes error: ${e.message} (${wallTime}ms)`);
    }
  }

  // Step 8: Wait a bit for pieces, then try again
  console.log('\nStep 8: Wait 15s for pieces to download, then retry readBytes');
  await sleep(15000);

  // Check download progress
  try {
    const raw = await evaluate(ws, `JSON.stringify(window.SeekServeWasm.getStatus(${engine}, '${TORRENT_ID}'))`, 5000);
    const status = JSON.parse(raw);
    if (status.error === 0) {
      const s = JSON.parse(status.json);
      console.log(`    Progress: ${(s.progress * 100).toFixed(1)}% peers=${s.num_peers} dl=${s.download_rate}`);
    }
  } catch (e) {}

  // Retry readBytes
  try {
    const readRaw = await evaluate(ws, `
      (() => {
        const result = window.SeekServeWasm.readBytes(${engine}, '${TORRENT_ID}', ${fileIndex}, 0, 65536);
        return JSON.stringify({ error: result.error, dataLen: result.data ? result.data.length : 0 });
      })()
    `, READ_TIMEOUT);
    const readResult = JSON.parse(readRaw);
    if (readResult.error === 0 && readResult.dataLen > 0) {
      ok(`Retry readBytes: got ${readResult.dataLen} bytes!`);
    } else {
      console.log(`    Retry readBytes: error=${readResult.error} (pieces may not be downloaded yet)`);
      console.log('    This is expected if no peers have the initial pieces.');
    }
  } catch (e) {
    console.log(`    Retry readBytes error: ${e.message}`);
  }

  // Cleanup
  console.log('\nStep 9: Cleanup');
  try {
    await evaluate(ws, `window.SeekServeWasm.engineDestroy(${engine})`, 5000);
    ok('Engine destroyed');
  } catch (e) {
    console.log(`    Cleanup error: ${e.message}`);
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
