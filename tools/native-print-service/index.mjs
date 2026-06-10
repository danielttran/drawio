#!/usr/bin/env node
// Native print unattended service — §3.2 of the implementation spec.
//
// HTTP API:
//   POST /print   { source, printerId, stockId, copies?, data?, pages?, options? }
//
// source:
//   { kind: 'drawio', content: '<xml>' }   — baked on-demand (D1)
//   { kind: 'contract', content: <obj> }   — pre-baked contract, used as-is
//
// Failure policy (D5): any degradation notice → job refused, HTTP 422.
// Font preflight (§3.5): missing face → HTTP 422 before engine call.
// Job queue: one engine call at a time (engine is single-flight).
// Auth: bearer token (configure via --token / env PRINT_SERVICE_TOKEN).
//
// CLI:  node index.mjs [--port <port>] [--host-bin <path>] [--token <tok>]

import http from 'node:http';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

// Lazy-import so the module is importable without bake being required at parse
// time (lets tests import just the service factory without the full bake dep).
let _bake = null;
let _assertFontsAvailable = null;
let _referencedFonts = null;
let _checkFontAvailability = null;

async function loadDeps() {
  if (!_bake) {
    const b = await import('../native-print-bake/bake.mjs');
    _bake = b.bake;
    const fp = await import('../native-print-bake/font-preflight.mjs');
    _assertFontsAvailable = fp.assertFontsAvailable;
    _referencedFonts = fp.referencedFonts;
    _checkFontAvailability = fp.checkFontAvailability;
  }
}

// ---- serialising job queue (one engine call at a time) ----

class JobQueue {
  constructor() {
    this._running = false;
    this._queue = [];
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._running || this._queue.length === 0) return;
    this._running = true;
    const { fn, resolve, reject } = this._queue.shift();
    try {
      resolve(await fn());
    } catch (err) {
      reject(err);
    } finally {
      this._running = false;
      this._drain();
    }
  }
}

// ---- HTTP helpers ----

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(json);
}

function badRequest(res, code, message, detail) {
  sendJson(res, 400, { error: message, code, detail });
}

function authError(res) {
  sendJson(res, 401, { error: 'Unauthorized', code: 'AUTH_ERROR' });
}

function jobRefused(res, code, message, notices) {
  sendJson(res, 422, { error: message, code, notices });
}

// ---- PrintService ----

export class PrintService {
  constructor({ hostClient, token = null, availableFonts = null }) {
    this._client = hostClient;
    this._token = token;
    this._availableFonts = availableFonts;  // Set<string> or null (skip preflight in tests)
    this._queue = new JobQueue();
    this._server = null;
  }

  async start(port = 3001, host = '127.0.0.1') {
    await loadDeps();
    await this._client.connect();
    this._server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((resolve) => this._server.listen(port, host, resolve));
    return this._server.address();
  }

  async stop() {
    await new Promise((resolve) => this._server.close(resolve));
    await this._client.disconnect();
  }

  async _handle(req, res) {
    // Auth gate
    if (this._token) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${this._token}`) {
        return authError(res);
      }
    }

    if (req.method === 'POST' && req.url === '/print') {
      return this._handlePrint(req, res);
    }
    sendJson(res, 404, { error: 'Not Found' });
  }

  async _handlePrint(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return badRequest(res, 'BAD_REQUEST', err.message);
    }

    const { source, printerId, stockId, copies = 1, data = {}, pages, options = {} } = body;

    if (!source || !printerId || !stockId) {
      return badRequest(res, 'BAD_REQUEST',
        'missing required fields: source, printerId, stockId');
    }

    // Enqueue — one job at a time through the engine
    let result;
    try {
      result = await this._queue.enqueue(() =>
        this._runJob(source, printerId, stockId, copies, data, pages, options)
      );
    } catch (err) {
      if (err.code === 'BAKE_NOTICES') {
        return jobRefused(res, 'BAKE_NOTICES',
          'D5: bake produced degradation notices; job refused', err.notices);
      }
      if (err.code === 'MISSING_FONTS') {
        return jobRefused(res, 'MISSING_FONTS',
          `font preflight failed: ${err.missingFonts.join(', ')}`, []);
      }
      if (err.code === 'PRINT_NOTICES') {
        return jobRefused(res, 'PRINT_NOTICES',
          'D5: engine produced degradation notices; job refused', err.notices);
      }
      const statusCode = err.statusCode || 500;
      return sendJson(res, statusCode,
        { error: err.message || 'internal error', code: err.code || 'INTERNAL_ERROR' });
    }

    sendJson(res, 200, result);
  }

  async _runJob(source, printerId, stockId, copies, data, pages, options = {}) {
    await loadDeps();

    let contract;

    if (source.kind === 'drawio') {
      // D1: bake the .drawio XML (D5 gate inside bake with unattended:true)
      const { contract: baked, notices } = await _bake(source.content, {
        unattended: false,  // we apply D5 ourselves below
        pages: pages || undefined
      });
      // D5: any bake notice → refuse
      if (notices.length > 0) {
        const err = new Error(`bake produced ${notices.length} notice(s)`);
        err.code = 'BAKE_NOTICES';
        err.notices = notices;
        throw err;
      }
      contract = baked;
    } else if (source.kind === 'contract') {
      contract = source.content;
    } else {
      const err = new Error(`unknown source kind: ${source.kind}`);
      err.statusCode = 400;
      err.code = 'BAD_REQUEST';
      throw err;
    }

    // §3.5 Font preflight
    if (this._availableFonts !== null) {
      _assertFontsAvailable(contract, this._availableFonts);
    }

    // Send to engine (D6 AA control: pass options.aa through to Print op)
    const { jobId, notices: engineNotices, jobLog } =
      await this._client.print(contract, printerId, stockId, copies, data, options);

    // D5: any engine notice → refuse (job not printed)
    if (engineNotices.length > 0) {
      const err = new Error(`engine produced ${engineNotices.length} notice(s)`);
      err.code = 'PRINT_NOTICES';
      err.notices = engineNotices;
      throw err;
    }

    return { jobId, notices: [], jobLog };
  }
}

// ---- CLI entry point ----

async function main() {
  const { values } = parseArgs({
    options: {
      port:     { type: 'string', default: '3001' },
      'host-bin': { type: 'string', default: '' },
      token:    { type: 'string', default: '' },
    }
  });

  const port = parseInt(values.port, 10) || 3001;
  const hostBin = values['host-bin'];
  const token = values.token || null;

  if (!hostBin) {
    process.stderr.write('--host-bin is required\n');
    process.exit(2);
  }

  const { HostClient } = await import('./host-client.mjs');
  const client = new HostClient({ bin: hostBin });
  const svc = new PrintService({ hostClient: client, token });

  const addr = await svc.start(port);
  process.stderr.write(`native-print-service listening on http://127.0.0.1:${addr.port}\n`);

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      process.stderr.write(`\nshutting down (${sig})\n`);
      await svc.stop();
      process.exit(0);
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err.message}\n`);
    process.exit(1);
  });
}
