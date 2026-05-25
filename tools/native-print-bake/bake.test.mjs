// Tests for the headless bake pipeline (Phase 2).
// Browser-free: pure node --test per docs/CLAUDE.md C2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { bake } from './bake.mjs';
import { pxContractToUm, SCALE } from './px-to-um.mjs';
import { parseDrawio, buildGraph } from './drawio-parser.mjs';
import { ShimDocument, ShimElement, ShimTextNode, ShimXMLSerializer } from './svg-shim/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../src/main/native-print-engine/tests/fixtures/labels');
const simpleDrawio = join(fixtureDir, 'simple.drawio');
const simpleGolden = join(fixtureDir, 'simple.contract.golden.json');

// --- px-to-um converter ---

test('SCALE factor is exactly 25400/96', () => {
  assert.equal(SCALE, 25400 / 96);
});

test('pxContractToUm: schema becomes minor=1, units become "um"', () => {
  const px = {
    schema: { major: 1, minor: 0 },
    document: { units: 'px', pages: [{ id: 'p1', size: { w: 96, h: 96 }, tiles: [{ origin: { x: 0, y: 0 }, size: { w: 96, h: 96 } }], paint: [] }] }
  };
  const um = pxContractToUm(px);
  assert.equal(um.schema.major, 1);
  assert.equal(um.schema.minor, 1);
  assert.equal(um.document.units, 'um');
  // 96 px * (25400/96) = 25400 um exactly
  assert.equal(um.document.pages[0].size.w, 25400);
  assert.equal(um.document.pages[0].size.h, 25400);
});

test('pxContractToUm: path d coordinates are scaled', () => {
  const px = {
    schema: { major: 1, minor: 0 },
    document: { units: 'px', pages: [{ id: 'p1', size: { w: 200, h: 100 }, tiles: [{ origin: { x: 0, y: 0 }, size: { w: 200, h: 100 } }],
      paint: [{ kind: 'path', d: 'M 0 0 L 96 0 L 96 96 L 0 96 Z', fill: null, stroke: null }] }] }
  };
  const um = pxContractToUm(px);
  const d = um.document.pages[0].paint[0].d;
  // 96 px * (25400/96) = 25400 um
  assert.match(d, /M 0 0 L 25400 0 L 25400 25400 L 0 25400 Z/);
});

test('pxContractToUm: arc flags are NOT scaled', () => {
  // Arc: A rx ry x-rotation large-arc-flag sweep-flag x y
  // flags at positions 2,3,4 in each 7-arg group must stay 0 or 1
  const arcD = 'M 0 10 A 20 10 0 1 0 40 10 A 20 10 0 1 0 0 10';
  const px = {
    schema: { major: 1, minor: 0 },
    document: { units: 'px', pages: [{ id: 'p1', size: { w: 200, h: 100 }, tiles: [{ origin: { x: 0, y: 0 }, size: { w: 200, h: 100 } }],
      paint: [{ kind: 'path', d: arcD, fill: null, stroke: null }] }] }
  };
  const um = pxContractToUm(px);
  const d = um.document.pages[0].paint[0].d;
  // Extract the A command args: should keep 0 1 0 (rotation=0, laf=1, sf=0) unchanged
  assert.match(d, / 0 1 0 /); // x-rotation=0, laf=1, sf=0 unchanged
  // rx=20 → 20*(25400/96)=5291.666... um
  assert.match(d, /A 5291\.666667 2645\.833333 0 1 0/);
});

test('pxContractToUm: font sizePx is scaled', () => {
  const px = {
    schema: { major: 1, minor: 0 },
    document: { units: 'px', pages: [{ id: 'p1', size: { w: 200, h: 100 }, tiles: [{ origin: { x: 0, y: 0 }, size: { w: 200, h: 100 } }],
      paint: [{ kind: 'text', box: { x: 0, y: 0, w: 100, h: 50 },
        font: { family: 'Arial', sizePx: 12, weight: 400, italic: false, color: '#000000' },
        align: { h: 'left', v: 'top' },
        content: { type: 'static', lines: ['Hi'] } }] }] }
  };
  const um = pxContractToUm(px);
  const textNode = um.document.pages[0].paint[0];
  // 12 px * (25400/96) = 3175 um
  assert.equal(textNode.font.sizePx, 3175);
});

