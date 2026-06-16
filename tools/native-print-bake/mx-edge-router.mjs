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
  topToBottomEdgeStyle: 'TopToBottom',
  // Self-loops: mxGraphView.getEdgeStyle routes source==target edges through
  // graph.defaultLoopStyle = mxEdgeStyle.Loop (honors direction/segment and a
  // single dragged hint) -- the synthetic token below is what the parser
  // passes when isLoopStyleEnabled() holds.
  loopEdgeStyle: 'Loop'
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
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // mxGraphView.getFloatingTerminalPoint: a rotated terminal rotates `next`
  // by -rotation about its centre, intersects the UNROTATED perimeter, then
  // rotates the result back (+rotation); orthogonal projection applies only
  // when rotation == 0. Ignoring this attached edges to the unrotated box --
  // visibly detached from / buried in any rotated shape.
  const rotation = parseFloat(st.rotation) || 0;
  let target = { x: next.x, y: next.y };
  if (rotation !== 0) {
    target = rotatePointAbout(target, -rotation, cx, cy);
  }
  // mxGraphView.getPerimeterPoint: flipH/flipV (incl. legacy stencilFlipH/V)
  // mirror `next` before and the result after -- matters for asymmetric
  // perimeters (triangle, rhombus off-centre targets).
  const flipH = String(st.flipH) === '1' || String(st.stencilFlipH) === '1';
  const flipV = String(st.flipV) === '1' || String(st.stencilFlipV) === '1';
  if (flipH) target.x = 2 * cx - target.x;
  if (flipV) target.y = 2 * cy - target.y;
  const bounds = new sb.mxRectangle(box.x, box.y, box.width, box.height);
  const vertex = new sb.mxCellState(box.x, box.y, box.width, box.height, st);
  const pt = sb.mxPerimeter[fnName](
    bounds, vertex, new sb.mxPoint(target.x, target.y),
    rotation === 0 && !!orthogonal);
  if (pt == null) return null;
  let out = { x: pt.x, y: pt.y };
  if (flipH) out.x = 2 * cx - out.x;
  if (flipV) out.y = 2 * cy - out.y;
  if (rotation !== 0) {
    out = rotatePointAbout(out, rotation, cx, cy);
  }
  return out;
}

function rotatePointAbout(pt, deg, cx, cy) {
  const rad = deg * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = pt.x - cx;
  const dy = pt.y - cy;
  return { x: dx * cos - dy * sin + cx, y: dy * cos + dx * sin + cy };
}

// Fixed connection point: exact port of mxGraph.getConnectionPoint
// (mxGraph.js:7200-7322). Order matters and each step was previously wrong
// or missing: (1) the bounds rotate90 for N/S is UNCONDITIONAL (outside the
// anchorPointDirection gate); (2) flips (swapped for N/S) mirror the point
// BEFORE the direction quarter-turn; (3) the quarter-turn applies only when
// anchorPointDirection == 1 (default; the style stores numeric 0, so the old
// `st.anchorPointDirection || 1` truthiness silently ignored an explicit 0);
// (4) constraint.perimeter (exitPerimeter/entryPerimeter, DEFAULT TRUE)
// projects the anchor through the shape's perimeter function -- skipping it
// detached every fixed anchor from ellipse/rhombus/triangle outlines;
// (5) the cell rotation applies last. No rounding (mxGraphView
// getFixedTerminalPoint passes round=false).
export function fixedConnectionPoint(box, style, fx, fy, dx, dy, projectPerimeter) {
  const st = style || {};
  // mxGraph.getConnectionPoint computes the fixed anchor against
  // view.getPerimeterBounds(vertex) (mxGraphView.js:1824-1834), which GROWS the
  // box by the terminal's perimeterSpacing on every side before placing
  // fx*width / fy*height and projecting through the perimeter. A fixed anchor on
  // a shape with perimeterSpacing previously attached at the raw box edge.
  const ps = parseFloat(st.perimeterSpacing) || 0;
  if (ps !== 0) {
    box = { x: box.x - ps, y: box.y - ps, width: box.width + 2 * ps, height: box.height + 2 * ps };
  }
  const ccx = box.x + box.width / 2;
  const ccy = box.y + box.height / 2;
  const ns = st.direction === 'north' || st.direction === 'south';
  const bounds = ns
    ? { x: ccx - box.height / 2, y: ccy - box.width / 2,
        width: box.height, height: box.width }
    : { x: box.x, y: box.y, width: box.width, height: box.height };
  let point = {
    x: bounds.x + fx * bounds.width + (dx || 0),
    y: bounds.y + fy * bounds.height + (dy || 0)
  };
  let flipH = String(st.flipH) === '1';
  let flipV = String(st.flipV) === '1';
  // Legacy stencilFlipH/V applies only when the shape HAS a stencil
  // (mxGraph.getConnectionPoint gates on shape.stencil != null).
  if (typeof st.shape === 'string' && st.shape.indexOf('mxgraph.') === 0) {
    flipH = flipH || String(st.stencilFlipH) === '1';
    flipV = flipV || String(st.stencilFlipV) === '1';
  }
  if (ns) { const t = flipH; flipH = flipV; flipV = t; }
  if (flipH) point.x = 2 * (bounds.x + bounds.width / 2) - point.x;
  if (flipV) point.y = 2 * (bounds.y + bounds.height / 2) - point.y;
  let r1 = 0;
  const apd = st.anchorPointDirection;
  if (st.direction != null && (apd == null || String(apd) === '1')) {
    if (st.direction === 'north') r1 = 270;
    else if (st.direction === 'west') r1 = 180;
    else if (st.direction === 'south') r1 = 90;
  }
  if (r1 !== 0) point = rotateAbout(point, r1, ccx, ccy);
  if (projectPerimeter !== false) {
    // getPerimeterPoint applies the flip mirroring itself; rotation is NOT
    // part of the projection here (applied separately below, like mx r2).
    const proj = perimeterPoint(box, Object.assign({}, st, { rotation: 0 }),
      point, false);
    if (proj) point = proj;
  }
  const rotation = parseFloat(st.rotation) || 0;
  if (rotation !== 0) point = rotateAbout(point, rotation, ccx, ccy);
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
