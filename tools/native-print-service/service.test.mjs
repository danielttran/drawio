// Tests for the native-print unattended service (§3.2).
// Browser-free: pure node --test.
// Uses a mock host process (mock-host.mjs) instead of the real Windows binary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PrintService } from './index.mjs';
import { HostClient } from './host-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mockHostScript = resolve(here, './mock-host.mjs');

// Spawn a mock host process
function spawnMock(bin, args) {
  return spawn(process.execPath, [bin, ...args],
    { stdio: ['pipe', 'pipe', 'inherit'] });
}

// Minimal um-unit contract for testing (valid schema 1.1)
const MINIMAL_CONTRACT = {
  schema: { major: 1, minor: 1 },
  document: {
    units: 'um',
    pages: [{
      id: 'page-1',
      size: { w: 25400, h: 25400 },
      tiles: [{ origin: { x: 0, y: 0 }, size: { w: 25400, h: 25400 } }],
      paint: []
    }]
  }
};

// Contract that triggers a mock notice (mock-host checks for FORCE_NOTICE in inline JSON)
const NOTICE_CONTRACT = {
  schema: { major: 1, minor: 1 },
  document: {
    units: 'um',
    pages: [{
      id: 'page-1',
      size: { w: 25400, h: 25400 },
      tiles: [{ origin: { x: 0, y: 0 }, size: { w: 25400, h: 25400 } }],
      paint: [{ kind: 'path', d: 'FORCE_NOTICE', fill: null, stroke: null }]
    }]
  }
};

async function fetch(url, opts = {}) {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const body = opts.body ? Buffer.from(opts.body, 'utf8') : null;
    const parsedUrl = new URL(url);
    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          json: () => JSON.parse(text),
          text: () => text
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function makeService(opts = {}) {
  const client = new HostClient({
    bin: mockHostScript,
    spawnFn: spawnMock
  });
  const svc = new PrintService({
    hostClient: client,
    token: opts.token || null,
    availableFonts: opts.availableFonts !== undefined ? opts.availableFonts : null
  });
  const addr = await svc.start(0); // port 0 = OS assigns
  return { svc, port: addr.port };
}

// --- proto-codec unit tests ---

test('encodeFrame / FrameDecoder: round-trip control frame', async () => {
  const { encodeControl, FrameDecoder } = await import('./proto-codec.mjs');
  const msg = { op: 'Hello', proto: { major: 1, minor: 0 } };
  const encoded = encodeControl(msg);
  const dec = new FrameDecoder();
  dec.feed(encoded);
  const frame = dec.next();
  assert.ok(frame, 'expected a frame');
  assert.equal(frame.type, 0x01);
  const decoded = JSON.parse(frame.payload.toString('utf8'));
  assert.deepEqual(decoded, msg);
});

test('FrameDecoder: handles partial chunks', async () => {
  const { encodeControl, FrameDecoder } = await import('./proto-codec.mjs');
  const msg = { result: 'HelloOk' };
  const encoded = encodeControl(msg);
  const dec = new FrameDecoder();
  // Feed one byte at a time
  for (let i = 0; i < encoded.length; i++) {
    dec.feed(encoded.subarray(i, i + 1));
  }
  const frame = dec.next();
  assert.ok(frame);
  assert.deepEqual(JSON.parse(frame.payload.toString('utf8')), msg);
});

test('FrameDecoder: fails on bad frame length', async () => {
  const { FrameDecoder } = await import('./proto-codec.mjs');
  const dec = new FrameDecoder();
  const bad = Buffer.alloc(4);
  bad.writeUInt32LE(3, 0); // frameLen=3 < min 5
  dec.feed(bad);
  assert.equal(dec.failed, true);
});

// --- HostClient unit tests ---

test('HostClient: connects to mock host and handshakes', async () => {
  const client = new HostClient({ bin: mockHostScript, spawnFn: spawnMock });
  await client.connect();
  assert.equal(client._connected, true);
  await client.disconnect();
});

test('HostClient: print returns jobId', async () => {
  const client = new HostClient({ bin: mockHostScript, spawnFn: spawnMock });
  await client.connect();
  const result = await client.print(MINIMAL_CONTRACT, 'mock-printer', 'stock-1', 1);
  assert.ok(result.jobId.startsWith('mock-job-'));
  assert.deepEqual(result.notices, []);
  await client.disconnect();
});

test('HostClient: engine error maps to HostClientError', async () => {
  const client = new HostClient({ bin: mockHostScript, spawnFn: spawnMock });
  await client.connect();
  await assert.rejects(
    () => client.print(MINIMAL_CONTRACT, 'BUSY', 'stock-1', 1),
    (err) => err.code === 'EngineBusyError'
  );
  await client.disconnect();
});

// --- PrintService HTTP API tests ---

test('POST /print with contract source returns 200 and jobId', async () => {
  const { svc, port } = await makeService();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      body: JSON.stringify({
        source: { kind: 'contract', content: MINIMAL_CONTRACT },
        printerId: 'my-printer',
        stockId: 'stock-a4'
      })
    });
    assert.equal(res.status, 200);
    const body = res.json();
    assert.ok(body.jobId, 'expected jobId in response');
    assert.deepEqual(body.notices, []);
  } finally {
    await svc.stop();
  }
});

