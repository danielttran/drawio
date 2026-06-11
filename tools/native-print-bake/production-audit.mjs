#!/usr/bin/env node
// Browser-free Native Print production audit.
// Enumerates draw.io's registered Shapes.js objects and checked-in stencil
// catalogue, bakes each object through the headless native-print path, and
// validates every generated contract with the same schema validator used by CI.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { bake } from './bake.mjs';
import { loadStencils } from './stencil-loader.mjs';
// Reuse the verification gate's page composer + PRODUCTION resvg CLI: the ink
// check below must rasterize through the exact pipeline the printer uses, not
// a parallel reimplementation.
import { composePageSvg, rasterizeSvg, RASTERIZE } from './render-artifact.mjs';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const shapesJsPath = resolve(repoRoot, 'src/main/webapp/js/grapheditor/Shapes.js');
const stencilDir = resolve(repoRoot, 'src/main/webapp/stencils');
const validatorPath = resolve(here, '../native-print-validate-contract.mjs');

function xmlAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Grid layout shared by the bake sheet and the ink check: shape i sits at
// cell (i % GRID_COLS, floor(i / GRID_COLS)), CELL_PX apart, SHAPE_PX big.
const GRID_COLS = 20;
const CELL_PX = 60;
const SHAPE_PX = 50;

function graphXmlForShapes(shapes, label, colors) {
  const fill = colors?.fill || '#ffffff';
  const stroke = colors?.stroke || '#000000';
  let cells = '<mxCell id="0"/><mxCell id="1" parent="0"/>';
  shapes.forEach((shape, i) => {
    cells += `<mxCell id="c${i}" vertex="1" value="${xmlAttr(label || '')}" ` +
      `style="shape=${xmlAttr(shape)};fillColor=${fill};strokeColor=${stroke};" parent="1">` +
      `<mxGeometry x="${(i % GRID_COLS) * CELL_PX}" y="${Math.floor(i / GRID_COLS) * CELL_PX}" ` +
      `width="${SHAPE_PX}" height="${SHAPE_PX}" as="geometry"/></mxCell>`;
  });
  return `<mxGraphModel pageWidth="1200" pageHeight="3000"><root>${cells}</root></mxGraphModel>`;
}

