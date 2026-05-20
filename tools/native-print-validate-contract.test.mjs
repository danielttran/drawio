// Self-checks for tools/native-print-validate-contract.mjs.
//
// Runs the validator as a subprocess against well-formed and malformed
// contracts; pins exit codes + at least one expected diagnostic per failure
// path. Browser-free (pure node --test) per docs/CLAUDE.md C2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(here, 'native-print-validate-contract.mjs');

async function run(contract) {
  const dir = await mkdtemp(join(tmpdir(), 'nprint-val-'));
  const path = join(dir, 'c.json');
  await writeFile(path, JSON.stringify(contract));
  try {
    const r = await execFileP(process.execPath, [SCRIPT, path]);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function minimalValid() {
  return {
    schema: { major: 1, minor: 0 },
    document: {
      units: 'px',
      pages: [{
        id: 'page-1',
        size: { w: 200, h: 100 },
        tiles: [{ origin: { x: 0, y: 0 }, size: { w: 200, h: 100 } }],
        paint: [
          { kind: 'path', box: { x: 0, y: 0, w: 10, h: 10 },
            d: 'M 0 0 L 10 10', stroke: { dash: null } },
          {
            kind: 'text',
            box: { x: 5, y: 5, w: 80, h: 20 },
            font: { family: 'Arial', sizePx: 12, weight: 400, italic: false,
                    underline: false, strikethrough: false, color: '#000000' },
            align: { h: 'left', v: 'top' },
            content: { type: 'static', lines: ['Hello'] }
          }
        ]
      }]
    }
  };
}

test('valid minimal contract exits 0', async () => {
  const r = await run(minimalValid());
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stdout: ${r.stdout}`);
});

test('valid rich-text contract exits 0', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = {
    type: 'rich',
    paragraphs: [{
      align: 'center', indentPx: 0,
      runs: [{ text: 'Bold', fontFamily: 'Arial', sizePx: 14, weight: 700,
               italic: false, underline: false, strikethrough: false,
               color: '#ff0000' }]
    }]
  };
  const r = await run(c);
  assert.equal(r.code, 0, r.stdout);
});

test('wrong schema major exits 1 with a precise diagnostic', async () => {
  const c = minimalValid();
  c.schema.major = 2;
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\$\.schema\.major: must be 1/);
});

test('non-px units exits 1', async () => {
  const c = minimalValid();
  c.document.units = 'mm';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /units: must be "px"/);
});

test('empty text content lines exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = { type: 'static', lines: [] };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /content\.lines: static text must have at least one line/);
});

test('empty SVG source exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint.push({
    kind: 'svg', box: { x: 0, y: 0, w: 50, h: 50 }, source: '', aspect: 'fill'
  });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.source: base64 svg source is empty/);
});

test('text with unknown alignment value exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].align.h = 'middle';  // 'middle' is V-only
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /align\.h: must be left\|center\|right/);
});

test('non-positive box dim exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].box.w = 0;
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /box\.w: not strictly positive/);
});

test('stroke without dash key exits 1 (engine requires dash present, null OK)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].stroke = {
    paint: { type: 'solid', color: '#000', alpha: 1 },
    width: 2, cap: 'butt', join: 'miter', miterLimit: 10
  }; // no dash key
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /stroke\.dash: stroke object missing required dash key/);
});

test('non-existent contract path exits 2', async () => {
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '/tmp/definitely-not-a-real-path.json'],
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout, stderr });
      });
  });
  assert.equal(r.code, 2);
});

test('no argument exits 2', async () => {
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
  assert.equal(r.code, 2);
});
