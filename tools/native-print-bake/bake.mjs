#!/usr/bin/env node
// Headless bake: .drawio (mxGraph XML) → frozen um-unit contract JSON.
//
// Reuses the existing exporter (src/main/webapp/plugins/nativeprint/exporter.js)
// with the draw.io graph model built headlessly from the parsed XML.
// Outputs schema 1.1 ("um" units, minor=1) as required by §4 of the spec.
//
// Multi-page: all diagram pages are baked and included as contract pages.
// The spec (§3.2) requires explicit page scope — this bake produces ALL pages
// by default.  Per-page selection can be added via options.pages (array of
// 0-based page indices).
//
// D5 gate: pass { unattended: true } to fail loudly if any degradation notice
// is produced (per spec §3.2 "Failure policy (D5)").
//
// CLI:  node bake.mjs <input.drawio> [output.contract.json]
// API:  import { bake } from './bake.mjs';
//       const { contract, notices } = bake(xmlString);
//       const { contract } = bake(xmlString, { unattended: true }); // throws on notices

import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { parseDrawio, buildGraph } from './drawio-parser.mjs';
import { pxContractToUm } from './px-to-um.mjs';
import { createSvgEnv } from './svg-shim/index.mjs';
import { loadStencils } from './stencil-loader.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

// The webapp root for resolving relative image URLs (e.g. img/clipart/Gear_128x128.png).
const WEBAPP_DIR = resolve(__dir, '../../src/main/webapp');
const WEBAPP_REAL_DIR = realpathSync(WEBAPP_DIR);

// Fetch implementation for relative/root-relative URLs that resolves against
// WEBAPP_DIR. Used as the default fetchFn so local images print WYSIWYG.
// Rejects URL schemes, protocol-relative URLs, and filesystem escapes: this
// default resolver is only for checked-in bundled assets beneath WEBAPP_DIR.
export function localFileFetch(url) {
  return Promise.resolve().then(function () {
    if (typeof url !== 'string' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
      return { ok: false };
    }
    var rel = url.replace(/^\/+/, '');
    var filePath = resolve(WEBAPP_DIR, rel);
    var fromWebapp = relative(WEBAPP_DIR, filePath);
    if (fromWebapp === '..' || fromWebapp.indexOf('..' + sep) === 0 ||
        isAbsolute(fromWebapp)) {
      return { ok: false };
    }
    var bytes;
    try {
      filePath = realpathSync(filePath);
      fromWebapp = relative(WEBAPP_REAL_DIR, filePath);
      if (fromWebapp === '..' || fromWebapp.indexOf('..' + sep) === 0 ||
          isAbsolute(fromWebapp)) {
        return { ok: false };
      }
      bytes = readFileSync(filePath);
    } catch (_) { return { ok: false }; }
    var ext = filePath.split('.').pop().toLowerCase();
    var mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };
    var mime = mimeMap[ext] || 'application/octet-stream';
    return {
      ok: true,
      blob: function () {
        return Promise.resolve({
          type: mime,
          arrayBuffer: function () {
            return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          }
        });
      }
    };
  });
}

// Inject the SVG serialization shim into globalThis BEFORE requiring the exporter.
// The exporter IIFE (line 2697) captures `root = globalThis` at require-time, so
// document + XMLSerializer must be present or the exporter's SVG serialization and
// DOM-creation paths will silently take wrong branches (§0 browser-free requirement).
const _shimEnv = createSvgEnv();
if (!globalThis.document) globalThis.document = _shimEnv.document;
if (!globalThis.XMLSerializer) globalThis.XMLSerializer = _shimEnv.XMLSerializer;
if (!globalThis.getComputedStyle) globalThis.getComputedStyle = _shimEnv.getComputedStyle;

// Load the exporter as a CommonJS module (it self-registers on module.exports).
const require = createRequire(import.meta.url);
const exporterPath = resolve(__dir, '../../src/main/webapp/plugins/nativeprint/exporter.js');
const exporter = require(exporterPath);

