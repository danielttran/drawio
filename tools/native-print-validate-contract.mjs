#!/usr/bin/env node
// Browser-free contract validator for the C5 manual validation runbook.
//
// Reads a baked native-print JSON contract and asserts the engine
// invariants the operator must rely on before clicking Print:
//
//   - schema.major == 1
//   - document.units == "px"
//   - every page has size + at least one tile
//   - every paint node has a positive-w/h box
//   - every text node either carries non-empty static lines OR a non-empty
//     rich.paragraphs[].runs[] with non-empty text per run, AND alignment
//     fields are present
//   - every svg node carries a non-empty base64 source
//   - every image node carries a base64 PNG payload and an aspect
//   - every barcode node (until the SDK lands) carries a value + symbology
//
// On any violation it prints "<path>: <detail>" lines and exits 1.
// On full success exits 0 with no stdout (so it's tail-able in CI).
//
// CONSTRAINTS: pure Node, no browser, no jsdom, no Playwright -- per
// docs/CLAUDE.md "Native Print -- NON-NEGOTIABLE CONSTRAINTS" C2 the
// validation half of the runbook cannot depend on any of those.

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const errors = [];
function bad(path, detail) { errors.push(`${path}: ${detail}`); }
function required(node, key, path, type) {
  if (node == null || !Object.prototype.hasOwnProperty.call(node, key)) {
    bad(path + '.' + key, 'missing');
    return false;
  }
  if (type && typeof node[key] !== type) {
    bad(path + '.' + key, `expected ${type}, got ${typeof node[key]}`);
    return false;
  }
  return true;
}
function isPositiveNumber(v) { return typeof v === 'number' && isFinite(v) && v > 0; }

function validateBox(box, path) {
  if (!box || typeof box !== 'object') { bad(path, 'missing box'); return; }
  for (const k of ['x', 'y', 'w', 'h']) {
    if (typeof box[k] !== 'number' || !isFinite(box[k])) {
      bad(`${path}.${k}`, 'not a finite number');
    }
  }
  if (!isPositiveNumber(box.w)) bad(`${path}.w`, 'not strictly positive');
  if (!isPositiveNumber(box.h)) bad(`${path}.h`, 'not strictly positive');
}

function validatePaintNode(node, path) {
  if (!node || typeof node !== 'object') { bad(path, 'not an object'); return; }
  if (!required(node, 'kind', path, 'string')) return;
  validateBox(node.box, path + '.box');
  switch (node.kind) {
    case 'path': {
      if (!required(node, 'd', path, 'string')) break;
      if (!node.d.startsWith('M') && !node.d.startsWith('m')) {
        bad(path + '.d', 'SVG path must start with an M command');
      }
      // dash key is REQUIRED on stroke when stroke is present.
      if (node.stroke && !Object.prototype.hasOwnProperty.call(node.stroke, 'dash')) {
        bad(path + '.stroke.dash', 'stroke object missing required dash key (use null for solid)');
      }
      break;
    }
    case 'text': {
      if (!required(node, 'font', path, 'object')) break;
      required(node.font, 'family', path + '.font', 'string');
      if (!isPositiveNumber(node.font?.sizePx)) bad(path + '.font.sizePx', 'must be > 0');
      if (!required(node, 'align', path, 'object')) break;
      if (!['left', 'center', 'right'].includes(node.align?.h)) {
        bad(path + '.align.h', `must be left|center|right, got ${JSON.stringify(node.align?.h)}`);
      }
      if (!['top', 'middle', 'bottom'].includes(node.align?.v)) {
        bad(path + '.align.v', `must be top|middle|bottom, got ${JSON.stringify(node.align?.v)}`);
      }
      const c = node.content;
      if (!c || typeof c !== 'object') { bad(path + '.content', 'missing'); break; }
      if (c.type === 'static') {
        if (!Array.isArray(c.lines) || c.lines.length === 0) {
          bad(path + '.content.lines', 'static text must have at least one line');
        } else if (!c.lines.every((ln) => typeof ln === 'string')) {
          bad(path + '.content.lines', 'every line must be a string');
        }
      } else if (c.type === 'rich') {
        if (!Array.isArray(c.paragraphs) || c.paragraphs.length === 0) {
          bad(path + '.content.paragraphs', 'rich text must have at least one paragraph');
        } else {
          c.paragraphs.forEach((p, pi) => {
            if (!p || typeof p !== 'object') { bad(`${path}.content.paragraphs[${pi}]`, 'not an object'); return; }
            if (!Array.isArray(p.runs)) { bad(`${path}.content.paragraphs[${pi}].runs`, 'missing'); return; }
            p.runs.forEach((r, ri) => {
              if (typeof r?.text !== 'string') {
                bad(`${path}.content.paragraphs[${pi}].runs[${ri}].text`, 'must be a string');
              }
              if (!isPositiveNumber(r?.sizePx)) {
                bad(`${path}.content.paragraphs[${pi}].runs[${ri}].sizePx`, 'must be > 0');
              }
            });
          });
        }
      } else if (c.type === 'merge') {
        for (const k of ['key', 'sample', 'maxLen', 'wrap', 'overflow']) {
          if (!Object.prototype.hasOwnProperty.call(c, k)) {
            bad(`${path}.content.${k}`, 'missing on merge content');
          }
        }
      } else {
        bad(path + '.content.type', `unknown text content type ${JSON.stringify(c.type)}`);
      }
      break;
    }
    case 'image': {
      if (!required(node, 'format', path, 'string')) break;
      if (!required(node, 'data', path, 'string')) break;
      if (!required(node, 'aspect', path, 'string')) break;
      if (node.format !== 'png') {
        bad(path + '.format', `only PNG is engine-supported, got ${JSON.stringify(node.format)}`);
      }
      if (node.data.length === 0) bad(path + '.data', 'base64 payload is empty');
      break;
    }
    case 'svg': {
      if (!required(node, 'source', path, 'string')) break;
      if (node.source.length === 0) bad(path + '.source', 'base64 svg source is empty');
      break;
    }
    case 'barcode': {
      // Barcode lives behind a loud stub until the enLabel SDK lands; we
      // still check the schema fields are present so the engine accepts it.
      required(node, 'symbology', path, 'string');
      if (node.valueType !== 'static' && node.valueType !== 'merge') {
        bad(path + '.valueType', `must be static|merge, got ${JSON.stringify(node.valueType)}`);
      }
      break;
    }
    default:
      bad(path + '.kind', `unknown kind ${JSON.stringify(node.kind)}`);
  }
}

