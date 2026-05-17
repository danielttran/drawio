// Vite dev config + the Native Print BROKER (host integration spec Layer 3),
// embedded as dev-server middleware so `npm run dev` brings the broker AND the
// engine up, same-origin with the webapp.
//
// Topology here (decided, documented):
//   browser webapp  --(localhost HTTP, dev-only)-->  this broker
//   this broker      --(spec-faithful framed stdio)-->  C++ engine
//
// The browser<->broker hop is a DELIBERATE dev-only deviation from spec §3.1
// ("no network surface"): mitigated by binding to localhost only and checking
// Origin on every request. The broker<->engine hop is spec-faithful: frozen
// length-prefixed frames over the engine's stdio, exactly one client (this
// broker), Hello handshake, single-flight Print, temp-file ownership with the
// ReleaseContract/Released deletion sequence (§6).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_EXE = join(
  HERE, '..', 'native-print-engine', 'build', 'Debug',
  'print_engine_host.exe');
const PROTO = { major: 1, minor: 0 };
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000', 'http://127.0.0.1:3000'
]);

// ---- frozen frame codec (JS mirror of include/print_engine/proto.hpp) ----
function encodeFrame(type, streamId, payload) {
  const h = Buffer.alloc(9);
  h.writeUInt32LE(payload.length + 5, 0);
  h.writeUInt8(type, 4);
  h.writeUInt32LE(streamId >>> 0, 5);
  return Buffer.concat([h, payload]);
}
class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  feed(chunk) { this.buf = Buffer.concat([this.buf, chunk]); }
  next() {
    if (this.buf.length < 4) return null;
    const frameLen = this.buf.readUInt32LE(0);
    if (frameLen < 5 || frameLen > 64 * 1024 * 1024) {
      throw new Error('frame length out of range');
    }
    if (this.buf.length < frameLen + 4) return null;
    const type = this.buf.readUInt8(4);
    const streamId = this.buf.readUInt32LE(5);
    const payload = this.buf.subarray(9, 4 + frameLen);
    const frame = { type, streamId, payload: Buffer.from(payload) };
    this.buf = this.buf.subarray(4 + frameLen);
    return frame;
  }
}

// ---- engine lifecycle + single-client request serialization ----
class Engine {
  constructor() { this.proc = null; this.dec = null; this.queue = []; }

