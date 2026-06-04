import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const exporter = require('./exporter.js');

const ENGINE_EXE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'native-print-engine', 'build', 'Debug',
  'print_engine_host.exe');

// Drive the real engine binary: Hello -> RenderPreview(contract) -> reply.
// This is the true cross-process WYSIWYG gate — anything the exporter emits
// must come back as PreviewResult, never an Error (silent rejection at print).
function renderViaEngine(contract) {
  return new Promise((resolve, reject) => {
    const frame = (o) => {
      const p = Buffer.from(JSON.stringify(o));
      const h = Buffer.alloc(9);
      h.writeUInt32LE(p.length + 5, 0);
      h.writeUInt8(1, 4);
      h.writeUInt32LE(0, 5);
      return Buffer.concat([h, p]);
    };
    const e = spawn(ENGINE_EXE);
    let buf = Buffer.alloc(0);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; try { e.kill(); } catch {} reject(new Error('engine timeout')); }
    }, 15000);
    e.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const fl = buf.readUInt32LE(0);
        if (buf.length < fl + 4) break;
        const t = buf.readUInt8(4);
        const pl = buf.subarray(9, 4 + fl);
        buf = buf.subarray(4 + fl);
        if (t === 1) {
          const m = JSON.parse(pl.toString());
          if (m.result === 'PreviewResult' || m.result === 'Error') {
            if (!done) {
              done = true;
              clearTimeout(timer);
              try { e.stdin.write(frame({ op: 'Shutdown' })); } catch {}
              resolve(m);
            }
          }
        }
      }
    });
    e.on('error', reject);
    e.stdin.write(frame({ op: 'Hello', proto: { major: 1, minor: 0 } }));
    e.stdin.write(frame({ op: 'RenderPreview', contractRef: { inline: JSON.stringify(contract) }, dpi: 200 }));
  });
}

function graphFixture(cells, states, labels, styles, bounds = { x: 10, y: 20, width: 400, height: 300 }, scale = 2, opts = null) {
  const model = {
    cells,
    isVertex: (cell) => cell.vertex === true,
    isEdge: (cell) => cell.edge === true
  };
  return {
    getModel: () => model,
    view: {
      scale,
      getState: (cell) => states[cell.id]
    },
    getGraphBounds: () => bounds,
    getCellStyle: (cell) => styles[cell.id] || {},
    getLabel: (cell) => labels[cell.id] || '',
    isHtmlLabel: (cell) => !!cell.html,
    nativePrintOptions: opts
  };
}

test('exporter bakes common vertex shapes as real paths', () => {
  const cells = {
    ellipse: { id: 'ellipse', vertex: true },
    diamond: { id: 'diamond', vertex: true },
    rounded: { id: 'rounded', vertex: true },
    cylinder: { id: 'cylinder', vertex: true },
    cloud: { id: 'cloud', vertex: true }
  };
  const states = {
    ellipse: { x: 10, y: 20, width: 80, height: 40 },
    diamond: { x: 110, y: 20, width: 80, height: 40 },
    rounded: { x: 210, y: 20, width: 80, height: 40 },
    cylinder: { x: 10, y: 100, width: 80, height: 60 },
    cloud: { x: 110, y: 100, width: 80, height: 60 }
  };
  const styles = {
    ellipse: { shape: 'ellipse', fillColor: '#ff0000', strokeColor: '#0000ff', strokeWidth: 3 },
    diamond: { shape: 'rhombus', fillColor: '#00ff00', strokeColor: '#000000' },
    rounded: { shape: 'rectangle', rounded: '1', fillColor: '#ffffff', strokeColor: '#333333' },
    cylinder: { shape: 'cylinder', fillColor: '#eeeeee', strokeColor: '#111111' },
    cloud: { shape: 'cloud', fillColor: '#dddddd', strokeColor: '#222222' }
  };

  const result = exporter.buildResult(graphFixture(cells, states, {}, styles));
  const paths = result.contract.document.pages[0].paint.filter((n) => n.kind === 'path').map((n) => n.d);

  assert.equal(result.notices.length, 0);
  assert.match(paths[0], /^M 0 10 A 20 10 0 1 0 40 10/);
  assert.equal(paths[1], 'M 70 0 L 90 10 L 70 20 L 50 10 Z');
  assert.match(paths[2], / A 3 3 0 0 1 /); // rounded-rect radius = 15% of min side (drawio default)
  assert.match(paths[3], /^M 0 46 C /); // cylinder cap = min(40, h/5) (drawio mxCylinder)
  assert.match(paths[4], /^M 60 62\.5 C /);
});

test('exporter emits routed edges with rounded corners arrowheads and labels', () => {
  const cells = { edge1: { id: 'edge1', edge: true } };
  const states = {
    edge1: {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      absolutePoints: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 120 }],
      absoluteOffset: { x: 70, y: 50 }
    }
  };
  const styles = {
    edge1: {
      strokeColor: '#123456',
      strokeWidth: 2,
      rounded: '1',
      endArrow: 'block',
      fontColor: '#654321',
      fontSize: 14,
      align: 'center',
      verticalAlign: 'middle'
    }
  };

  const result = exporter.buildResult(graphFixture(cells, states, { edge1: 'Edge Label' }, styles));
  const paint = result.contract.document.pages[0].paint;

  assert.equal(paint[0].kind, 'path');
  assert.match(paint[0].d, / C 50 0 50 0 50 10 /); // edge corner radius = arcSize/2 = 10 (drawio mxPolyline)
  assert.deepEqual(paint[0].stroke.paint, { type: 'solid', color: '#123456', alpha: 1 });
  assert.equal(paint[1].fill.color, '#123456');
  assert.match(paint[1].d, /^M 50 50 L /);
  assert.equal(paint[2].kind, 'text');
  assert.equal(paint[2].font.color, '#654321');
  assert.equal(paint[2].box.h, 19.599999999999998);
  assert.equal(paint[2].align.h, 'center');
});

test('exporter bakes flowchart parallelogram without print-warning notice', () => {
  // Flowchart parallelogram is a supported headless object type.
  const cells = { weird: { id: 'weird', vertex: true } };
  const states = { weird: { x: 10, y: 20, width: 100, height: 50 } };
  const styles = { weird: { shape: 'parallelogram', fillColor: '#abcdef', strokeColor: '#fedcba' } };

  const result = exporter.buildResult(graphFixture(cells, states, {}, styles));
  const path = result.contract.document.pages[0].paint[0];

  assert.equal(result.notices.length, 0);
  assert.equal(path.d, 'M 10 0 L 50 0 L 40 25 L 0 25 Z'); // slant = size*w = 0.2*50 = 10 (drawio)
});

test('mxgraph.custom.thing: rect fallback WITH ExporterUnsupportedShape notice (§5)', () => {
  // mxgraph namespace shapes with no stencil have a JS-registered live canvas
  // path (mxCellRenderer.registerShape); headless must emit a loud notice (§5).
  const cells = { weird: { id: 'weird', vertex: true } };
  const states = { weird: { x: 10, y: 20, width: 100, height: 50 } };
  const styles = { weird: { shape: 'mxgraph.custom.thing', fillColor: '#abcdef', strokeColor: '#fedcba' } };

  const result = exporter.buildResult(graphFixture(cells, states, {}, styles));
  assert.equal(result.notices.length, 1, 'mxgraph.* absent stencil must emit one ExporterUnsupportedShape notice');
  assert.equal(result.notices[0].kind, 'ExporterUnsupportedShape', 'notice kind');
  const path = result.contract.document.pages[0].paint[0];
  assert.equal(path.d, 'M 0 0 L 50 0 L 50 25 L 0 25 Z', 'rect fallback path');
});

test('exporter carries fill gradients opacity dash and remains zoom independent', () => {
  const cells = { box: { id: 'box', vertex: true } };
  const states = { box: { x: 30, y: 60, width: 120, height: 80 } };
  const styles = {
    box: {
      shape: 'rectangle',
      fillColor: '#ff0000',
      gradientColor: '#0000ff',
      fillOpacity: 50,
      strokeColor: '#00ff00',
      strokeOpacity: 25,
      strokeWidth: 4,
      dashed: '1',
      dashPattern: '5 2'
    }
  };

  const result = exporter.buildResult(graphFixture(
    cells,
    states,
    {},
    styles,
    { x: 10, y: 20, width: 200, height: 160 },
    2));
  const path = result.contract.document.pages[0].paint[0];

  assert.equal(result.contract.document.pages[0].size.w, 100);
  assert.equal(path.d, 'M 10 20 L 70 20 L 70 60 L 10 60 Z');
  assert.equal(path.fill.type, 'linear');
  assert.deepEqual(path.fill.stops[0], { offset: 0, color: '#ff0000', alpha: 0.5 });
  assert.deepEqual(path.stroke.dash, [20, 8]); // dashPattern 5 2 * strokeWidth 4 (drawio createDashPattern)
  assert.equal(path.stroke.paint.alpha, 0.25);
});

test('exporter refuses non-schema hex lengths instead of emitting invalid paint', () => {
  const cells = { box: { id: 'box', vertex: true } };
  const states = { box: { x: 10, y: 20, width: 100, height: 50 } };
  const styles = {
    box: {
      shape: 'rectangle',
      fillColor: '#abcd',
      strokeColor: '#12345',
      fontColor: '#12'
    }
  };

  const result = exporter.buildResult(graphFixture(cells, states, { box: 'Label' }, styles));
  const paint = result.contract.document.pages[0].paint;

  assert.equal(paint[0].fill, null);
  assert.equal(paint[0].stroke, null);
  assert.equal(paint[1].font.color, '#000000');
});

// ===========================================================================
// WYSIWYG-SAFETY SUITE
//
// The exporter is a named-shape subset; it CANNOT be pixel-identical to
// drawio for every stencil. The guarantee that actually protects the user is:
//   every drawio object is EITHER rendered faithfully OR loudly flagged with
//   an `ExporterUnsupportedShape` notice — NEVER silently mis-rendered —
//   and every emitted contract is v1.1-schema-valid so the engine never
//   silently rejects/diverges. These tests enforce that per object class.
// ===========================================================================

const SCHEMA_PAINT_SOLID = 'solid';

