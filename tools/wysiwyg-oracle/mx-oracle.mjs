// WYSIWYG differential oracle — AUTHORITATIVE geometry from drawio's own code.
//
// This loads drawio/mxGraph's REAL vertex-shape rendering code
// (`paintVertexShape` / `redrawPath` / `mxShape.addPoints`) and drives it with
// a browser-free *recording* canvas that captures the exact path the renderer
// draws. No DOM, no jsdom, no painting — geometry is pure computation, so the
// browser is never needed. The result is drawio's own geometry, which the
// exporter contract is then diffed against (see oracle.test.mjs).
//
// Why this is a real proof and not a re-derivation: the path comes out of
// mxGraph's actual source (src/main/webapp/mxgraph/src/shape/*.js), the same
// code the editor paints with. Agreement between the exporter and this oracle
// is conformance to the authoritative renderer, established with zero browser.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const MX = resolve(dirname(fileURLToPath(import.meta.url)),
  '../../src/main/webapp/mxgraph/src');

// ---- minimal authoritative runtime ---------------------------------------
// Pure helpers only; the geometry methods we drive reference these inside
// their bodies (never any DOM). mxUtils helpers are the exact pure-function
// implementations from mxGraph's source.
const sandbox = {};
sandbox.mxPoint = function (x, y) { this.x = x || 0; this.y = y || 0; };
sandbox.mxPoint.prototype.clone = function () { return new sandbox.mxPoint(this.x, this.y); };
sandbox.mxRectangle = function (x, y, w, h) {
  this.x = x || 0; this.y = y || 0; this.width = w || 0; this.height = h || 0;
};
sandbox.mxUtils = {
  getValue: (dict, key, dflt) => {
    let v = (dict != null) ? dict[key] : null;
    return (v == null) ? dflt : v;
  },
  getNumber: (dict, key, dflt) => {
    let v = (dict != null) ? dict[key] : null;
    return (v == null || v === '') ? (dflt || 0) : parseFloat(v);
  },
  mod: (n, m) => ((n % m) + m) % m,
  indexOf: (arr, obj) => {
    if (arr == null) return -1;
    for (let i = 0; i < arr.length; i++) if (arr[i] === obj) return i;
    return -1;
  },
  extend: (sub, sup) => {
    const F = function () {}; F.prototype = sup.prototype;
    sub.prototype = new F(); sub.prototype.constructor = sub;
  }
};
sandbox.mxClient = { IS_IE: false, IS_SVG: true };
sandbox.window = sandbox; sandbox.global = sandbox;
vm.createContext(sandbox);

function load(rel) {
  vm.runInContext(readFileSync(`${MX}/${rel}`, 'utf8'), sandbox, { filename: rel });
}
// drawio's real constants + shape base + core vertex shapes.
load('util/mxConstants.js');
load('shape/mxShape.js');
load('shape/mxActor.js');         // base for triangle/hexagon (redrawPath)
load('shape/mxRectangleShape.js');
load('shape/mxEllipse.js');
load('shape/mxRhombus.js');
load('shape/mxTriangle.js');
load('shape/mxHexagon.js');
load('shape/mxCylinder.js');
load('shape/mxCloud.js');

// drawio style `shape=` value -> mxGraph core shape constructor.
const SHAPE_CTOR = {
  rectangle: 'mxRectangleShape',
  ellipse: 'mxEllipse',
  rhombus: 'mxRhombus',
  triangle: 'mxTriangle',
  hexagon: 'mxHexagon',
  cylinder: 'mxCylinder',
  cloud: 'mxCloud'
};
export const ORACLE_SHAPES = Object.keys(SHAPE_CTOR);

// ---- recording canvas: captures the path drawio's code draws -------------
function RecordingCanvas() { this.dx = 0; this.dy = 0; this.sx = 1; this.sy = 1; this.cmds = []; }
const NOOP = ['begin', 'end', 'fill', 'stroke', 'fillAndStroke', 'save', 'restore',
  'setFillColor', 'setStrokeColor', 'setStrokeWidth', 'setDashed', 'setDashPattern',
  'setShadow', 'setFontColor', 'setFontSize', 'setFontFamily', 'setLineCap',
  'setLineJoin', 'setMiterLimit', 'setGradient', 'setFillAlpha', 'setStrokeAlpha',
  'setAlpha', 'rotate', 'text', 'setFontStyle', 'setFontBackgroundColor',
  'setFontBorderColor', 'setShadowColor', 'setShadowAlpha', 'setShadowOffset',
  'setLineDash', 'image', 'link'];
