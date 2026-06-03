// Tests for the headless bake pipeline (Phase 2).
// Browser-free: pure node --test per docs/CLAUDE.md C2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

import { bake, localFileFetch } from './bake.mjs';
import { pxContractToUm, SCALE } from './px-to-um.mjs';
import { parseDrawio, buildGraph } from './drawio-parser.mjs';
import { ShimDocument, ShimElement, ShimTextNode, ShimXMLSerializer } from './svg-shim/index.mjs';
import { referencedFonts, checkFontAvailability, assertFontsAvailable } from './font-preflight.mjs';
import { loadStencils } from './stencil-loader.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../src/main/native-print-engine/tests/fixtures/labels');
const simpleDrawio = join(fixtureDir, 'simple.drawio');
const simpleGolden = join(fixtureDir, 'simple.contract.golden.json');

function svgText(node) {
  if (!node || node.kind !== 'svg' || typeof node.source !== 'string') return '';
  try {
    return Buffer.from(node.source, 'base64').toString('utf8')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function paintNodeText(node) {
  if (!node) return '';
  if (node.kind === 'text') {
    if (node.content?.type === 'rich') {
      return node.content.paragraphs
        .flatMap((p) => p.runs || [])
        .map((r) => r.text || '')
        .join(' ');
    }
    return (node.content?.lines || []).join(' ');
  }
  return svgText(node);
}

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
  const { contract, notices } = await bake(xml);

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
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden,
    'bake output diverged from golden — update golden if bake logic changed intentionally');
});

test('bake: flowchart parallelogram emits no print-warning notice', async () => {
  // Parallelogram is a supported browser-free object type.
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="X" style="shape=parallelogram;fillColor=#ffffff;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="60" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { contract, notices } = await bake(xml);
  assert.equal(notices.length, 0);
  assert.ok(contract.document.pages[0].paint.length >= 1);
});

test('bake: html object type emits no print-warning notice', async () => {
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="&lt;b&gt;HTML&lt;/b&gt; object" style="shape=html;html=1;whiteSpace=wrap;fillColor=none;strokeColor=none;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="60" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { contract, notices } = await bake(xml);
  assert.equal(notices.length, 0);
  const svgNode = contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  assert.ok(svgNode, 'html object emits printable svg text');
  const decoded = Buffer.from(svgNode.source, 'base64').toString('utf8');
  // The rich renderer keeps every run verbatim (now per-run, so "HTML" and
  // "object" are separate <text> elements) AND faithfully — the <b> run is bold.
  assert.ok(/>HTML</.test(decoded), 'html object keeps its bold run text');
  assert.ok(/>object</.test(decoded), 'html object keeps its plain run text');
  assert.ok(/font-weight="700"[^>]*>HTML</.test(decoded),
    'the <b> run prints bold (per-run fidelity)');
});

function graphXmlForShapes(shapes, label) {
  let cells = '<mxCell id="0"/><mxCell id="1" parent="0"/>';
  shapes.forEach((shape, i) => {
    cells += `<mxCell id="c${i}" vertex="1" value="${label || ''}" ` +
      `style="shape=${shape};fillColor=#ffffff;strokeColor=#000000;" parent="1">` +
      `<mxGeometry x="${(i % 20) * 60}" y="${Math.floor(i / 20) * 60}" ` +
      `width="50" height="50" as="geometry"/></mxCell>`;
  });
  return `<mxGraphModel pageWidth="1200" pageHeight="3000"><root>${cells}</root></mxGraphModel>`;
}

