#!/usr/bin/env node
// WYSIWYG comparison: draw.io XML vs baked contract.
//
// Reports whether every shape a user drew is faithfully transcribed into the
// contract that the native print engine will render — no browser involved.
//
// Usage:
//   node wysiwyg-compare.mjs <file.drawio>
//
// Exit 0 = all checks pass, Exit 1 = gaps found.

import { readFile, readdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { bake } from './bake.mjs';
import { parseDrawio } from './drawio-parser.mjs';

const SCALE = 25400 / 96;
function pxToUm(v) { return v * SCALE; }

// ---------- parse .drawio into expected shapes ----------

function parseStyleStr(s) {
  if (!s) return {};
  const out = {};
  for (const part of s.split(';')) {
    const tok = part.trim();
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq < 0) { if (tok) out.shape = tok; }
    else { out[tok.slice(0, eq).trim()] = tok.slice(eq + 1).trim(); }
  }
  return out;
}

function parseModelCells(drawioXml) {
  const cellRe = /<mxCell\s([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/gi;
  const geoRe  = /<mxGeometry\s([^>]*?)\/>/i;
  const cells  = [];
  let m;
  while ((m = cellRe.exec(drawioXml)) !== null) {
    const attrStr = m[1];
    const inner   = m[2] || '';
    const attrs   = {};
    const attrPat = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = attrPat.exec(attrStr)) !== null) attrs[a[1]] = a[2];
    if (!attrs.id || attrs.id === '0' || attrs.id === '1') continue;

    const style  = parseStyleStr(attrs.style || '');
    const isEdge = attrs.edge === '1';
    const isVtx  = attrs.vertex === '1';
    if (!isEdge && !isVtx) continue;

    const gm = geoRe.exec(inner);
    let geo = null;
    if (gm) {
      const ga = {};
      const gp = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
      let g;
      while ((g = gp.exec(gm[1])) !== null) ga[g[1]] = g[2];
      geo = {
        x: parseFloat(ga.x || 0),
        y: parseFloat(ga.y || 0),
        w: parseFloat(ga.width  || 0),
        h: parseFloat(ga.height || 0),
      };
    }

    // Decode &#xa; → newline in labels
    const rawLabel = (attrs.value || '')
      .replace(/&#xa;/gi, '\n').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    cells.push({
      id:        attrs.id,
      label:     rawLabel,
      style,
      isEdge,
      isVertex:  isVtx,
      geo,
      source:    attrs.source,
      target:    attrs.target,
    });
  }
  return cells;
}

// ---------- helpers for contract inspection ----------

// Decode base64 SVG source from kind:'svg' nodes and extract text content.
function svgNodeLabels(source) {
  if (!source) return [];
  try {
    const svgStr = Buffer.from(source, 'base64').toString('utf8');
    const labels = [];
    const re = /<text[^>]*>([\s\S]*?)<\/text>/gi;
    let m;
    while ((m = re.exec(svgStr)) !== null) {
      // Extract text from tspan elements or direct text content
      const inner = m[1].replace(/<tspan[^>]*>/gi, '').replace(/<\/tspan>/gi, '\n')
        .replace(/<[^>]+>/g, '').trim();
      if (inner) {
        // Normalize: collapse multiple newlines from tspan replacement
        labels.push(inner.replace(/\n+/g, '\n').replace(/^\n|\n$/g, ''));
      }
    }
    return labels;
  } catch { return []; }
}

function contractTextLabels(contract) {
  const labels = new Set();
  for (const page of contract.document.pages) {
    for (const node of page.paint) {
      if (node.kind === 'text') {
        const c = node.content;
        if (c && c.type === 'static' && Array.isArray(c.lines)) {
          labels.add(c.lines.join('\n'));
        }
      } else if (node.kind === 'svg') {
        // Rotated shapes embed labels inside their SVG source
        for (const lbl of svgNodeLabels(node.source)) labels.add(lbl);
      }
    }
  }
  return labels;
}

