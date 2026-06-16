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
import { fixedConnectionPoint } from './mx-edge-router.mjs';
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

test('pxContractToUm: merge shrinkFloorPx and rich indentPx are scaled', () => {
  const px = {
    schema: { major: 1, minor: 0 },
    document: { units: 'px', pages: [{ id: 'p1', size: { w: 200, h: 100 }, tiles: [{ origin: { x: 0, y: 0 }, size: { w: 200, h: 100 } }],
      paint: [
        { kind: 'text', box: { x: 0, y: 0, w: 100, h: 50 },
          font: { family: 'Arial', sizePx: 12, weight: 400, italic: false, color: '#000000' },
          align: { h: 'left', v: 'top' },
          content: { type: 'merge', key: 'k', sample: 's', maxLen: 10,
            wrap: 'word', overflow: 'shrink', shrinkFloorPx: 6 } },
        { kind: 'text', box: { x: 0, y: 0, w: 100, h: 50 },
          font: { family: 'Arial', sizePx: 12, weight: 400, italic: false, color: '#000000' },
          align: { h: 'left', v: 'top' },
          content: { type: 'rich', paragraphs: [{ align: 'left', indentPx: 24,
            runs: [{ text: 'x', fontFamily: 'Arial', sizePx: 12, weight: 400,
              italic: false, underline: false, strikethrough: false,
              color: '#000000' }] }] } }
      ] }] }
  };
  const um = pxContractToUm(px);
  const [mergeNode, richNode] = um.document.pages[0].paint;
  // 6 px * (25400/96) = 1587.5 um
  assert.equal(mergeNode.content.shrinkFloorPx, 1587.5);
  // 24 px * (25400/96) = 6350 um
  assert.equal(richNode.content.paragraphs[0].indentPx, 6350);
  // non-merge/non-rich inputs untouched: original objects not mutated
  assert.equal(px.document.pages[0].paint[0].content.shrinkFloorPx, 6);
  assert.equal(px.document.pages[0].paint[1].content.paragraphs[0].indentPx, 24);
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

test('bake: HTML label foreignObject is flattened to native SVG, not passed to C++ engine', async () => {
  const foreignHtml = `&lt;svg width=&quot;120&quot; height=&quot;50&quot;&gt;` +
    `&lt;foreignObject x=&quot;8&quot; y=&quot;6&quot; width=&quot;96&quot; height=&quot;32&quot;&gt;` +
    `&lt;div xmlns=&quot;http://www.w3.org/1999/xhtml&quot; style=&quot;font-size:14px;color:#ff0000;background-color:#ffffcc;&quot;&gt;` +
    `&lt;b&gt;Foreign&lt;/b&gt; HTML&lt;/div&gt;` +
    `&lt;/foreignObject&gt;&lt;/svg&gt;`;
  const xml = `<mxGraphModel pageWidth="220" pageHeight="120">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="${foreignHtml}" style="shape=html;html=1;whiteSpace=wrap;fillColor=none;strokeColor=none;fontFamily=Arial;fontSize=12;" parent="1">
        <mxGeometry x="10" y="10" width="140" height="70" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const { contract, notices } = await bake(xml);
  assert.equal(notices.length, 0);
  const svgNode = contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  assert.ok(svgNode, 'foreignObject HTML emits native svg paint');
  const decoded = Buffer.from(svgNode.source, 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /foreignObject/i,
    'raw foreignObject never reaches the C++/resvg print engine');
  assert.match(decoded, /transform="translate\(8 6\)"/,
    'foreignObject x/y placement is preserved');
  assert.match(decoded, /width="96" height="32"/,
    'foreignObject width/height clipping is preserved');
  assert.match(decoded, /fill="#ffffcc"/,
    'foreignObject HTML background color is preserved');
  assert.match(decoded, /fill="#ff0000"[^>]*>Foreign</,
    'foreignObject HTML text color is preserved');
  assert.match(decoded, /font-weight="700"[^>]*>Foreign</,
    'foreignObject bold run is preserved');
  assert.match(decoded, />HTML</, 'foreignObject plain text is preserved');
});

test('bake: flattened foreignObject output is deterministic across repeated exports', async () => {
  const foreignHtml = `&lt;foreignObject x=&quot;0&quot; y=&quot;0&quot; width=&quot;80&quot; height=&quot;24&quot;&gt;` +
    `&lt;div xmlns=&quot;http://www.w3.org/1999/xhtml&quot;&gt;&lt;b&gt;Stable&lt;/b&gt;&lt;/div&gt;` +
    `&lt;/foreignObject&gt;`;
  const xml = `<mxGraphModel pageWidth="120" pageHeight="80">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="${foreignHtml}" style="shape=html;html=1;whiteSpace=wrap;fillColor=none;strokeColor=none;fontFamily=Arial;fontSize=12;" parent="1">
        <mxGeometry x="10" y="10" width="90" height="40" as="geometry"/>
      </mxCell>
    </root>
  </mxGraphModel>`;
  const a = await bake(xml, { keepPx: true });
  const b = await bake(xml, { keepPx: true });
  assert.deepEqual(a.notices, []);
  assert.deepEqual(b.notices, []);
  assert.deepEqual(b.contract, a.contract,
    'generated foreignObject clip ids must reset per contract');
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
  // DOCUMENT ordinal, not selection index: notices' pageId must point at
  // the real document page (selecting [1] = the file's second page).
  assert.equal(contract.document.pages[0].id, 'page-2');
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

test('edge: default connector renders its classic arrowhead (no silent drop on degenerate points)', async () => {
  // REGRESSION (WYSIWYG): a default edge gets endArrow='classic'. The headless
  // parser emits a doubled endpoint for vertex-connected edges (verified:
  // connector.drawio's edge absolutePoints == [{80,75},{80,75},{220,75},{220,75}]);
  // the final segment is then zero-length, arrowPath() returns null and the
  // arrowhead was SILENTLY dropped — the print showed a plain line while drawio
  // draws the arrow. emitEdge now dedupes consecutive points. Uses the real
  // connector fixture, which is known to reproduce the degenerate-point case.
  const xml = await readFile(join(fixtureDir, 'connector.drawio'), 'utf8');
  const { contract, notices } = await bake(xml, { keepPx: true });
  assert.equal(notices.length, 0, `unexpected notice: ${notices.map((n) => n.kind).join('; ')}`);
  const paint = contract.document.pages[0].paint;
  // a classic arrowhead is a closed, filled triangle with a notched back
  // (tip + 2 wing points + back notch = 3 L commands, mxMarker.js:74-84)
  const arrows = paint.filter((n) => n.kind === 'path' && n.fill &&
    /^M [\d.]+ [\d.]+( L [\d.]+ [\d.]+){3} Z$/.test(n.d || ''));
  assert.ok(arrows.length >= 1, 'default edge must emit a filled classic arrowhead path');
  // and the connector line itself must have no zero-length duplicate segment
  const edge = paint.find((n) => n.kind === 'path' && n.fill == null && /^M [\d.]+ [\d.]+ L/.test(n.d || ''));
  assert.ok(edge, 'edge connector line present');
  assert.ok(!/L ([\d.]+) ([\d.]+) L \1 \2/.test(edge.d), `edge path has a degenerate duplicate point: ${edge.d}`);
});

test('edge: arrowhead types render faithfully or are loudly noticed (no silent triangle)', async () => {
  // REGRESSION (C1): the headless re-derivation drew EVERY non-open marker as a
  // classic triangle with no notice — diamond/oval/circle/box/ER/etc. silently
  // wrong. Now common markers render with their own geometry (incl. the ER
  // crow's-foot family, dash and cross as faithful stroked paths), and the
  // genuinely unsupported ones (async half-arrow, circlePlus glyph, halfCircle
  // quad-curve) raise a loud notice instead of a silent substitution.
  const mk = (end) => `<mxGraphModel pageWidth="400" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="20" y="60" width="60" height="40" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="280" y="60" width="60" height="40" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" source="a" target="b" style="endArrow=${end};" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const markerOf = (contract) => {
    // The end-arrow marker is the LAST path node emitted (after the vertex
    // shapes and the connector line); these edges have no label/start-arrow.
    const paths = contract.document.pages[0].paint.filter((n) => n.kind === 'path');
    return paths[paths.length - 1];
  };
  const segs = (d) => (d.match(/ L /g) || []).length;

  // Faithful, no notice. drawio default endFill is FILLED for every marker
  // type (mxConnector.js:112-113, undefined != 0), so circle/oval/box fill.
  for (const [type, check] of [
    ['diamond', (m) => segs(m.d) === 3 && /Z$/.test(m.d) && m.fill],          // rhombus, filled
    ['oval',    (m) => /A /.test(m.d) && m.fill],                              // filled circle
    ['circle',  (m) => /A /.test(m.d) && m.fill && m.stroke],                 // filled circle (Shapes.js circleMarker)
    ['box',     (m) => segs(m.d) === 3 && /Z$/.test(m.d) && m.fill],          // square, filled
    ['open',    (m) => segs(m.d) === 2 && !/Z$/.test(m.d) && !m.fill],        // open V
    ['dash',    (m) => segs(m.d) === 1 && !/Z$/.test(m.d) && !m.fill && m.stroke], // 1 stroke
    ['cross',   (m) => segs(m.d) === 1 && !m.fill && m.stroke],               // last of 2 strokes
    ['ERone',   (m) => segs(m.d) === 1 && !m.fill && m.stroke],               // 1 perpendicular stroke
    ['ERmany',  (m) => segs(m.d) === 2 && !/Z$/.test(m.d) && !m.fill && m.stroke], // crow's foot
    ['halfCircle', (m) => /C /.test(m.d) && !m.fill && m.stroke],             // two quadratics (as exact cubics)
    ['async',   (m) => segs(m.d) === 2 && /Z$/.test(m.d) && m.fill],          // half arrowhead
  ]) {
    const { contract, notices } = await bake(mk(type), { keepPx: true });
    assert.equal(notices.length, 0, `${type}: unexpected notice ${notices.map((n) => n.kind).join(',')}`);
    const m = markerOf(contract);
    assert.ok(m && check(m), `${type}: marker geometry not faithful (d=${m && m.d})`);
  }

  // Unsupported/unregistered -> loud notice (never silent):
  for (const type of ['manyOptional']) {
    const { notices } = await bake(mk(type), { keepPx: true });
    assert.ok(notices.some((n) => n.kind === 'ExporterUnsupportedShape'),
      `${type}: must raise a loud notice rather than silently substitute`);
  }
});

test('label: non-HTML labels render literal angle brackets (drawio isHtmlLabel parity)', async () => {
  // REGRESSION (WYSIWYG): the rich-vs-plain choice keyed on the presence of '<'
  // instead of drawio's Graph.isHtmlLabel (style html==1 || whiteSpace==wrap).
  // So a NON-HTML label like "List<String>" was HTML-parsed and "<String>" was
  // SILENTLY dropped (rendered "List"); drawio shows it verbatim. HTML labels
  // (html=1 or wrap) legitimately interpret the tag (drawio does too).
  const mk = (val, style) => `<mxGraphModel pageWidth="400" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="${val}" style="${style}" parent="1"><mxGeometry x="10" y="10" width="360" height="80" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const shownText = (contract) => {
    let out = '';
    for (const n of contract.document.pages[0].paint) {
      if (n.kind !== 'svg') continue;
      const s = Buffer.from(n.source, 'base64').toString('utf8');
      for (const m of s.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)) out += m[1];
    }
    return out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  };
  // Non-HTML: literal angle brackets survive.
  for (const style of ['text;html=0;', 'rounded=0;', 'rounded=0;html=0;']) {
    const { contract } = await bake(mk('List&lt;String&gt;', style), { keepPx: true });
    assert.match(shownText(contract), /List<String>/, `non-HTML label lost literal markup (style=${style})`);
  }
  // Non-HTML ampersand renders literally too.
  assert.match(shownText((await bake(mk('Tom &amp; Jerry', 'rounded=0;'), { keepPx: true })).contract),
    /Tom & Jerry/, 'non-HTML ampersand not literal');
  // HTML label (html=1 or whiteSpace=wrap) interprets the tag — same as drawio.
  for (const style of ['rounded=0;html=1;', 'rounded=0;whiteSpace=wrap;']) {
    const shown = shownText((await bake(mk('List&lt;String&gt;', style), { keepPx: true })).contract);
    assert.doesNotMatch(shown, /List<String>/, `HTML label should interpret the tag (style=${style})`);
    assert.match(shown, /List/, `HTML label kept surrounding text (style=${style})`);
  }
});

test('label: plain shape honors labelPosition / verticalLabelPosition (label outside shape)', async () => {
  // REGRESSION (WYSIWYG): the plain-shape label path placed the label on the
  // shape box, ignoring labelPosition (left/right) and verticalLabelPosition
  // (top/bottom) — so an external label silently painted over the shape.
  // Stencils/icons already handled this; plain geometric shapes did not.
  const mk = (style) => `<mxGraphModel pageWidth="600" pageHeight="400"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="LBL" style="${style}" parent="1"><mxGeometry x="250" y="180" width="80" height="50" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  // The bake anchors each page by its own INK extent (an outside label
  // shifts the whole content), so label and shape must be compared WITHIN
  // one bake: shape box = the rect path node's first M point + extent.
  const boxes = (contract) => {
    let label = null;
    let shape = null;
    for (const n of contract.document.pages[0].paint) {
      if (n.kind === 'svg' && /LBL/.test(Buffer.from(n.source, 'base64').toString('utf8'))) label = n.box;
      if (n.kind === 'path' && /^M /.test(n.d || '')) {
        const nums = (n.d.match(/[-+]?\d*\.?\d+/g) || []).map(Number);
        const xs = nums.filter((_, i) => i % 2 === 0);
        const ys = nums.filter((_, i) => i % 2 === 1);
        shape = { x: Math.min(...xs), y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      }
    }
    return { label, shape };
  };
  const right = boxes((await bake(mk('rounded=0;labelPosition=right;align=left;'), { keepPx: true })).contract);
  assert.ok(right.label && right.shape && right.label.x >= right.shape.x + right.shape.w - 0.5,
    `labelPosition=right not outside shape (x=${right.label && right.label.x}, shapeRight=${right.shape && (right.shape.x + right.shape.w)})`);
  const left = boxes((await bake(mk('rounded=0;labelPosition=left;align=right;'), { keepPx: true })).contract);
  assert.ok(left.label && left.shape && left.label.x + left.label.w <= left.shape.x + 0.5,
    `labelPosition=left not outside shape (labelRight=${left.label && (left.label.x + left.label.w)}, shapeX=${left.shape && left.shape.x})`);
  const bottom = boxes((await bake(mk('rounded=0;verticalLabelPosition=bottom;verticalAlign=top;'), { keepPx: true })).contract);
  assert.ok(bottom.label && bottom.shape && bottom.label.y >= bottom.shape.y + bottom.shape.h - 0.5,
    `verticalLabelPosition=bottom not below shape (y=${bottom.label && bottom.label.y})`);
  const top = boxes((await bake(mk('rounded=0;verticalLabelPosition=top;verticalAlign=bottom;'), { keepPx: true })).contract);
  assert.ok(top.label && top.shape && top.label.y + top.label.h <= top.shape.y + 0.5,
    `verticalLabelPosition=top not above shape (labelBottom=${top.label && (top.label.y + top.label.h)}, shapeY=${top.shape && top.shape.y})`);
});

test('edge: child-label cells (multi-label edges) are positioned along the edge', async () => {
  // REGRESSION (WYSIWYG): a label cell parented to an edge (UML multiplicity,
  // ER cardinality) has relative geometry x in [-1,1] mapped to a fraction
  // t=(x+1)/2 along the edge. The bake treated it as a standalone vertex,
  // baking a degenerate 1x1 box at the wrong spot — the label was silently lost
  // (clipped). Now positioned along the parent edge.
  const xml = `<mxGraphModel pageWidth="400" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="20" y="80" width="60" height="40" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="300" y="80" width="60" height="40" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="lbl1" value="ONE" vertex="1" connectable="0" parent="e"><mxGeometry x="-0.7" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry></mxCell>
    <mxCell id="lbl2" value="MANY" vertex="1" connectable="0" parent="e"><mxGeometry x="0.7" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry></mxCell>
  </root></mxGraphModel>`;
  const { contract, notices } = await bake(xml, { keepPx: true });
  assert.equal(notices.length, 0, `unexpected notice: ${notices.map((n) => n.kind).join('; ')}`);
  const find = (txt) => {
    for (const n of contract.document.pages[0].paint) {
      if (n.kind === 'svg' && new RegExp('>' + txt + '<').test(Buffer.from(n.source, 'base64').toString('utf8'))) return n.box;
    }
    return null;
  };
  const one = find('ONE'), many = find('MANY');
  assert.ok(one && many, 'both edge child-labels must render');
  // Non-degenerate boxes (not the old 1x1), and ONE is left of MANY along the edge.
  assert.ok(one.w > 2 && one.h > 2, `ONE label box degenerate: ${JSON.stringify(one)}`);
  assert.ok(many.w > 2 && many.h > 2, `MANY label box degenerate: ${JSON.stringify(many)}`);
  assert.ok(many.x > one.x + 20, `labels not distributed along the edge (one.x=${one.x}, many.x=${many.x})`);
});

test('shape: rounded rectangle radius matches drawio (arcSize / absoluteArcSize)', async () => {
  // REGRESSION (WYSIWYG): rounded-rect corner radius was hardcoded
  // 0.12*min(w,h) and ignored arcSize / absoluteArcSize. drawio uses
  // f=arcSize/100 (default RECTANGLE_ROUNDING_FACTOR*100=15) → r=min(w,h)*f, or
  // absolute mode r=min(w/2,h/2,arcSize/2) (arcSize default LINE_ARCSIZE=20).
  const mk = (style) => `<mxGraphModel pageWidth="200" pageHeight="120"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="${style}fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const radiusOf = (contract) => {
    for (const n of contract.document.pages[0].paint) {
      if (n.kind === 'path' && /A /.test(n.d || '')) {
        const m = n.d.match(/A ([\d.]+)/); if (m) return parseFloat(m[1]);
      }
    }
    return null;
  };
  // box 120x60 -> default 0.15*60=9, arcSize=20 -> 0.20*60=12, absolute as=20 -> min(60,30,10)=10
  assert.equal(radiusOf((await bake(mk('rounded=1;'), { keepPx: true })).contract), 9, 'default radius should be 15% of min side');
  assert.equal(radiusOf((await bake(mk('rounded=1;arcSize=20;'), { keepPx: true })).contract), 12, 'arcSize=20 not honored');
  assert.equal(radiusOf((await bake(mk('rounded=1;absoluteArcSize=1;arcSize=20;'), { keepPx: true })).contract), 10, 'absoluteArcSize not honored');
});

test('shape: dash pattern scales with stroke width (drawio createDashPattern)', async () => {
  // REGRESSION (WYSIWYG): dash values were emitted unscaled, so a thick dashed
  // stroke printed near-solid. drawio multiplies each dash value by the stroke
  // width (unless fixDash=1).
  const mk = (style) => `<mxGraphModel pageWidth="200" pageHeight="120"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="${style}" parent="1"><mxGeometry x="20" y="20" width="100" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const dashOf = (contract) => {
    for (const n of contract.document.pages[0].paint) if (n.kind === 'path' && n.stroke) return n.stroke.dash;
    return null;
  };
  assert.deepEqual(dashOf((await bake(mk('rounded=0;dashed=1;strokeWidth=1;'), { keepPx: true })).contract), [3, 3]);
  assert.deepEqual(dashOf((await bake(mk('rounded=0;dashed=1;strokeWidth=4;'), { keepPx: true })).contract), [12, 12]);
  assert.deepEqual(dashOf((await bake(mk('rounded=0;dashed=1;strokeWidth=4;dashPattern=8 4;'), { keepPx: true })).contract), [32, 16]);
  assert.deepEqual(dashOf((await bake(mk('rounded=0;dashed=1;strokeWidth=4;fixDash=1;'), { keepPx: true })).contract), [3, 3]);
});

test('label: spacing / spacingLeft / spacingTop inset the label (drawio mxText)', async () => {
  // REGRESSION (WYSIWYG): the label renderer used a flat pad=2 and ignored
  // spacing / spacingLeft / spacingTop / etc. drawio insets the label by
  // spacing (default 2) + the per-side spacing (default 0). A label with
  // spacingLeft=52 printed flush-left instead of indented.
  const mk = (style) => `<mxGraphModel pageWidth="200" pageHeight="150"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="T" style="${style}" parent="1"><mxGeometry x="20" y="20" width="120" height="80" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const textPos = (contract) => {
    for (const n of contract.document.pages[0].paint) {
      if (n.kind !== 'svg') continue;
      const s = Buffer.from(n.source, 'base64').toString('utf8');
      const m = s.match(/<text\b[^>]*\bx="([0-9.]+)"[^>]*\by="([0-9.]+)"/);
      if (m && />T</.test(s)) return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
    }
    return null;
  };
  const base = textPos((await bake(mk('rounded=0;align=left;verticalAlign=top;'), { keepPx: true })).contract);
  assert.ok(base && Math.abs(base.x - 2) < 0.01 && Math.abs(base.y - 2) < 0.01, `default inset should be 2/2, got ${JSON.stringify(base)}`);
  const sl = textPos((await bake(mk('rounded=0;align=left;verticalAlign=top;spacingLeft=20;'), { keepPx: true })).contract);
  assert.ok(sl && Math.abs(sl.x - 22) < 0.01, `spacingLeft=20 -> x should be 22, got ${sl && sl.x}`);
  const st = textPos((await bake(mk('rounded=0;align=left;verticalAlign=top;spacingTop=15;'), { keepPx: true })).contract);
  assert.ok(st && Math.abs(st.y - 17) < 0.01, `spacingTop=15 -> y should be 17, got ${st && st.y}`);
});

test('label: plain label honors letterSpacing', async () => {
  // REGRESSION: the rich path applied letterSpacing but the plain (non-HTML)
  // text path dropped it, so a plain label with letterSpacing printed with
  // default spacing.
  const mk = (ls) => `<mxGraphModel pageWidth="200" pageHeight="120"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="SPACED" style="rounded=0;letterSpacing=${ls};" parent="1"><mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const svgText = (contract) => {
    for (const n of contract.document.pages[0].paint) {
      if (n.kind === 'svg') { const s = Buffer.from(n.source, 'base64').toString('utf8'); if (/SPACED/.test(s)) return s; }
    }
    return '';
  };
  assert.doesNotMatch(svgText((await bake(mk('0'), { keepPx: true })).contract), /letter-spacing/);
  assert.match(svgText((await bake(mk('5'), { keepPx: true })).contract), /letter-spacing="5"/);
});

test('shape: shadow matches drawio (#000000, opacity 0.25, offset 2,3)', async () => {
  // REGRESSION (WYSIWYG): the bake drew shadows as black@0.18 offset (4,4),
  // then as the LIBRARY defaults #808080@1. The APP overrides them
  // (Graph.js:161-162): SHADOWCOLOR #000000 at SHADOW_OPACITY 0.25, offset
  // (SHADOW_OFFSET_X=2, SHADOW_OFFSET_Y=3), with per-cell overrides.
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="rounded=0;fillColor=#ffffff;shadow=1;" parent="1"><mxGeometry x="40" y="40" width="100" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const shadow = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && n.fill && n.fill.color === '#000000' && n.fill.alpha === 0.25);
  assert.ok(shadow, 'shadow path should use the app shadow ink #000000 @ 0.25');
  // shadow offset (2,3): the silhouette path starts at the offset, not (4,4).
  assert.match(shadow.d, /^M 2 3 /, `shadow offset should be (2,3): ${shadow.d.slice(0, 20)}`);
});

test('shape: glass=1 renders the glass highlight overlay (not silently dropped)', async () => {
  // REGRESSION (WYSIWYG): drawio's glass effect (a white top highlight with a
  // 0.9->0.1 alpha gradient) was dropped silently. Now emitted as an overlay.
  const glass = `<mxGraphModel pageWidth="200" pageHeight="120"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="rounded=0;glass=1;fillColor=#0000ff;" parent="1"><mxGeometry x="20" y="20" width="100" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const plain = glass.replace('glass=1;', '');
  const { contract: gc } = await bake(glass, { keepPx: true });
  const { contract: pc } = await bake(plain, { keepPx: true });
  const overlay = (c) => c.document.pages[0].paint.some(
    (n) => n.kind === 'svg' && /glassg/.test(Buffer.from(n.source, 'base64').toString('utf8')));
  assert.ok(overlay(gc), 'glass=1 must emit a glass highlight overlay');
  assert.ok(!overlay(pc), 'a non-glass shape must not emit a glass overlay');
});

test('shape: flipH / flipV mirror built-in path shapes (not just stencils)', async () => {
  // REGRESSION (WYSIWYG): flipH/flipV were honored for stencils but IGNORED for
  // built-in shapePath shapes (triangle, parallelogram, ...), so a flipped
  // triangle printed un-flipped. The geometry is now mirrored about the box
  // centre (the label stays upright, matching drawio).
  const mk = (style) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="${style}fillColor=#f00;" parent="1"><mxGeometry x="20" y="20" width="100" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const pathD = (contract) => {
    const n = contract.document.pages[0].paint.find((x) => x.kind === 'path');
    return n && n.d;
  };
  // drawio default triangle points EAST (apex at right, mid-height); flipH must
  // move the apex to the left. flipped geometry is mirrored about the box centre.
  const norm = pathD((await bake(mk('triangle;'), { keepPx: true })).contract);
  const flh = pathD((await bake(mk('triangle;flipH=1;'), { keepPx: true })).contract);
  assert.match(norm, /L 100 30 /, 'east triangle apex at right (x=100,y=30)');
  assert.match(flh, /L 0 30 /, 'flipH triangle apex must move to left (x=0,y=30)');
  // parallelogram flipH must mirror horizontally (differs from unflipped).
  const pn = pathD((await bake(mk('shape=parallelogram;'), { keepPx: true })).contract);
  const pf = pathD((await bake(mk('shape=parallelogram;flipH=1;'), { keepPx: true })).contract);
  assert.notEqual(pn, pf, 'parallelogram flipH must change the geometry');
  // rotation + flip: the flip must STILL be applied (not silently dropped) and
  // the label must stay upright. The flip is baked into the rotated path
  // (flipPathD), so the rotated SVG differs from rotation-only.
  const mkLbl = (style) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" value="T" vertex="1" style="${style}fillColor=#f00;" parent="1"><mxGeometry x="80" y="60" width="100" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const svgSrc = async (style) => {
    const n = (await bake(mkLbl(style), { keepPx: true })).contract.document.pages[0].paint.find((x) => x.kind === 'svg');
    return n ? n.source : '';
  };
  const rotOnly = await svgSrc('shape=parallelogram;rotation=30;');
  const rotFlip = await svgSrc('shape=parallelogram;rotation=30;flipH=1;');
  assert.notEqual(rotOnly, rotFlip, 'rotation+flip must apply the flip (not silently dropped)');
  const s = Buffer.from(rotFlip, 'base64').toString('utf8');
  assert.match(s, /<path/, 'shape path still rendered');
  assert.match(s, /<text/, 'label still rendered (not mirrored away)');
});

test('image: cell opacity is applied (frozen contract has no image opacity field)', async () => {
  // REGRESSION (WYSIWYG): a translucent image cell (style opacity<100) printed
  // fully opaque because kind:image has no opacity field. Now routed through an
  // svg <image opacity> when opacity<1; a fully-opaque image stays kind:image.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR42mNk+M9Qz0BkYBxVSF+FAP5FCB3+aV1nAAAAAElFTkSuQmCC';
  const mk = (op) => `<mxGraphModel pageWidth="200" pageHeight="120"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=image;image=data:image/png;base64,${png};opacity=${op};" parent="1"><mxGeometry x="20" y="20" width="60" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const paint100 = (await bake(mk('100'), { keepPx: true })).contract.document.pages[0].paint;
  assert.ok(paint100.some((n) => n.kind === 'image'), 'opaque image stays kind:image');
  const paint50 = (await bake(mk('50'), { keepPx: true })).contract.document.pages[0].paint;
  const svg = paint50.find((n) => n.kind === 'svg');
  assert.ok(svg, 'translucent image routes through svg');
  assert.match(Buffer.from(svg.source, 'base64').toString('utf8'), /opacity="0\.5"/, 'image opacity 0.5 applied');
});

test('edge: rounded corner radius is arcSize/2 = 10 (drawio mxPolyline)', async () => {
  // REGRESSION: edge bend rounding used a hardcoded radius 8; drawio rounds with
  // (style.arcSize || LINE_ARCSIZE=20)/2 = 10 by default (every rounded edge).
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" parent="1"><mxGeometry x="20" y="20" width="60" height="40" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" parent="1"><mxGeometry x="300" y="220" width="60" height="40" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" source="a" target="b" style="rounded=1;" parent="1"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="200" y="40"/><mxPoint x="200" y="240"/></Array></mxGeometry></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.find((n) => n.kind === 'path' && n.fill == null && /C/.test(n.d || ''));
  assert.ok(edge, 'rounded edge present with curve');
  // First bend at x=180: the straight segment ends 10px before it (L ...170...),
  // not 8px (172), and the corner is the EXACT cubic elevation of drawio's
  // quadTo (controls at a + 2/3(corner - a)), not a control-at-corner bulge.
  assert.match(edge.d, /L 170 20 C 176\.667 20 180 23\.333 180 30/,
    `edge corner must be the elevated quad: ${edge.d.slice(0, 50)}`);
});

test('edge: perimeterSpacing creates a gap between shape and connector', async () => {
  // REGRESSION (WYSIWYG): perimeterSpacing (+ source/targetPerimeterSpacing)
  // was ignored, so the connector touched the shape instead of leaving the gap
  // drawio draws.
  const mk = (ps) => `<mxGraphModel pageWidth="400" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" parent="1"><mxGeometry x="20" y="80" width="60" height="40" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" parent="1"><mxGeometry x="300" y="80" width="60" height="40" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" source="a" target="b" style="perimeterSpacing=${ps};" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const ends = (contract) => {
    const e = contract.document.pages[0].paint.find((n) => n.kind === 'path' && n.fill == null && n.stroke);
    const m = e.d.match(/^M ([\d.]+) [\d.]+ L ([\d.]+) /);
    return { x0: parseFloat(m[1]), x1: parseFloat(m[2]) };
  };
  const e0 = ends((await bake(mk('0'), { keepPx: true })).contract);
  const e20 = ends((await bake(mk('20'), { keepPx: true })).contract);
  assert.ok(Math.abs((e20.x0 - e0.x0) - 20) < 0.01, `source endpoint should pull in by 20: ${e0.x0}->${e20.x0}`);
  assert.ok(Math.abs((e0.x1 - e20.x1) - 20) < 0.01, `target endpoint should pull in by 20: ${e0.x1}->${e20.x1}`);
});