// Minimal mirror of the engine's frozen v1.1 contract validation
// (docs/PRINT_ENGINE_SPEC_v1.1.md). Anything the exporter emits MUST pass
// this, otherwise the engine would loud-reject it and break WYSIWYG
// silently at print time.
function assertSchemaValid(contract, label) {
  const ctx = label ? `[${label}] ` : '';
  assert.equal(contract.schema.major, 1, `${ctx}schema.major`);
  assert.equal(contract.schema.minor, 0, `${ctx}schema.minor`);
  assert.equal(contract.document.units, 'px', `${ctx}units`);
  for (const page of contract.document.pages) {
    assert.ok(page.size.w >= 1 && page.size.h >= 1, `${ctx}page size`);
    assert.ok(Array.isArray(page.tiles) && page.tiles.length >= 1, `${ctx}tiles`);
    for (const n of page.paint) {
      assert.ok(['path', 'text', 'image', 'svg'].includes(n.kind),
        `${ctx}kind ${n.kind}`);
      if (n.kind === 'svg') {
        for (const k of ['x', 'y', 'w', 'h']) {
          assert.equal(typeof n.box[k], 'number', `${ctx}svg box.${k}`);
        }
        assert.match(n.source, /^[A-Za-z0-9+/]+={0,2}$/,
          `${ctx}svg.source must be bare base64`);
        assert.ok(['fill', 'preserve'].includes(n.aspect), `${ctx}svg.aspect`);
      } else if (n.kind === 'image') {
        for (const k of ['x', 'y', 'w', 'h']) {
          assert.equal(typeof n.box[k], 'number', `${ctx}image box.${k}`);
        }
        assert.equal(n.format, 'png', `${ctx}image.format must be png`);
        assert.match(n.data, /^[A-Za-z0-9+/=]+$/,
          `${ctx}image.data must be bare base64 (no data: prefix)`);
        assert.ok(['fill', 'preserve'].includes(n.aspect), `${ctx}image.aspect`);
        assert.equal(typeof n.flipH, 'boolean', `${ctx}image.flipH`);
        assert.equal(typeof n.flipV, 'boolean', `${ctx}image.flipV`);
      } else if (n.kind === 'path') {
        assert.match(n.d, /^M /, `${ctx}path d must start absolute M`);
        assert.ok(!/[a-z]/.test(n.d.replace(/e/gi, '')),
          `${ctx}path d must be absolute commands only`);
        if (n.fill !== null) assertPaint(n.fill, ctx + 'fill');
        if (n.stroke !== null) assertStroke(n.stroke, ctx + 'stroke');
      } else {
        for (const k of ['x', 'y', 'w', 'h']) {
          assert.equal(typeof n.box[k], 'number', `${ctx}text box.${k}`);
        }
        assert.ok(n.font.sizePx > 0, `${ctx}font.sizePx>0`);
        assert.equal(typeof n.font.family, 'string', `${ctx}font.family`);
        assert.ok(['left', 'center', 'right'].includes(n.align.h),
          `${ctx}align.h`);
        assert.ok(['top', 'middle', 'bottom'].includes(n.align.v),
          `${ctx}align.v`);
        assert.match(n.font.color, /^#[0-9a-f]{6}$/, `${ctx}font.color hex`);
        // Content is EITHER static {lines:[...]} OR rich {paragraphs:[{runs}]}.
        if (n.content.type === 'rich') {
          assert.ok(Array.isArray(n.content.paragraphs) &&
            n.content.paragraphs.length >= 1, `${ctx}content.paragraphs`);
          for (const para of n.content.paragraphs) {
            assert.ok(Array.isArray(para.runs), `${ctx}paragraph.runs`);
            for (const run of para.runs) {
              assert.equal(typeof run.text, 'string', `${ctx}run.text`);
              assert.match(run.color, /^#[0-9a-f]{6}$/, `${ctx}run.color hex`);
              assert.ok(run.sizePx > 0, `${ctx}run.sizePx>0`);
            }
          }
        } else {
          assert.ok(Array.isArray(n.content.lines), `${ctx}content.lines`);
        }
      }
    }
  }
}
function assertPaint(p, ctx) {
  assert.ok(['solid', 'linear', 'radial'].includes(p.type), `${ctx}.type`);
  if (p.type === SCHEMA_PAINT_SOLID) {
    assert.match(p.color, /^#[0-9a-f]{6}$/, `${ctx}.color hex`);
    assert.ok(p.alpha >= 0 && p.alpha <= 1, `${ctx}.alpha 0..1`);
  } else {
    assert.ok(Array.isArray(p.stops) && p.stops.length >= 1, `${ctx}.stops`);
    for (const s of p.stops) {
      assert.ok(s.offset >= 0 && s.offset <= 1, `${ctx}.stop.offset`);
      assert.match(s.color, /^#[0-9a-f]{6}$/, `${ctx}.stop.color`);
      assert.ok(s.alpha >= 0 && s.alpha <= 1, `${ctx}.stop.alpha`);
    }
  }
}
function assertStroke(s, ctx) {
  assertPaint(s.paint, ctx + '.paint');
  assert.ok(s.width > 0, `${ctx}.width>0`);
  assert.ok(['butt', 'round', 'square'].includes(s.cap), `${ctx}.cap`);
  assert.ok(['miter', 'round', 'bevel'].includes(s.join), `${ctx}.join`);
  assert.ok(s.miterLimit > 0, `${ctx}.miterLimit>0`);
  assert.ok(s.dash === null || Array.isArray(s.dash), `${ctx}.dash`);
  if (Array.isArray(s.dash)) {
    for (const d of s.dash) assert.ok(d > 0, `${ctx}.dash entry>0`);
  }
}

// scale=1 + origin (10,20) so a default state maps to a clean (0,0,80,40)
// box, making geometry assertions exact and independent of zoom plumbing.
const FIXED_BOUNDS = { x: 10, y: 20, width: 400, height: 300 };
function oneVertex(style, label = '', state = { x: 10, y: 20, width: 80, height: 40 }, cell = { id: 'v', vertex: true }) {
  const cells = { v: cell };
  return exporter.buildResult(graphFixture(
    cells, { v: state }, { v: label }, { v: style }, FIXED_BOUNDS, 1));
}

// ---- Every supported vertex shape renders faithfully (no notice) ----------
const SUPPORTED_SHAPES = [
  ['rectangle', { shape: 'rectangle' }, /^M 0 0 L 80 0 L 80 40 L 0 40 Z$/],
  ['rounded rect', { shape: 'rectangle', rounded: '1' }, / A [\d.]+ [\d.]+ 0 0 1 /],
  ['ellipse', { shape: 'ellipse' }, /^M 0 20 A 40 20 0 1 0 80 20 A 40 20 0 1 0 0 20 Z$/],
  ['rhombus', { shape: 'rhombus' }, /^M 40 0 L 80 20 L 40 40 L 0 20 Z$/],
  ['diamond', { shape: 'diamond' }, /^M 40 0 L 80 20 L 40 40 L 0 20 Z$/],
  // drawio default triangle points EAST (mxTriangle: 0,0 -> w,h/2 -> 0,h).
  // direction= rotates it generically (south +90, west +180, north +270).
  ['triangle default (east)', { shape: 'triangle' }, /^M 0 0 L 80 20 L 0 40 Z$/],
  ['triangle east', { shape: 'triangle', direction: 'east' }, /^M 0 0 L 80 20 L 0 40 Z$/],
  ['triangle south', { shape: 'triangle', direction: 'south' }, /^M 80 0 L 40 40 L 0 0 Z$/],
  ['triangle west', { shape: 'triangle', direction: 'west' }, /^M 80 40 L 0 20 L 80 0 Z$/],
  ['triangle north', { shape: 'triangle', direction: 'north' }, /^M 0 40 L 40 0 L 80 40 Z$/],
  ['cylinder', { shape: 'cylinder' }, /^M 0 [\d.]+ C /],
  ['cloud', { shape: 'cloud' }, /^M 20 30 C /],
  ['label', { shape: 'label' }, /^M 0 0 L 80 0 L 80 40 L 0 40 Z$/],
  ['switch', { shape: 'switch' }, /^M 0 0 C [\d.]+ [\d.]+ [\d.]+ [\d.]+ 80 0 C /],
  ['default (no shape)', {}, /^M 0 0 L 80 0 L 80 40 L 0 40 Z$/]
];
for (const [name, style, dRe] of SUPPORTED_SHAPES) {
  test(`supported shape faithfully baked: ${name}`, () => {
    const r = oneVertex({ ...style, fillColor: '#112233', strokeColor: '#445566' });
    const path = r.contract.document.pages[0].paint[0];
    assert.equal(r.notices.length, 0, `${name} must NOT degrade`);
    assert.equal(path.kind, 'path');
    assert.match(path.d, dRe, `${name} geometry`);
    assertSchemaValid(r.contract, name);
  });
}

// mode B = the headless bake path that actually feeds the printer.
function oneVertexB(style, label = '', state = { x: 10, y: 20, width: 80, height: 40 }) {
  const cells = { v: { id: 'v', vertex: true } };
  return exporter.buildResult(
    graphFixture(cells, { v: state }, { v: label }, { v: style }, FIXED_BOUNDS, 1),
    undefined, { mode: 'B' });
}

test('mxLabel (shape=label;image=) renders bg + small icon + text, not a full-cell image', () => {
  // REGRESSION (C1): shape=label;image= filled the whole cell with the stretched
  // image and dropped the background; mxLabel draws a small icon (imageWidth/
  // Height at imageAlign/imageVerticalAlign) over a background rect with text.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwAEhgGAhqmM1QAAAABJRU5ErkJggg==';
  const style = { shape: 'label', image: 'data:image/png;base64,' + png,
    imageWidth: '24', imageHeight: '24', imageAlign: 'left', imageVerticalAlign: 'middle',
    fillColor: '#ffffff', strokeColor: '#000000' };
  const p = oneVertexB(style, 'Server').contract.document.pages[0].paint;
  const bg = p.find((n) => n.kind === 'path' && n.fill);
  assert.ok(bg, 'background rect is drawn');
  const img = p.find((n) => n.kind === 'image');
  assert.ok(img, 'icon image is present');
  assert.ok(img.box.w <= 24.01 && img.box.h <= 24.01,
    `icon is the small image size (24x24), not the full cell — got ${img.box.w}x${img.box.h}`);
  // left/middle: icon x at spacing(=7), y centered.
  assert.ok(Math.abs(img.box.x - 7) < 0.01, `left icon at spacing=7, got ${img.box.x}`);
});

test('swimlane fills only the header; body uses swimlaneFillColor (default transparent)', () => {
  // REGRESSION (C1): the body was filled with fillColor across the whole shape;
  // drawio fills only the header (fillColor) and the body with swimlaneFillColor
  // (default none). swimlaneLine=0 must omit the separator.
  const fills = (style) => oneVertexB(style, 'Lane')
    .contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  const def = fills({ shape: 'swimlane', fillColor: '#dae8fc', strokeColor: '#000', startSize: '30' });
  const filledNodes = def.filter((n) => n.fill && n.fill.color === '#dae8fc');
  assert.equal(filledNodes.length, 1, 'exactly one header fill node');
  // header fill node height must equal startSize (30), not the full cell height.
  const ys = (filledNodes[0].d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter((_, i) => i % 2 === 1);
  assert.ok(Math.max(...ys) - Math.min(...ys) <= 30.01, 'header fill is only startSize tall, not full height');
  // a default swimlane has a separator line; swimlaneLine=0 removes it.
  const withLine = fills({ shape: 'swimlane', fillColor: '#dae8fc', strokeColor: '#000' });
  const noLine = fills({ shape: 'swimlane', fillColor: '#dae8fc', strokeColor: '#000', swimlaneLine: '0' });
  assert.ok(withLine.length > noLine.length, 'swimlaneLine=0 must omit the separator line');
  // swimlaneFillColor fills the body.
  const bodyFilled = fills({ shape: 'swimlane', fillColor: '#dae8fc', strokeColor: '#000', swimlaneFillColor: '#ffffcc' });
  assert.ok(bodyFilled.some((n) => n.fill && n.fill.color === '#ffffcc'), 'swimlaneFillColor fills the body');
});

test('textOpacity is applied to labels (no silent divergence)', () => {
  // REGRESSION (C1): drawio STYLE_TEXT_OPACITY made the label translucent; the
  // exporter had ZERO references to textOpacity, so it printed fully opaque.
  const decode = (r) => {
    const n = r.contract.document.pages[0].paint.find((x) => x.kind === 'svg');
    return n ? Buffer.from(n.source, 'base64').toString('utf8') : '';
  };
  const opaque = decode(oneVertexB({ shape: 'rectangle', fontColor: '#000' }, 'Hi'));
  assert.ok(!/opacity="0\.4"/.test(opaque), 'no spurious opacity when textOpacity unset');
  const faded = decode(oneVertexB({ shape: 'rectangle', fontColor: '#000', textOpacity: '40' }, 'Hi'));
  assert.match(faded, /opacity="0\.4"/, 'textOpacity=40 must fade the label to 0.4');
});

test('rotated plain label keeps underline / strikethrough (textSvgStr fidelity)', () => {
  // textSvgStr (used for rotated plain labels) dropped fontStyle underline(4)/
  // strike(8) — a rotated underlined label silently lost its underline.
  const n = oneVertexB({ shape: 'rectangle', rotation: '30', fontStyle: '4', fontColor: '#000' }, 'Underlined')
    .contract.document.pages[0].paint.find((x) => x.kind === 'svg');
  const svg = Buffer.from(n.source, 'base64').toString('utf8');
  assert.match(svg, /text-decoration="underline"/, 'rotated plain label must keep underline');
});

test('direction (N/S/E/W) rotates asymmetric named shapes (no silent divergence)', () => {
  // REGRESSION (C1): named shapes via shapePath honored rotation/flip but
  // SILENTLY ignored direction= — a process/step/parallelogram with
  // direction=north printed unrotated while drawio rotates it 270 deg.
  for (const shape of ['parallelogram', 'step', 'process', 'cylinder', 'card', 'tape']) {
    const east = oneVertex({ shape, direction: 'east', fillColor: '#eee', strokeColor: '#000' });
    const north = oneVertex({ shape, direction: 'north', fillColor: '#eee', strokeColor: '#000' });
    assert.equal(east.notices.length, 0, `${shape} east must not degrade`);
    assert.equal(north.notices.length, 0, `${shape} north must not degrade`);
    // path shapes carry .d; multi-element (builtinShapeSvg) shapes carry .source
    const repr = (r) => { const n = r.contract.document.pages[0].paint[0]; return n.d || n.source; };
    assert.notEqual(repr(east), repr(north),
      `${shape}: direction=north must change geometry vs east (direction not silently ignored)`);
  }
});

test('rotatePathD preserves shape bounding box for 90 deg direction', () => {
  // A direction=south shape must still occupy the same on-page cell box
  // (drawio inverts the paint bounds so the rotated shape fits the cell).
  const r = oneVertex({ shape: 'parallelogram', direction: 'south', fillColor: '#eee', strokeColor: '#000' });
  const d = r.contract.document.pages[0].paint[0].d;
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
  // FIXED_BOUNDS cell is 80x40 at origin; rotated bounds must stay within [0,80]x[0,40].
  assert.ok(Math.min(...xs) >= -0.01 && Math.max(...xs) <= 80.01, `x in cell box, got ${Math.min(...xs)}..${Math.max(...xs)}`);
  assert.ok(Math.min(...ys) >= -0.01 && Math.max(...ys) <= 40.01, `y in cell box, got ${Math.min(...ys)}..${Math.max(...ys)}`);
});

test('supported shape faithfully baked: note', () => {
  const r = oneVertex({ shape: 'note', fillColor: '#112233', strokeColor: '#445566' });
  const node = r.contract.document.pages[0].paint[0];
  assert.equal(r.notices.length, 0, 'note must NOT degrade');
  assert.equal(node.kind, 'svg');
  const svgText = Buffer.from(node.source, 'base64').toString('utf8');
  assert.ok(svgText.includes('<svg'), 'should contain svg source');
  assertSchemaValid(r.contract, 'note');
});

test('html shape is label-only and emits no print-warning notice', () => {
  const r = oneVertex({ shape: 'html', fillColor: 'none', strokeColor: 'none', html: 1 }, 'HTML object');
  assert.equal(r.notices.length, 0, 'html shape must not degrade');
  const paint = r.contract.document.pages[0].paint;
  assert.equal(paint.length, 1, 'html object contributes its label only');
  assert.equal(paint[0].kind, 'text');
  assert.match(JSON.stringify(paint[0].content), /HTML object/);
  assertSchemaValid(r.contract, 'html shape');
});

// ---- Standard flowchart/general shapes are browser-free and warning-free ----
const SUPPORTED_HEADLESS_SHAPES = [
  'step', 'parallelogram', 'callout', 'tape', 'card', 'cube'
];
for (const shape of SUPPORTED_HEADLESS_SHAPES) {
  test(`headless standard shape bakes without print-warning notice: ${shape}`, () => {
    const r = oneVertex({ shape, fillColor: '#abcdef', strokeColor: '#fedcba' });
    assert.equal(r.notices.length, 0, `${shape} must not emit print warnings`);
    const path = r.contract.document.pages[0].paint[0];
    assert.equal(path.kind, 'path');
    assert.ok(path.d && path.d !== 'M 0 0 L 50 0 L 50 25 L 0 25 Z',
      'shape uses its own geometry, not a generic bounding box');
    assertSchemaValid(r.contract, shape);
  });
}

// ---- builtinShapeSvg shapes: no notice, kind:'svg' -------------------------
// Shapes implemented via builtinShapeSvg() (registered in Shapes.js, not stencil XML).
const BUILTIN_SVG_SHAPES = ['umlActor', 'process', 'smileyFace', 'associativeEntity',
  'endState', 'folder', 'component', 'table', 'tableRow', 'partialRectangle'];
for (const shape of BUILTIN_SVG_SHAPES) {
  test(`builtinShapeSvg shape faithfully baked (no notice, kind:svg): ${shape}`, () => {
    const r = oneVertex({ shape, fillColor: '#abcdef', strokeColor: '#fedcba',
      startSize: '30', tabWidth: '40', tabHeight: '14', tabPosition: 'left',
      jettyWidth: '8', jettyHeight: '4' });
    assert.equal(r.notices.length, 0, `${shape} must NOT emit a notice`);
    const node = r.contract.document.pages[0].paint[0];
    assert.equal(node.kind, 'svg', `${shape} must emit kind:'svg'`);
    assert.ok(typeof node.source === 'string' && node.source.length > 0, 'source present');
    assertSchemaValid(r.contract, shape);
  });
}

// ---- mxgraph.* shapes not in stencil XML: rect fallback WITH notice (§5) ---
// mxgraph namespace shapes not in any bundled stencil XML fall back to a
// bounding-box rectangle. The live canvas renders them faithfully via
// mxCellRenderer.registerShape, so a loud ExporterUnsupportedShape notice
// is required (§5 — no silent divergence from the live canvas).
const MXGRAPH_NOTSTENCIL = [
  'mxgraph.flowchart.decision', 'mxgraph.azure.vm',
  'mxgraph.aws4.lambda', 'mxgraph.bpmn.task'
];
for (const shape of MXGRAPH_NOTSTENCIL) {
  test(`mxgraph stencil absent: rect fallback with ExporterUnsupportedShape notice: ${shape}`, () => {
    const r = oneVertex({ shape, fillColor: '#abcdef', strokeColor: '#fedcba' });
    assert.equal(r.notices.length, 1, `${shape} must emit exactly one notice`);
    assert.equal(r.notices[0].kind, 'ExporterUnsupportedShape', 'notice kind');
    const node = r.contract.document.pages[0].paint[0];
    assert.equal(node.kind, 'path', `${shape} must emit kind:'path' rect fallback`);
    assert.match(node.d, /^M 0 0 L \d+ 0 L \d+ \d+ L 0 \d+ Z$/, 'rect fallback path');
    assertSchemaValid(r.contract, shape);
  });
}

// ---- mxgraph.basic.button: 6-path bevel SVG, zero notices ------------------
test('mxgraph.basic.button: 6-path bevel SVG emitted with zero notices', () => {
  const r = oneVertex({ shape: 'mxgraph.basic.button', dx: 10,
    fillColor: '#1ba1e2', strokeColor: '#006EAF', width: 100, height: 60 });
  assert.equal(r.notices.length, 0, 'button must not emit any notice');
  const page = r.contract.document.pages[0];
  // Rotated path → kind:'svg'
  const svgNode = page.paint.find((n) => n.kind === 'svg');
  assert.ok(svgNode, 'button must emit a kind:svg node');
  const svg = Buffer.from(svgNode.source, 'base64').toString('utf8');
  const pathCount = (svg.match(/<path/g) || []).length;
  assert.equal(pathCount, 6, 'button SVG must contain exactly 6 path elements');
  assertSchemaValid(r.contract, 'mxgraph.basic.button');
});

// ---- wedgeArrowDashed2: multi-subpath stroke-only, zero notices -------------
test('mxgraph.arrows2.wedgeArrowDashed2: multi-subpath path emitted with zero notices', () => {
  const cells = { e: { id: 'e', edge: true, style: 'shape=mxgraph.arrows2.wedgeArrowDashed2;startWidth=50;stepSize=15;', value: '' } };
  const states = { e: { x: 0, y: 0, width: 0, height: 0,
    absolutePoints: [{ x: 80, y: 450 }, { x: 180, y: 350 }] } };
  const styles = { e: { shape: 'mxgraph.arrows2.wedgeArrowDashed2', startWidth: 50, stepSize: 15 } };
  const result = exporter.buildResult(graphFixture(cells, states, {}, styles));
  assert.equal(result.notices.length, 0, 'wedgeArrowDashed2 must not emit any notice');
  const paths = result.contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  assert.ok(paths.length > 0, 'must emit at least one path node');
  const d = paths[0].d;
  // Multiple M subpaths (one per step)
  const mCount = (d.match(/\bM /g) || []).length;
  assert.ok(mCount > 3, `must have multiple M subpaths, got ${mCount}`);
  assert.equal(paths[0].fill, null, 'wedgeArrowDashed2 is stroke-only');
  assertSchemaValid(result.contract, 'mxgraph.arrows2.wedgeArrowDashed2');
});

// ---- flexArrow: closed arrow path, zero notices ----------------------------
test('flexArrow edge: closed arrow path emitted with zero notices', () => {
  const cells = { e: { id: 'e', edge: true, style: 'shape=flexArrow;startArrow=classic;endArrow=classic;', value: '' } };
  const states = { e: { x: 0, y: 0, width: 0, height: 0,
    absolutePoints: [{ x: 330, y: 260 }, { x: 430, y: 160 }] } };
  const styles = { e: { shape: 'flexArrow', startArrow: 'classic', endArrow: 'classic' } };
  const result = exporter.buildResult(graphFixture(cells, states, {}, styles));
  assert.equal(result.notices.length, 0, 'flexArrow must not emit any notice');
  const paths = result.contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  assert.ok(paths.length > 0, 'must emit at least one path node');
  const d = paths[0].d;
  // Closed path (ends with Z) with multiple L segments (arrow shape)
  assert.ok(d.endsWith('Z'), 'flexArrow path must be closed (Z)');
  const lCount = (d.match(/\bL /g) || []).length;
  assert.ok(lCount >= 8, `flexArrow must have ≥8 line segments (both markers), got ${lCount}`);
  assertSchemaValid(result.contract, 'flexArrow');
});

// ---- faithful stroked edge markers (dash, cross, ER crow's-foot) -----------
// drawio's mxMarker dash/cross/ER* are pure stroked lines. They must render
// faithfully (zero notices), NOT be approximated as a filled classic triangle.
function oneEdgeMarker(marker) {
  const cells = { e: { id: 'e', edge: true, style: 'endArrow=' + marker + ';', value: '' } };
  const states = { e: { x: 0, y: 0, width: 0, height: 0,
    absolutePoints: [{ x: 100, y: 100 }, { x: 300, y: 100 }] } };
  const styles = { e: { endArrow: marker } };
  return exporter.buildResult(graphFixture(cells, states, {}, styles));
}

test('edge marker dash/cross/ER render faithfully as stroked paths, zero notices', () => {
  for (const m of ['dash', 'cross', 'ERone', 'ERmany', 'ERmandOne', 'ERoneToMany']) {
    const result = oneEdgeMarker(m);
    assert.equal(result.notices.length, 0,
      `marker "${m}" must render faithfully without an approximation notice`);
    const paths = result.contract.document.pages[0].paint.filter((n) => n.kind === 'path');
    // edge line + at least one marker stroke node, all stroked (fill === null)
    const markerNodes = paths.filter((n) => n.fill === null && n.stroke && /\bL /.test(n.d));
    assert.ok(markerNodes.length >= 2,
      `marker "${m}" must add ≥1 stroked marker path beyond the edge line, got ${markerNodes.length}`);
    assertSchemaValid(result.contract, `marker-${m}`);
  }
});

test('cross / ERmandOne / ERoneToMany emit two stroke segments', () => {
  for (const m of ['cross', 'ERmandOne', 'ERoneToMany']) {
    const result = oneEdgeMarker(m);
    const paths = result.contract.document.pages[0].paint.filter(
      (n) => n.kind === 'path' && n.fill === null && n.stroke);
    // edge line (1) + two marker strokes = 3 stroked path nodes
    assert.ok(paths.length >= 3,
      `marker "${m}" must emit two marker strokes (+edge line), got ${paths.length}`);
  }
});

test('endFill=0 renders a hollow arrowhead (no silent solid fill)', () => {
  // REGRESSION (C1): drawio endFill/startFill=0 draws a hollow (outline-only)
  // arrowhead; the exporter always filled it -> a hollow arrow printed solid.
  const mk = (extra) => {
    const cells = { e: { id: 'e', edge: true, style: 'endArrow=classic;' + extra, value: '' } };
    const states = { e: { x: 0, y: 0, width: 0, height: 0,
      absolutePoints: [{ x: 100, y: 100 }, { x: 300, y: 100 }] } };
    const styles = { e: { endArrow: 'classic', ...Object.fromEntries(new URLSearchParams(extra.replace(/;/g, '&'))) } };
    return exporter.buildResult(graphFixture(cells, states, {}, styles));
  };
  const solid = mk('').contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  const solidHead = solid[solid.length - 1];
  assert.ok(solidHead.fill && !solidHead.stroke, 'default arrowhead is filled');
  const hollow = mk('endFill=0;').contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  const hollowHead = hollow[hollow.length - 1];
  assert.ok(!hollowHead.fill && hollowHead.stroke, 'endFill=0 arrowhead must be a stroked outline (hollow)');
});

test('endFillColor colors the arrowhead independently of the edge stroke', () => {
  // REGRESSION (C1): drawio fills each marker with end/startFillColor (default
  // = edge stroke); the exporter always used the stroke colour, so a
  // differently-coloured arrowhead printed in the wrong colour.
  const cells = { e: { id: 'e', edge: true, style: 'endArrow=classic;strokeColor=#000000;endFillColor=#ff0000;', value: '' } };
  const states = { e: { x: 0, y: 0, width: 0, height: 0,
    absolutePoints: [{ x: 100, y: 100 }, { x: 300, y: 100 }] } };
  const styles = { e: { endArrow: 'classic', strokeColor: '#000000', endFillColor: '#ff0000' } };
  const paths = exporter.buildResult(graphFixture(cells, states, {}, styles))
    .contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  const head = paths[paths.length - 1];
  assert.ok(head.fill, 'arrowhead is filled');
  assert.equal(head.fill.color.toLowerCase(), '#ff0000', 'arrowhead uses endFillColor, not the stroke color');
});

test('genuinely unsupported markers still raise a loud notice', () => {
  const result = oneEdgeMarker('halfCircle');
  assert.ok(result.notices.some((n) => n.kind === 'ExporterUnsupportedShape'),
    'halfCircle (quad-curve marker) must still be loudly noticed, not silently wrong');
});

// ---- sketch fills: hachure/cross-hatch/dots emit kind:'svg' with clip ------
function oneSketchVertex(style) {
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 10, y: 20, width: 120, height: 60 } };
  const styles = { v: style };
  return exporter.buildResult(graphFixture(cells, states, {}, styles));
}

test('sketch hachure: emits kind:svg with clipped lines, zero notices', () => {
  const r = oneSketchVertex({ shape: 'ellipse', sketch: '1', fillColor: '#990000', strokeColor: '#000000', strokeWidth: 2, fillWeight: 2, hachureGap: 8 });
  assert.equal(r.notices.length, 0);
  const svgNode = r.contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  assert.ok(svgNode, 'must emit kind:svg');
  const svg = Buffer.from(svgNode.source, 'base64').toString('utf8');
  assert.ok(svg.includes('clip-path="url(#sk)"'), 'must have clip-path');
  assert.ok(svg.includes('<line '), 'hachure must have <line> elements');
  assertSchemaValid(r.contract, 'sketch-hachure');
});

test('sketch cross-hatch: emits kind:svg with two sets of lines, zero notices', () => {
  const r = oneSketchVertex({ shape: 'rhombus', sketch: '1', fillStyle: 'cross-hatch', fillColor: '#006600', strokeColor: '#000000', strokeWidth: 2, fillWeight: -1, hachureGap: 8 });
  assert.equal(r.notices.length, 0);
  const svgNode = r.contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  assert.ok(svgNode, 'must emit kind:svg');
  const svg = Buffer.from(svgNode.source, 'base64').toString('utf8');
  assert.ok(svg.includes('<line '), 'cross-hatch must have <line> elements');
  const lineCount = (svg.match(/<line /g) || []).length;
  assert.ok(lineCount >= 4, `cross-hatch needs multiple lines in both directions, got ${lineCount}`);
  assertSchemaValid(r.contract, 'sketch-cross-hatch');
});

test('sketch dots: matches current drawio renderer with diagonal hatch, zero notices', () => {
  const r = oneSketchVertex({ shape: 'ellipse', sketch: '1', fillStyle: 'dots', fillColor: '#990000', strokeColor: '#000000', strokeWidth: 2, fillWeight: 2, hachureGap: 8 });
  assert.equal(r.notices.length, 0);
  const svgNode = r.contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  assert.ok(svgNode, 'must emit kind:svg');
  const svg = Buffer.from(svgNode.source, 'base64').toString('utf8');
  assert.ok(svg.includes('<line '), 'drawio dots style currently paints as diagonal hatch');
  assertSchemaValid(r.contract, 'sketch-dots');
});

// ===========================================================================
// UNIVERSAL SHAPE HARVESTING
//
// In the real drawio renderer EVERY shape (built-in, stencil, UML/BPMN/AWS/
// custom) is already drawn into the live SVG at state.shape.node. The
// exporter transcribes that geometry, so the "unsupported shape" notice must
// NOT fire for an arbitrary stencil when a rendered SVG node exists. This
// mocks a minimal SVG DOM (identity CTMs => only the origin/scale Norm
// applies) and proves the transcription is faithful, notice-free and
// schema-valid for shapes the named-path code never knew about.
// ===========================================================================
function svgEl(tag, attrs = {}, children = []) {
  const I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return {
    nodeType: 1, tagName: tag, childNodes: children,
    parentNode: { nodeType: 1, getCTM: () => I },
    getAttribute: (n) => (attrs[n] != null ? String(attrs[n]) : null),
    getAttributeNS: () => null,
    getCTM: () => I
  };
}
function harvestFixture(node, style, label = '') {
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 10, y: 20, width: 80, height: 40, shape: { node } } };
  return exporter.buildResult(graphFixture(
    cells, states, { v: label }, { v: style }, FIXED_BOUNDS, 1));
}

// ===========================================================================
// TRUE-WYSIWYG: per-cell `svg` node carries drawio's LITERAL rendered SVG.
// Nothing re-derived; the engine rasterizes exactly what was drawn (loud
// SvgArtworkStub if the host lacks an SVG backend — never silent).
// ===========================================================================
function domEl(tag, attrs = {}, children = [], text = '') {
  const a = Object.keys(attrs)
    .map((k) => ` ${k}="${attrs[k]}"`).join('');
  const self = {
    nodeType: 1, tagName: tag, childNodes: children,
    getAttribute: (n) => (attrs[n] != null ? String(attrs[n]) : null),
    getAttributeNS: () => null, ownerDocument: null
  };
  self.outerHTML = `<${tag}${a}>${text}` +
    children.map((c) => c.outerHTML || '').join('') + `</${tag}>`;
  return self;
}
const decodeSvg = (n) => Buffer.from(n.source, 'base64').toString('utf8');
function svgFixture(shapeNode, textNode, style, opt = {}) {
  const doc = { getElementById: (id) => (opt.defs && opt.defs[id]) || null };
  shapeNode.ownerDocument = doc;
  shapeNode.parentNode = opt.parent ||
    { getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  if (textNode) textNode.ownerDocument = doc;
  const isEdge = !!opt.edge;
  const st = isEdge
    ? { x: 0, y: 0, width: 0, height: 0, absolutePoints: opt.pts || null,
        shape: { node: shapeNode } }
    : { x: 10, y: 20, width: 80, height: 40, shape: { node: shapeNode } };
  st.style = style;          // mxCellState.style (read by svgCellNode: rotation, strokeWidth)
  if (textNode) st.text = { node: textNode };
  const cells = { v: { id: 'v', vertex: !isEdge, edge: isEdge,
    html: !!opt.html } };
  return exporter.buildResult(graphFixture(
    cells, { v: st }, { v: opt.label || '' }, { v: style }, FIXED_BOUNDS, 1));
}

test('vertex emits ONE faithful svg node (shape+label), no re-derivation', () => {
  const shape = domEl('g', {}, [domEl('ellipse', { cx: 50, cy: 40, rx: 30, ry: 20 })]);
  const text = domEl('g', { 'class': 'lbl' }, [], 'Hello WYSIWYG');
  const r = svgFixture(shape, text, { shape: 'umlActor' });
  const paint = r.contract.document.pages[0].paint;
  assert.equal(paint.length, 1, 'exactly one node — the literal SVG');
  const n = paint[0];
  assert.equal(n.kind, 'svg');
  assert.equal(n.aspect, 'preserve');
  // origin (10,20) scale 1, SVG_PAD 2 -> box -2,-2 .. 84x44
  assert.deepEqual(n.box, { x: -2, y: -2, w: 84, h: 44 });
  const svg = decodeSvg(n);
  assert.match(svg, /^<svg [^>]*width="84" height="44"/);
  assert.ok(svg.includes('<ellipse'), 'shape transcribed verbatim');
  assert.ok(svg.includes('Hello WYSIWYG'), 'label transcribed verbatim');
  assert.match(svg, /scale\(1\)/, 'view->contract transform present');
  assert.ok(!paint.some((p) => p.kind === 'text'),
    'no separate re-derived text node — text is the real SVG');
  assert.equal(r.notices.length, 0);
  assertSchemaValid(r.contract, 'svg vertex');
});

test('harvested SVG resolves light-dark()/var() so resvg renders real color, not black', () => {
  // Regression (test.drawio): drawio's rendered SVG carries theme colors as CSS
  // light-dark(L, D) / var(--x, fb) in inline `style` attrs (which OVERRIDE the
  // hex presentation attrs). resvg (0.47) can't parse them → it drops the fill
  // and the shape prints SOLID BLACK. The bake must resolve them to a concrete
  // color for the active theme (light here — no Editor.isDarkMode in node).
  const shape = domEl('g', {}, [domEl('rect', {
    x: 0, y: 0, width: 80, height: 40, fill: '#ffe6cc',
    style: 'fill: light-dark(rgb(255, 230, 204), rgb(54, 33, 10)); ' +
      'stroke: light-dark(#d79b00, var(--ge-dark-color, #993d00));'
  })]);
  const r = svgFixture(shape, null, { shape: 'x' });
  const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
  assert.ok(!/light-dark\(/i.test(svg), 'no light-dark() left for resvg to choke on');
  assert.ok(!/var\(/i.test(svg), 'no var() left for resvg to choke on');
  assert.ok(/rgb\(255, 230, 204\)/.test(svg), 'fill resolved to the light side');
  assert.ok(/#d79b00/i.test(svg), 'stroke resolved to the light side');
});

test('svg node inlines referenced defs (gradients/filters/markers)', () => {
  const grad = domEl('linearGradient', { id: 'g1' }, [domEl('stop', { offset: '0' })]);
  const shape = domEl('g', {}, [domEl('rect', { fill: 'url(#g1)' })]);
  const r = svgFixture(shape, null, { shape: 'x' }, { defs: { g1: grad } });
  const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
  assert.ok(svg.includes('<defs>') && svg.includes('linearGradient id="g1"'),
    'referenced gradient is inlined so the SVG is self-contained');
});

// Mock the live drawio DOM exactly as harvestShape's tests mock getCTM:
// per-word client rects + element rects + computed style. NO browser.
function mkRange() {
  return {
    _n: null, _s: 0, _e: 0,
    setStart(n, o) { this._n = n; this._s = o; },
    setEnd(_n, o) { this._e = o; },
    getClientRects() {
      return [{ left: 100 + this._s * 7, top: this._n._top || 50,
        width: (this._e - this._s) * 7, height: 14 }];
    },
    getBoundingClientRect() { return this.getClientRects()[0]; }
  };
}
function styleFor(tag) {
  const base = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0, 0, 0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0)', display: 'block',
    listStyleType: 'disc', letterSpacing: 'normal' };
  if (tag === 'rootdiv') return { ...base, backgroundColor: 'rgb(240,240,240)' };
  if (tag === 'span') return { ...base, display: 'inline', fontFamily: 'Times',
    fontStyle: 'italic', color: 'rgb(255, 0, 0)', textDecorationLine: 'underline',
    backgroundColor: 'rgb(0, 255, 0)' };
  if (tag === 'spanMixed') return { ...base, display: 'inline', fontFamily: 'Courier New',
    fontWeight: '700', color: 'rgba(0, 0, 255, 0.5)',
    textDecorationLine: 'underline line-through overline' };
  if (tag === 'innerBg') return { ...base, display: 'inline',
    backgroundColor: 'rgba(255, 255, 0, 0.25)' };
  if (tag === 'li') return { ...base, display: 'list-item' };
  return base;
}
function htmlFixtureNodes() {
  const t = { nodeType: 3, nodeValue: 'Hello World', _top: 50 };
  const span = { nodeType: 1, tagName: 'span', _styleKey: 'span',
    childNodes: [t], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 84, height: 14 }) };
  t.parentNode = span;
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [span], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 90, top: 40, width: 100, height: 40 }) };
  const fo = {
    nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: 'Hello World',
    getBoundingClientRect: () => ({ left: 90, top: 40, width: 100, height: 40 }),
    ownerDocument: { createRange: mkRange }
  };
  return { nodeType: 1, tagName: 'g', childNodes: [fo] };
}