test('coverage: every draw.io registered Shapes.js object bakes browser-free with no unsupported-shape warning', async () => {
  const shapesJs = await readFile(resolve(here, '../../src/main/webapp/js/grapheditor/Shapes.js'), 'utf8');
  const registered = [...new Set([...shapesJs.matchAll(/mxCellRenderer\.registerShape\('([^']+)'/g)]
    .map((m) => m[1]))];
  assert.ok(registered.length >= 80, `expected full Shapes.js catalogue, got ${registered.length}`);

  const { contract, notices } = await bake(graphXmlForShapes(registered, 'T'), { keepPx: true });
  const unsupported = notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
  assert.equal(unsupported.length, 0,
    `registered shape(s) still warn: ${unsupported.map((n) => n.detail?.detail).join('; ')}`);
  assert.ok(contract.document.pages[0].paint.length >= registered.length,
    'every registered object contributes printable paint or text');
});

test('coverage: every checked-in draw.io stencil object bakes browser-free with no unsupported-shape warning', async () => {
  const registry = await loadStencils(resolve(here, '../../src/main/webapp/stencils'));
  const stencilKeys = [...registry.keys()];
  assert.ok(stencilKeys.length >= 8000, `expected full stencil catalogue, got ${stencilKeys.length}`);

  for (let start = 0; start < stencilKeys.length; start += 1000) {
    const chunk = stencilKeys.slice(start, start + 1000);
    const { notices } = await bake(graphXmlForShapes(chunk, ''), { keepPx: true });
    const unsupported = notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
    assert.equal(unsupported.length, 0,
      `stencil shape(s) ${start}-${start + chunk.length - 1} still warn: ` +
      unsupported.map((n) => n.detail?.detail).join('; '));
  }
});

test('bake: empty diagram produces valid zero-paint contract', async () => {
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
    </root>
  </mxGraphModel>`;
  const { contract } = await bake(xml);
  assert.equal(contract.document.units, 'um');
  assert.equal(contract.document.pages[0].paint.length, 0);
});

test('bake: ellipse cell produces an arc path', async () => {
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="" style="ellipse;fillColor=#ff0000;strokeColor=#0000ff;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="40" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { contract } = await bake(xml);
  const paths = contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  assert.equal(paths.length, 1);
  // um-scaled ellipse path starts with M ... A ...
  assert.match(paths[0].d, /^M .+ A /);
  assert.equal(paths[0].fill.color, '#ff0000');
});

test('bake: schema minor is 1 and units are um', async () => {
  const xml = `<mxGraphModel pageWidth="100" pageHeight="50">
    <root><mxCell id="0"/><mxCell id="1" parent="0"/></root>
  </mxGraphModel>`;
  const { contract } = await bake(xml);
  assert.equal(contract.schema.minor, 1);
  assert.equal(contract.document.units, 'um');
});

// --- C1: golden match for shapes corpus ---

const shapesDrawio = join(fixtureDir, 'shapes.drawio');
const shapesGolden = join(fixtureDir, 'shapes.contract.golden.json');

test('C1: bake output matches shapes.contract.golden.json', async () => {
  const xml    = await readFile(shapesDrawio, 'utf8');
  const golden = JSON.parse(await readFile(shapesGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden,
    'shapes bake output diverged from golden');
});

// --- C3: structural invariants (WYSIWYG-by-construction) ---
// These run against the bake output and verify that every labelled cell
// maps faithfully to paint nodes — no silent drops, no re-derived geometry.

test('C3: every vertex with a non-empty value has a label paint node', async () => {
  const xml = await readFile(shapesDrawio, 'utf8');
  const { cells } = parseDrawio(xml);
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  const labelNodes = paint.filter((n) => n.kind === 'text' || n.kind === 'svg');

  // Collect all labelled vertices (non-empty value, skip layers/root)
  const labelledCells = Object.values(cells).filter(
    (c) => c.vertex && c.value && c.value.trim() !== '' && c.parent !== null
  );
  assert.ok(labelledCells.length > 0, 'fixture should have labelled cells');

  // Each labelled cell must have at least one label node matching its label
  for (const cell of labelledCells) {
    const label = cell.value.trim();
    const found = labelNodes.some((n) => paintNodeText(n).includes(label));
    assert.ok(found, `no label node found for label "${label}" (cell id=${cell.id})`);
  }
});

test('C3: standard shapes produce no ExporterUnsupportedShape notice', async () => {
  const xml = await readFile(shapesDrawio, 'utf8');
  const { notices } = await bake(xml);
  const unsupported = notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
  assert.equal(unsupported.length, 0,
    `unexpected ExporterUnsupportedShape: ${unsupported.map((n) => n.detail && n.detail.detail).join('; ')}`);
});

test('C3: all paint nodes have strictly positive box dimensions (where applicable)', async () => {
  const xml = await readFile(shapesDrawio, 'utf8');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  const boxKinds = new Set(['text', 'image', 'svg', 'barcode']);
  for (const node of paint) {
    if (!boxKinds.has(node.kind)) continue;
    assert.ok(node.box && node.box.w > 0 && node.box.h > 0,
      `${node.kind} node has non-positive box: ${JSON.stringify(node.box)}`);
  }
});

test('C3: simple.drawio — vertex count equals geometric-shape paint-node count', async () => {
  const xml = await readFile(simpleDrawio, 'utf8');
  const { cells } = parseDrawio(xml);
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;

  // Count visible vertices (not root/layer, with geometry)
  const visibleVertices = Object.values(cells).filter(
    (c) => c.vertex && c.geometry && c.geometry.width > 0 && c.geometry.height > 0
      && c.parent !== null
  );

  // For shapes, the path paint nodes correspond to shape bodies;
  // text nodes correspond to labels; shape='text' cells have no path body.
  const nonTextShapes = visibleVertices.filter((c) => c.style.shape !== 'text');
  const pathNodes = paint.filter((n) => n.kind === 'path');
  // Each non-text shape should emit at least one path node (some emit multiple).
  assert.ok(pathNodes.length >= nonTextShapes.length,
    `expected ≥${nonTextShapes.length} path nodes, got ${pathNodes.length}`);
});

test('C3: bake output passes validate-contract', async () => {
  // Run the validator on a tmp file to confirm C3 at the contract schema level.
  const { execFile } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  const tmp = join(tmpdir(), 'bake-c3-test.json');
  const xml = await readFile(shapesDrawio, 'utf8');
  const { contract } = await bake(xml);
  await writeFile(tmp, JSON.stringify(contract));
  const scriptPath = resolve(here, '../native-print-validate-contract.mjs');
  const r = await execFileP(process.execPath, [scriptPath, tmp]).catch((e) => e);
  assert.equal(r.code ?? 0, 0,
    `validate-contract failed: ${r.stdout || ''}`);
});

// --- multi-page and D5 ---

test('bake: multi-page .drawio produces contract with multiple pages', async () => {
  const xml = `<mxfile>
    <diagram id="d1" name="Page-1">
      <mxGraphModel pageWidth="200" pageHeight="100">
        <root>
          <mxCell id="0"/><mxCell id="1" parent="0"/>
          <mxCell id="2" vertex="1" value="P1" style="rounded=1;" parent="1">
            <mxGeometry x="10" y="10" width="80" height="30" as="geometry"/>
          </mxCell>
        </root>
      </mxGraphModel>
    </diagram>
    <diagram id="d2" name="Page-2">
      <mxGraphModel pageWidth="200" pageHeight="100">
        <root>
          <mxCell id="0"/><mxCell id="1" parent="0"/>
          <mxCell id="2" vertex="1" value="P2" style="ellipse;" parent="1">
            <mxGeometry x="10" y="10" width="80" height="30" as="geometry"/>
          </mxCell>
        </root>
      </mxGraphModel>
    </diagram>
  </mxfile>`;
  const { contract } = await bake(xml);
  assert.equal(contract.document.pages.length, 2);
  assert.equal(contract.document.pages[0].id, 'page-1');
  assert.equal(contract.document.pages[1].id, 'page-2');
  assert.equal(contract.document.units, 'um');
});

test('bake: pages option selects subset of pages', async () => {
  const xml = `<mxfile>
    <diagram id="d1" name="Page-1">
      <mxGraphModel pageWidth="100" pageHeight="50">
        <root><mxCell id="0"/><mxCell id="1" parent="0"/></root>
      </mxGraphModel>
    </diagram>
    <diagram id="d2" name="Page-2">
      <mxGraphModel pageWidth="100" pageHeight="50">
        <root><mxCell id="0"/><mxCell id="1" parent="0"/></root>
      </mxGraphModel>
    </diagram>
  </mxfile>`;
  const { contract } = await bake(xml, { pages: [1] }); // only second page
  assert.equal(contract.document.pages.length, 1);
  assert.equal(contract.document.pages[0].id, 'page-1'); // ordinal from selected set
});

test('D5: unattended mode succeeds for supported browser-free flowchart shape', async () => {
  // Flowchart parallelogram no longer triggers a degradation notice.
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="" style="shape=parallelogram;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="60" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { notices } = await bake(xml, { unattended: true });
  assert.equal(notices.length, 0);
});

test('D5: unattended mode succeeds when no notices', async () => {
  // Standard shape with no notices
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="OK" style="rounded=1;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="30" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { contract, notices } = await bake(xml, { unattended: true }); // must not throw
  assert.equal(notices.length, 0);
  assert.equal(contract.document.units, 'um');
});

test('localFileFetch: bundled assets resolve but paths outside webapp stay blocked', async () => {
  const bundled = await localFileFetch('img/clipart/Gear_128x128.png');
  assert.equal(bundled.ok, true, 'bundled relative webapp asset should remain readable');
  assert.equal((await localFileFetch('/img/clipart/Gear_128x128.png')).ok, true,
    'bundled root-relative webapp asset should remain readable');

  const dir = await mkdtemp(join(tmpdir(), 'native-print-local-fetch-'));
  const outside = join(dir, 'secret.png');
  await writeFile(outside, Buffer.from('not-for-embedding'));
  try {
    const traversal = relative(resolve(here, '../../src/main/webapp'), outside);
    assert.equal((await localFileFetch(traversal)).ok, false,
      '../ traversal must not escape the bundled webapp asset root');
    assert.equal((await localFileFetch('//' + outside.replace(/^\/+/, ''))).ok, false,
      'protocol-relative path must not become an absolute filesystem read');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Gap 1B: bake() accepts fetchFn option; injectable fetch resolves external image URLs', async () => {
  // Build a diagram with an external image URL
  const pngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const fakeFetch = async (url) => {
    if (String(url).startsWith('http')) {
      return {
        ok: true,
        blob: async () => ({
          type: 'image/png',
          arrayBuffer: async () => Buffer.from(pngDataUri.split(',')[1], 'base64')
        })
      };
    }
    return { ok: false };
  };
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="" style="shape=image;image=https://example.com/img.png;" parent="1">
        <mxGeometry x="10" y="10" width="80" height="60" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { notices } = await bake(xml, { fetchFn: fakeFetch });
  const imgNotices = notices.filter(n => n.kind === 'ExporterUnsupportedImage');
  assert.equal(imgNotices.length, 0, 'fetchFn resolved the external image — no ExporterUnsupportedImage notice expected');
});

// --- font preflight (§3.5) ---

test('referencedFonts: collects font families from text nodes', async () => {
  const xml = await readFile(simpleDrawio, 'utf8');
  const { contract } = await bake(xml);
  const fonts = referencedFonts(contract);
  assert.ok(fonts.size > 0, 'expected at least one font family');
  assert.ok(fonts.has('Helvetica'), 'expected Helvetica (draw.io default)');
});

test('referencedFonts: collects rich-run fontFamily', () => {
  const contract = {
    document: { pages: [{ paint: [{
      kind: 'text', box: { x:0,y:0,w:10,h:10 },
      font: { family: 'Arial', sizePx: 12 },
      align: { h:'left',v:'top' },
      content: { type: 'rich', paragraphs: [{
        align: 'left', runs: [
          { text: 'A', fontFamily: 'Helvetica', sizePx: 12, weight: 400, italic: false, underline: false, strikethrough: false, color: '#000' }
        ]
      }]}
    }]}]}
  };
  const fonts = referencedFonts(contract);
  assert.ok(fonts.has('Arial'));
  assert.ok(fonts.has('Helvetica'));
});

test('checkFontAvailability: returns missing fonts', () => {
  const missing = checkFontAvailability(
    new Set(['Arial', 'CustomFont']),
    new Set(['Arial', 'Times New Roman'])
  );
  assert.deepEqual([...missing], ['CustomFont']);
});

test('assertFontsAvailable: passes when all fonts present', async () => {
  const xml = await readFile(simpleDrawio, 'utf8');
  const { contract } = await bake(xml);
  const fonts = referencedFonts(contract);
  assert.doesNotThrow(() => assertFontsAvailable(contract, fonts));
});

test('assertFontsAvailable: throws MISSING_FONTS when font absent', async () => {
  const xml = await readFile(simpleDrawio, 'utf8');
  const { contract } = await bake(xml);
  assert.throws(
    () => assertFontsAvailable(contract, new Set(['Arial'])),
    (err) => err.code === 'MISSING_FONTS' && Array.isArray(err.missingFonts)
  );
});

// --- C4: Zero-notice gate (§6 / §9.3) ---
// Every supported-vocabulary sample renders with zero degradation notices.

test('C4: simple.drawio produces zero degradation notices', async () => {
  const xml = await readFile(simpleDrawio, 'utf8');
  const { notices } = await bake(xml);
  assert.equal(notices.length, 0,
    `C4 failed: ${notices.map((n) => `${n.kind}:${n.detail && n.detail.detail || ''}`).join('; ')}`);
});

test('C4: shapes.drawio produces zero degradation notices', async () => {
  const xml = await readFile(shapesDrawio, 'utf8');
  const { notices } = await bake(xml);
  assert.equal(notices.length, 0,
    `C4 failed: ${notices.map((n) => `${n.kind}:${n.detail && n.detail.detail || ''}`).join('; ')}`);
});

// --- C5: Vocabulary coverage (§6 / §9.3) ---
// Every object type in the corpus renders non-empty output (never a silent stub).

test('C5: simple.drawio — all paint nodes have non-empty content', async () => {
  const xml = await readFile(simpleDrawio, 'utf8');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  assert.ok(paint.length > 0, 'C5: no paint nodes produced for simple.drawio');
  for (const node of paint) {
    if (node.kind === 'path') {
      assert.ok(node.d && node.d.trim().length > 1,
        `C5: path node has trivially empty d: ${JSON.stringify(node.d)}`);
    } else if (node.kind === 'text') {
      assert.ok(node.box && node.box.w > 0 && node.box.h > 0,
        `C5: text node has zero-area box: ${JSON.stringify(node.box)}`);
    }
  }
});

test('C5: shapes.drawio — rect/ellipse/diamond/rounded produce non-empty path nodes', async () => {
  const xml = await readFile(shapesDrawio, 'utf8');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  const pathNodes = paint.filter((n) => n.kind === 'path');
  // shapes.drawio has rect, ellipse, diamond, rounded-rect = 4 shapes
  assert.ok(pathNodes.length >= 4,
    `C5: expected ≥4 non-empty path nodes for 4 shapes, got ${pathNodes.length}`);
  for (const node of pathNodes) {
    assert.ok(node.d && node.d.trim().length > 2,
      `C5: shape path node has trivially empty d: ${JSON.stringify(node.d)}`);
  }
});

// --- Expanded corpus (§9.1): connector, gradient, multitext, groups, multipage ---

const connectorDrawio   = join(fixtureDir, 'connector.drawio');
const connectorGolden   = join(fixtureDir, 'connector.contract.golden.json');
const gradientDrawio    = join(fixtureDir, 'gradient.drawio');
const gradientGolden    = join(fixtureDir, 'gradient.contract.golden.json');
const multitextDrawio   = join(fixtureDir, 'multitext.drawio');
const multitextGolden   = join(fixtureDir, 'multitext.contract.golden.json');
const groupsDrawio      = join(fixtureDir, 'groups.drawio');
const groupsGolden      = join(fixtureDir, 'groups.contract.golden.json');
const multipageDrawio   = join(fixtureDir, 'multipage.drawio');
const multipageGolden   = join(fixtureDir, 'multipage.contract.golden.json');

// C1: golden match

test('C1: bake output matches connector.contract.golden.json', async () => {
  const xml    = await readFile(connectorDrawio, 'utf8');
  const golden = JSON.parse(await readFile(connectorGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden, 'connector bake output diverged from golden');
});

test('C1: bake output matches gradient.contract.golden.json', async () => {
  const xml    = await readFile(gradientDrawio, 'utf8');
  const golden = JSON.parse(await readFile(gradientGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden, 'gradient bake output diverged from golden');
});

test('C1: bake output matches multitext.contract.golden.json', async () => {
  const xml    = await readFile(multitextDrawio, 'utf8');
  const golden = JSON.parse(await readFile(multitextGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden, 'multitext bake output diverged from golden');
});

test('C1: bake output matches groups.contract.golden.json', async () => {
  const xml    = await readFile(groupsDrawio, 'utf8');
  const golden = JSON.parse(await readFile(groupsGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden, 'groups bake output diverged from golden');
});

test('C1: bake output matches multipage.contract.golden.json', async () => {
  const xml    = await readFile(multipageDrawio, 'utf8');
  const golden = JSON.parse(await readFile(multipageGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden, 'multipage bake output diverged from golden');
});

// C4: zero-notice gate for supported-vocabulary samples
// (gradient and groups produce expected notices and are excluded from C4)

test('C4: connector.drawio produces zero degradation notices', async () => {
  const xml = await readFile(connectorDrawio, 'utf8');
  const { notices } = await bake(xml);
  assert.equal(notices.length, 0,
    `C4 failed: ${notices.map((n) => n.kind).join(', ')}`);
});

test('C4: multitext.drawio produces zero degradation notices', async () => {
  const xml = await readFile(multitextDrawio, 'utf8');
  const { notices } = await bake(xml);
  assert.equal(notices.length, 0,
    `C4 failed: ${notices.map((n) => n.kind).join(', ')}`);
});

test('C4: multipage.drawio produces zero degradation notices', async () => {
  const xml = await readFile(multipageDrawio, 'utf8');
  const { notices } = await bake(xml);
  assert.equal(notices.length, 0,
    `C4 failed: ${notices.map((n) => n.kind).join(', ')}`);
});

const templateDrawio = join(here, '../../src/main/native-print-engine/tests/fixtures/labels/test.drawio');
test('C4: test.drawio produces zero degradation notices', async () => {
  const xml = await readFile(templateDrawio, 'utf8');
  const { notices } = await bake(xml);
  assert.equal(notices.length, 0,
    `C4 failed: ${notices.map((n) => `${n.kind}:${n.cellId || ''}:${n.detail && n.detail.detail || ''}`).join('; ')}`);
});

// C5: vocabulary coverage — connector, gradient, groups all produce non-empty output

test('C5: connector.drawio — path nodes from edge and vertices are non-empty', async () => {
  const xml = await readFile(connectorDrawio, 'utf8');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  assert.ok(paint.length > 0, 'C5: no paint nodes for connector.drawio');
  const paths = paint.filter((n) => n.kind === 'path');
  assert.ok(paths.length >= 2, `C5: expected ≥2 path nodes (2 boxes + edge), got ${paths.length}`);
  for (const p of paths) {
    assert.ok(p.d && p.d.trim().length > 1, `C5: path has trivially empty d`);
  }
});

test('C5: gradient.drawio — gradient cells produce svg nodes with linearGradient in mode B', async () => {
  const xml = await readFile(gradientDrawio, 'utf8');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  // In mode B, gradient-filled non-rotated cells emit kind:'svg' (direction encoded inline).
  const svgNodes = paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, `C5: expected ≥1 svg node for gradient shapes, got ${svgNodes.length}`);
  const hasGrad = svgNodes.some((n) => {
    const s = Buffer.from(n.source, 'base64').toString('utf8');
    return s.includes('linearGradient');
  });
  assert.ok(hasGrad, 'C5: expected at least one svg node to contain a linearGradient def');
});

test('C5: multipage.drawio — two pages each have paint nodes', async () => {
  const xml = await readFile(multipageDrawio, 'utf8');
  const { contract } = await bake(xml);
  assert.equal(contract.document.pages.length, 2, 'C5: expected 2 pages');
  for (const page of contract.document.pages) {
    assert.ok(page.paint.length > 0, `C5: page ${page.id} has no paint nodes`);
  }
});

test('C5: multitext.drawio — all text nodes have non-zero-area boxes', async () => {
  const xml = await readFile(multitextDrawio, 'utf8');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  const texts = paint.filter((n) => n.kind === 'text' || n.kind === 'svg');
  assert.ok(texts.length >= 4, `C5: expected ≥4 text nodes, got ${texts.length}`);
  for (const t of texts) {
    assert.ok(t.box && t.box.w > 0 && t.box.h > 0,
      `C5: text node has zero-area box: ${JSON.stringify(t.box)}`);
  }
});

// --- Master WYSIWYG test (all supported shapes, all features, rotations) ---

const masterTestDrawio = join(fixtureDir, 'master-test.drawio');
const masterTestGolden = join(fixtureDir, 'master-test.contract.golden.json');

// Lazy-import compare so wysiwyg-compare.mjs is only loaded when these tests run.
async function runWysiwygCompare(xml) {
  const { compare } = await import('./wysiwyg-compare.mjs');
  return compare(xml);
}

test('C1: bake output matches master-test.contract.golden.json', async () => {
  const xml    = await readFile(masterTestDrawio, 'utf8');
  const golden = JSON.parse(await readFile(masterTestGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden, 'master-test bake output diverged from golden');
});

test('WYSIWYG: master-test — all shapes, labels, gradients, dash, thick, rotation verified', async () => {
  const xml = await readFile(masterTestDrawio, 'utf8');
  const { checks, fail } = await runWysiwygCompare(xml);
  const failures = checks.filter((c) => !c.ok);
  assert.equal(fail, 0,
    `WYSIWYG failures:\n${failures.map((c) => `  ${c.name}: ${c.detail}`).join('\n')}`);
});

test('WYSIWYG: master-test — rotated shapes produce kind:svg nodes with rotate() transform', async () => {
  const xml = await readFile(masterTestDrawio, 'utf8');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  const svgNodes = paint.filter((n) => n.kind === 'svg');
  // Filter to only the svg nodes that carry a rotation (stencil shapes without rotation also produce kind:svg)
  const rotatedSvgNodes = svgNodes.filter((n) => {
    try { return /transform="rotate/.test(Buffer.from(n.source, 'base64').toString('utf8')); }
    catch { return false; }
  });
  assert.ok(rotatedSvgNodes.length >= 9, `expected ≥9 rotated svg nodes, got ${rotatedSvgNodes.length} (total svg: ${svgNodes.length})`);
  for (const n of svgNodes) {
    assert.ok(n.box && n.box.w > 0 && n.box.h > 0,
      `kind:svg node has non-positive box: ${JSON.stringify(n.box)}`);
  }
});

test('WYSIWYG: master-test — gradient shapes produce gradient fills in contract', async () => {
  const xml = await readFile(masterTestDrawio, 'utf8');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  // r13: gradient rect (unrotated → kind:path with linear fill)
  // r14: gradient ellipse (rotated 30° → kind:svg with linearGradient in SVG)
  const gradPaths = paint.filter((n) =>
    n.kind === 'path' && n.fill && (n.fill.type === 'linear' || n.fill.type === 'radial'));
  const gradSvgs  = paint.filter((n) => {
    if (n.kind !== 'svg') return false;
    try { return /linearGradient|radialGradient/.test(Buffer.from(n.source,'base64').toString('utf8')); }
    catch { return false; }
  });
  assert.ok(gradPaths.length + gradSvgs.length >= 2,
    `expected ≥2 gradient nodes (path+svg combined), got path=${gradPaths.length} svg=${gradSvgs.length}`);
});

test('WYSIWYG: master-test — dashed rotated shape embeds stroke-dasharray in SVG', async () => {
  const xml = await readFile(masterTestDrawio, 'utf8');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  // r15 is dashed + rotated → kind:svg with stroke-dasharray
  const dashedSvg = paint.find((n) => {
    if (n.kind !== 'svg') return false;
    try { return /stroke-dasharray/.test(Buffer.from(n.source,'base64').toString('utf8')); }
    catch { return false; }
  });
  assert.ok(dashedSvg, 'expected a kind:svg node with stroke-dasharray for the dashed rotated shape');
});

test('WYSIWYG: master-test — only GradientDirectionApprox notice expected', async () => {
  const xml = await readFile(masterTestDrawio, 'utf8');
  const { notices } = await bake(xml);
  const unexpected = notices.filter((n) => n.kind !== 'GradientDirectionApprox');
  assert.equal(unexpected.length, 0,
    `unexpected notices: ${unexpected.map((n) => n.kind).join(', ')}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Stencil renderer tests (Phase 1)
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: make a simple drawio XML with one stencil-shape cell
function makeStencilXml(styleExtra, label = '') {
  return `<mxGraphModel pageWidth="300" pageHeight="200">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="${label}" style="${styleExtra}" parent="1">
        <mxGeometry x="50" y="50" width="120" height="100" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
}

test('stencil: variable-aspect flowchart shape bakes to kind:svg with no notice', async () => {
  const xml = makeStencilXml('shape=mxgraph.flowchart.start_1;fillColor=#dae8fc;strokeColor=#6c8ebf;', 'Start');
  const { contract, notices } = await bake(xml);
  const unsupported = notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
  assert.equal(unsupported.length, 0, `unexpected ExporterUnsupportedShape: ${unsupported.map(n => n.detail && n.detail.detail).join('; ')}`);
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, 'expected kind:svg node for stencil shape');
});

test('stencil: <fillcolor color="key" default="#hex"> resolves to the default color (not invisible)', async () => {
  // REGRESSION (WYSIWYG): the whole mxgraph.salesforce.* family paints via
  // `<fillcolor color="fillColor2" default="#032d60"/>` — a style-key reference
  // with a fallback `default`. The headless renderer previously stored the
  // literal key "fillColor2" as the fill color; isPaintable() rejected it and
  // every such path baked with fill="none", so the stencil printed INVISIBLE
  // with no notice (a silent C1 violation caught by the native-engine render
  // gate). mxStencil.parseColor/getColorValue fall back to the `default` attr.
  const xml = makeStencilXml('shape=mxgraph.salesforce.apps;fillColor=#dae8fc;strokeColor=#6c8ebf;', 'SF Apps');
  const { contract, notices } = await bake(xml);
  assert.equal(notices.length, 0, `unexpected notice: ${notices.map(n => n.kind).join('; ')}`);
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  const sources = svgNodes.map((n) => Buffer.from(n.source, 'base64').toString('utf8'));
  const joined = sources.join('\n');
  // The stencil's default fill colors must be present as real fills...
  assert.ok(/fill="#032d60"/i.test(joined), 'apps stencil must paint its default fillColor2 (#032d60)');
  assert.ok(/fill="#0d9dda"/i.test(joined), 'apps stencil must paint its default fillColor3 (#0d9dda)');
  // ...and the literal style-key string must NEVER leak into a paint attribute.
  assert.ok(!/fill="fillColor\d"/i.test(joined), 'style-key reference leaked as a literal fill color');
});

test('stencil: explicit <fillcolor color="#hex"> and unresolved-no-default keys are unchanged', async () => {
  // Guard against the resolver over-reaching: a concrete color passes through,
  // and a style-key with no `default` and no cell-style entry preserves prior
  // behaviour (no surprise paint invented).
  const concrete = '<shape name="c1" w="10" h="10"><background><path><move x="0" y="0"/><line x="10" y="0"/><line x="10" y="10"/><close/></path></background><foreground><fillcolor color="#123456"/><fillstroke/></foreground></shape>';
  const b64 = Buffer.from(concrete, 'utf8').toString('base64');
  const xml = makeStencilXml(`shape=stencil(${b64});fillColor=#dae8fc;strokeColor=#000000;`, 'C');
  const { contract } = await bake(xml);
  const src = (contract.document.pages[0].paint.find((n) => n.kind === 'svg')?.source) || '';
  assert.ok(/fill="#123456"/i.test(Buffer.from(src, 'base64').toString('utf8')),
    'concrete stencil fill color must pass through untouched');
});

test('stencil: default-attr color family renders across packages (whole bug class)', async () => {
  // Broad regression for the silent-invisible bug class: EVERY stencil whose
  // definition paints via `<fill|stroke|fontcolor … default="#hex">` (1100+
  // shapes: cisco, eip, salesforce, gmdl, gcp2, veeam, mscae, floorplan, …)
  // printed blank before resolveStencilColor(). The buggy code emitted
  // fill="none" (no key leak), so the precise signature is "the stencil's OWN
  // default colour is ABSENT from the bake". We sample across families and
  // assert each baked shape contains at least one of its own default colours.
  // String-level (no rasterizer) so it runs in the standard suite.
  const registry = await loadStencils(resolve(here, '../../src/main/webapp/stencils'));
  // Only collect defaults that WILL be used: a `default` is consulted only when
  // the color references a style key absent from the cell. We bake with the
  // standard fillColor/strokeColor set, so defaults keyed on those standard
  // names are legitimately shadowed by the cell value (and fontcolor defaults
  // never show with an empty label). Restrict to non-standard keys on
  // fill/stroke nodes — exactly the paths whose visibility depends on the fix.
  const STD_KEYS = new Set(['fillColor', 'strokeColor', 'fontColor', 'fill', 'stroke', 'font']);
  const defaultsOf = (node, acc = new Set()) => {
    if (!node) return acc;
    if (['fillcolor', 'strokecolor'].includes(node.name) && node.attrs &&
        /^#[0-9a-fA-F]{3,6}$/.test(node.attrs.default || '') &&
        node.attrs.color && !STD_KEYS.has(node.attrs.color)) {
      acc.add(node.attrs.default.toLowerCase());
    }
    for (const c of node.children || []) defaultsOf(c, acc);
    return acc;
  };
  const affected = [];
  for (const [key, node] of registry.entries()) {
    const defs = defaultsOf(node);
    if (defs.size) affected.push([key, [...defs]]);
  }
  assert.ok(affected.length >= 1000,
    `expected the full default-attr stencil class, found ${affected.length}`);

  // Sample evenly across the catalogue (caps bake count; keeps families mixed).
  const step = Math.ceil(affected.length / 80);
  const sample = affected.filter((_, i) => i % step === 0);
  const misses = [];
  for (const [key, defs] of sample) {
    const { contract, notices } = await bake(makeStencilXml(`shape=${key};fillColor=#dae8fc;strokeColor=#6c8ebf;`, ''), { keepPx: true });
    if (notices.length) continue; // a loud notice is not a silent blank — out of scope
    const joined = contract.document.pages[0].paint
      .filter((n) => n.kind === 'svg')
      .map((n) => Buffer.from(n.source, 'base64').toString('utf8').toLowerCase())
      .join('\n');
    if (!defs.some((d) => joined.includes('fill="' + d + '"') ||
                          joined.includes('stroke="' + d + '"'))) {
      misses.push(key);
    }
  }
  assert.deepEqual(misses, [],
    `stencils rendering WITHOUT any of their default colours (silent-invisible regression): ${misses.join(', ')}`);
});

test('stencil: fixed-aspect AWS shape bakes to kind:svg with no unsupported notice', async () => {
  // aws4 shapes use aspect="fixed" — tests computeAspect centering
  const xml = makeStencilXml('shape=mxgraph.aws4.lambda;fillColor=#232F3E;strokeColor=#ffffff;fontColor=#ffffff;', 'Lambda');
  const { contract, notices } = await bake(xml);
  const unsupported = notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
  assert.equal(unsupported.length, 0, `unexpected ExporterUnsupportedShape`);
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, 'expected kind:svg node for fixed-aspect stencil');
});

test('stencil: fixed-aspect centering — SVG geometry is bounded within cell box', async () => {
  // A fixed-aspect stencil with a simple 10×10 native size rendered into a 100×60 cell.
  // computeAspect: su = min(100/10, 60/10) = 6, ox = (100-10*6)/2 = 20, oy = (60-10*6)/2 = 0.
  // The shape rectangle at (0,0) 10×10 → rendered at (20,0) with size 60×60.
  // Verify: the SVG x coordinate of the first path point (M) includes the centering offset (ox=20).
  const stencilXml = '<shape name="fixtest" w="10" h="10" aspect="fixed"><background><path><move x="0" y="0"/><line x="10" y="0"/><line x="10" y="10"/><line x="0" y="10"/><close/></path></background><foreground><fillstroke/></foreground></shape>';
  const b64 = Buffer.from(stencilXml, 'utf8').toString('base64');
  // Cell 100×60 — fixed aspect with 10×10 native → su=min(10,6)=6, ox=20, oy=0
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="FixedAspect" style="shape=stencil(${b64});fillColor=#dae8fc;strokeColor=#6c8ebf;" parent="1">
      <mxGeometry x="50" y="50" width="100" height="60" as="geometry"/>
    </mxCell>
  </root></mxGraphModel>`;
  const { contract, notices } = await bake(xml);
  const unsupported = notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
  assert.equal(unsupported.length, 0, 'fixed-aspect inline stencil should not produce ExporterUnsupportedShape');
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, 'expected kind:svg for fixed-aspect stencil');
  // Decode SVG and verify the centering offset appears in the path data.
  // With ox=20 and su=6: first M point should be approximately "M 20 0" (ox + 0*6, oy + 0*6)
  const svgStr = Buffer.from(svgNodes[0].source, 'base64').toString('utf8');
  // The path should start with M near x=20 (centering offset), not M 0 0
  const mMatch = /M\s+([\d.]+)\s+([\d.]+)/.exec(svgStr);
  assert.ok(mMatch, 'SVG path should contain an M command');
  const mx = parseFloat(mMatch[1]);
  // With cell 100×60 native 10×10: su=min(10,6)=6, ox=(100-60)/2=20
  assert.ok(mx >= 18 && mx <= 22, `expected M x ≈ 20 (centering offset), got ${mx}`);
});

test('stencil: inline base64 stencil decodes and bakes to kind:svg', async () => {
  // A simple rectangle stencil encoded as base64
  // <shape name="test" w="100" h="100" aspect="variable">
  //   <background><path><move x="0" y="0"/><line x="100" y="0"/><line x="100" y="100"/><line x="0" y="100"/><close/></path></background>
  //   <foreground><fillstroke/></foreground>
  // </shape>
  const stencilXml = '<shape name="test" w="100" h="100" aspect="variable"><background><path><move x="0" y="0"/><line x="100" y="0"/><line x="100" y="100"/><line x="0" y="100"/><close/></path></background><foreground><fillstroke/></foreground></shape>';
  const b64 = Buffer.from(stencilXml, 'utf8').toString('base64');
  const xml = makeStencilXml(`shape=stencil(${b64});fillColor=#dae8fc;strokeColor=#6c8ebf;`, 'Inline');
  const { contract, notices } = await bake(xml);
  const unsupported = notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
  assert.equal(unsupported.length, 0, `unexpected ExporterUnsupportedShape: ${JSON.stringify(unsupported)}`);
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, 'expected kind:svg node for inline stencil');
  // Verify SVG content has geometry
  const svgStr = Buffer.from(svgNodes[0].source, 'base64').toString('utf8');
  assert.ok(/<svg/.test(svgStr), 'SVG node should contain SVG markup');
});