test('shape: cylinder cap height = min(40, round(h/5)) + drawio control points (mxCylinder)', async () => {
  // REGRESSION: cylinder cap was min(0.18h, 0.28w) (width-dependent, wrong
  // proportion), then drawn with a circle-bezier (k=0.5522) that made the caps
  // far too shallow. drawio mxCylinder.redrawPath: cap e = min(maxHeight=40,
  // round(h/5)); top rim control = -e/3 (arcs ABOVE the box top), bottom
  // control = h+e/3, front lid control = 2e. 200x100 -> e = min(40, 20) = 20.
  // The faithful top rim bulges above y=0, so the ink-extent anchor shifts the
  // whole path down by the overhang — assert the cap e from the geometry, not
  // the absolute origin.
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=cylinder;fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="200" height="100" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const cyl = contract.document.pages[0].paint.find((n) => n.kind === 'path' && /C/.test(n.d || ''));
  assert.ok(cyl, 'cylinder path present');
  // d = "M 0 <topY> C 0 <topCtrl> ..."; e = topY - topCtrl scaled: topY = y+e,
  // topCtrl = y - e/3, so (topY - topCtrl) = e + e/3 = (4/3)e.
  const m = cyl.d.match(/^M 0 ([\d.]+) C 0 (-?[\d.]+)/);
  assert.ok(m, `unexpected cylinder path: ${cyl.d.slice(0, 40)}`);
  const e = (parseFloat(m[1]) - parseFloat(m[2])) * 3 / 4;
  assert.ok(Math.abs(e - 20) < 0.01, `cylinder cap e should be 20, got ${e}`);
  // front lid control sits 2e below the cap line (downward-bulging ellipse).
  assert.match(cyl.d, /C 0 44\.167 200 44\.167 200 24\.167$/, `lid control = 2e: ${cyl.d.slice(-40)}`);
});

test('shape: size proportion matches drawio (parallelogram/step/card + size/fixedSize)', async () => {
  // REGRESSION (WYSIWYG): built-in shape slant/notch sizes were hardcoded
  // (parallelogram/trapezoid 0.25w, step 0.22w, card min(0.18w,0.35h)) and
  // ignored the size/fixedSize style. drawio: relative w*(size||0.2) or absolute
  // min(w,size) under fixedSize; card = min(w,h,size||30).
  const mk = (style) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="${style}fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="100" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const d = async (style) => {
    const c = (await bake(mk(style), { keepPx: true })).contract;
    return c.document.pages[0].paint.find((n) => n.kind === 'path').d;
  };
  assert.equal(await d('shape=parallelogram;'), 'M 20 0 L 100 0 L 80 60 L 0 60 Z'); // 0.2*100=20
  assert.equal(await d('shape=parallelogram;size=0.4;'), 'M 40 0 L 100 0 L 60 60 L 0 60 Z'); // honors size
  assert.match(await d('shape=parallelogram;size=10;fixedSize=1;'), /^M 10 0 /); // absolute
  assert.match(await d('shape=step;'), /^M 0 0 L 80 0 L 100 30 /); // notch 0.2*100=20 -> 80
  assert.match(await d('shape=card;'), /^M 0 0 L 70 0 L 100 30 /); // corner min(100,60,30)=30 -> 70
});

test('shape: flowchart document/dataStorage/manualInput/loopLimit match drawio geometry', async () => {
  // REGRESSION (WYSIWYG): these flowchart shapes had wrong size proportions and,
  // for dataStorage (was a parallelogram, should be a curved D) and loopLimit
  // (was a pentagon peak, should be a cut-corner hexagon), the WRONG geometry.
  const mk = (sh) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=${sh};fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="120" height="80" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const d = async (sh) => (await bake(mk(sh), { keepPx: true })).contract.document.pages[0].paint.find((n) => n.kind === 'path').d;
  // document: bottom wave uses quadratics, dy = 0.3*80 = 24.
  assert.equal(((await d('document')).match(/ C /g) || []).length, 2, 'document should have two bottom-wave cubic curves (Q->C)');
  // dataStorage: D-shape -> both right and left edges are quadratics (curved).
  const ds = await d('dataStorage');
  assert.ok((ds.match(/ C /g) || []).length === 2, `dataStorage must be a curved D-shape: ${ds}`);
  // manualInput: top slopes from (0,s) to (w,0); s = min(80,30)=30.
  assert.match(await d('manualInput'), /^M 0 80 L 0 30 L 120 0 L 120 80 Z/);
  // loopLimit: cut-corner hexagon, s = min(60,80,20)=20; 6 vertices.
  const ll = await d('loopLimit');
  assert.match(ll, /^M 20 0 L 100 0 L 120 16 /, `loopLimit must be a cut-corner hexagon: ${ll}`);
});

test('shape: tape/display/internalStorage match drawio geometry', async () => {
  // REGRESSION (WYSIWYG): tape wave was 0.12h (drawio 0.4h, quadratic waves);
  // display used one cubic (drawio two quadratics through w,h/2);
  // internalStorage divider lines were at 10 (drawio dx/dy=20).
  const mk = (sh) => `<mxGraphModel pageWidth="300" pageHeight="160"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=${sh};fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="120" height="80" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const d = async (sh) => (await bake(mk(sh), { keepPx: true })).contract.document.pages[0].paint.find((n) => n.kind === 'path').d;
  // tape: four quadratic waves total (2 top + 2 bottom).
  assert.equal(((await d('tape')).match(/ C /g) || []).length, 4, 'tape should have 4 wave cubics (Q->C)');
  // display: two quadratics on the right edge.
  assert.equal(((await d('display')).match(/ C /g) || []).length, 2, 'display should have 2 right-edge cubics (Q->C)');
  // internalStorage is now a builtin multi-paint svg node (rounded-capable):
  // rect background + stroke-only dividers, horizontal at dy=20 then vertical
  // at dx=20 (drawio InternalStorageShape.paintForeground order).
  const isNode = (await bake(mk('internalStorage'), { keepPx: true }))
    .contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  const isSvg = Buffer.from(isNode.source, 'base64').toString('utf8');
  assert.match(isSvg, /<rect x="0" y="0" width="120" height="80"/, 'internalStorage rect background');
  assert.match(isSvg, /M 0 20 L 120 20 M 20 0 L 20 80/, 'internalStorage dividers at 20');
});

test('shape: cube/delay/offPageConnector match drawio geometry', async () => {
  // REGRESSION (WYSIWYG): cube had the 3D depth in the WRONG direction
  // (top-left vs drawio top-right); delay used one cubic (drawio two
  // quadratics); offPageConnector shoulder was 0.65h (drawio h - 0.375h).
  const mk = (sh) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=${sh};fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="100" height="80" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const d = async (sh) => (await bake(mk(sh), { keepPx: true })).contract.document.pages[0].paint.find((n) => n.kind === 'path').d;
  // cube: outline starts at (0,0) and cuts the TOP-RIGHT corner (w-s,0)->(w,s); s=20.
  assert.match(await d('cube'), /^M 0 0 L 80 0 L 100 20 /, 'cube depth must be top-right');
  // delay: two right-edge quadratics.
  assert.equal(((await d('delay')).match(/ C /g) || []).length, 2, 'delay should have 2 right-edge cubics (Q->C)');
  // offPage: shoulder at h - 0.375h = 80 - 30 = 50.
  assert.match(await d('offPageConnector'), /L 100 50 L 50 80 L 0 50 Z/, 'offPage shoulder at h-0.375h=50');
});

test('shape: cross honors size attr; datastore top cap matches drawio', async () => {
  // REGRESSION: cross ignored the size style (default 0.2 was correct);
  // datastore top-cap control point was 0 (drawio -dy/3).
  const mk = (st) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="${st}fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="100" height="100" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const d = async (st) => (await bake(mk(st), { keepPx: true })).contract.document.pages[0].paint.find((n) => n.kind === 'path').d;
  assert.match(await d('shape=cross;'), /^M 0 40 L 40 40 /, 'cross default arms at 0.2*min=20 (t=40)');
  assert.match(await d('shape=cross;size=0.5;'), /^M 0 25 L 25 25 /, 'cross size=0.5 -> arms at 25');
  assert.match(await d('shape=datastore;'), /C 0 -[\d.]+ 100 -[\d.]+ 100 /, 'datastore top cap control = -dy/3');
});

test('visibility: hidden layers and hidden cells do not print', async () => {
  // REGRESSION (WYSIWYG): content on a visible="0" layer (or a visible="0"
  // cell) was printed. drawio renders only visible cells whose ancestors are
  // all visible.
  const xml = `<mxGraphModel pageWidth="300" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="L2" visible="0" parent="0"/>
    <mxCell id="v1" value="Visible" vertex="1" style="" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="h1" value="OnHiddenLayer" vertex="1" style="" parent="L2"><mxGeometry x="20" y="100" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="h2" value="HiddenCell" visible="0" vertex="1" style="" parent="1"><mxGeometry x="120" y="20" width="80" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const all = contract.document.pages[0].paint
    .filter((n) => n.kind === 'svg')
    .map((n) => Buffer.from(n.source, 'base64').toString('utf8')).join('');
  assert.match(all, /Visible/, 'visible cell must print');
  assert.doesNotMatch(all, /OnHiddenLayer/, 'cell on a hidden layer must NOT print');
  assert.doesNotMatch(all, /HiddenCell/, 'a hidden cell must NOT print');
});

test('page: background colour prints behind content (white/none skipped)', async () => {
  // REGRESSION (WYSIWYG): a page background colour (File > Page Setup) was not
  // printed. Now emitted as a full-page rect behind all content; white/none
  // are skipped (paper is already white).
  const mk = (bg) => `<mxGraphModel pageWidth="200" pageHeight="120" background="${bg}"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const first = async (bg) => (await bake(mk(bg), { keepPx: true })).contract.document.pages[0].paint[0];
  const c = await first('#ffeecc');
  assert.ok(c.kind === 'path' && c.fill && c.fill.color === '#ffeecc' && /^M 0 0 L 200 0/.test(c.d),
    'colored background must be a full-page rect first');
  const n = await first('none');
  assert.ok(!(n.kind === 'path' && n.fill && /^M 0 0 L 200 0/.test(n.d)), 'background=none -> no bg rect');
  const wh = await first('#ffffff');
  assert.ok(!(wh.kind === 'path' && wh.fill && wh.fill.color === '#ffffff' && /^M 0 0 L 200 0/.test(wh.d)),
    'white background -> no bg rect (paper already white)');
});

test('parser: object/UserObject-wrapped cells render (id+label on the wrapper)', async () => {
  // REGRESSION (WYSIWYG): drawio wraps cells with metadata in
  // <object id=.. label=..><mxCell .../></object> (or <UserObject>); the inner
  // mxCell has no id, so the bake dropped the cell entirely. Now flattened.
  const xml = `<mxGraphModel pageWidth="300" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <object label="Wrapped &amp; Co" customAttr="x" id="2"><mxCell vertex="1" style="rounded=0;" parent="1"><mxGeometry x="20" y="20" width="120" height="40" as="geometry"/></mxCell></object>
    <UserObject label="UserObj" id="3"><mxCell vertex="1" style="ellipse;" parent="1"><mxGeometry x="20" y="100" width="120" height="40" as="geometry"/></mxCell></UserObject>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const all = contract.document.pages[0].paint
    .filter((n) => n.kind === 'svg')
    .map((n) => Buffer.from(n.source, 'base64').toString('utf8')).join('');
  assert.match(all, /Wrapped &amp; Co/, 'object-wrapped cell label must render (entity preserved)');
  assert.match(all, /UserObj/, 'UserObject-wrapped cell label must render');
  // both shapes present (a rect path + an ellipse svg).
  assert.ok(contract.document.pages[0].paint.length >= 4, 'both wrapped shapes + labels present');
});

