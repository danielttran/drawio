// Parse .drawio (mxGraph XML) files into a fake graph model compatible with
// the exporter's buildResult() function.
//
// Supports both uncompressed and deflate-compressed diagram content.
// Pure Node.js (no jsdom, no browser); uses node:zlib for decompression.

import { inflateRawSync } from 'node:zlib';
import {
  isRoutedEdgeStyle, isOrthogonalStyle, makeTerminalState, routeEdge,
  perimeterPoint, fixedConnectionPoint
} from './mx-edge-router.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// --- attribute parsing ---

function decodeEntities(s) {
  // &amp; must decode LAST (decoding it first double-decoded "&amp;lt;" to
  // "<"), and numeric references need fromCodePoint (fromCharCode corrupts
  // astral code points like emoji to private-use garbage).
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// Parse XML attribute string (key="value" pairs) → plain object.
// Handles single-quoted values too.
function parseAttrs(str) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1]] = decodeEntities(m[2] != null ? m[2] : m[3]);
  }
  return attrs;
}

function cloneStyle(style) {
  return { ...(style || {}) };
}

function loadDefaultStylesheet() {
  const xml = readFileSync(resolve(__dir, '../../src/main/webapp/styles/default.xml'), 'utf8');
  const raw = {};
  const addRe = /<add\b([^>]*)>([\s\S]*?)<\/add>/gi;
  let m;
  while ((m = addRe.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    const name = attrs.as;
    if (!name) continue;
    const style = {};
    const childRe = /<add\b([^>]*?)\/>/gi;
    let c;
    while ((c = childRe.exec(m[2])) !== null) {
      const ca = parseAttrs(c[1]);
      if (ca.as) style[ca.as] = ca.value != null ? ca.value : '';
    }
    raw[name] = { extend: attrs.extend || null, style };
  }

  const resolved = {};
  const resolveStyle = (name, seen = new Set()) => {
    if (resolved[name]) return resolved[name];
    const entry = raw[name];
    if (!entry) return {};
    if (seen.has(name)) return cloneStyle(entry.style);
    seen.add(name);
    resolved[name] = {
      ...(entry.extend ? resolveStyle(entry.extend, seen) : {}),
      ...entry.style
    };
    return resolved[name];
  };

  Object.keys(raw).forEach((name) => resolveStyle(name));
  return {
    defaultVertex: resolved.defaultVertex || {},
    defaultEdge: resolved.defaultEdge || {},
    named: resolved
  };
}

const DEFAULT_STYLESHEET = loadDefaultStylesheet();

function splitStyleTokens(s) {
  if (!s) return [];
  const parts = [];
  let cur = '';
  let inDataUri = false;
  for (let i = 0; i < s.length; i++) {
    if (!inDataUri && s.slice(i, i + 5).toLowerCase() === 'data:') {
      inDataUri = true;
    }
    if (s[i] === ';' && !inDataUri) {
      parts.push(cur);
      cur = '';
    } else {
      if (inDataUri && s[i] === ',') inDataUri = false;
      cur += s[i];
    }
  }
  if (cur) parts.push(cur);
  return parts.map((part) => part.trim()).filter(Boolean);
}

// Parse draw.io style string → object.
// "ellipse;fillColor=#ff0000;strokeColor=#0000ff;" → { shape:'ellipse', fillColor:'#ff0000', ... }
// "rounded=1;whiteSpace=wrap;" → { rounded:'1', whiteSpace:'wrap' }
// data: URI values (e.g. image=data:image/png;base64,...) are kept atomic.
function parseStyle(s) {
  if (!s) return {};
  const style = {};
  for (const tok of splitStyleTokens(s)) {
    const eq = tok.indexOf('=');
    if (eq < 0) {
      if (tok) style.shape = tok;
    } else {
      const k = tok.slice(0, eq).trim();
      const v = tok.slice(eq + 1).trim();
      // Match mxStylesheet.getCellStyle: numeric values are parseFloat'd to
      // NUMBERS in the real browser. Keeping them as strings here masks bugs
      // where exporter.js does `style.x === '0'` (passes on a string, fails on
      // the number the browser actually provides). isNumeric mirrors mxUtils.
      if (k) style[k] = isStyleNumeric(v) ? parseFloat(v) : v;
    }
  }
  return style;
}

// Browser-faithful mxGraph.getCellStyle for the offline harness:
// clone(defaultVertex/defaultEdge), then mxStylesheet.getCellStyle semantics.
function faithfulCellStyle(rawStyle, isEdge) {
  const style = (rawStyle && rawStyle.trim().startsWith(';'))
    ? {}
    : cloneStyle(isEdge ? DEFAULT_STYLESHEET.defaultEdge : DEFAULT_STYLESHEET.defaultVertex);
  if (!rawStyle) return style;

  for (const tok of splitStyleTokens(rawStyle)) {
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      const key = tok.slice(0, eq).trim();
      const value = tok.slice(eq + 1).trim();
      if (!key) continue;
      if (value === 'none') {
        delete style[key];
      } else {
        style[key] = isStyleNumeric(value) ? parseFloat(value) : value;
      }
    } else {
      const named = DEFAULT_STYLESHEET.named[tok];
      if (named) {
        Object.assign(style, named);
      } else if (tok) {
        // drawio registers some shapes/styles at runtime outside default.xml.
        // Preserve the token as a shape so the harness remains shape-complete.
        style.shape = tok;
      }
    }
  }
  return style;
}

// Mirror of mxUtils.isNumeric: true for "0","20","0.05","-5"; false for
// "#FFF9B2","west","wrap","1ba1e2" (hex-ish), "" .
function isStyleNumeric(n) {
  return n !== '' && !isNaN(parseFloat(n)) && isFinite(n) &&
    (typeof n !== 'string' || n.toLowerCase().indexOf('0x') < 0);
}

// --- XML structure extraction ---

// Decode a single diagram block (which may be compressed or inline XML).
// Returns the mxGraphModel XML string, or null on failure.
function decodeDiagramBlock(content) {
  const raw = content.trim();
  if (!raw) return null;
  if (raw.startsWith('<')) return raw; // already uncompressed XML
  // Compressed: base64 + deflate-raw + URL-encoding
  try {
    const buf = Buffer.from(raw, 'base64');
    const inflated = inflateRawSync(buf).toString('utf8');
    return decodeURIComponent(inflated);
  } catch {
    return null;
  }
}

