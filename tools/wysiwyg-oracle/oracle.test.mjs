// WYSIWYG differential-conformance test (browser-free).
//
// Proves the native-print exporter's vertex geometry is EQUIVALENT to drawio's
// OWN rendering code (mxGraph `paintVertexShape`), executed headlessly by
// mx-oracle.mjs. This is conformance to the authoritative renderer with zero
// browser — the load-bearing evidence in docs/WYSIWYG_ASSURANCE_CASE.md (L2).
//
// Scope: the shapes drawio renders via mxGraph CORE (not overridden in
// Shapes.js) — rectangle, ellipse, rhombus, triangle — across sizes, the
// rounded flag, and arcSize. For these the contract path must match drawio's
// path to sub-pixel tolerance. Shapes drawio overrides (e.g. hexagon) need a
// Shapes.js-backed oracle and are tracked in the assurance case residuals.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { oracleCommands, pathDeviation } from './mx-oracle.mjs';

const require = createRequire(import.meta.url);
const exporter = require('../../src/main/webapp/plugins/nativeprint/exporter.js');

function graphFixture(cells, states, labels, styles) {
  return {
    getModel: () => ({ cells, isVertex: (c) => c.vertex === true, isEdge: (c) => c.edge === true }),
    view: { scale: 1, getState: (c) => states[c.id] },
    getGraphBounds: () => ({ x: 0, y: 0, width: 1000, height: 1000 }),
    getCellStyle: (c) => styles[c.id] || {},
    getLabel: (c) => labels[c.id] || '',
    isHtmlLabel: (c) => !!c.html
  };
}
// Exporter body geometry for one cell, as an absolute path 'd' string. Uses
// origin (0,0) scale 1 so the contract coords equal the shape's local (0..w,0..h).
function exporterPathD(style, w, h) {
  const r = exporter.buildResult(graphFixture(
    { v: { id: 'v', vertex: true } }, { v: { x: 0, y: 0, width: w, height: h } },
    { v: '' }, { v: style }));
  const paint = r.contract.document.pages[0].paint;
  const path = paint.find((n) => n.kind === 'path');
  if (path) return path.d;
  const svg = paint.find((n) => n.kind === 'svg');
  if (svg) {
    const s = Buffer.from(svg.source, 'base64').toString('utf8');
    const m = /<path d="([^"]*)"/.exec(s);
    if (m) return m[1];
  }
  return null;
}

// Shapes drawio renders via mxGraph CORE -> the oracle is authoritative.
const CORE_SHAPES = ['rectangle', 'ellipse', 'rhombus', 'triangle'];
const SIZES = [[80, 40], [120, 60], [50, 50], [200, 30]];
const TOL = 0.1; // sub-pixel: float noise from quad->cubic + sampling only

for (const shape of CORE_SHAPES) {
  for (const [w, h] of SIZES) {
    test(`oracle conformance: ${shape} ${w}x${h} (sharp) == drawio geometry`, () => {
      const style = { shape, fillColor: '#eeeeee', strokeColor: '#333333' };
      const oracle = oracleCommands(shape, style, w, h);
      const exp = exporterPathD(style, w, h);
      assert.ok(exp, `${shape} emits a path`);
      const dev = pathDeviation(oracle, exp);
      assert.ok(dev <= TOL,
        `${shape} ${w}x${h} contract geometry must match drawio (dev=${dev.toFixed(4)}px)`);
    });
  }
}

// Rounded conformance — rhombus/triangle now round exactly like drawio
// (mxShape.addPoints), across arcSize values.
for (const shape of ['rhombus', 'triangle']) {
  for (const arcSize of ['10', '20', '40']) {
    test(`oracle conformance: rounded ${shape} arcSize=${arcSize} == drawio geometry`, () => {
      const style = { shape, rounded: '1', arcSize, fillColor: '#eee', strokeColor: '#333' };
      const oracle = oracleCommands(shape, style, 100, 60);
      const exp = exporterPathD(style, 100, 60);
      const dev = pathDeviation(oracle, exp);
      assert.ok(dev <= TOL,
        `rounded ${shape} (arcSize ${arcSize}) must match drawio (dev=${dev.toFixed(4)}px)`);
    });
  }
}

// C1 (no silent divergence): rounded corners are EITHER faithful OR loudly
// noticed. rhombus/triangle round faithfully (no notice); the not-yet-rounded
// polygons raise a loud notice; rectangle rounds via roundedRectPath (no notice).
test('C1: rounded rhombus/triangle round faithfully with NO notice', () => {
  for (const shape of ['rhombus', 'triangle']) {
    const r = exporter.buildResult(graphFixture(
      { v: { id: 'v', vertex: true } }, { v: { x: 0, y: 0, width: 100, height: 60 } },
      { v: '' }, { v: { shape, rounded: '1', strokeColor: '#000' } }));
    assert.equal(r.notices.length, 0, `${shape} rounded must be faithful (no notice)`);
  }
});
test('C1: rounded hexagon/parallelogram/step/trapezoid are LOUDLY noticed (never silent)', () => {
  for (const shape of ['hexagon', 'parallelogram', 'step', 'trapezoid']) {
    const r = exporter.buildResult(graphFixture(
      { v: { id: 'v', vertex: true } }, { v: { x: 0, y: 0, width: 100, height: 60 } },
      { v: '' }, { v: { shape, rounded: '1', strokeColor: '#000' } }));
    assert.ok(r.notices.some((n) => /rounded corners/.test((n.detail && n.detail.detail) || '')),
      `${shape} rounded must raise a loud notice (no silent square-corner divergence)`);
  }
});
test('C1: rounded rectangle rounds faithfully with NO notice', () => {
  const r = exporter.buildResult(graphFixture(
    { v: { id: 'v', vertex: true } }, { v: { x: 0, y: 0, width: 100, height: 60 } },
    { v: '' }, { v: { shape: 'rectangle', rounded: '1', strokeColor: '#000' } }));
  assert.equal(r.notices.length, 0, 'rounded rectangle is faithful (roundedRectPath)');
});
