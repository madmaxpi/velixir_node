'use strict';
// Velixir free Node.js app: serves HTTP on $PORT, downloads Xray on start,
// extracts the zip with Node built-ins only (zlib, no unzip / python3),
// and proxies WebSocket upgrades on $WS_PATH to a local VLESS inbound.
// TLS is terminated by velixir itself (https://<app>.velixir.run), so the
// local Xray inbound uses plain WS (security: none on the inner hop).
// Env: UUID (required, generated if missing), WS_PATH, PORT, XRAY_PORT,
// XRAY_VERSION, XRAY_URL, NODE_NAME.

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const XRAY_PORT = parseInt(process.env.XRAY_PORT || '18081', 10);
const XRAY_VERSION = process.env.XRAY_VERSION || 'v26.10.21';
const XRAY_URL = process.env.XRAY_URL ||
  `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip`;

let WS_PATH = process.env.WS_PATH || '/ws';
if (!WS_PATH.startsWith('/')) WS_PATH = '/' + WS_PATH;

let UUID = process.env.UUID || '';
if (!UUID) {
  UUID = crypto.randomUUID();
  console.log('[app] UUID env not set, generated one at runtime; use /sub to retrieve the link');
}

const WORKDIR = path.join(os.tmpdir(), 'velixir-xray');
const XRAY_BIN = path.join(WORKDIR, 'xray');
const XRAY_CFG = path.join(WORKDIR, 'config.json');
const ZIP_PATH = path.join(WORKDIR, 'xray.zip');

function log(...args) { console.log('[app]', ...args); }

// ---- minimal zip reader (central directory, zlib inflateRaw) ----
function extractXrayFromZip(buf) {
  // Find End Of Central Directory (last 64 KiB, signature 0x06054b50).
  let eocd = -1;
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('zip: EOCD not found');
  const entries = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('zip: bad central entry');
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOff = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    if (name === 'xray') {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip: bad local header');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataOff, dataOff + compSize);
      if (method === 8) return zlib.inflateRawSync(data);
      if (method === 0) return Buffer.from(data);
      throw new Error('zip: unsupported method ' + method);
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('zip: xray entry not found');
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'velixir-xray-node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('download HTTP ' + res.statusCode + ' for ' + url));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

let xrayProc = null;
let xrayReady = false;

async function ensureXray() {
  fs.mkdirSync(WORKDIR, { recursive: true });
  if (fs.existsSync(XRAY_BIN)) {
    try { fs.chmodSync(XRAY_BIN, 0o755); } catch (_) {}
    return;
  }
  log('downloading Xray', XRAY_VERSION);
  await downloadFile(XRAY_URL, ZIP_PATH);
  const zipBuf = fs.readFileSync(ZIP_PATH);
  const bin = extractXrayFromZip(zipBuf);
  fs.writeFileSync(XRAY_BIN, bin, { mode: 0o755 });
  try { fs.unlinkSync(ZIP_PATH); } catch (_) {}
  log('Xray extracted, size', bin.length);
}

function writeConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{
      port: XRAY_PORT,
      listen: '127.0.0.1',
      protocol: 'vless',
      settings: { clients: [{ id: UUID }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: WS_PATH } },
    }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  };
  fs.writeFileSync(XRAY_CFG, JSON.stringify(cfg));
}

function startXray() {
  if (xrayProc) return;
  writeConfig();
  log('starting Xray on 127.0.0.1:' + XRAY_PORT);
  xrayProc = spawn(XRAY_BIN, ['-c', XRAY_CFG], { stdio: ['ignore', 'pipe', 'pipe'] });
  xrayProc.stdout.on('data', (d) => process.stdout.write('[xray] ' + d));
  xrayProc.stderr.on('data', (d) => process.stderr.write('[xray] ' + d));
  xrayProc.on('error', (e) => { log('Xray spawn error', e.message); xrayProc = null; });
  xrayProc.on('exit', (code) => {
    log('Xray exited', code, '- will retry in 5s');
    xrayProc = null; xrayReady = false;
    setTimeout(() => { ensureXray().then(startXray).catch((e) => log('retry failed', e.message)); }, 5000);
  });
  // Readiness: first successful TCP connect marks it ready (best effort).
  const probe = () => {
    const s = net.connect(XRAY_PORT, '127.0.0.1');
    s.on('connect', () => { xrayReady = true; s.end(); log('Xray ready'); });
    s.on('error', () => setTimeout(probe, 500));
  };
  setTimeout(probe, 500);
}

function vlessLink(host) {
  const cleanHost = String(host || '').split(':')[0];
  const name = encodeURIComponent(process.env.NODE_NAME || 'velixir-xray');
  const params = new URLSearchParams({
    encryption: 'none', security: 'tls', sni: cleanHost,
    type: 'ws', host: cleanHost, path: WS_PATH,
  });
  return `vless://${UUID}@${cleanHost}:443?${params.toString()}#${name}`;
}

function pathnameOf(req) {
  try { return new URL(req.url, 'http://x').pathname; } catch (_) { return req.url; }
}

const server = http.createServer((req, res) => {
  const p = pathnameOf(req);
  if (p === '/sub') {
    const link = vlessLink(req.headers.host);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(Buffer.from(link, 'utf8').toString('base64'));
    return;
  }
  if (p === WS_PATH) {
    // WS endpoint hit over plain HTTP: 400 means the app is alive.
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  if (p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.on('upgrade', (req, socket, head) => {
  const p = pathnameOf(req);
  if (p !== WS_PATH) { socket.destroy(); return; }
  let attempts = 0;
  const tryConnect = () => {
    attempts++;
    const upstream = net.connect(XRAY_PORT, '127.0.0.1');
    upstream.on('connect', () => {
      let headBuf = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) { for (const item of v) headBuf += `${k}: ${item}\r\n`; }
        else headBuf += `${k}: ${v}\r\n`;
      }
      headBuf += '\r\n';
      upstream.write(headBuf);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
    });
    upstream.on('error', () => {
      if (attempts < 6) setTimeout(tryConnect, 400);
      else socket.destroy();
    });
  };
  tryConnect();
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on ${PORT}, WS_PATH=${WS_PATH}, xray internal 127.0.0.1:${XRAY_PORT}`);
  ensureXray().then(startXray).catch((e) => {
    log('Xray prepare failed', e.message, '- will retry in 10s');
    setTimeout(() => { ensureXray().then(startXray).catch((err) => log('retry failed', err.message)); }, 10000);
  });
});
