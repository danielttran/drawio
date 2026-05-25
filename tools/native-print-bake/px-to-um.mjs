// Convert a px-unit contract to a um-unit contract (schema 1.1).
//
// Scale factor: 25400 um/inch ÷ 96 px/inch = 25400/96 um/px.
// All positional dimensions (box, tile, page, path coordinates, font size,
// stroke width) are multiplied by this factor. Arc rotation angles and
// large-arc/sweep flags inside SVG path `d` strings are NOT scaled.

const SCALE = 25400 / 96;

function scaleN(n) {
  return Math.round(n * SCALE * 1e6) / 1e6;
}

// Scale an SVG path `d` string.  All coordinate/radius tokens are scaled;
// the three non-coordinate slots in arc (A) args — x-rotation (pos 2),
// large-arc-flag (pos 3), sweep-flag (pos 4) — are passed through unchanged.
function scaleD(d) {
  const ARC_SKIP = new Set([2, 3, 4]);
  const parts = [];
  let curCmd = null;
  let argIdx = 0;
  const re = /([MLHVCSQTAZmlhvcsqtaz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) {
      curCmd = m[1].toUpperCase();
      argIdx = 0;
      parts.push(m[1]);
    } else {
      const n = parseFloat(m[2]);
      if (curCmd === 'A' && ARC_SKIP.has(argIdx % 7)) {
        parts.push(m[2]);
      } else {
        parts.push(String(Math.round(n * SCALE * 1e6) / 1e6));
      }
      argIdx++;
    }
  }
  return parts.join(' ');
}

function scaleBox(box) {
  if (!box) return box;
  return { x: scaleN(box.x), y: scaleN(box.y), w: scaleN(box.w), h: scaleN(box.h) };
}

function scalePaintNode(node) {
  if (!node) return node;
  const n = Object.assign({}, node);
  switch (n.kind) {
    case 'path':
      if (typeof n.d === 'string') n.d = scaleD(n.d);
      if (n.stroke && typeof n.stroke.width === 'number') {
        n.stroke = Object.assign({}, n.stroke, { width: scaleN(n.stroke.width) });
      }
      break;
    case 'text':
      n.box = scaleBox(n.box);
      if (n.font && typeof n.font.sizePx === 'number') {
        n.font = Object.assign({}, n.font, { sizePx: scaleN(n.font.sizePx) });
      }
      if (n.content && n.content.type === 'rich' && Array.isArray(n.content.paragraphs)) {
        n.content = Object.assign({}, n.content, {
          paragraphs: n.content.paragraphs.map((p) => Object.assign({}, p, {
            runs: (p.runs || []).map((r) =>
              typeof r.sizePx === 'number'
                ? Object.assign({}, r, { sizePx: scaleN(r.sizePx) })
                : r)
          }))
        });
      }
      break;
    case 'image':
    case 'svg':
    case 'barcode':
      n.box = scaleBox(n.box);
      break;
  }
  return n;
}

function scaleTile(t) {
  return {
    origin: { x: scaleN(t.origin.x), y: scaleN(t.origin.y) },
    size:   { w: scaleN(t.size.w),   h: scaleN(t.size.h) }
  };
}

export function pxContractToUm(contract) {
  const doc = contract.document;
  return {
    schema: { major: contract.schema.major, minor: 1 },
    document: {
      units: 'um',
      pages: doc.pages.map((page) => Object.assign({}, page, {
        size:  { w: scaleN(page.size.w), h: scaleN(page.size.h) },
        tiles: (page.tiles || []).map(scaleTile),
        paint: (page.paint || []).map(scalePaintNode)
      }))
    }
  };
}

export { SCALE };