// Extract all diagram model XML strings from a .drawio file.
// Returns an array of { name, xml } objects (one per page/diagram).
function extractAllModels(xml) {
  // Multi-diagram file: <mxfile><diagram ...>...</diagram>...</mxfile>
  const diagRe = /<diagram([^>]*)>([\s\S]*?)<\/diagram>/gi;
  const results = [];
  let m;
  let diagramIndex = 0;
  while ((m = diagRe.exec(xml)) !== null) {
    const diagAttrs = parseAttrs(m[1]);
    const decoded = decodeDiagramBlock(m[2]);
    if (decoded) {
      results.push({ name: diagAttrs.name || '', id: diagAttrs.id || '', xml: decoded });
    } else if (m[2].trim() === '') {
      // Empty/blank page (the common "added a new page" serialization):
      // drawio keeps it as a BLANK SHEET that counts toward %pagecount% and
      // renumbers nothing. Dropping it silently miscounted pages and shifted
      // %pagenumber% on the surviving pages. Emit a minimal empty model.
      results.push({ name: diagAttrs.name || '', id: diagAttrs.id || '',
        xml: '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>' });
    } else {
      // A page that exists but cannot be decoded must REFUSE the whole
      // bake: silently printing the other pages is a partial document --
      // the worst C1 outcome for an unattended print.
      throw new Error('drawio page ' + (diagramIndex + 1) +
        (diagAttrs.name ? ' ("' + diagAttrs.name + '")' : '') +
        ' could not be decoded (corrupt base64/deflate content)');
    }
    diagramIndex++;
  }
  if (results.length > 0) return results;

  // Single bare mxGraphModel (no mxfile wrapper)
  if (/<mxGraphModel/i.test(xml)) return [{ name: '', id: '', xml }];
  return [];
}

// drawio wraps cells that carry metadata (custom attributes, links, tooltips)
// in <object ...><mxCell .../></object> (or <UserObject>): the id and the
// display label live on the WRAPPER, not the inner mxCell. Flatten them so the
// inner mxCell gets the wrapper's id + value (kept raw/encoded so the normal
// attribute decode runs once). Without this, object-wrapped cells have no id
// and are dropped entirely from the print.
function flattenObjectWrappers(xml) {
  return xml.replace(/<(object|UserObject)\b([^>]*?)>([\s\S]*?)<\/\1>/gi,
    function (full, tag, rawAttrs, inner) {
      const idM = /\bid\s*=\s*"([^"]*)"/i.exec(rawAttrs);
      const lblM = /\blabel\s*=\s*"([^"]*)"/i.exec(rawAttrs);
      const idRaw = idM ? idM[1] : '';
      const lblRaw = lblM ? lblM[1] : '';
      // Preserve the wrapper's OTHER attributes (custom data fields like
      // PATIENT_ID/lot/expiry, plus `placeholders`) under a data-np- prefix so
      // %placeholder% labels resolve to their values like drawio's
      // convertValueToString. Dropping them printed the literal %PATIENT_ID%
      // token -- a silent, patient-safety-grade divergence for variable-data
      // (e.g. medical) labels. Prefixed so they cannot collide with mxCell's
      // own structural attributes.
      let meta = '';
      const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
      let am;
      while ((am = attrRe.exec(rawAttrs)) !== null) {
        if (/^(id|label)$/i.test(am[1])) continue;
        meta += ' data-np-' + am[1] + '="' + am[2] + '"';
      }
      return inner.replace(/<mxCell\b([^>]*?)(\/?)>/i, function (cm, cattrs, sc) {
        const clean = cattrs.replace(/\s+id\s*=\s*"[^"]*"/i, '').replace(/\s+value\s*=\s*"[^"]*"/i, '');
        return '<mxCell id="' + idRaw + '" value="' + lblRaw + '"' + clean + meta + (sc ? '/' : '') + '>';
      });
    });
}

