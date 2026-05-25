#!/usr/bin/env node
// Print File: headlessly bakes a .drawio file and prints it directly to a Win32 printer
// using the native C++ print engine.
//
// Usage: node print-file.mjs <input.drawio> <printer_name> [stock_name]
// Example: node print-file.mjs test.drawio "Microsoft Print to PDF" "A4"

import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bake } from './bake.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ENGINE_EXE = resolve(__dir, '../../src/main/native-print-engine/build/Debug/print_engine_host.exe');

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

async function runPrintJob(contract, printerName, stockName) {
  // Setup temp contract file (required by C++ print engine contractRef §6)
  const dir = mkdtempSync(join(tmpdir(), 'nativeprint-cli-'));
  const contractFile = join(dir, 'contract.json');
  writeFileSync(contractFile, JSON.stringify(contract, null, 2), { mode: 0o600 });
  console.log(`[cli] Temp contract written to: ${contractFile}`);

  return new Promise((resolve, reject) => {
    console.log(`[cli] Spawning print engine: ${ENGINE_EXE}`);
    const proc = spawn(ENGINE_EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const dec = new FrameDecoder();
    let handshaked = false;

    proc.stdout.on('data', chunk => {
      dec.feed(chunk);
      let frame;
      try {
        while ((frame = dec.next())) {
          if (frame.type === 1) {
            const msg = JSON.parse(frame.payload.toString('utf8'));
            console.log('[engine stdout]', JSON.stringify(msg, null, 2));

            if (msg.result === 'HelloOk') {
              handshaked = true;
              console.log('[cli] Handshake successful. Sending print job...');
              const printCmd = {
                op: 'Print',
                contractRef: { path: contractFile },
                printerId: printerName,
                stockId: stockName,
                copies: 1,
                mergeData: {}
              };
              proc.stdin.write(encodeFrame(1, 0, Buffer.from(JSON.stringify(printCmd), 'utf8')));
            } else if (msg.result === 'PrintResult') {
              console.log(`[cli] Print job succeeded! Job ID: ${msg.jobId}`);
              cleanupAndFinish();
            } else if (msg.result === 'Error') {
              reject(new Error(`Engine error: ${msg.error} - ${msg.detail}`));
              cleanupAndFinish();
            }
          }
        }
      } catch (e) {
        reject(e);
        cleanupAndFinish();
      }
    });

    proc.on('error', err => {
      reject(err);
      cleanupAndFinish();
    });

    proc.on('exit', code => {
      console.log(`[cli] Print engine exited with code: ${code}`);
      cleanupAndFinish();
    });

    function cleanupAndFinish() {
      // Release contract command to keep protocol clean
      try {
        proc.stdin.write(encodeFrame(1, 0, Buffer.from(JSON.stringify({ op: 'ReleaseContract', contractRef: { path: contractFile } }), 'utf8')));
        proc.stdin.write(encodeFrame(1, 0, Buffer.from(JSON.stringify({ op: 'Shutdown' }), 'utf8')));
      } catch (_) {}
      try { proc.kill(); } catch (_) {}
      try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      resolve();
    }

    // Initiate single-flight handshake
    const hello = { op: 'Hello', proto: { major: 1, minor: 0 } };
    proc.stdin.write(encodeFrame(1, 0, Buffer.from(JSON.stringify(hello), 'utf8')));
  });
}

async function main() {
  const [, , inputPath, printerName, stockName = 'A4'] = process.argv;

  if (!inputPath || !printerName) {
    console.error('Usage: node print-file.mjs <input.drawio> <printer_name> [stock_name]');
    console.error('Example: node print-file.mjs test.drawio "Microsoft Print to PDF" "A4"');
    process.exit(2);
  }

  let xml;
  try {
    xml = await readFile(inputPath, 'utf8');
  } catch (e) {
    console.error(`Error: Cannot read ${inputPath}: ${e.message}`);
    process.exit(2);
  }

  console.log(`[cli] Baking ${inputPath} headlessly...`);
  let baked;
  try {
    baked = await bake(xml);
    console.log(`[cli] Baked successfully. Notices produced: ${baked.notices.length}`);
    for (const n of baked.notices) {
      console.warn(`  [Notice: ${n.kind}] ${n.detail && n.detail.detail || ''}`);
    }
  } catch (e) {
    console.error(`Error: Bake failed: ${e.message}`);
    process.exit(1);
  }

  try {
    await runPrintJob(baked.contract, printerName, stockName);
    console.log('[cli] Completed successfully.');
    process.exit(0);
  } catch (e) {
    console.error(`Error: Printing failed: ${e.message}`);
    process.exit(1);
  }
}

main();