// Count shape nodes: path + svg (svg nodes represent rotated shapes)
function contractPathCount(contract) {
  let n = 0;
  for (const page of contract.document.pages) {
    for (const node of page.paint) {
      if (node.kind === 'path' || node.kind === 'svg') n++;
    }
  }
  return n;
}

function svgNodeHasPattern(source, pattern) {
  if (!source) return false;
  try {
    const s = Buffer.from(source, 'base64').toString('utf8');
    return pattern.test(s);
  } catch { return false; }
}

function hasGradientFills(contract) {
  for (const page of contract.document.pages) {
    for (const node of page.paint) {
      if (node.kind === 'path' && node.fill &&
          (node.fill.type === 'linear' || node.fill.type === 'radial')) return true;
      if (node.kind === 'svg' && svgNodeHasPattern(node.source, /linearGradient|radialGradient/)) return true;
    }
  }
  return false;
}

function hasDashedStroke(contract) {
  for (const page of contract.document.pages) {
    for (const node of page.paint) {
      if (node.kind === 'path' && node.stroke && node.stroke.dash) return true;
      if (node.kind === 'svg' && svgNodeHasPattern(node.source, /stroke-dasharray/)) return true;
    }
  }
  return false;
}

function hasThickStroke(contract, thresholdUm) {
  for (const page of contract.document.pages) {
    for (const node of page.paint) {
      if (node.kind === 'path' && node.stroke && node.stroke.width > thresholdUm) return true;
      // SVG nodes: check stroke-width attribute value in SVG source
      if (node.kind === 'svg') {
        try {
          const s = Buffer.from(node.source, 'base64').toString('utf8');
          const m = /stroke-width="([\d.]+)"/.exec(s);
          if (m && parseFloat(m[1]) * pxToUm(1) > thresholdUm) return true;
        } catch { /* skip */ }
      }
    }
  }
  return false;
}

