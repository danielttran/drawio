// Faithful edge routing for the headless bake, powered by drawio's OWN
// router source. Instead of re-implementing mxEdgeStyle (the previous
// hand-rolled mid-Y elbow silently diverged from every router drawio
// ships -- wrong default elbow orientation, no orthogonal legs between
// waypoints, no jetty/side selection), this module evaluates the REAL
// `mxgraph/src/view/mxEdgeStyle.js` + `mxPerimeter.js` + `mxConstants.js`
// in a Node vm sandbox with a minimal mx* shim, so the print route is the
// same algorithm the editor runs. Browser-free (C2): the sources are plain
// object literals with no DOM dependency.

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const MX_SRC = resolve(__dir, '../../src/main/webapp/mxgraph/src');

function mxSource(rel) {
  return readFileSync(resolve(MX_SRC, rel), 'utf8');
}

// --- minimal mx shims (verbatim semantics of the originals) ---

class MxPoint {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  clone() { return new MxPoint(this.x, this.y); }
  equals(p) { return p != null && p.x === this.x && p.y === this.y; }
}

class MxRectangle extends MxPoint {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    super(x, y);
    this.width = width;
    this.height = height;
  }
  getCenterX() { return this.x + this.width / 2; }
  getCenterY() { return this.y + this.height / 2; }
  setRect(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; }
  clone() { return new MxRectangle(this.x, this.y, this.width, this.height); }
}

class MxCellState extends MxRectangle {
  constructor(x = 0, y = 0, width = 0, height = 0, style = {}) {
    super(x, y, width, height);
    this.style = style;
    this.cell = null;
    this.origin = new MxPoint(0, 0);
    this.absolutePoints = [];
  }
}