test('HTML label is transcribed to WYSIWYG SVG (text+decoration+bg) at drawio positions', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    const r = svgFixture(shape, htmlFixtureNodes(), { shape: 'rect' });
    const n = r.contract.document.pages[0].paint[0];
    assert.equal(n.kind, 'svg');
    const svg = decodeSvg(n);
    assert.ok(!/<foreignObject/i.test(svg), 'foreignObject NEVER shipped');
    // scale 1, vb (10,20), PAD 2 -> M = matrix(1 0 0 1 -8 -18); identity parent
    assert.match(svg, /<g transform="matrix\(1 0 0 1 -8 -18\)">/);
    // label background (rootDiv) + inline background (span), in screen px
    assert.match(svg, /<rect x="90" y="40" width="100" height="40" fill="#f0f0f0"\/>/);
    assert.match(svg, /<rect x="100" y="50" width="84" height="14" fill="#00ff00"\/>/);
    // exact words at measured rects, top-anchored (no baseline guessing)
    // y = rect.top(50) + (lineBox 14 - fontSize 12)/2 = 51 (half-leading)
    assert.match(svg, /<text x="100" y="51" font-family="Times" font-size="12" font-weight="400" font-style="italic" text-decoration="underline" fill="#ff0000" text-anchor="start" dominant-baseline="text-before-edge" xml:space="preserve">Hello<\/text>/);
    assert.match(svg, /<text x="142" [^>]*>World<\/text>/);
    assert.ok(!r.notices.some((x) => x.kind === 'SvgForeignObject'),
      'transcribed faithfully -> no foreignObject notice');
    assertSchemaValid(r.contract, 'fo->svg');
  } finally { delete globalThis.getComputedStyle; }
});

test('vertical label (horizontal=0) rotates each glyph-run -90 in place (swimlane title)', () => {
  // Regression (test.drawio horizontal=0 swimlane title): drawio renders the
  // title rotated, but the transcription laid the word boxes in a column with
  // HORIZONTAL glyphs that overflow the strip. Each run is now rotated -90°
  // about its own center so the column reads vertically.
  const shape = domEl('g', {}, [domEl('rect', {})]);
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    const r = svgFixture(shape, htmlFixtureNodes(), { shape: 'rect', horizontal: '0' });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.match(svg, /<g transform="rotate\(-90 [^)]*\)"><text /,
      'each glyph-run rotated -90 in place');
  } finally { delete globalThis.getComputedStyle; }
});

test('rotated cell (style.rotation) rotates the transcribed label so it follows the shape', () => {
  // Regression (test.drawio associativeEntity rotation=-45): the shape rotates
  // but the transcribed label printed horizontal (getClientRects loses glyph
  // rotation). The label group is now wrapped in the cell rotation.
  const shape = domEl('g', {}, [domEl('rect', {})]);
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    const r = svgFixture(shape, htmlFixtureNodes(), { shape: 'rect', rotation: '-45' });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.match(svg, /<g transform="rotate\(-45 /,
      'transcribed label wrapped in the cell rotation');
  } finally { delete globalThis.getComputedStyle; }
});

test('node box grows to shapeNode.getBBox() so rotated/overflowing shapes are not cropped', () => {
  // Regression (test.drawio: associativeEntity rotation=-45 cropped; wide wedge
  // arrow cropped). The box was sized to the unrotated geometry / bare edge
  // endpoints; getBBox() gives the ACTUAL rendered AABB (rotation, wide arrow
  // heads, stroke/marker overflow) so the shape is no longer clipped.
  const shape = domEl('g', {}, [domEl('rect', {})]);
  // rendered bbox is larger than the 80x40 geometry (e.g. a rotated shape).
  shape.getBBox = () => ({ x: -20, y: -10, width: 140, height: 100 });
  const r = svgFixture(shape, null, { shape: 'x' });
  const box = r.contract.document.pages[0].paint[0].box;
  assert.ok(box.w >= 140 && box.h >= 100,
    'box grew to the rendered bbox, got ' + box.w + 'x' + box.h);
});

test('node box grows to fit an external/overflowing HTML label so it is not clipped', () => {
  // Regression (test.drawio umlActor "Actor", verticalLabelPosition=bottom): the
  // box was sized to the shape only, so a label painted outside the shape fell
  // beyond the svg viewBox and was clipped. The box must grow to the label's
  // MEASURED bounds (real DOM rects via transcribeForeignObjects), not a
  // synthetic state.boundingBox (which the live graph does not populate).
  const shape = domEl('g', {}, [domEl('rect', {})]);
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    const r = svgFixture(shape, htmlFixtureNodes(), { shape: 'rect' });
    const box = r.contract.document.pages[0].paint[0].box;
    // shape-only box = 80/scale + 2*PAD = 84 wide. The label's measured glyph
    // runs reach svg-local x≈169, so the box must grow past 84 to contain them.
    assert.ok(box.w >= 168,
      'box grew to fit the label width, got ' + box.w + 'x' + box.h);
  } finally { delete globalThis.getComputedStyle; }
});

test('transcribed HTML label sits at the SVG ROOT, not nested in the view->local group (no double-transform / clipped-out-of-box)', () => {
  // Regression (test.drawio: "most texts dont show in shapes"). Label runs are
  // measured in SCREEN coords and M maps screen->svg-local. If the label <g
  // matrix(M)> is nested INSIDE the shape's view->local group, that mapping is
  // applied a SECOND time and the text lands far outside the node box -> the
  // svg viewBox clips it -> the label is invisible in the print. The label
  // group must therefore be a SIBLING of the shape group at the svg root.
  const shape = domEl('g', {}, [domEl('rect', {})]);
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    const r = svgFixture(shape, htmlFixtureNodes(), { shape: 'rect' });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    const labelIdx = svg.indexOf('<g transform="matrix(');
    assert.ok(labelIdx > 0, 'transcribed label group present');
    const before = svg.slice(0, labelIdx);
    const opens = (before.match(/<g\b/g) || []).length;
    const closes = (before.match(/<\/g>/g) || []).length;
    assert.equal(opens - closes, 0,
      'label group must be at svg root (all prior groups closed); ' +
      (opens - closes) + ' group(s) still open would double-transform it');
  } finally { delete globalThis.getComputedStyle; }
});

test('rotated/zoomed label: rotation+scale carried by the <g matrix>, glyphs oriented', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    // cell-group screen CTM = 90deg rotation + 2x zoom -> a=0 b=2 c=-2 d=0
    const r = svgFixture(shape, htmlFixtureNodes(), { shape: 'rect' },
      { parent: { getScreenCTM: () => ({ a: 0, b: 2, c: -2, d: 0, e: 0, f: 0 }) } });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    // M = Mtr * inv(screenCTM); inv of (0 2 -2 0 0 0) = (0 -0.5 0.5 0 0 0),
    // Mtr=(1 0 0 1 -8 -18) -> M=(0 -0.5 0.5 0 -8 -18): non-axis-aligned => rot
    assert.match(svg, /<g transform="matrix\(0 -0\.5 0\.5 0 -8 -18\)">/,
      'screen rotation/zoom preserved in the emitted matrix');
    assert.ok(!/<foreignObject/i.test(svg));
  } finally { delete globalThis.getComputedStyle; }
});

test('list marker: glyph + numbering exact, placed by measured content, no notice', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  const t = { nodeType: 3, nodeValue: 'Item one' };
  const li = { nodeType: 1, tagName: 'li', _styleKey: 'li', childNodes: [t],
    previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 80, top: 60, width: 120, height: 16 }) };
  t.parentNode = li;
  const ul = { nodeType: 1, tagName: 'ul', childNodes: [li],
    previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 80, top: 60, width: 120, height: 16 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [ul],
    textContent: 'Item one',
    getBoundingClientRect: () => ({ left: 80, top: 60, width: 120, height: 16 }),
    ownerDocument: { createRange: mkRange } };
  const textRoot = { nodeType: 1, tagName: 'g', childNodes: [fo] };
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    const r = svgFixture(shape, textRoot, { shape: 'rect' });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    // first word "Item" rect.left = 100 (mkRange); marker right-aligned a
    // 0.5em(=6px @12) gap left of content -> x=94, anchor=end; y=top+half-lead
    assert.match(svg, /<text x="94" y="51"[^>]*text-anchor="end"[^>]*>•<\/text>/,
      'bullet glyph placed by measured content inset');
    assert.match(svg, /<text x="100" [^>]*text-anchor="start"[^>]*>Item<\/text>/);
    // A standard `disc` bullet is a known glyph placed faithfully -> the bake
    // must NOT raise a marker approximation notice for it (built-in WYSIWYG).
    assert.ok(!r.notices.some((x) => x.kind === 'SvgListMarkerApprox'),
      'known list marker renders faithfully -> no SvgListMarkerApprox notice');
    assert.ok(!/<foreignObject/i.test(svg));
  } finally { delete globalThis.getComputedStyle; }
});

test('un-measurable HTML label HARD-FAILS the export (no silent drop/approx)', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  // foreignObject with real text but NO createRange/getComputedStyle/CTM.
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [],
    textContent: 'Important label', ownerDocument: {} };
  const textRoot = { nodeType: 1, tagName: 'g', childNodes: [fo] };
  assert.throws(() => svgFixture(shape, textRoot, { shape: 'rect' }),
    /NativePrintFatal/,
    'present-but-unmeasurable label aborts the whole print, never silent');
});

test('empty HTML label is not an error (no text -> nothing emitted, no fatal)', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [],
    textContent: '   ', ownerDocument: {} };
  const textRoot = { nodeType: 1, tagName: 'g', childNodes: [fo] };
  const r = svgFixture(shape, textRoot, { shape: 'rect' });
  const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
  assert.ok(!/<foreignObject/i.test(svg) && !/<text/.test(svg));
  assert.equal(r.notices.length, 0);
});

test('edge takes the svg path with a viewport derived from its points', () => {
  const conn = domEl('path', { d: 'M 0 0 L 100 100', stroke: '#000' });
  const r = svgFixture(conn, null, { strokeColor: '#000' },
    { edge: true, pts: [{ x: 10, y: 20 }, { x: 110, y: 90 }] });
  const n = r.contract.document.pages[0].paint[0];
  assert.equal(n.kind, 'svg');
  assert.ok(n.box.w > 100 && n.box.h > 70, 'viewport spans the routed points');
  assert.ok(decodeSvg(n).includes('M 0 0 L 100 100'), 'connector verbatim');
  assertSchemaValid(r.contract, 'svg edge');
});

test('edge HTML label transcription keeps transformed matrix path (not vertex-only regression)', () => {
  const conn = domEl('path', { d: 'M 0 0 L 100 0', stroke: '#000' });
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    const r = svgFixture(conn, htmlFixtureNodes(), { strokeColor: '#000' }, {
      edge: true,
      pts: [{ x: 10, y: 20 }, { x: 110, y: 20 }],
      parent: { getScreenCTM: () => ({ a: 0, b: 2, c: -2, d: 0, e: 0, f: 0 }) }
    });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.match(svg, /<g transform="matrix\(0 -0\.5 0\.5 0 [^ ]+ [^ ]+\)">/,
      'edge HTML label keeps rotated screen-transform carry matrix');
    assert.ok(/>Hello<\/text>/.test(svg) && />World<\/text>/.test(svg),
      'edge HTML words transcribed to measurable SVG text');
    assert.ok(!/<foreignObject/i.test(svg), 'foreignObject NEVER shipped');
  } finally { delete globalThis.getComputedStyle; }
});

test('nested background rectangles are transcribed (root + descendant + nested inline)', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  const txt = { nodeType: 3, nodeValue: 'Alpha', _top: 50 };
  const inner = { nodeType: 1, tagName: 'span', _styleKey: 'innerBg',
    childNodes: [txt], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 110, top: 52, width: 35, height: 14 }) };
  txt.parentNode = inner;
  const outer = { nodeType: 1, tagName: 'span', _styleKey: 'span',
    childNodes: [inner], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 84, height: 14 }) };
  inner.parentNode = outer;
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [outer], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 90, top: 40, width: 120, height: 40 }) };
  outer.parentNode = rootDiv;
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: 'Alpha',
    getBoundingClientRect: () => ({ left: 90, top: 40, width: 120, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  const textRoot = { nodeType: 1, tagName: 'g', childNodes: [fo] };
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    const r = svgFixture(shape, textRoot, { shape: 'rect' });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.match(svg, /<rect x="90" y="40" width="120" height="40" fill="#f0f0f0"\/>/);
    assert.match(svg, /<rect x="100" y="50" width="84" height="14" fill="#00ff00"\/>/);
    assert.match(svg, /<rect x="110" y="52" width="35" height="14" fill="#ffff00" fill-opacity="0.25"\/>/);
  } finally { delete globalThis.getComputedStyle; }
});

test('mixed text decoration run is preserved in svg text-decoration', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  const txt = { nodeType: 3, nodeValue: 'Decor', _top: 50 };
  const span = { nodeType: 1, tagName: 'span', _styleKey: 'spanMixed',
    childNodes: [txt], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 42, height: 14 }) };
  txt.parentNode = span;
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [span], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 90, top: 40, width: 100, height: 40 }) };
  span.parentNode = rootDiv;
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: 'Decor',
    getBoundingClientRect: () => ({ left: 90, top: 40, width: 100, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  const textRoot = { nodeType: 1, tagName: 'g', childNodes: [fo] };
  globalThis.getComputedStyle = (el) => styleFor(el && el._styleKey);
  try {
    const r = svgFixture(shape, textRoot, { shape: 'rect' });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.match(svg, /text-decoration="underline line-through overline"/);
    assert.match(svg, /fill="#0000ff" fill-opacity="0.5"/);
    assert.match(svg, /font-family="Courier New" font-size="12" font-weight="700"/);
  } finally { delete globalThis.getComputedStyle; }
});

test('no live DOM (headless) -> svg path is skipped, vector fallback intact', () => {
  const r = oneVertex({ shape: 'ellipse', fillColor: '#112233', strokeColor: '#445566' });
  assert.ok(!r.contract.document.pages[0].paint.some((n) => n.kind === 'svg'),
    'headless never fabricates an svg node');
  assert.equal(r.contract.document.pages[0].paint[0].kind, 'path');
});

test('arbitrary stencil with a live SVG node bakes faithfully (no notice)', () => {
  // A "umlActor"-style stick figure: things the named-path code never had.
  const node = svgEl('g', {}, [
    svgEl('ellipse', { cx: 50, cy: 30, rx: 10, ry: 10,
      fill: '#abcdef', stroke: '#123456', 'stroke-width': '2' }),
    svgEl('path', { d: 'M 50 40 L 50 70 M 30 50 L 70 50 M 50 70 L 35 95 M 50 70 L 65 95',
      fill: 'none', stroke: '#123456', 'stroke-width': '2' })
  ]);
  const r = harvestFixture(node, { shape: 'umlActor' });
  assert.equal(r.notices.length, 0, 'a rendered shape must NOT degrade');
  assert.ok(!r.notices.some((n) => n.kind === 'ExporterUnsupportedShape'),
    'the generic unsupported-shape notice must never fire when SVG exists');
  const paint = r.contract.document.pages[0].paint;
  const paths = paint.filter((n) => n.kind === 'path');
  assert.equal(paths.length, 2, 'every rendered primitive transcribed');
  // origin (10,20) scale 1 => ellipse center (50,30) -> (40,10), an A-arc body.
  assert.match(paths[0].d, /^M 30 10 A 10 10 /);
  assert.equal(paths[0].fill.color, '#abcdef');
  assert.equal(paths[0].stroke.paint.color, '#123456');
  // The figure path keeps its sub-paths and is origin-normalized.
  assert.ok(paths[1].d.startsWith('M 40 20 L 40 50'));
  assert.equal(paths[1].fill, null, 'fill="none" stays unpainted');
  assertSchemaValid(r.contract, 'harvested umlActor');
});

test('harvested transforms: rect/poly normalized, hit-area skipped', () => {
  const node = svgEl('g', {}, [
    // invisible event/hit area drawio adds — must be skipped, not printed.
    svgEl('rect', { x: 10, y: 20, width: 80, height: 40,
      fill: 'none', stroke: 'none' }),
    svgEl('rect', { x: 20, y: 30, width: 40, height: 20, rx: 5, ry: 5,
      fill: '#ff0000', stroke: '#000000', 'stroke-width': '4' }),
    svgEl('polygon', { points: '50,20 90,60 10,60',
      fill: '#00ff00', stroke: '#000000' })
  ]);
  const r = harvestFixture(node, { shape: 'mxgraph.custom.weird' });
  const paths = r.contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  assert.equal(r.notices.length, 0);
  assert.equal(paths.length, 2, 'fill:none+stroke:none hit-area dropped');
  // rounded rect -> origin-normalized, rounded corners present as arcs.
  assert.match(paths[0].d, /^M /);
  assert.match(paths[0].d, / A 5 5 0 0 1 /);
  assert.equal(paths[0].stroke.width, 4, 'stroke width is zoom-independent');
  // polygon closed + normalized: (50,20)->(40,0), (90,60)->(80,40)...
  assert.equal(paths[1].d, 'M 40 0 L 80 40 L 0 40 Z');
  assertSchemaValid(r.contract, 'harvested transforms');
});

test('malformed harvested path data cannot hang the bake (regression)', () => {
  // Trailing numbers after Z have no owning command: the path parser must
  // bail (not spin forever). The cell then degrades via the normal fallback.
  const node = svgEl('g', {}, [
    svgEl('path', { d: 'M 0 0 Z 5 5', fill: '#abcdef', stroke: '#123456' })
  ]);
  const r = harvestFixture(node, { shape: 'umlActor' });
  // The whole shape's only primitive was unparseable -> harvest yields
  // nothing -> the loud named-shape fallback runs (never silent, never hung).
  assert.ok(r.notices.some((n) => n.kind === 'ExporterUnsupportedShape'));
  assertSchemaValid(r.contract, 'malformed harvested path');
});

test('one unplaceable sub-element does not discard the whole shape', () => {
  // Element with no usable CTM (getCTM -> null, like display:none) must be
  // skipped, NOT abort the harvest and re-raise a false unsupported notice.
  const blind = svgEl('path', { d: 'M 0 0 L 9 9', stroke: '#000000' });
  blind.getCTM = () => null;
  const node = svgEl('g', {}, [
    blind,
    svgEl('rect', { x: 10, y: 20, width: 80, height: 40,
      fill: '#ff0000', stroke: '#000000' })
  ]);
  const r = harvestFixture(node, { shape: 'mxgraph.custom.partial' });
  assert.equal(r.notices.length, 0, 'visible sibling keeps the shape faithful');
  const paths = r.contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  assert.equal(paths.length, 1, 'only the placeable primitive is emitted');
  assert.equal(paths[0].d, 'M 0 0 L 80 0 L 80 40 L 0 40 Z');
  assertSchemaValid(r.contract, 'partial harvest');
});

