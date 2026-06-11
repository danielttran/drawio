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
          // Per Appendix A, path nodes do NOT carry a JSON `box` — the
          // engine derives bounds from `d`. The validator must match.
          // The stroke carries the FULL engine-required shape
          // (contract_loader.cpp): a {dash:null}-only stroke was blessed by
          // the old lax validator but rejected by the engine at print time.
          { kind: 'path', d: 'M 0 0 L 10 10',
            fill: null,
            stroke: { paint: { type: 'solid', color: '#000000', alpha: 1 },
                      width: 1, cap: 'butt', join: 'miter', miterLimit: 4,
                      dash: null } },
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

test('missing schema minor exits 1 (engine require_int\'s schema.minor)', async () => {
  const c = minimalValid();
  delete c.schema.minor;
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\$\.schema\.minor: must be a non-negative integer/);
});

test('negative schema minor exits 1', async () => {
  const c = minimalValid();
  c.schema.minor = -1;
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\$\.schema\.minor: must be a non-negative integer/);
});

test('single-stop gradient passes (engine accepts >= 1 stop)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].fill = {
    type: 'linear',
    stops: [{ offset: 0.5, color: '#336699', alpha: 1 }]
  };
  const r = await run(c);
  assert.equal(r.code, 0, r.stdout);
});

test('zero-stop gradient exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].fill = { type: 'radial', stops: [] };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.stops: gradient needs >= 1 stop/);
});

test('unknown units exits 1 (mm)', async () => {
  const c = minimalValid();
  c.document.units = 'mm';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /units: must be "px" or "um"/);
});

test('um units passes validation', async () => {
  const c = minimalValid();
  c.document.units = 'um';
  const r = await run(c);
  assert.equal(r.code, 0);
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

test('lowercase relative path command exits 1 (paths must be absolute)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = 'm 0 0 l 10 10';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.d: only absolute SVG path commands are supported/);
});

// --- path `d` grammar: mirror of path_parser.cpp (no false reds/greens) ---

test('path d with exponent numbers passes (engine from_chars accepts 1e2)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = 'M 0 0 L 1e2 5E1 L 1.5e-1 .5';
  const r = await run(c);
  assert.equal(r.code, 0, r.stdout);
});

test('path d with leading whitespace/commas passes (engine skips separators)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = '  ,\t M 0 0 L 10 10 ';
  const r = await run(c);
  assert.equal(r.code, 0, r.stdout);
});

test('path d starting with a non-M command passes (engine accepts it)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = 'L 10 10 H 20 V 30 Z';
  const r = await run(c);
  assert.equal(r.code, 0, r.stdout);
});

test('path d with leading + and trailing-dot numbers passes', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = 'M +5. 3 L 10 10';
  const r = await run(c);
  assert.equal(r.code, 0, r.stdout);
});

test('path d with engine-unsupported Q command exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = 'M 0 0 Q 1 1 2 2';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.d: engine-unsupported path command "Q"/);
});

test('path d with missing command arguments exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = 'M 0 0 L 10';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.d: path command L has missing or malformed numeric argument/);
});

test('path d that is Z-only exits 1 (no positioned command)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = 'Z';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.d: path must contain at least one positioned command/);
});

test('empty path d exits 1 (no commands)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = '   ';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.d: path must contain at least one command/);
});

test('path d with trailing junk number-start exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].d = 'M 0 0 L 10 10 5';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.d: only absolute SVG path commands are supported/);
});

// --- solid paint alpha is REQUIRED (loader parse_paint require_number) ---

test('solid paint without alpha exits 1 (engine requires alpha)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].fill = { type: 'solid', color: '#112233' };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /fill\.alpha: solid paint requires alpha/);
});

test('gradient stop with alpha:null exits 1 (present key must be a number)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].fill = {
    type: 'linear',
    stops: [{ offset: 0, color: '#112233', alpha: null }]
  };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /stops\[0\]\.alpha: alpha must be a number in \[0,1\] when present/);
});

// --- stroke.paint null reject (loader read_optional_stroke require_object) ---

test('stroke with paint:null exits 1 (engine requires a paint object)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].stroke = {
    paint: null, width: 1, cap: 'butt', join: 'miter', miterLimit: 4, dash: null
  };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /stroke\.paint: stroke requires a paint OBJECT/);
});

// --- font weight/italic/color (loader text branch) ---

test('text font without weight exits 1 (engine require_int)', async () => {
  const c = minimalValid();
  delete c.document.pages[0].paint[1].font.weight;
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /font\.weight: engine requires an integer font weight/);
});

