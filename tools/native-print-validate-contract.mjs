#!/usr/bin/env node
// Browser-free contract validator for the C5 manual validation runbook.
//
// Reads a baked native-print JSON contract and asserts the engine
// invariants the operator must rely on before clicking Print:
//
//   - schema.major == 1
//   - document.units == "px" or "um"
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
  // Per the v1.1 contract Appendix, path nodes derive bounds from the parsed
  // `d`; every OTHER known paint kind carries a JSON `box`. Validate `box`
  // only on those kinds so an unknown-kind error isn't accompanied by a
  // spurious missing-box error.
  const boxBearingKinds = new Set(['text', 'image', 'svg', 'barcode']);
  if (boxBearingKinds.has(node.kind)) {
    validateBox(node.box, path + '.box');
  }
  switch (node.kind) {
    case 'path': {
      if (!required(node, 'd', path, 'string')) break;
      // Appendix A: paths must be ABSOLUTE. Lowercase commands are relative
      // and are rejected by the engine's path parser.
      if (!node.d.startsWith('M')) {
        bad(path + '.d', 'SVG path must start with an absolute M command (uppercase)');
      }
      // Mirror the C++ path parser's command whitelist (path_parser.cpp):
      // ONLY absolute M L H V C A Z. A validator that lets Q/S/T or any
      // lowercase command through blesses a contract the engine rejects
      // mid-job -- the exact failure the C5 runbook validation exists to
      // prevent.
      {
        const cmds = node.d.match(/[A-Za-z]/g) || [];
        for (const cmd of cmds) {
          if (!'MLHVCAZ'.includes(cmd)) {
            bad(path + '.d', `engine-unsupported path command ${JSON.stringify(cmd)} (only absolute M L H V C A Z)`);
            break;
          }
        }
      }
      validatePaint(node.fill, path + '.fill');
      validateStroke(node.stroke, path + '.stroke');
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
      if (node.aspect !== 'preserve' && node.aspect !== 'fill') {
        bad(path + '.aspect', `must be preserve|fill, got ${JSON.stringify(node.aspect)}`);
      }
      break;
    }
    case 'svg': {
      if (!required(node, 'source', path, 'string')) break;
      if (!required(node, 'aspect', path, 'string')) break;
      if (node.source.length === 0) bad(path + '.source', 'base64 svg source is empty');
      if (node.aspect !== 'preserve' && node.aspect !== 'fill') {
        bad(path + '.aspect', `must be preserve|fill, got ${JSON.stringify(node.aspect)}`);
      }
      break;
    }
    case 'barcode': {
      // Barcode lives behind a loud stub until the enLabel SDK lands; the
      // ENGINE (contract_loader.cpp) requires a `value` OBJECT carrying
      // type static|merge -- the old top-level valueType check validated a
      // field that does not exist and missed the required one.
      required(node, 'symbology', path, 'string');
      const bv = node.value;
      if (!bv || typeof bv !== 'object') {
        bad(path + '.value', 'barcode requires a value object');
      } else if (bv.type !== 'static' && bv.type !== 'merge') {
        bad(path + '.value.type', `must be static|merge, got ${JSON.stringify(bv.type)}`);
      }
      break;
    }
    default:
      bad(path + '.kind', `unknown kind ${JSON.stringify(node.kind)}`);
  }
}


const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function validateColor(c, path) {
  if (typeof c !== 'string' || !HEX_COLOR.test(c)) {
    bad(path, `engine requires exactly #rrggbb, got ${JSON.stringify(c)}`);
  }
}

// Mirrors contract_loader.cpp parse_paint: null, or solid {color, alpha},
// or linear/radial {stops:[{offset, color, alpha?}]}.
function validatePaint(paint, path) {
  if (paint == null) return;
  if (typeof paint !== 'object') { bad(path, 'paint must be null or an object'); return; }
  if (paint.type === 'solid') {
    validateColor(paint.color, path + '.color');
    if (paint.alpha != null && !(typeof paint.alpha === 'number' && paint.alpha >= 0 && paint.alpha <= 1)) {
      bad(path + '.alpha', 'alpha must be in [0,1]');
    }
  } else if (paint.type === 'linear' || paint.type === 'radial') {
    // The engine (contract_loader.cpp parse_paint) accepts >= 1 stop; a
    // >= 2 check here falsely rejected contracts the engine prints fine.
    if (!Array.isArray(paint.stops) || paint.stops.length < 1) {
      bad(path + '.stops', 'gradient needs >= 1 stop');
      return;
    }
    paint.stops.forEach((stop, i) => {
      if (!(typeof stop?.offset === 'number' && stop.offset >= 0 && stop.offset <= 1)) {
        bad(`${path}.stops[${i}].offset`, 'offset must be in [0,1]');
      }
      validateColor(stop?.color, `${path}.stops[${i}].color`);
      if (stop?.alpha != null && !(typeof stop.alpha === 'number' && stop.alpha >= 0 && stop.alpha <= 1)) {
        bad(`${path}.stops[${i}].alpha`, 'alpha must be in [0,1]');
      }
    });
  } else {
    bad(path + '.type', `unknown paint type ${JSON.stringify(paint.type)}`);
  }
}

// Mirrors contract_loader.cpp parse_stroke: null, or an object requiring
// paint, width>0, cap/join enums, miterLimit>0, dash null-or-positive-array.
function validateStroke(stroke, path) {
  if (stroke == null) return;
  if (typeof stroke !== 'object') { bad(path, 'stroke must be null or an object'); return; }
  if (!Object.prototype.hasOwnProperty.call(stroke, 'paint')) {
    bad(path + '.paint', 'stroke object missing required paint');
  } else {
    validatePaint(stroke.paint, path + '.paint');
  }
  if (!(typeof stroke.width === 'number' && stroke.width > 0)) {
    bad(path + '.width', 'stroke width must be > 0');
  }
  if (!['butt', 'round', 'square'].includes(stroke.cap)) {
    bad(path + '.cap', `must be butt|round|square, got ${JSON.stringify(stroke.cap)}`);
  }
  if (!['miter', 'round', 'bevel'].includes(stroke.join)) {
    bad(path + '.join', `must be miter|round|bevel, got ${JSON.stringify(stroke.join)}`);
  }
  if (!(typeof stroke.miterLimit === 'number' && stroke.miterLimit > 0)) {
    bad(path + '.miterLimit', 'miterLimit must be > 0');
  }
  if (!Object.prototype.hasOwnProperty.call(stroke, 'dash')) {
    bad(path + '.dash', 'stroke object missing required dash key (use null for solid)');
  } else if (stroke.dash != null) {
    if (!Array.isArray(stroke.dash) ||
        !stroke.dash.every((v) => typeof v === 'number' && v > 0)) {
      bad(path + '.dash', 'dash must be null or an array of positive numbers');
    }
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
  // The engine loader (contract_loader.cpp) require_int's schema.minor too;
  // a contract that omits it passes a major-only validation here, then fails
  // at the engine boundary — the exact drift this validator exists to catch.
  if (!Number.isInteger(contract.schema?.minor) || contract.schema.minor < 0) {
    bad('$.schema.minor', `must be a non-negative integer, got ${JSON.stringify(contract.schema?.minor)}`);
  }
  if (!required(contract, 'document', '$', 'object')) return;
  if (contract.document?.units !== 'px' && contract.document?.units !== 'um') {
    bad('$.document.units', `must be "px" or "um", got ${JSON.stringify(contract.document?.units)}`);
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