test('stencil: gradient fill produces linearGradient in SVG defs', async () => {
  const xml = makeStencilXml('shape=mxgraph.flowchart.process;fillColor=#dae8fc;gradientColor=#6c8ebf;strokeColor=#000000;', 'Gradient');
  const { contract, notices } = await bake(xml);
  // Find kind:svg nodes
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  const pathNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  // Gradient should appear in SVG source or path fill
  const hasGrad = svgNodes.some((n) => {
    try { return /linearGradient/.test(Buffer.from(n.source, 'base64').toString('utf8')); }
    catch { return false; }
  }) || pathNodes.some((n) => n.fill && (n.fill.type === 'linear' || n.fill.type === 'radial'));
  assert.ok(hasGrad, 'expected linearGradient in stencil SVG with gradientColor');
});

test('stencil: rotation produces SVG with rotate() transform', async () => {
  const xml = `<mxGraphModel pageWidth="300" pageHeight="200">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="Rotated" style="shape=mxgraph.flowchart.card;fillColor=#dae8fc;strokeColor=#6c8ebf;rotation=30;" parent="1">
        <mxGeometry x="50" y="50" width="120" height="100" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { contract, notices } = await bake(xml);
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, 'expected kind:svg for rotated stencil');
  const svgStr = Buffer.from(svgNodes[0].source, 'base64').toString('utf8');
  assert.ok(/rotate\(30/.test(svgStr), 'SVG should contain rotate(30 transform');
});

test('stencil: direction=north produces rotation transform', async () => {
  const xml = makeStencilXml('shape=mxgraph.flowchart.start_1;fillColor=#dae8fc;strokeColor=#6c8ebf;direction=north;', 'Dir N');
  const { contract, notices } = await bake(xml);
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, 'expected kind:svg for direction=north stencil');
  const svgStr = Buffer.from(svgNodes[0].source, 'base64').toString('utf8');
  assert.ok(/rotate/.test(svgStr), 'SVG should contain rotation transform for direction=north');
});

test('stencil: <image> with data URI src embeds inline (no notice)', async () => {
  // data: URI src is already embedded — should emit SVG <image> element, no notice.
  const stencilXml = '<shape name="imgtest" w="50" h="50" aspect="variable"><background><path><move x="0" y="0"/><line x="50" y="0"/><line x="50" y="50"/><line x="0" y="50"/><close/></path></background><foreground><image x="0" y="0" w="50" h="50" src="data:image/png;base64,abc"/><fillstroke/></foreground></shape>';
  const b64 = Buffer.from(stencilXml, 'utf8').toString('base64');
  const xml = makeStencilXml(`shape=stencil(${b64});fillColor=#dae8fc;`, '');
  const { contract, notices } = await bake(xml);
  const stencilNotices = notices.filter((n) => n.kind === 'ExporterUnsupportedStencilFeature');
  assert.ok(stencilNotices.length === 0, 'expected no notice for data-URI <image> in stencil');
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, 'expected kind:svg node for stencil with data-URI image');
});