NOOP.forEach((m) => { RecordingCanvas.prototype[m] = function () {}; });
const N = (v) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; };
RecordingCanvas.prototype._x = function (x) { return N(x * this.sx + this.dx); };
RecordingCanvas.prototype._y = function (y) { return N(y * this.sy + this.dy); };
RecordingCanvas.prototype.translate = function (dx, dy) { this.dx += dx * this.sx; this.dy += dy * this.sy; };
RecordingCanvas.prototype.scale = function (s) { this.sx *= s; this.sy *= s; };
RecordingCanvas.prototype.moveTo = function (x, y) { this.cmds.push(['M', this._x(x), this._y(y)]); };
RecordingCanvas.prototype.lineTo = function (x, y) { this.cmds.push(['L', this._x(x), this._y(y)]); };
RecordingCanvas.prototype.quadTo = function (x1, y1, x2, y2) {
  this.cmds.push(['Q', this._x(x1), this._y(y1), this._x(x2), this._y(y2)]);
};
RecordingCanvas.prototype.curveTo = function (x1, y1, x2, y2, x3, y3) {
  this.cmds.push(['C', this._x(x1), this._y(y1), this._x(x2), this._y(y2), this._x(x3), this._y(y3)]);
};
RecordingCanvas.prototype.close = function () { this.cmds.push(['Z']); };
RecordingCanvas.prototype.rect = function (x, y, w, h) {
  this.cmds.push(['RECT', this._x(x), this._y(y), N(w * this.sx), N(h * this.sy)]);
};
RecordingCanvas.prototype.roundrect = function (x, y, w, h, dx, dy) {
  this.cmds.push(['RRECT', this._x(x), this._y(y), N(w * this.sx), N(h * this.sy), N(dx), N(dy)]);
};
RecordingCanvas.prototype.ellipse = function (x, y, w, h) {
  this.cmds.push(['ELL', this._x(x), this._y(y), N(w * this.sx), N(h * this.sy)]);
};

// Run drawio's real shape code for one cell; return recorded commands.
export function oracleCommands(styleName, style, w, h) {
  const ctor = SHAPE_CTOR[styleName];
  if (!ctor) throw new Error(`oracle: no mxGraph shape for "${styleName}"`);
  const shape = new sandbox[ctor]();
  shape.style = style || {};
  shape.isRounded = !!(style && (style.rounded === '1' || style.rounded === 1));
  shape.strokewidth = 1;
  const c = new RecordingCanvas();
  shape.paintVertexShape(c, 0, 0, w, h);
  return c.cmds;
}