test('POST /print with drawio source bakes and returns 200', async () => {
  const { svc, port } = await makeService();
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="Hello" style="rounded=1;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="30" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      body: JSON.stringify({
        source: { kind: 'drawio', content: xml },
        printerId: 'my-printer',
        stockId: 'stock-a4'
      })
    });
    assert.equal(res.status, 200, `unexpected status: ${res.text()}`);
    const body = res.json();
    assert.ok(body.jobId);
    assert.deepEqual(body.notices, []);
  } finally {
    await svc.stop();
  }
});

test('engine notices: job is NOT falsely refused after printing; notices reported', async () => {
  // Op::Print physically prints before returning notices, so a 422
  // "refused" here was a lie (the sheet was already out) and made
  // retrying clients print duplicates. The printed job must be reported
  // honestly with its notices; degradation-severity kinds are surfaced
  // separately for the caller's judgement.
  const { svc, port } = await makeService();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      body: JSON.stringify({
        source: { kind: 'contract', content: NOTICE_CONTRACT },
        printerId: 'my-printer',
        stockId: 'stock-a4'
      })
    });
    assert.equal(res.status, 200);
    const body = res.json();
    assert.ok(body.jobId, 'printed job id reported');
    assert.equal(body.notices.length, 1);
    assert.equal(body.notices[0].kind, 'StubbedSvgArtwork');
    assert.equal(body.degradations.length, 1,
      'StubbedSvgArtwork is degradation severity and surfaced as such');
  } finally {
    await svc.stop();
  }
});

test('D5: bake notices → 422 job refused', async () => {
  const { svc, port } = await makeService();
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="" style="shape=definitelyUnknownShape;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="60" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      body: JSON.stringify({
        source: { kind: 'drawio', content: xml },
        printerId: 'my-printer',
        stockId: 'stock-a4'
      })
    });
    assert.equal(res.status, 422);
    const body = res.json();
    assert.equal(body.code, 'BAKE_NOTICES');
  } finally {
    await svc.stop();
  }
});

test('§3.5: missing font → 422 before engine', async () => {
  const { svc, port } = await makeService({
    availableFonts: new Set(['Helvetica'])  // Arial missing → preflight fails
  });
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="Hi" style="rounded=1;fontFamily=Arial;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="30" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      body: JSON.stringify({
        source: { kind: 'drawio', content: xml },
        printerId: 'my-printer',
        stockId: 'stock-a4'
      })
    });
    assert.equal(res.status, 422);
    const body = res.json();
    assert.equal(body.code, 'MISSING_FONTS');
  } finally {
    await svc.stop();
  }
});

test('auth: missing token → 401', async () => {
  const { svc, port } = await makeService({ token: 'secret' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      body: JSON.stringify({
        source: { kind: 'contract', content: MINIMAL_CONTRACT },
        printerId: 'p',
        stockId: 's'
      })
    });
    assert.equal(res.status, 401);
  } finally {
    await svc.stop();
  }
});

test('auth: correct bearer token → 200', async () => {
  const { svc, port } = await makeService({ token: 'secret' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({
        source: { kind: 'contract', content: MINIMAL_CONTRACT },
        printerId: 'p',
        stockId: 's'
      })
    });
    assert.equal(res.status, 200);
  } finally {
    await svc.stop();
  }
});

test('bad request: missing printerId → 400', async () => {
  const { svc, port } = await makeService();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      body: JSON.stringify({ source: { kind: 'contract', content: MINIMAL_CONTRACT } })
    });
    assert.equal(res.status, 400);
  } finally {
    await svc.stop();
  }
});

test('unknown route → 404', async () => {
  const { svc, port } = await makeService();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    assert.equal(res.status, 404);
  } finally {
    await svc.stop();
  }
});

test('queue: concurrent requests serialise (no EngineBusy)', async () => {
  const { svc, port } = await makeService();
  try {
    // Fire 3 simultaneous requests; they should all succeed (queued, not concurrent)
    const requests = Array.from({ length: 3 }, () =>
      fetch(`http://127.0.0.1:${port}/print`, {
        method: 'POST',
        body: JSON.stringify({
          source: { kind: 'contract', content: MINIMAL_CONTRACT },
          printerId: 'my-printer',
          stockId: 'stock-a4'
        })
      })
    );
    const results = await Promise.all(requests);
    for (const res of results) {
      assert.equal(res.status, 200, `concurrent request failed: ${res.text()}`);
    }
  } finally {
    await svc.stop();
  }
});

test('invalid JSON body → 400', async () => {
  const { svc, port } = await makeService();
  try {
    const { default: http } = await import('node:http');
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/print', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject);
      req.write('not valid json');
      req.end();
    });
    assert.equal(res.status, 400);
  } finally {
    await svc.stop();
  }
});

test('audit7: encodeFrame refuses oversize payloads with a typed error (C++ parity)', async () => {
  const { encodeFrame, FrameType } = await import('./proto-codec.mjs');
  // Just over the 64 MiB frame limit: without the encode-side guard the
  // peer's decoder hard-fails on the length prefix and kills the transport.
  const oversize = Buffer.alloc(64 * 1024 * 1024 - 4);
  assert.throws(
    () => encodeFrame(FrameType.Control, 0, oversize),
    (e) => e.code === 'FRAME_TOO_LARGE' && /frame limit/.test(e.message));
  // At the limit exactly: still encodable (frameLen == MAX_FRAME_LEN).
  const atLimit = Buffer.alloc(64 * 1024 * 1024 - 5);
  const frame = encodeFrame(FrameType.Control, 0, atLimit);
  assert.equal(frame.readUInt32LE(0), 64 * 1024 * 1024);
});