// Load all stencil XML files and register them with the exporter.
// Top-level await is valid in ES module context (Node.js 14.8+).
const _stencilDir = resolve(__dir, '../../src/main/webapp/stencils');
const _stencilRegistry = await loadStencils(_stencilDir);
if (typeof exporter.registerStencils === 'function') {
  exporter.registerStencils(_stencilRegistry);
}

// Minimal absolute-path bounds (M/L/H/V/C/A/Z) for the ink-extent pass.
// C uses the control hull (conservative), A the endpoint boxes grown by r.
function inkPathMin(d) {
  const toks = String(d).match(/[a-zA-Z]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  let i = 0, cx = 0, cy = 0, cmd = '';
  let minX = Infinity, minY = Infinity;
  const ext = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; };
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const C = (cmd || '').toUpperCase();
    if (C === 'M' || C === 'L') { cx = num(); cy = num(); ext(cx, cy); if (C === 'M') cmd = 'L'; }
    else if (C === 'H') { cx = num(); ext(cx, cy); }
    else if (C === 'V') { cy = num(); ext(cx, cy); }
    else if (C === 'C') { ext(num(), num()); ext(num(), num()); cx = num(); cy = num(); ext(cx, cy); }
    else if (C === 'A') { num(); num(); num(); num(); num();
      // Endpoints only: end+-r over-estimates by up to 2r and would shift
      // content spuriously. An arc's true extremes never exceed its cell
      // geometry, which the parser bounds already cover.
      const x = num(), y = num(); ext(x, y); cx = x; cy = y; }
    else if (C === 'Z') { /* nothing */ }
    else break;
  }
  return isFinite(minX) ? { x: minX, y: minY } : null;
}

// True ink minimum of an emitted page (boxes for box-bearing nodes, parsed
// path extents for kind:path).
function pageInkMin(page) {
  let minX = 0, minY = 0;
  for (const n of page.paint || []) {
    if (n.box) { minX = Math.min(minX, n.box.x); minY = Math.min(minY, n.box.y); }
    else if (n.kind === 'path' && typeof n.d === 'string') {
      const m = inkPathMin(n.d);
      if (m) { minX = Math.min(minX, m.x); minY = Math.min(minY, m.y); }
    }
  }
  return { x: minX, y: minY };
}

// Bake a single page (internal helper). Resolves external images first.
// Returns { pxContract (one-page), notices }.
async function bakePage(pageData, exporterOpts, fetchFn) {
  const graph = buildGraph(pageData.cells, pageData.paper);
  // Pre-resolve external image URLs so they print WYSIWYG (no ExporterUnsupportedImage).
  // embedExternalImages is a no-op when no external URLs are present.
  let resolvedImages = {};
  if (typeof exporter.embedExternalImages === 'function') {
    resolvedImages = await exporter.embedExternalImages(graph, fetchFn || localFileFetch, null, null)
      .catch(() => ({}));
  }
  const first = exporter.buildResult(graph, pageData.paper,
    { ...(exporterOpts || {}), resolvedImages });
  // INK-EXTENT PASS: the parser's geometry bounds cannot know every painted
  // halo (outside-positioned labels, wedge/arrow band widths, rotation
  // slop). If any EMITTED ink lands above/left of the page origin, shift
  // the anchor by the overhang and re-bake once -- so what the editor shows
  // at the content edge is on the paper, not off it.
  const page0 = first.contract.document.pages[0];
  const inkMin = pageInkMin(page0);
  const PAD = 2.5; // exporter SVG_PAD slop: boxes legitimately sit ~2px out
  // Author-fixed page size: positions are PAGE-RELATIVE truth — ink past
  // the page edge is the owner-ruled HardwareMarginClip edge-clip case,
  // and shifting the anchor would move every cell off its authored
  // position. The shift only applies to auto-fit pages, whose origin is
  // derived from (halo-blind) geometry bounds in the first place.
  if (!(pageData.paper && pageData.paper.explicit) &&
      (inkMin.x < -PAD || inkMin.y < -PAD)) {
    const shiftX = Math.min(0, inkMin.x + PAD);
    const shiftY = Math.min(0, inkMin.y + PAD);
    const b = graph.getGraphBounds();
    const shifted = {
      ...graph,
      getGraphBounds: () => ({
        x: b.x + shiftX, y: b.y + shiftY,
        width: b.width, height: b.height
      })
    };
    return exporter.buildResult(shifted, pageData.paper,
      { ...(exporterOpts || {}), resolvedImages });
  }
  return first;
}