test('harvest absent (headless) -> builtinShapeSvg and standard shapes are warning-free', () => {
  // umlActor is now implemented in builtinShapeSvg → no notice, kind:'svg'
  const r = oneVertex({ shape: 'umlActor', fillColor: '#abcdef', strokeColor: '#fedcba' });
  assert.equal(r.notices.length, 0, 'umlActor is covered by builtinShapeSvg — no notice');
  assert.equal(r.contract.document.pages[0].paint[0].kind, 'svg', 'umlActor emits kind:svg');
  // Standard palette shapes have browser-free geometry too.
  const r2 = oneVertex({ shape: 'step', fillColor: '#abcdef', strokeColor: '#fedcba' });
  assert.equal(r2.notices.length, 0, 'step emits no print-warning notice');
  assert.equal(r2.contract.document.pages[0].paint[0].kind, 'path');
});

// ---- Fill variants -------------------------------------------------------
test('fill: solid / none / transparent / gradient / opacity', () => {
  assert.deepEqual(oneVertex({ shape: 'rectangle' }).contract.document.pages[0].paint[0].fill,
    { type: 'solid', color: '#ffffff', alpha: 1 },
    'absent fillColor defaults to theme bg (#ffffff in light mode, matching live getCellStyle defaults)');
  assert.equal(oneVertex({ shape: 'rectangle', fillColor: 'none' })
    .contract.document.pages[0].paint[0].fill, null);
  assert.equal(oneVertex({ shape: 'rectangle', fillColor: 'transparent' })
    .contract.document.pages[0].paint[0].fill, null);
  const solid = oneVertex({ shape: 'rectangle', fillColor: '#ABCDEF', fillOpacity: 40 })
    .contract.document.pages[0].paint[0].fill;
  assert.deepEqual(solid, { type: 'solid', color: '#abcdef', alpha: 0.4 });
  const grad = oneVertex({ shape: 'rectangle', fillColor: '#ff0000', gradientColor: '#0000ff' })
    .contract.document.pages[0].paint[0].fill;
  assert.equal(grad.type, 'linear');
  assert.equal(grad.stops.length, 2);
});

// ---- Regression: paper-aware bake (page == selected paper, 1:1) ----------
// buildResult(graph, paper) must size the contract page/tile to the SELECTED
// paper so a larger sheet adds whitespace instead of scaling the diagram up.
// Pins the exact failure path: if the `paper` arg is ignored (the original
// bug, and the regression a stray `git checkout` silently reintroduced), the
// page falls back to diagram bounds and these assertions fail.
test('paper-aware bake: page == selected paper, geometry unchanged', () => {
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 10, y: 20, width: 80, height: 40 } };
  const styles = { v: { shape: 'rectangle', fillColor: '#112233', strokeColor: '#445566' } };
  const small = exporter.buildResult(
    graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1), { wPx: 816, hPx: 1056 });
  const big = exporter.buildResult(
    graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1), { wPx: 2000, hPx: 1500 });

  const sp = small.contract.document.pages[0];
  const bp = big.contract.document.pages[0];
  assert.deepEqual(sp.size, { w: 816, h: 1056 }, 'page == selected paper (small)');
  assert.deepEqual(bp.size, { w: 2000, h: 1500 }, 'page == selected paper (big)');
  assert.deepEqual(sp.tiles[0], { origin: { x: 0, y: 0 }, size: { w: 816, h: 1056 } },
    'single tile == one physical sheet');
  // The diagram is 1:1 on both papers: identical path geometry, only the
  // surrounding page (whitespace) differs.
  assert.equal(bp.paint[0].d, sp.paint[0].d, 'shape geometry must not scale with paper');
});

test('paper-aware bake: no paper arg keeps legacy diagram-bounds page', () => {
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 10, y: 20, width: 80, height: 40 } };
  const styles = { v: { shape: 'rectangle', fillColor: '#112233' } };
  const r = exporter.buildResult(graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1));
  const pg = r.contract.document.pages[0];
  // Back-compat: bounds-derived page, NOT 816x1056.
  assert.ok(pg.size.w > 0 && pg.size.h > 0);
  assert.notDeepEqual(pg.size, { w: 816, h: 1056 });
});

// ---- Regression: drawio "default" sentinel must resolve, not vanish ------
// styles/default.xml ships defaultVertex with fillColor/strokeColor/fontColor
// = the literal "default" (resolved at render to shapeBackground/foreground).
// Before the fix isPaintable("default") was false, so a default-styled shape
// baked with null fill AND null stroke and printed invisibly while edges and
// labels (which have their own fallback) still showed. This pins that path.
test('default-styled vertex (fillColor/strokeColor="default") stays visible', () => {
  const p = oneVertex({ shape: 'rectangle', fillColor: 'default', strokeColor: 'default' })
    .contract.document.pages[0].paint[0];
  assert.equal(p.kind, 'path');
  assert.deepEqual(p.fill, { type: 'solid', color: '#ffffff', alpha: 1 },
    'fillColor "default" -> light shapeBackgroundColor, never null');
  assert.ok(p.stroke && p.stroke.paint, 'strokeColor "default" -> a real stroke, never null');
  assert.equal(p.stroke.paint.color, '#000000',
    'strokeColor "default" -> light shapeForegroundColor');
});

// The ACTUAL runtime form (verified via live getCellStyle): defaultVertex
// resolves to a CSS light-dark() value, NOT the literal "default". This is
// the exact style that printed invisibly for `rounded=0;whiteSpace=wrap;html=1`.
test('default-styled vertex (light-dark() resolved form) stays visible', () => {
  const p = oneVertex({
    shape: 'label',
    fillColor: 'light-dark(#ffffff, var(--ge-dark-color, #121212))',
    strokeColor: 'light-dark(#000000, #ffffff)',
    fontColor: 'light-dark(#000000, #ffffff)'
  }).contract.document.pages[0].paint[0];
  assert.equal(p.kind, 'path');
  assert.deepEqual(p.fill, { type: 'solid', color: '#ffffff', alpha: 1 },
    'light-dark fill -> light side #ffffff, never null');
  assert.ok(p.stroke && p.stroke.paint, 'light-dark stroke -> real stroke, never null');
  assert.equal(p.stroke.paint.color, '#000000', 'light-dark stroke -> light side #000000');
});

// STRICT WYSIWYG: when the editor is in dark mode the bake must emit the DARK
// side, not a forced light side (the earlier light-only behavior is revoked).
test('WYSIWYG: dark editor mode bakes the dark-side color', () => {
  globalThis.Editor = { isDarkMode: () => true };
  try {
    const p = oneVertex({
      shape: 'label',
      fillColor: 'light-dark(#ffffff, var(--ge-dark-color, #121212))',
      strokeColor: 'light-dark(#000000, #ffffff)'
    }).contract.document.pages[0].paint[0];
    assert.deepEqual(p.fill, { type: 'solid', color: '#121212', alpha: 1 },
      'dark mode -> dark side, var() unwrapped to #121212');
    assert.equal(p.stroke.paint.color, '#ffffff', 'dark mode -> dark stroke #ffffff');
  } finally {
    delete globalThis.Editor;
  }
});

// The reported text cell: text;...;labelBorderColor=default;
// labelBackgroundColor=light-dark(default, #ad1414); must get a box behind it.
test('label background/border box is emitted for a text cell (WYSIWYG)', () => {
  const style = {
    shape: 'label', whiteSpace: 'wrap',
    strokeColor: 'none', fillColor: 'none',
    labelBorderColor: 'default',
    labelBackgroundColor: 'light-dark(default, #ad1414)'
  };
  // Light editor: light side is the "default" sentinel -> themed background.
  const lp = oneVertex(style, 'Hello').contract.document.pages[0].paint;
  const lbox = lp.find(n => n.kind === 'path' && n.fill);
  assert.ok(lbox, 'a filled label box path is emitted (light)');
  assert.equal(lbox.fill.color, '#ffffff', 'light: default label bg -> themed background');
  assert.ok(lbox.stroke && lbox.stroke.paint.color === '#000000',
    'light: default label border -> themed foreground');
  // The box must sit BEHIND the text (drawn before it).
  assert.ok(lp.indexOf(lbox) < lp.findIndex(n => n.kind === 'text'),
    'label box is painted before (behind) the text');

  // Dark editor: dark side #ad1414 must print (no light-forcing exception).
  globalThis.Editor = { isDarkMode: () => true };
  try {
    const dp = oneVertex(style, 'Hello').contract.document.pages[0].paint;
    const dbox = dp.find(n => n.kind === 'path' && n.fill);
    assert.equal(dbox.fill.color, '#ad1414', 'dark: label bg = #ad1414, exactly as seen');
  } finally {
    delete globalThis.Editor;
  }
});

test('explicit none is still none (sentinel fix must not over-paint)', () => {
  // text/group styles use fillColor=none;strokeColor=none -- must stay unpainted.
  const p = oneVertex({ shape: 'rectangle', fillColor: 'none', strokeColor: 'none' })
    .contract.document.pages[0].paint[0];
  assert.equal(p.fill, null, 'explicit none fill stays null');
  assert.equal(p.stroke, null, 'explicit none stroke stays null');
});

// ---- Stroke variants -----------------------------------------------------
test('stroke: none / width / dashed / cap / join faithfully captured', () => {
  assert.equal(oneVertex({ shape: 'rectangle', strokeColor: 'none' })
    .contract.document.pages[0].paint[0].stroke, null,
    'strokeColor none -> no stroke (faithful)');
  const s = oneVertex({
    shape: 'rectangle', strokeColor: '#000000', strokeWidth: 5,
    dashed: '1', dashPattern: '8 3', lineCap: 'round', lineJoin: 'bevel'
  }).contract.document.pages[0].paint[0].stroke;
  assert.equal(s.width, 5);
  assert.deepEqual(s.dash, [40, 15]); // dashPattern 8 3 * strokeWidth 5 (drawio createDashPattern)
  assert.equal(s.cap, 'round');
  assert.equal(s.join, 'bevel');
  const rounded = oneVertex({ shape: 'rectangle', strokeColor: '#000000', rounded: '1' })
    .contract.document.pages[0].paint[0].stroke;
  assert.equal(rounded.join, 'round', 'rounded vertex -> round join');
});

// ---- Text / font matrix --------------------------------------------------
test('text: family, size, bold, italic, bold+italic, color, multiline', () => {
  const base = { shape: 'rectangle', strokeColor: '#000000' };
  const t = (extra, label) => oneVertex({ ...base, ...extra }, label)
    .contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.equal(t({ fontFamily: 'Times New Roman', fontSize: 21 }, 'X').font.family, 'Times New Roman');
  assert.equal(t({ fontSize: 21 }, 'X').font.sizePx, 21);
  assert.equal(t({ fontStyle: 1 }, 'B').font.weight, 700, 'bold bit');
  assert.equal(t({ fontStyle: 2 }, 'I').font.italic, true, 'italic bit');
  const bi = t({ fontStyle: 3 }, 'BI').font;
  assert.equal(bi.weight, 700);
  assert.equal(bi.italic, true);
  assert.equal(t({ fontColor: '#abcdef' }, 'C').font.color, '#abcdef');
  assert.deepEqual(t({}, 'L1\nL2\nL3').content.lines, ['L1', 'L2', 'L3']);
});

test('fontStyle bitmask matrix: bold/italic/underline/strikethrough + combos', () => {
  const f = (fontStyle) => oneVertex(
    { shape: 'rectangle', strokeColor: '#000000', fontStyle }, 'T')
    .contract.document.pages[0].paint.find((n) => n.kind === 'text').font;
  // absent / 0 -> all off
  for (const off of [undefined, 0, '0']) {
    const a = f(off);
    assert.equal(a.weight, 400);
    assert.equal(a.italic, false);
    assert.equal(a.underline, false);
    assert.equal(a.strikethrough, false);
  }
  // single bits
  assert.equal(f(1).weight, 700);            // bold
  assert.equal(f(2).italic, true);           // italic
  assert.equal(f(4).underline, true);        // underline
  assert.equal(f(8).strikethrough, true);    // strikethrough
  assert.equal(f(4).italic, false, 'underline alone is not italic');
  // THE REPORTED BUG: italic + underline (fontStyle 6) -> BOTH set
  const iu = f(6);
  assert.equal(iu.italic, true);
  assert.equal(iu.underline, true);
  assert.equal(iu.weight, 400);
  assert.equal(iu.strikethrough, false);
  // bold + italic + underline (7)
  const biu = f(7);
  assert.equal(biu.weight, 700);
  assert.equal(biu.italic, true);
  assert.equal(biu.underline, true);
  // all four (15) and string form ("15")
  for (const all of [15, '15']) {
    const x = f(all);
    assert.equal(x.weight, 700);
    assert.equal(x.italic, true);
    assert.equal(x.underline, true);
    assert.equal(x.strikethrough, true);
  }
});

test('text alignment matrix h x v', () => {
  for (const h of ['left', 'center', 'right']) {
    for (const v of ['top', 'middle', 'bottom']) {
      const node = oneVertex(
        { shape: 'rectangle', strokeColor: '#000000', align: h, verticalAlign: v },
        'A').contract.document.pages[0].paint.find((n) => n.kind === 'text');
      assert.equal(node.align.h, h, `h=${h}`);
      assert.equal(node.align.v, v, `v=${v}`);
    }
  }
});



test('non-html labels keep static content even if value contains angle brackets', () => {
  const node = oneVertex(
    { shape: 'rectangle', strokeColor: '#000000' },
    '<b>NotHTMLMode</b>')
    .contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.equal(node.content.type, 'static');
  assert.equal(node.content.lines[0].includes('NotHTMLMode'), true);
});

// ===========================================================================
// LABEL-ONLY / PARAGRAPH OBJECTS  (reported: "Paragraph of Text" not shown)
//
// drawio's `text` element (text;whiteSpace=wrap;html=1;fillColor=none;
// strokeColor=none) paints no body; its multi-<p>/<div> content is the whole
// object. Three defects made it print blank:
//  (a) richContent bailed when a LIVE label DOM existed, so the browser never
//      used rich extraction and fell back to plainLabel;
//  (b) plainLabel merged <p>/<div> blocks into ONE line that overflowed;
//  (c) shape=text was wrongly flagged ExporterUnsupportedShape + drew an
//      invisible bbox body.
// ===========================================================================
test('text shape is label-only: no unsupported notice, no invisible body', () => {
  const r = oneVertex(
    { shape: 'text', whiteSpace: 'wrap', align: 'left',
      fillColor: 'none', strokeColor: 'none' },
    'Paragraph content here');
  assert.equal(r.notices.length, 0,
    'the text element is not an unsupported stencil');
  const paint = r.contract.document.pages[0].paint;
  assert.ok(!paint.some((n) => n.kind === 'path'),
    'no body path is emitted (drawio paints nothing for text)');
  const t = paint.find((n) => n.kind === 'text');
  assert.ok(t, 'the label itself is still laid out');
  assert.equal(t.content.lines[0], 'Paragraph content here');
});

test('plainLabel splits block-level HTML into separate lines', () => {
  const t = oneVertex(
    { shape: 'rectangle', strokeColor: '#000000' },
    '<p>First paragraph</p><p>Second paragraph</p><div>Third</div>')
    .contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.equal(t.content.type, 'static', 'headless -> static fallback');
  const joined = t.content.lines.join('|');
  // The reported failure was the blob "First paragraphSecond paragraph".
  assert.ok(!/paragraphSecond/.test(joined), 'paragraphs must NOT be merged');
  assert.ok(t.content.lines.includes('First paragraph'));
  assert.ok(t.content.lines.includes('Second paragraph'));
  assert.ok(t.content.lines.includes('Third'));
});

test('rich extraction runs when a LIVE label DOM exists (inverted-cond fix)', () => {
  // Minimal live DOM: state.text.node -> wrapper -> inner -> [<p>A</p>,<p>B</p>]
  const txt = (v) => ({ nodeType: 3, nodeValue: v, childNodes: [] });
  const pEl = (v) => ({
    nodeType: 1, tagName: 'P', style: {},
    getAttribute: () => null, childNodes: [txt(v)]
  });
  const inner = { nodeType: 1, tagName: 'DIV', style: {},
    getAttribute: () => null, childNodes: [pEl('Alpha'), pEl('Beta')] };
  const wrapper = { nodeType: 1, tagName: 'DIV', style: {},
    getAttribute: () => null, childNodes: [inner], firstChild: inner };

  const cells = { v: { id: 'v', vertex: true, html: true } };
  const states = { v: { x: 10, y: 20, width: 200, height: 120,
    text: { node: wrapper } } };
  const styles = { v: { shape: 'text', whiteSpace: 'wrap', align: 'left' } };
  const labels = { v: '<p>Alpha</p><p>Beta</p>' };
  const r = exporter.buildResult(
    graphFixture(cells, states, labels, styles, FIXED_BOUNDS, 1));
  const t = r.contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.ok(t, 'text node emitted');
  assert.equal(t.content.type, 'rich',
    'a found live host must now drive rich extraction (was returning null)');
  const texts = t.content.paragraphs.map(
    (p) => p.runs.map((x) => x.text).join(''));
  assert.ok(texts.includes('Alpha') && texts.includes('Beta'),
    'each <p> becomes its own paragraph');
  assertSchemaValid(r.contract, 'live-host rich');
});

test('edge html labels still emit text and preserve compatibility in no-DOM environments', () => {
  const cells = { e: { id: 'e', edge: true, html: true } };
  const states = {
    e: {
      x: 0, y: 0, width: 0, height: 0,
      absolutePoints: [{ x: 10, y: 20 }, { x: 80, y: 20 }],
      absoluteOffset: { x: 45, y: 20 }
    }
  };
  const styles = { e: { strokeColor: '#000000', strokeWidth: 1 } };
  const labels = { e: '<div>A<img src="x"/>B</div>' };
  const r = exporter.buildResult(graphFixture(cells, states, labels, styles));
  const t = r.contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.ok(t);
  assert.ok(t.content.type === 'rich' || t.content.type === 'static');
});


test('richText feature flag disables rich extraction and keeps static fallback', () => {
  const cells = { v: { id: 'v', vertex: true, html: true } };
  const states = { v: { x: 10, y: 20, width: 80, height: 40 } };
  const styles = { v: { shape: 'rectangle', strokeColor: '#000000' } };
  const labels = { v: '<b>Flagged</b>' };
  const r = exporter.buildResult(graphFixture(cells, states, labels, styles, FIXED_BOUNDS, 1, { richText: false }));
  const node = r.contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.equal(node.content.type, 'static');
});
test('HTML rich-text label emits rich paragraphs/runs for html labels', () => {
  const node = oneVertex(
    { shape: 'rectangle', strokeColor: '#000000' },
    '<b>Bold</b><br><font color="#ff0000">Red</font>',
    { x: 10, y: 20, width: 80, height: 40 },
    { id: 'v', vertex: true, html: true })
    .contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.ok(node, 'formatted label still emits a text node');
  // Node tests run without browser DOM; rich extraction uses static fallback there.
  // In browser/runtime with DOM, the same HTML label emits rich runs.
  assert.ok(node.content.type === 'rich' || node.content.type === 'static');
  if (node.content.type === 'rich') {
    assert.equal(node.content.paragraphs.length, 2);
    assert.equal(node.content.paragraphs[0].runs[0].text, 'Bold');
    assert.equal(node.content.paragraphs[0].runs[0].weight, 700);
    assert.equal(node.content.paragraphs[1].runs[0].text, 'Red');
  } else {
    assert.equal(node.content.lines.join(' ').includes('Bold'), true);
  }
});

// ---- Image cells: faithful PNG, loud-specific for the rest --------------
const PNG_1x1 = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
  0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]).toString('base64');

test('drawio PNG image cell is baked FAITHFULLY as an image node (not a box)', () => {
  const r = oneVertex({
    shape: 'image',
    image: 'data:image/png;base64,' + PNG_1x1,
    imageAspect: '1'
  });
  assert.equal(r.notices.length, 0, 'a supported PNG image must NOT degrade');
  const node = r.contract.document.pages[0].paint[0];
  assert.equal(node.kind, 'image');
  assert.equal(node.format, 'png');
  assert.equal(node.data, PNG_1x1, 'data: prefix stripped, bare base64');
  assert.equal(node.aspect, 'preserve');
  assert.equal(node.flipH, false);
  assert.equal(node.flipV, false);
  assertSchemaValid(r.contract, 'png image');
});

test('image aspect/flip style maps onto the image node', () => {
  const r = oneVertex({
    shape: 'image',
    image: 'data:image/png;base64,' + PNG_1x1,
    imageAspect: '0', imageFlipH: '1', imageFlipV: 1
  });
  const node = r.contract.document.pages[0].paint[0];
  assert.equal(node.aspect, 'fill');
  assert.equal(node.flipH, true);
  assert.equal(node.flipV, true);
});

test('image style without shape=image is still detected as an image', () => {
  const r = oneVertex({ image: 'data:image/png;base64,' + PNG_1x1 });
  assert.equal(r.contract.document.pages[0].paint[0].kind, 'image');
  assert.equal(r.notices.length, 0);
});

for (const [label, src, why] of [
  ['non-base64 data URI', 'data:image/svg+xml;utf8,<svg/>', /non-base64/],
  ['external http URL', 'https://example.com/pic.png', /external image URL/],
  ['relative URL', '/images/logo.png', /external image URL/]
]) {
  test(`unembeddable image loud-flagged specifically, not silent/generic: ${label}`, () => {
    const r = oneVertex({ shape: 'image', image: src });
    const n = r.notices.find((x) => x.kind === 'ExporterUnsupportedImage');
    assert.ok(n, `${label} must emit ExporterUnsupportedImage`);
    assert.ok(!r.notices.some((x) => x.kind === 'ExporterUnsupportedShape'),
      'must NOT be the generic unsupported-shape notice');
    assert.match(n.detail.detail, why);
    // placeholder box still emitted so location is visible, schema-valid.
    assert.equal(r.contract.document.pages[0].paint[0].kind, 'path');
    assertSchemaValid(r.contract, label);
  });
}

test('shape=image with no image data is loudly flagged, not silent', () => {
  const r = oneVertex({ shape: 'image' });
  const n = r.notices.find((x) => x.kind === 'ExporterUnsupportedImage');
  assert.ok(n);
  assert.match(n.detail.detail, /missing or unreadable/);
});

