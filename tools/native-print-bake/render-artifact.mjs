#!/usr/bin/env node
// render-artifact.mjs -- browser-free, end-to-end Native Print VERIFICATION GATE.
//
// Pipeline (zero browser, the production headless path):
//   .drawio file --bake.mjs (mode B)--> native print contract
//                --compose page SVG (verbatim contract nodes)-->
//                --PRODUCTION resvg cdylib (native-engine-render/rasterize)-->
//                --PNG artifact for object-by-object inspection
//
// WHY THIS IS "WHAT THE PRINTER RECEIVES":
//   The Win32 print host composites the engine RenderTrace into a device-DPI
//   bitmap and blits it 1:1 to the printer DC (win32_services.cpp print()).
//   For every `kind:"svg"` node (all styled shapes + ALL rich-text labels) the
//   host rasterizes the node's svg_source through this EXACT resvg cdylib. This
//   tool feeds the SAME bytes to the SAME cdylib, so those pixels ARE the
//   printer's pixels (rasterizer identity). `path`/`image` nodes carry explicit
//   geometry / encoded bytes the host fills via GDI+; resvg renders the same
//   geometry/bytes, faithful by construction.
//
//   This is NOT a pixel-comparison oracle: it never diffs against a reference
//   image. It (a) produces an artifact for human object-by-object inspection,
//   and (b) asserts every contract paint node renders to >0 opaque pixels --
//   the project's existing "no silent blank" posture, applied per object.
//
// Usage: node render-artifact.mjs <file.drawio> [dpi] [out.png]

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, resolve, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { bake } from './bake.mjs';

const execFileP = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const RASTERIZE = resolve(__dir, 'native-engine-render/rasterize');
const PX_PER_INCH = 96; // contract units:"px" -> 96 dpi base (units_per_inch)

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- map a contract solid/gradient paint to SVG fill attrs + optional <defs> ---
let gradSeq = 0;
function paintToSvg(paint, role, defs) {
  // role: 'fill' | 'stroke'
  if (!paint) return role === 'fill' ? `fill="none"` : '';
  if (paint.type === 'solid') {
    const a = paint.alpha == null ? 1 : paint.alpha;
    const op = a < 1 ? ` ${role}-opacity="${a}"` : '';
    return `${role}="${esc(paint.color)}"${op}`;
  }
  if (paint.type === 'gradient') {
    // Host fallback renders linear L->R / radial box-centered (GradientDirectionApprox).
    const id = `g${gradSeq++}`;
    const stops = (paint.stops && paint.stops.length)
      ? paint.stops
      : [{ offset: 0, color: paint.color, alpha: paint.alpha ?? 1 },
         { offset: 1, color: paint.gradColor ?? paint.color, alpha: paint.gradAlpha ?? 1 }];
    const stopsXml = stops.map((s) =>
      `<stop offset="${s.offset}" stop-color="${esc(s.color)}" stop-opacity="${s.alpha ?? 1}"/>`).join('');
    if (paint.radial) {
      defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stopsXml}</radialGradient>`);
    } else {
      defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stopsXml}</linearGradient>`);
    }
    return `${role}="url(#${id})"`;
  }
  return role === 'fill' ? `fill="none"` : '';
}

function nodeToSvg(node, defs) {
  if (node.kind === 'path') {
    const fill = paintToSvg(node.fill, 'fill', defs);
    let stroke = '';
    if (node.stroke) {
      const s = node.stroke;
      stroke = `${paintToSvg(s.paint, 'stroke', defs)} stroke-width="${s.width}" ` +
        `stroke-linecap="${s.cap || 'butt'}" stroke-linejoin="${s.join || 'miter'}" ` +
        `stroke-miterlimit="${s.miterLimit || 10}"`;
      if (s.dash && s.dash.length) stroke += ` stroke-dasharray="${s.dash.join(',')}"`;
    }
    return `<path d="${esc(node.d)}" ${fill} ${stroke || 'stroke="none"'}/>`;
  }
  const b = node.box;
  if (node.kind === 'svg') {
    const href = `data:image/svg+xml;base64,${node.source}`;
    // preserveAspectRatio="none": the node's svg intrinsic size == box, host
    // renders it into device_box (w x h); 1:1, so 'none' == exact placement.
    return `<image x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" ` +
      `preserveAspectRatio="none" xlink:href="${href}"/>`;
  }
  if (node.kind === 'image') {
    const mime = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg',
      gif: 'image/gif', svg: 'image/svg+xml' }[node.format] || 'image/png';
    const href = `data:${mime};base64,${node.data}`;
    const par = node.aspect === 'preserve' ? 'xMidYMid meet' : 'none';
    let tx = '', cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (node.flipH || node.flipV) {
      const sx = node.flipH ? -1 : 1, sy = node.flipV ? -1 : 1;
      tx = ` transform="translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})"`;
    }
    return `<image x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" ` +
      `preserveAspectRatio="${par}"${tx} xlink:href="${href}"/>`;
  }
  if (node.kind === 'text') {
    // Headless production path emits text as svg nodes; a bare text node would
    // only appear via variable-merge contracts. Render verbatim if present.
    return `<text x="${b.x}" y="${b.y + (node.font_size_px || 12)}" ` +
      `font-family="${esc(node.font_family || 'Helvetica, Arial, sans-serif')}" ` +
      `font-size="${node.font_size_px || 12}" fill="${esc((node.fill && node.fill.color) || '#000')}" ` +
      `xml:space="preserve">${esc(node.content && node.content.sample || node.label || '')}</text>`;
  }
  return '';
}