test('pxContractToUm: stroke width is scaled', () => {
  const px = {
    schema: { major: 1, minor: 0 },
    document: { units: 'px', pages: [{ id: 'p1', size: { w: 200, h: 100 }, tiles: [{ origin: { x: 0, y: 0 }, size: { w: 200, h: 100 } }],
      paint: [{ kind: 'path', d: 'M 0 0 L 10 10',
        fill: null,
        stroke: { paint: { type: 'solid', color: '#000', alpha: 1 }, width: 1, cap: 'butt', join: 'miter', miterLimit: 10, dash: null } }] }] }
  };
  const um = pxContractToUm(px);
  const pathNode = um.document.pages[0].paint[0];
  // 1 px * (25400/96) = 264.583... um
  assert.ok(Math.abs(pathNode.stroke.width - 25400 / 96) < 0.001);
});

// --- drawio-parser ---

test('parseDrawio: simple fixture parses to expected cells', async () => {
  const xml = await readFile(simpleDrawio, 'utf8');
  const { cells, paper } = parseDrawio(xml);

  // Expect cells 0 (root), 1 (layer), 2 (rectangle), 3 (text)
  assert.ok(cells['0'], 'cell 0 (model root) present');
  assert.ok(cells['1'], 'cell 1 (layer) present');
  assert.ok(cells['2'], 'rectangle cell present');
  assert.ok(cells['3'], 'text cell present');

  assert.equal(cells['2'].vertex, true);
  assert.equal(cells['2'].value, 'Hello');
  assert.equal(cells['2'].geometry.x, 10);
  assert.equal(cells['2'].geometry.y, 10);
  assert.equal(cells['2'].geometry.width, 80);
  assert.equal(cells['2'].geometry.height, 30);
  assert.equal(cells['2'].style.fillColor, '#dae8fc');
  assert.equal(cells['2'].style.strokeColor, '#6c8ebf');

  assert.equal(cells['3'].vertex, true);
  assert.equal(cells['3'].value, 'World');
  // text shape: style="text;..."
  assert.equal(cells['3'].style.shape, 'text');

  // paper from pageWidth/pageHeight attributes
  assert.equal(paper.wPx, 200);
  assert.equal(paper.hPx, 100);
});