  start() {
    if (this.proc) return;
    this.proc = spawn(ENGINE_EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.dec = new FrameDecoder();
    this.pendingControl = null;   // resolver awaiting a control reply
    this.pendingBlobFor = null;   // imageStreamId we still need a 0x02 for
    this.blob = null;
    this.proc.stdout.on('data', d => this._onData(d));
    this.proc.on('exit', () => {
      this.proc = null;
      // The fresh process started on the next request needs a NEW Hello;
      // without this reset ensureHandshake() is skipped and every op on the
      // respawned engine fails with ProtoHandshakeError.
      this._handshaked = false;
      this._failAll('engine exited');
    });
  }

  _failAll(msg) {
    if (this.pendingControl) { this.pendingControl.reject(new Error(msg)); }
    this.pendingControl = null;
  }

  _onData(d) {
    this.dec.feed(d);
    let f;
    try { while ((f = this.dec.next())) this._onFrame(f); }
    catch (e) { this._failAll(e.message); }
  }

  _onFrame(f) {
    if (f.type === 2) {                       // binary blob (preview PNG)
      if (this.pendingBlobFor != null && f.streamId === this.pendingBlobFor) {
        this.blob = f.payload;
        this._maybeResolve();
      }
      return;
    }
    const msg = JSON.parse(f.payload.toString('utf8'));
    if (msg.result === 'PreviewResult' && msg.imageStreamId != null) {
      this.controlMsg = msg;
      this.pendingBlobFor = msg.imageStreamId;
      this._maybeResolve();              // resolves once the blob also arrives
      return;
    }
    this.controlMsg = msg;
    this._maybeResolve();
  }

  _maybeResolve() {
    if (!this.pendingControl) return;
    if (this.pendingBlobFor != null && this.blob == null) return; // wait blob
    const p = this.pendingControl;
    const out = { msg: this.controlMsg, blob: this.blob };
    this.pendingControl = null;
    this.pendingBlobFor = null;
    this.blob = null;
    this.controlMsg = null;
    p.resolve(out);
  }

  // Serialized request: at most one in flight (single client; §3.4).
  request(obj) {
    return new Promise((resolve, reject) => {
      this.queue.push({ obj, resolve, reject });
      if (this.queue.length === 1) this._drain();
    });
  }
  async _drain() {
    while (this.queue.length) {
      const { obj, resolve, reject } = this.queue[0];
      try {
        this.start();
        const r = await new Promise((res, rej) => {
          this.pendingControl = { resolve: res, reject: rej };
          this.proc.stdin.write(
            encodeFrame(1, 0, Buffer.from(JSON.stringify(obj), 'utf8')));
        });
        resolve(r);
      } catch (e) { reject(e); }
      this.queue.shift();
    }
  }

  async ensureHandshake() {
    if (this._handshaked) return;
    const { msg } = await this.request({ op: 'Hello', proto: PROTO });
    if (msg.result !== 'HelloOk') {
      throw new Error('engine handshake failed: ' + JSON.stringify(msg));
    }
    this._handshaked = true;
  }
}

const engine = new Engine();
const previews = new Map();   // token -> PNG Buffer

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Temp contract file with the §6 deletion sequence: written by the broker
// (single owner), engine reads only, deleted only after Released {}.
function withContractFile(contract, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nativeprint-'));
  const file = join(dir, 'contract.json');
  writeFileSync(file, JSON.stringify(contract), { mode: 0o600 });
  return Promise.resolve(fn(file)).finally(async () => {
    try { await engine.request({ op: 'ReleaseContract',
      contractRef: { path: file } }); } catch (_) { /* engine may be gone */ }
    try { unlinkSync(file); } catch (_) { /* best-effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ok */ }
  });
}

function nativePrintBroker() {
  return {
    name: 'native-print-broker',
    configureServer(server) {
      server.middlewares.use('/native-print', async (req, res) => {
        // Dev-only network surface: localhost bind (Vite) + Origin check.
        const origin = req.headers.origin;
        if (origin && !ALLOWED_ORIGINS.has(origin)) {
          res.statusCode = 403; res.end('forbidden origin'); return;
        }
        try {
          const url = new URL(req.url, 'http://localhost');
          if (url.pathname === '/preview' && req.method === 'GET') {
            const png = previews.get(url.searchParams.get('token'));
            if (!png) { res.statusCode = 404; res.end('no preview'); return; }
            res.setHeader('Content-Type', 'image/png');
            res.end(png);
            return;
          }
          if (url.pathname === '/rpc' && req.method === 'POST') {
            const body = await readBody(req);
            await engine.ensureHandshake();
            const out = await handleRpc(body);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(out));
            return;
          }
          res.statusCode = 404; res.end('not found');
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ result: 'Error',
            error: 'BrokerError', detail: String(e && e.message || e) }));
        }
      });
      server.httpServer?.on('close', () => {
        try { engine.proc?.stdin.write(
          encodeFrame(1, 0, Buffer.from(JSON.stringify({ op: 'Shutdown' })))); }
        catch (_) { /* ignore */ }
        try { engine.proc?.kill(); } catch (_) { /* ignore */ }
      });
    }
  };
}

// Browser-facing RPCs. The browser never speaks frames or parses contracts;
// it sends {action, ...} and the broker maps to engine ops.
async function handleRpc(body) {
  if (body.action === 'capabilities') {
    const { msg } = await engine.request({ op: 'GetCapabilities' });
    return msg;
  }
  if (body.action === 'preview') {
    return withContractFile(body.contract, async (file) => {
      const { msg, blob } = await engine.request({
        op: 'RenderPreview', contractRef: { path: file },
        mergeData: body.mergeData || {}, dpi: body.dpi || 150 });
      if (msg.result === 'PreviewResult' && blob) {
        const token = randomBytes(8).toString('hex');
        previews.set(token, blob);
        if (previews.size > 8) previews.delete(previews.keys().next().value);
        msg.previewUrl = '/native-print/preview?token=' + token;
      }
      return msg;
    });
  }
  if (body.action === 'print') {
    return withContractFile(body.contract, async (file) => {
      const { msg } = await engine.request({
        op: 'Print', contractRef: { path: file },
        mergeData: body.mergeData || {}, printerId: body.printerId,
        stockId: body.stockId, copies: body.copies || 1 });
      return msg;
    });
  }
  return { result: 'Error', error: 'BrokerError',
    detail: 'unknown action: ' + body.action };
}

export default {
  root: HERE,
  server: { host: 'localhost', port: 3000, open: true },
  plugins: [nativePrintBroker()]
};
