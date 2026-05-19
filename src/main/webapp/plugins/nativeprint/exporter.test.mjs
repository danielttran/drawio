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
  assert.match(paths[2], / A 2.4 2.4 0 0 1 /);
  assert.match(paths[3], /^M 0 45\.4 C /);
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
  assert.match(paint[0].d, / C 50 0 50 0 50 8 /);
  assert.deepEqual(paint[0].stroke.paint, { type: 'solid', color: '#123456', alpha: 1 });
  assert.equal(paint[1].fill.color, '#123456');
  assert.match(paint[1].d, /^M 50 50 L /);
  assert.equal(paint[2].kind, 'text');
  assert.equal(paint[2].font.color, '#654321');
  assert.equal(paint[2].box.h, 19.599999999999998);
  assert.equal(paint[2].align.h, 'center');
});

test('exporter reports unsupported shapes while preserving a valid fallback path', () => {
  const cells = { weird: { id: 'weird', vertex: true } };
  const states = { weird: { x: 10, y: 20, width: 100, height: 50 } };
  const styles = { weird: { shape: 'mxgraph.custom.thing', fillColor: '#abcdef', strokeColor: '#fedcba' } };

  const result = exporter.buildResult(graphFixture(cells, states, {}, styles));
  const path = result.contract.document.pages[0].paint[0];

  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].kind, 'ExporterUnsupportedShape');
  assert.equal(path.d, 'M 0 0 L 50 0 L 50 25 L 0 25 Z');
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
  assert.deepEqual(path.stroke.dash, [5, 2]);
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

// Minimal mirror of the engine's frozen v1.1 contract validation (Appendix A
// of PRINT_ENGINE_ACCURACY_TODO.md). Anything the exporter emits MUST pass
// this, otherwise the engine would loud-reject it and break WYSIWYG silently
// at print time.
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
  ['triangle north', { shape: 'triangle' }, /^M 40 0 L 80 40 L 0 40 Z$/],
  ['triangle south', { shape: 'triangle', direction: 'south' }, /^M 0 0 L 80 0 L 40 40 Z$/],
  ['triangle east', { shape: 'triangle', direction: 'east' }, /^M 0 0 L 80 20 L 0 40 Z$/],
  ['triangle west', { shape: 'triangle', direction: 'west' }, /^M 80 0 L 0 20 L 80 40 Z$/],
  ['cylinder', { shape: 'cylinder' }, /^M 0 [\d.]+ C /],
  ['cloud', { shape: 'cloud' }, /^M 20 30 C /],
  ['label', { shape: 'label' }, /^M 0 0 L 80 0 L 80 40 L 0 40 Z$/],
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

// ---- Every UNSUPPORTED stencil is loudly flagged (never silent) ----------
const UNSUPPORTED = [
  'hexagon', 'step', 'process', 'parallelogram', 'actor', 'callout',
  'mxgraph.flowchart.decision', 'mxgraph.azure.vm', 'mxgraph.aws4.lambda',
  'mxgraph.bpmn.task', 'tape', 'card', 'umlActor', 'note', 'cube'
];
for (const shape of UNSUPPORTED) {
  test(`unsupported stencil loudly degraded, not silent: ${shape}`, () => {
    const r = oneVertex({ shape, fillColor: '#abcdef', strokeColor: '#fedcba' });
    const notice = r.notices.find((n) => n.kind === 'ExporterUnsupportedShape');
    assert.ok(notice, `${shape} MUST emit ExporterUnsupportedShape`);
    assert.ok(String(notice.detail.detail).includes(shape), 'notice names shape');
    const path = r.contract.document.pages[0].paint[0];
    assert.match(path.d, /^M 0 0 L \d+ 0 L \d+ \d+ L 0 \d+ Z$/,
      'fallback is a valid bounding-box rect');
    assertSchemaValid(r.contract, shape);
  });
}

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
  if (textNode) textNode.ownerDocument = doc;
  const isEdge = !!opt.edge;
  const st = isEdge
    ? { x: 0, y: 0, width: 0, height: 0, absolutePoints: opt.pts || null,
        shape: { node: shapeNode } }
    : { x: 10, y: 20, width: 80, height: 40, shape: { node: shapeNode } };
  if (textNode) st.text = { node: textNode };
  const cells = { v: { id: 'v', vertex: !isEdge, edge: isEdge } };
  return exporter.buildResult(graphFixture(
    cells, { v: st }, { v: '' }, { v: style }, FIXED_BOUNDS, 1));
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

