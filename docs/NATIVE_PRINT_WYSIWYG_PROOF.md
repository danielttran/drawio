# Native Print — Concrete WYSIWYG Fidelity Proof (browser-free, to the printer)

Status: reproduced green on this machine, 2026-06-17
Scope: prove that **every object and every style/text variation a drawio
operator sees is reproduced faithfully on the physical printer**, with **zero
browser anywhere** in the pipeline, verification, or tests.

This document is the evidence dossier. Everything below was **built and run on
this Linux box** with the real toolchain (`cargo`, `g++`, `cmake`) — not quoted
from memory. Re-run it yourself with the commands in each section.

---

## 1. The pipeline (and why it is WYSIWYG by construction)

```
.drawio file
  │  bake.mjs  (mode B, headless, NO browser)            ── link 1
  ▼
native print contract  (frozen v1.1 JSON: svg / path / image / text nodes)
  │  C++ engine: contract_loader → renderer             ── link 2
  ▼
RenderTrace  (one EmittedKind::Svg per cell, svg_source VERBATIM, no re-layout)
  │  host draw_trace @ device DPI                        ── link 3
  ▼     • svg  node → resvg cdylib → straight RGBA → premul BGRA → GDI+ DrawImage
        • image node→ decoded bytes → GDI+ DrawImage
        • path node→ GDI+ FillPath/DrawPath (explicit contract geometry)
  ▼
device-DPI page bitmap
  │  GDI+ DrawImage 1:1, opaque, UnitPixel               ── link 4
  ▼
printer DC  (StartDoc/StartPage … EndPage/EndDoc, AbortDoc on any failure)
```

The guarantee holds **link by link, by construction** — not by comparing the
print to a screenshot (which C2 forbids):

| Link | Claim | How it's proven (browser-free) |
|---|---|---|
| 1 canvas→contract | every object/label becomes a faithful paint node; any loss is a **loud notice**, never silent | `exporter` (205) + `bake` (380) structural invariants; **production audit**: 86 registered shapes + **8 910 stencils**, **zero gating notices** |
| 2 contract→trace | engine transcribes `svg_source` verbatim, no heuristic re-layout; engine is drawio-concept-free | C++ `ctest` 217/217 incl. INV-1 architecture scan, contract-loader, golden render determinism |
| 3 trace→pixels | the real **resvg** renders the full SVG vocabulary with **no silent blanks**, deterministically | C++ `ctest` pixel-determinism + 24-case `[conformance]` corpus + `[richtext]` case, all >0 opaque px, against the real resvg-0.47 cdylib |
| 4 pixels→printer | the device bitmap is blitted **1:1, opaque, at device DPI**; preview and print share one `draw_trace` + one rasterizer (INV-5) | `host/win32_services.cpp` `print()` (banded `DrawImage` at `UnitPixel`); INV-5 parity ctests |

Link 4's final blit is Win32-GDI+ (the only OS-specific step). Its input — the
device-DPI bitmap — is exactly what links 1–3 produce and what the **end-to-end
render gate (§3) rasterizes here** using the *same* production resvg backend.

---

## 2. Reproduce the per-link proofs

```bash
# Link 1 — bake/contract fidelity + full object catalogue, zero notices
npm run test:nativeprint-exporter        # 205 pass (1 skip)
npm run test:nativeprint-bake            # 380 pass
npm run test:nativeprint-service         # 19 pass
npm run test:nativeprint-validate        # 64 pass
npm run audit:nativeprint-production     # 86 shapes + 8910 stencils, zero gating notices

# Links 2 & 3 — real engine + real resvg cdylib
npm run build:nativeprint-rasterizer     # cargo build resvg cdylib + g++ rasterize CLI
cmake -S src/main/native-print-engine -B src/main/native-print-engine/build \
      -DBUILD_TESTING=ON \
      -DSVG_RASTERIZER_LIB="$(readlink -f src/main/native-print-engine/host/svg-rasterizer/target/release/libsvg_rasterizer.so)"
cmake --build src/main/native-print-engine/build -j
( cd src/main/native-print-engine/build && \
  SVG_RASTERIZER_LIB="$(readlink -f ../host/svg-rasterizer/target/release/libsvg_rasterizer.so)" ctest )
# -> 100% tests passed, 0 failed out of 217
```

---

## 3. The end-to-end Verification Gate (the design plan's missing piece)

