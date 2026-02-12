#!/usr/bin/env node
/**
 * OPFS Worker Isolation Test
 *
 * Tests the seekserve_opfs.js Web Worker in isolation using Chrome via CDP.
 * Does NOT require the full Flutter app — just needs Chrome with
 * --remote-debugging-port=9222 and a minimal HTML page.
 *
 * Usage:
 *   # Start Chrome with remote debugging:
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *     --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-opfs-test \
 *     --auto-open-devtools-for-tabs about:blank
 *
 *   # Run test:
 *   node scripts/e2e/test_opfs_worker.mjs [opfs_worker_url]
 */
import WebSocket from 'ws';
import http from 'http';

const CDP_DISCOVERY = 'http://localhost:9222/json';
const OPFS_WORKER_URL = process.argv[2] || 'http://127.0.0.1:8080/seekserve_opfs.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let msgId = 0;
let passed = 0;
let failed = 0;

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
          const page = pages.find(p => p.type === 'page');
          if (!page) reject(new Error('No page found'));
          else resolve(page.webSocketDebuggerUrl);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 10 * 1024 * 1024 });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function evaluateAsync(ws, expression, timeout = 15000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout id=${id}`)), timeout);
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

// --- Test harness ---

async function main() {
  console.log('=== OPFS Worker Isolation Test ===\n');

  // 1. Connect to Chrome
  console.log('[1/8] Connecting to Chrome...');
  const wsUrl = await discoverWsUrl();
  const ws = await connect(wsUrl);
  console.log('  Connected\n');

  // 2. Inject OPFS Worker helper into page
  console.log('[2/8] Injecting OPFS Worker...');
  await evaluateAsync(ws, `(async () => {
    // Create a minimal Worker wrapper with postMessage/onMessage
    window._opfsWorker = new Worker('${OPFS_WORKER_URL}');
    window._opfsMsgId = 0;
    window._opfsPending = new Map();
    window._opfsWorker.onmessage = (e) => {
      const msg = e.data;
      const resolve = window._opfsPending.get(msg.msgId);
      if (resolve) {
        window._opfsPending.delete(msg.msgId);
        resolve(msg);
      }
    };
    window.postToOpfs = (msg) => {
      return new Promise((resolve) => {
        const id = ++window._opfsMsgId;
        msg.msgId = id;
        window._opfsPending.set(id, resolve);
        const transfer = [];
        if (msg.data instanceof Uint8Array) transfer.push(msg.data.buffer);
        window._opfsWorker.postMessage(msg, transfer);
      });
    };
    return true;
  })()`);
  ok('Worker injected');

  // 3. Test list (should be empty initially or have leftover data)
  console.log('\n[3/8] Testing list...');
  const listResult = await evaluateAsync(ws, `(async () => {
    const r = await window.postToOpfs({ type: 'list' });
    return r;
  })()`);
  if (listResult.ok) {
    ok('list returned ok=true');
  } else {
    fail('list', listResult.error);
  }

  // 4. Test init (create a 1MB file)
  console.log('\n[4/8] Testing init (1MB file)...');
  const initResult = await evaluateAsync(ws, `(async () => {
    const r = await window.postToOpfs({
      type: 'init',
      torrentId: 'test_torrent_001',
      fileIndex: 0,
      fileSize: 1048576,
    });
    return r;
  })()`);
  if (initResult.ok) {
    ok('init returned ok=true');
  } else {
    fail('init', initResult.error);
  }

  // 5. Test writePiece (write 256KB at offset 0)
  console.log('\n[5/8] Testing writePiece...');
  const writeResult = await evaluateAsync(ws, `(async () => {
    // Write 256KB of pattern data at offset 0
    const data = new Uint8Array(262144);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xFF;
    const r = await window.postToOpfs({
      type: 'writePiece',
      torrentId: 'test_torrent_001',
      fileIndex: 0,
      offset: 0,
      data: data,
    });
    return r;
  })()`);
  if (writeResult.ok) {
    ok('writePiece at offset 0 ok');
  } else {
    fail('writePiece', writeResult.error);
  }

  // Write another piece at offset 256KB
  const write2Result = await evaluateAsync(ws, `(async () => {
    const data = new Uint8Array(262144);
    for (let i = 0; i < data.length; i++) data[i] = (i + 128) & 0xFF;
    const r = await window.postToOpfs({
      type: 'writePiece',
      torrentId: 'test_torrent_001',
      fileIndex: 0,
      offset: 262144,
      data: data,
    });
    return r;
  })()`);
  if (write2Result.ok) {
    ok('writePiece at offset 256KB ok');
  } else {
    fail('writePiece 2', write2Result.error);
  }

  // 6. Test restore (read file back)
  console.log('\n[6/8] Testing restore...');
  const restoreResult = await evaluateAsync(ws, `(async () => {
    const r = await window.postToOpfs({
      type: 'restore',
      torrentId: 'test_torrent_001',
      fileIndex: 0,
    });
    if (!r.ok) return { ok: false, error: r.error };
    // Verify first and second piece patterns
    const d = r.data;
    const piece1Ok = d[0] === 0 && d[1] === 1 && d[255] === 255;
    const piece2Ok = d[262144] === 128 && d[262145] === 129;
    return {
      ok: r.ok,
      size: r.size,
      piece1Ok: piece1Ok,
      piece2Ok: piece2Ok,
    };
  })()`);
  // File size is 2 x 262144 = 524288 (no pre-allocation via truncate)
  if (restoreResult.ok && restoreResult.size === 524288) {
    ok(`restore returned ${restoreResult.size} bytes`);
    if (restoreResult.piece1Ok && restoreResult.piece2Ok) {
      ok('restore data integrity verified');
    } else {
      fail('restore data', `piece1Ok=${restoreResult.piece1Ok}, piece2Ok=${restoreResult.piece2Ok}`);
    }
  } else {
    fail('restore', JSON.stringify(restoreResult));
  }

  // 7. Test getFile (get File object)
  console.log('\n[7/8] Testing getFile...');
  const getFileResult = await evaluateAsync(ws, `(async () => {
    const r = await window.postToOpfs({
      type: 'getFile',
      torrentId: 'test_torrent_001',
      fileIndex: 0,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, size: r.file.size, type: r.file.type };
  })()`);
  if (getFileResult.ok && getFileResult.size === 524288) {
    ok(`getFile returned File with size=${getFileResult.size}`);
  } else {
    fail('getFile', JSON.stringify(getFileResult));
  }

  // 8. Test delete + verify empty list
  console.log('\n[8/8] Testing delete...');
  const deleteResult = await evaluateAsync(ws, `(async () => {
    const r = await window.postToOpfs({
      type: 'delete',
      torrentId: 'test_torrent_001',
      fileIndex: 0,
    });
    if (!r.ok) return { ok: false, error: r.error };
    // Verify it's gone
    const list = await window.postToOpfs({ type: 'list' });
    const stillThere = list.data?.some(f =>
      f.torrentId === 'test_torrent_001' && f.fileIndex === 0);
    return { ok: true, stillThere: !!stillThere };
  })()`);
  if (deleteResult.ok && !deleteResult.stillThere) {
    ok('delete + verify gone');
  } else {
    fail('delete', JSON.stringify(deleteResult));
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
