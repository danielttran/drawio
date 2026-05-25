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
      if (k) style[k] = v;
    }
  }
  return style;
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
      // Edge waypoints inside mxGeometry
      const ptRe = /<mxPoint\s([^>]*?)\/>/gi;
      const points = [];
      let pt;
      while ((pt = ptRe.exec(body)) !== null) {
        const pa = parseAttrs(pt[1]);
        if (pa.as !== 'points') { // skip sourcePoint/targetPoint
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

// Compute bounding box of all vertex/edge geometry.
function computeBounds(cells) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cell of Object.values(cells)) {
    if (!cell.geometry) continue;
    const g = cell.geometry;
    if (cell.vertex && g.width > 0 && g.height > 0) {
      minX = Math.min(minX, g.x);
      minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + g.width);
      maxY = Math.max(maxY, g.y + g.height);
    } else if (cell.edge && g.points) {
      for (const pt of g.points) {
        minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
      }
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 100, height: 100 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Build a source cell state compatible with exporter's buildResult().
// Scale is 1 (model units = view pixel units in headless mode).
function cellToState(cell) {
  if (!cell.geometry) return null;
  const g = cell.geometry;
  if (cell.vertex) {
    return { x: g.x, y: g.y, width: g.width, height: g.height };
  }
  if (cell.edge && g.points && g.points.length >= 2) {
    // Provide absolute waypoints for the headless fallback path in emitEdge.
    return {
      x: 0, y: 0, width: 0, height: 0,
      absolutePoints: g.points.map((pt) => ({ x: pt.x, y: pt.y }))
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
    const s = cellToState(cell);
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