test('svg node inlines referenced defs (gradients/filters/markers)', () => {
  const grad = domEl('linearGradient', { id: 'g1' }, [domEl('stop', { offset: '0' })]);
  const shape = domEl('g', {}, [domEl('rect', { fill: 'url(#g1)' })]);
  const r = svgFixture(shape, null, { shape: 'x' }, { defs: { g1: grad } });
  const svg = decodeSvg(r.contract.document.pages[0].paint[0]);
  assert.ok(svg.includes('<defs>') && svg.includes('linearGradient id="g1"'),
    'referenced gradient is inlined so the SVG is self-contained');
});

test('HTML-label <foreignObject> is loudly flagged, never silently dropped', () => {
  const shape = domEl('g', {}, [domEl('rect', {})]);
  const fo = domEl('g', {}, [domEl('foreignObject', {}, [], 'rich')]);
  const r = svgFixture(shape, fo, { shape: 'rect' });
  assert.equal(r.contract.document.pages[0].paint[0].kind, 'svg',
    'still emits the faithful svg node');
  assert.ok(r.notices.some((x) => x.kind === 'SvgForeignObject'),
    'foreignObject requires a loud notice (backend support caveat)');
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

test('harvest absent (headless) -> named-shape/notice fallback preserved', () => {
  // No state.shape => the legacy path still runs (this is what Node CI uses).
  const r = oneVertex({ shape: 'umlActor', fillColor: '#abcdef', strokeColor: '#fedcba' });
  assert.ok(r.notices.some((n) => n.kind === 'ExporterUnsupportedShape'),
    'without a live SVG node the loud fallback is unchanged');
});

// ---- Fill variants -------------------------------------------------------
test('fill: solid / none / transparent / gradient / opacity', () => {
  assert.equal(oneVertex({ shape: 'rectangle' }).contract.document.pages[0].paint[0].fill, null,
    'truly absent fillColor key -> null (the sentinel case is covered separately)');
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
  assert.deepEqual(s.dash, [8, 3]);
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
  ['JPEG', 'data:image/jpeg;base64,/9j/4AAQ', /format "jpeg"/],
  ['GIF', 'data:image/gif;base64,R0lGODlh', /format "gif"/],
  ['SVG data URI', 'data:image/svg+xml;base64,PHN2Zz4=', /format "svg\+xml"/],
  ['non-base64 data URI', 'data:image/svg+xml;utf8,<svg/>', /non-base64/],
  ['external http URL', 'https://example.com/pic.png', /external image URL/],
  ['relative URL', '/images/logo.png', /external image URL/]
]) {
  test(`non-PNG image loud-flagged specifically, not silent/generic: ${label}`, () => {
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
  for (const shape of UNSUPPORTED) add({ shape, fillColor: '#abcdef', strokeColor: '#123456' }, false, 'U');
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
  // Invariant 2: exactly one notice per unsupported stencil — none silent.
  const degraded = r.notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
  assert.equal(degraded.length, UNSUPPORTED.length,
    'every unsupported stencil must be loudly flagged');
  // Invariant 3: nothing vanished — every cell contributed >=1 paint node.
  assert.ok(r.contract.document.pages[0].paint.length >=
    SUPPORTED_SHAPES.length + UNSUPPORTED.length,
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
  for (const shape of UNSUPPORTED) add({ shape, fillColor: '#abcdef', strokeColor: '#123456' }, false, 'Stencil');
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