test('stencil: external <image> URL resolves to inline artwork headlessly', async () => {
  const stencilXml = '<shape name="exturltest" w="50" h="50" aspect="variable"><foreground><image x="0" y="0" w="50" h="50" src="https://example.com/img.png"/><fillstroke/></foreground></shape>';
  const b64 = Buffer.from(stencilXml, 'utf8').toString('base64');
  const xml = makeStencilXml(`shape=stencil(${b64});fillColor=#dae8fc;`, '');
  const fakeFetch = async (url) => ({
    ok: url === 'https://example.com/img.png',
    blob: async () => new Blob([Buffer.from('pngbytes')], { type: 'image/png' }),
  });
  const { contract, notices } = await bake(xml, { fetchFn: fakeFetch });
  const stencilNotices = notices.filter((n) => n.kind === 'ExporterUnsupportedStencilFeature');
  assert.equal(stencilNotices.length, 0, 'resolved stencil artwork should not degrade');
  const svg = contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  assert.ok(svg, 'expected stencil SVG paint node');
  assert.match(Buffer.from(svg.source, 'base64').toString('utf8'),
    /<image href="data:image\/png;base64,cG5nYnl0ZXM="/,
    'stencil artwork should be embedded as an inline data URI');
});

test('stencil: unresolved external <image> URL stays loud', async () => {
  const stencilXml = '<shape name="exturltest" w="50" h="50" aspect="variable"><foreground><image x="0" y="0" w="50" h="50" src="https://example.com/missing.png"/><fillstroke/></foreground></shape>';
  const b64 = Buffer.from(stencilXml, 'utf8').toString('base64');
  const xml = makeStencilXml(`shape=stencil(${b64});fillColor=#dae8fc;`, '');
  const { notices } = await bake(xml, { fetchFn: async () => ({ ok: false }) });
  const stencilNotices = notices.filter((n) => n.kind === 'ExporterUnsupportedStencilFeature');
  assert.ok(stencilNotices.length >= 1, 'unresolved stencil artwork must remain loud');
  assert.match(stencilNotices[0].detail.detail, /unresolved external URL/);
});