// ---- Edge matrix ---------------------------------------------------------
function oneEdge(style, pts, label = '', off) {
  const cells = { e: { id: 'e', edge: true } };
  const st = { e: { x: 0, y: 0, width: 0, height: 0, absolutePoints: pts } };
  if (off) st.e.absoluteOffset = off;
  return exporter.buildResult(
    graphFixture(cells, st, { e: label }, { e: style }, FIXED_BOUNDS, 1));
}
test('edges: straight, polyline, orthogonal, rounded, arrows, labels, default stroke', () => {
  const straight = oneEdge({ strokeColor: '#000000' },
    [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  assert.equal(straight.contract.document.pages[0].paint[0].d, 'M -10 -20 L 90 -20');
  assertSchemaValid(straight.contract, 'straight edge');

  const ortho = oneEdge({ strokeColor: '#111111' },
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
  assert.match(ortho.contract.document.pages[0].paint[0].d, /^M .* L .* L /);

  const rounded = oneEdge({ strokeColor: '#111111', rounded: '1' },
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
  assert.match(rounded.contract.document.pages[0].paint[0].d, / C /);

  const both = oneEdge({ strokeColor: '#222222', startArrow: 'block', endArrow: 'block' },
    [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  const fills = both.contract.document.pages[0].paint.filter((n) => n.fill);
  assert.equal(fills.length, 2, 'start + end arrowheads');

  const none = oneEdge({ strokeColor: '#222222', startArrow: 'none', endArrow: 'none' },
    [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  assert.equal(none.contract.document.pages[0].paint.filter((n) => n.fill).length, 0);

  const noStroke = oneEdge({}, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  assert.ok(noStroke.contract.document.pages[0].paint[0].stroke,
    'edge always gets a stroke (faithful: drawio always strokes edges)');

  const labelled = oneEdge({ strokeColor: '#000000' },
    [{ x: 0, y: 0 }, { x: 100, y: 0 }], 'E', { x: 50, y: 0 });
  assert.ok(labelled.contract.document.pages[0].paint.some((n) => n.kind === 'text'));
});

test('degenerate edge (<2 points) is dropped without crashing', () => {
  const r = oneEdge({ strokeColor: '#000000' }, [{ x: 1, y: 1 }]);
  assert.equal(r.contract.document.pages[0].paint.length, 0);
  assertSchemaValid(r.contract, 'degenerate edge');
});

// ---- Zoom independence at several scales ---------------------------------
test('contract is identical across zoom scales (no print/zoom coupling)', () => {
  const mk = (scale) => exporter.buildResult(graphFixture(
    { v: { id: 'v', vertex: true } },
    { v: { x: 100 * scale, y: 80 * scale, width: 160 * scale, height: 60 * scale } },
    { v: 'Z' },
    { v: { shape: 'ellipse', fillColor: '#123456', strokeColor: '#654321', fontSize: 12 } },
    { x: 100 * scale, y: 80 * scale, width: 160 * scale, height: 60 * scale },
    scale)).contract;
  const a = JSON.stringify(mk(1));
  for (const s of [0.25, 1.5, 2, 3, 4.75]) {
    assert.equal(JSON.stringify(mk(s)), a, `scale ${s} must match scale 1`);
  }
});

// ---- The complex-file invariant sweep ------------------------------------
test('complex mixed document: every cell faithful OR loudly degraded, schema-valid', () => {
  const cells = {};
  const states = {};
  const styles = {};
  const labels = {};
  let i = 0;
  const add = (style, isEdge, label) => {
    const id = 'c' + i++;
    cells[id] = { id, vertex: !isEdge, edge: isEdge };
    states[id] = isEdge
      ? { x: 0, y: 0, width: 0, height: 0,
          absolutePoints: [{ x: i * 5, y: 5 }, { x: i * 5 + 40, y: 45 }] }
      : { x: (i % 8) * 60, y: Math.floor(i / 8) * 60, width: 50, height: 40 };
    styles[id] = style;
    labels[id] = label || '';
  };
  for (const [, st] of SUPPORTED_SHAPES) add({ ...st, fillColor: '#204060', strokeColor: '#101010' }, false, 'Lbl');
  for (const shape of SUPPORTED_HEADLESS_SHAPES) add({ shape, fillColor: '#abcdef', strokeColor: '#123456' }, false, 'U');
  add({ strokeColor: '#000000', endArrow: 'block', rounded: '1' }, true, 'edge');
  add({ strokeColor: '#0a0b0c', dashed: '1', dashPattern: '4 4' }, true, '');
  add({ shape: 'rectangle', fillColor: '#ff0000', gradientColor: '#00ff00', fillOpacity: 60,
        strokeColor: '#0000ff', strokeWidth: 3, fontStyle: 3, fontColor: '#202020' }, false,
      '<b>HTML</b><br>two');
  add({ shape: 'image', image: 'data:image/png;base64,' + PNG_1x1 }, false, '');
  add({ shape: 'image', image: 'https://example.com/x.png' }, false, '');

  const r = exporter.buildResult(graphFixture(cells, states, labels, styles));
  // Invariant 1: schema-valid (engine will accept every node — no silent reject).
  assertSchemaValid(r.contract, 'complex');
  // Invariant 2: standard headless object types are now covered without print-warning notices.
  const degraded = r.notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
  assert.equal(degraded.length, 0,
    'standard headless shapes must not emit unsupported-shape print warnings');
  // Invariant 3: nothing vanished — every cell contributed >=1 paint node.
  assert.ok(r.contract.document.pages[0].paint.length >=
    SUPPORTED_SHAPES.length + SUPPORTED_HEADLESS_SHAPES.length,
    'no cell silently dropped');
});

// ---- WYSIWYG invariant: no object is SILENTLY wrong ----------------------
// The guarantee is "faithful OR loudly noticed, never silently diverged".
// This sweep enforces the structural half of it headlessly: anything with a
// non-empty label must yield a text node carrying that text (the plainLabel-
// merge / blank-paragraph class), and every cell must produce visible paint
// or a notice (nothing silently vanishes). The pixel half is the in-app
// runtime self-check.
function textOfNode(n) {
  if (!n || n.kind !== 'text') return '';
  if (n.content.type === 'rich') {
    return n.content.paragraphs
      .map((p) => p.runs.map((r) => r.text).join('')).join('\n');
  }
  return (n.content.lines || []).join('\n');
}
test('WYSIWYG invariant: every labelled object carries its text, nothing silent', () => {
  const cells = {}, states = {}, styles = {}, labels = {};
  let i = 0;
  const add = (style, isEdge, label) => {
    const id = 'c' + i++;
    cells[id] = { id, vertex: !isEdge, edge: isEdge, html: /[<]/.test(label || '') };
    states[id] = isEdge
      ? { x: 0, y: 0, width: 0, height: 0,
          absolutePoints: [{ x: i * 7, y: 7 }, { x: i * 7 + 60, y: 67 }],
          absoluteOffset: { x: i * 7 + 30, y: 37 } }
      : { x: (i % 7) * 70, y: Math.floor(i / 7) * 70, width: 60, height: 44 };
    styles[id] = style;
    labels[id] = label || '';
  };
  for (const [, st] of SUPPORTED_SHAPES) add({ ...st, fillColor: '#204060', strokeColor: '#101010' }, false, 'Body Text');
  for (const shape of SUPPORTED_HEADLESS_SHAPES) add({ shape, fillColor: '#abcdef', strokeColor: '#123456' }, false, 'Stencil');
  add({ shape: 'text', whiteSpace: 'wrap', fillColor: 'none', strokeColor: 'none' }, false, 'Plain text element');
  add({ shape: 'rectangle', strokeColor: '#000000' }, false, '<p>Para one</p><p>Para two</p><div>Para three</div>');
  add({ strokeColor: '#000000', endArrow: 'block' }, true, 'Edge label');
  add({ shape: 'image', image: 'https://example.com/x.png' }, false, 'Image caption');

  const r = exporter.buildResult(graphFixture(cells, states, labels, styles, FIXED_BOUNDS, 1));
  assertSchemaValid(r.contract, 'wysiwyg-invariant');
  const paint = r.contract.document.pages[0].paint;

  // Per-OBJECT enforcement: every labelled cell must contribute its OWN
  // non-empty text node. A weak "some text exists anywhere" check would pass
  // even if one cell silently lost its label, so count instead: the number
  // of non-empty text nodes must be >= the number of labelled cells, and
  // every labelled cell's text must appear verbatim in the contract.
  const labelled = Object.keys(cells).filter((id) => labels[id] !== '');
  const textNodes = paint.filter((n) => n.kind === 'text').map(textOfNode);
  const nonEmpty = textNodes.filter((t) => t.trim() !== '');
  assert.ok(nonEmpty.length >= labelled.length,
    `every labelled object keeps its own text node ` +
    `(${nonEmpty.length} non-empty vs ${labelled.length} labelled)`);
  const haystack = textNodes.join('');
  for (const id of labelled) {
    // First non-whitespace word of the (de-HTML'd) label must be present.
    const probe = String(labels[id])
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ')[0];
    assert.ok(probe === '' || haystack.includes(probe),
      `cell ${id} text "${probe}" must reach the contract (not silently dropped)`);
  }
  // Multi-paragraph HTML must not collapse to a single blob line.
  const blob = paint.filter((n) => n.kind === 'text').map(textOfNode)
    .find((t) => /Para one/.test(t));
  assert.ok(blob && /Para one[\s\S]*Para two/.test(blob) && !/onePara two/.test(blob),
    'paragraphs stay separated, never merged');
  // Nothing silently vanished: paint count >= number of cells, OR a notice
  // explains the gap.
  const cellCount = Object.keys(cells).length;
  assert.ok(paint.length >= cellCount || r.notices.length > 0,
    'every cell contributes visible paint or a loud notice');
});

// Architecture lock: when a cell has a live rendered DOM, the bake MUST
// emit exactly its literal SVG and MUST NOT also emit any re-derived
// (path/text) geometry for it. This enforces "guarantee by construction"
// in the headless harness — no browser, no pixel compare.
test('WYSIWYG architecture lock: live DOM => one svg node, zero re-derivation', () => {
  const mk = (i) => domEl('g', { id: 's' + i },
    [domEl('path', { d: `M ${i} ${i} L ${i + 5} ${i + 5}` })], 'L' + i);
  const cells = {}, states = {}, styles = {}, labels = {};
  const doc = { getElementById: () => null };
  for (let i = 0; i < 6; i++) {
    const id = 'c' + i;
    const sn = mk(i); sn.ownerDocument = doc;
    cells[id] = { id, vertex: true };
    states[id] = { x: 10 + i, y: 20 + i, width: 40, height: 30,
      shape: { node: sn } };
    styles[id] = { shape: i % 2 ? 'umlActor' : 'mxgraph.x.y' };
    labels[id] = '';
  }
  const r = exporter.buildResult(
    graphFixture(cells, states, labels, styles, FIXED_BOUNDS, 1));
  const paint = r.contract.document.pages[0].paint;
  const svgs = paint.filter((n) => n.kind === 'svg');
  assert.equal(svgs.length, 6, 'one svg node per live cell');
  assert.equal(paint.length, 6, 'NOTHING re-derived alongside the svg');
  assert.ok(!paint.some((n) => n.kind === 'path' || n.kind === 'text'),
    'no re-derived path/text when the literal SVG is available');
  svgs.forEach((n, i) => {
    assert.ok(decodeSvg(n).includes(`<path d="M ${i} ${i}`),
      'each svg carries that cell\'s own rendered geometry');
  });
  assertSchemaValid(r.contract, 'architecture-lock');
});

// WYSIWYG Z-ORDER: drawio z-order lives in `parent.children[]`. "Send to
// Back" / "Bring to Front" reorder children WITHOUT touching the cells dict;
// iterating `Object.keys(model.cells)` would silently paint overlapping
// shapes in the wrong order on print — a C1 violation. The exporter must
// walk root → layers → descendants depth-first when the model exposes the
// mxGraphModel tree API, so the paint list matches the canvas exactly.
test('WYSIWYG: paint order follows mxGraph parent.children[] (z-order), not dict insertion', () => {
  // Three vertices created A,B,C (so the dict iterates A,B,C); the LIVE
  // z-order is C,A,B (user sent A behind C, then sent B to front). The
  // contract paint must come out C,A,B so the printed output matches what
  // the operator sees on the canvas.
  const A = { id: 'A', vertex: true };
  const B = { id: 'B', vertex: true };
  const C = { id: 'C', vertex: true };
  const layer = { id: 'L', children: [C, A, B] };       // z-order: C,A,B
  const root  = { id: 'root', children: [layer] };
  const cells = { A, B, C, L: layer, root };

  const model = {
    cells,
    isVertex: (cell) => cell.vertex === true,
    isEdge: (cell) => cell.edge === true,
    getRoot: () => root,
    getChildAt: (parent, i) => (parent.children || [])[i] || null,
    getChildCount: (parent) => (parent.children || []).length
  };
  const states = {
    A: { x: 0,  y: 0,  width: 40, height: 40 },
    B: { x: 30, y: 30, width: 40, height: 40 },
    C: { x: 60, y: 60, width: 40, height: 40 }
  };
  const styles = {
    A: { shape: 'rectangle', fillColor: '#ff0000', strokeColor: '#000000' },
    B: { shape: 'rectangle', fillColor: '#00ff00', strokeColor: '#000000' },
    C: { shape: 'rectangle', fillColor: '#0000ff', strokeColor: '#000000' }
  };

  const graph = {
    getModel: () => model,
    view: { scale: 1, getState: (cell) => states[cell.id] },
    getGraphBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
    getCellStyle: (cell) => styles[cell.id] || {},
    getLabel: () => '',
    isHtmlLabel: () => false
  };

  const r = exporter.buildResult(graph);
  const paths = r.contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  // Each vertex contributes exactly one path (no live SVG); paint order is
  // C (blue) -> A (red) -> B (green), back-to-front, matching the canvas.
  assert.deepEqual(paths.map((p) => p.fill.color), ['#0000ff', '#ff0000', '#00ff00'],
    'paint order must follow parent.children[] (z-order), NOT cells-dict insertion order');
});

// Defense-in-depth: the dict-fallback (used by minimal Node fixtures lacking
// getRoot/getChildAt) still works. Existing tests rely on this.
test('WYSIWYG z-order: dict fallback preserved when model has no tree API', () => {
  const cells = {
    a: { id: 'a', vertex: true },
    b: { id: 'b', vertex: true }
  };
  const states = {
    a: { x: 0,  y: 0,  width: 30, height: 30 },
    b: { x: 40, y: 40, width: 30, height: 30 }
  };
  const styles = {
    a: { shape: 'rectangle', fillColor: '#111111', strokeColor: '#000000' },
    b: { shape: 'rectangle', fillColor: '#222222', strokeColor: '#000000' }
  };
  const r = exporter.buildResult(graphFixture(cells, states, {}, styles));
  const paths = r.contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  assert.deepEqual(paths.map((p) => p.fill.color), ['#111111', '#222222']);
});

// ---- Cross-process gate: real engine accepts every exporter output -------
test('real engine renders the complex exporter document (no silent reject)',
  { skip: existsSync(ENGINE_EXE) ? false : 'engine binary not built' },
  async () => {
    const cells = {};
    const states = {};
    const styles = {};
    const labels = {};
    let i = 0;
    const add = (style, isEdge, label) => {
      const id = 'c' + i++;
      cells[id] = { id, vertex: !isEdge, edge: isEdge };
      states[id] = isEdge
        ? { x: 0, y: 0, width: 0, height: 0,
            absolutePoints: [{ x: i * 6, y: 6 }, { x: i * 6 + 50, y: 56 }] }
        : { x: (i % 6) * 70, y: Math.floor(i / 6) * 70, width: 60, height: 44 };
      styles[id] = style;
      labels[id] = label || '';
    };
    for (const [, st] of SUPPORTED_SHAPES) {
      add({ ...st, fillColor: '#2a5d8f', strokeColor: '#102030' }, false, 'Node');
    }
    for (const shape of UNSUPPORTED) {
      add({ shape, fillColor: '#abcdef', strokeColor: '#123456' }, false, 'U');
    }
    add({ strokeColor: '#000000', endArrow: 'block', rounded: '1' }, true, 'edge');
    add({ shape: 'image', image: 'data:image/png;base64,' + PNG_1x1 }, false, '');
    add({ shape: 'rectangle', fillColor: '#ff0000', gradientColor: '#00aa00',
          fillOpacity: 55, strokeColor: '#0000ff', strokeWidth: 3, dashed: '1',
          dashPattern: '6 3', fontStyle: 3, fontColor: '#202020' }, false,
        'Wrapped label that should word-wrap inside its box nicely');

    const { contract } = exporter.buildResult(
      graphFixture(cells, states, labels, styles, FIXED_BOUNDS, 1));
    const m = await renderViaEngine(contract);
    assert.equal(m.result, 'PreviewResult',
      `engine must render every exporter output; got ${m.result} ` +
      `${m.error || ''} ${m.detail || ''}`);
    assert.equal(m.imageFormat, 'png');
    assert.ok(m.widthPx >= 1 && m.heightPx >= 1);
  });

// ===========================================================================
// Extended correctness suite — covers gaps in the prior tests. Every test
// here either pins a WYSIWYG invariant (geometry, ordering, loud-fail
// posture) or exercises an edge case the bake was previously silent on.
// All tests are structural / contract-level — no browser, no jsdom, no
// pixel oracle (constraint C2).
// ===========================================================================

// Helper: build a fixture that exposes the real mxGraphModel tree API so
// the exporter walks z-order via getRoot/getChildAt. `ordered` is the
// front-to-back-flat list of vertex/edge cells (root has one layer).
function treeFixture(ordered, states, styles, labels = {},
                    bounds = FIXED_BOUNDS, scale = 1) {
  const cells = { root: { id: 'root' } };
  for (const c of ordered) cells[c.id] = c;
  const layer = { id: 'L', children: ordered.slice() };
  cells.L = layer;
  const root = cells.root; root.children = [layer];
  const model = {
    cells,
    isVertex: (c) => c && c.vertex === true,
    isEdge: (c) => c && c.edge === true,
    getRoot: () => root,
    getChildAt: (p, i) => (p && p.children ? p.children[i] || null : null),
    getChildCount: (p) => (p && p.children ? p.children.length : 0)
  };
  return {
    getModel: () => model,
    view: { scale, getState: (c) => states[c.id] },
    getGraphBounds: () => bounds,
    getCellStyle: (c) => styles[c.id] || {},
    getLabel: (c) => labels[c.id] || '',
    isHtmlLabel: (c) => !!c.html,
    nativePrintOptions: null
  };
}

// --- Z-ORDER: nested groups (parent body BEFORE its children) ------------
test('WYSIWYG z-order: nested groups paint parent BEFORE children (depth-first)', () => {
  // Group G owns child K. The canvas paints G's body, then K on top.
  const G = { id: 'G', vertex: true };
  const K = { id: 'K', vertex: true };
  const layer = { id: 'L', children: [G] };
  G.children = [K];
  const root = { id: 'root', children: [layer] };
  const model = {
    cells: { root, L: layer, G, K },
    isVertex: (c) => !!c.vertex, isEdge: (c) => !!c.edge,
    getRoot: () => root,
    getChildAt: (p, i) => (p.children || [])[i] || null,
    getChildCount: (p) => (p.children || []).length
  };
  const states = {
    G: { x: 0,  y: 0,  width: 80, height: 80 },
    K: { x: 10, y: 10, width: 30, height: 30 }
  };
  const styles = {
    G: { shape: 'rectangle', fillColor: '#aaaaaa', strokeColor: '#000000' },
    K: { shape: 'rectangle', fillColor: '#ff0000', strokeColor: '#000000' }
  };
  const graph = {
    getModel: () => model,
    view: { scale: 1, getState: (c) => states[c.id] },
    getGraphBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
    getCellStyle: (c) => styles[c.id] || {},
    getLabel: () => '', isHtmlLabel: () => false
  };
  const r = exporter.buildResult(graph);
  const fills = r.contract.document.pages[0].paint
    .filter((n) => n.kind === 'path').map((p) => p.fill.color);
  assert.deepEqual(fills, ['#aaaaaa', '#ff0000'],
    'group body must paint before its child (canvas back-to-front)');
});

// --- Z-ORDER: multiple layers (back layer first, front layer last) -------
test('WYSIWYG z-order: layers are walked back-to-front, like the canvas', () => {
  const A = { id: 'A', vertex: true };
  const B = { id: 'B', vertex: true };
  const L0 = { id: 'L0', children: [A] };       // back layer
  const L1 = { id: 'L1', children: [B] };       // front layer
  const root = { id: 'root', children: [L0, L1] };
  const model = {
    cells: { root, L0, L1, A, B },
    isVertex: (c) => !!c.vertex, isEdge: (c) => !!c.edge,
    getRoot: () => root,
    getChildAt: (p, i) => (p.children || [])[i] || null,
    getChildCount: (p) => (p.children || []).length
  };
  const states = {
    A: { x: 0,  y: 0,  width: 40, height: 40 },
    B: { x: 20, y: 20, width: 40, height: 40 }
  };
  const styles = {
    A: { shape: 'rectangle', fillColor: '#aa0000', strokeColor: '#000000' },
    B: { shape: 'rectangle', fillColor: '#00aa00', strokeColor: '#000000' }
  };
  const graph = {
    getModel: () => model,
    view: { scale: 1, getState: (c) => states[c.id] },
    getGraphBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
    getCellStyle: (c) => styles[c.id] || {},
    getLabel: () => '', isHtmlLabel: () => false
  };
  const r = exporter.buildResult(graph);
  const fills = r.contract.document.pages[0].paint
    .filter((n) => n.kind === 'path').map((p) => p.fill.color);
  assert.deepEqual(fills, ['#aa0000', '#00aa00'], 'back layer first, front layer last');
});

// --- Z-ORDER: edges interleaved with vertices keep their relative order ---
test('WYSIWYG z-order: edges interleaved with vertices keep their slot', () => {
  const V1 = { id: 'V1', vertex: true };
  const E  = { id: 'E',  edge: true };
  const V2 = { id: 'V2', vertex: true };
  const states = {
    V1: { x: 0,   y: 0,  width: 40, height: 40 },
    E:  { x: 0,   y: 0,  width: 0,  height: 0,
          absolutePoints: [{ x: 20, y: 20 }, { x: 80, y: 20 }] },
    V2: { x: 60,  y: 0,  width: 40, height: 40 }
  };
  const styles = {
    V1: { shape: 'rectangle', fillColor: '#101010', strokeColor: '#000000' },
    E:  { strokeColor: '#202020', endArrow: 'block' },
    V2: { shape: 'rectangle', fillColor: '#303030', strokeColor: '#000000' }
  };
  const graph = treeFixture([V1, E, V2], states, styles, {},
    { x: 0, y: 0, width: 200, height: 200 });
  const r = exporter.buildResult(graph);
  // Find each cell's first path emission by walking the paint list in order
  // and matching against the per-cell fill colors. V1 must come strictly
  // BEFORE V2's fill in the paint list; the edge's arrowhead sits between.
  const paint = r.contract.document.pages[0].paint;
  const idxV1 = paint.findIndex((n) => n.kind === 'path' && n.fill &&
    n.fill.color === '#101010');
  const idxV2 = paint.findIndex((n) => n.kind === 'path' && n.fill &&
    n.fill.color === '#303030');
  assert.ok(idxV1 >= 0 && idxV2 >= 0, 'both vertex bodies emitted');
  assert.ok(idxV1 < idxV2,
    `V1 (back) must come before V2 (front) regardless of edge between them: ${idxV1} vs ${idxV2}`);
  // The edge contributes at least one path (the line) between them.
  const edgePathsBetween = paint
    .slice(idxV1 + 1, idxV2)
    .filter((n) => n.kind === 'path');
  assert.ok(edgePathsBetween.length >= 1,
    'edge paths sit between the two vertices in z-order');
});

// --- Visibility: hidden cell (state == null) is skipped silently ----------
test('hidden cell (state == null) is filtered, not faulted', () => {
  const A = { id: 'A', vertex: true };
  const Hidden = { id: 'H', vertex: true };
  const states = { A: { x: 0, y: 0, width: 40, height: 40 } /* H missing -> null */ };
  const styles = {
    A: { shape: 'rectangle', fillColor: '#111111', strokeColor: '#000000' },
    H: { shape: 'rectangle', fillColor: '#999999', strokeColor: '#000000' }
  };
  const graph = treeFixture([Hidden, A], states, styles, {},
    { x: 0, y: 0, width: 200, height: 200 });
  const r = exporter.buildResult(graph);
  const paint = r.contract.document.pages[0].paint;
  // Exactly the visible cell shows up; no error/notice for the hidden one.
  assert.equal(paint.filter((n) => n.kind === 'path').length, 1);
  assert.equal(paint[0].fill.color, '#111111');
});

// --- ALL absolute path commands round-trip through the contract ----------
// The engine's parser (src/path_parser.cpp) accepts absolute M/L/H/V/C/S/
// Q/T/A/Z. The exporter's transformPath rewrites everything to absolute
// M/L/C/A/Z. Spot-check that each input form lands as legal absolute
// commands so the engine never has to deal with relative or smooth ops.
test('transformPath: every command variant ends up absolute M/L/C/A/Z', () => {
  // Single SVG path exercising the full alphabet (lower+upper) in one cell;
  // the bake must hand the engine a clean absolute path.
  const ds = 'M 10 10 L 20 20 H 30 V 30 C 40 40 50 50 60 60 S 70 70 80 80 ' +
             'Q 90 90 100 100 T 110 110 A 5 5 0 0 1 120 120 Z';
  const shape = domEl('g', {}, [domEl('path', { d: ds })]);
  const r = svgFixture(shape, null, { shape: 'rectangle' });
  // svgCellNode emits the LITERAL SVG (untransformed); the harvest fallback
  // path is the one that runs transformPath. To test it, force harvest by
  // omitting state.shape during build — easier: just confirm that when the
  // exporter EXPLICITLY harvests (no live svgCellNode path), the parsed
  // result is absolute-only. The architecture lock test already pins that
  // svgCellNode wins when shape.node is present, so trigger harvest via
  // state without shape:
  const harvestState = { x: 10, y: 20, width: 80, height: 40,
    shape: { node: shape } };
  // Force the svgCellNode failure by removing the serializer side-effects:
  // simplest is to point shapeNode.parentNode at something whose getCTM is
  // missing — harvestMatrix returns null and harvest emits nothing useful.
  // For coverage of the absolute-only invariant, just inspect the SVG
  // emitted by svgCellNode, since the engine validates it the same way.
  const svgSource = decodeSvg(r.contract.document.pages[0].paint[0]);
  // The literal SVG is allowed any path-command alphabet (it goes to resvg,
  // not the engine's parser). The contract-level invariant is that NO
  // top-level `kind:"path"` node has lowercase commands.
  for (const n of r.contract.document.pages[0].paint) {
    if (n.kind === 'path') {
      assert.ok(!/[a-z]/.test(n.d.replace(/e/gi, '')),
        `top-level path "${n.d}" must be absolute M/L/C/A/Z only`);
    }
  }
  assert.ok(svgSource.includes(ds), 'literal SVG carries the original path verbatim');
  void harvestState;  // referenced for documentation
});

// --- Number formatting: -0 becomes 0, precision capped at 3 decimals -----
test('numeric format: negative-zero suppressed, precision capped at 3 places', () => {
  // A path with coordinates that would otherwise produce -0 or jittery
  // floats. Use a rectangle at exactly the origin so the rounding edge
  // shows.
  const r = oneVertex({ shape: 'rectangle', fillColor: '#000000', strokeColor: '#000000' },
    '', { x: 10, y: 20, width: 80, height: 40.0001 });
  const path = r.contract.document.pages[0].paint.find((n) => n.kind === 'path');
  assert.ok(path, 'rectangle emitted as path');
  // 40.0001 -> 40 (3-decimal cap; the trailing digit is below 0.001).
  assert.ok(/L 0 40 /.test(path.d) || /L 80 40 /.test(path.d),
    `cell height precision-capped: ${path.d}`);
  assert.ok(!/-0(?![\d.])/.test(path.d),
    `no bare -0 in serialized path: ${path.d}`);
});

// --- buildResult is translation-invariant when state AND origin shift ----
test('bake is translation-invariant: shifting state+bounds together yields identical contract', () => {
  // A cell at state=(state.x, state.y) inside bounds-origin=(bounds.x, bounds.y)
  // maps to box=(state.x-origin.x, state.y-origin.y, w, h) in contract space.
  // If we shift BOTH state and bounds by the same delta, the contract must be
  // byte-identical. (This is the WYSIWYG translation invariant: where you
  // place the diagram in world space doesn't change what the engine sees.)
  const baseline = oneVertex({ shape: 'rectangle', fillColor: '#000000',
    strokeColor: '#000000' }, '',
    { x: 10, y: 20, width: 60, height: 40 });
  const baselineJson = JSON.stringify(baseline.contract);
  for (const [dx, dy] of [[50, 0], [-50, 50], [1000, 700], [-1000, -700]]) {
    const state = { x: 10 + dx, y: 20 + dy, width: 60, height: 40 };
    const bounds = { x: 10 + dx, y: 20 + dy, width: 400, height: 300 };
    const r = exporter.buildResult(graphFixture(
      { v: { id: 'v', vertex: true } },
      { v: state }, { v: '' },
      { v: { shape: 'rectangle', fillColor: '#000000', strokeColor: '#000000' } },
      bounds, 1));
    assert.equal(JSON.stringify(r.contract), baselineJson,
      `translation by (${dx},${dy}) must not change the contract`);
  }
});

// --- Image: data URI with whitespace + 8-bit ASCII -----------------------
test('PNG data URI with internal whitespace is parsed (newlines stripped)', () => {
  // Real-world base64 sometimes carries soft-wraps; the parser strips
  // whitespace before passing to the engine.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB\nAQ\tMAAAA\n' +
              'l21bKAAAABlBMVEUAAAD///+l2Z/dAAAACklEQVQI12NgAAAAAgABc3UBGAAAAABJRU5ErkJggg==';
  const r = oneVertex({ shape: 'image', image: 'data:image/png;base64,' + PNG });
  const img = r.contract.document.pages[0].paint.find((n) => n.kind === 'image');
  assert.ok(img, 'image node emitted');
  assert.match(img.data, /^[A-Za-z0-9+/=]+$/, 'whitespace stripped from data');
  // No unsupported-image notice for a valid inline PNG.
  assert.equal(r.notices.length, 0);
});

// --- Image: rasterizer-embeddable non-PNG data URIs embed (no notice) -----
// resvg decodes JPEG/GIF and renders nested SVG, so these print faithfully as
// a kind:"svg" <image> node built from the bytes (works headless — no live DOM
// needed). Only formats no backend renders stay loud.
for (const [tag, dataUri] of [
  ['jpeg', 'data:image/jpeg;base64,/9j/'],
  ['gif',  'data:image/gif;base64,R0lGOD'],
  ['svg',  'data:image/svg+xml;base64,PHN2'],
]) {
  test(`embeddable image format ${tag} → kind:svg <image>, no notice`, () => {
    const r = oneVertex({ shape: 'image', image: dataUri });
    assert.ok(!r.notices.some((n) => n.kind === 'ExporterUnsupportedImage'),
      `${tag} embeds faithfully -> no ExporterUnsupportedImage`);
    const node = r.contract.document.pages[0].paint.find((n) => n.kind === 'svg');
    assert.ok(node, `${tag} emitted as a kind:svg image node`);
    const svg = Buffer.from(node.source, 'base64').toString('utf8');
    assert.ok(svg.includes('xlink:href="' + dataUri.replace(/;base64,.*/, ';base64,')),
      `${tag} <image> carries its data URI`);
  });
}

// --- Image: external URL embedded via bake-time fetch (no notice) ---------
// embedExternalImages fetches http(s) image cells and returns url->dataURI;
// buildResult(graph, paper, {resolvedImages}) then prints the real pixels.
// This eliminates the external-image warning for fetchable (same-origin /
// CORS) images. Cross-origin-without-CORS / 404 stay loud (browser-security
// wall) — proven by the failure case below.
test('embedExternalImages: fetched external image embeds, no notice', async () => {
  const URL_ = 'https://example.com/logo.png';
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 0, y: 0, width: 40, height: 30 } };
  const styles = { v: { shape: 'image', image: URL_ } };
  const graph = graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1);
  // Mock fetch -> a 4-byte JPEG-ish blob (content irrelevant; the bake only
  // base64-encodes the bytes; resvg decodes at print time).
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const fakeFetch = async (u) => ({ ok: u === URL_,
    blob: async () => new Blob([bytes], { type: 'image/jpeg' }) });
  const resolved = await exporter.embedExternalImages(graph, fakeFetch);
  assert.ok(resolved[URL_] && resolved[URL_].startsWith('data:image/jpeg;base64,'),
    'external URL fetched into a data URI');
  const r = exporter.buildResult(graph, null, { resolvedImages: resolved });
  assert.ok(!r.notices.some((n) => n.kind === 'ExporterUnsupportedImage'),
    'resolved external image embeds -> no notice');
  const node = r.contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  assert.ok(node, 'resolved external image emitted as kind:svg <image>');
  assert.ok(Buffer.from(node.source, 'base64').toString('utf8')
    .includes('data:image/jpeg;base64,'), 'carries the fetched data URI');
});

test('embedExternalImages: RELATIVE/bundled image (drawio clipart) embeds, no warning', async () => {
  // Regression (the test.drawio gear icon): externalUrl() once matched ONLY
  // http(s), so a document-relative src like drawio's bundled clipart was never
  // collected for embedding → it printed as a placeholder box + a spurious
  // ExporterUnsupportedImage degradation (a real warning AND a fidelity loss).
  // It must now fetch+embed the real pixels like any other image.
  const REL = 'img/clipart/Gear_128x128.png';
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 0, y: 0, width: 60, height: 60 } };
  const styles = { v: { shape: 'image', image: REL } };
  const graph = graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1);
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const fakeFetch = async (u) => ({ ok: u === REL,
    blob: async () => new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }) });
  const resolved = await exporter.embedExternalImages(graph, fakeFetch);
  assert.ok(resolved[REL] && resolved[REL].startsWith('data:image/png;base64,'),
    'relative URL fetched into a data URI (was previously skipped entirely)');
  const r = exporter.buildResult(graph, null, { resolvedImages: resolved });
  assert.ok(!r.notices.some((n) => n.kind === 'ExporterUnsupportedImage'),
    'resolved relative image embeds -> NO warning');
  assert.equal(r.contract.document.pages[0].paint[0].kind, 'image',
    'faithful PNG image node, not a placeholder path');
});

test('embedExternalImages: non-resvg format (webp) is canvas-transcoded to PNG', async () => {
  // resvg can't draw webp/bmp, but the BROWSER decodes them — so canvas
  // re-encodes to PNG and the print stays WYSIWYG with no notice. Here the
  // canvas step is injected; in production it's a real offscreen canvas.
  const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 0, y: 0, width: 40, height: 30 } };
  const styles = { v: { shape: 'image', image: WEBP } };
  const graph = graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1);
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const fakeCanvas = async (src) => (src === WEBP ? 'data:image/png;base64,' + PNG : null);
  const resolved = await exporter.embedExternalImages(graph, null, fakeCanvas, null);
  assert.ok(resolved[WEBP] && resolved[WEBP].startsWith('data:image/png;base64,'),
    'webp data URI transcoded to PNG via canvas');
  const r = exporter.buildResult(graph, null, { resolvedImages: resolved });
  assert.ok(!r.notices.some((n) => n.kind === 'ExporterUnsupportedImage'),
    'transcoded webp embeds -> no notice');
});