// Parse all mxCell elements from within <root>...</root>.
function parseCells(xml) {
  xml = flattenObjectWrappers(xml);
  const cells = {};
  // DOCUMENT order, not dict order: JS objects iterate integer-LIKE keys
  // numerically ascending, which inverted "Bring to Front"/"Send to Back"
  // stacking for numeric ids when building the z-order tree below.
  const docOrder = [];

  // Match each mxCell — self-closing or paired.
  // Note: the value attribute may contain HTML entities but not raw '<>'
  // (draw.io always entity-encodes attributes), so this regex is safe.
  const cellRe = /<mxCell([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/gi;
  let m;
  while ((m = cellRe.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    const id = attrs.id;
    if (id == null) continue;

    // Custom object-wrapper attributes (data-np-* from flattenObjectWrappers):
    // the variable-data fields + `placeholders` flag used to resolve %token%
    // labels. Collected into cell.meta (prefix stripped).
    let meta = null;
    for (const k in attrs) {
      if (k.indexOf('data-np-') === 0) {
        (meta || (meta = {}))[k.slice(8)] = attrs[k];
      }
    }

    const cell = {
      meta,
      id,
      vertex:   attrs.vertex === '1',
      edge:     attrs.edge   === '1',
      value:    attrs.value  || '',
      // mxCell.visible defaults true; visible="0" hides the cell (and, for a
      // layer, all its descendants) — such content must NOT print.
      visible:  attrs.visible !== '0',
      // collapsed="1": the cell renders at its (collapsed) geometry, but its
      // descendants are NOT shown.
      collapsed: attrs.collapsed === '1',
      parent:   attrs.parent || null,
      source:   attrs.source || null,
      target:   attrs.target || null,
      rawStyle: attrs.style || '',
      style:    parseStyle(attrs.style || ''),
      resolvedStyle: faithfulCellStyle(attrs.style || '', attrs.edge === '1'),
      geometry: null,
      children: []
    };

    // mxGeometry inside the cell body
    const body = m[2] || '';
    const geomRe = /<mxGeometry([^>]*?)(?:\/>|>[\s\S]*?<\/mxGeometry>)/i.exec(body);
    if (geomRe) {
      const ga = parseAttrs(geomRe[1]);
      cell.geometry = {
        x:        parseFloat(ga.x      || 0) || 0,
        y:        parseFloat(ga.y      || 0) || 0,
        width:    parseFloat(ga.width  || 0) || 0,
        height:   parseFloat(ga.height || 0) || 0,
        relative: ga.relative === '1'
      };
      // Parse mxPoint children inside mxGeometry.
      // offset: pixel offset for relative-geometry vertices — stored separately.
      // sourcePoint/targetPoint/waypoints: go into points[] for edge path rendering.
      const ptRe = /<mxPoint\s([^>]*?)\/>/gi;
      const points = [];
      let pt;
      while ((pt = ptRe.exec(body)) !== null) {
        const pa = parseAttrs(pt[1]);
        if (pa.as === 'offset') {
          cell.geometry.offset = { x: parseFloat(pa.x || 0) || 0, y: parseFloat(pa.y || 0) || 0 };
        } else if (pa.as === 'sourcePoint') {
          cell.geometry.sourcePoint = { x: parseFloat(pa.x || 0) || 0, y: parseFloat(pa.y || 0) || 0 };
        } else if (pa.as === 'targetPoint') {
          cell.geometry.targetPoint = { x: parseFloat(pa.x || 0) || 0, y: parseFloat(pa.y || 0) || 0 };
        } else {
          points.push({ x: parseFloat(pa.x || 0) || 0, y: parseFloat(pa.y || 0) || 0 });
        }
      }
      cell.geometry.points = points.length ? points : null;
    }

    cells[id] = cell;
    docOrder.push(cell);
  }

  // Build parent→children tree (for collectCellsInZOrder) in DOCUMENT
  // order — mxGraphModel child order IS the z-order (last paints on top).
  for (const cell of docOrder) {
    if (cell.parent != null && cells[cell.parent]) {
      cells[cell.parent].children.push(cell);
    }
  }

  return cells;
}

// Compute the absolute x,y position of a cell by accumulating parent offsets.
// Cells with parent='0' or parent='1' have absolute geometry; cells inside
// containers have geometry relative to their parent.
//
// Vertices with geometry.relative=true use x,y as fractions (0–1) of parent
// width/height plus an optional pixel offset (geometry.offset). This is how
// draw.io positions decorators like UML component notches.
function absolutePos(cell, cells, depth) {
  if (!cell.geometry) return { ax: 0, ay: 0 };
  const g = cell.geometry;
  const parentId = cell.parent;
  // Cycle guard: a malformed/imported file can contain a parent cycle (A->B,
  // B->A), which drawio's model cannot hold but the parser does not reject.
  // Without this the recursion / parent-walk below loops forever and the
  // unattended bake hangs with no output and no notice -- the worst outcome.
  depth = depth || 0;
  if (depth > 1000) return { ax: g.x || 0, ay: g.y || 0 };

  if (g.relative && cell.vertex && parentId && parentId !== '0' && parentId !== '1') {
    const parent = cells[parentId];
    if (parent && parent.geometry) {
      const ox = g.offset ? g.offset.x : 0;
      const oy = g.offset ? g.offset.y : 0;
      const relX = (parent.geometry.width  || 0) * (g.x || 0) + ox;
      const relY = (parent.geometry.height || 0) * (g.y || 0) + oy;
      const { ax: pax, ay: pay } = absolutePos(parent, cells, depth + 1);
      // mxGraphView.updateVertexState: a RELATIVE child of a rotated parent
      // rotates its CENTER around the parent center (absolute-geometry
      // children stay put — the editor bakes rotation into their geometry).
      // Without this the child printed at the unrotated spot while the
      // parent body rotated away from it.
      const pStyle = parent.resolvedStyle || parent.style || {};
      const rot = parseFloat(pStyle.rotation || 0) || 0;
      if (rot !== 0) {
        const cw = g.width || 0, ch = g.height || 0;
        const pcx = pax + (parent.geometry.width || 0) / 2;
        const pcy = pay + (parent.geometry.height || 0) / 2;
        const cx = pax + relX + cw / 2;
        const cy = pay + relY + ch / 2;
        const rad = rot * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const dx = cx - pcx, dy = cy - pcy;
        return { ax: pcx + dx * cos - dy * sin - cw / 2,
                 ay: pcy + dx * sin + dy * cos - ch / 2 };
      }
      return { ax: pax + relX, ay: pay + relY };
    }
  }

  let ax = g.x || 0;
  let ay = g.y || 0;
  let pid = parentId;
  let hops = 0;
  while (pid && pid !== '0' && pid !== '1' && hops++ < 1000) {
    const parent = cells[pid];
    if (!parent || !parent.geometry) break;
    ax += parent.geometry.x || 0;
    ay += parent.geometry.y || 0;
    pid = parent.parent;
  }
  return { ax, ay };
}

function absoluteBox(cell, cells) {
  if (!cell || !cell.geometry) return null;
  const { ax, ay } = absolutePos(cell, cells);
  return {
    x: ax,
    y: ay,
    width: cell.geometry.width || 0,
    height: cell.geometry.height || 0
  };
}

// mxGraphView.getVisibleTerminal: an edge whose terminal sits inside a
// collapsed ancestor attaches to that ancestor (the child is hidden), not
// to the hidden child's stale geometry.
function resolveVisibleTerminal(terminalId, cells) {
  let cell = terminalId ? cells[terminalId] : null;
  if (!cell) return null;
  const chain = [];
  let cur = cell;
  while (cur) { chain.push(cur); cur = cur.parent != null ? cells[cur.parent] : null; }
  // mxGraphView.updateEdgeState: a terminal on a HIDDEN layer/cell has no
  // visible state, and the editor then shows NO edge at all. Returning the
  // hidden terminal here printed an edge into empty space -- a silent
  // divergence. The HIDDEN marker tells edgePoints to drop the edge (vs a
  // dangling/unconnected end, which legitimately floats).
  for (const link of chain) {
    if (link.visible === false) return 'HIDDEN';
  }
  // The OUTERMOST collapsed ancestor above the terminal is the visible one.
  for (let i = chain.length - 1; i > 0; i--) {
    if (chain[i].collapsed) return chain[i];
  }
  return cell;
}

// String-safe style flag: parseStyle stores numerics as numbers, so a
// === '1' comparison silently never matched (mxUtils.getValue semantics).
function styleFlag(style, key) {
  return style != null && style[key] != null && String(style[key]) === '1';
}

function terminalPoint(edge, cells, terminalId, isSource, toward, orthogonal) {
  const terminal = resolveVisibleTerminal(terminalId, cells);
  const box = absoluteBox(terminal, cells);
  if (!box) return null;
  const style = edge.style || {};
  const pxKey = isSource ? 'exitX' : 'entryX';
  const pyKey = isSource ? 'exitY' : 'entryY';
  // mxGraph.getConnectionConstraint: a FIXED anchor needs BOTH coordinates;
  // a lone exitX/entryX leaves the end FLOATING (the 0.5 default invented
  // an anchor the editor does not draw).
  if (style[pxKey] != null && style[pyKey] != null) {
    const px = parseFloat(style[pxKey] ?? 0.5);
    const py = parseFloat(style[pyKey] ?? 0.5);
    const dx = parseFloat(style[isSource ? 'exitDx' : 'entryDx'] || 0) || 0;
    const dy = parseFloat(style[isSource ? 'exitDy' : 'entryDy'] || 0) || 0;
    // mxGraph.getConnectionPoint: the fraction applies to the direction-
    // normalized bounds, then flip mirroring, the direction quarter-turn,
    // the PERIMETER PROJECTION (exitPerimeter/entryPerimeter default true --
    // anchors sit ON the ellipse/rhombus outline, not the bounding box), and
    // the vertex rotation last.
    const perimKey = isSource ? 'exitPerimeter' : 'entryPerimeter';
    const perim = style[perimKey] == null || String(style[perimKey]) !== '0';
    return fixedConnectionPoint(box, terminal && terminal.resolvedStyle
      ? terminal.resolvedStyle : (terminal && terminal.style) || {}, px, py, dx, dy, perim);
  }

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (!toward) return { x: cx, y: cy };
  // Real perimeter intersection (rectangle/ellipse/rhombus/triangle/...),
  // mirroring mxGraphView.getPerimeterPoint -- the old side-midpoint made
  // printed edges visibly detach from non-rectangular shapes.
  const tStyle = terminal && terminal.resolvedStyle
    ? terminal.resolvedStyle : (terminal && terminal.style) || {};
  // mxGraphView.updateFloatingTerminalPoint + getPerimeterBounds: the
  // perimeter spacing GROWS the perimeter bounds before the intersection
  // (edge perimeterSpacing + per-end source/targetPerimeterSpacing + the
  // TERMINAL's own perimeterSpacing style), for FLOATING ends only (fixed
  // exitX/exitY anchors returned above untouched). The old endpoint nudge
  // along the line gave wrong geometry on diagonal approaches and spaced
  // fixed anchors too.
  const eStyle = edge.resolvedStyle || edge.style || {};
  let border = parseFloat(eStyle.perimeterSpacing || 0) || 0;
  border += parseFloat(
    eStyle[isSource ? 'sourcePerimeterSpacing' : 'targetPerimeterSpacing'] || 0) || 0;
  border += parseFloat(tStyle.perimeterSpacing || 0) || 0;
  const pBox = border !== 0
    ? { x: box.x - border, y: box.y - border,
        width: box.width + 2 * border, height: box.height + 2 * border }
    : box;
  const pt = perimeterPoint(pBox, tStyle, toward, !!orthogonal);
  if (pt) return pt;
  return { x: cx, y: cy };
}

function edgePoints(cell, cells) {
  const g = cell.geometry;
  const { ax, ay } = absolutePos(cell, cells);
  const waypoints = (g.points || []).map((pt) => ({ x: pt.x + ax, y: pt.y + ay }));
  // Route with the stylesheet-RESOLVED style, exactly like the editor: the
  // routers read defaulted keys the raw style omits (e.g. jettySize=auto
  // reads endArrow/endSize from defaultEdge), so raw-style routing produced
  // different jetties than the editor for customized arrow sizes.
  const style = cell.resolvedStyle || cell.style || {};
  const noEdgeStyle = styleFlag(style, 'noEdgeStyle');
  const styleName = !noEdgeStyle && style.edgeStyle != null ? String(style.edgeStyle) : null;

  const srcResolved = resolveVisibleTerminal(cell.source, cells);
  const tgtResolved = resolveVisibleTerminal(cell.target, cells);
  // mxGraphView.updateEdgeState removes any edge whose CONNECTED terminal
  // has no visible state -- the editor shows no edge at all, so printing
  // one (into the hidden shape's empty space) was a silent divergence.
  if (srcResolved === 'HIDDEN' || tgtResolved === 'HIDDEN') return null;
  const srcCell = srcResolved;
  const tgtCell = tgtResolved;
  const sourceBox = absoluteBox(srcCell, cells);
  const targetBox = absoluteBox(tgtCell, cells);
  const sourceCenter = sourceBox
    ? { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }
    : null;
  const targetCenter = targetBox
    ? { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 }
    : null;

  // Literal terminal points apply ONLY to an endpoint whose cell ref is
  // missing (mxGraphView.getFixedTerminalPoint). drawio routinely leaves a
  // stale sourcePoint/targetPoint on connected edges; treating it as
  // authoritative silently disabled edge-style routing.
  const literalSrc = (!srcCell && g.sourcePoint)
    ? { x: g.sourcePoint.x + ax, y: g.sourcePoint.y + ay } : null;
  const literalTgt = (!tgtCell && g.targetPoint)
    ? { x: g.targetPoint.x + ax, y: g.targetPoint.y + ay } : null;

  // BOTH coordinates make a fixed anchor (mxGraph.getConnectionConstraint).
  const hasExit = style.exitX != null && style.exitY != null;
  const hasEntry = style.entryX != null && style.entryY != null;

  // Self-loop: mxGraphView.isLoopStyleEnabled -- source == target, fewer
  // than 2 hints, and (orthogonalLoop unset OR no fixed exit/entry point)
  // routes through mxEdgeStyle.Loop REGARDLESS of the edge's edgeStyle
  // (honoring direction/segment and a single dragged hint). The previous
  // hand-rolled right-side loop silently ignored direction= and hints.
  const isLoop = srcCell != null && srcCell === tgtCell &&
    waypoints.length < 2 &&
    (!styleFlag(style, 'orthogonalLoop') || (!hasExit && !hasEntry));
  const effStyleName = isLoop ? 'loopEdgeStyle' : styleName;

  // mxGraph.isOrthogonal: the bare style flag DECIDES when present (a plain
  // no-edgeStyle edge with orthogonal=1 projects its floating terminals
  // orthogonally); only when absent does the edge style imply it.
  const orth = style.orthogonal != null
    ? String(style.orthogonal) === '1'
    : (effStyleName ? isOrthogonalStyle(effStyleName, style) : false);
  const fixedSrc = literalSrc ||
    (hasExit && sourceBox ? terminalPoint(cell, cells, cell.source, true, null, orth) : null);
  const fixedTgt = literalTgt ||
    (hasEntry && targetBox ? terminalPoint(cell, cells, cell.target, false, null, orth) : null);

  if (effStyleName && isRoutedEdgeStyle(effStyleName) &&
      (sourceBox || fixedSrc) && (targetBox || fixedTgt)) {
    const srcStyle = srcCell
      ? (srcCell.resolvedStyle || srcCell.style || {}) : {};
    const tgtStyle = tgtCell
      ? (tgtCell.resolvedStyle || tgtCell.style || {}) : {};
    const sState = sourceBox ? makeTerminalState(sourceBox, srcStyle, srcCell) : null;
    const tState = targetBox ? makeTerminalState(targetBox, tgtStyle, tgtCell) : null;
    // EntityRelation never reads control hints (mxEdgeStyle.js).
    const hints = effStyleName === 'entityRelationEdgeStyle' ? [] : waypoints;
    const inner = routeEdge(effStyleName, style, sState, tState,
      fixedSrc, fixedTgt, hints) || [];
    const startToward = inner[0] || fixedTgt || targetCenter || fixedSrc;
    const endToward = inner[inner.length - 1] || fixedSrc || sourceCenter || fixedTgt;
    const start = fixedSrc ||
      (startToward ? terminalPoint(cell, cells, cell.source, true, startToward, orth) : null);
    const end = fixedTgt ||
      (endToward ? terminalPoint(cell, cells, cell.target, false, endToward, orth) : null);
    const pts = [];
    if (start) pts.push(start);
    for (const p of inner) pts.push(p);
    if (end) pts.push(end);
    const out = pts.filter((p, i) => i === 0 ||
      Math.abs(p.x - pts[i - 1].x) > 0.01 || Math.abs(p.y - pts[i - 1].y) > 0.01);
    if (out.length >= 2) return out;
  }

  const out = waypoints.slice();
  if (literalSrc) out.unshift(literalSrc);
  if (literalTgt) out.push(literalTgt);
  if (out.length === 0 && sourceCenter && targetCenter) {
    // No waypoints: mxGraphView.updateFloatingTerminalPoints computes the
    // TARGET point first (aiming at the source center), then aims the
    // source at that POINT (getNextPoint picks the freshly-set pe). Aiming
    // both ends at the opposite CENTER gave the same ray for disjoint
    // shapes but flipped the attachment side when the shapes overlap.
    const end = terminalPoint(cell, cells, cell.target, false, sourceCenter, orth)
      || targetCenter;
    const start = terminalPoint(cell, cells, cell.source, true, end, orth)
      || sourceCenter;
    return [start, end];
  }
  const firstToward = out.length > (literalSrc ? 1 : 0) ? out[literalSrc ? 1 : 0] : (out[0] || targetCenter);
  const lastToward = out[out.length - 1] || sourceCenter;
  const src = literalSrc ? null
    : terminalPoint(cell, cells, cell.source, true, firstToward, orth);
  const tgt = literalTgt ? null
    : terminalPoint(cell, cells, cell.target, false, lastToward, orth);
  if (src) out.unshift(src);
  if (tgt) out.push(tgt);

  if (out.length < 2 && sourceCenter && targetCenter) {
    const end = terminalPoint(cell, cells, cell.target, false, sourceCenter, orth) || targetCenter;
    const start = terminalPoint(cell, cells, cell.source, true, end, orth) || sourceCenter;
    return [start, end];
  }

  return out;
}

// A cell is painted only if its parent chain reaches the root ('0') or a layer
// ('1'). An orphan (parent id that doesn't exist) or a cell in a parent cycle is
// NOT in the paint tree, so it must not inflate the auto-fit page bounds either
// (doing so silently enlarged the sheet / shifted content vs drawio).
function isReachableFromRoot(cell, cells) {
  let pid = cell.parent;
  let hops = 0;
  while (hops++ < 1000) {
    if (pid === '0' || pid === '1') return true;
    if (pid == null) return false;
    const parent = cells[pid];
    if (!parent) return false; // orphan: parent does not exist
    pid = parent.parent;
  }
  return false; // cycle / pathological depth
}

// Compute bounding box of all vertex/edge geometry using absolute positions.
function computeBounds(cells) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (x, y) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const cell of Object.values(cells)) {
    if (!cell.geometry) continue;
    if (!isReachableFromRoot(cell, cells)) continue; // not painted => not in bounds
    const g = cell.geometry;
    if (cell.vertex && g.width > 0 && g.height > 0) {
      const { ax, ay } = absolutePos(cell, cells);
      // Rotation grows the on-screen AABB (mxGraphView.getBoundingBox);
      // ignoring it anchored content too high/left and pushed rotated
      // shapes' real ink off the printed page.
      const rotation = cell.style ? parseFloat(cell.style.rotation) || 0 : 0;
      if (rotation !== 0) {
        const cx = ax + g.width / 2;
        const cy = ay + g.height / 2;
        const rad = rotation * (Math.PI / 180);
        const cos = Math.cos(rad), sin = Math.sin(rad);
        for (const [px, py] of [[ax, ay], [ax + g.width, ay],
                                [ax + g.width, ay + g.height], [ax, ay + g.height]]) {
          const dx = px - cx, dy = py - cy;
          include(dx * cos - dy * sin + cx, dy * cos + dx * sin + cy);
        }
      } else {
        include(ax, ay);
        include(ax + g.width, ay + g.height);
      }
      // verticalLabelPosition / labelPosition place the label OUTSIDE the
      // shape (drawio getGraphBounds includes the label's bounding box).
      // Without this a top-positioned label above a shape at the content
      // edge printed off-page.
      const st = cell.style || {};
      if (cell.value != null && String(cell.value) !== '') {
        const fs = parseFloat(st.fontSize) || 12;
        const text = String(cell.value).replace(/<[^>]+>/g, '');
        const lines = text.split(/\n|<br\s*\/?>/i).length;
        const lblH = Math.max(fs * 1.4, lines * fs * 1.25);
        const lblW = Math.min(Math.max(g.width, text.length * fs * 0.65), text.length * fs * 0.7 + 8);
        const vlp = st.verticalLabelPosition;
        const lp = st.labelPosition;
        if (vlp === 'top') include(ax, ay - lblH);
        else if (vlp === 'bottom') include(ax, ay + g.height + lblH);
        if (lp === 'left') include(ax - lblW, ay);
        else if (lp === 'right') include(ax + g.width + lblW, ay);
      }
    } else if (cell.edge) {
      // The real routed polyline (incl. literal dangling endpoints and
      // router-inserted bends) defines the edge's extent -- raw waypoints
      // alone missed dangling edges entirely (wrong fallback paper size).
      // Arrow-class edge shapes (shape=arrow/link/wedge...) paint a band of
      // width/startWidth/endWidth AROUND the route; without that halo the
      // band's outer ink fell outside the computed bounds and the page.
      const st = cell.style || {};
      // mxConnector.augmentBoundingBox: marker ink extends (size+1) beyond
      // the endpoint/route; without this growth an auto-fit page (no
      // pageWidth/pageHeight) cropped arrowhead wings at the sheet edge.
      const rst = cell.resolvedStyle || st;
      let markerHalo = 0;
      if (rst.startArrow != null && String(rst.startArrow) !== 'none') {
        markerHalo = (parseFloat(rst.startSize) || 6) + 1;
      }
      if (rst.endArrow != null && String(rst.endArrow) !== 'none') {
        markerHalo = Math.max(markerHalo, (parseFloat(rst.endSize) || 6) + 1);
      }
      // Additive like mx: stroke/band halo first, then the marker growth.
      const halo = Math.max(
        parseFloat(st.width) || 0,
        parseFloat(st.startWidth) || 0,
        parseFloat(st.endWidth) || 0,
        parseFloat(st.strokeWidth) || 1) / 2 + markerHalo;
      try {
        const pts = edgePoints(cell, cells) || [];
        for (const pt of pts) {
          include(pt.x - halo, pt.y - halo);
          include(pt.x + halo, pt.y + halo);
        }
        // The edge's own LABEL extends the graph bounds too (drawio
        // getGraphBounds includes label bboxes): an auto-fit page cropped
        // dragged/long edge labels that stuck out past the route.
        if (pts.length >= 2 && cell.value != null && String(cell.value) !== '') {
          const fs2 = parseFloat(st.fontSize) || 12;
          const text2 = String(cell.value).replace(/<[^>]+>/g, '');
          const lw2 = Math.max(24, text2.length * fs2 * 0.65);
          const lh2 = Math.max(fs2 * 1.4, text2.split('\n').length * fs2 * 1.25);
          let mid = pts[Math.floor(pts.length / 2)];
          if (pts.length % 2 === 0) {
            const a = pts[pts.length / 2 - 1], b = pts[pts.length / 2];
            mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          }
          const offp = cell.geometry && cell.geometry.offset ? cell.geometry.offset : { x: 0, y: 0 };
          include(mid.x + offp.x - lw2 / 2, mid.y + offp.y - lh2 / 2);
          include(mid.x + offp.x + lw2 / 2, mid.y + offp.y + lh2 / 2);
        }
      } catch {
        const { ax, ay } = absolutePos(cell, cells);
        for (const pt of (g.points || [])) include(pt.x + ax, pt.y + ay);
      }
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 100, height: 100 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}


// Port of mxGraphView.getPoint for relative edge geometry: walk the
// routed polyline to fraction (gx/2 + 0.5) of its arc length, then offset
// perpendicular by gy and add the absolute geometry offset.
function edgeLabelPosition(points, g) {
  let total = 0;
  const segs = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    segs.push(len);
    total += len;
  }
  const gx = (parseFloat(g.x) || 0) / 2;
  const gy = parseFloat(g.y) || 0;
  const ox = g.offset ? g.offset.x : 0;
  const oy = g.offset ? g.offset.y : 0;
  if (total <= 0) {
    const mid = points[Math.floor(points.length / 2)];
    return { x: mid.x + ox, y: mid.y + oy };
  }
  const dist = Math.round((gx + 0.5) * total);
  let segment = segs[0];
  let length = 0;
  let index = 1;
  while (dist >= Math.round(length + segment) && index < points.length - 1) {
    length += segment;
    segment = segs[index++];
  }
  const factor = segment === 0 ? 0 : (dist - length) / segment;
  const p0 = points[index - 1];
  const pe = points[index];
  const dx = pe.x - p0.x;
  const dy = pe.y - p0.y;
  const nx = segment === 0 ? 0 : dy / segment;
  const ny = segment === 0 ? 0 : dx / segment;
  return {
    x: p0.x + dx * factor + nx * gy + ox,
    y: p0.y + dy * factor - (ny * gy - oy)
  };
}

// Build a source cell state compatible with exporter's buildResult().
// Scale is 1 (model units = view pixel units in headless mode).
// Uses absolute positions so container children appear at the correct location.
function cellToState(cell, cells) {
  if (!cell.geometry) return null;
  const g = cell.geometry;
  if (cell.vertex) {
    const { ax, ay } = absolutePos(cell, cells);
    return { x: ax, y: ay, width: g.width, height: g.height };
  }
  if (cell.edge) {
    // Provide absolute waypoints for the headless fallback path in emitEdge.
    // Include source/target terminal points when draw.io stores them as cell
    // references instead of literal mxPoint entries.
    const points = edgePoints(cell, cells);
    // null = the edge has no visible state (hidden terminal) and must not
    // print; < 2 points = nothing routable either way.
    if (!points || points.length < 2) return null;
    const state = {
      x: 0, y: 0, width: 0, height: 0,
      absolutePoints: points
    };
    // mxGraphView.getPoint: the edge's own label position. relative
    // geometry.x in [-1,1] is the arc-length position, geometry.y the
    // PERPENDICULAR offset, geometry.offset an absolute shift. Dropping
    // these printed every dragged edge label at the polyline midpoint
    // (plus its labelBackground box) -- silently in the wrong place.
    if (g.relative && (g.x || g.y || g.offset)) {
      state.absoluteOffset = edgeLabelPosition(points, g);
    }
    return state;
  }
  return null;
}

// --- public API ---

// Parse a single mxGraphModel XML string into { cells, modelAttrs, paper }.
function parseModel(modelXml) {
  const modelOpen = /<mxGraphModel([^>]*)>/i.exec(modelXml);
  const modelAttrs = modelOpen ? parseAttrs(modelOpen[1]) : {};

  // View > Page Scale: the on-canvas page covers pageFormat * pageScale
  // model units (drawio computes page breaks as pageFormat*pageScale).
  // Ignoring it printed files authored at != 100% page scale mis-fit.
  const pageScale = parseFloat(modelAttrs.pageScale || 1) || 1;
  const pageW = (parseFloat(modelAttrs.pageWidth  || 0) || 0) * pageScale;
  const pageH = (parseFloat(modelAttrs.pageHeight || 0) || 0) * pageScale;

  const cells = parseCells(modelXml);

  const bounds = computeBounds(cells);
  // `explicit` records that the AUTHOR fixed the page size (File > Page
  // Setup): the bake must then keep every cell's on-page position (the
  // page origin is model 0,0), not normalise content to the paper corner.
  // Without page dims the page is auto-fit to content and bounds-anchoring
  // is the faithful choice.
  const paper = (pageW > 0 && pageH > 0)
    ? { wPx: pageW, hPx: pageH, explicit: true }
    : { wPx: Math.max(1, bounds.width), hPx: Math.max(1, bounds.height) };
  // Page background colour (File > Page Setup) prints behind all content.
  if (modelAttrs.background && modelAttrs.background !== 'none') {
    paper.background = modelAttrs.background;
  }

  return { cells, modelAttrs, paper };
}

// Parse a .drawio XML string.
// Returns { cells, modelAttrs, paper } for the FIRST page (for compatibility
// with single-page callers), plus `pages` for multi-page access.
//
// pages: Array of { name, id, cells, modelAttrs, paper } — one entry per
// diagram/page in the file.  The API must use `pages` to avoid silently
// printing only page 1 in multi-page files (spec §3.2).
export function parseDrawio(xml) {
  const models = extractAllModels(xml);
  if (models.length === 0) throw new Error('no mxGraphModel found in drawio file');

  const pages = models.map((m) => {
    const parsed = parseModel(m.xml);
    return { name: m.name, diagramId: m.id, ...parsed };
  });

  // First-page compat fields
  const first = pages[0];
  return { cells: first.cells, modelAttrs: first.modelAttrs, paper: first.paper, pages };
}

// Build the fake graph object expected by exporter.buildResult().
// scale = 1 (model unit == view pixel in headless mode).
// Resolve %placeholder% tokens in a label the way drawio's
// Graph.replacePlaceholders / getAttributeForCell do: only when the cell has
// placeholders="1", substitute each %name% with the cell's (or an ancestor's)
// custom attribute value; unresolved tokens stay literal (matching the editor).
// Global page placeholders resolve from the optional pageCtx the bake supplies.
// Editor.toUnit: a pixel value (96 px/inch) -> the requested unit.
function npToUnit(px, unit) {
  if (unit === 'mm') return Math.round(px / 96 * 25.4 * 100) / 100;
  if (unit === 'in') return Math.round(px / 96 * 100) / 100;
  if (unit === 'm') return Math.round(px / 96 * 0.0254 * 1000) / 1000;
  return px;
}

// Faithful port of Graph.formatDate (Steven Levithan's dateFormat), including
// the NAMED mask table and 'quoted'/"quoted" literals. drawio's %date{mask}%
// passes `mask` here: a named mask (shortDate, isoDate, isoDateTime, ...)
// resolves via NP_DATE_MASKS, an explicit mask (yyyy-mm-dd) is used verbatim,
// and quoted runs ('T') are emitted literally. m/mm = month, M/MM = minutes
// (Levithan convention). A partial port previously left named masks unresolved
// ("shortDate" -> garbage "461ortDate") and kept the 'T' quotes -- silent
// divergence on a medical date label; this mirrors Graph.js exactly.
const NP_DATE_MASKS = {
  'default':      'ddd mmm dd yyyy HH:MM:ss',
  shortDate:      'm/d/yy',
  mediumDate:     'mmm d, yyyy',
  longDate:       'mmmm d, yyyy',
  fullDate:       'dddd, mmmm d, yyyy',
  shortTime:      'h:MM TT',
  mediumTime:     'h:MM:ss TT',
  longTime:       'h:MM:ss TT Z',
  isoDate:        'yyyy-mm-dd',
  isoTime:        'HH:MM:ss',
  isoDateTime:    "yyyy-mm-dd'T'HH:MM:ss",
  isoUtcDateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss'Z'"
};
const NP_DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat',
  'Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const NP_MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec',
  'January','February','March','April','May','June','July','August','September','October','November','December'];
function npFormatDate(date, mask, utc) {
  const pad = (val, len) => { val = String(val); len = len || 2; while (val.length < len) val = '0' + val; return val; };
  const timezone = /\b(?:[PMCEA][SDP]T|(?:Pacific|Mountain|Central|Eastern|Atlantic) (?:Standard|Daylight|Prevailing) Time|(?:GMT|UTC)(?:[-+]\d{4})?)\b/g;
  const timezoneClip = /[^-+\dA-Z]/g;
  mask = String(NP_DATE_MASKS[mask] || mask || NP_DATE_MASKS['default']);
  if (mask.slice(0, 4) === 'UTC:') { mask = mask.slice(4); utc = true; }
  const g = utc ? 'getUTC' : 'get';
  const d = date[g + 'Date'](), D = date[g + 'Day'](), m = date[g + 'Month'](),
        y = date[g + 'FullYear'](), H = date[g + 'Hours'](), M = date[g + 'Minutes'](),
        s = date[g + 'Seconds'](), L = date[g + 'Milliseconds']();
  const o = utc ? 0 : date.getTimezoneOffset();
  const flags = {
    d: d, dd: pad(d), ddd: NP_DAY_NAMES[D], dddd: NP_DAY_NAMES[D + 7],
    m: m + 1, mm: pad(m + 1), mmm: NP_MONTH_NAMES[m], mmmm: NP_MONTH_NAMES[m + 12],
    yy: String(y).slice(2), yyyy: y,
    h: H % 12 || 12, hh: pad(H % 12 || 12), H: H, HH: pad(H),
    M: M, MM: pad(M), s: s, ss: pad(s),
    l: pad(L, 3), L: pad(L > 99 ? Math.round(L / 10) : L),
    t: H < 12 ? 'a' : 'p', tt: H < 12 ? 'am' : 'pm',
    T: H < 12 ? 'A' : 'P', TT: H < 12 ? 'AM' : 'PM',
    Z: utc ? 'UTC' : (String(date).match(timezone) || ['']).pop().replace(timezoneClip, ''),
    o: (o > 0 ? '-' : '+') + pad(Math.floor(Math.abs(o) / 60) * 100 + Math.abs(o) % 60, 4),
    S: ['th', 'st', 'nd', 'rd'][d % 10 > 3 ? 0 : (d % 100 - d % 10 !== 10) * d % 10]
  };
  const token = /d{1,4}|m{1,4}|yy(?:yy)?|([HhMsTt])\1?|[LloSZ]|"[^"]*"|'[^']*'/g;
  return mask.replace(token, ($0) => ($0 in flags ? flags[$0] : $0.slice(1, $0.length - 1)));
}

