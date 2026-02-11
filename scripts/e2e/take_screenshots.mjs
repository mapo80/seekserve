#!/usr/bin/env node
/**
 * Takes screenshots of video streaming via local WebTorrent in Chrome.
 */
import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';

const CDP_DISCOVERY = 'http://localhost:9222/json';
const MAGNET = 'magnet:?xt=urn:btih:31ed292ddb90f45afcbf3b4c9009b84aacee5de6&dn=bbb_sunflower_1080p_30fps_normal.mp4&tr=ws://localhost:8000/announce';
const TORRENT_ID = '31ed292ddb90f45afcbf3b4c9009b84aacee5de6';
const DIR = '/tmp/seekserve-screenshots';

let msgId = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function discoverWsUrl() {
  return new Promise((resolve, reject) => {
    http.get(CDP_DISCOVERY, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const p = JSON.parse(d).find(p => p.type === 'page' && p.url.includes('localhost:8080'));
        p ? resolve(p.webSocketDebuggerUrl) : reject(new Error('No page'));
      });
    }).on('error', reject);
  });
}

async function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 50*1024*1024 });
    ws.once('open', () => resolve(ws)); ws.once('error', reject);
  });
}

function cdp(ws, method, params = {}, timeout = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timeout`)), timeout);
    const h = raw => { const m = JSON.parse(raw); if (m.id===id) { clearTimeout(t); ws.off('message',h); resolve(m.result); }};
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function ev(ws, expr, timeout = 15000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ev timeout')), timeout);
    const h = raw => {
      const m = JSON.parse(raw);
      if (m.id === id) {
        clearTimeout(t); ws.off('message', h);
        const r = m.result?.result;
        if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description || 'exception'));
        else resolve(r?.value ?? r);
      }
    };
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: false }}));
  });
}

function evAsync(ws, expr, timeout = 60000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('evAsync timeout')), timeout);
    const h = raw => {
      const m = JSON.parse(raw);
      if (m.id === id) {
        clearTimeout(t); ws.off('message', h);
        const r = m.result?.result;
        if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description || 'exception'));
        else resolve(r?.value ?? r);
      }
    };
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true }}));
  });
}

async function shot(ws, name) {
  const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync(`${DIR}/${name}`, buf);
  console.log(`  >> ${name} (${(buf.length/1024).toFixed(0)} KB)`);
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  console.log('=== Screenshot Session ===\n');

  const ws = await connect(await discoverWsUrl());
  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Page.enable');

  // Wait for engine
  let engine = 0;
  for (let i = 0; i < 30; i++) {
    try { engine = await ev(ws, 'window.__seekserveEngine || 0', 3000); if (engine > 0) break; } catch(e) {}
    await sleep(2000);
  }
  console.log(`Engine: ${engine}`);

  // Screenshot: App home
  await shot(ws, '01_home.png');

  // Add torrent
  try {
    await ev(ws, `JSON.stringify(window.SeekServeWasm.addTorrent(${engine}, '${MAGNET}'))`);
  } catch(e) { console.log(`addTorrent: ${e.message} (may already exist)`); }
  console.log('Torrent added');

  // Wait for metadata + some download
  console.log('Waiting for metadata + download...');
  let hasMeta = false, progress = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    try {
      const raw = await ev(ws, `JSON.stringify(window.SeekServeWasm.getStatus(${engine}, '${TORRENT_ID}'))`, 8000);
      const result = JSON.parse(raw);
      if (result.error !== 0) continue;
      const s = JSON.parse(result.json);
      progress = s.progress;
      console.log(`  [${i*3}s] progress=${(s.progress*100).toFixed(1)}% peers=${s.num_peers} dl=${(s.download_rate/1024).toFixed(0)}KB/s meta=${s.has_metadata}`);
      if (s.has_metadata) hasMeta = true;
      if (hasMeta && progress > 0.03) break; // 3% = ~8MB, enough for video start
    } catch(e) { console.log(`  status: ${e.message}`); }
  }

  if (!hasMeta) { console.log('No metadata, aborting'); ws.close(); return; }

  // Screenshot: downloading
  await shot(ws, '02_downloading.png');

  // Select file + get stream URL
  await ev(ws, `window.SeekServeWasm.selectFile(${engine}, '${TORRENT_ID}', 0)`);
  const urlRaw = await ev(ws, `JSON.stringify(window.SeekServeWasm.getStreamUrl(${engine}, '${TORRENT_ID}', 0))`);
  const streamUrl = JSON.parse(urlRaw).url;
  console.log(`Stream URL: ${streamUrl}`);

  // Wait for readBytes to return actual data (pieces at offset 0)
  console.log('Waiting for first bytes...');
  for (let i = 0; i < 60; i++) {
    try {
      const rbRaw = await ev(ws, `JSON.stringify((() => { const r = window.SeekServeWasm.readBytes(${engine}, '${TORRENT_ID}', 0, 0, 4096); return {err: r.error, len: r.data ? r.data.length : 0}; })())`, 8000);
      const rb = JSON.parse(rbRaw);
      if (rb.err === 0 && rb.len > 0) { console.log(`  readBytes OK: ${rb.len} bytes`); break; }
      // Also check progress
      const sRaw = await ev(ws, `JSON.stringify(window.SeekServeWasm.getStatus(${engine}, '${TORRENT_ID}'))`, 8000);
      const s = JSON.parse(JSON.parse(sRaw).json);
      console.log(`  readBytes err=${rb.err}, progress=${(s.progress*100).toFixed(1)}% dl=${(s.download_rate/1024).toFixed(0)}KB/s`);
    } catch(e) { console.log(`  ${e.message}`); }
    await sleep(3000);
  }

  // Create fullscreen video
  console.log('Creating video...');
  const videoResult = await evAsync(ws, `
    new Promise(resolve => {
      const v = document.createElement('video');
      v.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background:black;object-fit:contain;';
      document.body.appendChild(v);
      const result = {events:[], error:null, currentTime:0, duration:0, w:0, h:0};
      const done = () => { result.currentTime=v.currentTime; result.duration=v.duration; result.w=v.videoWidth; result.h=v.videoHeight; resolve(result); };
      v.onloadedmetadata = () => { result.events.push('loadedmetadata'); };
      v.oncanplay = () => { result.events.push('canplay'); setTimeout(done, 3000); }; // wait 3s after canplay for frame
      v.onerror = () => { result.error = v.error?.code; if(result.error !== 2) done(); };
      setTimeout(() => { result.events.push('timeout'); done(); }, 45000);
      v.src = '${streamUrl}';
      v.autoplay = true;
      v.muted = true;
    })
  `, 50000);
  console.log(`Video: events=[${videoResult.events}] time=${videoResult.currentTime?.toFixed(1)}s dur=${videoResult.duration?.toFixed(1)}s ${videoResult.w}x${videoResult.h} err=${videoResult.error}`);

  // Screenshot: video playing
  await shot(ws, '03_video_playing.png');

  // Let it play more
  await sleep(5000);
  await shot(ws, '04_video_5s_later.png');

  // Get final state
  const state = await ev(ws, `(() => { const v=document.querySelector('video'); return v ? {t:v.currentTime,d:v.duration,p:v.paused,w:v.videoWidth,h:v.videoHeight} : null; })()`);
  console.log(`Final state: ${JSON.stringify(state)}`);

  // Final status
  try {
    const raw = await ev(ws, `JSON.stringify(window.SeekServeWasm.getStatus(${engine}, '${TORRENT_ID}'))`, 8000);
    const s = JSON.parse(JSON.parse(raw).json);
    console.log(`Torrent: progress=${(s.progress*100).toFixed(1)}% peers=${s.num_peers} dl=${(s.download_rate/1024).toFixed(0)}KB/s`);
  } catch(e) {}

  // Remove video, show app
  await ev(ws, `document.querySelector('video')?.remove()`);
  await sleep(1000);
  await shot(ws, '05_app_after.png');

  console.log(`\nScreenshots in ${DIR}`);
  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