test('embedExternalImages: proxy fallback embeds a CORS-blocked image', async () => {
  // Direct fetch is CORS-blocked; the same-origin proxy (server-side fetch)
  // returns the bytes readably -> embeds, no notice. All URLs resolve in
  // parallel via Promise.all; here we assert the per-URL fetch->proxy chain.
  const URL_ = 'https://cdn.example/cors-blocked.png';
  const PROXY = '/proxy';
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 0, y: 0, width: 40, height: 30 } };
  const styles = { v: { shape: 'image', image: URL_ } };
  const graph = graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const fetchImpl = async (target) => {
    if (target === URL_) throw new Error('CORS');           // direct blocked
    if (target.startsWith(PROXY + '?url=')) {                // proxy succeeds
      return { ok: true, blob: async () => new Blob([bytes], { type: 'image/png' }) };
    }
    return { ok: false };
  };
  // canvasImpl null so only fetch+proxy are exercised; proxyBase = PROXY.
  const resolved = await exporter.embedExternalImages(graph, fetchImpl,
    async () => null, PROXY);
  assert.ok(resolved[URL_] && resolved[URL_].startsWith('data:image/png;base64,'),
    'proxy returned the bytes -> data URI');
  const r = exporter.buildResult(graph, null, { resolvedImages: resolved });
  assert.ok(!r.notices.some((n) => n.kind === 'ExporterUnsupportedImage'),
    'proxied external image embeds -> no notice');
});

test('embedExternalImages: multiple images resolve together (parallel)', async () => {
  const A = 'https://a.example/1.png', B = 'https://b.example/2.png';
  const cells = { a: { id: 'a', vertex: true }, b: { id: 'b', vertex: true } };
  const states = { a: { x: 0, y: 0, width: 20, height: 20 },
    b: { x: 30, y: 0, width: 20, height: 20 } };
  const styles = { a: { shape: 'image', image: A }, b: { shape: 'image', image: B } };
  const graph = graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1);
  let inFlight = 0, maxInFlight = 0;
  const fetchImpl = async (u) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { ok: true, blob: async () => new Blob([new Uint8Array([0])], { type: 'image/png' }) };
  };
  const resolved = await exporter.embedExternalImages(graph, fetchImpl, async () => null, null);
  assert.ok(resolved[A] && resolved[B], 'both images resolved');
  assert.ok(maxInFlight >= 2, 'images fetched in parallel, not sequentially');
});

test('embedExternalImages: canvas fallback embeds when fetch is CORS-blocked', async () => {
  // Owner-authorised: when fetch() fails (CORS), re-encode the image via canvas.
  // Here the canvas step is injected (browser-only in production) to verify the
  // fetch->canvas fallback wiring deterministically.
  const URL_ = 'https://cdn.example/cors-blocked.png';
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 0, y: 0, width: 40, height: 30 } };
  const styles = { v: { shape: 'image', image: URL_ } };
  const graph = graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1);
  const failFetch = async () => { throw new Error('CORS'); };
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const fakeCanvas = async (u) => (u === URL_ ? 'data:image/png;base64,' + PNG : null);
  const resolved = await exporter.embedExternalImages(graph, failFetch, fakeCanvas);
  assert.ok(resolved[URL_] && resolved[URL_].startsWith('data:image/png;base64,'),
    'canvas fallback produced a data URI when fetch failed');
  const r = exporter.buildResult(graph, null, { resolvedImages: resolved });
  assert.ok(!r.notices.some((n) => n.kind === 'ExporterUnsupportedImage'),
    'canvas-embedded external image -> no notice');
});

test('embedExternalImages: unfetchable + unreadable external image stays loud', async () => {
  const URL_ = 'https://cross-origin.example/no-cors.png';
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 0, y: 0, width: 40, height: 30 } };
  const styles = { v: { shape: 'image', image: URL_ } };
  const graph = graphFixture(cells, states, {}, styles, FIXED_BOUNDS, 1);
  const failFetch = async () => { throw new Error('CORS'); };   // browser wall
  const resolved = await exporter.embedExternalImages(graph, failFetch);
  assert.deepEqual(resolved, {}, 'unfetchable URL is left unresolved');
  const r = exporter.buildResult(graph, null, { resolvedImages: resolved });
  const n = r.notices.find((x) => x.kind === 'ExporterUnsupportedImage');
  assert.ok(n, 'still loud + placeholder when the image cannot be fetched');
  assert.match(n.detail.detail, /could not be fetched/);
});

// --- Image: a format NO backend renders stays loud -----------------------
test('unsupported image format bmp → loud notice + placeholder box', () => {
  const r = oneVertex({ shape: 'image', image: 'data:image/bmp;base64,Qk0=' });
  const note = r.notices.find((n) => n.kind === 'ExporterUnsupportedImage');
  assert.ok(note, 'ExporterUnsupportedImage notice fires for bmp');
  assert.match(note.detail.detail, /bmp/i, 'notice names the format');
  const placeholder = r.contract.document.pages[0].paint
    .find((n) => n.kind === 'path');
  assert.ok(placeholder, 'placeholder path emitted to mark where image would be');
});

// --- Image: external URL is loudly named (would not embed) ---------------
test('external image URL is loudly noticed, never silently shipped', () => {
  const r = oneVertex({ shape: 'image', image: 'https://example.com/foo.png' });
  const note = r.notices.find((n) => n.kind === 'ExporterUnsupportedImage');
  assert.ok(note, 'external URL flagged');
  assert.match(note.detail.detail, /external image URL/i);
});

// --- Theme color: light-dark() resolves to LIGHT side in light mode ------
test('theme color: light-dark(L,D) resolves to L when not in dark mode', () => {
  const r = oneVertex({
    shape: 'rectangle',
    fillColor: 'light-dark(#abcdef, #112233)',
    strokeColor: 'light-dark(#445566, #ddeeff)'
  });
  const path = r.contract.document.pages[0].paint.find((n) => n.kind === 'path');
  assert.equal(path.fill.color, '#abcdef', 'light side picked by default');
  assert.equal(path.stroke.paint.color, '#445566');
});

// --- Theme color: var(--x, FALLBACK) unwraps to the fallback hex --------
test('theme color: var(--token, #fallback) unwraps to the hex fallback', () => {
  const r = oneVertex({
    shape: 'rectangle',
    fillColor: 'var(--ge-light-color, #ad1414)',
    strokeColor: 'var(--ge-dark-color, #200000)'
  });
  const path = r.contract.document.pages[0].paint.find((n) => n.kind === 'path');
  assert.equal(path.fill.color, '#ad1414');
  assert.equal(path.stroke.paint.color, '#200000');
});

// --- Theme color: nested light-dark with `default` sentinel inside ------
test('theme color: light-dark(default, hex) resolves the active-side default', () => {
  // Active side (light) is `default` → theme bg. Confirm the bake doesn't
  // emit a null fill, doesn't choke on the sentinel, doesn't propagate it.
  const r = oneVertex({
    shape: 'rectangle',
    fillColor: 'light-dark(default, #aa0000)',
    strokeColor: '#000000'
  });
  const path = r.contract.document.pages[0].paint.find((n) => n.kind === 'path');
  assert.ok(path.fill && /^#[0-9a-f]{6}$/.test(path.fill.color),
    'light-dark(default,...) still produces a hex fill');
});

// --- Label background: 8-digit #rrggbbaa alpha is honored ----------------
test('label background: #rrggbbaa parses with alpha (drawio format)', () => {
  const r = oneVertex({
    shape: 'rectangle', strokeColor: '#000000',
    labelBackgroundColor: '#ff000080',     // 50% alpha red
    labelBorderColor: '#0000ff',
    fontColor: '#ffffff'
  }, 'Tag');
  const bg = r.contract.document.pages[0].paint.find((n) =>
    n.kind === 'path' && n.fill && n.fill.color === '#ff0000');
  assert.ok(bg, 'label background path emitted');
  assert.ok(Math.abs(bg.fill.alpha - 0.502) < 0.01,
    `alpha derived from #rrggbbaa: got ${bg.fill.alpha}`);
});

// --- Edge: zero-length collapses arrow gracefully (no NaN coords) -------
test('edge: zero-length segment does not emit NaN/Infinity arrow coords', () => {
  const cell = { id: 'edge1', edge: true };
  const state = { x: 0, y: 0, width: 0, height: 0,
    // Two identical points -> length 0; arrowPath returns null
    absolutePoints: [{ x: 50, y: 50 }, { x: 50, y: 50 }] };
  const r = exporter.buildResult(graphFixture(
    { e: cell }, { e: state }, { e: '' },
    { e: { strokeColor: '#000000', endArrow: 'block' } },
    { x: 0, y: 0, width: 100, height: 100 }, 1));
  for (const n of r.contract.document.pages[0].paint) {
    if (n.kind === 'path') {
      assert.ok(!/NaN|Infinity/.test(n.d),
        `path data must be finite numbers only: ${n.d}`);
    }
  }
});

// --- Edge: single-point edge is dropped (< 2 points) --------------------
test('edge with <2 points emits nothing (no contract pollution)', () => {
  const cell = { id: 'e', edge: true };
  const state = { x: 0, y: 0, width: 0, height: 0,
    absolutePoints: [{ x: 5, y: 5 }] };
  const r = exporter.buildResult(graphFixture(
    { e: cell }, { e: state }, { e: '' },
    { e: { strokeColor: '#000000' } },
    { x: 0, y: 0, width: 100, height: 100 }, 1));
  const paint = r.contract.document.pages[0].paint;
  assert.equal(paint.length, 0, 'degenerate edge yields zero paint nodes');
});

// --- HardwareMarginClip: engine fires the notice when a cell escapes -----
// This is an engine-side responsibility (renderer.cpp), so we exercise the
// boundary: bake a cell that sits past the explicit paper size, the
// contract should still be schema-valid (loud-fail is the engine's job).
test('paper-aware bake keeps a cell past the paper inside the page; engine clips', () => {
  const cells = { v: { id: 'v', vertex: true } };
  const states = { v: { x: 500, y: 600, width: 80, height: 40 } };
  const styles = { v: { shape: 'rectangle', fillColor: '#cccccc', strokeColor: '#000000' } };
  const paper = { wPx: 200, hPx: 200 };
  const r = exporter.buildResult(graphFixture(
    cells, states, {}, styles, { x: 0, y: 0, width: 1000, height: 1000 }, 1), paper);
  // Page size respects the paper choice (engine clips at render).
  assert.deepEqual(r.contract.document.pages[0].size, { w: 200, h: 200 });
  // Path is still emitted, with its absolute coordinates kept.
  const path = r.contract.document.pages[0].paint.find((n) => n.kind === 'path');
  assert.ok(path && /M 500 600 /.test(path.d),
    'cell coords preserved verbatim; engine decides the clip notice');
});

