#!/usr/bin/env node
// Render at higher DPI for label inspection
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
  return Promise.resolve().then(() => {
    if (/^https?:\/\//i.test(url)) return { ok: false };
    const filePath = resolve(WEBAPP_DIR, url.replace(/^\//, ''));
    let bytes; try { bytes = readFileSync(filePath); } catch (_) { return { ok: false }; }
    const ext = filePath.split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' }[ext] || 'application/octet-stream';
    return { ok: true, blob: () => Promise.resolve({ type: mime, arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) }) };
  });
}

const _shimEnv = createSvgEnv();
if (!globalThis.document) globalThis.document = _shimEnv.document;
if (!globalThis.XMLSerializer) globalThis.XMLSerializer = _shimEnv.XMLSerializer;
if (!globalThis.getComputedStyle) globalThis.getComputedStyle = _shimEnv.getComputedStyle;
const require = createRequire(import.meta.url);
const exporter = require(resolve(__dir, '../../src/main/webapp/plugins/nativeprint/exporter.js'));
const _stencilRegistry = await loadStencils(resolve(__dir, '../../src/main/webapp/stencils'));
if (typeof exporter.registerStencils === 'function') exporter.registerStencils(_stencilRegistry);

function encodeFrame(type, streamId, payload) {
  const h = Buffer.alloc(9);
  h.writeUInt32LE(payload.length + 5, 0); h.writeUInt8(type, 4); h.writeUInt32LE(streamId >>> 0, 5);
  return Buffer.concat([h, payload]);
}

class EngineClient {
  constructor() {
    this._proc = spawn(ENGINE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this._buf = Buffer.alloc(0); this._pending = null;
    this._proc.stdout.on('data', (c) => this._onData(c));
    this._proc.on('exit', () => { if (this._pending) this._pending.reject(new Error('engine exited')); });
  }
  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (true) {
      if (this._buf.length < 4) break;
      const fl = this._buf.readUInt32LE(0);
      if (this._buf.length < fl + 4) break;
      const type = this._buf.readUInt8(4), sid = this._buf.readUInt32LE(5);
      const payload = Buffer.from(this._buf.subarray(9, 4 + fl));
      this._buf = this._buf.subarray(4 + fl);
      this._onFrame(type, sid, payload);
    }
  }
  _onFrame(type, sid, payload) {
    const p = this._pending; if (!p) return;
    if (type === 2) { if (p.blobSid != null && sid === p.blobSid) { p.blob = payload; this._tr(); } return; }
    const msg = JSON.parse(payload.toString('utf8'));
    if (msg.result === 'PreviewResult' && msg.imageStreamId != null) { p.controlMsg = msg; p.blobSid = msg.imageStreamId; }
    else { p.controlMsg = msg; }
    this._tr();
  }
  _tr() {
    const p = this._pending; if (!p || !p.controlMsg) return;
    if (p.blobSid != null && !p.blob) return;
    this._pending = null; p.resolve({ msg: p.controlMsg, blob: p.blob || null });
  }
  request(obj) {
    return new Promise((resolve, reject) => {
      this._pending = { blobSid: null, blob: null, controlMsg: null, resolve, reject };
      this._proc.stdin.write(encodeFrame(1, 0, Buffer.from(JSON.stringify(obj), 'utf8')));
    });
  }
  close() { try { this._proc.stdin.end(); } catch(_){} try { this._proc.kill(); } catch(_){} }
}

const inputFile = process.argv[2];
const dpi = parseInt(process.argv[3] || '300');
const outPng = process.argv[4] || inputFile.replace(/\.drawio$/, `-${dpi}dpi.png`);

const xml = await readFile(inputFile, 'utf8');
const parsed = parseDrawio(xml);
const pageData = parsed.pages[0];
const graph = buildGraph(pageData.cells, pageData.paper);
let resolvedImages = {};
if (typeof exporter.embedExternalImages === 'function')
  resolvedImages = await exporter.embedExternalImages(graph, localFileFetch, null, null).catch(() => ({}));
// Surface bake notices: this probe previously discarded them entirely, so
// a degraded render previewed with no hint of WHY it diverged.
const { contract, notices } = exporter.buildResult(graph, pageData.paper, { resolvedImages });
if (notices && notices.length) {
  console.error(`bake notices (${notices.length}):`);
  for (const n of notices) {
    console.error('  ', n.kind, (n.detail && (n.detail.detail || n.detail)) || '');
  }
}

const client = new EngineClient();
const { msg: h } = await client.request({ op: 'Hello', proto: { major: 1, minor: 0 } });
if (h.result !== 'HelloOk') throw new Error('handshake failed');
const { msg, blob } = await client.request({ op: 'RenderPreview', contractRef: { inline: JSON.stringify(contract) }, dpi });
client.close();
if (msg.result === 'Error') { console.error('ENGINE ERROR:', msg.error, msg.detail); process.exit(1); }
await writeFile(outPng, blob);
console.log(`${basename(inputFile)} @ ${dpi}dpi → ${outPng} (${blob.length} bytes)`);
if (blob.length < 100) {
  console.error('WARNING: tiny PNG — this host binary is the cross-platform STUB');
  console.error('(stub_services.cpp returns a fixed 1x1 preview). For real pixels');
  console.error('on this box use render-artifact.mjs (production resvg).');
}