test('engine-compat: every stroke/fill is a well-formed contract descriptor', async () => {
  // REGRESSION (PRODUCTION/C1): a swimlane with separatorColor assigned a bare
  // paint object {type,color,alpha} to a node's stroke field (which requires a
  // stroke DESCRIPTOR {paint,width,...}). bake emitted zero notices but the C++
  // engine loader rejected the contract (stroke.paint missing), hard-failing the
  // whole page with no warning. This structural invariant catches that class of
  // bug browser-free over feature-rich diagrams.
  const isPaint = (p) => p && typeof p === 'object' &&
    (p.type === 'solid' || p.type === 'linear' || p.type === 'radial') &&
    (p.type !== 'solid' || (typeof p.color === 'string' && typeof p.alpha === 'number'));
  // Mirror the C++ engine loader's requirements exactly: stroke.paint present,
  // width > 0 (require_positive), miterLimit > 0, cap/join from the enum, dash
  // null-or-array. (The engine rejects width<=0, so 'number' is not enough.)
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwAEhgGAhqmM1QAAAABJRU5ErkJggg==';
  const isStroke = (s) => s === null || (s && typeof s === 'object' &&
    isPaint(s.paint) && typeof s.width === 'number' && s.width > 0 &&
    ['butt', 'round', 'square'].includes(s.cap) && ['miter', 'round', 'bevel'].includes(s.join) &&
    typeof s.miterLimit === 'number' && s.miterLimit > 0 && (s.dash === null || Array.isArray(s.dash)));
  const isFill = (f) => f === null || isPaint(f);
  const diagrams = [
    'swimlane;fillColor=#dae8fc;strokeColor=#6c8ebf;separatorColor=#ff0000;',
    'swimlane;fillColor=#dae8fc;swimlaneFillColor=#ffffcc;swimlaneLine=0;horizontal=0;',
    'swimlane;fillColor=#fff;gradientColor=#f00;strokeColor=#000;',
    'swimlane;fillColor=#dae8fc;strokeColor=#000;separatorColor=#f00;strokeWidth=0;',
    'shape=image;image=data:image/png;base64,' + PNG + ';imageBackground=#ffffcc;imageBorder=#ff0000;',
    'shape=image;image=data:image/png;base64,' + PNG + ';imageBackground=#ffffcc;imageBorder=#ff0000;strokeWidth=0;',
    'rounded=1;fillColor=#fff;strokeColor=#000;direction=north;strokeWidth=0;',
    'shape=parallelogram;fillColor=#fff;gradientColor=#f00;direction=south;'
  ];
  const offenders = [];
  for (const st of diagrams) {
    const xml = `<mxGraphModel pageWidth="400" pageHeight="300"><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="L" style="${st}" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
    </root></mxGraphModel>`;
    const { contract } = await bake(xml, { keepPx: true });
    for (const n of contract.document.pages[0].paint) {
      if (n.kind === 'path') {
        if (!isStroke(n.stroke)) offenders.push(`${st} -> bad stroke ${JSON.stringify(n.stroke)}`);
        if (!isFill(n.fill)) offenders.push(`${st} -> bad fill ${JSON.stringify(n.fill)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `paint nodes with malformed stroke/fill (engine would reject): ${offenders.join('; ')}`);
});

test('engine-compat: kind:path nodes use only engine-supported commands (no Q/S/T)', async () => {
  // REGRESSION (PRODUCTION): the C++ engine path parser accepts only absolute
  // M/L/H/V/C/A/Z. A kind:"path" node containing Q (quadratic) — or S/T — is
  // rejected with "unsupported SVG path command", so the shape fails to PRINT
  // even though resvg (the render gate) handles it. Every shapePath shape must
  // emit engine-parseable path data (Q is converted to exact cubic C).
  const shapes = ['dataStorage', 'document', 'tape', 'delay', 'display', 'cylinder',
    'datastore', 'card', 'cube', 'cloud', 'callout', 'note', 'umlActor', 'actor'];
  const offenders = [];
  for (const sh of shapes) {
    const xml = `<mxGraphModel pageWidth="300" pageHeight="200"><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="2" vertex="1" value="L" style="shape=${sh};fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="120" height="80" as="geometry"/></mxCell>
    </root></mxGraphModel>`;
    const { contract } = await bake(xml, { keepPx: true });
    for (const n of contract.document.pages[0].paint) {
      if (n.kind === 'path' && /[QSTqst]/.test(n.d || '')) offenders.push(`${sh}: ${n.d.slice(0, 50)}`);
    }
  }
  assert.deepEqual(offenders, [],
    `kind:path nodes with engine-unsupported commands (would fail to print): ${offenders.join('; ')}`);
});

test('edge: entityRelationEdgeStyle routes with horizontal exit/entry (not a straight diagonal)', async () => {
  // REGRESSION (WYSIWYG): entity-relation edges (common in ER diagrams) routed
  // as a straight diagonal — only orthogonal/elbow were routed. drawio's
  // mxEdgeStyle.EntityRelation exits/enters horizontally from the side centres.
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" parent="1"><mxGeometry x="280" y="220" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" source="a" target="b" style="edgeStyle=entityRelationEdgeStyle;endArrow=classic;rounded=0;" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.find((n) => n.kind === 'path' && n.fill == null && n.stroke);
  // > 2 vertices (not a straight line) and a horizontal first segment from the
  // source's right side (y constant: exit horizontally).
  const verts = edge.d.match(/[ML] [\d.]+ [\d.]+/g) || [];
  assert.ok(verts.length >= 3, `ER edge must be routed (not straight): ${edge.d}`);
  assert.match(edge.d, /^M 80 20 L 1[01]\d 20/, `ER edge must exit horizontally (y constant): ${edge.d.slice(0, 30)}`);
});

test('edge: segmentEdgeStyle routes orthogonally; isometric is loudly noticed', async () => {
  // segmentEdgeStyle (no waypoints) routes orthogonally like orthogonalEdgeStyle
  // (was straight). isometricEdgeStyle is not replicated headless -> must be a
  // LOUD notice, never a silent straight route (C1).
  const mk = (es) => `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" parent="1"><mxGeometry x="280" y="220" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" source="a" target="b" style="edgeStyle=${es};rounded=0;" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const seg = await bake(mk('segmentEdgeStyle'), { keepPx: true });
  const segEdge = seg.contract.document.pages[0].paint.find((n) => n.kind === 'path' && n.fill == null);
  assert.ok((segEdge.d.match(/[ML] /g) || []).length >= 3, 'segmentEdgeStyle must route orthogonally');
  assert.equal(seg.notices.length, 0, 'segmentEdgeStyle is faithfully routed (no notice)');
  const iso = await bake(mk('isometricEdgeStyle'), { keepPx: true });
  assert.ok(iso.notices.some((n) => n.kind === 'ExporterUnsupportedShape'),
    'isometric edge routing must be loudly noticed (never silent)');
});

test('edge: self-loop (source==target) renders a loop (not silently dropped)', async () => {
  // REGRESSION (WYSIWYG): a self-loop edge collapsed to one point and was
  // dropped entirely. drawio (mxEdgeStyle.Loop) routes a small loop off the
  // shape side.
  const xml = `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" value="S" vertex="1" parent="1"><mxGeometry x="100" y="100" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="e" value="loop" edge="1" source="a" target="a" style="endArrow=classic;rounded=0;" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.find((n) => n.kind === 'path' && n.fill == null && n.stroke);
  assert.ok(edge, 'self-loop must render an edge line (was dropped)');
  assert.ok((edge.d.match(/[ML] /g) || []).length >= 4, `self-loop must be a multi-segment loop: ${edge.d}`);
  // and the loop label + an arrowhead are present.
  const all = contract.document.pages[0].paint;
  assert.ok(all.some((n) => n.kind === 'svg' && /loop/.test(Buffer.from(n.source, 'base64').toString('utf8'))), 'loop label present');
  assert.ok(all.some((n) => n.kind === 'path' && n.fill && /Z$/.test(n.d || '')), 'arrowhead present');
});

test('visibility: a collapsed container hides its descendants (renders itself)', async () => {
  // REGRESSION (WYSIWYG): children of a collapsed="1" container still printed.
  // drawio renders the collapsed shape but hides its descendants.
  const mk = (collapsed) => `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="g" value="Folded" vertex="1" ${collapsed}style="swimlane;" parent="1"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="c" value="Child" vertex="1" style="rounded=0;" parent="g"><mxGeometry x="20" y="40" width="60" height="30" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const labels = (contract) => contract.document.pages[0].paint
    .filter((n) => n.kind === 'svg').map((n) => Buffer.from(n.source, 'base64').toString('utf8')).join('');
  const collapsed = labels((await bake(mk('collapsed="1" '), { keepPx: true })).contract);
  assert.match(collapsed, /Folded/, 'collapsed container itself renders');
  assert.doesNotMatch(collapsed, /Child/, 'descendant of a collapsed container must NOT render');
  const expanded = labels((await bake(mk(''), { keepPx: true })).contract);
  assert.match(expanded, /Child/, 'expanded container shows its child');
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
  // mxStencil.js:664-721 semantics: rounding requires arcSize (absent → 0 =
  // no rounding) and ONLY move/line children — segments auto-close when the
  // first and last points coincide (an explicit <close/> would make drawio
  // parse the path regularly, i.e. UNROUNDED).
  const stencilXml = '<shape name="roundtest" w="50" h="50" aspect="variable"><background><path rounded="1" arcSize="8"><move x="0" y="0"/><line x="50" y="0"/><line x="50" y="50"/><line x="0" y="0"/></path></background><foreground><fillstroke/></foreground></shape>';
  const b64 = Buffer.from(stencilXml, 'utf8').toString('base64');
  const xml = makeStencilXml(`shape=stencil(${b64});fillColor=#dae8fc;`, '');
  const { contract, notices } = await bake(xml);
  const stencilNotices = notices.filter((n) => n.kind === 'ExporterUnsupportedStencilFeature');
  assert.ok(stencilNotices.length === 0, 'expected no notice for rounded="1" path');
  const svgNodes = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.ok(svgNodes.length >= 1, 'expected kind:svg node for rounded stencil path');
  const svgStr = Buffer.from(svgNodes[0].source, 'base64').toString('utf8');
  // Bezier rounded path uses Q (quadratic) commands and the auto-close Z
  assert.ok(/Q /.test(svgStr), 'expected Q (quadratic Bezier) command in rounded path SVG');
  assert.ok(/Z/.test(svgStr), 'expected auto-closed segment (first==last point)');
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

// ─── audit3: label/text renderer fixes (entities, UA margins, nbsp, h5/h6) ──

test('audit3: shim decodes "&amp;lt;" to the literal "&lt;" once (decode &amp; LAST)', async () => {
  const { svg, notices } = await bakeRichLabel('<b>x &amp;lt; y</b>');
  assert.equal(notices.length, 0);
  // one decode: the run text is the 4-char "&lt;", re-escaped in the SVG
  assert.ok(richRuns(svg).some((r) => r.text === '&amp;lt;'),
    'literal "&lt;" survives (no double decode to "<")');
});

test('audit3: astral numeric reference (emoji) survives the rich path', async () => {
  const { svg, notices } = await bakeRichLabel('<b>&#128512;</b>');
  assert.equal(notices.length, 0);
  assert.ok(svg.includes('\u{1F600}'), 'U+1F600 preserved (fromCodePoint, not fromCharCode)');
});

test('audit3: &nbsp; is U+00A0 — does not collapse and is NOT a wrap opportunity', async () => {
  // width 40 forces "aaaa bbbb" onto two rows…
  const sp = await bakeRichLabel('<b>aaaa bbbb</b>', '', 40, 160);
  const spRuns = richRuns(sp.svg);
  assert.ok(new Set(spRuns.map((r) => r.y)).size >= 2, 'plain space wraps');
  // …but the &nbsp; variant must stay one unbreakable run
  const nb = await bakeRichLabel('<b>aaaa&nbsp;bbbb</b>', '', 40, 160);
  const nbRuns = richRuns(nb.svg);
  assert.equal(nbRuns.length, 1, 'nbsp keeps the words in one run');
  assert.equal(nbRuns[0].text, 'aaaa bbbb', 'U+00A0 preserved in the run text');
});

test('audit3: h5/h6 are SMALLER than the base size (UA 0.83em/0.67em, no floor)', async () => {
  const { svg, notices } = await bakeRichLabel('<h5>five</h5><h6>six</h6><p>body</p>', '', 240, 220);
  assert.equal(notices.length, 0);
  const body = findRun(svg, 'body');
  assert.ok(Math.abs(findRun(svg, 'five').size - 0.83 * 12) < 0.01, 'h5 = 0.83em');
  assert.ok(Math.abs(findRun(svg, 'six').size - 0.67 * 12) < 0.01, 'h6 = 0.67em');
  assert.ok(findRun(svg, 'five').size < body.size && findRun(svg, 'six').size < body.size,
    'h5/h6 shrink below the base size');
});

test('audit3: UA <p> margins — adjacent paragraphs collapse to one 1em gap', async () => {
  const { svg, notices } = await bakeRichLabel('<p>one</p><p>two</p>', '', 240, 200);
  assert.equal(notices.length, 0);
  const d = findRun(svg, 'two').y - findRun(svg, 'one').y;
  // lineH 14.4 + collapsed max(12,12) margin = 26.4
  assert.ok(Math.abs(d - 26.4) < 0.01, `1em collapsed margin between <p> (gap ${d})`);
});

test('audit3: inline margin:0 override wins over the UA <p> margin (drawio templates)', async () => {
  const { svg } = await bakeRichLabel(
    '<p style="margin: 0px;">one</p><p style="margin: 0px;">two</p>', '', 240, 200);
  const d = findRun(svg, 'two').y - findRun(svg, 'one').y;
  assert.ok(Math.abs(d - 14.4) < 0.01, `margin:0 paragraphs stay flush (gap ${d})`);
});

test('audit3: <div> line containers have NO UA margin (drawio default lines)', async () => {
  const { svg } = await bakeRichLabel('<div>one</div><div>two</div>', '', 240, 200);
  const d = findRun(svg, 'two').y - findRun(svg, 'one').y;
  assert.ok(Math.abs(d - 14.4) < 0.01, `div lines stay flush (gap ${d})`);
});

test('audit3: heading UA margins use the HEADING’s em (h2 bottom = 0.83em of 18px)', async () => {
  const { svg } = await bakeRichLabel('<h2>T</h2><p>b</p>', '', 240, 220);
  const d = findRun(svg, 'b').y - findRun(svg, 'T').y;
  // h2 line box: ascent 16.56, lineH 21.6; gap = max(h2 mb 0.83*18=14.94, p mt 12)
  // baseline delta = (21.6 - 16.56) + 14.94 + 0.92*12 = 31.02
  assert.ok(Math.abs(d - 31.02) < 0.05, `h2 margin-bottom in h2 em (delta ${d})`);
});

test('audit3: lists indent by the UA 40px padding-left and carry 1em vertical margins', async () => {
  const { svg, notices } = await bakeRichLabel('<p>x</p><ul><li>item</li></ul>', 'align=left;', 320, 220);
  assert.equal(notices.length, 0);
  const bullet = richRuns(svg).find((r) => r.text === '•');
  assert.ok(bullet, 'bullet emitted');
  assert.ok(Math.abs(bullet.x - 40) < 0.01, `list padding-left = 40px (got ${bullet.x})`);
  const d = bullet.y - findRun(svg, 'x').y;
  // collapsed max(p mb 12, ul mt 12) = 12 + lineH 14.4
  assert.ok(Math.abs(d - 26.4) < 0.01, `ul top margin 1em collapsed (gap ${d})`);
});

test('audit3: blockquote indents 40px with 1em vertical margins', async () => {
  const { svg } = await bakeRichLabel('<blockquote>q</blockquote>', 'align=left;', 240, 200);
  const q = findRun(svg, 'q');
  assert.ok(Math.abs(q.x - 40) < 0.01, `blockquote margin-left 40px (got ${q.x})`);
});

test('audit3: middle HTML label taller than its box grows the viewport UPWARD', async () => {
  const xml = `<mxGraphModel pageWidth="600" pageHeight="400"><root>` +
    `<mxCell id="0"/><mxCell id="1" parent="0"/>` +
    `<mxCell id="2" vertex="1" value="${escHtmlAttr('<div>a</div>'.repeat(8))}" ` +
    `style="whiteSpace=wrap;html=1;fontSize=12;" parent="1">` +
    `<mxGeometry x="20" y="50" width="120" height="40" as="geometry"/>` +
    `</mxCell></root></mxGraphModel>`;
  const { contract } = await bake(xml);
  const paint = contract.document.pages[0].paint;
  const node = paint.find((n) => n.kind === 'svg');
  // The vertex body rect gives the cell box in contract units.
  const body = paint.find((n) => n.kind === 'path' && /Z$/.test(n.d));
  const ys = [...body.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => +m[2]);
  const cellTop = Math.min(...ys), cellBot = Math.max(...ys);
  // 8 rows * 14.4 = 115.2 in a 40-high box: oy = -37.6 — the label stays
  // CENTERED on the cell, spilling above and below equally.
  assert.ok(node.box.y < cellTop, `viewport grows above the cell top (y=${node.box.y})`);
  assert.ok(node.box.h > (cellBot - cellTop) * 2.5, `viewport holds the whole stack (h=${node.box.h})`);
  assert.ok(Math.abs((node.box.y + node.box.h / 2) - (cellTop + cellBot) / 2) < (cellBot - cellTop) / 20,
    'label remains centered on the cell');
});

test('audit3: html label without markup is entity-decoded end-to-end', async () => {
  // XML attr &amp;amp; -> stored value "Tom &amp; Jerry" -> displayed "Tom & Jerry"
  const { svg, notices } = await bakeRichLabel('Tom &amp; Jerry');
  assert.equal(notices.length, 0);
  assert.ok(svg.includes('>Tom &amp; Jerry<'),
    'one decode: prints "Tom & Jerry", not the literal entity text');
});

// --- audit: parser/exporter fidelity regressions (routing, bounds, text) ---
// Each test pins a fixed silent divergence found in the end-to-end WYSIWYG
// audit. Routing values are checked against drawio's own mxEdgeStyle
// algorithms (which the bake now runs verbatim via mx-edge-router.mjs).

test('audit: elbowEdgeStyle default is SideToSide (horizontal-first), not mid-Y', async () => {
  const xml = `<mxGraphModel pageWidth="600" pageHeight="400"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="A" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="B" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="240" y="160" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="E" edge="1" parent="1" source="A" target="B" style="edgeStyle=elbowEdgeStyle;rounded=0;"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.find((n) => n.kind === 'path' && /M 80 /.test(n.d));
  assert.ok(edge, 'edge path present');
  // SideToSide routes through mid-X (160): exits source EAST at y=20,
  // vertical leg at x=160, enters target WEST at y=180. The old hand-rolled
  // router produced the inverted TopToBottom (mid-Y 100) elbow.
  // The line stops at 240 - 6.368 = 233.632: the default classic arrowhead
  // recedes the endpoint by (size+sw)*3/4 + sw*1.118 (mxMarker.js:69-70).
  assert.match(edge.d, /M 80 20 L 160 20 L 160 180 L 233\.632 180/,
    `expected drawio SideToSide route, got ${edge.d}`);
});

test('audit: stale sourcePoint on a CONNECTED edge does not disable routing', async () => {
  const mk = (extra) => `<mxGraphModel pageWidth="600" pageHeight="400"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="A" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="B" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="240" y="160" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="E" edge="1" parent="1" source="A" target="B" style="edgeStyle=elbowEdgeStyle;"><mxGeometry relative="1" as="geometry">${extra}</mxGeometry></mxCell>
  </root></mxGraphModel>`;
  const clean = await bake(mk(''), { keepPx: true });
  const stale = await bake(mk('<mxPoint x="999" y="999" as="sourcePoint"/>'), { keepPx: true });
  const route = (r) => r.contract.document.pages[0].paint.find((n) => n.kind === 'path' && /^M 80 /.test(n.d || ''));
  assert.ok(route(clean) && route(stale), 'both edges routed');
  assert.equal(route(stale).d, route(clean).d,
    'stale literal sourcePoint must not change the route of a connected edge');
});

test('audit: floating edge from an ellipse starts on the ellipse arc, not the bbox side', async () => {
  const xml = `<mxGraphModel pageWidth="600" pageHeight="400"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="A" vertex="1" parent="1" style="ellipse;"><mxGeometry x="0" y="0" width="80" height="80" as="geometry"/></mxCell>
    <mxCell id="B" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="200" y="200" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="E" edge="1" parent="1" source="A" target="B"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  // The edge is the only OPEN path (shape outlines close with Z).
  const edge = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && n.stroke && !/Z/i.test(n.d || ''));
  assert.ok(edge, 'edge present');
  const m = /^M ([\d.]+) ([\d.]+)/.exec(edge.d);
  const sx = parseFloat(m[1]), sy = parseFloat(m[2]);
  // mxPerimeter.EllipsePerimeter toward (240,220): the 45-degree point on
  // the circle is ~(68.3, 68.3) -- NOT the bbox east pole (80, 40).
  const dx = sx - 40, dy = sy - 40;
  const r = Math.sqrt(dx * dx + dy * dy);
  assert.ok(Math.abs(r - 40) < 1.5, `start point must sit ON the ellipse (r=${r}, got ${sx},${sy})`);
  assert.ok(sy > 55, `start must be on the lower-right arc toward the target (y=${sy})`);
});

test('audit: exitX/exitY honors the terminal rotation (mxGraph.getConnectionPoint)', async () => {
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="A" vertex="1" parent="1" style="rounded=0;rotation=90;"><mxGeometry x="0" y="0" width="120" height="40" as="geometry"/></mxCell>
    <mxCell id="B" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="300" y="300" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="E" edge="1" parent="1" source="A" target="B" style="exitX=1;exitY=0.5;"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && n.stroke && !/Z/i.test(n.d || ''));
  const m = /^M ([\d.-]+) ([\d.-]+)/.exec(edge.d);
  const sx = parseFloat(m[1]), sy = parseFloat(m[2]);
  // Unrotated mid-right is (120,20); rotated 90 about the center (60,20)
  // the attachment lands at MODEL (60,80) -- the rotated shape's bottom
  // center. A's rotated AABB is x in [40,80], y in [-40,80], so the
  // content origin is (40,-40) and the expected CONTENT point is (20,120).
  // The old fraction-on-the-unrotated-box attached at (120,20) instead.
  assert.ok(Math.abs(sx - 20) < 1.5 && Math.abs(sy - 120) < 1.5,
    `rotated exit point must be the shape bottom-center (got ${sx},${sy})`);
});

test('audit: edge to a child of a collapsed group attaches to the group', async () => {
  const xml = `<mxGraphModel pageWidth="600" pageHeight="400"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="G" vertex="1" parent="1" style="group" collapsed="1"><mxGeometry x="200" y="0" width="80" height="30" as="geometry"><mxRectangle x="200" y="0" width="80" height="30" as="alternateBounds"/></mxGeometry></mxCell>
    <mxCell id="C" vertex="1" parent="G" style="rounded=0;"><mxGeometry x="10" y="50" width="60" height="30" as="geometry"/></mxCell>
    <mxCell id="A" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="0" y="0" width="80" height="30" as="geometry"/></mxCell>
    <mxCell id="E" edge="1" parent="1" source="A" target="C"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && n.stroke && !/Z/i.test(n.d || ''));
  assert.ok(edge, 'edge present');
  const nums = (edge.d.match(/[-\d.]+/g) || []).map(Number);
  const endX = nums[nums.length - 2], endY = nums[nums.length - 1];
  // Must land on the collapsed GROUP's box (y in [0,30], x ~200 minus the
  // classic-arrowhead line recession of 6.368px, mxMarker.js:69-70), not the
  // hidden child's stale geometry at (210,50)+.
  assert.ok(endY <= 31 && endX >= 188 && endX <= 285,
    `edge must attach to the collapsed group perimeter, got (${endX},${endY})`);
});

test('audit: corrupt <diagram> page refuses the whole bake (no silent partial)', async () => {
  const xml = '<mxfile><diagram name="ok"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>' +
    '<diagram name="bad">!!!not-base64!!!</diagram></mxfile>';
  await assert.rejects(() => bake(xml), /could not be decoded/,
    'a 2-page file with one corrupt page must refuse, not print one page');
});

test('audit: double-encoded entities and astral chars decode faithfully', async () => {
  const xml = `<mxGraphModel pageWidth="300" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="a &amp;amp;lt; b &#128512;" style="rounded=0;" parent="1"><mxGeometry x="10" y="10" width="180" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const svg = contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  const dec = Buffer.from(svg.source, 'base64').toString('utf8');
  // The cell VALUE after ONE xml decode is "a &amp;lt; b ..." -- the editor
  // shows that literal text; in the baked SVG it appears XML-escaped again.
  assert.ok(dec.includes('a &amp;amp;lt; b'),
    'literal "&amp;lt;" survives (the old decoder double-decoded it to "<")');
  assert.ok(dec.includes('\u{1F600}'), 'astral entity decodes via fromCodePoint');
});

test('audit: dragged edge label prints at its stored position, not the midpoint', async () => {
  const xml = `<mxGraphModel pageWidth="600" pageHeight="400"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="A" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="0" y="100" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="B" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="400" y="100" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="E" edge="1" parent="1" source="A" target="B" value="lbl"><mxGeometry x="-0.8" y="15" relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const paint = contract.document.pages[0].paint;
  const svg = paint.find((n) =>
    n.kind === 'svg' && /lbl/.test(Buffer.from(n.source, 'base64').toString('utf8')));
  assert.ok(svg, 'edge label present');
  const edge = paint.find((n) => n.kind === 'path' && n.stroke && !/Z/i.test(n.d || ''));
  const em = /^M ([\d.-]+) ([\d.-]+)/.exec(edge.d);
  const ex = parseFloat(em[1]), ey = parseFloat(em[2]);
  const cx = svg.box.x + svg.box.w / 2;
  const cy = svg.box.y + svg.box.h / 2;
  // Edge runs horizontally, length 320. gx=-0.8 -> dist=(-0.4+0.5)*320 = 32
  // from the start; positive gy displaces perpendicular UP for a rightward
  // edge (mxGraphView.getPoint: y -= ny*gy). Compare relative to the edge's
  // own drawn start so the content-origin shift cancels.
  assert.ok(Math.abs((cx - ex) - 32) < 3, `label sits 32px along the edge (got ${cx - ex})`);
  assert.ok(Math.abs((cy - ey) + 15) < 3, `label sits 15px above the edge (got ${cy - ey})`);
});

test('audit: curved=1 with 3+ points emits smooth cubics (mxPolyline.paintCurvedLine)', async () => {
  const xml = `<mxGraphModel pageWidth="600" pageHeight="400"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="A" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="B" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="240" y="160" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="E" edge="1" parent="1" source="A" target="B" style="curved=1;rounded=0;noEdgeStyle=1;"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="150" y="20"/></Array></mxGeometry></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.find((n) => n.kind === 'path' && /C /.test(n.d || ''));
  assert.ok(edge, 'curved edge emits cubic path');
  assert.ok(!/ L /.test(edge.d.replace(/^M [\d. ]+/, '')),
    `curved edge must be smooth cubics with no straight interior segments: ${edge.d}`);
});

test('audit: opacity and fillOpacity compose multiplicatively (mxSvgCanvas2D)', async () => {
  const xml = `<mxGraphModel pageWidth="300" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="rounded=0;fillColor=#ff0000;opacity=50;fillOpacity=50;" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const node = contract.document.pages[0].paint.find((n) => n.kind === 'path' && n.fill);
  assert.ok(Math.abs(node.fill.alpha - 0.25) < 1e-6,
    `fill alpha must be 0.5*0.5=0.25, got ${node.fill.alpha}`);
});

test('audit: gradientDirection=radial emits a real radialGradient', async () => {
  const xml = `<mxGraphModel pageWidth="300" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="rounded=0;fillColor=#ff0000;gradientColor=#0000ff;gradientDirection=radial;" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const svg = contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  const dec = Buffer.from(svg.source, 'base64').toString('utf8');
  assert.match(dec, /<radialGradient/, 'radial gradient must not silently become linear');
});

test('audit: default-overflow label is NOT clipped to its box (overflow visible)', async () => {
  const mk = (overflow) => `<mxGraphModel pageWidth="400" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="an extremely long unwrapped label text" style="rounded=0;${overflow}" parent="1"><mxGeometry x="120" y="50" width="60" height="30" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const vis = await bake(mk(''), { keepPx: true });
  const visSvg = vis.contract.document.pages[0].paint.find((n) =>
    n.kind === 'svg' && /extremely/.test(Buffer.from(n.source, 'base64').toString('utf8')));
  assert.ok(visSvg.box.w > 100,
    `default overflow grows the label viewport past the 60px box (w=${visSvg.box.w})`);
  assert.ok(!/clipPath/.test(Buffer.from(visSvg.source, 'base64').toString('utf8')),
    'no clip for overflow:visible');
  const hid = await bake(mk('overflow=hidden;'), { keepPx: true });
  const hidSvg = hid.contract.document.pages[0].paint.find((n) =>
    n.kind === 'svg' && /extremely/.test(Buffer.from(n.source, 'base64').toString('utf8')));
  assert.ok(Math.abs(hidSvg.box.w - 60) < 6, 'overflow=hidden keeps the box + clip');
  assert.ok(/clipPath/.test(Buffer.from(hidSvg.source, 'base64').toString('utf8')),
    'overflow=hidden clips');
});

test('audit: jumpStyle raises a loud notice (line jumps are not re-derived)', async () => {
  const xml = `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="E1" edge="1" parent="1" style="jumpStyle=arc;noEdgeStyle=1;"><mxGeometry relative="1" as="geometry"><mxPoint x="0" y="0" as="sourcePoint"/><mxPoint x="200" y="200" as="targetPoint"/></mxGeometry></mxCell>
  </root></mxGraphModel>`;
  const { notices } = await bake(xml, { keepPx: true });
  assert.ok(notices.some((n) => /jumpStyle/.test(n.detail && n.detail.detail || '')),
    'jumpStyle must be loudly noticed, never silently flattened');
});

test('audit: wrapped CJK label breaks between ideographs (no silent clipping)', async () => {
  const xml = `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="这是一个很长的中文标签文本应该自动换行显示" style="whiteSpace=wrap;rounded=0;" parent="1"><mxGeometry x="20" y="20" width="120" height="80" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const svg = contract.document.pages[0].paint.find((n) =>
    n.kind === 'svg' && /这是/.test(Buffer.from(n.source, 'base64').toString('utf8')));
  const dec = Buffer.from(svg.source, 'base64').toString('utf8');
  const lines = (dec.match(/<text/g) || []).length;
  assert.ok(lines >= 2, `CJK label must wrap into multiple lines (got ${lines})`);
});

test('audit: ink-extent anchoring keeps outside-positioned labels on the page', async () => {
  const xml = `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="Above" style="rounded=0;verticalLabelPosition=top;verticalAlign=bottom;" parent="1"><mxGeometry x="0" y="0" width="100" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const page = contract.document.pages[0];
  for (const n of page.paint) {
    if (n.box) {
      assert.ok(n.box.y > -3, `no ink may anchor off the page top (box.y=${n.box.y})`);
    }
  }
});

// ---------------------------------------------------------------------------
// Round-2 audit regression tests: shape fidelity fixes verified against
// Shapes.js / mxgraph shape sources (structural assertions on the baked
// contract, px units). Each test pins the exact geometry/paint drawio uses.
// ---------------------------------------------------------------------------

function auditProbe(style, w = 100, h = 60) {
  const xml = `<mxGraphModel pageWidth="200" pageHeight="160"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="${style}" parent="1">
      <mxGeometry x="0" y="0" width="${w}" height="${h}" as="geometry"/>
    </mxCell>
  </root></mxGraphModel>`;
  return bake(xml, { keepPx: true });
}
const decodeSvgNode = (n) => Buffer.from(n.source, 'base64').toString('utf8');

test('audit2: note geometry — size default 30, fold stroked open path, no invented shade fill', async () => {
  const { contract, notices } = await auditProbe('shape=note;fillColor=#FFF2CC;strokeColor=#D6B656;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // NoteShape: s = max(0, min(w, min(h, size=30))) — pentagon corner cut at 30px
  assert.ok(svg.includes('M 0 0 L 70 0 L 100 30 L 100 60 L 0 60 L 0 0 Z'),
    'note body pentagon must cut the corner at size=30 (NoteShape default), got: ' + svg);
  // fold = OPEN path (w-s,0)->(w-s,s)->(w,s) stroked in strokeColor
  assert.match(svg, /<path d="M 70 0 L 70 30 L 100 30" fill="none" stroke="#d6b656"/,
    'fold must be the stroked open path in strokeColor');
  // darkOpacity defaults 0: NO filled fold triangle, no shaded fill
  assert.ok(!/M 70 0 L 70 30 L 100 30 Z/.test(svg), 'no fold triangle fill at darkOpacity=0');
  assert.ok(!/#e5dab7|#ccc2a3/.test(svg), 'no invented shadeHex fold fill');
});

test('audit2: note darkOpacity fills the fold triangle black/white at |op| alpha', async () => {
  const pos = decodeSvgNode((await auditProbe('shape=note;fillColor=#FFF2CC;strokeColor=#D6B656;darkOpacity=0.3;'))
    .contract.document.pages[0].paint[0]);
  assert.match(pos, /<path d="M 70 0 L 70 30 L 100 30 Z" fill="#000000" fill-opacity="0.3" stroke="none"\/>/,
    'darkOpacity=0.3 fills the fold triangle black at 0.3');
  const neg = decodeSvgNode((await auditProbe('shape=note;fillColor=#FFF2CC;strokeColor=#D6B656;darkOpacity=-0.4;'))
    .contract.document.pages[0].paint[0]);
  assert.match(neg, /<path d="M 70 0 L 70 30 L 100 30 Z" fill="#ffffff" fill-opacity="0.4" stroke="none"\/>/,
    'darkOpacity<0 fills white at |op|');
});

test('audit2: note body fill honors fillOpacity/opacity multiplicatively', async () => {
  const svg = decodeSvgNode((await auditProbe('shape=note;fillColor=#FFF2CC;strokeColor=#D6B656;opacity=50;fillOpacity=50;'))
    .contract.document.pages[0].paint[0]);
  assert.match(svg, /fill="#fff2cc" fill-opacity="0.25"/, 'fill-opacity = opacity * fillOpacity = 0.25');
});

test('audit2: note2 paints the dog-ear exactly like note (NoteShape2 extends NoteShape)', async () => {
  const note = await auditProbe('shape=note;fillColor=#FFF2CC;strokeColor=#D6B656;');
  const note2 = await auditProbe('shape=note2;fillColor=#FFF2CC;strokeColor=#D6B656;');
  assert.equal(note2.notices.length, 0, 'note2 must not degrade');
  assert.equal(decodeSvgNode(note2.contract.document.pages[0].paint[0]),
    decodeSvgNode(note.contract.document.pages[0].paint[0]),
    'note2 must bake byte-identically to note (was a plain rectangle)');
});

test('audit2: note flipH mirrors the fold within the box', async () => {
  const svg = decodeSvgNode((await auditProbe('shape=note;flipH=1;fillColor=#FFF2CC;strokeColor=#D6B656;'))
    .contract.document.pages[0].paint[0]);
  assert.match(svg, /<g transform="translate\(100,0\) scale\(-1,1\)">/,
    'flipH must mirror the note shape (was silently ignored)');
});

test('audit2: process honors fixedSize, and rounded=1 rounds the background + widens the inset', async () => {
  const { contract, notices } = await auditProbe('shape=process;fixedSize=1;size=12;rounded=1;arcSize=20;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0, 'rounded process must round faithfully, not notice');
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // inset = max(min(w,12), min(w*0.2,h*0.2)=12) = 12 (absolute px, fixedSize)
  assert.match(svg, /<line x1="12" y1="0" x2="12" y2="60"/, 'left inset line at 12px (fixedSize absolute)');
  assert.match(svg, /<line x1="88" y1="0" x2="88" y2="60"/, 'right inset line at w-12');
  // rounded background: arc radius min(w,h)*arcSize/100 = 12
  assert.match(svg, /<path d="M 12 0 L 88 0 A 12 12 0 0 1 100 12/, 'rounded-rect background, r=12');
  // relative default still works: size=0.2 -> inset 20
  const rel = decodeSvgNode((await auditProbe('shape=process;size=0.2;fillColor=#ffffff;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0]);
  assert.match(rel, /<line x1="20" y1="0"/, 'relative size=0.2 -> inset w*0.2=20');
});

test('audit2: cloud is the exact mxCloud silhouette', async () => {
  const { contract, notices } = await auditProbe('shape=cloud;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const d = contract.document.pages[0].paint[0].d;
  // mxCloud.redrawPath, w=100 h=60: M(25,15) C(5,15)(0,30)(16,33) ...
  assert.equal(d,
    'M 25 15 C 5 15 0 30 16 33 C 0 39.6 18 54 31 48 C 40 60 70 60 80 48 ' +
    'C 100 48 100 36 87.5 30 C 100 18 80 6 62.5 12 C 50 3 30 3 25 15 Z',
    'cloud must match mxCloud.js:45-55 exactly');
});

test('audit2: actor is the exact mxActor silhouette (single path)', async () => {
  const { contract, notices } = await auditProbe('shape=actor;fillColor=#ffffff;strokeColor=#000000;', 60, 90);
  assert.equal(notices.length, 0);
  assert.equal(contract.document.pages[0].paint[0].d,
    'M 0 90 C 0 54 0 36 30 36 C 10 36 10 0 30 0 C 50 0 50 36 30 36 C 60 36 60 54 60 90 Z',
    'actor must match mxActor.js:77-87 exactly (width=w/3, shoulders at 2h/5)');
});

test('audit2: doubleEllipse margin = min(3+strokewidth, min(w/5,h/5)) and honors margin=', async () => {
  const def = (await auditProbe('shape=doubleEllipse;fillColor=#ffffff;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0].d;
  // strokeWidth 1 -> margin 4: inner ellipse from (4,30) rx 46 ry 26
  assert.ok(def.includes('M 4 30 A 46 26 0 1 0 96 30'), `default margin must be 4 (3+sw), got: ${def}`);
  const m8 = (await auditProbe('shape=doubleEllipse;margin=8;fillColor=#ffffff;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0].d;
  assert.ok(m8.includes('M 8 30 A 42 22 0 1 0 92 30'), `margin=8 style key must be honored, got: ${m8}`);
});

test('audit2: singleArrow body is arrowWidth*h FULL height (not 2x), arrowSize honored', async () => {
  const { contract, notices } = await auditProbe('shape=singleArrow;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  // aw=0.3*60=18 -> at=21 ab=39; as=0.2*100=20 (Shapes.js SingleArrowShape)
  assert.equal(contract.document.pages[0].paint[0].d,
    'M 0 21 L 80 21 L 80 0 L 100 30 L 80 60 L 80 39 L 0 39 Z');
  const custom = (await auditProbe('shape=singleArrow;arrowWidth=0.5;arrowSize=0.1;fillColor=#ffffff;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0].d;
  assert.equal(custom, 'M 0 15 L 90 15 L 90 0 L 100 30 L 90 60 L 90 45 L 0 45 Z',
    'arrowWidth/arrowSize style keys must be honored');
});

test('audit2: doubleArrow geometry matches DoubleArrowShape', async () => {
  const { contract, notices } = await auditProbe('shape=doubleArrow;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  // aw=18 at=21 ab=39 as=20
  assert.equal(contract.document.pages[0].paint[0].d,
    'M 0 30 L 20 0 L 20 21 L 80 21 L 80 0 L 100 30 L 80 60 L 80 39 L 20 39 L 20 60 Z');
});

test('audit2: rounded singleArrow rounds via addPoints (no notice, quadratic corners)', async () => {
  const { contract, notices } = await auditProbe('shape=singleArrow;rounded=1;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0, 'rounded singleArrow must round, not notice');
  assert.match(contract.document.pages[0].paint[0].d, / C /, 'rounded corners present (Q->C converted)');
});

test('audit2: plus is a rect background + stroke-only inset plus lines (PlusShape)', async () => {
  const { contract, notices } = await auditProbe('shape=plus;fillColor=#ffffff;strokeColor=#000000;', 60, 60);
  assert.equal(notices.length, 0);
  const node = contract.document.pages[0].paint[0];
  assert.equal(node.kind, 'svg', 'plus is multi-paint -> kind:svg');
  const svg = decodeSvgNode(node);
  assert.match(svg, /<rect x="0" y="0" width="60" height="60" fill="#ffffff" stroke="#000000"/,
    'full rect background (was a filled Greek cross)');
  // border = min(w/5,h/5)+1 = 13
  assert.match(svg, /<path d="M 30 13 L 30 47 M 13 30 L 47 30" fill="none" stroke="#000000"/,
    'stroke-only plus lines inset by border=13');
});

test('audit2: cylinder2 cap uses absolute size (default 15) with arcs + stroke-only inner lid', async () => {
  const { contract, notices } = await auditProbe('shape=cylinder2;fillColor=#ffffff;strokeColor=#000000;', 100, 120);
  assert.equal(notices.length, 0);
  const node = contract.document.pages[0].paint[0];
  assert.equal(node.kind, 'svg', 'cylinder2 is multi-paint -> kind:svg');
  const svg = decodeSvgNode(node);
  assert.ok(svg.includes('M 0 15 A 50 15 0 0 1 50 0 A 50 15 0 0 1 100 15 L 100 105 A 50 15 0 0 1 50 120 A 50 15 0 0 1 0 105 Z'),
    'body per CylinderShape (size=15 absolute), got: ' + svg);
  assert.match(svg, /<path d="M 100 15 A 50 15 0 0 1 50 30 A 50 15 0 0 1 0 15" fill="none"/,
    'inner lid is stroke-only at 2*size');
});

test('audit2: cylinder3 honors size= and lid=0 (downward top arc, no inner lid)', async () => {
  const svg = decodeSvgNode((await auditProbe('shape=cylinder3;size=40;lid=0;fillColor=#ffffff;strokeColor=#000000;', 100, 120))
    .contract.document.pages[0].paint[0]);
  assert.ok(svg.includes('M 0 0 A 50 40 0 0 0 50 40 A 50 40 0 0 0 100 0 L 100 80'),
    'lid=0 top edge is the sweep-0 arc pair, got: ' + svg);
  assert.ok(!svg.includes('fill="none"') || !/A 50 40 0 0 1 50 80/.test(svg),
    'no inner lid stroke when lid=0');
  assert.equal((svg.match(/<path/g) || []).length, 1, 'lid=0 -> single body path, no inner lid');
});

test('audit2: isoCube2 hexagon body + stroke-only interior edges (isoAngle honored)', async () => {
  const { contract, notices } = await auditProbe('shape=isoCube2;fillColor=#ffffff;strokeColor=#000000;', 80, 100);
  assert.equal(notices.length, 0);
  const node = contract.document.pages[0].paint[0];
  assert.equal(node.kind, 'svg', 'isoCube2 is multi-paint -> kind:svg');
  const svg = decodeSvgNode(node);
  // isoAngle 15 -> isoH = min(80*tan(15*PI/200), 50) = 80*tan(0.23562) = 19.206
  assert.match(svg, /<path d="M 40 0 L 80 19\.206 L 80 80\.794 L 40 100 L 0 80\.794 L 0 19\.206 Z"/,
    'IsoCubeShape2 hexagonal body');
  assert.match(svg, /<path d="M 0 19\.206 L 40 38\.413 L 80 19\.206 M 40 38\.413 L 40 100" fill="none"/,
    'stroke-only interior edges');
});

test('audit2: corner/tee are FILLED polygons with dx/dy; crossbar is end bars + middle line', async () => {
  const corner = await auditProbe('shape=corner;fillColor=#ff0000;strokeColor=#000000;');
  assert.equal(corner.notices.length, 0);
  const cn = corner.contract.document.pages[0].paint[0];
  assert.equal(cn.d, 'M 0 0 L 100 0 L 100 20 L 20 20 L 20 60 L 0 60 Z', 'CornerShape polygon (dx=dy=20)');
  assert.ok(cn.fill && cn.fill.color === '#ff0000', 'corner is FILLED (was a bare polyline)');
  const tee = await auditProbe('shape=tee;dx=30;dy=10;fillColor=#ff0000;strokeColor=#000000;');
  assert.equal(tee.contract.document.pages[0].paint[0].d,
    'M 0 0 L 100 0 L 100 10 L 65 10 L 65 60 L 35 60 L 35 10 L 0 10 Z', 'TeeShape polygon honors dx/dy');
  const bar = await auditProbe('shape=crossbar;strokeColor=#000000;fillColor=none;');
  assert.equal(bar.contract.document.pages[0].paint[0].d,
    'M 0 0 L 0 60 M 100 0 L 100 60 M 0 30 L 100 30', 'CrossbarShape: end bars + middle line (was a plus)');
});

test('audit2: rounded=1 rounds every ported polygon shape faithfully (no notice, no square corners)', async () => {
  for (const shape of ['card', 'manualInput', 'loopLimit', 'offPageConnector', 'corner', 'tee',
    'hexagon', 'parallelogram', 'step', 'trapezoid', 'singleArrow', 'doubleArrow']) {
    const { contract, notices } = await auditProbe(`shape=${shape};rounded=1;fillColor=#ffffff;strokeColor=#000000;`);
    assert.equal(notices.length, 0, `rounded ${shape} must round faithfully, not notice`);
    const d = contract.document.pages[0].paint[0].d;
    assert.match(d, / C /, `rounded ${shape} must contain rounded (curve) corners`);
  }
});

test('audit2: rounded=1 on non-ported roundable shapes stays LOUD (folder/callout)', async () => {
  // zigzag left this list in audit7: rounded=1 now paints the faithful cubic
  // wave (ZigzagShape rounded branch) — see 'audit7 shape: zigzag'.
  for (const shape of ['folder', 'callout']) {
    const { notices } = await auditProbe(`shape=${shape};rounded=1;fillColor=#ffffff;strokeColor=#000000;`);
    assert.ok(notices.some((n) => /rounded corners on/.test(n.detail && n.detail.detail || '')),
      `rounded ${shape} must emit a loud notice (not silently square)`);
  }
});

test('audit2: step includes the left notch point (StepShape exact polygon)', async () => {
  const { contract } = await auditProbe('shape=step;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(contract.document.pages[0].paint[0].d,
    'M 0 0 L 80 0 L 100 30 L 80 60 L 0 60 L 20 30 Z',
    'StepShape points incl. (s, h/2) notch');
});

test('audit2: gradient fills carry fill-opacity on every svg-emission path', async () => {
  // plain gradient cell
  const g1 = decodeSvgNode((await auditProbe('fillColor=#dae8fc;gradientColor=#7ea6e0;fillOpacity=40;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0]);
  assert.match(g1, /fill="url\(#g\d*\)" fill-opacity="0.4"/, 'gradient cell carries fill-opacity');
  // rotated gradient cell (separate emission path)
  const g2 = decodeSvgNode((await auditProbe('rotation=30;fillColor=#dae8fc;gradientColor=#7ea6e0;opacity=50;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0]);
  assert.match(g2, /fill="url\(#g\d*\)" fill-opacity="0.5"/, 'rotated gradient cell carries fill-opacity');
  // swimlane header gradient (regionFillNode)
  const sw = (await auditProbe('swimlane;startSize=20;fillColor=#dae8fc;gradientColor=#7ea6e0;fillOpacity=40;strokeColor=#000000;'))
    .contract.document.pages[0].paint.find((n) => n.kind === 'svg' && /linearGradient/.test(decodeSvgNode(n)));
  assert.match(decodeSvgNode(sw), /fill="url\(#r\w*\)" fill-opacity="0.4"/, 'swimlane header gradient carries fill-opacity');
  // note gradient
  const ng = decodeSvgNode((await auditProbe('shape=note;fillColor=#dae8fc;gradientColor=#7ea6e0;fillOpacity=40;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0]);
  assert.match(ng, /fill="url\(#ngrad\)" fill-opacity="0.4"/, 'note gradient carries fill-opacity');
});

test('audit2: flipH/flipV apply to builtinShapeSvg and swimlane branches', async () => {
  const proc = decodeSvgNode((await auditProbe('shape=process;flipH=1;fillColor=#ffffff;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0]);
  assert.match(proc, /<g transform="translate\(100,0\) scale\(-1,1\)">/, 'builtinShapeSvg flipH mirrors content');
  const cyl = decodeSvgNode((await auditProbe('shape=cylinder3;flipV=1;fillColor=#ffffff;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0]);
  assert.match(cyl, /<g transform="translate\(0,60\) scale\(1,-1\)">/, 'cylinder3 flipV mirrors content');
  // swimlane flipV: header (and its divider) moves to the bottom edge
  const lane = (await auditProbe('swimlane;flipV=1;startSize=20;fillColor=#dae8fc;strokeColor=#6c8ebf;'))
    .contract.document.pages[0].paint;
  const headerFill = lane.find((n) => n.kind === 'path' && n.fill);
  assert.equal(headerFill.d, 'M 0 60 L 100 60 L 100 40 L 0 40 Z',
    'flipV swimlane header fill sits at the bottom (40..60)');
  const divider = lane.filter((n) => n.kind === 'path' && !n.fill).map((n) => n.d);
  assert.ok(divider.includes('M 0 40 L 100 40'), 'divider line at the flipped header boundary');
});

// ---- audit2 router fixes: self-loop via real mxEdgeStyle.Loop; rotated/flipped
// floating perimeters (mxGraphView.getFloatingTerminalPoint/getPerimeterPoint).

async function bakeEdgeProbe(vertexStyle, edgeStyle, opts) {
  const o = opts || {};
  const geo = o.geometry || { x: 100, y: 100, w: 80, h: 40 };
  const target = o.target || null;
  const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" style="${vertexStyle}" parent="1">
      <mxGeometry x="${geo.x}" y="${geo.y}" width="${geo.w}" height="${geo.h}" as="geometry"/></mxCell>
    ${target ? `<mxCell id="b" vertex="1" style="rounded=0;" parent="1">
      <mxGeometry x="${target.x}" y="${target.y}" width="${target.w}" height="${target.h}" as="geometry"/></mxCell>` : ''}
    <mxCell id="e" edge="1" style="${edgeStyle}" source="a" target="${target ? 'b' : 'a'}" parent="1">
      <mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  // The edge polyline is the multi-point unfilled path.
  const edge = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && !n.fill && (n.d.match(/L /g) || []).length >= 1);
  return edge;
}

test('audit2: self-loop honors direction=north (loops over the TOP, mxEdgeStyle.Loop)', async () => {
  const east = await bakeEdgeProbe('rounded=0;', 'direction=west;');
  const north = await bakeEdgeProbe('rounded=0;', 'direction=north;');
  // direction=west (drawio default): loop off the RIGHT side -> max x beyond the box.
  const xs = [...east.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => +m[1]);
  assert.ok(Math.max(...xs) > 80, `west loop extends right of the shape, got max x ${Math.max(...xs)}`);
  // direction=north: loop over the TOP -> min y above the box top (y=0 in anchored coords).
  // The loop tops out 20 units above the box top (2*seg). Compare against
  // the box top in the same anchored coordinates (the anchor itself moves
  // with halo growth, e.g. the marker bbox augmentation).
  const ys = [...north.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => +m[2]);
  const boxTop = Math.max(...ys); // loop start/end sit ON the box top edge
  assert.ok(Math.min(...ys) <= boxTop - 19,
    `north loop extends ~20 above the shape top (top ${boxTop}, min ${Math.min(...ys)})`);
});

test('audit2: self-loop honors segment= (loop depth scales)', async () => {
  const near = await bakeEdgeProbe('rounded=0;', '');
  const far = await bakeEdgeProbe('rounded=0;', 'segment=30;');
  const maxX = (e) => Math.max(...[...e.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => +m[1]));
  assert.ok(maxX(far) > maxX(near) + 30,
    `segment=30 loops farther out (${maxX(far)} vs ${maxX(near)})`);
});

test('audit2: floating edge attaches to the ROTATED perimeter of a rotated terminal', async () => {
  // 80x20 box rotated 90: its ink occupies x in [cx-10, cx+10] = [130, 150].
  // A floating edge from a target far to the right must attach at the rotated
  // right ink edge x=150 (the unrotated box edge x=180 would be detached air).
  const edge = await bakeEdgeProbe('rounded=0;rotation=90;', 'edgeStyle=none;',
    { geometry: { x: 100, y: 100, w: 80, h: 20 }, target: { x: 400, y: 100, w: 40, h: 20 } });
  const first = /M (-?[\d.]+) (-?[\d.]+)/.exec(edge.d);
  // anchored coords: content min-x is the rotated vertex's ink left edge.
  // The attach x must be ~50 units from content origin (130->150 span is 20 wide,
  // rotated box center at 140; content min x = 130). Attach = 150-130 = 20.
  assert.ok(Math.abs(+first[1] - 20) < 1.5,
    `edge attaches at the rotated ink edge (expected ~20, got ${first[1]})`);
});

// ─── audit4: edge markers (mxMarker fidelity) and stencil renderer fixes ────

// fmt() mirror of the exporter's 3-decimal coordinate formatter.
const f3 = (n) => {
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
};

// Free-floating edge (no terminals) so the routed points are exactly the
// source/target points and only the line + markers are painted.
function markerProbe(style) {
  return `<mxGraphModel pageWidth="400" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="e" edge="1" style="${style}" parent="1"><mxGeometry relative="1" as="geometry">
      <mxPoint x="20" y="100" as="sourcePoint"/><mxPoint x="220" y="100" as="targetPoint"/>
    </mxGeometry></mxCell>
  </root></mxGraphModel>`;
}
const pathsOf = (contract) =>
  contract.document.pages[0].paint.filter((n) => n.kind === 'path');
// The connector line is the only path with a non-null dashless stroke and no
// fill that has exactly one straight segment from min-x; simpler: it is the
// FIRST path emitted by emitEdge.
const lineOf = (contract) => pathsOf(contract)[0];
const endNums = (d) => {
  const nums = (d.match(/-?[\d.]+/g) || []).map(Number);
  return { x: nums[nums.length - 2], y: nums[nums.length - 1] };
};

test('audit4: endArrow=none paints NO marker; absent endArrow paints the classic default', async () => {
  // The stylesheet resolver DELETES endArrow=none (value-none keys), making it
  // indistinguishable from "absent" — the exporter then re-injected the
  // defaultEdge classic arrow, printing an arrowhead drawio does not draw.
  const none = await bake(markerProbe('endArrow=none;'), { keepPx: true });
  assert.equal(pathsOf(none.contract).length, 1,
    'endArrow=none must paint only the line, no marker node');
  // absent endArrow → drawio defaultEdge endArrow=classic → notched triangle
  const dflt = await bake(markerProbe('rounded=0;'), { keepPx: true });
  const dPaths = pathsOf(dflt.contract);
  assert.equal(dPaths.length, 2, 'default edge paints line + classic marker');
  assert.ok(dPaths[1].fill && /( L [-\d. ]+){3} Z$/.test(dPaths[1].d),
    `default marker is the filled classic notched triangle (d=${dPaths[1].d})`);
  // startArrow: absent → none (defaultEdge has no startArrow); explicit none → none
  const sNone = await bake(markerProbe('startArrow=none;endArrow=none;'), { keepPx: true });
  assert.equal(pathsOf(sNone.contract).length, 1, 'startArrow=none paints no marker');
  const sDflt = await bake(markerProbe('endArrow=none;startArrow=classic;'), { keepPx: true });
  assert.equal(pathsOf(sDflt.contract).length, 2, 'explicit startArrow paints one marker');
});

test('audit4: classic marker — exact mxMarker geometry and receded line endpoint', async () => {
  // Horizontal edge, sw=1, endSize default 6 (mxConstants.DEFAULT_MARKERSIZE).
  // mxMarker createArrow: endOffset = sw*1.118; unit=(size+sw)=7;
  // tip pt = pe - 1.118; wings at (pt-7, y±3.5); classic notch at pt-7*3/4;
  // line recedes to pe - 7*3/4 - 1.118 = tip(model) - 6.368.
  const { contract, notices } = await bake(markerProbe('endArrow=classic;rounded=0;'), { keepPx: true });
  assert.equal(notices.length, 0);
  const [line, marker] = pathsOf(contract);
  const le = endNums(line.d);
  const tipX = le.x + 6.368, y = le.y; // recession is exactly 6.368
  assert.equal(marker.d,
    `M ${f3(tipX - 1.118)} ${f3(y)}` +
    ` L ${f3(tipX - 8.118)} ${f3(y + 3.5)}` +
    ` L ${f3(tipX - 6.368)} ${f3(y)}` +
    ` L ${f3(tipX - 8.118)} ${f3(y - 3.5)} Z`,
    'classic marker path must match mxMarker.js exactly');
  assert.ok(marker.fill && marker.stroke, 'filled marker fillAndStrokes');
  assert.equal(marker.stroke.dash, null, 'markers are never dashed');
});

test('audit4: marker size comes from endSize/startSize, not strokeWidth', async () => {
  // endSize=12, sw=1: recession = (12+1)*3/4 + 1.118 = 10.868; wing half-width
  // = (size+sw)/2 = 6.5. Previously size was max(7, sw*5)=7 for everything.
  const { contract } = await bake(markerProbe('endArrow=classic;endSize=12;'), { keepPx: true });
  const [line, marker] = pathsOf(contract);
  const le = endNums(line.d);
  const tipX = le.x + 10.868, y = le.y;
  assert.equal(marker.d,
    `M ${f3(tipX - 1.118)} ${f3(y)}` +
    ` L ${f3(tipX - 14.118)} ${f3(y + 6.5)}` +
    ` L ${f3(tipX - 10.868)} ${f3(y)}` +
    ` L ${f3(tipX - 14.118)} ${f3(y - 6.5)} Z`,
    'endSize=12 classic marker geometry');
  // per-end: startSize only affects the start marker
  const both = await bake(markerProbe('endArrow=block;startArrow=block;startSize=20;'), { keepPx: true });
  const ps = pathsOf(both.contract);
  const ld = ps[0].d, sM = ps[1].d, eM = ps[2].d; // line, start marker, end marker
  const lineStartX = Number(ld.match(/-?[\d.]+/)[0]);
  const lineEndX = endNums(ld).x;
  const xsOf = (d) => [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => +m[1]);
  // The marker path's extreme x is its strokewidth-offset tip pt = model
  // endpoint ∓ sw*1.118. Block recedes the line by (size+sw) + sw*1.118, so
  // (line endpoint − path tip) = size+sw exactly:
  //   start: startSize 20 → 21;  end: default 6 → 7.
  const sTip = Math.min(...xsOf(sM)); // start marker points left; tip = min x
  const eTip = Math.max(...xsOf(eM));
  assert.ok(Math.abs((lineStartX - sTip) - 21) < 0.01,
    `start line recedes by startSize formula (got ${lineStartX - sTip})`);
  assert.ok(Math.abs((eTip - lineEndX) - 7) < 0.01,
    `end line recedes by endSize formula (got ${eTip - lineEndX})`);
});

test('audit4: hollow (endFill=0) markers are outlined and the line does not bisect them', async () => {
  // Expected (marker-path max-x − line end-x) on a horizontal edge, sw=1,
  // size=6 — recession minus the path tip's own strokewidth offset:
  //   classic: recession 6.368, path tip at model−1.118 → 5.25  (= (size+sw)*3/4)
  //   diamond: recession 7.7071, path tip at model−0.7071 → 7   (= size+sw)
  //   box:     recession 8, front face AT the model endpoint → 8 (= size+sw+1)
  // In every case the line end sits at/behind the marker's rear face — it no
  // longer bisects the hollow glyph.
  for (const [type, gap] of [['classic', 5.25], ['diamond', 7], ['box', 8]]) {
    const { contract } = await bake(markerProbe(`endArrow=${type};endFill=0;`), { keepPx: true });
    const [line, marker] = pathsOf(contract);
    assert.ok(!marker.fill && marker.stroke, `${type} endFill=0 is stroke-only`);
    const lineEndX = endNums(line.d).x;
    const tipX = Math.max(...[...marker.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => +m[1]));
    assert.ok(Math.abs((tipX - lineEndX) - gap) < 0.02,
      `${type}: marker-tip − line-end = ${tipX - lineEndX}, expected ${gap}`);
  }
  // circle: recession 2(size+sw)+sw = 15 lands the line end exactly ON the
  // circle's rear arc point (center model−8, radius 7): the ellipse path's
  // first M x equals the receded line end — tangent, not bisecting.
  const { contract: cc } = await bake(markerProbe('endArrow=circle;endFill=0;'), { keepPx: true });
  const [cLine, cMarker] = pathsOf(cc);
  assert.ok(!cMarker.fill && cMarker.stroke, 'circle endFill=0 is stroke-only');
  const cRear = Number(cMarker.d.match(/^M (-?[\d.]+)/)[1]);
  assert.ok(Math.abs(cRear - endNums(cLine.d).x) < 0.02,
    'circle: line end coincides with the circle rear point (no bisecting chord)');
});

test('audit4: oval marker — diameter=size circle centered AT the endpoint, recession size/2', async () => {
  const { contract } = await bake(markerProbe('endArrow=oval;'), { keepPx: true });
  const [line, marker] = pathsOf(contract);
  const le = endNums(line.d);
  const tipX = le.x + 3, y = le.y; // oval recedes by size/2 = 3 (to the center)
  // ellipse path: M (cx-r) cy A r r 0 1 0 (cx+r) cy A r r 0 1 0 (cx-r) cy Z, r=3, c=tip
  assert.equal(marker.d,
    `M ${f3(tipX - 3)} ${f3(y)} A 3 3 0 1 0 ${f3(tipX + 3)} ${f3(y)}` +
    ` A 3 3 0 1 0 ${f3(tipX - 3)} ${f3(y)} Z`,
    'oval marker is a size-diameter circle centered at the line endpoint');
  assert.ok(marker.fill, 'oval defaults filled (endFill default 1)');
});

test('audit4: open marker recedes the line by exactly 2*sw*1.118', async () => {
  const { contract } = await bake(markerProbe('endArrow=open;strokeWidth=3;'), { keepPx: true });
  const [line, marker] = pathsOf(contract);
  const le = endNums(line.d);
  // sw=3: recession = 2*3*1.118 = 6.708; tip pt = recession/2 ahead of line end
  const tipX = le.x + 6.708;
  assert.ok(!marker.fill && marker.stroke, 'open is stroke-only');
  // wings: unit=(6+3)=9, pt=(tip-3.354): M(pt-9, y+4.5) L(pt) L(pt-9, y-4.5)
  assert.equal(marker.d,
    `M ${f3(tipX - 3.354 - 9)} ${f3(le.y + 4.5)}` +
    ` L ${f3(tipX - 3.354)} ${f3(le.y)}` +
    ` L ${f3(tipX - 3.354 - 9)} ${f3(le.y - 4.5)}`,
    'open marker geometry (mxMarker createOpenArrow)');
});

test('audit4: circle marker — radius size+sw centered size+2sw behind the tip (Shapes.js)', async () => {
  const { contract } = await bake(markerProbe('endArrow=circle;'), { keepPx: true });
  const [line, marker] = pathsOf(contract);
  const le = endNums(line.d);
  const tipX = le.x + 15, y = le.y; // recession 2*(6+1)+1 = 15
  const c = tipX - 8, r = 7;        // center size+2sw=8 behind tip, radius size+sw=7
  assert.equal(marker.d,
    `M ${f3(c - r)} ${f3(y)} A 7 7 0 1 0 ${f3(c + r)} ${f3(y)}` +
    ` A 7 7 0 1 0 ${f3(c - r)} ${f3(y)} Z`,
    'circle marker per Shapes.js circleMarker');
});

// ─── audit4: stencil renderer fixes ─────────────────────────────────────────

// Inline stencil probe: makeStencilXml's cell is 120x100; stencil space is
// 60x50, so sx=sy=minScale(su)=2 exactly.
function stencilProbe(inner, styleExtra = '', shapeAttrs = '') {
  const xml = `<shape name="probe" w="60" h="50" aspect="variable"${shapeAttrs}>${inner}</shape>`;
  const b64 = Buffer.from(xml, 'utf8').toString('base64');
  return makeStencilXml(`shape=stencil(${b64});${styleExtra}`, '');
}
async function stencilSvgOf(xml) {
  const { contract, notices } = await bake(xml, { keepPx: true });
  const node = contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  return { svg: node ? Buffer.from(node.source, 'base64').toString('utf8') : '', notices };
}

test('audit4: stencil <fillcolor> switches to SOLID fill; earlier gradient def survives', async () => {
  // mxAbstractCanvas2D.setFillColor clears the gradient. Previously the
  // exporter minted a NEW gradient id on <fillcolor> and dropped the old def:
  // the already-painted element referenced a dangling def (broken paint) and
  // the post-<fillcolor> element wrongly kept a gradient.
  const { svg, notices } = await stencilSvgOf(stencilProbe(
    '<background><rect x="0" y="0" w="30" h="50"/></background>' +
    '<foreground><fillstroke/>' +
    '<fillcolor color="#ff0000"/><rect x="30" y="0" w="30" h="50"/><fillstroke/></foreground>',
    'fillColor=#0000ff;gradientColor=#00ff00;'));
  assert.equal(notices.length, 0);
  const url = /fill="url\(#([^)]+)\)"/.exec(svg);
  assert.ok(url, 'first rect painted with the cell gradient');
  assert.ok(svg.includes(`<linearGradient id="${url[1]}"`),
    `gradient def #${url[1]} must exist in <defs> (no dangling reference)`);
  assert.match(svg, /<rect x="60"[^>]*fill="#ff0000"/,
    'rect after <fillcolor> paints SOLID (gradient cleared), not a new gradient');
});

test('audit4: stencil save/restore restores the gradient fill state', async () => {
  const { svg, notices } = await stencilSvgOf(stencilProbe(
    '<background><rect x="0" y="0" w="30" h="50"/></background>' +
    '<foreground><save/><fillcolor color="#ff0000"/><fillstroke/>' +
    '<restore/><rect x="30" y="0" w="30" h="50"/><fillstroke/></foreground>',
    'fillColor=#0000ff;gradientColor=#00ff00;'));
  assert.equal(notices.length, 0);
  assert.match(svg, /<rect x="0"[^>]*fill="#ff0000"/,
    'rect painted under save+fillcolor is solid');
  const m2 = /<rect x="60"[^>]*fill="url\(#([^)]+)\)"/.exec(svg);
  assert.ok(m2 && svg.includes(`<linearGradient id="${m2[1]}"`),
    'restore must bring the gradient back (and its def must exist)');
});

test('audit4: stencil <text> font size is scaled ONCE (fontsize*minScale, no double su)', async () => {
  // mxStencil.js:965-968: <fontsize size="12"> → setFontSize(12*minScale=24).
  // The <text> emitter then uses the canvas font size as-is; it used to
  // multiply by su AGAIN (48 at su=2).
  const { svg, notices } = await stencilSvgOf(stencilProbe(
    '<background><rect x="0" y="0" w="60" h="50"/></background>' +
    '<foreground><fillstroke/><fontsize size="12"/>' +
    '<text str="Hi" x="10" y="10" align="left" valign="top"/></foreground>'));
  assert.equal(notices.length, 0);
  assert.match(svg, /font-size="24"/, 'fontsize 12 at minScale 2 = 24');
  assert.doesNotMatch(svg, /font-size="48"/, 'must not double-scale');
  // align defaults LEFT (anchor start) and valign TOP: first-line baseline at
  // y + size - 1 (mxSvgCanvas2D.plainText) = 20 + 24 - 1 = 43.
  assert.match(svg, /<text x="20" y="43" text-anchor="start"/);
});

test('audit4: stencil <text> vertical/rotation rotate about the anchor', async () => {
  const { svg } = await stencilSvgOf(stencilProbe(
    '<background><rect x="0" y="0" w="60" h="50"/></background>' +
    '<foreground><fillstroke/><text str="V" x="10" y="10" vertical="1"/></foreground>'));
  assert.match(svg, /rotate\(-90 20 20\)/, 'vertical="1" rotates -90 about (x,y)');
  const { svg: svg2 } = await stencilSvgOf(stencilProbe(
    '<background><rect x="0" y="0" w="60" h="50"/></background>' +
    '<foreground><fillstroke/><text str="R" x="10" y="10" rotation="30"/></foreground>'));
  assert.match(svg2, /rotate\(-30 20 20\)/, 'rotation attr SUBTRACTS (mxStencil.js:853)');
});

test('audit4: stencil missing strokewidth attr = 1*minScale, NOT the cell strokeWidth', async () => {
  // mxStencil.parseDescription defaults strokewidth to '1'; only the literal
  // 'inherit' uses the style value. 106 bundled stencils omit the attribute.
  const inner = '<background><rect x="0" y="0" w="60" h="50"/></background><foreground><fillstroke/></foreground>';
  const { svg } = await stencilSvgOf(stencilProbe(inner, 'strokeWidth=5;'));
  assert.match(svg, /stroke-width="2"/, 'absent strokewidth → 1 * minScale(2)');
  const { svg: svgInh } = await stencilSvgOf(stencilProbe(inner, 'strokeWidth=5;', ' strokewidth="inherit"'));
  assert.match(svgInh, /stroke-width="5"/, 'strokewidth="inherit" → cell strokeWidth');
});

test('audit4: stencil <fillalpha alpha="0"> makes the fill fully transparent', async () => {
  // parseFloat(a.alpha) || 1 treated alpha=0 as 1 (falsy-zero bug).
  const { svg } = await stencilSvgOf(stencilProbe(
    '<background><rect x="0" y="0" w="60" h="50"/></background>' +
    '<foreground><fillalpha alpha="0"/><fillstroke/></foreground>',
    'fillColor=#ff0000;'));
  assert.match(svg, /fill-opacity="0"/, 'alpha=0 must yield fill-opacity 0');
});

test('audit4: stencil <path rounded="1"> — exact addPoints geometry at su=2, arcSize unscaled', async () => {
  // Triangle (0,0)→(30,0)→(30,25)→(0,0), arcSize=4, su=2: points scale to
  // (0,0),(60,0),(60,50); first==last → auto-close pops the duplicate and the
  // virtual midpoint (30,25) between last and first becomes the path start
  // (mxShape.addPoints:1239-1245). arcSize stays UNSCALED (radius 4).
  const { svg, notices } = await stencilSvgOf(stencilProbe(
    '<background><path rounded="1" arcSize="4">' +
    '<move x="0" y="0"/><line x="30" y="0"/><line x="30" y="25"/><line x="0" y="0"/>' +
    '</path></background><foreground><fillstroke/></foreground>'));
  assert.equal(notices.length, 0);
  assert.ok(svg.includes(
    'd="M 30 25 L 3.073 2.561 Q 0 0 4 0 L 56 0 Q 60 0 60 4 L 60 46 Q 60 50 56.927 47.439 Z"'),
    `exact rounded-path geometry (got ${/d="([^"]*)"/.exec(svg)?.[1]})`);
});

test('audit4: stencil rounded path with multiple <move> splits into independent segments', async () => {
  const { svg, notices } = await stencilSvgOf(stencilProbe(
    '<background><path rounded="1" arcSize="4">' +
    '<move x="0" y="0"/><line x="20" y="0"/><line x="20" y="20"/>' +
    '<move x="30" y="0"/><line x="50" y="0"/>' +
    '</path></background><foreground><stroke/></foreground>'));
  assert.equal(notices.length, 0);
  assert.ok(svg.includes('d="M 0 0 L 36 0 Q 40 0 40 4 L 40 40 M 60 0 L 100 0"'),
    `multi-move rounded path segments (got ${/d="([^"]*)"/.exec(svg)?.[1]})`);
});

test('audit4: stencil rounded path with explicit <close/> parses regularly (drawio fallback)', async () => {
  // mxStencil only supports move/line inside rounded paths; <close/> flips it
  // back to the regular (UNROUNDED) parser — no Q commands.
  const { svg, notices } = await stencilSvgOf(stencilProbe(
    '<background><path rounded="1" arcSize="4">' +
    '<move x="0" y="0"/><line x="30" y="0"/><line x="30" y="25"/><close/>' +
    '</path></background><foreground><fillstroke/></foreground>'));
  assert.equal(notices.length, 0);
  assert.doesNotMatch(svg, /Q /, 'explicit close → regular (unrounded) parse');
  assert.match(svg, /d="M 0 0 L 60 0 L 60 50 Z"/);
});

test('audit4: stencil <dashpattern> values scale by minScale (then strokeWidth)', async () => {
  // mxStencil.js:897-916 multiplies each value by minScale; mxSvgCanvas2D
  // multiplies by strokeWidth. su=2, stencil sw=1*su=2 → 3 2 → 12 8.
  const { svg } = await stencilSvgOf(stencilProbe(
    '<background><rect x="0" y="0" w="60" h="50"/></background>' +
    '<foreground><dashed dashed="1"/><dashpattern pattern="3 2"/><fillstroke/></foreground>'));
  assert.match(svg, /stroke-dasharray="12 8"/,
    'dash pattern must be pattern*minScale*strokeWidth');
});

test('audit4: include-shape applies the direction rotation ONCE (outermost only)', async () => {
  // drawio rotates the canvas once for the whole shape; the included stencil
  // only recomputes aspect (scale swap + delta translate, mxStencil.js:497-508,
  // 862-874). The nested render used to wrap a second rotate(-90).
  const xml = stencilProbe(
    '<background><include-shape name="mxgraph.basic.4_point_star" x="0" y="0" w="60" h="50"/></background>' +
    '<foreground></foreground>',
    'direction=north;');
  const { svg, notices } = await stencilSvgOf(xml);
  assert.ok(!notices.some((n) => n.kind === 'ExporterUnsupportedStencilFeature'),
    `no stencil notice expected: ${notices.map((n) => n.message).join('; ')}`);
  const rotates = (svg.match(/rotate\(/g) || []).length;
  assert.equal(rotates, 1, `direction rotation must appear exactly once, got ${rotates}`);
  // nested delta translate: cell 120x100 north → outer frame 100x120; include
  // W=100, H=120 → delta=(100-120)/2=-10 → translate(-10,10).
  assert.match(svg, /translate\(-10,10\)/, 'nested aspect delta translate present');
});

// ---- audit5 router fixes: fixed-anchor perimeter projection + connection
// point order (mxGraph.getConnectionPoint parity) + marker bbox growth.

test('audit5: exitX/exitY anchors project onto the terminal PERIMETER by default', async () => {
  const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" style="ellipse;" parent="1"><mxGeometry x="200" y="100" width="100" height="100" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="20" y="20" width="40" height="20" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" style="edgeStyle=none;exitX=0;exitY=0;endArrow=none;" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && !n.fill && /^M /.test(n.d) && (n.d.match(/ L /g) || []).length === 1);
  // mxGraph.getConnectionPoint projects (200,100) onto the ellipse outline:
  // (214.64, 114.64) in model coords. Content min is (20,20)-anchored; the
  // vertex b at (20,20) defines origin (minus the 0.5 stroke halo).
  const m = /^M (-?[\d.]+) (-?[\d.]+)/.exec(edge.d);
  const ax = +m[1], ay = +m[2];
  assert.ok(Math.abs(ax - 195.14) < 1 && Math.abs(ay - 95.14) < 1,
    `anchor sits on the ellipse outline (~195.14,95.14 anchored), got ${ax},${ay}`);
});

test('audit5: exitPerimeter=0 keeps the raw fraction point (no projection)', async () => {
  const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" style="ellipse;" parent="1"><mxGeometry x="200" y="100" width="100" height="100" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="20" y="20" width="40" height="20" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" style="edgeStyle=none;exitX=0;exitY=0;exitPerimeter=0;endArrow=none;" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && !n.fill && /^M /.test(n.d) && (n.d.match(/ L /g) || []).length === 1);
  const m = /^M (-?[\d.]+) (-?[\d.]+)/.exec(edge.d);
  assert.ok(Math.abs(+m[1] - 180.5) < 1 && Math.abs(+m[2] - 80.5) < 1,
    `raw bbox corner (~180.5,80.5 anchored), got ${m[1]},${m[2]}`);
});

test('audit5: anchorPointDirection=0 skips the quarter-turn but bounds still rotate90', async () => {
  const { fixedConnectionPoint } = await import('./mx-edge-router.mjs');
  const b = { x: 200, y: 100, width: 100, height: 60 };
  // mxGraph.getConnectionPoint: south + apd=0, exitX=1,exitY=0.5 -> (280,130)
  const p = fixedConnectionPoint(b, { direction: 'south', anchorPointDirection: 0 }, 1, 0.5, 0, 0, false);
  assert.ok(Math.abs(p.x - 280) < 0.001 && Math.abs(p.y - 130) < 0.001, JSON.stringify(p));
  // flips apply BEFORE the quarter-turn: south+flipH, exitX=1,exitY=0.25 -> (225,160)
  const q = fixedConnectionPoint(b, { direction: 'south', flipH: 1 }, 1, 0.25, 0, 0, false);
  assert.ok(Math.abs(q.x - 225) < 0.001 && Math.abs(q.y - 160) < 0.001, JSON.stringify(q));
});

test('audit5: auto-fit paper grows for marker ink (no cropped arrowheads)', async () => {
  const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="e" edge="1" style="edgeStyle=none;endArrow=classic;" parent="1">
      <mxGeometry relative="1" as="geometry"><mxPoint x="0" y="40" as="sourcePoint"/><mxPoint x="200" y="40" as="targetPoint"/></mxGeometry></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const page = contract.document.pages[0];
  // classic marker wings span ±(size+sw)/2 = ±3.5 around the line; page must
  // be at least that tall (was 1px before the augmentBoundingBox growth).
  assert.ok(page.size.h >= 7, `page tall enough for marker wings, got ${page.size.h}`);
});

// ─── audit5: builtin-shape fidelity (gradients/shadow/glass/shape ports) ────

// Bake a single styled vertex and return { nodes, notices, svgs } where svgs
// are the decoded kind:'svg' sources in paint order.
async function bakeVertexProbe(style, geo = { x: 20, y: 20, w: 100, h: 60 }, value = '') {
  const xml = `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="v" vertex="1" value="${value}" style="${style}" parent="1">
      <mxGeometry x="${geo.x}" y="${geo.y}" width="${geo.w}" height="${geo.h}" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract, notices } = await bake(xml, { keepPx: true });
  const nodes = contract.document.pages[0].paint;
  const svgs = nodes.filter((n) => n.kind === 'svg')
    .map((n) => Buffer.from(n.source, 'base64').toString('utf8'));
  return { nodes, notices, svgs };
}

test('audit5: builtin shapes render a REAL gradient (process probe)', async () => {
  // Previously builtinShapeSvg passed an empty gradId to fillSvgAttr — every
  // builtin shape (process/plus/cylinder3/component/...) silently dropped its
  // gradient to solid fillColor.
  const { svgs, notices } = await bakeVertexProbe(
    'shape=process;fillColor=#ff0000;gradientColor=#0000ff;gradientDirection=east;');
  assert.equal(notices.length, 0);
  const s = svgs.find((x) => /linearGradient/.test(x));
  assert.ok(s, 'process emits a linearGradient def');
  assert.match(s, /x1="0" y1="0" x2="1" y2="0"/, 'gradientDirection=east axis');
  assert.match(s, /<stop offset="0" stop-color="#ff0000"\/>/);
  assert.match(s, /<stop offset="1" stop-color="#0000ff"\/>/);
  assert.match(s, /fill="url\(#b[a-z0-9]+\)"/, 'background filled with the gradient');
  // fill-opacity composes with the gradient (mxSvgCanvas2D alpha*fillAlpha)
  const { svgs: op } = await bakeVertexProbe(
    'shape=cylinder3;fillColor=#ff0000;gradientColor=#0000ff;fillOpacity=50;');
  assert.match(op.find((x) => /linearGradient/.test(x)),
    /fill="url\(#b[a-z0-9]+\)" fill-opacity="0\.5"/, 'gradient honors fillOpacity');
});

test('audit5: builtin shapes paint shadow=1 (cylinder3 probe)', async () => {
  // Previously shadow=1 was silently dropped on the builtin branch. drawio:
  // the shadow is the shape repainted in the APP's SHADOWCOLOR #000000 at
  // SHADOW_OPACITY 0.25 (Graph.js overrides), offset (2,3), UNDER the shape.
  const { nodes, svgs } = await bakeVertexProbe('shape=cylinder3;shadow=1;fillColor=#dae8fc;');
  const svgNodes = nodes.filter((n) => n.kind === 'svg');
  assert.equal(svgNodes.length, 2, 'shadow node + shape node');
  const [shadow, body] = svgs;
  assert.match(shadow, /<g opacity="0.25">/, 'shadow composited at SHADOW_OPACITY once');
  assert.match(shadow, /fill="#000000"/, 'shadow fill recolored to SHADOWCOLOR');
  assert.match(shadow, /stroke="#000000"/, 'shadow stroke recolored to SHADOWCOLOR');
  assert.ok(!/#dae8fc/.test(shadow), 'no original colors left in the shadow copy');
  assert.ok(/#dae8fc/.test(body), 'body keeps its own fill');
  // offset (2,3) in page space
  assert.ok(Math.abs((svgNodes[1].box.x + 2) - svgNodes[0].box.x) < 0.001 &&
            Math.abs((svgNodes[1].box.y + 3) - svgNodes[0].box.y) < 0.001,
    `shadow box offset by (2,3): ${JSON.stringify([svgNodes[0].box, svgNodes[1].box])}`);
  // fill=none stays none in the shadow copy (stroke-only sub-paths)
  assert.match(shadow, /fill="none"/, 'stroke-only lid keeps fill=none');
});

test('audit5: builtin glass=1 — painted for the mxRectangleShape family, under the fg lines', async () => {
  // drawio paints glass only where paintGlassEffect is called:
  // mxRectangleShape.paintForeground (process/plus/internalStorage) and the
  // swimlane/table HEADER. mxCylinder shapes never paint glass in drawio.
  const { svgs } = await bakeVertexProbe('shape=process;glass=1;fillColor=#dae8fc;');
  const s = svgs.find((x) => /glassg/.test(x));
  assert.ok(s, 'process paints the glass overlay');
  // glass BEFORE the foreground inset lines (lines paint over the highlight)
  assert.ok(s.indexOf('fill="url(#glassg)"') < s.indexOf('<line x1='),
    'glass under the process lines');
  // cylinder3: drawio paints NO glass (mxCylinder has no paintGlassEffect call)
  const { svgs: cy } = await bakeVertexProbe('shape=cylinder3;glass=1;fillColor=#dae8fc;');
  assert.ok(!cy.some((x) => /glassg/.test(x)), 'cylinder3 has no glass in drawio');
  // table: glass covers the HEADER region only (mxSwimlane.js:267-270)
  const { svgs: tb } = await bakeVertexProbe('shape=table;startSize=30;glass=1;fillColor=#dae8fc;');
  const tbs = tb.find((x) => /glassg/.test(x));
  assert.ok(tbs, 'table paints glass');
  assert.match(tbs, /y2="18"/, 'glass gradient extent = header h*0.6 = 18, not the full table');
});

test('audit5: note fold opacity = |darkOpacity| * cell opacity (setFillAlpha semantics)', async () => {
  // NoteShape calls c.setFillAlpha(|op|), REPLACING fillAlpha, so the fold
  // paints at alpha*|op| (mxSvgCanvas2D.updateFill = alpha*fillAlpha).
  // Previously the fold ignored the cell's base opacity.
  const { svgs } = await bakeVertexProbe('shape=note;darkOpacity=0.5;opacity=50;size=20;');
  const s = svgs.join('');
  assert.match(s, /fill="#000000" fill-opacity="0\.25"/, 'fold at 0.5*0.5 = 0.25');
  const { svgs: plain } = await bakeVertexProbe('shape=note;darkOpacity=0.5;size=20;');
  assert.match(plain.join(''), /fill="#000000" fill-opacity="0\.5"/, 'no base opacity -> |op|');
});

test('audit5: stencilFlipH/V are IGNORED on non-stencil shapes (mxShape.js:1410-1415)', async () => {
  // mxShape.apply ORs stencilFlip* into flipH/V only when a stencil exists.
  const plain = await bakeVertexProbe('shape=parallelogram;');
  const sflip = await bakeVertexProbe('shape=parallelogram;stencilFlipH=1;');
  const flip = await bakeVertexProbe('shape=parallelogram;flipH=1;');
  const dOf = (r) => r.nodes.find((n) => n.kind === 'path').d;
  assert.equal(dOf(sflip), dOf(plain), 'stencilFlipH must not mirror a non-stencil shape');
  assert.notEqual(dOf(flip), dOf(plain), 'flipH still mirrors');
  // builtin branch (note dog-ear is asymmetric): stencilFlipH must not wrap a flip group
  const noteS = await bakeVertexProbe('shape=note;stencilFlipH=1;');
  assert.ok(!/scale\(-1,1\)/.test(noteS.svgs.join('')), 'note ignores stencilFlipH');
});

test('audit5: internalStorage — rounded background + dx/dy raised to the corner inset', async () => {
  // InternalStorageShape extends mxRectangleShape (Shapes.js:3402-3446):
  // rounded=1 -> rounded rect bg; inset = min(w*f, h*f), f = arcSize/100
  // (default 15); dx/dy = max(inset, min(w|h, dx|dy)). Previously rounded was
  // silently square and the clamp was missing.
  const { svgs, notices } = await bakeVertexProbe(
    'shape=internalStorage;rounded=1;arcSize=30;', { x: 20, y: 20, w: 120, h: 80 });
  assert.equal(notices.length, 0);
  const s = svgs[0];
  // rounded background: arc commands, radius min(120,80)*0.3 = 24
  assert.match(s, /<path d="M 24 0[^"]* A 24 24 /, 'rounded rect background r=24');
  // inset = min(120*0.3, 80*0.3) = 24 > dx/dy default 20 -> dividers at 24
  assert.match(s, /M 0 24 L 120 24 M 24 0 L 24 80/, 'dividers raised to inset 24');
});

test('audit5: requiredInterface / providedRequiredInterface match Shapes.js', async () => {
  // RequiredInterfaceShape: STROKE-ONLY open arc M0,0 Qw,0 w,h/2 Qw,h 0,h —
  // previously printed as a filled full ellipse.
  const { svgs } = await bakeVertexProbe('shape=requiredInterface;fillColor=#ff0000;');
  assert.match(svgs[0], /<path d="M 0 0 Q 100 0 100 30 Q 100 60 0 60" fill="none"/,
    'requiredInterface is the open stroke-only arc');
  assert.ok(!/#ff0000/.test(svgs[0]), 'never filled');
  // ProvidedRequiredInterfaceShape: ellipse inset by (inset default 2)+sw,
  // fillAndStroke, plus the open arc from w/2.
  const { svgs: pri } = await bakeVertexProbe('shape=providedRequiredInterface;fillColor=#ff0000;');
  assert.match(pri[0], /<ellipse cx="47" cy="30" rx="47" ry="27" fill="#ff0000"/,
    'inset ellipse (inset 2 + sw 1 = 3) fillAndStroke');
  assert.match(pri[0], /<path d="M 50 0 Q 100 0 100 30 Q 100 60 50 60" fill="none"/,
    'open provided arc stroke-only');
});

test('audit5: module — jetty body + stroke-only jetty boxes (ModuleShape geometry)', async () => {
  // ModuleShape (Shapes.js:3141-3179): jettyWidth 20 / jettyHeight 10;
  // x0=10, x1=20, y0=min(10,h-10)=10, y1=min(30,h-10)=30. Previously a rect.
  const { svgs, notices } = await bakeVertexProbe('shape=module;fillColor=#dae8fc;',
    { x: 20, y: 20, w: 100, h: 80 });
  assert.equal(notices.length, 0);
  assert.match(svgs[0],
    /<path d="M 10 0 L 100 0 L 100 80 L 10 80 L 10 40 L 0 40 L 0 30 L 10 30 L 10 20 L 0 20 L 0 10 L 10 10 Z" fill="#dae8fc"/,
    'notched body polygon fillAndStroke');
  assert.match(svgs[0],
    /<path d="M 10 10 L 20 10 L 20 20 L 10 20 M 10 30 L 20 30 L 20 40 L 10 40" fill="none"/,
    'stroke-only jetty outlines');
});

test('audit5: umlFrame — title pentagon + L-border + label in the title box', async () => {
  // UmlFrame (Shapes.js:2605-2650): title pentagon (defaults 60x30, corner
  // 10) filled with fillColor; body L-border stroke-only; swimlaneFillColor
  // (default none) fills the full frame. Previously a fillColor-filled rect.
  const { nodes, svgs, notices } = await bakeVertexProbe(
    'shape=umlFrame;fillColor=#ffe6cc;', { x: 20, y: 20, w: 200, h: 120 }, 'sd Frame');
  assert.equal(notices.length, 0);
  const s = svgs[0];
  assert.match(s, /<path d="M 0 0 L 60 0 L 60 15 L 50 30 L 0 30 Z" fill="#ffe6cc"/,
    'title pentagon: w0=60, h0=30, corner cut 10/15');
  assert.match(s, /<path d="M 60 0 L 200 0 L 200 120 L 0 120 L 0 30" fill="none"/,
    'body L-border stroke-only (no fillColor body fill)');
  assert.equal((s.match(/fill="#ffe6cc"/g) || []).length, 1, 'fillColor only fills the title');
  // label constrained to the title box (UmlFrame.getLabelMargins)
  const lbl = nodes.find((n) =>
    (n.kind === 'text') ||
    (n.kind === 'svg' && /sd Frame/.test(Buffer.from(n.source, 'base64').toString('utf8'))));
  const frameNode = nodes.find((n) => n.kind === 'svg');
  assert.ok(lbl && lbl.box.w <= 60 + 4 && lbl.box.h <= 30 + 4 &&
    Math.abs(lbl.box.x - (frameNode.box.x + 0.5)) < 4 &&
    Math.abs(lbl.box.y - (frameNode.box.y + 0.5)) < 4,
    `label in the 60x30 title box, got ${JSON.stringify(lbl && lbl.box)}`);
  // swimlaneFillColor paints the full-frame background
  const { svgs: bg } = await bakeVertexProbe(
    'shape=umlFrame;fillColor=#ffe6cc;swimlaneFillColor=#f5f5f5;', { x: 20, y: 20, w: 200, h: 120 });
  assert.match(bg[0], /<rect x="0" y="0" width="200" height="120" fill="#f5f5f5" stroke="none"\/>/,
    'swimlaneFillColor full-rect background');
});

test('audit5: table — title row fillColor, body swimlaneFillColor (default transparent)', async () => {
  // TableShape extends mxSwimlane: previously the BODY was wrongly filled
  // with fillColor.
  const { svgs } = await bakeVertexProbe('shape=table;startSize=30;fillColor=#dae8fc;',
    { x: 20, y: 20, w: 180, h: 120 });
  const s = svgs[0];
  assert.match(s, /<path d="M 0 30 L 0 0 L 180 0 L 180 30" fill="#dae8fc"/, 'header filled');
  assert.match(s, /<path d="M 0 30 L 0 120 L 180 120 L 180 30" fill="none"/, 'body transparent');
  assert.match(s, /<line x1="0" y1="30" x2="180" y2="30"/, 'divider at startSize');
  const { svgs: lane } = await bakeVertexProbe(
    'shape=table;startSize=30;fillColor=#dae8fc;swimlaneFillColor=#fff2cc;',
    { x: 20, y: 20, w: 180, h: 120 });
  assert.match(lane[0], /<path d="M 0 30 L 0 120 L 180 120 L 180 30" fill="#fff2cc"/,
    'swimlaneFillColor fills the body');
  // swimlaneLine=0 removes the divider
  const { svgs: noLine } = await bakeVertexProbe(
    'shape=table;startSize=30;swimlaneLine=0;fillColor=#dae8fc;', { x: 20, y: 20, w: 180, h: 120 });
  assert.ok(!/<line /.test(noLine[0]), 'swimlaneLine=0 -> no divider');
});

test('audit5: mermaidBlockArrow — faithful dirs/nodePadding polygon, round join', async () => {
  // Previously silently mapped to singleArrowPath (a different shape).
  // dirs default 'right', nodePadding 8 -> pad 4, midpoint h/2=30; points per
  // MermaidBlockArrowShape (px, h+py).
  const { svgs, notices } = await bakeVertexProbe('shape=mermaidBlockArrow;fillColor=#dae8fc;');
  assert.equal(notices.length, 0, 'faithful port, no unsupported-shape notice');
  assert.match(svgs[0],
    /<path d="M 30 56 L 70 56 L 70 60 L 100 30 L 70 0 L 70 4 L 30 4 Z" fill="#dae8fc"/,
    'dirs=right block-arrow polygon');
  assert.match(svgs[0], /stroke-linejoin="round"/, 'forced round line join');
  // bidirectional x: pointed both ends
  const { svgs: x2 } = await bakeVertexProbe('shape=mermaidBlockArrow;dirs=x;fillColor=#dae8fc;');
  assert.match(x2[0],
    /<path d="M 30 60 L 30 56 L 70 56 L 70 60 L 100 30 L 70 0 L 70 4 L 30 4 L 30 0 L 0 30 Z"/,
    'dirs=x double-headed polygon');
});

test('audit5: swimlane direction!=east emits a LOUD notice (never silent)', async () => {
  const { notices } = await bakeVertexProbe('swimlane;direction=south;startSize=30;');
  assert.ok(notices.some((n) => /swimlane direction=\\?"south\\?"/.test(JSON.stringify(n))),
    `loud notice for swimlane direction, got ${JSON.stringify(notices)}`);
  const { notices: east } = await bakeVertexProbe('swimlane;startSize=30;');
  assert.ok(!east.some((n) => /swimlane direction/.test(JSON.stringify(n))), 'east stays quiet');
});

test('audit5: plain vertex direction= follows mxShape.getShapeRotation exactly', async () => {
  // direction=south on a shape-less 100x60 rect: mxShape inverts the paint
  // bounds (60x100 about the same centre) then rotates +90 — landing exactly
  // back on the 100x60 box. The path must be that rotated footprint-swapped
  // rect (covering the SAME box), not a 60x100 one.
  const { nodes } = await bakeVertexProbe('rounded=0;direction=south;');
  const d = nodes.find((n) => n.kind === 'path').d;
  const pts = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  // Page-relative anchoring (explicit page dims): the probe cell sits at
  // (20,20), so the rotated footprint covers exactly its authored box.
  assert.equal(Math.min(...xs), 20); assert.equal(Math.max(...xs), 120);
  assert.equal(Math.min(...ys), 20); assert.equal(Math.max(...ys), 80);
  // ellipse footprint visibly swaps under the rotation: rx 30 / ry 50 with a
  // 90-degree arc x-axis rotation = a 100x60-looking ellipse (faithful).
  const { nodes: el } = await bakeVertexProbe('ellipse;direction=south;');
  assert.match(el.find((n) => n.kind === 'path').d, /A 30 50 90 /,
    'ellipse paints in the inverted 60x100 frame rotated +90');
});

test('audit7: explicit page dims keep the authored on-page placement', async () => {
  // HIGH-severity audit finding: with pageWidth/pageHeight set, the bake
  // anchored to CONTENT bounds, printing every diagram flush at the paper
  // corner -- the author's page margins were silently dropped on every
  // production print. Page-relative anchoring must keep model coords.
  const xml = `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="rounded=0;" parent="1">
      <mxGeometry x="150" y="100" width="80" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const d = contract.document.pages[0].paint.find((n) => n.kind === 'path').d;
  assert.match(d, /^M 150 100 /, `cell must stay at (150,100), got: ${d.slice(0, 30)}`);

  // Auto-fit page (no page dims): bounds-anchoring stays (content flush).
  const auto = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="rounded=0;" parent="1">
      <mxGeometry x="150" y="100" width="80" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract: c2 } = await bake(auto, { keepPx: true });
  const d2 = c2.document.pages[0].paint.find((n) => n.kind === 'path').d;
  assert.match(d2, /^M 0 0 /, `auto-fit stays flush, got: ${d2.slice(0, 30)}`);

  // Content drawn on a FAR page-grid cell prints on that sheet with the
  // same in-page margins (mxPrintPreview floor() semantics).
  const far = `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="rounded=0;" parent="1">
      <mxGeometry x="850" y="640" width="80" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract: c3 } = await bake(far, { keepPx: true });
  const d3 = c3.document.pages[0].paint.find((n) => n.kind === 'path').d;
  // grid cell (2,2): origin (800,600) -> in-page position (50,40)
  assert.match(d3, /^M 50 40 /, `far grid cell keeps margins, got: ${d3.slice(0, 30)}`);
});

test('audit7: edge to a hidden-layer terminal is dropped like the editor', async () => {
  // mxGraphView.updateEdgeState removes any edge whose connected terminal
  // has no visible state; the bake printed the edge into empty space.
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="L2" value="hidden layer" style="" parent="0" visible="0"/>
    <mxCell id="a" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="0" y="40" width="100" height="20" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="L2"><mxGeometry x="200" y="40" width="100" height="20" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const paths = contract.document.pages[0].paint.filter((n) => n.kind === 'path');
  // Only the visible vertex body: no edge stroke reaching x>=100.
  for (const p of paths) {
    const xs = [...p.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => +m[1]);
    assert.ok(Math.max(...xs) <= 101, `edge to hidden terminal leaked ink: ${p.d.slice(0, 60)}`);
  }
});

test('audit7: bare orthogonal=1 flag projects floating terminals orthogonally', async () => {
  // mxGraph.isOrthogonal honors the bare style flag without any edgeStyle.
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="0" y="0" width="100" height="100" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="160" y="25" width="100" height="50" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" style="orthogonal=1;endArrow=none;" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.filter((n) => n.kind === 'path').pop();
  const pts = [...edge.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  // Orthogonal projection -> a horizontal segment at the shared band's y=50.
  assert.ok(pts.every((p) => Math.abs(p[1] - 50) < 0.5),
    `expected horizontal y=50 edge, got ${edge.d}`);
});

test('audit7: floating edge between OVERLAPPING shapes attaches like the editor', async () => {
  // mx computes the target point first, then aims the source at that POINT.
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="0" y="0" width="100" height="100" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="20" y="20" width="200" height="200" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" style="endArrow=none;" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const edge = contract.document.pages[0].paint.filter((n) => n.kind === 'path').pop();
  const pts = [...edge.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  const start = pts[0];
  // drawio: target point = b's perimeter toward a's center (20,20); source
  // then aims at that point -> source attaches at its own (0,0)-ward corner
  // ray, NOT flipped to the far side.
  assert.ok(start[0] <= 50 && start[1] <= 50,
    `source attached on the wrong side: ${edge.d.slice(0, 50)}`);
});

test('audit7: z-order follows DOCUMENT order for integer-like ids', async () => {
  // JS objects iterate integer-like keys numerically; with ids "10" and "9"
  // declared as 10-then-9 ("9" sent to front), the dict walk painted 10 on
  // top — inverted stacking. The model tree walk must follow XML order.
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="10" vertex="1" style="rounded=0;fillColor=#ff0000;" parent="1"><mxGeometry x="10" y="10" width="60" height="40" as="geometry"/></mxCell>
    <mxCell id="9" vertex="1" style="rounded=0;fillColor=#0000ff;" parent="1"><mxGeometry x="30" y="20" width="60" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const fills = contract.document.pages[0].paint
    .filter((n) => n.kind === 'path' && n.fill)
    .map((n) => n.fill.color);
  // id 9 is declared LAST -> paints LAST (on top), regardless of numeric order.
  assert.deepEqual(fills, ['#ff0000', '#0000ff'],
    `document order must win: ${fills.join(',')}`);
});

test('audit7: bezier=1 edges paint cubic curves through the control points', async () => {
  // mxPolyline checks STYLE_BEZIER before curved: 3n+1 points are direct
  // cubic control points. Previously baked as a straight polyline THROUGH
  // the control points with no notice.
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="e" edge="1" style="bezier=1;endArrow=none;noEdgeStyle=1;" parent="1">
      <mxGeometry relative="1" as="geometry">
        <mxPoint x="0" y="50" as="sourcePoint"/><mxPoint x="300" y="50" as="targetPoint"/>
        <Array as="points"><mxPoint x="100" y="150"/><mxPoint x="200" y="150"/></Array>
      </mxGeometry>
    </mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const e = contract.document.pages[0].paint.find((n) => n.kind === 'path');
  // Structural: exactly ONE cubic whose controls are the two waypoints
  // (auto-fit anchoring may translate all coordinates uniformly).
  const m = e.d.match(/^M ([\d.]+) ([\d.]+) C ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)$/);
  assert.ok(m, `bezier edge must be one cubic: ${e.d}`);
  const [, sx, sy, c1x, c1y, c2x, c2y, ex2, ey] = m.map(Number);
  assert.equal(c1x - sx, 100); assert.equal(c1y - sy, 100);
  assert.equal(c2x - sx, 200); assert.equal(c2y - sy, 100);
  assert.equal(ex2 - sx, 300); assert.equal(ey - sy, 0);
});

test('audit7: shadow=1 edges paint the offset shadow line under the edge', async () => {
  // mxConnector paints the LINE with the shadow (markers without): the
  // shadow stroke is the app ink #000000@0.25 offset (2,3), painted first.
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="0" y="40" width="60" height="20" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="200" y="40" width="60" height="20" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" style="shadow=1;endArrow=none;" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const paths = contract.document.pages[0].paint.filter((n) => n.kind === 'path' && n.fill == null);
  const shadow = paths.find((n) => n.stroke && n.stroke.paint.color === '#000000' && n.stroke.paint.alpha === 0.25);
  assert.ok(shadow, 'edge shadow stroke present');
  const line = paths.find((n) => n !== shadow);
  assert.ok(contract.document.pages[0].paint.indexOf(shadow) <
            contract.document.pages[0].paint.indexOf(line), 'shadow paints under the line');
  const sm = shadow.d.match(/^M ([\d.]+) ([\d.]+)/), lm = line.d.match(/^M ([\d.]+) ([\d.]+)/);
  assert.ok(Math.abs((+sm[1]) - (+lm[1]) - 2) < 0.01 && Math.abs((+sm[2]) - (+lm[2]) - 3) < 0.01,
    `shadow offset (2,3): shadow ${sm[1]},${sm[2]} vs line ${lm[1]},${lm[2]}`);
});

test('audit7: perimeterSpacing semantics match mxGraphView (terminal style, fixed anchors, diagonals)', async () => {
  const page = (body) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>${body}</root></mxGraphModel>`;
  const firstEdge = (contract) => contract.document.pages[0].paint
    .find((n) => n.kind === 'path' && n.fill == null && n.stroke);
  // (a) the TERMINAL's own perimeterSpacing style creates the gap too
  // (mxGraphView.getPerimeterBounds adds it to the edge's border).
  const a = await bake(page(`
    <mxCell id="a" vertex="1" style="rounded=0;perimeterSpacing=10;" parent="1"><mxGeometry x="0" y="40" width="60" height="20" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="200" y="40" width="60" height="20" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" style="endArrow=none;" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`),
    { keepPx: true });
  const am = firstEdge(a.contract).d.match(/^M ([\d.]+) /);
  // a's right side is at x=60; +10 spacing -> 70 (minus the bake's content
  // translation, which moved x=-10 ink to 0 -> source at 80? No: auto-fit
  // shifts ALL coords uniformly; measure the GAP via the target end).
  const pts = [...firstEdge(a.contract).d.matchAll(/([\d.]+) ([\d.]+)/g)].map((m) => +m[1]);
  const gap = pts[pts.length - 1] - pts[0];
  // span between endpoints: from 60+10 to 200 (no target spacing) = 130.
  assert.ok(Math.abs(gap - 130) < 0.5, `terminal-style spacing honored: span ${gap}`);

  // (c) FIXED exitX/exitY anchors are never spaced (mxGraph applies border
  // to floating terminals only).
  const c = await bake(page(`
    <mxCell id="a" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="0" y="40" width="60" height="20" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="200" y="40" width="60" height="20" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" style="endArrow=none;perimeterSpacing=20;exitX=1;exitY=0.5;" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`),
    { keepPx: true });
  const cpts = [...firstEdge(c.contract).d.matchAll(/([\d.]+) ([\d.]+)/g)].map((m) => +m[1]);
  // fixed source anchor at x=60 exactly; floating target spaced to 180:
  // span = 120.
  assert.ok(Math.abs((cpts[cpts.length - 1] - cpts[0]) - 120) < 0.5,
    `fixed anchor unspaced, floating end spaced: span ${cpts[cpts.length - 1] - cpts[0]}`);
});

test('audit7: noLabel=1 suppresses the label like mxGraph.getLabel', async () => {
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="SECRET" style="rounded=0;noLabel=1;" parent="1"><mxGeometry x="10" y="10" width="80" height="30" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract, notices } = await bake(xml, { keepPx: true });
  for (const n of contract.document.pages[0].paint) {
    if (n.kind === 'svg') {
      const s = Buffer.from(n.source, 'base64').toString('utf8');
      assert.ok(!/SECRET/.test(s), 'noLabel=1 label must not print');
    }
  }
  assert.equal(notices.length, 0);
});

test('audit7: clipped middle/bottom labels show the FIRST lines (plainText clamp)', async () => {
  // mxSvgCanvas2D.plainText (matchHtmlAlignment): the effective text height
  // is clamped to the box before valign, so overflow=hidden shows lines from
  // the TOP. The unclamped offset clipped away line 1 and showed the middle.
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="L1&#xa;L2&#xa;L3&#xa;L4&#xa;L5&#xa;L6" style="rounded=0;overflow=hidden;verticalAlign=middle;" parent="1"><mxGeometry x="10" y="10" width="100" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const node = contract.document.pages[0].paint.find((n) => {
    if (n.kind !== 'svg') return false;
    return /L1/.test(Buffer.from(n.source, 'base64').toString('utf8'));
  });
  const s = Buffer.from(node.source, 'base64').toString('utf8');
  const firstY = parseFloat(/<text[^>]*y="(-?[\d.]+)"/.exec(s)[1]);
  // clamped: y = (40 - min(6*14, 40))/2 = 0 -> line 1 fully inside the clip.
  assert.ok(firstY >= -0.01 && firstY < 2, `first line stays visible (y=${firstY})`);
});

test('audit7: vertical-lr textDirection is LOUD, never a silent horizontal print', async () => {
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="V" style="rounded=0;textDirection=vertical-lr;" parent="1"><mxGeometry x="10" y="10" width="80" height="30" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { notices } = await bake(xml, { keepPx: true });
  assert.ok(notices.some((n) => /vertical textDirection/.test(n.detail.detail || n.detail || '')),
    `loud notice expected: ${JSON.stringify(notices)}`);
});

test('audit7: edge labels honor align=left/right and rotation=', async () => {
  const page = (lblStyle) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="0" y="40" width="40" height="20" as="geometry"/></mxCell>
    <mxCell id="b" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="400" y="40" width="40" height="20" as="geometry"/></mxCell>
    <mxCell id="e" edge="1" style="endArrow=none;" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="l" value="Cardinality" style="edgeLabel;${lblStyle}" vertex="1" connectable="0" parent="e"><mxGeometry x="0" relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const labelBox = (contract) => contract.document.pages[0].paint.find((n) => {
    if (n.kind !== 'svg') return false;
    return /Cardinality/.test(Buffer.from(n.source, 'base64').toString('utf8'));
  }).box;
  // mxUtils.getAlignmentAsPoint: left puts the label's LEFT edge at the
  // anchor (edge midpoint, x=220), right its RIGHT edge; center straddles.
  const left = labelBox((await bake(page('align=left;'), { keepPx: true })).contract);
  const right = labelBox((await bake(page('align=right;'), { keepPx: true })).contract);
  const center = labelBox((await bake(page('align=center;'), { keepPx: true })).contract);
  const cx = 220;
  const PAD = 6; // svg node box pad/overflow slop
  assert.ok(Math.abs(left.x - cx) < PAD, `left-aligned label starts at the anchor (x=${left.x})`);
  assert.ok(Math.abs((right.x + right.w) - cx) < PAD, `right-aligned label ends at the anchor`);
  assert.ok(Math.abs((center.x + center.w / 2) - cx) < PAD, `centered label straddles the anchor`);

  // rotation= on the label child must reach the printed SVG (was dropped).
  const rot = (await bake(page('align=center;rotation=45;'), { keepPx: true })).contract;
  const rotNode = rot.document.pages[0].paint.find((n) => {
    if (n.kind !== 'svg') return false;
    return /Cardinality/.test(Buffer.from(n.source, 'base64').toString('utf8'));
  });
  assert.match(Buffer.from(rotNode.source, 'base64').toString('utf8'), /rotate\(45 /,
    'label rotation transform present');
});

test('audit7: external label bands are FULL cell extent (mxGraphView/mxCellRenderer)', async () => {
  const page = (style) => `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="XYZ" style="rounded=0;${style}" parent="1"><mxGeometry x="100" y="100" width="120" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const labelNode = (contract) => contract.document.pages[0].paint.find((n) => {
    if (n.kind !== 'svg') return false;
    return /XYZ/.test(Buffer.from(n.source, 'base64').toString('utf8'));
  });
  // verticalLabelPosition=bottom + verticalAlign=middle: drawio offsets the
  // label box by the FULL cell height with the SAME height -> the text
  // centers ~30px below the cell bottom (the old fontSize-derived band put
  // it ~9px below: 21px off).
  const b = labelNode((await bake(page('verticalLabelPosition=bottom;verticalAlign=middle;'), { keepPx: true })).contract);
  const cyB = b.box.y + b.box.h / 2;
  assert.ok(Math.abs(cyB - 190) < 8, `bottom band centers at cell.bottom + h/2 = 190 (got ${cyB})`);
  // labelPosition=left + align=center: band width = CELL width (120), so the
  // text centers 60px left of the cell (the old max(w, fs*8) band shifted it).
  const l = labelNode((await bake(page('labelPosition=left;align=center;'), { keepPx: true })).contract);
  const cxL = l.box.x + l.box.w / 2;
  assert.ok(Math.abs(cxL - 40) < 8, `left band centers at cell.x - w/2 = 40 (got ${cxL})`);
});

test('audit7: labelWidth overrides the wrap width and aligns inside the cell', async () => {
  const page = (style) => `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="wrap me over the label width please thanks" style="rounded=0;whiteSpace=wrap;${style}" parent="1"><mxGeometry x="100" y="100" width="100" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const labelSvg = (contract) => {
    const n = contract.document.pages[0].paint.find((n2) => {
      if (n2.kind !== 'svg') return false;
      return /wrap me/.test(Buffer.from(n2.source, 'base64').toString('utf8'));
    });
    return Buffer.from(n.source, 'base64').toString('utf8');
  };
  const narrow = labelSvg((await bake(page(''), { keepPx: true })).contract);
  const wide = labelSvg((await bake(page('labelWidth=200;'), { keepPx: true })).contract);
  const lines = (s) => (s.match(/<text/g) || []).length;
  assert.ok(lines(wide) < lines(narrow),
    `labelWidth=200 must wrap fewer lines than the 100px cell (${lines(wide)} vs ${lines(narrow)})`);
});

test('audit7: relative child of a ROTATED parent rotates around the parent center', async () => {
  // mxGraphView.updateVertexState rotates a relative child's center about
  // the parent center; the bake printed it at the unrotated spot while the
  // parent body rotated away.
  const xml = `<mxGraphModel pageWidth="600" pageHeight="400"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="g" vertex="1" style="rounded=0;rotation=90;" parent="1"><mxGeometry x="100" y="100" width="200" height="100" as="geometry"/></mxCell>
    <mxCell id="c" vertex="1" value="" style="rounded=0;fillColor=#ff0000;" parent="g"><mxGeometry x="1" y="1" relative="1" width="40" height="20" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const child = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && n.fill && n.fill.color === '#ff0000');
  const xs = [...child.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  const cx = (Math.min(...xs.map((p) => p[0])) + Math.max(...xs.map((p) => p[0]))) / 2;
  const cy = (Math.min(...xs.map((p) => p[1])) + Math.max(...xs.map((p) => p[1]))) / 2;
  // parent center (200,150); child unrotated center (320,210); rotated 90deg
  // -> (200 - (210-150), 150 + (320-200)) = (140, 270).
  assert.ok(Math.abs(cx - 140) < 0.5 && Math.abs(cy - 270) < 0.5,
    `child center must rotate with the parent: got (${cx},${cy})`);
});

test('audit7: flipH on a GIF image cell reaches the printed SVG (non-PNG flip)', async () => {
  const gif = 'R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==';
  const xml = `<mxGraphModel pageWidth="200" pageHeight="100"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=image;flipH=1;image=data:image/gif,${gif};" parent="1"><mxGeometry x="10" y="10" width="60" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const node = contract.document.pages[0].paint.find((n) => n.kind === 'svg' &&
    /image\/gif/.test(Buffer.from(n.source, 'base64').toString('utf8')));
  assert.ok(node, 'gif image baked as svg-wrapped node');
  assert.match(Buffer.from(node.source, 'base64').toString('utf8'), /scale\(-1 1\)/,
    'flipH transform present');
});

test('audit7: pages: [] is a loud refusal, never "print everything"', async () => {
  const xml = `<mxGraphModel pageWidth="100" pageHeight="50"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>`;
  await assert.rejects(() => bake(xml, { pages: [] }), RangeError);
});

// ---------------------------------------------------------------------------
// audit7 registry shape fidelity: registered shapes that previously baked to a
// WRONG silhouette with NO notice. Every expectation below is pinned against
// the actual painter in src/main/webapp/js/grapheditor/Shapes.js (line refs in
// each test). Probes use auditProbe (cell at page origin, keepPx).
// ---------------------------------------------------------------------------

test('audit7 shape: or is the D-shape M0,0 Q(w,0)(w,h/2) Q(w,h)(0,h) Z (Shapes.js:3639)', async () => {
  const { contract, notices } = await auditProbe('shape=or;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  assert.equal(contract.document.pages[0].paint[0].d,
    'M 0 0 C 66.667 0 100 10 100 30 C 100 50 66.667 60 0 60 Z',
    'or must be the OrShape D (was a full ellipse)');
});

test('audit7 shape: xor adds the concave back quad to (0,0) (Shapes.js:3658)', async () => {
  const { contract, notices } = await auditProbe('shape=xor;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  assert.equal(contract.document.pages[0].paint[0].d,
    'M 0 0 C 66.667 0 100 10 100 30 C 100 50 66.667 60 0 60 C 33.333 40 33.333 20 0 0 Z',
    'xor must be the XorShape crescent (was a full ellipse)');
});

test('audit7 shape: orEllipse paints BOTH mid lines over the ellipse (Shapes.js:3750)', async () => {
  const { contract, notices } = await auditProbe('shape=orEllipse;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.match(svg, /<ellipse cx="50" cy="30" rx="50" ry="30"/, 'ellipse body');
  assert.ok(svg.includes('M 0 30 L 100 30'), 'horizontal mid line, got: ' + svg);
  assert.ok(svg.includes('M 50 0 L 50 60'), 'vertical mid line, got: ' + svg);
});

test('audit7 shape: sumEllipse diagonals use the s2=0.145 inset (Shapes.js:3778)', async () => {
  const { contract, notices } = await auditProbe('shape=sumEllipse;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.ok(svg.includes('M 14.5 8.7 L 85.5 51.3'), 'main diagonal, got: ' + svg);
  assert.ok(svg.includes('M 85.5 8.7 L 14.5 51.3'), 'anti diagonal, got: ' + svg);
});

test('audit7 shape: lineEllipse mid line follows line=vertical (Shapes.js:3983)', async () => {
  const hor = decodeSvgNode((await auditProbe('shape=lineEllipse;fillColor=#ffffff;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0]);
  assert.ok(hor.includes('M 0 30 L 100 30'), 'default mid line is horizontal, got: ' + hor);
  const ver = decodeSvgNode((await auditProbe('shape=lineEllipse;line=vertical;fillColor=#ffffff;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0]);
  assert.ok(ver.includes('M 50 0 L 50 60'), 'line=vertical mid line is vertical, got: ' + ver);
});

test('audit7 shape: tapeData = ellipse + bottom-center to bottom-right line (Shapes.js:3729)', async () => {
  const { contract, notices } = await auditProbe('shape=tapeData;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.match(svg, /<ellipse cx="50" cy="30" rx="50" ry="30"/, 'ellipse body (was a tape silhouette)');
  assert.ok(svg.includes('M 50 60 L 100 60'), 'bottom tail line, got: ' + svg);
});

test('audit7 shape: dimension is the stroke-only double arrow (Shapes.js:3856)', async () => {
  const { contract, notices } = await auditProbe('shape=dimension;fillColor=#ff00ff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // sw = strokeWidth/2 = 0.5; al = 10+2*sw = 11; cy = h - al/2 = 54.5
  assert.ok(svg.includes('M 0 0 L 0 60'), 'left end bar, got: ' + svg);
  assert.ok(svg.includes('M 100 0 L 100 60'), 'right end bar');
  assert.ok(svg.includes('M 0.5 54.5 L 99.5 54.5'), 'dimension line at cy=h-al/2');
  assert.ok(svg.includes('M 0.5 54.5 L 11.5 49'), 'left arrowhead upper');
  assert.ok(svg.includes('M 99.5 54.5 L 88.5 60'), 'right arrowhead lower');
  assert.ok(!/ff00ff/.test(svg), 'DimensionShape only ever strokes — fillColor must not paint');
});

test('audit7 shape: umlBoundary = bar + connector + offset ellipse (Shapes.js:2397)', async () => {
  const { contract, notices } = await auditProbe('shape=umlBoundary;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.ok(svg.includes('M 0 15 L 0 45'), 'left bar h/4..3h/4, got: ' + svg);
  assert.ok(svg.includes('M 0 30 L 16.667 30'), 'connector to w/6 at h/2');
  assert.match(svg, /<ellipse cx="58.333" cy="30" rx="41.667" ry="30"/,
    'ellipse occupies (w\\/6,0,5w\\/6,h), not the whole box');
});

test('audit7 shape: umlEntity underline runs w/8..7w/8 at the bottom (Shapes.js:2430)', async () => {
  const { contract, notices } = await auditProbe('shape=umlEntity;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.match(svg, /<ellipse cx="50" cy="30" rx="50" ry="30"/, 'full ellipse body');
  assert.ok(svg.includes('M 12.5 60 L 87.5 60'), 'bottom underline, got: ' + svg);
});

test('audit7 shape: umlControl = arrow strokes + lowered ellipse (Shapes.js:2479)', async () => {
  const { contract, notices } = await auditProbe('shape=umlControl;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // h/8*1.1 = 8.25 with h=60
  assert.ok(svg.includes('M 37.5 8.25 L 62.5 0'), 'upper arrow stroke, got: ' + svg);
  assert.match(svg, /<ellipse cx="50" cy="33.75" rx="50" ry="26.25"/, 'ellipse at (0,h/8,w,7h/8)');
  assert.ok(svg.includes('M 37.5 8.25 L 62.5 15'), 'lower arrow stroke (paintForeground)');
});

test('audit7 shape: umlLifeline = header rect (size=40) + DASHED stem (Shapes.js:2530)', async () => {
  const { contract, notices } = await auditProbe('shape=umlLifeline;fillColor=#ffffff;strokeColor=#000000;', 100, 200);
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.match(svg, /<rect x="0" y="0" width="100" height="40"/,
    'header rect is size tall, NOT the whole cell');
  const stem = svg.match(/<path d="M 50 40 L 50 200"[^/]*\/>/);
  assert.ok(stem, 'stem from header bottom to cell bottom, got: ' + svg);
  assert.match(stem[0], /stroke-dasharray/, 'stem dashed by default (lifelineDashed=1)');
  const solid = decodeSvgNode((await auditProbe('shape=umlLifeline;lifelineDashed=0;fillColor=#ffffff;strokeColor=#000000;', 100, 200))
    .contract.document.pages[0].paint[0]);
  const solidStem = solid.match(/<path d="M 50 40 L 50 200"[^/]*\/>/);
  assert.ok(solidStem && !/stroke-dasharray/.test(solidStem[0]), 'lifelineDashed=0 stem is solid');
});

test('audit7 shape: umlLifeline participant=umlActor renders the actor header; unknown participant is LOUD', async () => {
  const actor = await auditProbe('shape=umlLifeline;participant=umlActor;fillColor=#ffffff;strokeColor=#000000;', 40, 200);
  assert.equal(actor.notices.length, 0, 'registered participant must render without notice');
  const svg = decodeSvgNode(actor.contract.document.pages[0].paint[0]);
  assert.match(svg, /<ellipse /, 'umlActor head ellipse painted as the header');
  assert.ok(!/<rect /.test(svg), 'participant replaces the default header rect');
  const unknown = await auditProbe('shape=umlLifeline;participant=noSuchShape;fillColor=#ffffff;strokeColor=#000000;', 40, 200);
  assert.ok(unknown.notices.some((n) => n.kind === 'ExporterUnsupportedShape' &&
    /participant/.test(n.detail.detail)), 'unknown participant must emit a LOUD notice');
});

test('audit7 shape: message = rect + STROKED envelope flap (Shapes.js:2325)', async () => {
  const { contract, notices } = await auditProbe('shape=message;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.match(svg, /<rect x="0" y="0" width="100" height="60"/, 'envelope body rect');
  assert.match(svg, /<path d="M 0 0 L 50 30 L 100 0" fill="none"/,
    'flap 0,0 -> w/2,h/2 -> w,0 stroked only');
});

test('audit7 shape: lollipop = size circle at top-center + stem (Shapes.js:3028)', async () => {
  const { contract, notices } = await auditProbe('shape=lollipop;fillColor=#ffffff;strokeColor=#000000;', 30, 60);
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.match(svg, /<ellipse cx="15" cy="5" rx="5" ry="5"/,
    'size(10) circle at top-center, NOT a full-cell ellipse');
  assert.match(svg, /<path d="M 15 10 L 15 60" fill="none"/, 'stem from circle to bottom');
});

test('audit7 shape: requires = stroke-only open arc (inset 2+sw) + stem (Shapes.js:3057)', async () => {
  const { contract, notices } = await auditProbe('shape=requires;fillColor=#ff00ff;strokeColor=#000000;', 30, 60);
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // sz=10, inset=2+1=3: stem (15,13)->(15,60); arc M 7 5 Q 7 13 15 13 Q 23 13 23 5
  assert.ok(svg.includes('M 15 13 L 15 60'), 'stem below the arc, got: ' + svg);
  assert.ok(svg.includes('M 7 5 Q 7 13 15 13 Q 23 13 23 5'), 'open half-arc quads');
  assert.ok(!/ff00ff/.test(svg), 'RequiresShape only strokes — fillColor must not paint');
});

test('audit7 shape: waypoint is a dot filled with the STROKE color (Shapes.js:500)', async () => {
  const { contract, notices } = await auditProbe('shape=waypoint;fillColor=#00ff00;strokeColor=#ff0000;', 40, 40);
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // s = max(0, size-2) + 2*sw = 4 + 2 = 6 -> r=3 centered
  assert.match(svg, /<ellipse cx="20" cy="20" rx="3" ry="3" fill="#ff0000"/,
    'dot diameter size-2+2sw filled with strokeColor (was a full-cell ellipse)');
  assert.ok(!/00ff00/.test(svg), 'fillColor is never painted (drawio fills with NONE)');
  const big = decodeSvgNode((await auditProbe('shape=waypoint;size=20;strokeWidth=2;strokeColor=#ff0000;', 40, 40))
    .contract.document.pages[0].paint[0]);
  assert.match(big, /<ellipse cx="20" cy="20" rx="11" ry="11"/, 'size/strokeWidth honored: (20-2)+2*2=22');
});

test('audit7 shape: transparent paints NOTHING (Shapes.js:1933)', async () => {
  const { contract, notices } = await auditProbe('shape=transparent;fillColor=#ff0000;strokeColor=#00ff00;');
  assert.equal(notices.length, 0, 'transparent is faithful as no-paint — no notice');
  assert.equal(contract.document.pages[0].paint.length, 0,
    'TransparentShape fills NONE and never strokes — zero ink');
});

test('audit7 shape: link VERTEX paints nothing (mxArrowConnector has no paintVertexShape)', async () => {
  const { contract, notices } = await auditProbe('shape=link;fillColor=#ff0000;strokeColor=#00ff00;');
  assert.equal(notices.length, 0);
  assert.equal(contract.document.pages[0].paint.length, 0,
    'link as a vertex paints no body in drawio (was an invented S-curve)');
});

test('audit7 shape: curlyBracket is the NEVER-filled bracket polyline (Shapes.js:1535)', async () => {
  const { contract, notices } = await auditProbe('shape=curlyBracket;fillColor=#ff00ff;strokeColor=#000000;', 20, 120);
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // s = w*size(0.5) = 10; open polyline through (w,0)(s,0)(s,h/2)(0,h/2)(s,h/2)(s,h)(w,h)
  assert.match(svg, /<path d="M 20 0 L 10 0 L 10 60 L 0 60 L 10 60 L 10 120 L 20 120" fill="none"/,
    'bracket polyline (was a closed filled double-C), got: ' + svg);
  assert.ok(!/ff00ff/.test(svg), 'CurlyBracketShape sets fill NULL — never filled');
  const rounded = decodeSvgNode((await auditProbe('shape=curlyBracket;rounded=1;strokeColor=#000000;', 20, 120))
    .contract.document.pages[0].paint[0]);
  assert.ok(/ d="[^"]*Q[^"]*" fill="none"/.test(rounded), 'rounded=1 rounds the corners via addPoints');
});

test('audit7 shape: zigzag starts/ends at h/2 with round(w/size)-1 waves (Shapes.js:5708)', async () => {
  const { contract, notices } = await auditProbe('shape=zigzag;strokeColor=#000000;fillColor=none;', 100, 20);
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // size=10: numFull = round(100/10)-1 = 9, halfWave=10, halfEnd=5; inset=sw=1
  assert.match(svg,
    /<path d="M 0 10 L 5 1 L 15 19 L 25 1 L 35 19 L 45 1 L 55 19 L 65 1 L 75 19 L 85 1 L 95 19 L 100 10" fill="none"/,
    'zigzag teeth from the ported painter, got: ' + svg);
  const filled = decodeSvgNode((await auditProbe('shape=zigzag;strokeColor=#000000;fillColor=#ffcc00;', 100, 20))
    .contract.document.pages[0].paint[0]);
  assert.match(filled, /<rect x="0" y="0" width="100" height="20" fill="#ffcc00" stroke="none"/,
    'background fill is a SEPARATE unstroked rect');
  const wave = await auditProbe('shape=zigzag;rounded=1;strokeColor=#000000;fillColor=none;', 100, 20);
  assert.equal(wave.notices.length, 0, 'rounded zigzag (wave) now renders faithfully — no notice');
  assert.ok(/ d="M 0 10 C [^"]*" fill="none"/.test(decodeSvgNode(wave.contract.document.pages[0].paint[0])),
    'rounded=1 paints the cubic wave');
});

test('audit7 shape: gitTag = tabInset/tabSize polygon + hole circle (Shapes.js:6424)', async () => {
  const { contract, notices } = await auditProbe('shape=gitTag;fillColor=#ffffff;strokeColor=#000000;', 60, 20);
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // tabSize=8, tabInset=4: tabY1=8, tabY2=12 — NOT the old arrow-left pentagon
  assert.ok(svg.includes('M 0 8 L 0 12 L 8 20 L 60 20 L 60 0 L 8 0 Z'),
    'tag silhouette with the flat tab tip, got: ' + svg);
  // holeColor falls back to the RESOLVED style fontColor (default.xml
  // defaultVertex fontColor=default -> theme fg #000000), exactly like the
  // live getValue(style,'holeColor', getValue(style,'fontColor','#333333')).
  assert.match(svg, /<ellipse cx="4" cy="10" rx="1" ry="1" fill="#000000" stroke="#000000"/,
    'pierce hole at (tabSize/2, h/2), holeSize=1, default = resolved fontColor');
  const red = decodeSvgNode((await auditProbe('shape=gitTag;holeColor=#ff0000;fillColor=#ffffff;strokeColor=#000000;', 60, 20))
    .contract.document.pages[0].paint[0]);
  assert.match(red, /<ellipse cx="4" cy="10" rx="1" ry="1" fill="#ff0000"/, 'holeColor= honored');
  const noHole = decodeSvgNode((await auditProbe('shape=gitTag;holeSize=0;fillColor=#ffffff;strokeColor=#000000;', 60, 20))
    .contract.document.pages[0].paint[0]);
  assert.ok(!/<ellipse/.test(noHole), 'holeSize=0 suppresses the hole');
});

test('audit7 shape: gitMergeCommit inner 0.6-diameter circle in innerColor (Shapes.js:6488)', async () => {
  const { contract, notices } = await auditProbe('shape=gitMergeCommit;fillColor=#ffffff;strokeColor=#000000;', 40, 40);
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.match(svg, /<ellipse cx="20" cy="20" rx="20" ry="20" fill="#ffffff"/, 'outer circle');
  assert.match(svg, /<ellipse cx="20" cy="20" rx="12" ry="12" fill="#ececff" stroke="#ececff"/,
    'inner min(w,h)*0.6 circle in default innerColor #ECECFF');
});

test('audit7 shape: gitCherryPick eyes + stem in featureColor (Shapes.js:6519)', async () => {
  const { contract, notices } = await auditProbe('shape=gitCherryPick;fillColor=#1f2020;strokeColor=#000000;', 40, 40);
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  // s = min(w,h)/20 = 2; eyeR = 5.5; eyes at (cx±3s, cy+2s) = (14|26, 24)
  assert.match(svg, /<ellipse cx="14" cy="24" rx="5.5" ry="5.5" fill="#ffffff"/, 'left eye');
  assert.match(svg, /<ellipse cx="26" cy="24" rx="5.5" ry="5.5" fill="#ffffff"/, 'right eye');
  assert.ok(/M 26 22 L 20 10/.test(svg) && /M 14 22 L 20 10/.test(svg),
    'inverted-V stem lines to (cx, cy-5s), got: ' + svg);
  assert.match(svg, /stroke-width="2"/, 'stem stroke width = 1*s');
});

test('audit7 shape: mindmapBang is the 14-arc starburst (Shapes.js:6575)', async () => {
  const { contract, notices } = await auditProbe('shape=mindmapBang;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const d = contract.document.pages[0].paint[0].d;
  // W=80 H=48 r=12 ox=8 oy=4.8; first top arc ends at (28, 0)
  assert.ok(d.startsWith('M 8 4.8 A 12 12 0 0 0 28 0'),
    'starburst starts at (ox,oy) with the first scallop arc, got: ' + d);
  assert.equal((d.match(/A /g) || []).length, 14, '4+3+4+3 elliptical arcs');
  assert.ok(/Z$/.test(d), 'closed silhouette');
});

test('audit7 shape: ishikawaHead bulges to quad ctrl (2w, h/2) (Shapes.js:6647)', async () => {
  const { contract, notices } = await auditProbe('shape=ishikawaHead;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  assert.equal(contract.document.pages[0].paint[0].d,
    'M 0 0 L 0 60 C 133.333 40 133.333 20 0 0 Z',
    'fish head: flat left edge + quadTo(2w,h/2) teardrop (was an ellipse)');
});

test('audit7 shape: mermaidOdd notches the LEFT side inward by h/4 (Shapes.js:6672)', async () => {
  const { contract, notices } = await auditProbe('shape=mermaidOdd;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  assert.equal(contract.document.pages[0].paint[0].d,
    'M 0 0 L 15 30 L 0 60 L 100 60 L 100 0 Z',
    'rect with the inward left chevron (was an ellipse)');
});

test('audit7 shape: ext;double=1 paints the inner rect at margin max(2,sw+1)+margin (Shapes.js:2220)', async () => {
  const { contract, notices } = await auditProbe('shape=ext;double=1;fillColor=#ffffff;strokeColor=#000000;');
  assert.equal(notices.length, 0);
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.match(svg, /<rect x="0" y="0" width="100" height="60"/, 'outer rect');
  assert.match(svg, /<rect x="2" y="2" width="96" height="56"/, 'inner rect at default margin 2');
  const m3 = decodeSvgNode((await auditProbe('shape=ext;double=1;margin=3;fillColor=#ffffff;strokeColor=#000000;'))
    .contract.document.pages[0].paint[0]);
  assert.match(m3, /<rect x="5" y="5" width="90" height="50"/, 'margin= style adds to the base margin');
});

test('audit7 shape: ext symbol0..n emit a LOUD ExporterUnsupportedShape notice', async () => {
  const { contract, notices } = await auditProbe('shape=ext;double=1;symbol0=cloud;fillColor=#ffffff;strokeColor=#000000;');
  assert.ok(notices.some((n) => n.kind === 'ExporterUnsupportedShape' &&
    /symbol0/.test(n.detail.detail)), 'symbols must never be silently dropped');
  const svg = decodeSvgNode(contract.document.pages[0].paint[0]);
  assert.match(svg, /<rect x="2" y="2" width="96" height="56"/, 'double rect still renders');
});

test('audit7: image clipPath/rounded crop reaches the printed SVG', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const page = (style) => `<mxGraphModel pageWidth="200" pageHeight="100"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=image;${style}image=data:image/png,${png};" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  // inset() crop -> svg-wrapped node with a clipPath rect at the crop window.
  const { contract: cropC, notices: cropN } =
    await bake(page('clipPath=inset(10% 20% 10% 20%);'), { keepPx: true });
  assert.equal(cropN.length, 0);
  const cropNode = cropC.document.pages[0].paint.find((n) => n.kind === 'svg');
  const cropSvg = Buffer.from(cropNode.source, 'base64').toString('utf8');
  assert.match(cropSvg, /<clipPath id="imgclip\d+"><rect x="16" y="4" width="48" height="32"/,
    `inset crop rect: ${cropSvg}`);
  // rounded=1 -> synthetic inset(0 round r%) clip with rx.
  const { contract: rndC } = await bake(page('rounded=1;'), { keepPx: true });
  const rndNode = rndC.document.pages[0].paint.find((n) => n.kind === 'svg');
  assert.match(Buffer.from(rndNode.source, 'base64').toString('utf8'), /rx="/,
    'rounded image carries a rounded clip');
  // unsupported clip form -> full image + LOUD notice, never a silent wrong crop.
  const { notices: polyN } = await bake(page('clipPath=polygon(0 0, 100% 0, 0 100%);'), { keepPx: true });
  assert.ok(polyN.some((n) => /clipPath/.test(n.detail.detail)), 'polygon clip is loud');
});

test('audit7: shadow=1 on a STENCIL paints the offset recolored copy; sketch=1 is LOUD', async () => {
  const xml = `<mxGraphModel pageWidth="300" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=mxgraph.basic.4_point_star;fillColor=#ff0000;shadow=1;" parent="1"><mxGeometry x="40" y="40" width="100" height="100" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract, notices } = await bake(xml, { keepPx: true });
  assert.equal(notices.length, 0);
  const svgs = contract.document.pages[0].paint.filter((n) => n.kind === 'svg');
  assert.equal(svgs.length, 2, 'shadow copy + stencil body');
  const shadow = Buffer.from(svgs[0].source, 'base64').toString('utf8');
  assert.match(shadow, /<g opacity="0.25">/);
  assert.match(shadow, /#000000/);
  assert.ok(!/#ff0000/.test(shadow), 'shadow copy is fully recolored');
  // paddedSvgShapeNode grows the shadow viewport by the stroke halo, so
  // compare with that slack: the offset is (2,3) +- pad.
  assert.ok(Math.abs((svgs[1].box.x + 2) - svgs[0].box.x) < 1, 'offset ~(2,3)');

  const { notices: skN } = await bake(xml.replace('shadow=1;', 'sketch=1;'), { keepPx: true });
  assert.ok(skN.some((n) => /sketch=1/.test(n.detail.detail)), 'stencil sketch is loud');

  const builtin = xml.replace('shape=mxgraph.basic.4_point_star;fillColor=#ff0000;shadow=1;',
    'shape=process;sketch=1;fillStyle=hachure;fillColor=#ff0000;');
  const { notices: biN } = await bake(builtin, { keepPx: true });
  assert.ok(biN.some((n) => /sketch=1/.test(n.detail.detail)), 'builtin-branch sketch is loud');
});

test('audit7: zero/negative-extent cells match drawio (hairline / nothing)', async () => {
  const page = (w, h) => `<mxGraphModel pageWidth="200" pageHeight="100"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="rounded=0;" parent="1"><mxGeometry x="10" y="10" width="${w}" height="${h}" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  // h=0: a horizontal hairline, not a 1px-tall outlined rect.
  const { contract: lineC } = await bake(page(80, 0), { keepPx: true });
  const ln = lineC.document.pages[0].paint.find((n) => n.kind === 'path');
  assert.ok(ln && /^M 10 10 L 90 10$/.test(ln.d), `hairline expected: ${ln && ln.d}`);
  assert.equal(ln.fill, null);
  // The LABEL still renders for a degenerate body (drawio mxText does).
  const { contract: lblC } = await bake(page(80, 0).replace('style=', 'value="DIV" style='), { keepPx: true });
  assert.ok(lblC.document.pages[0].paint.some((n) => n.kind === 'svg' &&
    /DIV/.test(Buffer.from(n.source, 'base64').toString('utf8'))),
    'zero-extent cell keeps its label');
  // negative width: drawio paints nothing.
  const { contract: negC } = await bake(page(-80, 40), { keepPx: true });
  assert.equal(negC.document.pages[0].paint.length, 0, 'negative extent paints nothing');
});

test('audit7: shadow ink composes with the shape opacity (createShadow clone semantics)', async () => {
  // mxSvgCanvas2D.createShadow clones the painted node (keeping its own
  // fill-opacity) and applies shadowAlpha on top: opacity=50 + shadow=1
  // prints a 0.25*0.5 = 0.125 shadow, not a flat 0.25.
  const xml = `<mxGraphModel pageWidth="400" pageHeight="300"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="rounded=0;shadow=1;opacity=50;" parent="1"><mxGeometry x="40" y="40" width="100" height="60" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const shadow = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && n.fill && n.fill.color === '#000000');
  assert.ok(shadow, 'shadow present');
  assert.ok(Math.abs(shadow.fill.alpha - 0.125) < 0.001,
    `shadow alpha composes: got ${shadow.fill.alpha}`);
});

// ──────────────────────────────────────────────────────────────────────────
// Round-6 audit (branch claude/optimistic-archimedes-ka4th1): silent-divergence
// fixes found by object-by-object comparison against drawio mxShape/mxStencil/
// mxText source. Each asserts the FAITHFUL geometry/attribute the bake now emits.
// ──────────────────────────────────────────────────────────────────────────

function rawSvg(node) {
  return (node && node.kind === 'svg' && typeof node.source === 'string')
    ? Buffer.from(node.source, 'base64').toString('utf8') : '';
}
const mkV = (style, w = 120, h = 80) => `<mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="2" vertex="1" style="${style}" parent="1"><mxGeometry x="20" y="20" width="${w}" height="${h}" as="geometry"/></mxCell>
</root></mxGraphModel>`;

test('V1 datastore: three stacked rim curves + body bottom control h+dy/3 (DataStoreShape)', async () => {
  const { contract } = await bake(mkV('shape=datastore;fillColor=#eee;', 100, 80), { keepPx: true });
  const d = contract.document.pages[0].paint.find((n) => n.kind === 'path' && /C/.test(n.d || '')).d;
  // body (1 'M') + three stacked platter rim curves (3 'M') = 4 subpaths.
  const moves = (d.match(/M /g) || []).length;
  assert.equal(moves, 4, `expected 4 subpaths (body + 3 rims), got ${moves}: ${d.slice(0, 60)}`);
});

test('V2 callout: square 7-point polygon, tail tip ON the bottom edge (CalloutShape)', async () => {
  const { contract } = await bake(mkV('shape=callout;fillColor=#eee;', 120, 80), { keepPx: true });
  const d = contract.document.pages[0].paint.find((n) => n.kind === 'path').d;
  // no arcs (square corners).
  assert.ok(!/[AQ]/.test(d), `callout should be square (no arcs), got: ${d}`);
  // default size=30 → body recedes to h-30=50; tail tip at (position*w=60, h=80)
  // sitting exactly on the bottom edge, then back up to (60,50).
  assert.ok(/L 60 80 L 60 50/.test(d), `tail tip on bottom edge then back up: ${d}`);
  // every y-coordinate is within [0, h=80] (tail never pokes past the footprint).
  const ys = [...d.matchAll(/(?:M|L) [\d.]+ ([\d.]+)/g)].map((m) => parseFloat(m[1]));
  assert.ok(Math.max(...ys) <= 80.0001, `no point below h=80: ${ys}`);
});

test('V4 cube darkOpacity: two shaded faces emitted (CubeShape)', async () => {
  // drawio darkOpacity is a fraction clamped to [-1,1] (CubeShape).
  const { contract } = await bake(mkV('shape=cube;fillColor=#eee;darkOpacity=0.4;darkOpacity2=-0.3;', 120, 80), { keepPx: true });
  const svg = rawSvg(contract.document.pages[0].paint.find((n) => n.kind === 'svg'));
  assert.ok(/fill="#000000" fill-opacity="0\.4/.test(svg), `op>0 top face black @0.4: ${svg.slice(0, 200)}`);
  assert.ok(/fill="#ffffff" fill-opacity="0\.3/.test(svg), `op2<0 left face white @0.3`);
});

test('V4 cube default (no darkOpacity): unchanged single-path render', async () => {
  const { contract } = await bake(mkV('shape=cube;fillColor=#eee;', 120, 80), { keepPx: true });
  // No shaded-face svg; stays a kind:path silhouette (the plain cube path).
  assert.ok(contract.document.pages[0].paint.some((n) => n.kind === 'path' && /L/.test(n.d || '')),
    'plain cube still a path');
});

test('V5 swimlane startSize defaults to 40 (mxConstants.DEFAULT_STARTSIZE)', async () => {
  const { contract } = await bake(mkV('shape=swimlane;fillColor=#eee;', 200, 200), { keepPx: true });
  const d = contract.document.pages[0].paint.find((n) => n.kind === 'path' && /L/.test(n.d || '')).d;
  // horizontal swimlane divider line sits at y = startSize = 40 (box-relative).
  assert.ok(/ 40(\b|\.)/.test(d) || /40 /.test(d), `header divider at startSize=40: ${d.slice(0, 120)}`);
});

test('V6 associativeEntity rounded=1: rounded rect + rounded diamond (AssociativeEntity)', async () => {
  const sq = rawSvg((await bake(mkV('shape=associativeEntity;fillColor=#eee;', 120, 80), { keepPx: true }))
    .contract.document.pages[0].paint.find((n) => n.kind === 'svg'));
  assert.ok(/<rect /.test(sq), `default associativeEntity = square rect: ${sq.slice(0, 120)}`);
  const rd = rawSvg((await bake(mkV('shape=associativeEntity;fillColor=#eee;rounded=1;arcSize=20;', 120, 80), { keepPx: true }))
    .contract.document.pages[0].paint.find((n) => n.kind === 'svg'));
  assert.ok(/[Q]/.test(rd) && !/<rect /.test(rd), `rounded=1 → rounded-rect path with Q curves: ${rd.slice(0, 160)}`);
});

test('V7 associativeEntity glass=1: glass overlay emitted', async () => {
  const svg = rawSvg((await bake(mkV('shape=associativeEntity;fillColor=#eee;glass=1;', 120, 80), { keepPx: true }))
    .contract.document.pages[0].paint.find((n) => n.kind === 'svg'));
  assert.ok(/#ffffff/i.test(svg) || /glass/i.test(svg), `glass highlight present: ${svg.slice(-160)}`);
});

test('E1 flexArrow shadow=1: offset filled shadow band emitted (was silently dropped)', async () => {
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="3" vertex="1" style="" parent="1"><mxGeometry x="20" y="20" width="20" height="20" as="geometry"/></mxCell>
    <mxCell id="4" vertex="1" style="" parent="1"><mxGeometry x="200" y="20" width="20" height="20" as="geometry"/></mxCell>
    <mxCell id="5" edge="1" source="3" target="4" style="shape=flexArrow;shadow=1;fillColor=#eee;" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const shadow = contract.document.pages[0].paint.find(
    (n) => n.kind === 'path' && n.fill && n.fill.color === '#000000' && n.fill.alpha < 0.3);
  assert.ok(shadow, 'flexArrow shadow=1 emits an offset filled shadow band');
});

test('S2 mxLabel image icon stretches (preserveAspectRatio=none, aspect=false)', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const { contract } = await bake(mkV(`shape=label;image=data:image/png,${png};imageWidth=16;imageHeight=40;`, 120, 80), { keepPx: true });
  const node = contract.document.pages[0].paint.find(
    (n) => (n.kind === 'image') || (n.kind === 'svg' && /Gear|iVBOR|xlink:href/.test(rawSvg(n))));
  assert.ok(node, 'label icon emitted');
  if (node.kind === 'image') assert.equal(node.aspect, 'fill', 'label icon aspect=fill (stretch)');
  else assert.ok(/preserveAspectRatio="none"/.test(rawSvg(node)), `label icon preserveAspectRatio=none: ${rawSvg(node).slice(0, 200)}`);
});

test('S4 image cell opacity composes opacity*fillOpacity (mxSvgCanvas2D.image)', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const { contract } = await bake(mkV(`shape=image;image=data:image/png,${png};opacity=80;fillOpacity=50;`, 60, 60), { keepPx: true });
  const node = contract.document.pages[0].paint.find((n) => n.kind === 'svg' && /opacity="0\.4/.test(rawSvg(n)));
  assert.ok(node, 'image opacity = 0.8 * 0.5 = 0.4');
});

test('L1 overflow=width clips to the cell (does not grow the viewport)', async () => {
  const long = 'WWWWWWWWWW WWWWWWWWWW WWWWWWWWWW WWWWWWWWWW';
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="${long}" style="text;html=1;overflow=width;whiteSpace=nowrap;fontSize=20;" parent="1"><mxGeometry x="20" y="20" width="40" height="30" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const lbl = contract.document.pages[0].paint.find((n) => n.kind === 'svg' && /<text/.test(rawSvg(n)));
  assert.ok(lbl, 'overflow=width label emitted');
  // clipped: the label box width stays ~ the cell width (40px → um), not grown
  // to the unwrapped text extent (which would be many times wider).
  assert.ok(lbl.box.w <= 60 * SCALE, `overflow=width clips to cell, box.w=${lbl.box.w / SCALE}px`);
});

test('L3 rich-text table colspan: spanning cell widens, following cells shift right', async () => {
  const value = '&lt;table border=&quot;1&quot;&gt;&lt;tr&gt;&lt;td colspan=&quot;2&quot;&gt;AB&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;C&lt;/td&gt;&lt;td&gt;D&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;';
  const xml = `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="${value}" style="text;html=1;" parent="1"><mxGeometry x="20" y="20" width="160" height="80" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml, { keepPx: true });
  const svg = rawSvg(contract.document.pages[0].paint.find((n) => n.kind === 'svg' && /<rect/.test(rawSvg(n))));
  // A colspan=2 top cell → its rect spans both columns (wider than a single
  // bottom cell). Match the real ` width=` attr (leading space avoids the
  // `stroke-width` attribute).
  const rectW = [...svg.matchAll(/ width="([\d.]+)"/g)].map((m) => parseFloat(m[1])).sort((a, b) => b - a);
  assert.ok(rectW.length >= 3, `table drew row+cell rects: ${rectW.length}`);
  assert.ok(rectW[0] > rectW[rectW.length - 1] * 1.5, `colspan cell wider than single cell: ${rectW}`);
});

test('S1 stencil <text> uses canvas-default font, NOT the cell font (mxShape.configureCanvas sets no font)', async () => {
  // The D/Q lettering inside electrical/logic_gates d_type_flip-flop carries no
  // <fontcolor>/<fontsize>/<fontstyle> command, so it must paint with the canvas
  // defaults (#000000, 11px, Arial,Helvetica, normal) even when the CELL sets a
  // different font. Seeding stencil text from the cell style mis-rendered every
  // stencil's decorative lettering (silent C1 violation).
  const xml = `<mxGraphModel pageWidth="300" pageHeight="200"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=mxgraph.electrical.logic_gates.d_type_flip-flop;fontColor=#ff0000;fontSize=40;fontStyle=1;" parent="1"><mxGeometry x="50" y="50" width="120" height="100" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const { contract } = await bake(xml);
  const svg = contract.document.pages[0].paint
    .map((n) => rawSvg(n)).find((s) => /<text[^>]*>D<\/text>/.test(s)) || '';
  const m = svg.match(/<text[^>]*>D<\/text>/);
  assert.ok(m, 'stencil D text present');
  assert.match(m[0], /fill="#000000"/, `stencil text stays black, not cell red: ${m[0]}`);
  assert.match(m[0], /font-size="11"/, `stencil text stays 11px, not cell 40: ${m[0]}`);
  assert.ok(!/font-weight="(bold|700)"/.test(m[0]), `stencil text stays normal weight: ${m[0]}`);
});

test('E2 fixed anchor honors the terminal perimeterSpacing (mxGraph.getConnectionPoint)', async () => {
  // getConnectionPoint computes the anchor against getPerimeterBounds, which
  // grows the box by perimeterSpacing on every side. A right-edge anchor
  // (fx=1, fy=0.5) on a 100x100 box at (0,0) sits at x=100 with no spacing,
  // and at x=110 with perimeterSpacing=10.
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const noSp = fixedConnectionPoint(box, {}, 1, 0.5, 0, 0, false);
  assert.ok(Math.abs(noSp.x - 100) < 0.001, `no spacing: x=${noSp.x}`);
  const sp = fixedConnectionPoint(box, { perimeterSpacing: 10 }, 1, 0.5, 0, 0, false);
  assert.ok(Math.abs(sp.x - 110) < 0.001, `perimeterSpacing=10 pushes anchor to x=110, got ${sp.x}`);
  assert.ok(Math.abs(sp.y - 50) < 0.001, `y stays centered: ${sp.y}`);
});

test('L4 sup/sub grows the line box (getSupSubLineExpansion)', async () => {
  // A superscript on line 1 expands line 1's box, so line 2 (B) is pushed DOWN
  // vs the same two lines with no superscript — the shifted glyph can no longer
  // ride into the line above. Measure B's baseline y in both cases.
  const mk = (val) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="${val}" style="text;html=1;fontSize=20;verticalAlign=top;" parent="1"><mxGeometry x="20" y="20" width="200" height="200" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const yOfB = async (val) => {
    const c = (await bake(mk(val), { keepPx: true })).contract;
    const s = c.document.pages[0].paint.map((n) => rawSvg(n)).find((x) => /<text/.test(x)) || '';
    const m = s.match(/<text[^>]*y="([\d.]+)"[^>]*>B</);
    return m ? parseFloat(m[1]) : 0;
  };
  const withSup = await yOfB('&lt;p&gt;A&lt;sup&gt;2&lt;/sup&gt;&lt;/p&gt;&lt;p&gt;B&lt;/p&gt;');
  const plain = await yOfB('&lt;p&gt;A&lt;/p&gt;&lt;p&gt;B&lt;/p&gt;');
  assert.ok(withSup > plain, `sup on line 1 pushes line 2 down: withSup=${withSup} plain=${plain}`);
});

test('L5 plain-label wrap accounts for letterSpacing', async () => {
  // With wide letter spacing the same words occupy more width, so the label
  // wraps to more lines (the wrap decision must include letterSpacing, matching
  // what the plain emit already renders).
  const mk = (ls) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="aaaa bbbb cccc dddd" style="whiteSpace=wrap;fontSize=14;letterSpacing=${ls};" parent="1"><mxGeometry x="20" y="20" width="80" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const linesOf = async (ls) => {
    const c = (await bake(mk(ls), { keepPx: true })).contract;
    const s = c.document.pages[0].paint.map((n) => rawSvg(n)).find((x) => /<text/.test(x)) || '';
    return (s.match(/<text/g) || []).length;
  };
  const tight = await linesOf(0);
  const wide = await linesOf(8);
  assert.ok(wide >= tight, `wide letterSpacing wraps to >= lines: wide=${wide} tight=${tight}`);
});

// ──────────────────────────────────────────────────────────────────────────
// Round-7 (advisor follow-up): per-shape label margins (getLabelMargins/Bounds),
// L4 descender-side sup/sub model, cube N/S bounds inversion, stencil <image>.
// ──────────────────────────────────────────────────────────────────────────

// Decode the y of a label text run from the page's label svg node(s).
function labelTextY(contract, ch = null) {
  for (const n of contract.document.pages[0].paint) {
    const s = rawSvg(n);
    if (!/<text/.test(s)) continue;
    const re = ch ? new RegExp(`<text[^>]*y="([\\d.]+)"[^>]*>${ch}`) : /<text[^>]*y="([\d.]+)"/;
    const m = s.match(re);
    if (m) return { y: parseFloat(m[1]), box: n.box, svg: s };
  }
  return null;
}

test('BLOCKING-2 cube boundedLbl insets the label by size (CubeShape.getLabelMargins)', async () => {
  // The default General-sidebar cube is boundedLbl=1;size=20 — the label must be
  // pushed right+down by size, clear of the depth band. Compare the label svg
  // box x/y with vs without boundedLbl.
  const mk = (extra) => `<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="Cube" style="shape=cube;fillColor=#eee;size=20;${extra}" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`;
  const bounded = (await bake(mk('boundedLbl=1;darkOpacity=0.05;'), { keepPx: true })).contract;
  const plain = (await bake(mk(''), { keepPx: true })).contract;
  const lb = labelTextY(bounded), lp = labelTextY(plain);
  assert.ok(lb && lp, 'both labels emitted');
  assert.ok(lb.box.x > lp.box.x + 10, `boundedLbl insets label left by ~size: ${lb.box.x} vs ${lp.box.x}`);
  assert.ok(lb.box.y > lp.box.y + 10, `boundedLbl insets label top by ~size: ${lb.box.y} vs ${lp.box.y}`);
});

test('label margin: datastore label is pushed below the disk stack (DataStoreShape.getLabelMargins)', async () => {
  const ds = (await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="DS" style="shape=datastore;fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true })).contract;
  const rect = (await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="DS" style="rounded=0;fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true })).contract;
  const lds = labelTextY(ds), lr = labelTextY(rect);
  assert.ok(lds && lr, 'labels emitted');
  // datastore inset top = 2.5*dy (dy≈round(120/8)=15 → ~37px); plain rect centers.
  assert.ok(lds.box.y > lr.box.y + 15, `datastore label below disk stack: ${lds.box.y} vs ${lr.box.y}`);
});

test('label margin: callout label lifted off the tail recess (CalloutShape.getLabelMargins)', async () => {
  const co = (await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="C" style="shape=callout;fillColor=#eee;size=30;" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true })).contract;
  const rect = (await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="C" style="rounded=0;fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true })).contract;
  const lco = labelTextY(co), lr = labelTextY(rect);
  assert.ok(lco && lr, 'labels emitted');
  // callout bottom inset = size=30 → the label box is SHORTER (h reduced by 30),
  // lifting the centered label off the tail recess.
  assert.ok(lco.box.h < lr.box.h - 20, `callout label box shortened by ~size: ${lco.box.h} vs ${lr.box.h}`);
});

test('label margin: process insets the label between the bars (ProcessShape.getLabelBounds)', async () => {
  const pr = (await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="P" style="shape=process;fillColor=#eee;size=0.2;" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true })).contract;
  const l = labelTextY(pr);
  assert.ok(l, 'process label emitted');
  // inset = 0.2*160 = 32 on each side → label box left edge ≳ 32px in.
  assert.ok(l.box.x >= 28, `process label inset between bars: box.x=${l.box.x}`);
});

test('cube direction=north paints in a swapped viewport (no overflow on non-square)', async () => {
  // A 200x80 cube rotated north must stay within its box (the body is built in
  // the h×w=80×200 swapped space then rotated), not overflow.
  const { contract } = await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" style="shape=cube;fillColor=#eee;direction=north;darkOpacity=0.1;" parent="1"><mxGeometry x="20" y="20" width="200" height="80" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true });
  const svgN = contract.document.pages[0].paint.find((n) => n.kind === 'svg');
  assert.ok(svgN, 'cube svg emitted');
  // box stays ~200x80 (+stroke halo), not a swapped/overflowed extent.
  assert.ok(svgN.box.w > svgN.box.h, `cube box keeps its 200x80 aspect: ${svgN.box.w}x${svgN.box.h}`);
});

test('label margin: umlControl insets the label top by h/8 (unconditional, getLabelBounds)', async () => {
  const c = (await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="Ctl" style="shape=umlControl;fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true })).contract;
  const l = labelTextY(c);
  assert.ok(l, 'umlControl label emitted');
  // top inset = 120/8 = 15 → label box top ≳ 15 (vs 0 unmargined).
  assert.ok(l.box.y >= 13, `umlControl label inset top by h/8: box.y=${l.box.y}`);
});

test('label margin: umlBoundary insets the label left by w/6 (unconditional, getLabelMargins)', async () => {
  const c = (await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="B" style="shape=umlBoundary;fillColor=#eee;" parent="1"><mxGeometry x="20" y="20" width="180" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true })).contract;
  const l = labelTextY(c);
  assert.ok(l, 'umlBoundary label emitted');
  // left inset = 180/6 = 30 → label box left ≳ 28.
  assert.ok(l.box.x >= 26, `umlBoundary label inset left by w/6: box.x=${l.box.x}`);
});

test('label margin: note2 boundedLbl insets BOTH top and bottom by size', async () => {
  const c = (await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="N" style="shape=note2;fillColor=#eee;boundedLbl=1;size=30;" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true })).contract;
  const l = labelTextY(c);
  assert.ok(l, 'note2 label emitted');
  // top=30, bottom=30 → label box h ≈ 120 - 60 = 60.
  assert.ok(l.box.y >= 28 && l.box.h <= 64, `note2 inset top+bottom by size: y=${l.box.y} h=${l.box.h}`);
});

test('label margin: ext double=1 insets the label on all sides', async () => {
  const c = (await bake(`<mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" vertex="1" value="E" style="shape=ext;double=1;fillColor=#eee;strokeWidth=2;" parent="1"><mxGeometry x="20" y="20" width="160" height="120" as="geometry"/></mxCell>
  </root></mxGraphModel>`, { keepPx: true })).contract;
  const l = labelTextY(c);
  assert.ok(l, 'ext double label emitted');
  // margin = max(2, sw+1)=3 each side → box inset by ~3, h ≈ 120-6.
  assert.ok(l.box.x >= 2 && l.box.h <= 116, `ext double inset all sides: x=${l.box.x} h=${l.box.h}`);
});