function buildSandbox() {
  const sandbox = {};
  // mxUtils subset used by mxEdgeStyle/mxPerimeter. getValue/getNumber/
  // contains/getBoundingBox are tiny and ported verbatim; the long
  // getPortConstraints/reversePortConstraints are EXTRACTED from
  // mxUtils.js source below so their quad/rotation tables cannot drift.
  const mxUtils = {
    getValue(array, key, defaultValue) {
      let value = array != null ? array[key] : null;
      if (value == null) value = defaultValue;
      return value;
    },
    getNumber(array, key, defaultValue) {
      let value = array != null ? array[key] : null;
      if (value == null) value = defaultValue || 0;
      return Number(value);
    },
    contains(state, x, y) {
      return state.x <= x && state.x + state.width >= x &&
             state.y <= y && state.y + state.height >= y;
    },
    getBoundingBox(rect, rotation, cx) {
      let result = null;
      if (rect != null && rotation != null && rotation !== 0) {
        const rad = rotation * (Math.PI / 180);
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        cx = cx != null ? cx
          : new MxPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        let p1 = new MxPoint(rect.x, rect.y);
        let p2 = new MxPoint(rect.x + rect.width, rect.y);
        let p3 = new MxPoint(p2.x, rect.y + rect.height);
        let p4 = new MxPoint(rect.x, p3.y);
        const rotatePoint = (pt) => {
          const dx = pt.x - cx.x;
          const dy = pt.y - cx.y;
          return new MxPoint(dx * cos - dy * sin + cx.x,
                             dy * cos + dx * sin + cx.y);
        };
        p1 = rotatePoint(p1); p2 = rotatePoint(p2);
        p3 = rotatePoint(p3); p4 = rotatePoint(p4);
        result = new MxRectangle(p1.x, p1.y, 0, 0);
        for (const p of [p2, p3, p4]) {
          const minX = Math.min(result.x, p.x);
          const minY = Math.min(result.y, p.y);
          const maxX = Math.max(result.x + result.width, p.x);
          const maxY = Math.max(result.y + result.height, p.y);
          result.x = minX; result.y = minY;
          result.width = maxX - minX; result.height = maxY - minY;
        }
      } else if (rect != null) {
        result = rect.clone();
      }
      return result;
    }
  };

  sandbox.mxUtils = mxUtils;
  sandbox.mxPoint = MxPoint;
  sandbox.mxRectangle = MxRectangle;
  sandbox.mxCellState = MxCellState;
  sandbox.mxStyleRegistry = { putValue() {} };
  // mxEdgeStyle references these names lazily inside functions we don't
  // call from the bake; provide inert placeholders so evaluation succeeds.
  sandbox.mxEdgeSegmentHandler = function () {};
  sandbox.mxGraphView = function () {};

  runInNewContext(mxSource('util/mxConstants.js') + '; this.mxConstants = mxConstants;', sandbox);
  // Pull getPortConstraints / reversePortConstraints out of the real
  // mxUtils.js (self-contained quad/rotation tables).
  const utilsSrc = mxSource('util/mxUtils.js');
  for (const name of ['getPortConstraints', 'reversePortConstraints']) {
    const start = utilsSrc.indexOf(name + ': function');
    if (start < 0) throw new Error('mxUtils.' + name + ' not found');
    const open = utilsSrc.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < utilsSrc.length; i++) {
      const ch = utilsSrc[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const fn = 'mxUtils.' + name + ' = function' +
      utilsSrc.slice(utilsSrc.indexOf('function', start) + 'function'.length, end) + ';';
    runInNewContext(fn, sandbox);
  }
  runInNewContext(mxSource('view/mxPerimeter.js') + '; this.mxPerimeter = mxPerimeter;', sandbox);
  runInNewContext(mxSource('view/mxEdgeStyle.js') + '; this.mxEdgeStyle = mxEdgeStyle;', sandbox);
  return sandbox;
}

let _sandbox = null;
function sandbox() {
  if (_sandbox == null) _sandbox = buildSandbox();
  return _sandbox;
}

// Minimal mxGraphView stand-in (scale 1, translate 0; hints are already
// absolute model coordinates).
function makeView() {
  const sb = sandbox();
  return {
    scale: 1,
    translate: new MxPoint(0, 0),
    graph: {
      gridSize: 10,
      getCellGeometry(cell) { return cell != null ? cell.geometry || null : null; },
      getStylesheet() { return { getDefaultEdgeStyle() { return {}; } }; }
    },
    transformControlPoint(state, pt) {
      return pt != null ? new sb.mxPoint(pt.x, pt.y) : null;
    },
    getRoutingCenterX(state) {
      const f = state.style ? parseFloat(state.style.routingCenterX) || 0 : 0;
      return state.getCenterX() + f * state.width;
    },
    getRoutingCenterY(state) {
      const f = state.style ? parseFloat(state.style.routingCenterY) || 0 : 0;
      return state.getCenterY() + f * state.height;
    }
  };
}

const STYLE_FN = {
  orthogonalEdgeStyle: 'OrthConnector',
  segmentEdgeStyle: 'SegmentConnector',
  elbowEdgeStyle: 'ElbowConnector',
  entityRelationEdgeStyle: 'EntityRelation',
  sideToSideEdgeStyle: 'SideToSide',
  topToBottomEdgeStyle: 'TopToBottom'
};

export function isRoutedEdgeStyle(name) {
  return Object.prototype.hasOwnProperty.call(STYLE_FN, name);
}

// mxGraph.isOrthogonal: these styles get orthogonal floating perimeter
// projection.
const ORTHOGONAL_FNS = new Set([
  'SegmentConnector', 'ElbowConnector', 'SideToSide', 'TopToBottom',
  'EntityRelation', 'OrthConnector'
]);

export function isOrthogonalStyle(name, style) {
  if (style && style.orthogonal != null) return String(style.orthogonal) === '1';
  const fn = STYLE_FN[name];
  return fn != null && ORTHOGONAL_FNS.has(fn);
}

// Make an mxCellState-shaped terminal for the router.
export function makeTerminalState(box, style, cell) {
  const sb = sandbox();
  const st = new sb.mxCellState(box.x, box.y, box.width, box.height, style || {});
  st.cell = cell || { geometry: cell && cell.geometry };
  return st;
}

// Run drawio's real edge style function.
//   styleName  - drawio edgeStyle token (e.g. "orthogonalEdgeStyle")
//   edgeStyle  - the edge's resolved style object
//   sourceState/targetState - terminal states (makeTerminalState) or null
//   p0/pe      - FIXED terminal points (exitX/literal) or null
//   hints      - absolute waypoints (control hints), may be []
// Returns the INNER control points (terminal points excluded), like
// mxGraphView.updatePoints.
export function routeEdge(styleName, edgeStyle, sourceState, targetState, p0, pe, hints) {
  const sb = sandbox();
  const fnName = STYLE_FN[styleName];
  if (!fnName) return null;
  const view = makeView();
  const state = new sb.mxCellState(0, 0, 0, 0, edgeStyle || {});
  state.view = view;
  state.cell = { geometry: { relative: false } };
  state.absolutePoints = [
    p0 != null ? new sb.mxPoint(p0.x, p0.y) : null,
    pe != null ? new sb.mxPoint(pe.x, pe.y) : null
  ];
  if (sourceState != null) sourceState.view = view;
  if (targetState != null) targetState.view = view;
  const result = [];
  const points = (hints || []).map((h) => new sb.mxPoint(h.x, h.y));
  // EntityRelation ignores control hints entirely (mxGraphView passes
  // them, but the function signature reads only source/target).
  sb.mxEdgeStyle[fnName](state, sourceState, targetState,
    points.length ? points : null, result);
  return result.map((p) => ({ x: p.x, y: p.y }));
}

// Perimeter intersection, mirroring mxGraphView.getPerimeterPoint: pick the
// shape's perimeter function and intersect toward `next`. `orthogonal`
// requests axis-projection (used by orthogonal edge styles).
const PERIMETER_BY_SHAPE = {
  ellipse: 'EllipsePerimeter',
  doubleEllipse: 'EllipsePerimeter',
  rhombus: 'RhombusPerimeter',
  triangle: 'TrianglePerimeter',
  hexagon: 'HexagonPerimeter'
};

const PERIMETER_BY_STYLE = {
  ellipsePerimeter: 'EllipsePerimeter',
  rhombusPerimeter: 'RhombusPerimeter',
  trianglePerimeter: 'TrianglePerimeter',
  hexagonPerimeter: 'HexagonPerimeter',
  rectanglePerimeter: 'RectanglePerimeter'
};

export function perimeterPoint(box, style, next, orthogonal) {
  const sb = sandbox();
  const st = style || {};
  let fnName = 'RectanglePerimeter';
  if (st.perimeter != null && PERIMETER_BY_STYLE[st.perimeter]) {
    fnName = PERIMETER_BY_STYLE[st.perimeter];
  } else if (st.shape != null && PERIMETER_BY_SHAPE[st.shape]) {
    fnName = PERIMETER_BY_SHAPE[st.shape];
  } else if (st.ellipse != null || st.shape === 'ellipse') {
    fnName = 'EllipsePerimeter';
  } else if (st.rhombus != null) {
    fnName = 'RhombusPerimeter';
  }
  const bounds = new sb.mxRectangle(box.x, box.y, box.width, box.height);
  const vertex = new sb.mxCellState(box.x, box.y, box.width, box.height, st);
  const pt = sb.mxPerimeter[fnName](
    bounds, vertex, new sb.mxPoint(next.x, next.y), !!orthogonal);
  return pt != null ? { x: pt.x, y: pt.y } : null;
}

// Fixed connection point, port of mxGraph.getConnectionPoint: honors the
// vertex's direction (N/S quarter-turn of the bounds), flipH/flipV
// mirroring, and rotation about the state center. The old fraction-on-the-
// unrotated-box silently attached edges to the wrong side of any rotated/
// flipped/redirected shape.
export function fixedConnectionPoint(box, style, fx, fy, dx, dy) {
  const st = style || {};
  let bounds = { x: box.x, y: box.y, width: box.width, height: box.height };
  const direction = st.direction;
  let r1 = 0;
  if (direction != null && String(st.anchorPointDirection || 1) !== '0') {
    if (direction === 'north') r1 += 270;
    else if (direction === 'west') r1 += 180;
    else if (direction === 'south') r1 += 90;
    // Bounds are rotated 90 degrees for north/south.
    if (direction === 'north' || direction === 'south') {
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      bounds = {
        x: cx - bounds.height / 2,
        y: cy - bounds.width / 2,
        width: bounds.height,
        height: bounds.width
      };
    }
  }
  let point = {
    x: bounds.x + fx * bounds.width + (dx || 0),
    y: bounds.y + fy * bounds.height + (dy || 0)
  };
  if (r1 !== 0) {
    point = rotateAbout(point, r1,
      bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  }
  // flipH/flipV mirror about the ORIGINAL state bounds (mxGraph reads the
  // shape's flip after direction normalization; for north/south the flips
  // are swapped by the stencil flow, mirrored here like mxGraph.js does).
  let flipH = String(st.flipH) === '1';
  let flipV = String(st.flipV) === '1';
  if (direction === 'north' || direction === 'south') {
    const t = flipH; flipH = flipV; flipV = t;
  }
  if (flipH) point.x = 2 * (box.x + box.width / 2) - point.x;
  if (flipV) point.y = 2 * (box.y + box.height / 2) - point.y;
  const rotation = parseFloat(st.rotation) || 0;
  if (rotation !== 0) {
    point = rotateAbout(point, rotation,
      box.x + box.width / 2, box.y + box.height / 2);
  }
  return point;
}

function rotateAbout(pt, deg, cx, cy) {
  const rad = deg * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = pt.x - cx;
  const dy = pt.y - cy;
  return { x: dx * cos - dy * sin + cx, y: dy * cos + dx * sin + cy };
}
