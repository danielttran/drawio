// Parse .drawio (mxGraph XML) files into a fake graph model compatible with
// the exporter's buildResult() function.
//
// Supports both uncompressed and deflate-compressed diagram content.
// Pure Node.js (no jsdom, no browser); uses node:zlib for decompression.

import { inflateRawSync } from 'node:zlib';

// --- attribute parsing ---

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
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

// Parse draw.io style string → object.
// "ellipse;fillColor=#ff0000;strokeColor=#0000ff;" → { shape:'ellipse', fillColor:'#ff0000', ... }
// "rounded=1;whiteSpace=wrap;" → { rounded:'1', whiteSpace:'wrap' }
// data: URI values (e.g. image=data:image/png;base64,...) are kept atomic.
function parseStyle(s) {
  if (!s) return {};
  const style = {};
  // Split on ';' but preserve data: URI values intact (they contain ';base64,').
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

  for (const part of parts) {
    const tok = part.trim();
    if (!tok) continue;
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
  while ((m = diagRe.exec(xml)) !== null) {
    const diagAttrs = parseAttrs(m[1]);
    const decoded = decodeDiagramBlock(m[2]);
    if (decoded) results.push({ name: diagAttrs.name || '', id: diagAttrs.id || '', xml: decoded });
  }
  if (results.length > 0) return results;

  // Single bare mxGraphModel (no mxfile wrapper)
  if (/<mxGraphModel/i.test(xml)) return [{ name: '', id: '', xml }];
  return [];
}

// Parse all mxCell elements from within <root>...</root>.
function parseCells(xml) {
  const cells = {};

  // Match each mxCell — self-closing or paired.
  // Note: the value attribute may contain HTML entities but not raw '<>'
  // (draw.io always entity-encodes attributes), so this regex is safe.
  const cellRe = /<mxCell([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/gi;
  let m;
  while ((m = cellRe.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    const id = attrs.id;
    if (id == null) continue;

    const cell = {
      id,
      vertex:   attrs.vertex === '1',
      edge:     attrs.edge   === '1',
      value:    attrs.value  || '',
      parent:   attrs.parent || null,
      source:   attrs.source || null,
      target:   attrs.target || null,
      style:    parseStyle(attrs.style || ''),
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
  }

  // Build parent→children tree (for collectCellsInZOrder)
  for (const cell of Object.values(cells)) {
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
function absolutePos(cell, cells) {
  if (!cell.geometry) return { ax: 0, ay: 0 };
  const g = cell.geometry;
  const parentId = cell.parent;

  if (g.relative && cell.vertex && parentId && parentId !== '0' && parentId !== '1') {
    const parent = cells[parentId];
    if (parent && parent.geometry) {
      const ox = g.offset ? g.offset.x : 0;
      const oy = g.offset ? g.offset.y : 0;
      const relX = (parent.geometry.width  || 0) * (g.x || 0) + ox;
      const relY = (parent.geometry.height || 0) * (g.y || 0) + oy;
      const { ax: pax, ay: pay } = absolutePos(parent, cells);
      return { ax: pax + relX, ay: pay + relY };
    }
  }

  let ax = g.x || 0;
  let ay = g.y || 0;
  let pid = parentId;
  while (pid && pid !== '0' && pid !== '1') {
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

function terminalPoint(edge, cells, terminalId, isSource, toward) {
  const terminal = terminalId ? cells[terminalId] : null;
  const box = absoluteBox(terminal, cells);
  if (!box) return null;
  const style = edge.style || {};
  const pxKey = isSource ? 'exitX' : 'entryX';
  const pyKey = isSource ? 'exitY' : 'entryY';
  if (style[pxKey] != null || style[pyKey] != null) {
    const px = parseFloat(style[pxKey] ?? 0.5);
    const py = parseFloat(style[pyKey] ?? 0.5);
    const dx = parseFloat(style[isSource ? 'exitDx' : 'entryDx'] || 0) || 0;
    const dy = parseFloat(style[isSource ? 'exitDy' : 'entryDy'] || 0) || 0;
    return { x: box.x + box.width * px + dx, y: box.y + box.height * py + dy };
  }

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (!toward) return { x: cx, y: cy };

  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: dx >= 0 ? box.x + box.width : box.x, y: cy };
  }
  return { x: cx, y: dy >= 0 ? box.y + box.height : box.y };
}

function edgePoints(cell, cells) {
  const g = cell.geometry;
  const { ax, ay } = absolutePos(cell, cells);
  const waypoints = (g.points || []).map((pt) => ({ x: pt.x + ax, y: pt.y + ay }));
  const hasLiteralTerminals = !!(g.sourcePoint || g.targetPoint);
  const sourceBox = absoluteBox(cells[cell.source], cells);
  const targetBox = absoluteBox(cells[cell.target], cells);
  const sourceCenter = sourceBox
    ? { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }
    : null;
  const targetCenter = targetBox
    ? { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 }
    : null;

  const out = waypoints.slice();
  if (!cell.source && g.sourcePoint) out.unshift({ x: g.sourcePoint.x + ax, y: g.sourcePoint.y + ay });
  if (!cell.target && g.targetPoint) out.push({ x: g.targetPoint.x + ax, y: g.targetPoint.y + ay });
  const firstToward = out[0] || targetCenter;
  const lastToward = out[out.length - 1] || sourceCenter;
  const src = terminalPoint(cell, cells, cell.source, true, firstToward);
  const tgt = terminalPoint(cell, cells, cell.target, false, lastToward);
  if (waypoints.length === 0 && !hasLiteralTerminals && src && tgt &&
      (cell.style?.edgeStyle === 'elbowEdgeStyle' ||
       cell.style?.edgeStyle === 'orthogonalEdgeStyle') &&
      cell.style?.noEdgeStyle !== '1') {
    if (cell.style?.elbow === 'horizontal') {
      const midX = (src.x + tgt.x) / 2;
      return [src, { x: midX, y: src.y }, { x: midX, y: tgt.y }, tgt];
    }
    const midY = (src.y + tgt.y) / 2;
    return [src, { x: src.x, y: midY }, { x: tgt.x, y: midY }, tgt];
  }
  if (src) out.unshift(src);
  if (tgt) out.push(tgt);

  if (out.length === 0 && sourceCenter && targetCenter) {
    const start = terminalPoint(cell, cells, cell.source, true, targetCenter) || sourceCenter;
    const end = terminalPoint(cell, cells, cell.target, false, sourceCenter) || targetCenter;
    if ((cell.style?.edgeStyle === 'elbowEdgeStyle' ||
         cell.style?.edgeStyle === 'orthogonalEdgeStyle') &&
        cell.style?.noEdgeStyle !== '1') {
      const midY = (start.y + end.y) / 2;
      return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
    }
    return [start, end];
  }

  return out;
}

// Compute bounding box of all vertex/edge geometry using absolute positions.
function computeBounds(cells) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cell of Object.values(cells)) {
    if (!cell.geometry) continue;
    const g = cell.geometry;
    if (cell.vertex && g.width > 0 && g.height > 0) {
      const { ax, ay } = absolutePos(cell, cells);
      minX = Math.min(minX, ax);
      minY = Math.min(minY, ay);
      maxX = Math.max(maxX, ax + g.width);
      maxY = Math.max(maxY, ay + g.height);
    } else if (cell.edge && g.points) {
      const { ax, ay } = absolutePos(cell, cells);
      for (const pt of g.points) {
        minX = Math.min(minX, pt.x + ax); minY = Math.min(minY, pt.y + ay);
        maxX = Math.max(maxX, pt.x + ax); maxY = Math.max(maxY, pt.y + ay);
      }
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 100, height: 100 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
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
    if (points.length < 2) return null;
    return {
      x: 0, y: 0, width: 0, height: 0,
      absolutePoints: points
    };
  }
  return null;
}

// --- public API ---

// Parse a single mxGraphModel XML string into { cells, modelAttrs, paper }.
function parseModel(modelXml) {
  const modelOpen = /<mxGraphModel([^>]*)>/i.exec(modelXml);
  const modelAttrs = modelOpen ? parseAttrs(modelOpen[1]) : {};

  const pageW = parseFloat(modelAttrs.pageWidth  || 0) || 0;
  const pageH = parseFloat(modelAttrs.pageHeight || 0) || 0;

  const cells = parseCells(modelXml);

  const bounds = computeBounds(cells);
  const paper = (pageW > 0 && pageH > 0)
    ? { wPx: pageW, hPx: pageH }
    : { wPx: Math.max(1, bounds.width), hPx: Math.max(1, bounds.height) };

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
export function buildGraph(cells, paper) {
  const states = {};
  for (const cell of Object.values(cells)) {
    const s = cellToState(cell, cells);
    if (s) states[cell.id] = s;
  }

  const allBounds = computeBounds(cells);

  // collectCellsInZOrder fallback: use Object.values order.
  const model = {
    cells,
    isVertex: (c) => !!(c && c.vertex),
    isEdge:   (c) => !!(c && c.edge)
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
    getCellStyle: (cell) => (cell && cell.style) || {},
    getLabel:     (cell) => (cell && cell.value != null ? String(cell.value) : ''),
    isHtmlLabel:  (cell) => !!(cell && cell.style && cell.style.html === '1'),
    nativePrintOptions: null
  };
}