// Faithful port of Graph.replacePlaceholders / getGlobalVariable: resolve %name%
// labels when placeholders="1". Resolution ORDER mirrors drawio exactly:
// id -> width[_unit] -> height[_unit] -> cell/ancestor attribute -> page
// (with +/-N arithmetic) / date|time|timestamp|date{fmt} globals -> else
// literal. %label%/%tooltip% are left literal (drawio skips them). %length%
// needs the routed edge length (unavailable at label-resolution time) and is a
// documented residual: faithful for vertex labels / unrouted edges (literal),
// may diverge only for a routed edge label that prints its own length (rare,
// never on medical labels).
function npGlobalVar(name, pageCtx) {
  if (name === 'date') return new Date().toLocaleDateString();
  if (name === 'time') return new Date().toLocaleTimeString();
  if (name === 'timestamp') return new Date().toLocaleString();
  if (name.substring(0, 5) === 'date{') return npFormatDate(new Date(), name.substring(5, name.length - 1));
  if (pageCtx) {
    if ((name === 'page' || name === 'pagenumber') && pageCtx.pageNumber != null) return String(pageCtx.pageNumber);
    if (name === 'pagecount' && pageCtx.pageCount != null) return String(pageCtx.pageCount);
  }
  return null;
}
// Resolve a single placeholder NAME (without the % delimiters) to its value, or
// null if unresolved. Mirrors Graph.replacePlaceholders' resolution order.
function npResolveName(name, cell, cells, pageCtx, units) {
  let tmp = null;
  if (name === 'id') {
    tmp = cell.id;
  } else if (name.substring(0, 5) === 'width' && cell.vertex && cell.geometry) {
    tmp = cell.geometry.width;
    if (name.length > 5 && units[name.substring(6)]) tmp = npToUnit(tmp, units[name.substring(6)]);
  } else if (name.substring(0, 6) === 'height' && cell.vertex && cell.geometry) {
    tmp = cell.geometry.height;
    if (name.length > 6 && units[name.substring(7)]) tmp = npToUnit(tmp, units[name.substring(7)]);
  } else if (name.substring(0, 6) === 'length') {
    return null; // routed edge length unavailable at resolution time (residual)
  } else if (name.indexOf('{') < 0) {
    let c = cell, hops = 0;
    while (tmp == null && c && hops++ < 1000) {
      if (c.meta && Object.prototype.hasOwnProperty.call(c.meta, name)) {
        tmp = (c.meta[name] != null) ? c.meta[name] : '';
      }
      const pid = c.parent;
      c = (pid != null) ? cells[pid] : null;
    }
  }
  if (tmp == null) {
    const am = name.match(/^(pagecount|pagenumber)\s*([+-])\s*(\d+)$/);
    if (am) {
      const base = npGlobalVar(am[1], pageCtx);
      if (base != null) {
        const n = parseInt(am[3], 10);
        tmp = String((parseInt(base, 10) || 0) + (am[2] === '+' ? n : -n));
      }
    } else {
      tmp = npGlobalVar(name, pageCtx);
    }
  }
  return tmp != null ? String(tmp) : null;
}

