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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseDrawio, buildGraph } from './drawio-parser.mjs';
import { pxContractToUm } from './px-to-um.mjs';
import { createSvgEnv } from './svg-shim/index.mjs';
import { loadStencils } from './stencil-loader.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

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

// Bake a single page (internal helper).
// Returns { pxContract (one-page), notices }.
function bakePage(pageData, exporterOpts) {
  const graph = buildGraph(pageData.cells, pageData.paper);
  return exporter.buildResult(graph, pageData.paper, exporterOpts || null);
}

// Bake a .drawio XML string to a multi-page um-unit contract.
//
// options:
//   unattended  {boolean} — D5: throw BakeNoticeError if any notice is produced
//   pages       {number[]} — 0-based page indices to include (default: all)
//   exporterOpts — passed through to exporter.buildResult()
//
// Returns { contract, notices } where:
//   contract — schema-1.1 um-unit object with all baked pages
//   notices  — flat array of all notices from all pages
export function bake(drawioXml, options) {
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

  pagesToBake.forEach((pageData, idx) => {
    const result = bakePage(pageData, { ...(opts.exporterOpts || {}), mode: 'B' });
    allNotices.push(...result.notices);
    // Take the single page the exporter produced, tag with ordinal id
    const page = result.contract.document.pages[0];
    page.id = `page-${idx + 1}`;
    pxPages.push(page);
    // Capture meta from first page (all pages share the same bake mode).
    if (!bakeMeta && result.contract.meta) bakeMeta = result.contract.meta;
  });

  // D5: fail loudly if unattended and any notice was raised
  if (opts.unattended && allNotices.length > 0) {
    const err = new Error(
      `D5: bake produced ${allNotices.length} degradation notice(s); job refused`);
    err.code = 'BAKE_NOTICES';
    err.notices = allNotices;
    throw err;
  }

  // Build combined px contract, then convert to um
  const pxContract = {
    schema: { major: 1, minor: 0 },
    document: { units: 'px', pages: pxPages }
  };
  if (bakeMeta) pxContract.meta = bakeMeta;
  const umContract = pxContractToUm(pxContract);

  return { contract: umContract, notices: allNotices };
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
    result = bake(xml);
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