function composePageSvg(page) {
  const W = page.size.w, H = page.size.h;
  const defs = [];
  const body = page.paint.map((n) => nodeToSvg(n, defs)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>\n` +
    (defs.length ? `<defs>${defs.join('')}</defs>\n` : '') +
    body + `\n</svg>\n`;
}

// --- minimal PNG encoder (zlib is built into Node) -------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const cd = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cd), 0);
  return Buffer.concat([len, cd, crc]);
}
function encodePng(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))]);
}

async function rasterizeSvg(svgText, tw, th, dpi, tmp, tag) {
  const svgFile = join(tmp, `${tag}.svg`);
  const rawFile = join(tmp, `${tag}.rgba`);
  await writeFile(svgFile, svgText, 'utf8');
  const { stdout } = await execFileP(RASTERIZE, [svgFile, rawFile, String(tw), String(th), String(dpi)]);
  const [ow, oh] = stdout.trim().split(/\s+/).map(Number);
  const rgba = await readFile(rawFile);
  return { rgba, w: ow, h: oh };
}

function opaqueCount(rgba) {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) n++;
  return n;
}

// Arity-aware SVG-path bounding box for the per-object blank check. A naive
// even/odd split of all numbers is WRONG for arcs (`A rx ry rot f f x y`, where
// rx/ry/flags are NOT coordinates) and curves. We walk commands by arity and
// include Bézier control points (which bound the curve hull) plus the arc
// radii, so the box conservatively CONTAINS the rendered ink — it never clips a
// real shape into a false "blank". Contract paths are absolute, but relative
// commands are handled for safety.
function pathBBox(d) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = '';
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ext = (x, y) => {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    if (cmd === '' || i > toks.length) break;
    const rel = cmd >= 'a' && cmd <= 'z';
    const C = cmd.toUpperCase();
    const ax = (x) => (rel ? cx + x : x);
    const ay = (y) => (rel ? cy + y : y);
    if (C === 'M' || C === 'L' || C === 'T') {
      const x = ax(num()), y = ay(num()); cx = x; cy = y; ext(x, y);
      if (C === 'M') { sx = cx; sy = cy; cmd = rel ? 'l' : 'L'; } // extra pairs are lineto
    } else if (C === 'H') { const x = ax(num()); cx = x; ext(x, cy); }
    else if (C === 'V') { const y = ay(num()); cy = y; ext(cx, y); }
    else if (C === 'C') {
      ext(ax(num()), ay(num())); ext(ax(num()), ay(num()));
      const x = ax(num()), y = ay(num()); cx = x; cy = y; ext(x, y);
    } else if (C === 'S' || C === 'Q') {
      ext(ax(num()), ay(num()));
      const x = ax(num()), y = ay(num()); cx = x; cy = y; ext(x, y);
    } else if (C === 'A') {
      const rx = Math.abs(num()), ry = Math.abs(num()); num(); num(); num();
      const x = ax(num()), y = ay(num());
      // conservative: the arc lies within the union of endpoint boxes grown by r
      ext(cx - rx, cy - ry); ext(cx + rx, cy + ry);
      ext(x - rx, y - ry); ext(x + rx, y + ry);
      cx = x; cy = y;
    } else if (C === 'Z') { cx = sx; cy = sy; }
    else { i++; } // unknown token: skip defensively
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Programmatic entry point. Returns a structured result so the verification
// gate can be driven from a test (browser-free) as well as the CLI.
//   { ok, srcHash, lib, dpi, notices, blockingNotices, pages:[{pageOut,w,h,paint,checked,blanks}] }
export async function renderArtifact({ inputFile, dpi = 300, outPng, lib }) {
  lib = lib || process.env.SVG_RASTERIZER_LIB;
  if (!lib) throw new Error('SVG_RASTERIZER_LIB must point to libsvg_rasterizer.so');
  process.env.SVG_RASTERIZER_LIB = lib; // the rasterize CLI reads it from env
  outPng = outPng || inputFile.replace(/\.drawio$/, `.artifact-${dpi}dpi.png`);

  const xml = await readFile(inputFile, 'utf8');
  const srcHash = createHash('sha256').update(xml).digest('hex');
  const r = await bake(xml, { keepPx: true });
  const blockingNotices = (r.notices || []).filter((n) => n.severity !== 'info');

  const tmp = await mkdtemp(join(tmpdir(), 'np-artifact-'));
  try {
    const results = [];
    for (let pi = 0; pi < r.contract.document.pages.length; pi++) {
      const page = r.contract.document.pages[pi];
      const scale = dpi / PX_PER_INCH;
      const tw = Math.round(page.size.w * scale);
      const th = Math.round(page.size.h * scale);
      const svgText = composePageSvg(page);
      const { rgba, w, h } = await rasterizeSvg(svgText, tw, th, dpi, tmp, `page${pi}`);

      // Per-object "no silent blank" structural check (NOT a comparison oracle):
      // render each visible paint node alone and assert it produces opaque pixels.
      const blanks = [];
      let checked = 0;
      for (let ni = 0; ni < page.paint.length; ni++) {
        const node = page.paint[ni];
        const hasFill = node.fill && node.fill.type !== 'none';
        const hasStroke = !!node.stroke;
        let visible;
        if (node.kind === 'svg') {
          // An svg node is only EXPECTED to draw ink if its source actually
          // paints something: text with non-whitespace content, an <image>, or
          // a shape whose fill/stroke is not "none". drawio legitimately emits
          // fully-transparent layout rects (fill="none" stroke="none"); those
          // are not WYSIWYG violations -- the canvas shows nothing there either.
          const src = Buffer.from(node.source, 'base64').toString('utf8');
          const hasText = /<text[^>]*>[\s\S]*?\S[\s\S]*?<\/text>/.test(src);
          const hasImg = /<image\b/.test(src);
          const hasPaint = /(?:fill|stroke)\s*=\s*"(?!none")[^"]+"/.test(src) ||
            /(?:fill|stroke)\s*:\s*(?!none)[^;"]+/.test(src);
          visible = hasText || hasImg || hasPaint;
        } else {
          visible = node.kind === 'image' ||
            (node.kind === 'path' && (hasFill || hasStroke)) || node.kind === 'text';
        }
        if (!visible) continue;
        checked++;
        const defs = [];
        const inner = nodeToSvg(node, defs);
        // bounding box for the mini canvas
        let bx, by, bw, bh;
        if (node.box) { bx = node.box.x; by = node.box.y; bw = node.box.w; bh = node.box.h; }
        else {
          const b = pathBBox(node.d); // path: arity-aware bbox from d
          bx = b.x; by = b.y; bw = b.w; bh = b.h;
        }
        bw = Math.max(1, bw); bh = Math.max(1, bh);
        const mini = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
          `width="${bw}" height="${bh}" viewBox="${bx} ${by} ${bw} ${bh}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${inner}</svg>`;
        const mw = Math.max(1, Math.round(bw * scale)), mh = Math.max(1, Math.round(bh * scale));
        const { rgba: mrgba } = await rasterizeSvg(mini, mw, mh, dpi, tmp, `p${pi}n${ni}`);
        if (opaqueCount(mrgba) === 0) blanks.push({ ni, kind: node.kind });
      }

      const png = encodePng(rgba, w, h);
      const pageOut = r.contract.document.pages.length > 1
        ? outPng.replace(/\.png$/, `.page${pi}.png`) : outPng;
      await writeFile(pageOut, png);
      results.push({ pageOut, w, h, paint: page.paint.length, checked, blanks });
    }
    const totalBlanks = results.reduce((a, r2) => a + r2.blanks.length, 0);
    return {
      ok: blockingNotices.length === 0 && totalBlanks === 0,
      srcHash, lib, dpi, notices: r.notices || [], blockingNotices,
      pages: results, totalBlanks,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) { console.error('usage: render-artifact.mjs <file.drawio> [dpi] [out.png]'); process.exit(2); }
  const dpi = parseInt(process.argv[3] || '300', 10);
  const outPng = process.argv[4];
  let res;
  try {
    res = await renderArtifact({ inputFile, dpi, outPng });
  } catch (e) { console.error(String(e.message || e)); process.exit(3); }

  console.log(`\n=== Native Print verification artifact ===`);
  console.log(`source       : ${basename(inputFile)}`);
  console.log(`source sha256: ${res.srcHash}`);
  console.log(`rasterizer   : production resvg cdylib (${basename(res.lib)})`);
  console.log(`dpi          : ${res.dpi}`);
  console.log(`bake notices : ${res.notices.length} total, ${res.blockingNotices.length} blocking`);
  for (const n of res.blockingNotices) console.log(`  BLOCKING ${n.kind}: ${n.detail?.detail || ''}`);
  for (const p of res.pages) {
    console.log(`page -> ${basename(p.pageOut)}  ${p.w}x${p.h}px  ` +
      `${p.paint} paint nodes, ${p.checked} visible checked, ${p.blanks.length} silent-blank`);
    for (const b of p.blanks) console.log(`  SILENT BLANK: node#${b.ni} kind=${b.kind}`);
  }
  console.log(`\nRESULT: ${res.ok ? 'PASS — every object renders, zero blocking notices, zero silent blanks' : 'FAIL'}`);
  if (!res.ok) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
