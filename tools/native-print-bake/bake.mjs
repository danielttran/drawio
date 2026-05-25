#!/usr/bin/env node
// Headless bake: .drawio (mxGraph XML) → frozen um-unit contract JSON.
//
// Reuses the existing exporter (src/main/webapp/plugins/nativeprint/exporter.js)
// with the draw.io graph model built headlessly from the parsed XML.
// Outputs schema 1.1 ("um" units, minor=1) as required by §4 of the spec.
//
// CLI:  node bake.mjs <input.drawio> [output.contract.json]
// API:  import { bake } from './bake.mjs';
//       const { contract, notices } = await bake(xmlString);

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { parseDrawio, buildGraph } from './drawio-parser.mjs';
import { pxContractToUm } from './px-to-um.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

// Load the exporter as a CommonJS module (it self-registers on module.exports).
const require = createRequire(import.meta.url);
const exporterPath = resolve(__dir, '../../src/main/webapp/plugins/nativeprint/exporter.js');
const exporter = require(exporterPath);

// Bake a .drawio XML string to a contract.
// Returns { contract, notices } where contract is a um-unit schema-1.1 object.
export function bake(drawioXml, options) {
  const opts = options || {};
  const { cells, paper } = parseDrawio(drawioXml);
  const graph = buildGraph(cells, paper);

  // paper: { wPx, hPx } — page size in model px; buildResult() expects { wPx, hPx }
  const result = exporter.buildResult(graph, paper, opts.exporterOpts || null);

  const umContract = pxContractToUm(result.contract);
  return { contract: umContract, notices: result.notices };
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