test('stencil: <path rounded="1"> renders as Bezier path (no notice)', async () => {
  const stencilXml = '<shape name="roundtest" w="50" h="50" aspect="variable"><background><path rounded="1"><move x="0" y="0"/><line x="50" y="0"/><line x="50" y="50"/><close/></path></background><foreground><fillstroke/></foreground></shape>';
  const b64 = Buffer.from(stencilXml, 'utf8').toString('base64');
  const xml = makeStencilXml(`shape=stencil(${b64});fillColor=#dae8fc;`, '');
  const { contract, notices } = await bake(xml);
  const stencilNotices = notices.filter((n) => n.kind === 'ExporterUnsupportedStencilFeature');
  assert.ok(stencilNotices.length === 0, 'expected no notice for rounded="1" path');
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, 'expected kind:svg node for rounded stencil path');
  const svgStr = Buffer.from(svgNodes[0].source, 'base64').toString('utf8');
  // Bezier rounded path uses Q (quadratic) commands
  assert.ok(/Q /.test(svgStr), 'expected Q (quadratic Bezier) command in rounded path SVG');
});

test('stencil: built-in hexagon shape produces no ExporterUnsupportedShape notice', async () => {
  const xml = makeStencilXml('shape=hexagon;fillColor=#dae8fc;strokeColor=#6c8ebf;', 'Hex');
  const { notices } = await bake(xml);
  const unsupported = notices.filter((n) => n.kind === 'ExporterUnsupportedShape');
  assert.equal(unsupported.length, 0, 'hexagon should not produce ExporterUnsupportedShape');
});