test('text font with non-integer weight exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].font.weight = 400.5;
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /font\.weight: engine requires an integer font weight/);
});

test('text font without italic exits 1 (engine require_bool)', async () => {
  const c = minimalValid();
  delete c.document.pages[0].paint[1].font.italic;
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /font\.italic: engine requires a boolean italic flag/);
});

test('text font without color exits 1 / bad hex exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].font.color = '#00f';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /font\.color: engine requires exactly #rrggbb/);
});

test('text font underline present but non-bool exits 1; absent passes', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].font.underline = 'yes';
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /font\.underline: must be a boolean when present/);

  const c2 = minimalValid();
  delete c2.document.pages[0].paint[1].font.underline;
  delete c2.document.pages[0].paint[1].font.strikethrough;
  const r2 = await run(c2);
  assert.equal(r2.code, 0, r2.stdout);
});

// --- static/rich extraneous-key rejection (loader reject_key) ---

test('static content carrying merge keys exits 1 (engine reject_key)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = {
    type: 'static', lines: ['Hi'], wrap: 'word'
  };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /content\.wrap: field is not allowed on static content/);
});

test('rich content carrying shrinkFloorPx exits 1 (engine reject_key)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = {
    type: 'rich', shrinkFloorPx: 4,
    paragraphs: [{ align: 'left', runs: [{ text: 'x', fontFamily: 'Arial',
      sizePx: 10, weight: 400, italic: false, underline: false,
      strikethrough: false, color: '#000000' }] }]
  };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /content\.shrinkFloorPx: field is not allowed on rich content/);
});

// --- rich run/paragraph field validation (loader read_rich_paragraphs) ---

test('rich run missing fontFamily exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = {
    type: 'rich',
    paragraphs: [{ align: 'left', runs: [{ text: 'x', sizePx: 10, weight: 400,
      italic: false, underline: false, strikethrough: false, color: '#000000' }] }]
  };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /runs\[0\]\.fontFamily: must be a string/);
});

test('rich run missing underline exits 1 (run bools are REQUIRED)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = {
    type: 'rich',
    paragraphs: [{ align: 'left', runs: [{ text: 'x', fontFamily: 'Arial',
      sizePx: 10, weight: 400, italic: false, strikethrough: false,
      color: '#000000' }] }]
  };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /runs\[0\]\.underline: engine requires a boolean/);
});

test('rich paragraph with bogus align exits 1 (engine enum)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = {
    type: 'rich',
    paragraphs: [{ align: 'justify', runs: [{ text: 'x', fontFamily: 'Arial',
      sizePx: 10, weight: 400, italic: false, underline: false,
      strikethrough: false, color: '#000000' }] }]
  };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /paragraphs\[0\]\.align: must be left\|center\|right/);
});

test('rich paragraph with negative indentPx exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = {
    type: 'rich',
    paragraphs: [{ align: 'left', indentPx: -1, runs: [{ text: 'x',
      fontFamily: 'Arial', sizePx: 10, weight: 400, italic: false,
      underline: false, strikethrough: false, color: '#000000' }] }]
  };
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /paragraphs\[0\]\.indentPx: must be a number >= 0/);
});

// --- merge content type/enum/range + shrinkFloorPx-iff-shrink ---

function mergeContent(overrides) {
  return Object.assign({
    type: 'merge', key: 'K', sample: 'S', maxLen: 10,
    wrap: 'none', overflow: 'reject'
  }, overrides);
}

test('valid merge content passes', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = mergeContent();
  const r = await run(c);
  assert.equal(r.code, 0, r.stdout);
});

test('merge content with non-string key exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = mergeContent({ key: 5 });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /content\.key: merge content requires a string here/);
});

test('merge content with negative maxLen exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = mergeContent({ maxLen: -2 });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /content\.maxLen: merge content requires a non-negative integer/);
});

test('merge content with unknown wrap/overflow enum exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = mergeContent({ wrap: 'char' });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /content\.wrap: must be none\|word/);

  const c2 = minimalValid();
  c2.document.pages[0].paint[1].content = mergeContent({ overflow: 'grow' });
  const r2 = await run(c2);
  assert.equal(r2.code, 1);
  assert.match(r2.stdout, /content\.overflow: must be reject\|clip\|shrink/);
});

test('merge overflow:shrink requires shrinkFloorPx > 0', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content = mergeContent({ overflow: 'shrink' });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /content\.shrinkFloorPx: overflow:"shrink" requires shrinkFloorPx > 0/);

  const c2 = minimalValid();
  c2.document.pages[0].paint[1].content =
    mergeContent({ overflow: 'shrink', shrinkFloorPx: 6 });
  const r2 = await run(c2);
  assert.equal(r2.code, 0, r2.stdout);
});