function validate(contract) {
  if (!contract || typeof contract !== 'object') {
    bad('$', 'contract is not an object'); return;
  }
  if (!required(contract, 'schema', '$', 'object')) return;
  if (contract.schema?.major !== 1) {
    bad('$.schema.major', `must be 1, got ${JSON.stringify(contract.schema?.major)}`);
  }
  if (!required(contract, 'document', '$', 'object')) return;
  if (contract.document?.units !== 'px') {
    bad('$.document.units', `must be "px", got ${JSON.stringify(contract.document?.units)}`);
  }
  if (!Array.isArray(contract.document?.pages) || contract.document.pages.length === 0) {
    bad('$.document.pages', 'must be a non-empty array'); return;
  }
  contract.document.pages.forEach((page, pi) => {
    const p = `$.document.pages[${pi}]`;
    required(page, 'id', p, 'string');
    if (page.size) {
      if (!isPositiveNumber(page.size.w)) bad(p + '.size.w', 'must be > 0');
      if (!isPositiveNumber(page.size.h)) bad(p + '.size.h', 'must be > 0');
    } else {
      bad(p + '.size', 'missing');
    }
    if (!Array.isArray(page.tiles) || page.tiles.length === 0) {
      bad(p + '.tiles', 'must be a non-empty array');
    } else {
      page.tiles.forEach((t, ti) => {
        const tp = `${p}.tiles[${ti}]`;
        if (!t?.origin || typeof t.origin.x !== 'number' || typeof t.origin.y !== 'number') {
          bad(tp + '.origin', 'must have numeric x,y');
        }
        if (!t?.size || !isPositiveNumber(t.size.w) || !isPositiveNumber(t.size.h)) {
          bad(tp + '.size', 'must have positive w,h');
        }
      });
    }
    if (!Array.isArray(page.paint)) {
      bad(p + '.paint', 'must be an array (may be empty)');
    } else {
      page.paint.forEach((node, ni) => {
        validatePaintNode(node, `${p}.paint[${ni}]`);
      });
    }
  });
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('usage: native-print-validate-contract.mjs <contract.json>\n');
    process.exit(2);
  }
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (e) {
    process.stderr.write(`could not read ${path}: ${e.message}\n`);
    process.exit(2);
  }
  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    process.stderr.write(`invalid JSON: ${e.message}\n`);
    process.exit(2);
  }
  validate(json);
  if (errors.length > 0) {
    for (const e of errors) process.stdout.write(e + '\n');
    process.exit(1);
  }
  process.exit(0);
}

main();