test('stencil: label preserved on non-rotated stencil shape', async () => {
  const xml = makeStencilXml('shape=mxgraph.flowchart.process;fillColor=#dae8fc;strokeColor=#6c8ebf;', 'MyLabel');
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  const textNodes = paint.filter((n) => n.kind === 'text');
  const svgNodes = paint.filter((n) => n.kind === 'svg');
  // Label should appear in either text node or embedded in SVG
  const labelInText = textNodes.some((n) => n.content && n.content.lines && n.content.lines.some((l) => l.includes('MyLabel')));
  const labelInSvg = svgNodes.some((n) => {
    try { return /MyLabel/.test(Buffer.from(n.source, 'base64').toString('utf8')); }
    catch { return false; }
  });
  assert.ok(labelInText || labelInSvg, 'label "MyLabel" should appear in contract text or SVG nodes');
});

// ── C1 + C4 for stencil fixture files ─────────────────────────────────────

const stencilFixtures = [
  'master-test-flowchart',
  'master-test-arrows-bpmn',
  'master-test-aws',
  'master-test-network',
  'master-test-style-variants',
  'master-test-stencil-commands',
  'master-test-compound-styles',
];

for (const name of stencilFixtures) {
  const drawioPath  = join(fixtureDir, `${name}.drawio`);
  const goldenPath  = join(fixtureDir, `${name}.contract.golden.json`);
  test(`C1: bake output matches ${name}.contract.golden.json`, async () => {
    const xml    = await readFile(drawioPath, 'utf8');
    const golden = JSON.parse(await readFile(goldenPath, 'utf8'));
    const { contract } = await bake(xml);
    assert.deepEqual(contract, golden, `${name} bake output diverged from golden`);
  });
  test(`C4: ${name}.drawio produces zero degradation notices`, async () => {
    const xml = await readFile(drawioPath, 'utf8');
    const { notices } = await bake(xml);
    assert.equal(notices.length, 0,
      `C4 failed: ${notices.map((n) => n.kind).join(', ')}`);
  });
}

