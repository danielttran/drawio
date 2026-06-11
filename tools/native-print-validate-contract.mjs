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
function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }
// Mirrors the loader's require_int: a finite number with no fractional part,
// inside C++ int range (contract_loader.cpp require_int).
function isLoaderInt(v) {
  return isFiniteNumber(v) && Math.floor(v) === v &&
    v >= -2147483648 && v <= 2147483647;
}

// Mirrors the loader's base64 shape check (contract_loader.cpp
// is_base64_like/decode_base64, with the concurrent tightening that '=' is
// only legal as FINAL padding, never mid-block): non-empty, length % 4 == 0,
// only [A-Za-z0-9+/] plus at most two trailing '='.
function isStrictBase64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

// Mirror of src/main/native-print-engine/src/path_parser.cpp, the ONLY
// authority on what `d` the engine accepts:
//   - leading/trailing whitespace and commas are separators (skip_separators)
//   - commands are single UPPERCASE letters from M L H V C A Z; the first
//     command does NOT have to be M (an initial L/H/V/... is accepted, the
//     implicit current point starts at 0,0)
//   - numbers are std::from_chars doubles with an optional single leading
//     '+': exponents (1e2), "5.", ".5" all parse; "inf"/"nan"/overflow are
//     rejected via the isfinite check
//   - each command must be followed by its full arity of numbers
//   - the path must contain >= 1 command and >= 1 positioned (non-Z) command
function validatePathD(d, path) {
  const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, A: 7, Z: 0 };
  // from_chars(chars_format::general) prefix, plus the parser's explicit
  // single leading '+' skip. Longest-prefix semantics: "1e" matches "1" and
  // leaves the 'e' in the stream (which then fails as a lowercase command),
  // exactly like from_chars.
  const NUM = /^\+?-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
  let pos = 0;
  const isSep = (ch) => ch === ',' || /\s/.test(ch);
  const skipSeps = () => { while (pos < d.length && isSep(d[pos])) pos++; };
  let sawCommand = false;
  let sawPositioned = false;
  skipSeps();
  while (pos < d.length) {
    const cmd = d[pos++];
    if (!/[A-Za-z]/.test(cmd) || cmd !== cmd.toUpperCase()) {
      bad(path, 'only absolute SVG path commands are supported (engine path parser)');
      return;
    }
    if (!(cmd in ARITY)) {
      bad(path, `engine-unsupported path command ${JSON.stringify(cmd)} (only absolute M L H V C A Z)`);
      return;
    }
    sawCommand = true;
    if (cmd !== 'Z') sawPositioned = true;
    for (let i = 0; i < ARITY[cmd]; i++) {
      skipSeps();
      const m = NUM.exec(d.slice(pos));
      if (!m || !isFinite(parseFloat(m[0].replace(/^\+/, '')))) {
        bad(path, `path command ${cmd} has missing or malformed numeric argument`);
        return;
      }
      pos += m[0].length;
      skipSeps();
    }
    skipSeps();
  }
  if (!sawCommand) {
    bad(path, 'path must contain at least one command');
    return;
  }
  if (!sawPositioned) {
    bad(path, 'path must contain at least one positioned command');
  }
}

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
      // Full mirror of the engine's path parser (path_parser.cpp): command
      // whitelist, arity, number grammar (exponents, leading '+', leading
      // separators, non-M starts are ALL engine-accepted). A validator that
      // diverges either blesses a contract the engine rejects mid-job, or
      // falsely rejects one the engine prints fine.
      validatePathD(node.d, path + '.d');
      validatePaint(node.fill, path + '.fill');
      validateStroke(node.stroke, path + '.stroke');
      break;
    }
    case 'text': {
      if (!required(node, 'font', path, 'object')) break;
      required(node.font, 'family', path + '.font', 'string');
      if (!isPositiveNumber(node.font?.sizePx)) bad(path + '.font.sizePx', 'must be > 0');
      // Loader (contract_loader.cpp text branch): weight is a required int,
      // italic a required bool, color a required #rrggbb string;
      // underline/strikethrough are optional but must be bools when present.
      if (!isLoaderInt(node.font?.weight)) {
        bad(path + '.font.weight', 'engine requires an integer font weight');
      }
      if (typeof node.font?.italic !== 'boolean') {
        bad(path + '.font.italic', 'engine requires a boolean italic flag');
      }
      for (const k of ['underline', 'strikethrough']) {
        if (node.font && Object.prototype.hasOwnProperty.call(node.font, k) &&
            typeof node.font[k] !== 'boolean') {
          bad(`${path}.font.${k}`, 'must be a boolean when present');
        }
      }
      validateColor(node.font?.color, path + '.font.color');
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
        // Loader rejects merge/rich-only keys on static content (reject_key).
        for (const k of ['wrap', 'overflow', 'shrinkFloorPx', 'key', 'sample', 'maxLen']) {
          if (Object.prototype.hasOwnProperty.call(c, k)) {
            bad(`${path}.content.${k}`, 'field is not allowed on static content (engine rejects it)');
          }
        }
      } else if (c.type === 'rich') {
        // Loader rejects static/merge keys on rich content (reject_key).
        for (const k of ['lines', 'key', 'sample', 'maxLen', 'wrap', 'overflow', 'shrinkFloorPx']) {
          if (Object.prototype.hasOwnProperty.call(c, k)) {
            bad(`${path}.content.${k}`, 'field is not allowed on rich content (engine rejects it)');
          }
        }
        if (!Array.isArray(c.paragraphs) || c.paragraphs.length === 0) {
          bad(path + '.content.paragraphs', 'rich text must have at least one paragraph');
        } else {
          c.paragraphs.forEach((p, pi) => {
            const pp = `${path}.content.paragraphs[${pi}]`;
            if (!p || typeof p !== 'object') { bad(pp, 'not an object'); return; }
            // Loader read_rich_paragraphs: align is a REQUIRED enum string;
            // indentPx optional but must be a number >= 0 when present.
            if (!['left', 'center', 'right'].includes(p.align)) {
              bad(pp + '.align', `must be left|center|right, got ${JSON.stringify(p.align)}`);
            }
            if (Object.prototype.hasOwnProperty.call(p, 'indentPx') &&
                !(isFiniteNumber(p.indentPx) && p.indentPx >= 0)) {
              bad(pp + '.indentPx', 'must be a number >= 0 when present');
            }
            if (!Array.isArray(p.runs)) { bad(pp + '.runs', 'missing'); return; }
            p.runs.forEach((r, ri) => {
              const rp = `${pp}.runs[${ri}]`;
              if (!r || typeof r !== 'object') { bad(rp, 'not an object'); return; }
              if (typeof r.text !== 'string') bad(rp + '.text', 'must be a string');
              // Loader: every run REQUIRES fontFamily, sizePx > 0, integer
              // weight, italic/underline/strikethrough bools, #rrggbb color.
              if (typeof r.fontFamily !== 'string') bad(rp + '.fontFamily', 'must be a string');
              if (!isPositiveNumber(r.sizePx)) bad(rp + '.sizePx', 'must be > 0');
              if (!isLoaderInt(r.weight)) bad(rp + '.weight', 'engine requires an integer weight');
              for (const k of ['italic', 'underline', 'strikethrough']) {
                if (typeof r[k] !== 'boolean') bad(`${rp}.${k}`, 'engine requires a boolean');
              }
              validateColor(r.color, rp + '.color');
            });
          });
        }
      } else if (c.type === 'merge') {
        // Loader validate_text_content merge branch: key/sample/wrap/overflow
        // are required STRINGS, maxLen a required int >= 0, wrap/overflow
        // enums, shrinkFloorPx required-positive iff overflow == "shrink"
        // (and rejected otherwise).
        for (const k of ['key', 'sample', 'wrap', 'overflow']) {
          if (typeof c[k] !== 'string') {
            bad(`${path}.content.${k}`, 'merge content requires a string here');
          }
        }
        if (!isLoaderInt(c.maxLen) || c.maxLen < 0) {
          bad(`${path}.content.maxLen`, 'merge content requires a non-negative integer maxLen');
        }
        if (typeof c.wrap === 'string' && !['none', 'word'].includes(c.wrap)) {
          bad(`${path}.content.wrap`, `must be none|word, got ${JSON.stringify(c.wrap)}`);
        }
        if (typeof c.overflow === 'string' &&
            !['reject', 'clip', 'shrink'].includes(c.overflow)) {
          bad(`${path}.content.overflow`, `must be reject|clip|shrink, got ${JSON.stringify(c.overflow)}`);
        }
        if (c.overflow === 'shrink') {
          if (!isPositiveNumber(c.shrinkFloorPx)) {
            bad(`${path}.content.shrinkFloorPx`, 'overflow:"shrink" requires shrinkFloorPx > 0');
          }
        } else if (Object.prototype.hasOwnProperty.call(c, 'shrinkFloorPx')) {
          bad(`${path}.content.shrinkFloorPx`, 'only allowed with overflow:"shrink" (engine rejects it)');
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
      if (node.data.length === 0) {
        bad(path + '.data', 'base64 payload is empty');
      } else if (!isStrictBase64(node.data)) {
        bad(path + '.data', 'image data must be base64 (length % 4 == 0, [A-Za-z0-9+/] with at most two trailing =)');
      }
      if (node.aspect !== 'preserve' && node.aspect !== 'fill') {
        bad(path + '.aspect', `must be preserve|fill, got ${JSON.stringify(node.aspect)}`);
      }
      // Loader (contract_loader.cpp image branch): flipH/flipV are REQUIRED
      // bools — a contract without them is rejected at the engine boundary.
      for (const k of ['flipH', 'flipV']) {
        if (typeof node[k] !== 'boolean') {
          bad(`${path}.${k}`, 'engine requires a boolean here');
        }
      }
      break;
    }
    case 'svg': {
      if (!required(node, 'source', path, 'string')) break;
      if (!required(node, 'aspect', path, 'string')) break;
      if (node.source.length === 0) {
        bad(path + '.source', 'base64 svg source is empty');
      } else if (!isStrictBase64(node.source)) {
        bad(path + '.source', 'svg source must be base64 (length % 4 == 0, [A-Za-z0-9+/] with at most two trailing =)');
      }
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
      if (!bv || typeof bv !== 'object' || Array.isArray(bv)) {
        bad(path + '.value', 'barcode requires a value object');
      } else if (bv.type !== 'static' && bv.type !== 'merge') {
        bad(path + '.value.type', `must be static|merge, got ${JSON.stringify(bv.type)}`);
      } else if (bv.type === 'merge') {
        // Loader barcode merge branch: key/sample required strings, maxLen a
        // required int >= 0, errorOnUnencodable a required bool that must be
        // EXACTLY true ("barcode merge values must fail on unencodable data").
        for (const k of ['key', 'sample']) {
          if (typeof bv[k] !== 'string') {
            bad(`${path}.value.${k}`, 'barcode merge value requires a string here');
          }
        }
        if (!isLoaderInt(bv.maxLen) || bv.maxLen < 0) {
          bad(path + '.value.maxLen', 'barcode merge value requires a non-negative integer maxLen');
        }
        if (bv.errorOnUnencodable !== true) {
          bad(path + '.value.errorOnUnencodable',
            'engine requires errorOnUnencodable === true (barcode merge values must fail on unencodable data)');
        }
      } else {
        // static: loader requires value.data as a string.
        if (typeof bv.data !== 'string') {
          bad(path + '.value.data', 'barcode static value requires a string data field');
        }
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
    // Loader parse_paint solid branch: alpha is REQUIRED (require_number) and
    // must lie in [0,1]; an alpha-less solid paint is rejected by the engine.
    if (!(typeof paint.alpha === 'number' && isFinite(paint.alpha) &&
          paint.alpha >= 0 && paint.alpha <= 1)) {
      bad(path + '.alpha', 'solid paint requires alpha in [0,1] (engine require_number)');
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
      // Loader: a PRESENT alpha key must be a number 0..1 — alpha:null is a
      // present key whose value is not a number, which the engine rejects.
      if (stop && typeof stop === 'object' &&
          Object.prototype.hasOwnProperty.call(stop, 'alpha') &&
          !(typeof stop.alpha === 'number' && isFinite(stop.alpha) &&
            stop.alpha >= 0 && stop.alpha <= 1)) {
        bad(`${path}.stops[${i}].alpha`, 'alpha must be a number in [0,1] when present');
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
  // Loader read_optional_stroke: stroke.paint goes through require_object —
  // a null (or missing, or non-object) paint is rejected; "no stroke" is
  // expressed as stroke:null, never stroke:{paint:null,...}.
  if (!stroke.paint || typeof stroke.paint !== 'object' || Array.isArray(stroke.paint)) {
    bad(path + '.paint', 'stroke requires a paint OBJECT (engine rejects null here; omit the stroke instead)');
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