test('merge with shrinkFloorPx but non-shrink overflow exits 1 (reject_key)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[1].content =
    mergeContent({ overflow: 'clip', shrinkFloorPx: 6 });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /content\.shrinkFloorPx: only allowed with overflow:"shrink"/);
});

// --- image flipH/flipV + base64 shape (loader image branch) ---

function validImage() {
  return { kind: 'image', box: { x: 0, y: 0, w: 50, h: 50 },
    format: 'png', data: 'iVBORw0KGgoAAAA=', aspect: 'fill', flipH: false, flipV: false };
  // (full 8-byte PNG signature prefix: the validator now checks it)
}

test('image with flipH/flipV bools passes', async () => {
  const c = minimalValid();
  c.document.pages[0].paint.push(validImage());
  const r = await run(c);
  assert.equal(r.code, 0, r.stdout);
});

test('image missing flipH exits 1 (engine requires it)', async () => {
  const c = minimalValid();
  const img = validImage();
  delete img.flipH;
  c.document.pages[0].paint.push(img);
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.flipH: engine requires a boolean here/);
});

test('image data with bad base64 shape exits 1 (length % 4, mid-=)', async () => {
  const c = minimalValid();
  const img = validImage();
  img.data = 'iVBOR';  // length not multiple of 4
  c.document.pages[0].paint.push(img);
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.data: image data must be base64/);

  const c2 = minimalValid();
  const img2 = validImage();
  img2.data = 'iV==AAAA';  // '=' mid-block
  c2.document.pages[0].paint.push(img2);
  const r2 = await run(c2);
  assert.equal(r2.code, 1);
  assert.match(r2.stdout, /\.data: image data must be base64/);
});

test('svg source with bad base64 shape exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint.push({
    kind: 'svg', box: { x: 0, y: 0, w: 50, h: 50 },
    source: 'PHN2Zz4!', aspect: 'fill'
  });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.source: svg source must be base64/);
});

// --- barcode value rules (loader barcode branch) ---

test('barcode static value requires data string', async () => {
  const c = minimalValid();
  c.document.pages[0].paint.push({
    kind: 'barcode', box: { x: 0, y: 0, w: 50, h: 20 },
    symbology: 'code128', value: { type: 'static' }
  });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.value\.data: barcode static value requires a string data field/);

  const c2 = minimalValid();
  c2.document.pages[0].paint.push({
    kind: 'barcode', box: { x: 0, y: 0, w: 50, h: 20 },
    symbology: 'code128', value: { type: 'static', data: '12345' }
  });
  const r2 = await run(c2);
  assert.equal(r2.code, 0, r2.stdout);
});

test('barcode merge value requires key/sample/maxLen/errorOnUnencodable===true', async () => {
  const valid = { type: 'merge', key: 'K', sample: 'S', maxLen: 20,
    errorOnUnencodable: true };
  const mk = (value) => {
    const c = minimalValid();
    c.document.pages[0].paint.push({
      kind: 'barcode', box: { x: 0, y: 0, w: 50, h: 20 },
      symbology: 'code128', value
    });
    return c;
  };
  assert.equal((await run(mk(valid))).code, 0);

  const noKey = { ...valid }; delete noKey.key;
  let r = await run(mk(noKey));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.value\.key: barcode merge value requires a string/);

  r = await run(mk({ ...valid, maxLen: 1.5 }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.value\.maxLen: barcode merge value requires a non-negative integer/);

  r = await run(mk({ ...valid, errorOnUnencodable: false }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.value\.errorOnUnencodable: engine requires errorOnUnencodable === true/);
});

test('SVG node missing aspect exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint.push({
    kind: 'svg', box: { x: 0, y: 0, w: 50, h: 50 }, source: 'PHN2Zz48L3N2Zz4='
    // aspect omitted
  });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.aspect: missing/);
});

test('SVG node with bogus aspect value exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint.push({
    kind: 'svg', box: { x: 0, y: 0, w: 50, h: 50 },
    source: 'PHN2Zz48L3N2Zz4=', aspect: 'stretch'
  });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.aspect: must be preserve\|fill/);
});

test('image with bogus aspect value exits 1', async () => {
  const c = minimalValid();
  c.document.pages[0].paint.push({
    kind: 'image', box: { x: 0, y: 0, w: 50, h: 50 },
    format: 'png', data: 'iVBORw0KGgoAAAA=', aspect: 'cover'
  });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.aspect: must be preserve\|fill/);
});