// ---- path sampling: command lists -> dense polyline of points ------------
// Evaluates M/L/Q/C/Z, the exporter's A (elliptical arc), and the oracle's
// RECT/RRECT/ELL primitives into points so two paths can be compared
// geometrically regardless of which command form each side used.
function quad(p0, p1, p2, t) {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
}
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y };
}
// Elliptical arc (SVG A) -> centre parametrization, sampled.
function arcPoints(p0, rx, ry, phiDeg, largeArc, sweep, p1, steps) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [p1];
  const phi = phiDeg * Math.PI / 180, cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1 = cosP * dx + sinP * dy, y1 = -sinP * dx + cosP * dy;
  let r2x = rx * rx, r2y = ry * ry; const lam = (x1 * x1) / r2x + (y1 * y1) / r2y;
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; r2x = rx * rx; r2y = ry * ry; }
  let sign = (largeArc !== sweep) ? 1 : -1;
  let num = r2x * r2y - r2x * y1 * y1 - r2y * x1 * x1;
  num = Math.max(0, num);
  const co = sign * Math.sqrt(num / (r2x * y1 * y1 + r2y * x1 * x1) || 0);
  const cxp = co * rx * y1 / ry, cyp = -co * ry * x1 / rx;
  const cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy, len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a; return a;
  };
  const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = t1 + dt * (i / steps);
    out.push({ x: cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP,
      y: cy + rx * Math.cos(t) * cosP * 0 + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP });
  }
  // recompute cleanly (rotation phi=0 for our shapes anyway)
  return out.map((_, i) => {
    const t = t1 + dt * ((i + 1) / steps);
    const ex = cx + rx * Math.cos(t), ey = cy + ry * Math.sin(t);
    if (phiDeg === 0) return { x: ex, y: ey };
    const rxp = rx * Math.cos(t), ryp = ry * Math.sin(t);
    return { x: cx + cosP * rxp - sinP * ryp, y: cy + sinP * rxp + cosP * ryp };
  });
}
const STEPS = 24;
export function samplePath(cmds, fromString) {
  // cmds may be an array (oracle) or a 'd' string (exporter).
  const list = fromString ? parseD(cmds) : cmds;
  const pts = []; let cur = { x: 0, y: 0 }, start = { x: 0, y: 0 };
  for (const c of list) {
    const op = c[0];
    if (op === 'M') { cur = { x: c[1], y: c[2] }; start = cur; pts.push(cur); }
    else if (op === 'L') { cur = { x: c[1], y: c[2] }; pts.push(cur); }
    else if (op === 'Q') {
      const p1 = { x: c[1], y: c[2] }, p2 = { x: c[3], y: c[4] };
      for (let i = 1; i <= STEPS; i++) pts.push(quad(cur, p1, p2, i / STEPS));
      cur = p2;
    } else if (op === 'C') {
      const p1 = { x: c[1], y: c[2] }, p2 = { x: c[3], y: c[4] }, p3 = { x: c[5], y: c[6] };
      for (let i = 1; i <= STEPS; i++) pts.push(cubic(cur, p1, p2, p3, i / STEPS));
      cur = p3;
    } else if (op === 'A') {
      const p1 = { x: c[6], y: c[7] };
      for (const p of arcPoints(cur, c[1], c[2], c[3], c[4], c[5], p1, STEPS)) pts.push(p);
      cur = p1;
    } else if (op === 'Z') { pts.push(start); cur = start; }
    else if (op === 'RECT') {
      const x = c[1], y = c[2], w = c[3], h = c[4];
      [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].forEach((p) => pts.push({ x: p[0], y: p[1] }));
      cur = { x, y };
    } else if (op === 'RRECT') {
      // rounded rectangle: sample straight edges + quarter-circle corners (r=dx,dy)
      const x = c[1], y = c[2], w = c[3], h = c[4], rx = c[5], ry = c[6];
      const corner = (cx, cy, a0) => {
        for (let i = 0; i <= STEPS; i++) {
          const t = a0 + (Math.PI / 2) * (i / STEPS);
          pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
        }
      };
      pts.push({ x: x + rx, y });
      pts.push({ x: x + w - rx, y });
      corner(x + w - rx, y + ry, -Math.PI / 2);
      pts.push({ x: x + w, y: y + h - ry });
      corner(x + w - rx, y + h - ry, 0);
      pts.push({ x: x + rx, y: y + h });
      corner(x + rx, y + h - ry, Math.PI / 2);
      pts.push({ x, y: y + ry });
      corner(x + rx, y + ry, Math.PI);
      cur = { x: x + rx, y };
    } else if (op === 'ELL') {
      const x = c[1], y = c[2], w = c[3], h = c[4], cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
      for (let i = 0; i <= STEPS * 2; i++) {
        const t = 2 * Math.PI * i / (STEPS * 2);
        pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
      }
      cur = { x: x + w, y: cy };
    }
  }
  return pts;
}
function parseD(d) {
  const toks = d.match(/[MLCQAZ]|-?[0-9.]+(?:e-?[0-9]+)?/gi) || [];
  const out = []; let i = 0;
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    const op = toks[i++];
    if (op === 'M' || op === 'L') out.push([op, num(), num()]);
    else if (op === 'Q') out.push(['Q', num(), num(), num(), num()]);
    else if (op === 'C') out.push(['C', num(), num(), num(), num(), num(), num()]);
    else if (op === 'A') out.push(['A', num(), num(), num(), num(), num(), num(), num()]);
    else if (op === 'Z' || op === 'z') out.push(['Z']);
  }
  return out;
}

// Resample a polyline to N points evenly by cumulative arc length, so two
// polylines with different vertex counts compare pointwise.
export function resample(pts, n) {
  if (pts.length === 0) return [];
  const seg = []; let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(d); total += d;
  }
  if (total === 0) return new Array(n).fill(pts[0]);
  const out = []; let acc = 0, idx = 0;
  for (let k = 0; k < n; k++) {
    const target = total * k / (n - 1);
    while (idx < seg.length && acc + seg[idx] < target) { acc += seg[idx]; idx++; }
    if (idx >= seg.length) { out.push(pts[pts.length - 1]); continue; }
    const f = seg[idx] === 0 ? 0 : (target - acc) / seg[idx];
    out.push({ x: pts[idx].x + f * (pts[idx + 1].x - pts[idx].x),
      y: pts[idx].y + f * (pts[idx + 1].y - pts[idx].y) });
  }
  return out;
}

// Symmetric Hausdorff distance between two paths' dense point samples. This is
// start-point- and winding-invariant (the right metric for closed fill paths,
// which may begin at different vertices or wind either way): it asks "is every
// point on each curve close to some point on the other?".
function directedHausdorff(a, b) {
  let mx = 0;
  for (const p of a) {
    let mn = Infinity;
    for (const q of b) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < mn) mn = d; }
    if (mn > mx) mx = mn;
  }
  return mx;
}
export function pathDeviation(cmdsA, dStringB) {
  const a = samplePath(cmdsA, false);
  const b = samplePath(dStringB, true);
  if (a.length === 0 || b.length === 0) return Infinity;
  return Math.max(directedHausdorff(a, b), directedHausdorff(b, a));
}