async function validateContract(contract, label, tmpDir) {
  const file = join(tmpDir, `${label}.contract.json`);
  await writeFile(file, JSON.stringify(contract), 'utf8');
  const result = await execFileP(process.execPath, [validatorPath, file]).catch((err) => err);
  if ((result.code ?? 0) !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${label} contract failed schema validation\n${details}`);
  }
}

function assertNoDegradationNotices(notices, label) {
  if (!Array.isArray(notices) || notices.length === 0) return;
  const rendered = notices.map((n) => `${n.kind}: ${n.detail?.detail || ''}`).join('; ');
  throw new Error(`${label} produced ${notices.length} notice(s): ${rendered}`);
}

// True if the tile [x0,y0,w,h] of an RGBA buffer contains any INK: an opaque
// pixel that is not the pure-white page background. The audit sheet draws
// every shape with strokeColor=#000000 on a white page, so a shape whose tile
// is all-white rasterized to NOTHING — an invisible (ink-less) bake that the
// zero-notices + schema checks alone would silently pass.
function tileHasInk(rgba, imgW, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) {
    let idx = (y * imgW + x0) * 4;
    for (let x = 0; x < w; x++, idx += 4) {
      if (rgba[idx + 3] !== 0 &&
          !(rgba[idx] === 255 && rgba[idx + 1] === 255 && rgba[idx + 2] === 255)) {
        return true;
      }
    }
  }
  return false;
}

// OPTIONAL ink gate. Performance approach (documented per the audit mandate):
// instead of spawning the rasterizer once per shape (8910+ process spawns —
// hours), a BATCHED ink sheet (one page per chunk, shapes on a fixed grid)
// is rasterized ONCE per chunk through the production resvg CLI, then each
// shape's grid tile is scanned for opaque non-background pixels. That is one
// bake + one rasterizer invocation per chunk (~10 for the full 86-shape +
// 8910-stencil sweep), completing in minutes.
//
// The ink sheet is baked with HIGH-VISIBILITY colors (magenta fill / blue
// stroke) instead of the notice sweep's white fill: 2068 fill-only stencils
// (logo glyphs etc.) faithfully render white-on-white — invisible by COLOR
// CHOICE, not by rasterization failure. The gate exists to catch the latter
// (a shape whose bake/raster produces literally no ink under colors that
// must show), not to flag white shapes on white paper.
async function assertChunkHasInk(chunk, label, chunkLabel, tmpDir, blankShapes) {
  const inkXml = graphXmlForShapes(chunk, label,
    { fill: '#ff00ff', stroke: '#0000ff' });
  const { contract } = await bake(inkXml, { keepPx: true });
  const page = contract.document.pages[0];
  const svgText = composePageSvg(page);
  // dpi 96 == contract px 1:1; the tile grid maps directly.
  const { rgba, w, h } = await rasterizeSvg(
    svgText, Math.round(page.size.w), Math.round(page.size.h), 96, tmpDir, chunkLabel);
  const sx = w / page.size.w;
  const sy = h / page.size.h;
  chunk.forEach((shape, i) => {
    const x0 = Math.max(0, Math.floor((i % GRID_COLS) * CELL_PX * sx));
    const y0 = Math.max(0, Math.floor(Math.floor(i / GRID_COLS) * CELL_PX * sy));
    const tw = Math.min(Math.ceil(CELL_PX * sx), w - x0);
    const th = Math.min(Math.ceil(CELL_PX * sy), h - y0);
    if (tw <= 0 || th <= 0 || !tileHasInk(rgba, w, x0, y0, tw, th)) {
      blankShapes.push(shape);
    }
  });
}

async function auditShapeSet(name, shapes, options) {
  const chunkSize = options?.chunkSize || shapes.length;
  const label = options?.label || '';
  const tmpDir = options.tmpDir;
  const inkGate = !!options.inkGate;
  let paintNodes = 0;
  const blankShapes = [];

  for (let start = 0; start < shapes.length; start += chunkSize) {
    const chunk = shapes.slice(start, start + chunkSize);
    const result = await bake(graphXmlForShapes(chunk, label), { keepPx: true });
    const chunkLabel = `${name}-${start}-${start + chunk.length - 1}`;
    assertNoDegradationNotices(result.notices, chunkLabel);
    await validateContract(result.contract, chunkLabel, tmpDir);
    paintNodes += result.contract.document.pages[0].paint.length;
    if (inkGate) {
      await assertChunkHasInk(chunk, label, chunkLabel, tmpDir, blankShapes);
    }
  }

  return { name, shapes: shapes.length, paintNodes, blankShapes };
}

async function main() {
  const tmpDir = await mkdtemp(join(tmpdir(), 'native-print-production-audit-'));
  try {
    const shapesJs = await readFile(shapesJsPath, 'utf8');
    const registeredShapes = [...new Set([...shapesJs.matchAll(/mxCellRenderer\.registerShape\('([^']+)'/g)]
      .map((m) => m[1]))];
    if (registeredShapes.length < 80) {
      throw new Error(`Shapes.js audit saw only ${registeredShapes.length} registered shapes`);
    }

    const stencilRegistry = await loadStencils(stencilDir);
    const stencilShapes = [...stencilRegistry.keys()];
    if (stencilShapes.length < 8000) {
      throw new Error(`Stencil audit saw only ${stencilShapes.length} stencil shapes`);
    }

    // OPTIONAL ink gate: only when the production rasterizer is available
    // (SVG_RASTERIZER_LIB set AND the render CLI built). Skippable so the
    // notice/schema sweep still runs on boxes without the Rust cdylib —
    // but say so loudly instead of silently downgrading the audit.
    const inkGate = !!process.env.SVG_RASTERIZER_LIB && existsSync(RASTERIZE);
    if (!inkGate) {
      process.stdout.write(
        'NOTE: ink check SKIPPED (set SVG_RASTERIZER_LIB and build ' +
        'tools/native-print-bake/native-engine-render/rasterize to enable); ' +
        'an ink-less (invisible) bake would not be caught by this run\n');
    }

    const results = [];
    results.push(await auditShapeSet('registered-shapes', registeredShapes,
      { label: 'T', tmpDir, inkGate }));
    results.push(await auditShapeSet('stencils', stencilShapes,
      { chunkSize: 1000, tmpDir, inkGate }));

    let totalBlank = 0;
    for (const r of results) {
      const inkStr = inkGate
        ? `, ${r.shapes - r.blankShapes.length} with ink, ${r.blankShapes.length} blank`
        : '';
      process.stdout.write(`${r.name}: ${r.shapes} shapes, ${r.paintNodes} paint nodes, zero notices${inkStr}\n`);
      for (const s of r.blankShapes) {
        process.stdout.write(`  BLANK (rendered zero ink): ${s}\n`);
      }
      totalBlank += r.blankShapes.length;
    }
    if (totalBlank > 0) {
      throw new Error(`${totalBlank} shape(s) baked to an ink-less (invisible) render`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`native print production audit failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
