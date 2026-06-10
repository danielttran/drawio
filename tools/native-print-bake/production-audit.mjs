#!/usr/bin/env node
// Browser-free Native Print production audit.
// Enumerates draw.io's registered Shapes.js objects and checked-in stencil
// catalogue, bakes each object through the headless native-print path, and
// validates every generated contract with the same schema validator used by CI.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { bake } from './bake.mjs';
import { loadStencils } from './stencil-loader.mjs';

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

function graphXmlForShapes(shapes, label) {
  let cells = '<mxCell id="0"/><mxCell id="1" parent="0"/>';
  shapes.forEach((shape, i) => {
    cells += `<mxCell id="c${i}" vertex="1" value="${xmlAttr(label || '')}" ` +
      `style="shape=${xmlAttr(shape)};fillColor=#ffffff;strokeColor=#000000;" parent="1">` +
      `<mxGeometry x="${(i % 20) * 60}" y="${Math.floor(i / 20) * 60}" ` +
      `width="50" height="50" as="geometry"/></mxCell>`;
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

async function auditShapeSet(name, shapes, options) {
  const chunkSize = options?.chunkSize || shapes.length;
  const label = options?.label || '';
  const tmpDir = options.tmpDir;
  let paintNodes = 0;

  for (let start = 0; start < shapes.length; start += chunkSize) {
    const chunk = shapes.slice(start, start + chunkSize);
    const result = await bake(graphXmlForShapes(chunk, label), { keepPx: true });
    const chunkLabel = `${name}-${start}-${start + chunk.length - 1}`;
    assertNoDegradationNotices(result.notices, chunkLabel);
    await validateContract(result.contract, chunkLabel, tmpDir);
    paintNodes += result.contract.document.pages[0].paint.length;
  }

  return { name, shapes: shapes.length, paintNodes };
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

    const results = [];
    results.push(await auditShapeSet('registered-shapes', registeredShapes,
      { label: 'T', tmpDir }));
    results.push(await auditShapeSet('stencils', stencilShapes,
      { chunkSize: 1000, tmpDir }));

    for (const r of results) {
      process.stdout.write(`${r.name}: ${r.shapes} shapes, ${r.paintNodes} paint nodes, zero notices\n`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`native print production audit failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