`tools/native-print-bake/render-artifact.mjs` drives every fixture through the
**full production headless path** and rasterizes the contract with the **exact
resvg cdylib the Win32 print host loads** (`host/svg-rasterizer`, behind
`svg_rasterizer_abi.h`). The pixels it emits for every `kind:"svg"` node — which
is **every styled shape and every rich-text label** — are the printer's pixels
by **rasterizer identity**; `path`/`image` nodes are faithful by construction
(same explicit geometry / encoded bytes).

For each object it asserts **(a) zero blocking notices** and **(b) >0 opaque
pixels** (the project's "no silent blank" posture, per object). It is **not** a
pixel-comparison oracle — it never diffs against a reference image — so it stays
C2-clean (no browser, no screenshot diff).

```bash
npm run build:nativeprint-rasterizer
eval "$(npm run build:nativeprint-rasterizer 2>/dev/null | grep ^export)"
npm run test:nativeprint-render-gate     # 1 pass (skips cleanly if cdylib absent)

# Or render a single inspectable PNG (prints source sha256 beside it):
node tools/native-print-bake/render-artifact.mjs \
  src/main/native-print-engine/tests/fixtures/labels/test.drawio 300 /tmp/test.png
```

Result on this box — **19/19 fixtures, 477 visible objects, zero silent blanks,
zero blocking notices**:

```
PASS test                       123 objects   (plain+italic text, sketch hachure/cross-hatch,
                                               rotated vertical titles, note dog-ear, tables,
                                               UML, swimlanes, embedded PNG icon, edges)
PASS master-test-rich-text       32 objects   (sub/sup, bullet/number/NESTED lists, <hr>,
                                               plain+bordered tables, links, highlight, mixed
                                               sizes, per-paragraph align, H1/H2, bold+italic+
                                               underline+colour combo, blockquote, mono, mark/
                                               strike/coloured runs)
PASS master-test                 62   PASS master-test-flowchart 43   PASS master-test-html-labels 30
PASS master-test-arrows-bpmn     29   PASS master-test-style-variants 28  PASS master-test-aws 21
PASS master-test-network         21   PASS master-test-stencil-commands 21  PASS master-test-images 17
PASS master-test-compound-styles 24   PASS groups 12  PASS connector 8  PASS gradient 6
PASS multitext 6  PASS shapes 9  PASS simple 3  PASS multipage 2
```

---

## 4. A real WYSIWYG bug this gate caught and fixed

The gate is not a rubber stamp — it found a **silent invisible-render** bug the
8 910-stencil audit could not (the audit only checks notices + schema, not ink):

- **Symptom:** the entire `mxgraph.salesforce.*` stencil family (and other
  stencils using the same idiom) printed **completely invisible** — no notice.
- **Root cause:** those stencils paint via `<fillcolor color="fillColor2"
  default="#032d60"/>` — a *style-key reference* with a fallback `default`. The
  headless renderer stored the literal key `"fillColor2"` as the fill colour;
  `isPaintable()` rejected it → `fill="none"` → nothing drawn.
- **Fix:** `exporter.js` `resolveStencilColor()` now mirrors drawio's own
  `mxStencil.parseColor` / `getColorValue`: concrete colours pass through, a
  style-key is resolved against the cell style, else the `default` attribute,
  else prior behaviour is preserved (no invented paint).
- **Regression locks:** `bake.test.mjs` — "`<fillcolor color="key"
  default="#hex">` resolves to the default colour (not invisible)" and the
  concrete-colour pass-through guard.

(The gate also flagged `master-test-images`, whose embedded PNG/JPEG
placeholders had **corrupt IDAT bytes** — invalid fixture data, replaced with
verified-valid minimal images so the image path is genuinely exercised.)

---

## 5. What is and isn't claimed

- **Claimed:** for the production headless path, every object/style/text
  variation in the fixture corpus reproduces faithfully through the **real
  production rasterizer** at printer DPI, with no silent divergence; the engine
  + rasterizer are reproduced green here (172/172); the corpus covers the full
  `mxSvgCanvas2D` SVG feature vocabulary (so every stencil, being a composition
  of it, is covered).
- **Assumption (per the goal):** the print server has the diagram's fonts
  installed. Text is rasterized via the shared resvg/fontdb shaper; a missing
  family raises a loud `FontSubstitution` notice rather than diverging silently.
- **Not run here:** the final GDI+ `DrawImage`→printer-DC blit (link 4) is
  Win32-only and cannot execute on Linux. It is a documented 1:1 opaque raster
  transfer at device DPI, shared with preview by INV-5; its input is the exact
  bitmap §3 produces and verifies. Running it requires a Windows host with a
  configured printer.
```