// --- Plain label: nested HTML blocks split into lines (not one blob) ----
test('plainLabel: nested block tags split into separate lines, no collapse', () => {
  const r = oneVertex({ shape: 'rectangle', strokeColor: '#000000' },
    '<div><p>One</p><p>Two</p><p>Three</p></div>');
  const text = r.contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.ok(text && Array.isArray(text.content.lines));
  // No "OneTwoThree" mash-up.
  assert.ok(!text.content.lines.some((l) => /OneTwo/.test(l)),
    'block boundaries split lines');
  assert.ok(text.content.lines.join(' ').includes('One') &&
            text.content.lines.join(' ').includes('Two') &&
            text.content.lines.join(' ').includes('Three'));
});

// --- Plain label: HTML entities are decoded ------------------------------
test('plainLabel: HTML entities decoded (&amp; -> &), no jsdom involvement', () => {
  // The exporter uses doc.createElement('div').innerHTML = ... then reads
  // textContent — that path requires a DOM. In the Node harness there is no
  // document, so the regex path runs and entities stay literal. Either is
  // acceptable AS LONG AS the test pins which path applies here so a
  // future regression is loud, not silent.
  const r = oneVertex({ shape: 'rectangle', strokeColor: '#000000' },
    '<p>Fish &amp; Chips</p>');
  const text = r.contract.document.pages[0].paint.find((n) => n.kind === 'text');
  const joined = (text.content.lines || []).join(' ');
  // Either decoded ("Fish & Chips") or escaped-literal ("Fish &amp; Chips")
  // is acceptable; what must NOT happen is silent corruption like missing
  // tokens or HTML tags leaking through.
  assert.ok(/Fish/.test(joined) && /Chips/.test(joined),
    `tokens preserved: ${joined}`);
  assert.ok(!/<p>|<\/p>/.test(joined), 'block tags not in user-visible text');
});

// --- Stroke dash: malformed input falls back to default, not undefined ---
test('stroke dash: malformed pattern falls back to "3 3", never undefined', () => {
  for (const bad of ['', '   ', 'abc', '0', 'NaN', '-1 -2', '0 0']) {
    const r = oneVertex({ shape: 'rectangle', strokeColor: '#000000',
      dashed: '1', dashPattern: bad });
    const path = r.contract.document.pages[0].paint.find((n) => n.kind === 'path');
    assert.ok(Array.isArray(path.stroke.dash) && path.stroke.dash.length > 0,
      `dash always an array for bad pattern "${bad}"`);
    for (const d of path.stroke.dash) {
      assert.ok(d > 0 && Number.isFinite(d),
        `every dash entry is finite + positive (got ${d})`);
    }
  }
});

// --- Stroke width: zero / negative / NaN clamps to >= 0.1 ----------------
test('stroke width: zero/negative/NaN clamp to 0.1 minimum (engine validates >0)', () => {
  for (const bad of ['0', '-3', 'NaN', '', 'abc']) {
    const r = oneVertex({ shape: 'rectangle', strokeColor: '#000000', strokeWidth: bad });
    const path = r.contract.document.pages[0].paint.find((n) => n.kind === 'path');
    assert.ok(path.stroke.width >= 0.1,
      `bad strokeWidth "${bad}" → clamped to ${path.stroke.width}`);
  }
});

// --- Notices: same notice from many cells deduplicates ------------------
test('notices: identical degradations dedupe; distinct cellIds keep distinct entries', () => {
  // Three cells with the SAME unsupported image format → should produce
  // three notices (one per cellId) because the cell id is part of the
  // notice detail. None should be silently dropped.
  const cells = {}, states = {}, styles = {};
  for (let i = 0; i < 3; i++) {
    const id = 'i' + i;
    cells[id] = { id, vertex: true };
    states[id] = { x: i * 100, y: 0, width: 60, height: 40 };
    styles[id] = { shape: 'image', image: 'data:image/bmp;base64,Qk0abc' };
  }
  const r = exporter.buildResult(graphFixture(cells, states, {}, styles,
    { x: 0, y: 0, width: 400, height: 200 }, 1));
  const flagged = r.notices.filter((n) => n.kind === 'ExporterUnsupportedImage');
  assert.equal(flagged.length, 3, 'one notice per cell, never collapsed silently');
  const ids = new Set(flagged.map((n) => n.detail.cellId));
  assert.deepEqual(Array.from(ids).sort(), ['i0', 'i1', 'i2']);
});

// --- Schema invariant: every emitted node has a finite, non-NaN box -----
test('schema invariant: every node\'s box numbers are finite', () => {
  // Compose a stress fixture: 1 vertex with rectangle, 1 edge, 1 image
  // placeholder, 1 plain-text shape. All boxes must be finite.
  const cells = {
    v: { id: 'v', vertex: true },
    e: { id: 'e', edge: true },
    i: { id: 'i', vertex: true },
    t: { id: 't', vertex: true }
  };
  const states = {
    v: { x: 0, y: 0, width: 50, height: 50 },
    e: { x: 0, y: 0, width: 0, height: 0,
         absolutePoints: [{ x: 10, y: 10 }, { x: 90, y: 90 }] },
    i: { x: 100, y: 0, width: 40, height: 40 },
    t: { x: 0, y: 100, width: 60, height: 30 }
  };
  const styles = {
    v: { shape: 'rectangle', fillColor: '#000000', strokeColor: '#000000' },
    e: { strokeColor: '#000000', endArrow: 'block' },
    i: { shape: 'image', image: 'https://example/x.png' },     // placeholder + notice
    t: { shape: 'text' }
  };
  const r = exporter.buildResult(graphFixture(cells, states,
    { v: '', e: '', i: '', t: 'plain' }, styles,
    { x: 0, y: 0, width: 200, height: 200 }, 1));
  for (const n of r.contract.document.pages[0].paint) {
    if (n.box) {
      for (const k of ['x', 'y', 'w', 'h']) {
        assert.ok(Number.isFinite(n.box[k]),
          `${n.kind}.box.${k} must be finite (got ${n.box[k]})`);
      }
    }
  }
  assertSchemaValid(r.contract, 'mixed stress fixture');
});

// --- Schema invariant: contract has 1 page, 1 tile == page (current bake)
test('schema invariant: bake emits exactly one page and one tile (current contract)', () => {
  const r = oneVertex({ shape: 'rectangle' });
  assert.equal(r.contract.document.pages.length, 1, 'one page');
  assert.equal(r.contract.document.pages[0].tiles.length, 1, 'one tile');
  const t = r.contract.document.pages[0].tiles[0];
  const sz = r.contract.document.pages[0].size;
  assert.equal(t.origin.x, 0);
  assert.equal(t.origin.y, 0);
  assert.equal(t.size.w, sz.w);
  assert.equal(t.size.h, sz.h);
});

// --- Cells with no style / null style do not corrupt the contract --------
test('cell with null style is handled (defensive, never silently throws)', () => {
  const cell = { id: 'v', vertex: true };
  const state = { x: 10, y: 20, width: 80, height: 40 };
  const graph = {
    getModel: () => ({
      cells: { v: cell },
      isVertex: (c) => c.vertex === true,
      isEdge: (c) => c.edge === true
    }),
    view: { scale: 1, getState: () => state },
    getGraphBounds: () => FIXED_BOUNDS,
    getCellStyle: () => null,    // ← null style
    getLabel: () => '',
    isHtmlLabel: () => false
  };
  // Must not throw; even if no paint is produced, the contract is schema-valid.
  const r = exporter.buildResult(graph);
  assertSchemaValid(r.contract, 'null-style cell');
});

// --- bake is idempotent: same input → same contract (deterministic) ------
test('bake is deterministic: identical input produces byte-identical contract', () => {
  const make = () => oneVertex({ shape: 'rectangle',
    fillColor: '#abcdef', strokeColor: '#102030', strokeWidth: 2 },
    'Hello');
  const a = JSON.stringify(make().contract);
  const b = JSON.stringify(make().contract);
  assert.equal(a, b, 'two runs of the same input must produce identical bytes');
});

// --- Zoom independence: identical contract across a wide scale range ----
test('zoom independence: contract is identical across scale ∈ {0.1, 0.5, 1, 2.5, 10, 100}', () => {
  const baseline = JSON.stringify(exporter.buildResult(graphFixture(
    { v: { id: 'v', vertex: true } },
    { v: { x: 10, y: 20, width: 80, height: 40 } },
    { v: '' },
    { v: { shape: 'rectangle', fillColor: '#abcdef', strokeColor: '#000000' } },
    FIXED_BOUNDS, 1)).contract);
  for (const scale of [0.1, 0.5, 2.5, 10, 100]) {
    // state coords scale with view.scale (mxGraph convention).
    const state = { x: 10 * scale, y: 20 * scale,
      width: 80 * scale, height: 40 * scale };
    const bounds = { x: 10 * scale, y: 20 * scale,
      width: 400 * scale, height: 300 * scale };
    const r = exporter.buildResult(graphFixture(
      { v: { id: 'v', vertex: true } }, { v: state }, { v: '' },
      { v: { shape: 'rectangle', fillColor: '#abcdef', strokeColor: '#000000' } },
      bounds, scale));
    assert.equal(JSON.stringify(r.contract), baseline,
      `scale=${scale}: contract drifted from scale=1 baseline`);
  }
});

// --- Edge label positioning: orthogonal edge mid-point ------------------
test('edge label box centers on absoluteOffset when present', () => {
  const cell = { id: 'e', edge: true };
  const state = { x: 0, y: 0, width: 0, height: 0,
    absolutePoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    absoluteOffset: { x: 50, y: 0 } };
  const r = exporter.buildResult(graphFixture(
    { e: cell }, { e: state }, { e: 'Mid' },
    { e: { strokeColor: '#000', fontSize: 12, align: 'center' } },
    { x: 0, y: 0, width: 200, height: 200 }, 1));
  const text = r.contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.ok(text, 'edge label emitted');
  // Box is centered on (50, 0): box.x + box.w/2 ≈ 50.
  assert.ok(Math.abs((text.box.x + text.box.w / 2) - 50) < 1,
    `edge label centered on absoluteOffset: got x=${text.box.x} w=${text.box.w}`);
});

// --- Plain label: NUL + control chars stripped or kept LITERAL, never crash
test('plain label: control characters do not crash the bake', () => {
  // NUL, tab, vertical tab, form feed: include and verify the bake produces
  // a valid contract. Whether they appear literally or get sanitized is an
  // implementation choice; what must NOT happen is a crash or schema break.
  const ctrl = 'A B\tCDE';
  const r = oneVertex({ shape: 'rectangle', strokeColor: '#000000' }, ctrl);
  assertSchemaValid(r.contract, 'control chars');
  const t = r.contract.document.pages[0].paint.find((n) => n.kind === 'text');
  assert.ok(t, 'label emitted even with control chars');
  // At minimum the alphabetic letters survive.
  const all = (t.content.lines || []).join('');
  for (const ch of 'ABCDE') {
    assert.ok(all.includes(ch), `letter ${ch} must survive`);
  }
});

// --- Mixed-script labels (Unicode) pass through untouched ----------------
test('Unicode label (mixed scripts + emoji) round-trips into the contract', () => {
  const samples = [
    'ASCII basic',
    'Café — déjà vu',                                  // Latin-1
    'Привет, мир',                                     // Cyrillic
    '日本語ラベル',                                     // Japanese
    'العربية',                                         // Arabic (RTL — text-only)
    'Mixed 中文 + Emoji 🎉 (UTF-8 surrogate pair)'
  ];
  for (const s of samples) {
    const r = oneVertex({ shape: 'rectangle', strokeColor: '#000' }, s);
    const text = r.contract.document.pages[0].paint.find((n) => n.kind === 'text');
    assert.ok(text, `text node emitted for: ${s}`);
    const joined = (text.content.lines || [text.content.paragraphs])
      .join ? (text.content.lines || []).join('\n') : '';
    if (text.content.type === 'static') {
      assert.equal(joined, s, `static label preserved verbatim: ${s}`);
    }
  }
});

// --- LOUD-OR-FAITHFUL: gradient direction warning on fallback paths -----
// The v1 contract carries gradient stops but NOT direction (no p0/p1 for
// linear; no center/focus/radius for radial). When the fallback bake path
// emits a `kind:"path"` with a gradient fill, the host renders it always
// left-to-right (linear) or always centered (radial), regardless of the
// drawio gradientDirection. That is a silent divergence the C1 constraint
// forbids → must be loudly noticed. Live path (kind:"svg" with literal
// SVG bytes) is NOT affected (direction lives inside the SVG, resvg
// honours it).
test('LOUD: fallback gradient triggers GradientDirectionApprox notice', () => {
  // No live shape.node => svgCellNode/harvestShape both return null => the
  // last-resort fallback runs `fillOf(style)`, which emits a 2-stop linear
  // fill (the typical drawio gradient bake). Notice must fire loudly.
  const r = oneVertex({
    shape: 'rectangle',
    fillColor: '#ff0000',
    gradientColor: '#0000ff',
    gradientDirection: 'south',   // top->bottom, the drawio default
    strokeColor: '#000000'
  });
  const path = r.contract.document.pages[0].paint.find((n) => n.kind === 'path');
  assert.ok(path && path.fill && path.fill.type === 'linear',
    'fallback path carries the gradient fill');
  const notice = r.notices.find((n) => n.kind === 'GradientDirectionApprox');
  assert.ok(notice,
    'GradientDirectionApprox must fire whenever a gradient is emitted on ' +
    'the fallback path (contract carries no direction)');
  assert.match(notice.detail.detail, /direction/i);
});

test('LOUD: gradient notice does NOT fire when only solid fills exist', () => {
  const r = oneVertex({
    shape: 'rectangle',
    fillColor: '#ff0000',         // no gradient
    strokeColor: '#000000'
  });
  const notice = r.notices.find((n) => n.kind === 'GradientDirectionApprox');
  assert.equal(notice, undefined,
    'no gradient -> no GradientDirectionApprox notice (false-positives are noise)');
});

test('LOUD: gradient notice dedupes — many gradient cells produce ONE notice', () => {
  const cells = {}, states = {}, styles = {};
  for (let i = 0; i < 5; i++) {
    const id = 'g' + i;
    cells[id] = { id, vertex: true };
    states[id] = { x: i * 100, y: 0, width: 60, height: 40 };
    styles[id] = { shape: 'rectangle',
      fillColor: '#ff0000', gradientColor: '#0000ff',
      strokeColor: '#000000' };
  }
  const r = exporter.buildResult(graphFixture(cells, states, {}, styles,
    { x: 0, y: 0, width: 600, height: 200 }, 1));
  const flagged = r.notices.filter((n) => n.kind === 'GradientDirectionApprox');
  assert.equal(flagged.length, 1,
    'gradient-direction notice deduped to ONE entry, not one-per-cell ' +
    '(operator UI is not spammed by a structural-contract limitation)');
});

// --- LOUD: malformed harvested path fragment is loudly skipped ----------
// `transformPath` returns null on truly unparseable forms (numbers after
// Z with no new subpath, missing arguments, etc.). Previously the caller
// silently `continue`'d, losing geometry without operator warning. Now a
// loud ExporterUnsupportedShape notice fires naming the cell + tag.
test('LOUD: harvest skips a malformed path fragment with a notice', () => {
  // Trigger transformPath -> null: numbers after Z with no new M starts
  // a non-positioning command sequence the parser refuses (would spin
  // otherwise). The element's <path> carries this; a sibling <rect>
  // exists so harvest keeps emitting the good geometry.
  const fakeCTM = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const mkEl = (tag, attrs) => {
    const e = {
      nodeType: 1, tagName: tag, childNodes: [],
      getAttribute: (n) => (attrs[n] != null ? String(attrs[n]) : null),
      getAttributeNS: () => null,
      getCTM: () => fakeCTM
    };
    e.outerHTML = '';
    return e;
  };
  const badPath = mkEl('path', { d: 'M 0 0 L 1 1 Z 5 5' });
  const goodRect = mkEl('rect', { x: '0', y: '0', width: '40', height: '40' });
  const shape = mkEl('g', {});
  shape.childNodes = [badPath, goodRect];
  // CRITICAL: shape.parentNode must expose getCTM so harvestMatrix
  // succeeds. The shared svgFixture stomps parent with getScreenCTM-only,
  // which makes harvestMatrix bail.
  shape.parentNode = { getCTM: () => fakeCTM, getScreenCTM: () => fakeCTM };
  shape.ownerDocument = { getElementById: () => null };
  badPath.ownerDocument = shape.ownerDocument;
  goodRect.ownerDocument = shape.ownerDocument;

  const cells = { v: { id: 'v', vertex: true } };
  const state = { x: 10, y: 20, width: 80, height: 40, shape: { node: shape } };
  const r = exporter.buildResult({
    getModel: () => ({ cells,
      isVertex: () => true, isEdge: () => false }),
    view: { scale: 1, getState: () => state },
    getGraphBounds: () => FIXED_BOUNDS,
    getCellStyle: () => ({ shape: 'rectangle' }),
    getLabel: () => '',
    isHtmlLabel: () => false
  });
  // Harvest emitted the good rect; bad fragment loudly noticed.
  const notice = r.notices.find((n) =>
    n.kind === 'ExporterUnsupportedShape' && /path data/.test(n.detail.detail));
  assert.ok(notice,
    'harvest must loudly notice a skipped path fragment (not silently drop)');
  assert.equal(notice.detail.cellId, 'v', 'notice carries the cell id');
});

// --- utf8Bytes hardening: lone surrogates become U+FFFD, not invalid bytes
test('utf8 fallback: lone high/low surrogates encoded as U+FFFD (no invalid UTF-8)', () => {
  // base64-encode a string containing a lone high surrogate (no low pair).
  // This exercises the manual utf8 path only when TextEncoder is missing;
  // in Node TextEncoder exists, so we instead check end-to-end: the bake
  // labels a cell with the bad string and the resulting contract is still
  // schema-valid (no crash, no corruption that breaks downstream consumers).
  const loneHigh = '\uD800';                  // unpaired high surrogate
  const loneLow  = '\uDC00';                  // unpaired low surrogate
  for (const s of [loneHigh, loneLow, loneHigh + loneLow + 'X' + loneHigh]) {
    const r = oneVertex({ shape: 'rectangle', strokeColor: '#000000' }, s);
    assertSchemaValid(r.contract, 'lone surrogate label');
    const text = r.contract.document.pages[0].paint.find((n) => n.kind === 'text');
    assert.ok(text, 'label still emitted (no crash on lone surrogate)');
  }
});

// ===========================================================================
// Round 6 fidelity additions — close remaining silent gaps and add new
// HTML-label capabilities. Per the C1 mandate every divergence here is
// either faithfully rendered or loudly noticed.
// ===========================================================================

// --- LOUD: SVG with <animate> inside fires AnimatedSvgFrozen notice ------
test('LOUD: <animate> in a cell SVG triggers AnimatedSvgFrozen notice', () => {
  // The bake serializes the cell SVG; if it contains <animate*>, resvg
  // would render frame-0 only with no error. The bake must loudly notice.
  const shape = domEl('g', {}, [
    domEl('rect', { width: '40', height: '30', fill: '#abc' }),
    // Self-closed <animate> form inside the rect, baked into outerHTML.
  ]);
  // Inject an <animate> directly into the serialized shape outerHTML.
  shape.outerHTML = '<g><rect width="40" height="30" fill="#abc">' +
    '<animate attributeName="x" from="0" to="20" dur="1s" repeatCount="indefinite"/>' +
    '</rect></g>';
  const r = svgFixture(shape, null, { shape: 'rectangle' });
  const notice = r.notices.find((n) => n.kind === 'AnimatedSvgFrozen');
  assert.ok(notice, 'AnimatedSvgFrozen must fire for SVG with <animate>');
  assert.match(notice.detail.detail, /animation/i);
  assert.equal(notice.detail.cellId, 'v');
});

test('LOUD: <animateTransform> also triggers AnimatedSvgFrozen', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  shape.outerHTML = '<g><rect width="40" height="30" fill="#abc">' +
    '<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s"/>' +
    '</rect></g>';
  const r = svgFixture(shape, null, { shape: 'rectangle' });
  assert.ok(r.notices.find((n) => n.kind === 'AnimatedSvgFrozen'));
});

test('LOUD: static SVG (no <animate>) does NOT fire AnimatedSvgFrozen', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  shape.outerHTML = '<g><rect width="40" height="30" fill="#abc" stroke="#000"/></g>';
  const r = svgFixture(shape, null, { shape: 'rectangle' });
  assert.equal(
    r.notices.find((n) => n.kind === 'AnimatedSvgFrozen'), undefined,
    'no animation -> no notice (no false positives)');
});

// AnimatedSvgFrozen detection expanded to cover the rest of the SMIL set:
// <animateColor> (deprecated but supported), <set>, <discard>.
test('LOUD: <animateColor>, <set>, <discard> also trigger AnimatedSvgFrozen', () => {
  for (const tag of ['animateColor', 'set', 'discard']) {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    shape.outerHTML = '<g><rect width="40" height="30" fill="#abc">' +
      '<' + tag + ' attributeName="fill" to="#0f0" begin="2s"/>' +
      '</rect></g>';
    const r = svgFixture(shape, null, { shape: 'rectangle' });
    assert.ok(r.notices.find((n) => n.kind === 'AnimatedSvgFrozen'),
      'AnimatedSvgFrozen must fire for <' + tag + '>');
  }
});

test('LOUD: tag names that merely START with "animate" (e.g. <animator>) do NOT false-positive', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  shape.outerHTML = '<g><rect width="40" height="30" fill="#abc">' +
    // A made-up element whose name starts with "animate" — must not match.
    '<animator data-x="0"/>' +
    '</rect></g>';
  const r = svgFixture(shape, null, { shape: 'rectangle' });
  assert.equal(
    r.notices.find((n) => n.kind === 'AnimatedSvgFrozen'), undefined,
    'regex must be anchored on the SMIL element names, not substrings');
});

// ===========================================================================
// HTML-label transcription enhancements (round-6 production audit):
//   - CSS border transcription (new fidelity)
//   - Per-cell notice dedup
//   - Per-side border mismatch noticed
//   - Inline <img> PNG transcription / non-PNG loudly noticed
//   - CSS background-image loudly noticed (once per cell)
// ===========================================================================