// ── master-test-html-labels and master-test-images (C1 + C4) ──────────────

const htmlLabelsDrawio = join(fixtureDir, 'master-test-html-labels.drawio');
const htmlLabelsGolden = join(fixtureDir, 'master-test-html-labels.contract.golden.json');
const imagesDrawio     = join(fixtureDir, 'master-test-images.drawio');
const imagesGolden     = join(fixtureDir, 'master-test-images.contract.golden.json');

test('C1: bake output matches master-test-html-labels.contract.golden.json', async () => {
  const xml    = await readFile(htmlLabelsDrawio, 'utf8');
  const golden = JSON.parse(await readFile(htmlLabelsGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden, 'html-labels bake output diverged from golden');
});

test('C4: master-test-html-labels.drawio produces zero degradation notices', async () => {
  const xml = await readFile(htmlLabelsDrawio, 'utf8');
  const { notices } = await bake(xml);
  assert.equal(notices.length, 0,
    `C4 failed: ${notices.map((n) => n.kind).join(', ')}`);
});

// ── master-test-rich-text: the FULL HTML rich-text vocabulary (C1 + C4) ─────
// sub/sup, ordered/unordered/nested lists, <hr>, tables (plain + bordered),
// links, highlight, mixed sizes, per-paragraph alignment, headings, deeply
// combined runs, blockquote, monospace/code, <mark>. Pins that every text
// configuration drawio's editor can emit bakes faithfully with NO notice.
const richTextDrawio = join(fixtureDir, 'master-test-rich-text.drawio');
const richTextGolden = join(fixtureDir, 'master-test-rich-text.contract.golden.json');

test('C1: bake output matches master-test-rich-text.contract.golden.json', async () => {
  const xml    = await readFile(richTextDrawio, 'utf8');
  const golden = JSON.parse(await readFile(richTextGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden, 'rich-text bake output diverged from golden');
});

test('C4: master-test-rich-text.drawio produces zero degradation notices', async () => {
  const xml = await readFile(richTextDrawio, 'utf8');
  const { notices } = await bake(xml);
  assert.equal(notices.length, 0,
    `C4 failed: ${notices.map((n) => n.kind).join(', ')}`);
});

test('C1: bake output matches master-test-images.contract.golden.json', async () => {
  const xml    = await readFile(imagesDrawio, 'utf8');
  const golden = JSON.parse(await readFile(imagesGolden, 'utf8'));
  const { contract } = await bake(xml);
  assert.deepEqual(contract, golden, 'images bake output diverged from golden');
});

test('C4: master-test-images.drawio produces zero degradation notices', async () => {
  const xml = await readFile(imagesDrawio, 'utf8');
  const { notices } = await bake(xml);
  assert.equal(notices.length, 0,
    `C4 failed: ${notices.map((n) => n.kind).join(', ')}`);
});

// GAP 3: labelPosition=right — text node x coordinate must exceed cell right edge
test('stencil: labelPosition=right places label node beyond cell right edge', async () => {
  // Cell at x=100, w=120: right edge = 220; with labelPosition=right the text box x should be >= 220
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" value="Right" style="shape=mxgraph.flowchart.process;fillColor=#dae8fc;strokeColor=#6c8ebf;labelPosition=right;align=left;" vertex="1" parent="1">
      <mxGeometry x="100" y="50" width="120" height="80" as="geometry"/>
    </mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  const textNodes = paint.filter((n) => (n.kind === 'text' || n.kind === 'svg') &&
    paintNodeText(n).includes('Right'));
  assert.ok(textNodes.length >= 1, 'expected at least one label node for labelPosition=right cell');
  // Cell right edge in px = 100 + 120 = 220; text box x should be at or beyond that
  const rightEdgePx = 100 + 120;
  const textBeyondRight = textNodes.some((n) => n.box && n.box.x >= rightEdgePx);
  assert.ok(textBeyondRight, 'label node x should be >= cell right edge (labelPosition=right)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Native-print TEXT FIDELITY audit: every HTML-label configuration drawio's
// rich-text editor can emit must bake faithfully (per-run colour/family/size/
// weight/italic/decoration/highlight, sub/sup, lists, <hr>, tables, links,
// paragraph alignment) with ZERO degradation notices and NO dropped text.
// These pin the headless production path (mode B) the broker actually runs.
// ─────────────────────────────────────────────────────────────────────────────
const escHtmlAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function bakeRichLabel(html, extraStyle = '', w = 240, h = 160) {
  const xml = `<mxGraphModel pageWidth="600" pageHeight="400"><root>` +
    `<mxCell id="0"/><mxCell id="1" parent="0"/>` +
    `<mxCell id="2" vertex="1" value="${escHtmlAttr(html)}" ` +
    `style="whiteSpace=wrap;html=1;fontSize=12;fontFamily=Arial;${extraStyle}" parent="1">` +
    `<mxGeometry x="20" y="20" width="${w}" height="${h}" as="geometry"/>` +
    `</mxCell></root></mxGraphModel>`;
  const { contract, notices } = await bake(xml);
  const node = contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  const svg = node ? Buffer.from(node.source, 'base64').toString('utf8') : '';
  return { svg, notices };
}
// All <text> elements with their attributes + content, for per-run assertions.
function richRuns(svg) {
  const out = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const attrs = m[1];
    const get = (k) => { const a = new RegExp(k + '="([^"]*)"').exec(attrs); return a ? a[1] : null; };
    out.push({
      text: m[2], x: parseFloat(get('x')), y: parseFloat(get('y')),
      size: parseFloat(get('font-size')), weight: get('font-weight'),
      style: get('font-style'), decoration: get('text-decoration'),
      fill: get('fill'), family: get('font-family')
    });
  }
  return out;
}
const findRun = (svg, txt) => richRuns(svg).find((r) => r.text === txt);

test('text fidelity: bold/italic/underline/strike each survive per-run', async () => {
  const { svg, notices } = await bakeRichLabel('<b>B</b> <i>I</i> <u>U</u> <s>S</s>');
  assert.equal(notices.length, 0, 'no notices for basic inline formatting');
  assert.equal(findRun(svg, 'B').weight, '700');
  assert.equal(findRun(svg, 'I').style, 'italic');
  assert.match(findRun(svg, 'U').decoration || '', /underline/);
  assert.match(findRun(svg, 'S').decoration || '', /line-through/);
});

test('text fidelity: per-run font colour is preserved (not the base colour)', async () => {
  const { svg, notices } = await bakeRichLabel('plain <font color="#ff0000">red</font> <font color="#00aa00">green</font>');
  assert.equal(notices.length, 0);
  assert.equal(findRun(svg, 'plain').fill, '#000000');
  assert.equal(findRun(svg, 'red').fill, '#ff0000');
  assert.equal(findRun(svg, 'green').fill, '#00aa00');
});

test('text fidelity: named CSS colours resolve', async () => {
  const { svg } = await bakeRichLabel('<font color="red">r</font> <span style="color:blue;">b</span>');
  assert.equal(findRun(svg, 'r').fill, '#ff0000');
  assert.equal(findRun(svg, 'b').fill, '#0000ff');
});

test('text fidelity: per-run font family and size are preserved', async () => {
  const { svg, notices } = await bakeRichLabel(
    '<font face="Times New Roman">T</font> <span style="font-size:20px;">big</span>');
  assert.equal(notices.length, 0);
  assert.match(findRun(svg, 'T').family, /Times New Roman/);
  assert.equal(findRun(svg, 'big').size, 20);
});

test('text fidelity: mixed runs on one line keep independent styling', async () => {
  const { svg } = await bakeRichLabel('<b>Bold</b> and <i>italic</i> mix');
  assert.equal(findRun(svg, 'Bold').weight, '700');
  assert.equal(findRun(svg, 'and').weight, '400');
  assert.equal(findRun(svg, 'italic').style, 'italic');
  assert.equal(findRun(svg, 'mix').style, null);
});

test('text fidelity: background-color highlight emits a backing rect, no notice', async () => {
  const { svg, notices } = await bakeRichLabel('<span style="background-color:#ffff00;">hi</span>');
  assert.equal(notices.length, 0);
  assert.match(svg, /<rect[^>]*fill="#ffff00"/);
  assert.ok(findRun(svg, 'hi'));
});

test('text fidelity: subscript and superscript shrink and shift, no notice', async () => {
  const { svg, notices } = await bakeRichLabel('x<sup>2</sup>+H<sub>2</sub>O');
  assert.equal(notices.length, 0, 'sub/sup must NOT raise RichUnsupported');
  const base = findRun(svg, 'x');
  const sup = findRun(svg, '2');               // first "2" is the superscript
  assert.ok(sup.size < base.size, 'superscript is smaller');
  assert.ok(sup.y < base.y, 'superscript sits above the baseline');
  const subs = richRuns(svg).filter((r) => r.text === '2');
  const sub = subs[subs.length - 1];           // the H2O subscript
  assert.ok(sub.y > base.y, 'subscript sits below the baseline');
});

test('text fidelity: unordered list renders bullets, no notice', async () => {
  const { svg, notices } = await bakeRichLabel('<ul><li>Apple</li><li>Pear</li></ul>');
  assert.equal(notices.length, 0);
  assert.ok(findRun(svg, 'Apple') && findRun(svg, 'Pear'));
  assert.equal(richRuns(svg).filter((r) => r.text === '•').length, 2, 'two bullets');
});

test('text fidelity: ordered list renders numbers, no notice', async () => {
  const { svg, notices } = await bakeRichLabel('<ol><li>One</li><li>Two</li><li>Three</li></ol>');
  assert.equal(notices.length, 0);
  assert.ok(findRun(svg, '1.') && findRun(svg, '2.') && findRun(svg, '3.'));
});

test('text fidelity: nested list indents deeper', async () => {
  const { svg } = await bakeRichLabel(
    '<ul><li>Top<ul><li>Child</li></ul></li></ul>', '', 320, 160);
  const top = findRun(svg, 'Top'), child = findRun(svg, 'Child');
  assert.ok(child.x > top.x, 'nested item indented further than its parent');
});

test('text fidelity: <hr> divider renders a line, no notice', async () => {
  const { svg, notices } = await bakeRichLabel('<p>Above</p><hr><p>Below</p>');
  assert.equal(notices.length, 0);
  assert.match(svg, /<line\b/);
  assert.ok(findRun(svg, 'Above') && findRun(svg, 'Below'));
});

test('text fidelity: table renders every cell, no notice', async () => {
  const { svg, notices } = await bakeRichLabel(
    '<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table>', '', 320, 160);
  assert.equal(notices.length, 0, 'tables must NOT raise RichUnsupported');
  ['A1', 'B1', 'A2', 'B2'].forEach((t) => assert.ok(findRun(svg, t), 'cell ' + t + ' present'));
  // Each cell's text sits inside a <g transform="translate(cx cy)">; the column/
  // row geometry lives in those translates. Collect the distinct x/y offsets.
  const tx = [...svg.matchAll(/translate\(([\d.]+) ([\d.]+)\)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
  const xs = [...new Set(tx.map((t) => t.x))].sort((a, b) => a - b);
  const ys = [...new Set(tx.map((t) => t.y))].sort((a, b) => a - b);
  assert.ok(xs.length >= 2 && xs[1] > xs[0], 'two columns at distinct x offsets');
  assert.ok(ys.length >= 2 && ys[1] > ys[0], 'two rows at distinct y offsets');
});

test('text fidelity: bordered table draws cell rects', async () => {
  const { svg } = await bakeRichLabel(
    '<table border="1"><tr><td>X</td></tr></table>', '', 200, 120);
  assert.match(svg, /<rect[^>]*fill="none"[^>]*stroke=/);
});

test('text fidelity: link text is preserved verbatim, no notice', async () => {
  const { svg, notices } = await bakeRichLabel('see <a href="https://x.test">site</a> now');
  assert.equal(notices.length, 0, 'a link must NOT raise a notice');
  assert.ok(findRun(svg, 'site'));
});

test('text fidelity: per-paragraph alignment is honoured', async () => {
  const { svg } = await bakeRichLabel(
    '<p style="text-align:left;">L</p><p style="text-align:right;">R</p>', '', 240, 160);
  const l = findRun(svg, 'L'), r = findRun(svg, 'R');
  assert.ok(r.x > l.x, 'right-aligned paragraph starts further right than left-aligned');
});

test('text fidelity: heading is larger than body text', async () => {
  const { svg } = await bakeRichLabel('<h1>Title</h1><p>body</p>');
  assert.ok(findRun(svg, 'Title').size > findRun(svg, 'body').size);
});

test('text fidelity: deeply combined run keeps every attribute, no notice', async () => {
  const { svg, notices } = await bakeRichLabel(
    '<b><i><u><font color="#123456" style="font-size:18px;">deep</font></u></i></b>');
  assert.equal(notices.length, 0);
  const r = findRun(svg, 'deep');
  assert.equal(r.weight, '700');
  assert.equal(r.style, 'italic');
  assert.match(r.decoration || '', /underline/);
  assert.equal(r.fill, '#123456');
  assert.equal(r.size, 18);
});

test('text fidelity: no text is silently dropped across a complex label', async () => {
  const { svg, notices } = await bakeRichLabel(
    '<p><b>Quarterly</b> report:</p><ul><li>Up 5%</li><li>Down 2%</li></ul>' +
    '<p>E=mc<sup>2</sup></p>', '', 360, 220);
  assert.equal(notices.length, 0);
  ['Quarterly', 'report:', 'Up', '5%', 'Down', '2%', 'E=mc', '2'].forEach((w) => {
    assert.ok(richRuns(svg).some((r) => r.text === w),
      'word "' + w + '" present in faithful output');
  });
});

test('text fidelity: nested unordered list cycles bullet style by depth', async () => {
  const { svg, notices } = await bakeRichLabel(
    '<ul><li>Top<ul><li>Inner</li></ul></li></ul>', 'align=left;', 320, 200);
  assert.equal(notices.length, 0);
  const top = findRun(svg, 'Top'), inner = findRun(svg, 'Inner');
  assert.ok(inner.x > top.x, 'nested item is indented further than its parent');
  // CSS default: depth-0 disc, depth-1 circle.
  assert.ok(richRuns(svg).some((r) => r.text === '•'), 'top level uses disc bullet');
  assert.ok(richRuns(svg).some((r) => r.text === '◦'), 'nested level uses circle bullet');
});

test('text fidelity: a tall inline image never overflows above the line top', async () => {
  // A 1x1 PNG sized to 80px tall — far taller than the 12px text ascent.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe' +
    'AAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const { svg, notices } = await bakeRichLabel(
    `text <img src="${png}" width="80" height="80"> more`, '', 320, 200);
  assert.equal(notices.length, 0, 'embeddable inline image raises no notice');
  const m = /<image\b[^>]*\by="(-?[\d.]+)"/.exec(svg);
  assert.ok(m, 'inline image is emitted');
  // y is relative to the content group's top; the image must sit at or below it,
  // never negative (which would overlap the line above).
  assert.ok(parseFloat(m[1]) >= 0, `image y must be >= 0, got ${m[1]}`);
});
