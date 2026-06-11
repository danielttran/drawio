// Client for the native print engine host process (stdio protocol).
//
// Manages a single host process lifetime: Hello handshake → print jobs →
// Shutdown. The engine is single-flight per process (EngineBusyError if two
// Print ops overlap), so this client serialises calls via a simple queue.
//
// Every request carries a timeout (default 120 s): a wedged host previously
// left the pending promise (and the service's job queue behind it) hanging
// forever. On timeout the pending request rejects with a typed
// HOST_TIMEOUT error, the host process is killed, and the client marks
// itself for respawn — the next print() spawns a fresh host and re-runs the
// Hello handshake, mirroring how the dev broker's Engine respawns on exit.
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
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class HostClientError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export class HostClient {
  constructor({ bin, args = [], spawnFn = null, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this._bin = bin;
    this._args = args;
    this._spawnFn = spawnFn;  // injectable for tests
    this._requestTimeoutMs = requestTimeoutMs;
    this._proc = null;
    this._decoder = new FrameDecoder();
    this._pending = null;    // { resolve, reject, timer }
    this._connected = false;
    this._everConnected = false;
    this._closed = false;    // deliberate disconnect() only — host death/
                             // timeout marks for RESPAWN instead
  }

  async connect() {
    if (this._connected) throw new Error('already connected');
    if (this._closed) throw new HostClientError('HOST_CLOSED', 'client was disconnected');

    const spawnFn = this._spawnFn || ((bin, args) =>
      spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] })
    );
    this._decoder = new FrameDecoder();  // fresh stream state per process
    this._proc = spawnFn(this._bin, this._args);
    const proc = this._proc;

    proc.stdout.on('data', (chunk) => {
      if (this._proc === proc) this._onData(chunk);
    });
    proc.stdout.on('end', () => {
      if (this._proc === proc) this._onClose('stdout EOF');
    });
    proc.on('error', (err) => {
      if (this._proc === proc) this._onClose(`process error: ${err.message}`);
    });
    proc.on('close', (code) => {
      if (this._proc === proc && !this._closed) {
        this._onClose(`process exited with code ${code}`);
      }
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
    this._everConnected = true;
  }

  // Send a Print command. Returns { jobId, notices, jobLog }.
  // opts.aa: 'on' (default, AA on) | 'crisp' (edge-crisp, D6 AA control)
  async print(contractJson, printerId, stockId, copies = 1, merge = {}, opts = {}) {
    if (!this._everConnected) throw new Error('not connected; call connect() first');
    if (this._closed) throw new HostClientError('HOST_CLOSED', 'host process closed');
    // Respawn after a host death or a timed-out (killed) host: the next job
    // gets a fresh process + handshake instead of failing forever.
    if (!this._connected) await this.connect();

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
    if (!this._proc || this._closed) {
      this._closed = true;
      return;
    }
    if (this._connected) {
      try {
        await this._sendAndWait({ op: 'Shutdown' });
      } catch { /* ignore — we're shutting down */ }
    }
    this._closed = true;
    this._connected = false;
    try { this._proc.stdin.end(); } catch { /* already dead */ }
  }

  // --- internals ---

  _sendAndWait(msg) {
    return new Promise((resolve, reject) => {
      if (this._pending) {
        return reject(new Error('a request is already in flight'));
      }
      const pending = { resolve, reject, timer: null };
      this._pending = pending;
      const timeoutMs = this._requestTimeoutMs;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeout(() => this._onTimeout(pending, msg.op), timeoutMs);
        // never keep the event loop alive just for a watchdog
        if (typeof pending.timer.unref === 'function') pending.timer.unref();
      }
      try {
        this._proc.stdin.write(encodeControl(msg));
      } catch (err) {
        this._settle(pending);
        reject(err);
      }
    });
  }

  _settle(pending) {
    if (pending.timer) clearTimeout(pending.timer);
    if (this._pending === pending) this._pending = null;
  }

  _onTimeout(pending, op) {
    if (this._pending !== pending) return;  // already answered
    this._settle(pending);
    // The host is wedged: kill it so the close handler marks the client for
    // respawn, then surface a typed error to the caller.
    this._connected = false;
    try { this._proc?.kill(); } catch { /* already dead */ }
    pending.reject(new HostClientError('HOST_TIMEOUT',
      `host did not reply to ${op} within ${this._requestTimeoutMs} ms; ` +
      'host killed, client will respawn it on the next request'));
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
      if (pending) {
        this._settle(pending);
        pending.resolve(json);
      }
    }
  }

  _onClose(reason) {
    // Host death is NOT a deliberate disconnect: mark for respawn (the dev
    // broker's Engine does the same — proc=null, re-spawn on next request).
    this._connected = false;
    this._proc = null;
    const pending = this._pending;
    if (pending) {
      this._settle(pending);
      pending.reject(new HostClientError('HOST_CLOSED', `host closed: ${reason}`));
    }
  }
}
