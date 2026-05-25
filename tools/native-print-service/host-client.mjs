// Client for the native print engine host process (stdio protocol).
//
// Manages a single host process lifetime: Hello handshake → print jobs →
// Shutdown. The engine is single-flight per process (EngineBusyError if two
// Print ops overlap), so this client serialises calls via a simple queue.
//
// Usage:
//   const client = new HostClient({ bin: '/path/to/print_engine_host' });
//   await client.connect();
//   const result = await client.print(contractJson, printerId, stockId, copies);
//   await client.disconnect();

import { spawn } from 'node:child_process';
import { encodeControl, FrameDecoder, FrameType } from './proto-codec.mjs';

const PROTO_MAJOR = 1;
const PROTO_MINOR = 0;

export class HostClientError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export class HostClient {
  constructor({ bin, args = [], spawnFn = null }) {
    this._bin = bin;
    this._args = args;
    this._spawnFn = spawnFn;  // injectable for tests
    this._proc = null;
    this._decoder = new FrameDecoder();
    this._pending = null;    // { resolve, reject }
    this._connected = false;
    this._closed = false;
  }

  async connect() {
    if (this._connected) throw new Error('already connected');

    const spawnFn = this._spawnFn || ((bin, args) =>
      spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] })
    );
    this._proc = spawnFn(this._bin, this._args);

    this._proc.stdout.on('data', (chunk) => this._onData(chunk));
    this._proc.stdout.on('end', () => this._onClose('stdout EOF'));
    this._proc.on('error', (err) => this._onClose(`process error: ${err.message}`));
    this._proc.on('close', (code) => {
      if (!this._closed) this._onClose(`process exited with code ${code}`);
    });

    // Hello handshake
    const reply = await this._sendAndWait({
      op: 'Hello',
      proto: { major: PROTO_MAJOR, minor: PROTO_MINOR }
    });
    if (reply.result !== 'HelloOk') {
      throw new HostClientError('HANDSHAKE_FAILED', `Hello failed: ${reply.result}`, reply);
    }
    this._connected = true;
  }

  // Send a Print command. Returns { jobId, notices, jobLog }.
  // opts.aa: 'on' (default, AA on) | 'crisp' (edge-crisp, D6 AA control)
  async print(contractJson, printerId, stockId, copies = 1, merge = {}, opts = {}) {
    if (!this._connected) throw new Error('not connected; call connect() first');
    if (this._closed) throw new HostClientError('HOST_CLOSED', 'host process closed');

    const msg = {
      op: 'Print',
      contractRef: { inline: JSON.stringify(contractJson) },
      printerId,
      stockId,
      copies,
      mergeData: merge
    };
    if (opts.aa === 'crisp') msg.aa = 'crisp';

    const reply = await this._sendAndWait(msg);

    if (reply.result === 'Error') {
      throw new HostClientError(reply.error || 'PRINT_FAILED',
        reply.detail || 'engine print failed', reply);
    }
    if (reply.result !== 'PrintResult') {
      throw new HostClientError('UNEXPECTED_RESULT',
        `unexpected result: ${reply.result}`, reply);
    }
    return {
      jobId: reply.jobId,
      notices: reply.notices || [],
      jobLog: reply.jobLog || {}
    };
  }

  async disconnect() {
    if (!this._proc || this._closed) return;
    try {
      await this._sendAndWait({ op: 'Shutdown' });
    } catch { /* ignore — we're shutting down */ }
    this._closed = true;
    this._proc.stdin.end();
  }

  // --- internals ---

  _sendAndWait(msg) {
    return new Promise((resolve, reject) => {
      if (this._pending) {
        return reject(new Error('a request is already in flight'));
      }
      this._pending = { resolve, reject };
      try {
        this._proc.stdin.write(encodeControl(msg));
      } catch (err) {
        this._pending = null;
        reject(err);
      }
    });
  }

  _onData(chunk) {
    this._decoder.feed(chunk);
    if (this._decoder.failed) {
      this._onClose(`frame decode error: ${this._decoder.error}`);
      return;
    }
    let frame;
    while ((frame = this._decoder.next()) !== null) {
      if (frame.type !== FrameType.Control) continue; // skip binary frames
      let json;
      try {
        json = JSON.parse(frame.payload.toString('utf8'));
      } catch (err) {
        this._onClose(`control JSON parse error: ${err.message}`);
        return;
      }
      const pending = this._pending;
      this._pending = null;
      if (pending) pending.resolve(json);
    }
  }

  _onClose(reason) {
    this._closed = true;
    const pending = this._pending;
    this._pending = null;
    if (pending) {
      pending.reject(new HostClientError('HOST_CLOSED', `host closed: ${reason}`));
    }
  }
}
