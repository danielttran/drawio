#!/usr/bin/env node
// Mock print_engine_host for tests.
// Speaks the native proto over stdio: Hello → HelloOk, Print → PrintResult.
// Any job with printerId 'BUSY' returns EngineBusyError.
// Any contract containing "FORCE_NOTICE" in jobLog triggers a DegradationNotice.

import { encodeControl, FrameDecoder } from './proto-codec.mjs';

if (process.platform !== 'win32') {
  // Binary stdio is implicit on POSIX
}

const decoder = new FrameDecoder();
let handshaked = false;
let jobSeq = 0;

function send(obj) {
  process.stdout.write(encodeControl(obj));
}

process.stdin.on('data', (chunk) => {
  decoder.feed(chunk);
  let frame;
  while ((frame = decoder.next()) !== null) {
    if (frame.type !== 0x01) continue; // skip binary
    let msg;
    try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }

    const { op } = msg;

    if (op === 'Hello') {
      handshaked = true;
      send({
        result: 'HelloOk',
        engineVersion: 'mock-host',
        proto: { major: 1, minor: 0 },
        supportedSchemaMajor: 1,
        supportedSchemaMinor: 1,
        notices: []
      });
      continue;
    }

    if (!handshaked) {
      send({ result: 'Error', error: 'ProtoHandshakeError', detail: 'Hello required first', proto: { major: 1, minor: 0 } });
      continue;
    }

    if (op === 'Print') {
      if (msg.printerId === 'BUSY') {
        send({ result: 'Error', error: 'EngineBusyError', detail: 'mock busy', proto: { major: 1, minor: 0 } });
        continue;
      }

      const notices = [];
      // Emit a notice if the inline contract says so
      const inlineStr = msg.contractRef && msg.contractRef.inline;
      if (inlineStr && inlineStr.includes('FORCE_NOTICE')) {
        notices.push({
          kind: 'StubbedSvgArtwork',
          pageId: 'page-1',
          detail: { detail: 'forced by test' }
        });
      }

      const jobId = `mock-job-${++jobSeq}`;
      send({
        result: 'PrintResult',
        jobId,
        notices,
        jobLog: { engineVersion: 'mock-host', printerId: msg.printerId },
        proto: { major: 1, minor: 0 }
      });
      continue;
    }

    if (op === 'Ping') {
      send({ result: 'Pong', engineUptimeMs: 0, proto: { major: 1, minor: 0 } });
      continue;
    }

    if (op === 'Shutdown') {
      send({ result: 'ShutdownAck', proto: { major: 1, minor: 0 } });
      process.stdout.end();
      process.exit(0);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