test('path stroke=null is valid (no stroke at all)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint[0].stroke = null;
  const r = await run(c);
  assert.equal(r.code, 0, r.stdout);
});

test('no argument exits 2', async () => {
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
  assert.equal(r.code, 2);
});

// ---------------------------------------------------------------------------
// Audit round 7: validator/loader parity additions.
// ---------------------------------------------------------------------------

async function runRaw(text) {
  const dir = await mkdtemp(join(tmpdir(), 'nprint-val-'));
  const path = join(dir, 'c.json');
  await writeFile(path, text);
  try {
    const r = await execFileP(process.execPath, [SCRIPT, path]);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('audit7: non-finite number literals anywhere are rejected (engine refuses 1e999)', async () => {
  // In a field the loader reads (tile origin)...
  const origin = JSON.stringify(minimalValid())
    .replace('"origin":{"x":0', '"origin":{"x":1e999');
  const r1 = await runRaw(origin);
  assert.equal(r1.code, 1);
  assert.match(r1.stdout, /non-finite|finite/);

  // ...and in an extra field the loader never reads: the engine's number
  // PARSER still refuses the literal, so the validator must too.
  const extra = JSON.stringify(minimalValid())
    .replace('"document":{', '"document":{"extraneous":1e999,');
  const r2 = await runRaw(extra);
  assert.equal(r2.code, 1);
  assert.match(r2.stdout, /non-finite/);
});

test('audit7: duplicate page ids are rejected', async () => {
  const c = minimalValid();
  c.document.pages.push(JSON.parse(JSON.stringify(c.document.pages[0])));
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /duplicate page id/);
});

test('audit7: page/tile extents beyond the printable range are rejected', async () => {
  const huge = minimalValid();
  huge.document.pages[0].size.w = 1e9;
  const r1 = await run(huge);
  assert.equal(r1.code, 1);
  assert.match(r1.stdout, /printable range/);

  const hugeOrigin = minimalValid();
  hugeOrigin.document.pages[0].tiles[0].origin.x = 1e30;
  const r2 = await run(hugeOrigin);
  assert.equal(r2.code, 1);
  assert.match(r2.stdout, /printable range/);
});

test('audit7: non-PNG image payload is rejected (engine fails it late and mislabeled)', async () => {
  const c = minimalValid();
  c.document.pages[0].paint.push({
    kind: 'image', box: { x: 1, y: 1, w: 10, h: 10 },
    format: 'png', aspect: 'preserve', flipH: false, flipV: false,
    data: 'aGVsbG8h' // "hello!" — strict base64 but not a PNG
  });
  const r = await run(c);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /PNG signature/);
});

test('audit7: merge sample exceeding maxLen is rejected (text and barcode)', async () => {
  const text = minimalValid();
  text.document.pages[0].paint.push({
    kind: 'text', box: { x: 1, y: 1, w: 40, h: 10 },
    font: { family: 'Arial', sizePx: 8, weight: 400, italic: false, color: '#000000' },
    align: { h: 'left', v: 'top' },
    content: { type: 'merge', key: 'NAME', sample: 'TOO-LONG', maxLen: 4,
               wrap: 'none', overflow: 'clip' }
  });
  const r1 = await run(text);
  assert.equal(r1.code, 1);
  assert.match(r1.stdout, /sample exceeds maxLen/);

  const barcode = minimalValid();
  barcode.document.pages[0].paint.push({
    kind: 'barcode', box: { x: 1, y: 1, w: 40, h: 10 },
    symbology: 'stub', params: {},
    value: { type: 'merge', key: 'CODE', sample: '123456', maxLen: 4,
             errorOnUnencodable: true }
  });
  const r2 = await run(barcode);
  assert.equal(r2.code, 1);
  assert.match(r2.stdout, /sample exceeds maxLen/);

  // Code points, not UTF-16 units: 4 astral chars at maxLen 4 must pass.
  const astral = minimalValid();
  astral.document.pages[0].paint.push({
    kind: 'text', box: { x: 1, y: 1, w: 40, h: 10 },
    font: { family: 'Arial', sizePx: 8, weight: 400, italic: false, color: '#000000' },
    align: { h: 'left', v: 'top' },
    content: { type: 'merge', key: 'NAME', sample: '\u{1F600}\u{1F600}\u{1F600}\u{1F600}', maxLen: 4,
               wrap: 'none', overflow: 'clip' }
  });
  const r3 = await run(astral);
  assert.equal(r3.code, 0, r3.stdout);
});