test('parseStyle: bare name sets shape', () => {
  // Test via parseDrawio with a cell that has a bare shape name
  const xml = `<mxGraphModel pageWidth="100" pageHeight="50">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="" style="ellipse;fillColor=#ff0000;" parent="1">
        <mxGeometry x="0" y="0" width="50" height="50" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { cells } = parseDrawio(xml);
  assert.equal(cells['2'].style.shape, 'ellipse');
  assert.equal(cells['2'].style.fillColor, '#ff0000');
});

// --- SVG shim ---

test('ShimElement: setAttribute / getAttribute roundtrip', () => {
  const el = new ShimElement('http://www.w3.org/2000/svg', 'rect', null);
  el.setAttribute('x', '10');
  el.setAttribute('fill', 'red');
  assert.equal(el.getAttribute('x'), '10');
  assert.equal(el.getAttribute('fill'), 'red');
  assert.equal(el.getAttribute('missing'), null);
});

test('ShimElement: appendChild and childNodes', () => {
  const parent = new ShimElement(null, 'g', null);
  const child = new ShimElement(null, 'rect', null);
  parent.appendChild(child);
  assert.equal(parent.childNodes.length, 1);
  assert.strictEqual(parent.childNodes[0], child);
  assert.strictEqual(child.parentNode, parent);
});

test('ShimElement: removeChild', () => {
  const parent = new ShimElement(null, 'g', null);
  const child = new ShimElement(null, 'rect', null);
  parent.appendChild(child);
  parent.removeChild(child);
  assert.equal(parent.childNodes.length, 0);
  assert.equal(child.parentNode, null);
});

test('ShimElement: style proxy get/set', () => {
  const el = new ShimElement(null, 'path', null);
  el.style.fill = 'blue';
  el.style.strokeWidth = '2px';
  assert.equal(el.style.fill, 'blue');
  assert.equal(el.style.strokeWidth, '2px');
});

test('ShimElement: getCTM returns identity-like object', () => {
  const el = new ShimElement(null, 'g', null);
  const m = el.getCTM();
  assert.equal(m.a, 1);
  assert.equal(m.d, 1);
  assert.equal(m.e, 0);
  assert.equal(m.f, 0);
});

test('ShimXMLSerializer: serializes element to XML', () => {
  const el = new ShimElement('http://www.w3.org/2000/svg', 'rect', null);
  el.setAttribute('x', '5');
  el.setAttribute('y', '10');
  const s = new ShimXMLSerializer();
  const xml = s.serializeToString(el);
  assert.match(xml, /^<rect/);
  assert.match(xml, /x="5"/);
  assert.match(xml, /y="10"/);
});

test('ShimXMLSerializer: serializes nested tree', () => {
  const g = new ShimElement(null, 'g', null);
  const path = new ShimElement(null, 'path', null);
  path.setAttribute('d', 'M 0 0');
  g.appendChild(path);
  const s = new ShimXMLSerializer();
  assert.match(s.serializeToString(g), /<g><path d="M 0 0"\/><\/g>/);
});

test('ShimDocument: getElementById finds by id attribute', () => {
  const doc = new ShimDocument();
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  doc.__root = svg;
  const defs = doc.createElementNS(null, 'defs');
  const grad = doc.createElementNS(null, 'linearGradient');
  grad.setAttribute('id', 'grad1');
  defs.appendChild(grad);
  svg.appendChild(defs);
  assert.strictEqual(doc.getElementById('grad1'), grad);
  assert.equal(doc.getElementById('nope'), null);
});

// --- full bake pipeline (C1: output matches golden) ---

test('bake: simple.drawio produces valid um contract', async () => {
  const xml = await readFile(simpleDrawio, 'utf8');
  const { contract, notices } = bake(xml);

  assert.equal(contract.schema.major, 1);
  assert.equal(contract.schema.minor, 1);
  assert.equal(contract.document.units, 'um');

  const page = contract.document.pages[0];
  // Page is 200x100 px → scaled to um
  assert.ok(Math.abs(page.size.w - 200 * SCALE) < 1, `page.w=${page.size.w}`);
  assert.ok(Math.abs(page.size.h - 100 * SCALE) < 1, `page.h=${page.size.h}`);

  // Should have paint nodes (at least the rectangle path + 2 text labels)
  assert.ok(page.paint.length >= 2, `expected ≥2 paint nodes, got ${page.paint.length}`);

  // All paint nodes have valid kinds
  const kinds = new Set(page.paint.map((n) => n.kind));
  for (const k of kinds) {
    assert.ok(['path','text','image','svg','barcode'].includes(k), `unexpected kind: ${k}`);
  }
});

test('C1: bake output matches simple.contract.golden.json', async () => {
  const xml    = await readFile(simpleDrawio,  'utf8');
  const golden = JSON.parse(await readFile(simpleGolden, 'utf8'));
  const { contract } = bake(xml);
  assert.deepEqual(contract, golden,
    'bake output diverged from golden — update golden if bake logic changed intentionally');
});

test('bake: ExporterUnsupportedShape notice for unknown shape', () => {
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="X" style="shape=mxgraph.aws4.user;fillColor=#ffffff;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="60" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { contract, notices } = bake(xml);
  assert.ok(notices.some((n) => n.kind === 'ExporterUnsupportedShape'),
    'expected ExporterUnsupportedShape notice for unknown shape');
  // Even with unsupported shape, bake produces a paint node (bounding box fallback)
  assert.ok(contract.document.pages[0].paint.length >= 1);
});

test('bake: empty diagram produces valid zero-paint contract', () => {
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
    </root>
  </mxGraphModel>`;
  const { contract } = bake(xml);
  assert.equal(contract.document.units, 'um');
  assert.equal(contract.document.pages[0].paint.length, 0);
});

test('bake: ellipse cell produces an arc path', () => {
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="" style="ellipse;fillColor=#ff0000;strokeColor=#0000ff;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="40" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { contract } = bake(xml);
  const paths = contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  assert.equal(paths.length, 1);
  // um-scaled ellipse path starts with M ... A ...
  assert.match(paths[0].d, /^M .+ A /);
  assert.equal(paths[0].fill.color, '#ff0000');
});

test('bake: schema minor is 1 and units are um', () => {
  const xml = `<mxGraphModel pageWidth="100" pageHeight="50">
    <root><mxCell id="0"/><mxCell id="1" parent="0"/></root>
  </mxGraphModel>`;
  const { contract } = bake(xml);
  assert.equal(contract.schema.minor, 1);
  assert.equal(contract.document.units, 'um');
});