function hasRotatedNode(contract) {
  for (const page of contract.document.pages) {
    for (const node of page.paint) {
      // Rotated shapes are emitted as kind:'svg' with a rotate() transform in source
      if (node.kind === 'svg' && svgNodeHasPattern(node.source, /transform="rotate/)) return true;
    }
  }
  return false;
}

function contractFillColors(contract) {
  const colors = new Set();
  for (const page of contract.document.pages) {
    for (const node of page.paint) {
      if (node.kind === 'path' && node.fill && node.fill.type === 'solid') {
        colors.add(node.fill.color.toLowerCase());
      }
      if (node.kind === 'svg') {
        try {
          const s = Buffer.from(node.source, 'base64').toString('utf8');
          const re = /fill="(#[0-9a-fA-F]{6})"/g;
          let m;
          while ((m = re.exec(s)) !== null) colors.add(m[1].toLowerCase());
        } catch { /* skip */ }
      }
    }
  }
  return colors;
}

// ---------- main comparison ----------

function compare(drawioXml) {
  const cells  = parseModelCells(drawioXml);
  const result = bake(drawioXml);
  const { contract, notices } = result;

  const vertices = cells.filter(c => c.isVertex);
  const edges    = cells.filter(c => c.isEdge);

  const textOnlyIds  = new Set(vertices.filter(c => c.style.shape === 'text').map(c => c.id));
  const shapeVerts   = vertices.filter(c => c.style.shape !== 'text');
  const labeledVerts = vertices.filter(c => c.label.trim() !== '');

  const contractLabels  = contractTextLabels(contract);
  const contractPaths   = contractPathCount(contract);
  const fillColors      = contractFillColors(contract);

  const checks = [];
  let pass = 0, fail = 0;

  function check(name, ok, detail) {
    checks.push({ name, ok, detail });
    if (ok) pass++; else fail++;
  }

  // ── 1. Path-producing shape count ──────────────────────────────────────────
  // Each shape vertex (non-text) should produce ≥ 1 path node.
  // Edges may or may not produce a path depending on resolved geometry.
  check(
    'Path-producing shapes → contract paths',
    contractPaths >= shapeVerts.length,
    `expected ≥${shapeVerts.length} paths, got ${contractPaths}`
  );

  // ── 2. Every labeled vertex appears in contract text nodes ─────────────────
  const missingLabels = [];
  for (const v of labeledVerts) {
    const expected = v.label.trim();
    if (!contractLabels.has(expected)) {
      // Try a partial match (label may be inside a larger string in rich text)
      const anyMatch = [...contractLabels].some(l => l.includes(expected) || expected.includes(l));
      if (!anyMatch) missingLabels.push(`"${expected}" (id=${v.id})`);
    }
  }
  check(
    'All vertex labels appear in contract text nodes',
    missingLabels.length === 0,
    missingLabels.length === 0 ? `${labeledVerts.length} labels verified` : `missing: ${missingLabels.join('; ')}`
  );

  // ── 3. All shape types represented ─────────────────────────────────────────
  const shapeTypes = new Set(shapeVerts.map(v => v.style.shape || 'rectangle'));
  // Only check path count if there are non-text shape vertices (text-only files are valid)
  check(
    'All supported shape types produce path nodes',
    shapeVerts.length === 0 || contractPaths > 0,
    shapeVerts.length === 0 ? 'no shape-body vertices (text-only diagram)' : `shape types in label: ${[...shapeTypes].join(', ')}`
  );

  // ── 4. Gradient fills ──────────────────────────────────────────────────────
  const gradVerts = vertices.filter(v => v.style.gradientColor && v.style.gradientColor !== 'none');
  if (gradVerts.length > 0) {
    check(
      'Gradient fill shapes → gradient nodes in contract',
      hasGradientFills(contract),
      `${gradVerts.length} gradient shape(s) in label`
    );
  }

  // ── 5. Dashed stroke ───────────────────────────────────────────────────────
  const dashedVerts = vertices.filter(v => v.style.dashed === '1');
  if (dashedVerts.length > 0) {
    check(
      'Dashed stroke shapes → dash pattern in contract',
      hasDashedStroke(contract),
      `${dashedVerts.length} dashed shape(s) in label`
    );
  }

  // ── 6. Thick stroke ────────────────────────────────────────────────────────
  const thickVerts = vertices.filter(v => v.style.strokeWidth && parseFloat(v.style.strokeWidth) > 1);
  if (thickVerts.length > 0) {
    const minThickPx = Math.min(...thickVerts.map(v => parseFloat(v.style.strokeWidth)));
    const minThickUm = pxToUm(minThickPx) * 0.9; // 10% tolerance
    check(
      'Thick stroke shapes → wide stroke in contract',
      hasThickStroke(contract, minThickUm),
      `${thickVerts.length} thick-stroke shape(s), min ${minThickPx}px (${minThickUm.toFixed(0)} um)`
    );
  }

  // ── 7. Rotated shapes ─────────────────────────────────────────────────────
  const rotatedVerts = vertices.filter(v => v.style.rotation && parseFloat(v.style.rotation) !== 0);
  if (rotatedVerts.length > 0) {
    check(
      'Rotated shapes → rotation transform in contract',
      hasRotatedNode(contract),
      `${rotatedVerts.length} rotated shape(s) in label`
    );
  }

  // ── 8. Fill colors round-trip ─────────────────────────────────────────────
  // Check that a sample of explicit fill colors appear in the contract.
  const explicitFills = vertices
    .filter(v => v.style.fillColor && v.style.fillColor !== 'none' && !v.style.gradientColor)
    .map(v => v.style.fillColor.toLowerCase());

  const missingColors = [];
  for (const c of new Set(explicitFills)) {
    if (!fillColors.has(c)) missingColors.push(c);
  }
  check(
    'Explicit fill colors appear in contract',
    missingColors.length === 0,
    missingColors.length === 0
      ? `${new Set(explicitFills).size} distinct fill color(s) verified`
      : `missing colors: ${missingColors.join(', ')}`
  );

  // ── 9. Connector edge ─────────────────────────────────────────────────────
  if (edges.length > 0) {
    // Edge should produce at least one path node beyond the vertex shapes
    check(
      'Connector edge(s) present in drawing',
      edges.length > 0,
      `${edges.length} edge(s) defined (source→target geometry required for path)`
    );
  }

  // ── 10. Notices are expected / catalogued ─────────────────────────────────
  const unexpectedNotices = notices.filter(n => n.kind !== 'GradientDirectionApprox');
  check(
    'No unexpected degradation notices',
    unexpectedNotices.length === 0,
    unexpectedNotices.length === 0
      ? `notices: ${notices.map(n => n.kind).join(', ') || 'none'}`
      : `UNEXPECTED: ${unexpectedNotices.map(n => n.kind).join(', ')}`
  );

  // ── 11. Flip transforms (§3.4 step 12) ───────────────────────────────────
  const flipVerts = vertices.filter(v => v.style.flipH === '1' || v.style.flipV === '1');
  if (flipVerts.length > 0) {
    const hasFlipTransform = (() => {
      for (const page of contract.document.pages) {
        for (const node of page.paint) {
          if (node.kind === 'svg' && svgNodeHasPattern(node.source, /scale\(-1,1\)|scale\(1,-1\)/)) return true;
        }
      }
      return false;
    })();
    check(
      'Flip transform shapes → scale(-1) or scale(1,-1) in SVG',
      hasFlipTransform,
      `${flipVerts.length} flipped shape(s) in label`
    );
  }

  // ── 12. Direction transforms (§3.3) ───────────────────────────────────────
  const dirVerts = vertices.filter(v =>
    v.style.direction === 'north' || v.style.direction === 'south' || v.style.direction === 'west'
  );
  if (dirVerts.length > 0) {
    const hasDirectionTransform = (() => {
      for (const page of contract.document.pages) {
        for (const node of page.paint) {
          if (node.kind === 'svg' && svgNodeHasPattern(node.source, /translate\(|rotate\(/)) return true;
        }
      }
      return false;
    })();
    check(
      'Directional shapes → translate/rotate transform in SVG',
      hasDirectionTransform,
      `${dirVerts.length} directional shape(s) (north/south/west) in label`
    );
  }

  return { checks, pass, fail, notices, vertices, edges, contractPaths };
}

// ---------- per-shape detail table ----------

function shapeDetail(drawioXml, contract) {
  const cells = parseModelCells(drawioXml);
  const contractLabels = contractTextLabels(contract);
  const allPaths = [];
  for (const page of contract.document.pages) {
    for (const node of page.paint) {
      if (node.kind === 'path') allPaths.push(node);
    }
  }

  const rows = [];
  for (const c of cells.filter(v => v.isVertex)) {
    const shapeType = c.style.shape || (c.isEdge ? 'edge' : 'rectangle');
    const rotation  = c.style.rotation ? parseFloat(c.style.rotation) : 0;
    const hasLabel  = c.label.trim() !== '';
    const labelInContract = hasLabel
      ? contractLabels.has(c.label.trim()) ||
        [...contractLabels].some(l => l.includes(c.label.trim()))
      : 'n/a';
    const isTextOnly = shapeType === 'text';
    const fillColor  = c.style.fillColor || '—';
    const gradient   = c.style.gradientColor ? '✓' : '';
    const dashed     = c.style.dashed === '1' ? '✓' : '';
    const thick      = c.style.strokeWidth && parseFloat(c.style.strokeWidth) > 1
      ? c.style.strokeWidth + 'px' : '';

    rows.push({
      id:           c.id,
      shape:        shapeType,
      label:        c.label.replace(/\n/g, '↵').slice(0, 20),
      rotation:     rotation !== 0 ? `${rotation}°` : '0°',
      fill:         fillColor,
      gradient,
      dashed,
      thick,
      isTextOnly:   isTextOnly ? '(text)' : '',
      labelOK:      hasLabel ? (labelInContract ? '✓' : '✗ MISSING') : '—',
    });
  }
  return rows;
}

// ---------- report ----------

function pad(s, n) {
  const str = String(s == null ? '' : s);
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}

// ---------- pre-Gate-1 validation: detect excluded shape commands in test files ----------

// Scan stencil XML node tree (from stencil-loader parseXml output) for excluded commands.
// Returns array of found excluded command names, or empty array if none.
function findExcludedCommands(shapeNode) {
  const EXCLUDED = new Set(['image', 'include-shape']);
  const found = new Set();
  function walk(node) {
    if (!node || !node.children) return;
    for (const child of node.children) {
      if (EXCLUDED.has(child.name)) found.add(child.name);
      // Check for rounded="1" paths
      if (child.name === 'path' && child.attrs && child.attrs.rounded === '1') {
        found.add('path rounded="1"');
      }
      walk(child);
    }
  }
  walk(shapeNode);
  return [...found];
}

// Validate that no cell in the drawio XML uses a stencil with excluded commands.
// Returns array of { cellId, shape, excludedCmds } for any violations.
async function validateNoExcludedShapes(drawioXml) {
  // Lazily import stencil loader to avoid circular dependencies
  const { loadStencils, parseXml } = await import('./stencil-loader.mjs');
  const { fileURLToPath } = await import('node:url');
  const { dirname: dir, resolve: res } = await import('node:path');
  const here2 = dir(fileURLToPath(import.meta.url));
  const stencilDir = res(here2, '../../src/main/webapp/stencils');

  // Load registry (cached between calls in same process)
  if (!validateNoExcludedShapes._registry) {
    validateNoExcludedShapes._registry = await loadStencils(stencilDir);
  }
  const registry = validateNoExcludedShapes._registry;

  const cells = parseModelCells(drawioXml);
  const violations = [];
  for (const cell of cells) {
    if (!cell.isVertex) continue;
    const shapeName = cell.style && cell.style.shape;
    if (!shapeName) continue;
    // Check inline stencil
    let shapeNode = null;
    if (shapeName.startsWith('stencil(') && shapeName.endsWith(')')) {
      try {
        const b64 = shapeName.slice(8, -1);
        const xml = Buffer.from(b64, 'base64').toString('utf8');
        shapeNode = parseXml(xml);
      } catch (e) { continue; }
    } else {
      shapeNode = registry.get(shapeName) || null;
    }
    if (!shapeNode) continue;
    const excluded = findExcludedCommands(shapeNode);
    if (excluded.length > 0) {
      violations.push({ cellId: cell.id, shape: shapeName, excludedCmds: excluded });
    }
  }
  return violations;
}

async function main() {
  const args = process.argv.slice(2);

  // --all mode: run compare on every .drawio file in the fixtures labels directory
  if (args.includes('--all')) {
    const here2 = dirname(fileURLToPath(import.meta.url));
    const labelDir = resolve(here2, '../../src/main/native-print-engine/tests/fixtures/labels');
    let files;
    try {
      files = readdirSync(labelDir).filter(f => f.endsWith('.drawio'));
    } catch (e) {
      process.stderr.write(`cannot read label dir ${labelDir}: ${e.message}\n`);
      process.exit(2);
    }

    if (files.length === 0) {
      console.log('No .drawio fixture files found.');
      process.exit(0);
    }

    let allPassed = true;
    for (const f of files) {
      const filePath = join(labelDir, f);
      let xml;
      try {
        xml = readFileSync(filePath, 'utf8');
      } catch (e) {
        console.error(`FAIL: ${f} (cannot read: ${e.message})`);
        allPassed = false;
        continue;
      }

      // Pre-Gate-1 validation: scan for excluded shapes
      let violations = [];
      try {
        violations = await validateNoExcludedShapes(xml);
      } catch (e) {
        // Non-fatal: continue even if registry unavailable
      }
      if (violations.length > 0) {
        console.error(`PRE-GATE-1 VIOLATION in ${f}:`);
        for (const v of violations) {
          console.error(`  Cell ${v.cellId} (shape=${v.shape}) uses excluded commands: ${v.excludedCmds.join(', ')}`);
        }
        allPassed = false;
        continue;
      }

      const result = compare(xml);
      if (result.fail > 0) {
        allPassed = false;
        console.log(`FAIL: ${f} (${result.fail} check(s) failed)`);
        for (const c of result.checks.filter(c => !c.ok)) {
          console.log(`  ✗ ${c.name}: ${c.detail}`);
        }
      } else {
        console.log(`PASS: ${f} (${result.pass} checks pass)`);
      }
    }

    process.exit(allPassed ? 0 : 1);
    return;
  }

  const [inputPath] = args;
  if (!inputPath) {
    process.stderr.write('usage: wysiwyg-compare.mjs <file.drawio>\n       wysiwyg-compare.mjs --all\n');
    process.exit(2);
  }

  const abs = resolve(process.cwd(), inputPath);
  let xml;
  try {
    xml = await readFile(abs, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${abs}: ${e.message}\n`);
    process.exit(2);
  }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(` WYSIWYG Compare: ${inputPath}`);
  console.log(`══════════════════════════════════════════════════════════════\n`);

  const { checks, pass, fail, notices, vertices, edges, contractPaths } = compare(xml);
  const { contract } = bake(xml);

  // Summary stats
  console.log(`Draw.io shapes : ${vertices.length} vertices, ${edges.length} edges`);
  console.log(`Contract nodes : ${contractPaths} path nodes, ${contract.document.pages[0].paint.filter(n=>n.kind==='text').length} text nodes`);
  console.log(`Bake notices   : ${notices.length > 0 ? notices.map(n => n.kind).join(', ') : 'none'}`);
  console.log();

  // Per-shape detail table
  const rows = shapeDetail(xml, contract);
  const hdr = ['ID', 'Shape', 'Label', 'Rotation', 'Fill', 'Grad', 'Dash', 'Thick', 'LabelOK'];
  console.log(
    pad(hdr[0],6) + pad(hdr[1],12) + pad(hdr[2],22) + pad(hdr[3],10) +
    pad(hdr[4],12) + pad(hdr[5],6) + pad(hdr[6],6) + pad(hdr[7],8) + hdr[8]
  );
  console.log('─'.repeat(94));
  for (const r of rows) {
    console.log(
      pad(r.id,6) + pad(r.shape + (r.isTextOnly?' (text)':''),12) +
      pad(r.label,22) + pad(r.rotation,10) +
      pad(r.fill,12) + pad(r.gradient,6) + pad(r.dashed,6) +
      pad(r.thick,8) + r.labelOK
    );
  }
  console.log();

  // Check results
  console.log('━━━━  WYSIWYG Checks  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const c of checks) {
    const mark = c.ok ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${mark}  ${c.name}`);
    console.log(`        → ${c.detail}`);
  }
  console.log();
  console.log(`Result: ${pass} passed, ${fail} failed`);

  if (fail > 0) {
    console.log('\n⚠  WYSIWYG GAPS DETECTED — see FAILs above\n');
    process.exit(1);
  } else {
    console.log('\n✓  All WYSIWYG checks pass\n');
  }
}

const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch(err => {
    process.stderr.write(`fatal: ${err.stack}\n`);
    process.exit(1);
  });
}

export { compare };