// Bake a .drawio XML string to a multi-page um-unit contract.
//
// options:
//   unattended  {boolean} — D5: throw BakeNoticeError if any notice is produced
//   pages       {number[]} — 0-based page indices to include (default: all)
//   fetchFn     {function} — injectable fetch implementation (for tests / Node)
//   keepPx      {boolean}  — if true, skip px-to-um conversion and return a
//                             px-unit contract (schema 1.0). Useful when the
//                             engine binary predates um-unit support.
//   exporterOpts — passed through to exporter.buildResult()
//
// Returns Promise<{ contract, notices }> where:
//   contract — schema-1.1 um-unit object with all baked pages
//   notices  — flat array of all notices from all pages
// The dialog's tested severity taxonomy (exporter.js noticeSeverity):
// 'silent' / 'info' never block printing; 'degradation' requires an ack.
export const noticeSeverity = exporter.noticeSeverity;

export async function bake(drawioXml, options) {
  const opts = options || {};
  const parsed = parseDrawio(drawioXml);

  // Determine which pages to bake
  let pagesToBake = parsed.pages;
  if (Array.isArray(opts.pages) && opts.pages.length > 0) {
    pagesToBake = opts.pages.map((i) => {
      if (i < 0 || i >= parsed.pages.length) {
        throw new RangeError(`page index ${i} out of range (file has ${parsed.pages.length} page(s))`);
      }
      return parsed.pages[i];
    });
  }

  const allNotices = [];
  const pxPages = [];
  let bakeMeta = null;

  for (let idx = 0; idx < pagesToBake.length; idx++) {
    const pageData = pagesToBake[idx];
    const result = await bakePage(
      pageData, { ...(opts.exporterOpts || {}), headless: true }, opts.fetchFn);
    allNotices.push(...result.notices);
    // Take the single page the exporter produced, tag with ordinal id
    const page = result.contract.document.pages[0];
    page.id = `page-${idx + 1}`;
    pxPages.push(page);
    // Capture meta from first page (all pages share the same bake mode).
    if (!bakeMeta && result.contract.meta) bakeMeta = result.contract.meta;
  }

  // D5: fail loudly if unattended and any notice was raised
  if (opts.unattended && allNotices.length > 0) {
    const err = new Error(
      `D5: bake produced ${allNotices.length} degradation notice(s); job refused`);
    err.code = 'BAKE_NOTICES';
    err.notices = allNotices;
    throw err;
  }

  // Build combined px contract, then convert to um (unless keepPx requested)
  const pxContract = {
    schema: { major: 1, minor: 0 },
    document: { units: 'px', pages: pxPages }
  };
  if (bakeMeta) pxContract.meta = bakeMeta;
  const contract = opts.keepPx ? pxContract : pxContractToUm(pxContract);

  return { contract, notices: allNotices };
}

// CLI entry point
async function main() {
  const [, , input, output] = process.argv;
  if (!input) {
    process.stderr.write('usage: bake.mjs <input.drawio> [output.contract.json]\n');
    process.exit(2);
  }

  let xml;
  try {
    xml = await readFile(input, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${input}: ${e.message}\n`);
    process.exit(2);
  }

  let result;
  try {
    result = await bake(xml);
  } catch (e) {
    process.stderr.write(`bake failed: ${e.message}\n`);
    process.exit(1);
  }

  const json = JSON.stringify(result.contract, null, 2);

  if (output) {
    await writeFile(output, json, 'utf8');
  } else {
    process.stdout.write(json + '\n');
  }

  if (result.notices.length > 0) {
    for (const n of result.notices) {
      process.stderr.write(`NOTICE [${n.kind}]: ${n.detail && n.detail.detail || ''}\n`);
    }
  }

  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