function resolvePlaceholders(value, cell, cells, pageCtx) {
  if (typeof value !== 'string' || value.indexOf('%') < 0) return value;
  const enabled = (cell.meta && String(cell.meta.placeholders) === '1') ||
    (cell.resolvedStyle && String(cell.resolvedStyle.placeholders) === '1') ||
    (cell.style && String(cell.style.placeholders) === '1');
  if (!enabled) return value;
  const units = { mm: 'mm', in: 'in', m: 'm' }; // drawio's set; unknown unit => raw px
  // EXACT mirror of Graph.placeholderPattern: the placeholder name excludes
  // % { } " ' = ; (so a CSS percentage like font-size:80% in an HTML label does
  // NOT swallow the real %TOKEN%), with date{...} as a special alternative. A
  // too-permissive [^%]* regex bound the wrong span and left variable-data
  // tokens unresolved -- a silent, patient-safety-grade divergence. The exec
  // loop also replicates drawio's %%-escape (a placeholder immediately preceded
  // by % is emitted literally with one % stripped).
  const pattern = /%(date\{.*\}|[^%{}"'=;]+)%/g;
  let result = '';
  let last = 0;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    const val = match[0];
    if (val.length > 2 && val !== '%label%' && val !== '%tooltip%') {
      let tmp;
      if (match.index > last && value.charAt(match.index - 1) === '%') {
        tmp = val.substring(1); // escaped %%name% -> literal %name%
      } else {
        tmp = npResolveName(val.substring(1, val.length - 1), cell, cells, pageCtx, units);
      }
      result += value.substring(last, match.index) + (tmp != null ? tmp : val);
      last = match.index + val.length;
    }
  }
  result += value.substring(last);
  return result;
}

export function buildGraph(cells, paper, pageCtx) {
  const states = {};
  for (const cell of Object.values(cells)) {
    const s = cellToState(cell, cells);
    if (s) states[cell.id] = s;
  }

  const allBounds = computeBounds(cells);

  // Expose the real mxGraphModel tree API so the exporter's TRUE z-order
  // walk engages. The Object.keys fallback iterates integer-LIKE ids
  // numerically ascending regardless of XML document order (JS object
  // semantics), so "Bring to Front"/"Send to Back" arrangements with
  // numeric ids printed in INVERTED stacking order.
  const rootCell = cells['0'] || Object.values(cells).find((c) => c && c.parent == null) || null;
  const model = {
    cells,
    isVertex: (c) => !!(c && c.vertex),
    isEdge:   (c) => !!(c && c.edge),
    getStyle: (c) => (c && c.rawStyle) || '',
    getRoot:  () => rootCell,
    getChildCount: (c) => (c && c.children ? c.children.length : 0),
    getChildAt: (c, i) => (c && c.children ? c.children[i] : null)
  };

  return {
    getModel:       () => model,
    view: {
      scale:    1,
      translate: null,
      getState: (cell) => (cell && states[cell.id]) || null
    },
    getGraphBounds: () => ({
      x:      allBounds.x,
      y:      allBounds.y,
      width:  allBounds.width,
      height: allBounds.height
    }),
    getCellStyle: (cell) => (cell && cell.resolvedStyle) ? cloneStyle(cell.resolvedStyle) : {},
    // mxGraph.getLabel returns '' when STYLE_NOLABEL is set — hidden labels
    // (noLabel=1) previously PRINTED, a silent divergence.
    getLabel:     (cell) => {
      if (!cell || cell.value == null) return '';
      const st = cell.resolvedStyle || cell.style;
      if (st && st.noLabel != null && String(st.noLabel) === '1') return '';
      return resolvePlaceholders(String(cell.value), cell, cells, pageCtx);
    },
    isHtmlLabel:  (cell) => !!(cell && cell.style && String(cell.style.html) === '1'),
    nativePrintOptions: null
  };
}
