import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const exporter = require('./exporter.js');

function graphFixture(cells, states, labels, styles, bounds = { x: 10, y: 20, width: 400, height: 300 }, scale = 2) {
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
    getLabel: (cell) => labels[cell.id] || ''
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
