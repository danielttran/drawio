#!/usr/bin/env node
// Mock print_engine_host for tests.
// Speaks the native proto over stdio: Hello → HelloOk, Print → PrintResult.
// Any job with printerId 'BUSY' returns EngineBusyError.
// Any job with printerId 'HANG' never replies (wedged-host simulation for
// the client request timeout).
// Any contract containing "FORCE_NOTICE" in jobLog triggers a DegradationNotice.
//
// Mirrors host_main.cpp behavior so tests exercise what the real host does:
//   - a malformed control payload gets a loud Error reply, never silence
//   - an unknown op gets an Error reply (ProtoDispatcher::handle), never silence
//   - transport corruption (decoder.failed) exits the process loudly

import { encodeControl, FrameDecoder } from './proto-codec.mjs';

if (process.platform !== 'win32') {
  // Binary stdio is implicit on POSIX
}

const decoder = new FrameDecoder();
let handshaked = false;
let jobSeq = 0;

const KNOWN_OPS = new Set(['Hello', 'Print', 'Ping', 'Shutdown']);

function send(obj) {
  process.stdout.write(encodeControl(obj));
}

process.stdin.on('data', (chunk) => {
  decoder.feed(chunk);
  let frame;
  while ((frame = decoder.next()) !== null) {
    if (frame.type !== 0x01) continue; // skip binary
    let msg;
    try { msg = JSON.parse(frame.payload.toString('utf8')); } catch {
      // host_main.cpp: malformed control payload → loud typed Error reply.
      send({ result: 'Error', error: 'EngineInternalError',
        detail: 'malformed control payload', proto: { major: 1, minor: 0 } });
      continue;
    }

    const { op } = msg;

    // Real host (ProtoDispatcher::handle) ALWAYS replies to unknown/missing
    // ops; a silent mock here hid client-side hangs the real host never has.
    if (typeof op !== 'string') {
      send({ result: 'Error', error: 'EngineInternalError',
        detail: 'missing op', proto: { major: 1, minor: 0 } });
      continue;
    }
    if (!KNOWN_OPS.has(op)) {
      send({ result: 'Error', error: 'EngineInternalError',
        detail: 'unknown op', proto: { major: 1, minor: 0 } });
      continue;
    }

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
      if (msg.printerId === 'HANG') {
        continue; // wedged host: never reply (client timeout test)
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
  // host_main.cpp: transport corruption is fatal — exit loudly, never limp on.
  if (decoder.failed) {
    process.stderr.write(`mock-host: frame decode error: ${decoder.error}\n`);
    process.exit(1);
  }
});

process.stdin.on('end', () => process.exit(0));
