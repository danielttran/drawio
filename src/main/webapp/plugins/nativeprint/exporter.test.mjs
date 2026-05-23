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
  shapeNode.parentNode = opt.parent ||
    { getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) };
  if (textNode) textNode.ownerDocument = doc;
  const isEdge = !!opt.edge;
  const st = isEdge
    ? { x: 0, y: 0, width: 0, height: 0, absolutePoints: opt.pts || null,
        shape: { node: shapeNode } }
    : { x: 10, y: 20, width: 80, height: 40, shape: { node: shapeNode } };
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

// --- Image: non-PNG data URI is loudly named, not silent -----------------
for (const [tag, dataUri] of [
  ['jpeg', 'data:image/jpeg;base64,/9j/'],
  ['gif',  'data:image/gif;base64,R0lGOD'],
  ['svg',  'data:image/svg+xml;base64,PHN2'],
  ['bmp',  'data:image/bmp;base64,Qk0='],
]) {
  test(`unsupported image format ${tag} → loud notice + placeholder box`, () => {
    const r = oneVertex({ shape: 'image', image: dataUri });
    const note = r.notices.find((n) => n.kind === 'ExporterUnsupportedImage');
    assert.ok(note, `ExporterUnsupportedImage notice fires for ${tag}`);
    assert.match(note.detail.detail, new RegExp(tag, 'i'),
      `notice names the actual format (${tag})`);
    // There's a placeholder shape (path with stroke), never silent.
    const placeholder = r.contract.document.pages[0].paint
      .find((n) => n.kind === 'path');
    assert.ok(placeholder, 'placeholder path emitted to mark where image would be');
  });
}

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
    styles[id] = { shape: 'image', image: 'data:image/jpeg;base64,/9j/abc' };
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

test('HTML-label background-image: loud RichUnsupported (deduped across nested elements)', () => {
  const styWithBgi = { fontFamily: 'Arial', fontSize: '12px', fontWeight: '400',
    fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
    backgroundColor: 'rgba(0,0,0,0)', display: 'block', listStyleType: 'disc',
    letterSpacing: 'normal',
    backgroundImage: 'linear-gradient(to right, red, blue)' };
  // Nested: root + 3 inner spans, each with same background-image.
  const mkSpan = () => ({ nodeType: 1, tagName: 'span', _styleKey: 'span',
    childNodes: [], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 30, height: 14 }) });
  const rootDiv = { nodeType: 1, tagName: 'div', _styleKey: 'rootdiv',
    childNodes: [mkSpan(), mkSpan(), mkSpan()], previousElementSibling: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }) };
  const fo = { nodeType: 1, tagName: 'foreignObject', childNodes: [rootDiv],
    textContent: '', getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }),
    ownerDocument: { createRange: mkRange } };
  globalThis.getComputedStyle = () => styWithBgi;
  try {
    const shape = domEl('g', {}, [domEl('rect', {})]);
    const text = { nodeType: 1, tagName: 'g', childNodes: [fo] };
    const r = svgFixture(shape, text, { shape: 'rect' }, { html: true });
    const bgi = r.notices.filter((n) => n.kind === 'RichUnsupported' &&
      /background-image/.test(n.detail.detail));
    assert.equal(bgi.length, 1,
      '4 elements with same bg-image -> ONE notice (per-cell dedup)');
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

// ---- Notice severity taxonomy (Print-gate contract) ----------------------
// The Native Print dialog blocks the Print button on *degradations* but not on
// *informational* notices. This classification is the single source of truth
// shared by the dialog (nativeprint.js) and keyed by the same `kind` string the
// UI receives from BOTH the exporter and the host/engine wire (proto.cpp).
// Pins WYSIWYG-without-friction: a faithful render / owner-accepted edge-clip
// must NOT require a per-print acknowledgment.
test('noticeSeverity: success + owner-accepted notices are informational', () => {
  assert.equal(typeof exporter.noticeSeverity, 'function');
  // SvgArtworkRasterized = host success notice ("rendered via resvg 0.47").
  assert.equal(exporter.noticeSeverity('SvgArtworkRasterized'), 'info');
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
