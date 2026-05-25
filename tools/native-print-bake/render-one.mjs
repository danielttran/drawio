#!/usr/bin/env node
// Render a single .drawio file through the native print engine and save PNG.
// Usage: node render-one.mjs <file.drawio> [output.png]

import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';

import { parseDrawio, buildGraph } from './drawio-parser.mjs';
import { createSvgEnv } from './svg-shim/index.mjs';
import { loadStencils } from './stencil-loader.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR = resolve(__dir, '../../src/main/webapp');
const ENGINE = resolve(__dir, '../../src/main/native-print-engine/build/Debug/print_engine_host.exe');

function localFileFetch(url) {
  return Promise.resolve().then(function () {
    if (/^https?:\/\//i.test(url)) return { ok: false };
    const rel = url.replace(/^\//, '');
    const filePath = resolve(WEBAPP_DIR, rel);
    let bytes;
    try { bytes = readFileSync(filePath); } catch (_) { return { ok: false }; }
    const ext = filePath.split('.').pop().toLowerCase();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };
    const mime = mimeMap[ext] || 'application/octet-stream';
    return {
      ok: true,
      blob: () => Promise.resolve({
        type: mime,
        arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      })
    };
  });
}

const _shimEnv = createSvgEnv();
if (!globalThis.document) globalThis.document = _shimEnv.document;
if (!globalThis.XMLSerializer) globalThis.XMLSerializer = _shimEnv.XMLSerializer;
if (!globalThis.getComputedStyle) globalThis.getComputedStyle = _shimEnv.getComputedStyle;

const require = createRequire(import.meta.url);
const exporterPath = resolve(__dir, '../../src/main/webapp/plugins/nativeprint/exporter.js');
const exporter = require(exporterPath);

const _stencilDir = resolve(__dir, '../../src/main/webapp/stencils');
const _stencilRegistry = await loadStencils(_stencilDir);
if (typeof exporter.registerStencils === 'function') {
  exporter.registerStencils(_stencilRegistry);
}

// Frame codec matching proto.hpp exactly
function encodeFrame(type, streamId, payload) {
  const h = Buffer.alloc(9);
  h.writeUInt32LE(payload.length + 5, 0);
  h.writeUInt8(type, 4);
  h.writeUInt32LE(streamId >>> 0, 5);
  return Buffer.concat([h, payload]);
}

// Engine client — one persistent data listener, serialized requests
class EngineClient {
  constructor(exePath) {
    this._proc = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this._buf = Buffer.alloc(0);
    this._pending = null; // { blobStreamId, blob, controlMsg, resolve, reject }
    this._proc.stdout.on('data', (chunk) => this._onData(chunk));
    this._proc.on('exit', () => { if (this._pending) this._pending.reject(new Error('engine exited')); });
    this._proc.on('error', (e) => { if (this._pending) this._pending.reject(e); });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (true) {
      if (this._buf.length < 4) break;
      const frameLen = this._buf.readUInt32LE(0);
      if (frameLen < 5 || frameLen > 64 * 1024 * 1024) {
        if (this._pending) this._pending.reject(new Error('frame length out of range: ' + frameLen));
        return;
      }
      if (this._buf.length < frameLen + 4) break;
      const type = this._buf.readUInt8(4);
      const streamId = this._buf.readUInt32LE(5);
      const payload = Buffer.from(this._buf.subarray(9, 4 + frameLen));
      this._buf = this._buf.subarray(4 + frameLen);
      this._onFrame(type, streamId, payload);
    }
  }

  _onFrame(type, streamId, payload) {
    const p = this._pending;
    if (!p) return;
    if (type === 2) { // binary blob
      if (p.blobStreamId != null && streamId === p.blobStreamId) {
        p.blob = payload;
        this._tryResolve();
      }
      return;
    }
    const msg = JSON.parse(payload.toString('utf8'));
    if (msg.result === 'PreviewResult' && msg.imageStreamId != null) {
      p.controlMsg = msg;
      p.blobStreamId = msg.imageStreamId;
    } else {
      p.controlMsg = msg;
    }
    this._tryResolve();
  }

  _tryResolve() {
    const p = this._pending;
    if (!p || !p.controlMsg) return;
    if (p.blobStreamId != null && !p.blob) return; // still waiting for blob
    this._pending = null;
    p.resolve({ msg: p.controlMsg, blob: p.blob || null });
  }

  request(obj) {
    return new Promise((resolve, reject) => {
      this._pending = { blobStreamId: null, blob: null, controlMsg: null, resolve, reject };
      this._proc.stdin.write(encodeFrame(1, 0, Buffer.from(JSON.stringify(obj), 'utf8')));
    });
  }

  close() {
    try { this._proc.stdin.end(); } catch (_) {}
    try { this._proc.kill(); } catch (_) {}
  }
}

async function renderFile(drawioPath, outPng) {
  const xml = await readFile(drawioPath, 'utf8');
  const parsed = parseDrawio(xml);
  const pageData = parsed.pages[0];
  const graph = buildGraph(pageData.cells, pageData.paper);

  let resolvedImages = {};
  if (typeof exporter.embedExternalImages === 'function') {
    resolvedImages = await exporter.embedExternalImages(graph, localFileFetch, null, null).catch(() => ({}));
  }

  const result = exporter.buildResult(graph, pageData.paper, { mode: 'B', resolvedImages });
  const notices = result.notices;
  const contract = result.contract;

  console.log(`  exporter notices: ${notices.length}`);
  notices.forEach(n => console.log('   ', n.kind, n.message || ''));

  const client = new EngineClient(ENGINE);

  try {
    const { msg: helloMsg } = await client.request({ op: 'Hello', proto: { major: 1, minor: 0 } });
    if (helloMsg.result !== 'HelloOk') {
      throw new Error('Handshake failed: ' + JSON.stringify(helloMsg));
    }

    const contractJson = JSON.stringify(contract);
    const { msg: renderMsg, blob } = await client.request({
      op: 'RenderPreview',
      contractRef: { inline: contractJson },
      dpi: 150
    });

    if (renderMsg.result === 'Error') {
      console.error(`  ENGINE ERROR (${renderMsg.error}): ${renderMsg.detail || ''}`);
      return false;
    }

    if (!blob) {
      console.log('  No PNG returned from engine');
      return false;
    }

    await writeFile(outPng, blob);
    console.log(`  PNG: ${outPng} (${blob.length} bytes)`);
    return true;
  } finally {
    client.close();
  }
}

const inputFile = process.argv[2];
if (!inputFile) { console.error('Usage: node render-one.mjs <file.drawio> [out.png]'); process.exit(1); }
const outPng = process.argv[3] || inputFile.replace(/\.drawio$/, '.png');
console.log(`Rendering ${basename(inputFile)}...`);
const ok = await renderFile(inputFile, outPng);
process.exit(ok ? 0 : 1);