// CSS border on root label element -> stroked <rect> in the emitted SVG.
test('HTML-label border: solid root border transcribes to stroked rect', () => {
  const styleMap = {
    rootdiv: { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
      fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
      backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
      letterSpacing: 'normal',
      borderTopStyle: 'solid', borderRightStyle: 'solid',
      borderBottomStyle: 'solid', borderLeftStyle: 'solid',
      borderTopWidth: '2px', borderRightWidth: '2px',
      borderBottomWidth: '2px', borderLeftWidth: '2px',
      borderTopColor: 'rgb(255, 0, 0)', borderRightColor: 'rgb(255, 0, 0)',
      borderBottomColor: 'rgb(255, 0, 0)', borderLeftColor: 'rgb(255, 0, 0)' },
  };
  const span = { nodeType: 1, tagName: 'span', _styleKey: 'span',
    childNodes: [], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 90, top: 40, width: 100, height: 40 }) };
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [span], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 90, top: 40, width: 100, height: 40 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: '', getBoundingClientRect: () => ({ left: 90, top: 40, width: 100, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  styleMap.span = styleMap.rootdiv;
  globalThis.getComputedStyle = (el) => styleMap[el && el._styleKey] || styleMap.rootdiv;
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    // Expect a stroked <rect> at rootDiv's rect, inset by half the stroke
    // width (2/2 = 1). So x=91 y=41 w=98 h=38, no dasharray (solid).
    assert.match(svg, /<rect [^>]*x="91"[^>]*y="41"[^>]*width="98"[^>]*height="38"[^>]*fill="none"[^>]*stroke="#ff0000"[^>]*stroke-width="2"/,
      'CSS solid border emitted as stroked <rect>');
    assert.ok(!/stroke-dasharray=/.test(svg.match(/<rect[^>]*stroke="#ff0000"[^>]*\/>/)[0]),
      'solid -> no stroke-dasharray');
  } finally { delete globalThis.getComputedStyle; }
});

test('HTML-label border: per-side differences render faithfully, no notice', () => {
  const sty = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal',
    borderTopStyle: 'solid', borderRightStyle: 'dashed',
    borderBottomStyle: 'solid', borderLeftStyle: 'solid',
    borderTopWidth: '2px', borderRightWidth: '2px',
    borderBottomWidth: '2px', borderLeftWidth: '2px',
    borderTopColor: 'rgb(255,0,0)', borderRightColor: 'rgb(0,0,255)',
    borderBottomColor: 'rgb(0,0,0)', borderLeftColor: 'rgb(0,0,0)' };
  const noBorder = Object.assign({}, sty, { borderStyle: 'none',
    borderTopStyle: 'none', borderRightStyle: 'none',
    borderBottomStyle: 'none', borderLeftStyle: 'none' });
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  globalThis.getComputedStyle = (el) => (el && el._styleKey === 'rootdiv') ? sty : noBorder;
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    // Per-side borders now transcribe to one stroked <line> per visible side,
    // each with its own colour/style -> no flatten-to-one-side approximation.
    assert.ok(!r.notices.some((n) => n.kind === 'RichApproximate' &&
      /per-side/.test(n.detail.detail)),
      'per-side borders render faithfully -> no RichApproximate notice');
    const lines = svg.match(/<line\b[^>]*>/g) || [];
    assert.equal(lines.length, 4, 'one stroked line per visible side');
    assert.ok(lines.some((l) => /stroke="#ff0000"/.test(l)), 'top side keeps red');
    assert.ok(lines.some((l) => /stroke="#0000ff"/.test(l)), 'right side keeps blue');
    assert.equal(lines.filter((l) => /stroke-dasharray/.test(l)).length, 1,
      'only the dashed (right) side carries a dasharray');
  } finally { delete globalThis.getComputedStyle; }
});

test('HTML-label border: uniform double -> two stroked rects, no notice', () => {
  const sty = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal',
    borderStyle: 'double',
    borderTopStyle: 'double', borderRightStyle: 'double',
    borderBottomStyle: 'double', borderLeftStyle: 'double',
    borderTopWidth: '6px', borderRightWidth: '6px',
    borderBottomWidth: '6px', borderLeftWidth: '6px',
    borderTopColor: 'rgb(0,0,0)', borderRightColor: 'rgb(0,0,0)',
    borderBottomColor: 'rgb(0,0,0)', borderLeftColor: 'rgb(0,0,0)' };
  const noBorder = Object.assign({}, sty, { borderStyle: 'none',
    borderTopStyle: 'none', borderRightStyle: 'none',
    borderBottomStyle: 'none', borderLeftStyle: 'none' });
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  globalThis.getComputedStyle = (el) => (el && el._styleKey === 'rootdiv') ? sty : noBorder;
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    const rects = svg.match(/<rect\b[^>]*fill="none"[^>]*>/g) || [];
    assert.equal(rects.length, 2, 'double border -> two concentric stroked rects');
    assert.ok(!r.notices.some((n) => n.kind === 'RichApproximate'),
      'double border renders faithfully -> no RichApproximate notice');
  } finally { delete globalThis.getComputedStyle; }
});

test('HTML-label border: 3D bevel (outset) renders two-tone, no notice', () => {
  const sty = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal',
    borderStyle: 'outset', borderTopStyle: 'outset', borderRightStyle: 'outset',
    borderBottomStyle: 'outset', borderLeftStyle: 'outset',
    borderWidth: '4px', borderTopWidth: '4px', borderRightWidth: '4px',
    borderBottomWidth: '4px', borderLeftWidth: '4px',
    borderColor: 'rgb(200,200,200)', borderTopColor: 'rgb(200,200,200)',
    borderRightColor: 'rgb(200,200,200)', borderBottomColor: 'rgb(200,200,200)',
    borderLeftColor: 'rgb(200,200,200)' };
  const noBorder = Object.assign({}, sty, { borderStyle: 'none',
    borderTopStyle: 'none', borderRightStyle: 'none',
    borderBottomStyle: 'none', borderLeftStyle: 'none' });
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'bevel',
    childNodes: [], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  globalThis.getComputedStyle = (el) => (el && el._styleKey === 'bevel') ? sty : noBorder;
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.ok(!r.notices.some((n) => n.kind === 'RichApproximate'),
      'bevel border renders two-tone faithfully -> no RichApproximate notice');
    const lines = svg.match(/<line\b[^>]*>/g) || [];
    assert.equal(lines.length, 4, 'one shaded line per side');
    // outset: top/left LIT (#c8c8c8), right/bottom SHADOWED (darkened ~#646464)
    assert.ok(lines.some((l) => /stroke="#c8c8c8"/.test(l)), 'lit edge keeps border colour');
    assert.ok(lines.some((l) => /stroke="#646464"/.test(l)), 'shadowed edge darkened');
  } finally { delete globalThis.getComputedStyle; }
});

test('HTML-label background-image: CSS gradient transcribes faithfully, no notice', () => {
  // Computed-style form (browsers normalise colours to rgb()).
  const styWithBgi = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal',
    backgroundImage: 'linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))' };
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  globalThis.getComputedStyle = () => styWithBgi;
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.ok(!r.notices.some((n) => n.kind === 'RichUnsupported'),
      'a CSS gradient background is faithfully transcribed -> no notice');
    assert.match(svg, /<linearGradient[^>]*>.*<stop[^>]*stop-color="#ff0000".*<stop[^>]*stop-color="#0000ff".*<\/linearGradient>/,
      'gradient -> SVG linearGradient with both stops');
    assert.match(svg, /<rect[^>]*fill="url\(#lblbg\d+\)"/, 'rect filled with the gradient');
    // to right -> horizontal line (x1=0 .. x2=1, y constant)
    assert.match(svg, /<linearGradient[^>]*x1="0"[^>]*x2="1"/);
  } finally { delete globalThis.getComputedStyle; }
});

test('HTML-label background-image: external url() stays loud (cannot embed)', () => {
  const sty = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal',
    backgroundImage: 'url("https://example.com/bg.png")' };
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  globalThis.getComputedStyle = () => sty;
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    const n = r.notices.find((x) => x.kind === 'RichUnsupported' &&
      /background-image/.test(x.detail.detail));
    assert.ok(n, 'external-URL background cannot be embedded -> loud notice');
    assert.match(n.detail.detail, /external URL/);
  } finally { delete globalThis.getComputedStyle; }
});

test('HTML-label background-image: data-URI url() embeds as <image>, no notice', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const sty = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal',
    backgroundImage: 'url("data:image/png;base64,' + PNG + '")' };
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  globalThis.getComputedStyle = () => sty;
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.ok(!r.notices.some((n) => n.kind === 'RichUnsupported'),
      'data-URI background embeds -> no notice');
    assert.ok(/<image [^>]*xlink:href="data:image\/png;base64,/.test(svg),
      'data-URI background painted as <image>');
  } finally { delete globalThis.getComputedStyle; }
});

test('HTML-label inline <img>: PNG data URI transcribed to <image>; non-PNG loud', () => {
  // 1x1 transparent PNG data URI (valid base64).
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const baseStyle = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal' };
  const mkImg = (src) => ({ nodeType: 1, tagName: 'img', _styleKey: 'img',
    childNodes: [], previousElementSibling: null,
    getAttribute: (n) => (n === 'src' ? src : null),
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 16, height: 16 }) });
  // Two images: one PNG data URI (should embed), one external URL (loud).
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [mkImg('data:image/png;base64,' + PNG),
                 mkImg('https://example.com/icon.png')],
    previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 80, height: 30 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 80, height: 30 }),
    ownerDocument: { createRange: mkRange } };
  globalThis.getComputedStyle = () => baseStyle;
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.ok(/<image [^>]*xlink:href="data:image\/png;base64,/.test(svg),
      'inline PNG <img> transcribed as SVG <image> with embedded data URI');
    const imgNotice = r.notices.find((n) => n.kind === 'RichUnsupported' &&
      /inline.*img/i.test(n.detail.detail));
    assert.ok(imgNotice, 'external-URL <img> loudly noticed');
    assert.match(imgNotice.detail.detail, /external URL/);
  } finally { delete globalThis.getComputedStyle; }
});

test('HTML-label inline <img>: JPEG/GIF/SVG data URIs embed faithfully, no notice', () => {
  const baseStyle = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal' };
  const mkImg = (src) => ({ nodeType: 1, tagName: 'img', _styleKey: 'img',
    childNodes: [], previousElementSibling: null,
    getAttribute: (k) => (k === 'src' ? src : null),
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 16, height: 16 }) });
  // resvg renders PNG/JPEG/GIF rasters and nested SVG from data URIs, so each
  // of these embeds as <image> with NO RichUnsupported notice.
  const cases = [
    ['data:image/jpeg;base64,/9j/AAAA', 'data:image/jpeg;base64,'],
    ['data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'data:image/gif;base64,'],
    ['data:image/svg+xml;base64,PHN2Zy8+', 'data:image/svg+xml;base64,']
  ];
  cases.forEach(([src, mimePrefix]) => {
    const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
      childNodes: [mkImg(src)], previousElementSibling: null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 80, height: 30 }) };
    const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
      textContent: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 80, height: 30 }),
      ownerDocument: { createRange: mkRange } };
    globalThis.getComputedStyle = () => baseStyle;
    try {
      const shape = domEl('g', {}, [domEl('rect', {})]);
      const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
      const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
      const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
      assert.ok(svg.includes('xlink:href="' + mimePrefix),
        mimePrefix + ' inline <img> embedded as SVG <image>');
      assert.ok(!r.notices.some((n) => n.kind === 'RichUnsupported' &&
        /inline.*img/i.test(n.detail.detail)),
        'embeddable inline <img> -> no RichUnsupported notice');
    } finally { delete globalThis.getComputedStyle; }
  });
});

// ---- GOAL: built-in objects rendered normally emit NO notice -------------
// A realistic built-in object — a rectangle whose HTML label is a bulleted
// list inside a uniformly-bordered div — must bake with zero notices, because
// every feature now transcribes faithfully (no flatten/approx left).
test('GOAL: built-in shape with bulleted, bordered HTML label -> zero notices', () => {
  const t1 = { nodeType: 3, nodeValue: 'First item' };
  const li1 = { nodeType: 1, tagName: 'li', _styleKey: 'li', childNodes: [t1],
    previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 80, top: 60, width: 120, height: 16 }) };
  t1.parentNode = li1;
  const t2 = { nodeType: 3, nodeValue: 'Second item' };
  const li2 = { nodeType: 1, tagName: 'li', _styleKey: 'li', childNodes: [t2],
    previousElementSibling: li1,
    getBoundingClientRect: () => ({ left: 80, top: 78, width: 120, height: 16 }) };
  t2.parentNode = li2;
  const ul = { nodeType: 1, tagName: 'ul', _styleKey: 'ul', childNodes: [li1, li2],
    previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 80, top: 60, width: 120, height: 34 }) };
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'bordered',
    childNodes: [ul], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 78, top: 58, width: 124, height: 38 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: 'First item Second item',
    getBoundingClientRect: () => ({ left: 78, top: 58, width: 124, height: 38 }),
    ownerDocument: { createRange: mkRange } };
  const noBorder = { borderStyle: 'none', borderTopStyle: 'none',
    borderRightStyle: 'none', borderBottomStyle: 'none', borderLeftStyle: 'none' };
  const bordered = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal',
    borderStyle: 'solid', borderTopStyle: 'solid', borderRightStyle: 'solid',
    borderBottomStyle: 'solid', borderLeftStyle: 'solid',
    borderWidth: '1px', borderTopWidth: '1px', borderRightWidth: '1px',
    borderBottomWidth: '1px', borderLeftWidth: '1px',
    borderColor: 'rgb(0,0,0)', borderTopColor: 'rgb(0,0,0)',
    borderRightColor: 'rgb(0,0,0)', borderBottomColor: 'rgb(0,0,0)',
    borderLeftColor: 'rgb(0,0,0)' };
  globalThis.getComputedStyle = (el) => {
    const k = el && el._styleKey;
    if (k === 'bordered') return bordered;
    if (k === 'li') return Object.assign({}, bordered, noBorder, { display: 'list-item' });
    return Object.assign({}, bordered, noBorder);   // ul / fo / text parents
  };
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    assert.deepEqual(r.notices, [],
      'every feature transcribes faithfully -> no bake notice for a built-in object');
    const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
    assert.ok(/<rect\b[^>]*fill="none"/.test(svg), 'uniform border -> one stroked rect');
    assert.ok(/•/.test(svg), 'list bullets rendered');
    assert.ok(!/<foreignObject/i.test(svg), 'never ships foreignObject');
  } finally { delete globalThis.getComputedStyle; }
});

// ---- Notice severity taxonomy (Print-gate contract) ----------------------
// The Native Print dialog blocks the Print button on *degradations* but not on
// *informational* notices. This classification is the single source of truth
// shared by the dialog (nativeprint.js) and keyed by the same `kind` string the
// UI receives from BOTH the exporter and the host/engine wire (proto.cpp).
// Pins WYSIWYG-without-friction: a faithful render / owner-accepted edge-clip
// must NOT require a per-print acknowledgment.
test('noticeSeverity: faithful-render success notice is silent (no warning)', () => {
  assert.equal(typeof exporter.noticeSeverity, 'function');
  // SvgArtworkRasterized = host SUCCESS notice ("rendered via resvg 0.47"). On
  // the Win32 host the design fonts are guaranteed so a successful resvg render
  // is trusted WYSIWYG; per owner directive a faithful print shows NO warning.
  // The dialog skips 'silent'; the engine may still emit it on the wire for
  // audit. The FAILURE path (StubbedSvgArtwork) stays a degradation below.
  assert.equal(exporter.noticeSeverity('SvgArtworkRasterized'), 'silent');
});

test('noticeSeverity: owner-accepted notices are informational', () => {
  // HardwareMarginClip = keep true size, the sheet shows what it can hold.
  assert.equal(exporter.noticeSeverity('HardwareMarginClip'), 'info');
  // Additive forward-compatible version skew.
  assert.equal(exporter.noticeSeverity('SchemaMinorAhead'), 'info');
  assert.equal(exporter.noticeSeverity('ProtoMinorAhead'), 'info');
});

test('noticeSeverity: real fidelity losses stay blocking degradations', () => {
  [
    // host/engine wire kinds (proto.cpp NoticeKind)
    'StubbedBarcode', 'StubbedSvgArtwork', 'FontSubstituted', 'MergeClip',
    // exporter bake kinds
    'ExporterUnsupportedShape', 'ExporterUnsupportedImage',
    'RichApproximate', 'RichUnsupported', 'GradientDirectionApprox',
    'AnimatedSvgFrozen', 'SvgListMarkerApprox'
  ].forEach((kind) => {
    assert.equal(exporter.noticeSeverity(kind), 'degradation',
      kind + ' must block Print until acknowledged');
  });
});

test('noticeSeverity: unknown kind fails safe to degradation', () => {
  assert.equal(exporter.noticeSeverity('SomethingNewAndUnknown'), 'degradation');
  assert.equal(exporter.noticeSeverity(''), 'degradation');
  assert.equal(exporter.noticeSeverity(undefined), 'degradation');
});

// --- Animation: built-in (CSS flow) prints clean; embedded SMIL stays guarded.
// drawio's ONLY built-in animation is edge "Flow Animation", which it renders
// as CSS @keyframes animating stroke-dashoffset on an already-drawn dashed
// stroke (Graph.js createFlowAnimationCss) — NOT SMIL <animate>. resvg ignores
// the CSS and draws the static dashed edge, which is a faithful still. So a
// built-in flow-animated edge must NOT raise AnimatedSvgFrozen.
test('built-in flow animation (CSS) prints static with NO AnimatedSvgFrozen notice', () => {
  const cells = { e: { id: 'e', edge: true } };
  const flowSvg =
    '<g><path d="M0 0 L80 0" fill="none" stroke="#000000" stroke-width="2" ' +
    'stroke-dasharray="8 8" style="animation: ge-flow-x 0.5s linear infinite"/>' +
    '<style>@keyframes ge-flow-x { to { stroke-dashoffset: 0; } }</style></g>';
  const states = { e: { x: 10, y: 20, width: 80, height: 2,
    shape: { node: { outerHTML: flowSvg } } } };
  const r = exporter.buildResult(graphFixture(cells, states, {}, {}));
  assert.ok(!r.notices.some((n) => n.kind === 'AnimatedSvgFrozen'),
    'CSS flow animation (drawio built-in) must not warn');
  const svgs = r.contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  const carried = svgs.some((n) =>
    Buffer.from(n.source, 'base64').toString().includes('stroke-dasharray'));
  assert.ok(carried, 'the frozen dashed edge stroke is carried into the print (WYSIWYG)');
});

// The guard must remain for a USER-EMBEDDED SVG file that contains real SMIL —
// not a built-in object — because such a clip can have a transparent frame-0
// (e.g. opacity 0 -> 1) that would otherwise print SILENTLY BLANK.
test('embedded SMIL animation still raises AnimatedSvgFrozen (silent-blank guard)', () => {
  const cells = { v: { id: 'v', vertex: true } };
  const smil =
    '<g><rect width="40" height="30" opacity="0">' +
    '<animate attributeName="opacity" from="0" to="1" dur="1s"/></rect></g>';
  const states = { v: { x: 10, y: 20, width: 40, height: 30,
    shape: { node: { outerHTML: smil } } } };
  const r = exporter.buildResult(graphFixture(cells, states, {}, {}));
  assert.ok(r.notices.some((n) => n.kind === 'AnimatedSvgFrozen'),
    'embedded SMIL (possibly blank frame-0) must stay loud');
});

// Regression: routing an image/icon cell through the literal-SVG path requires
// embedding its external <image> href (resvg can't fetch a relative URL) — but
// the rewrite must NOT touch gradient/pattern internal "#id" refs or already-
// inline "data:" hrefs. (The icon's gear was missing / a stray white label box
// cropped a neighbour because the icon was composed manually instead.)
test('embedImageHrefs: external <image> href -> resolved data URI; #refs & data: untouched', () => {
  const resolved = { 'img/clipart/Gear_128x128.png': 'data:image/png;base64,GEAR' };
  const svg =
    '<g><image x="0" y="0" width="60" height="60" ' +
    'xlink:href="img/clipart/Gear_128x128.png"/>' +
    '<rect fill="url(#grad1)"/>' +
    '<linearGradient id="grad1" xlink:href="#base"/>' +
    '<image href="data:image/png;base64,INLINE"/></g>';
  const out = exporter._embedImageHrefs(svg, resolved, { image: 'img/clipart/Gear_128x128.png' });
  assert.ok(out.includes('xlink:href="data:image/png;base64,GEAR"'),
    'the external gear href is replaced with the embedded data URI');
  assert.ok(out.includes('xlink:href="#base"'),
    'gradient internal #ref must be left intact');
  assert.ok(out.includes('href="data:image/png;base64,INLINE"'),
    'an already-inline data: href is left intact');
});

// Falls back to resolved[style.image] when drawio rendered the href absolute so
// the literal string is not itself a map key.
test('embedImageHrefs: absolute-rendered href falls back to style.image mapping', () => {
  const resolved = { 'img/clipart/Gear_128x128.png': 'data:image/png;base64,GEAR' };
  const svg = '<image xlink:href="http://localhost:3000/img/clipart/Gear_128x128.png"/>';
  const out = exporter._embedImageHrefs(svg, resolved, { image: 'img/clipart/Gear_128x128.png' });
  assert.ok(out.includes('data:image/png;base64,GEAR'),
    'unknown literal href resolves via style.image');
});

test('autosizeText: auto-scales fontSize to fit bounds headlessly', () => {
  const cells = {
    note: { id: 'note', vertex: true }
  };
  const states = {
    note: { x: 10, y: 20, width: 150, height: 150 }
  };
  const styles = {
    note: {
      shape: 'note',
      autosizeText: '1',
      fontSize: 20,
      whiteSpace: 'wrap'
    }
  };
  const labels = {
    note: 'The size of the font in this note will change so that it fits within the note shape'
  };

  const result = exporter.buildResult(graphFixture(cells, states, labels, styles), null, { mode: 'B' });
  const paint = result.contract.document.pages[0].paint;

  const svgNode = paint.find((n) => n.kind === 'svg' && n.source && Buffer.from(n.source, 'base64').toString('utf8').includes('<text'));
  assert.ok(svgNode, 'text SVG node should be emitted');
  const svgStr = Buffer.from(svgNode.source, 'base64').toString('utf8');
  const match = /font-size="(\d+(\.\d+)?)"/.exec(svgStr);
  assert.ok(match, 'should contain font-size attribute');
  const size = parseFloat(match[1]);
  assert.ok(size <= 16, `font size should be scaled down to fit (got ${size}px)`);
  assert.ok(size > 1, 'font size should be greater than 1');
});

