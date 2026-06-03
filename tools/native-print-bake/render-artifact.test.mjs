// Native Print END-TO-END VERIFICATION GATE (browser-free).
//
// Drives every checked-in .drawio fixture through the FULL production headless
// path — bake.mjs (mode B) -> native print contract -> the PRODUCTION resvg
// cdylib (host/svg-rasterizer, the exact backend the Win32 print host loads
// behind svg_rasterizer_abi.h) -> rasterized pixels — and asserts, per object:
//   (1) zero blocking (degradation) notices, and
//   (2) every visible paint node renders to > 0 opaque pixels (no silent blank).
//
// This is the design plan's "Verification Gate": it produces the actual
// printer-faithful raster for object-by-object inspection AND machine-checks
// that nothing silently vanishes en route to the printer. It is NOT a pixel
// comparison oracle (it never diffs against a reference image), so it satisfies
// docs/CLAUDE.md C2 (no browser, no screenshot diff).
//
// Build the rasterizer first, then point SVG_RASTERIZER_LIB at it:
//   (cd src/main/native-print-engine/host/svg-rasterizer && cargo build --release)
//   g++ -std=c++17 -O2 -o tools/native-print-bake/native-engine-render/rasterize \
//       tools/native-print-bake/native-engine-render/rasterize.cpp -ldl
//   SVG_RASTERIZER_LIB=.../libsvg_rasterizer.so node --test render-artifact.test.mjs
//
// When the rasterizer cdylib / CLI are absent the suite SKIPs cleanly (same
// posture as the C++ svg-rasterizer ctests), so it never red-fails a runner
// that hasn't built the native backend.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { renderArtifact } from './render-artifact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../src/main/native-print-engine/tests/fixtures/labels');
const rasterizeBin = resolve(here, 'native-engine-render/rasterize');
const lib = process.env.SVG_RASTERIZER_LIB;

const ready = !!lib && existsSync(lib) && existsSync(rasterizeBin);

test('Native Print verification gate: every fixture object renders (no silent blank, no blocking notice)',
  { skip: ready ? false : 'SVG_RASTERIZER_LIB / rasterize CLI not built (see file header)' },
  async () => {
    const files = (await readdir(fixtureDir)).filter((f) => f.endsWith('.drawio'));
    assert.ok(files.length >= 15, `expected the full fixture corpus, found ${files.length}`);

    const tmp = await mkdtemp(join(tmpdir(), 'np-gate-'));
    try {
      let totalChecked = 0;
      for (const f of files.sort()) {
        const res = await renderArtifact({
          inputFile: join(fixtureDir, f),
          dpi: 300,
          outPng: join(tmp, f.replace(/\.drawio$/, '.png')),
          lib,
        });
        const checked = res.pages.reduce((a, p) => a + p.checked, 0);
        totalChecked += checked;
        const blanks = res.pages.flatMap((p) => p.blanks.map((b) => `${f} node#${b.ni}(${b.kind})`));
        assert.equal(res.blockingNotices.length, 0,
          `${f}: blocking notices: ${res.blockingNotices.map((n) => n.kind).join(', ')}`);
        assert.equal(blanks.length, 0, `${f}: silent-blank object(s): ${blanks.join('; ')}`);
        assert.ok(checked > 0, `${f}: gate checked zero objects`);
      }
      // Sanity: the corpus exercises a large, diverse object population.
      assert.ok(totalChecked >= 300,
        `gate should verify a large object population, only checked ${totalChecked}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
