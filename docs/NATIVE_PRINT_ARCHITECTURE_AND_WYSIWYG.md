# Native Print — How It Works, How It's Built, and How WYSIWYG Is Proven

> Audience: engineers and reviewers of the draw.io **native (browser‑free) print**
> path. This is the end‑to‑end reference. Companion docs:
> `docs/NATIVE_PRINT_WYSIWYG_PROOF.md` (the per‑link proof you can reproduce),
> `docs/WYSIWYG_ASSURANCE_CASE.md` (the structured assurance argument), and the
> non‑negotiable constraints in `docs/CLAUDE.md` → *"Native Print — NON‑NEGOTIABLE
> CONSTRAINTS"*.

---

## 0. TL;DR

A drawing is printed by turning it into a **frozen JSON contract** of primitive
paint nodes (`path` / `svg` / `image`) entirely **without a browser**, then a
small **C++ engine** transcribes that contract verbatim to a device bitmap (text
and vector artwork rasterized by the real **resvg** renderer), which the Win32
host blits **1:1, opaque, at device DPI** to the printer.

WYSIWYG ("what the operator sees in draw.io is what the printer produces") is a
**hard requirement** and holds **by construction**: every object is either
rendered faithfully **or** a **loud `Degradation` notice** says exactly why not.
There is **never a silent divergence**. The guarantee is enforced by structural
invariants in a browser‑free test harness, not by pixel comparison (a pixel
oracle is explicitly forbidden — see §1).

---

## 1. Ground rules (the non‑negotiable constraints)

These are settled business requirements (`docs/CLAUDE.md`,
`src/main/webapp/plugins/nativeprint/CLAUDE.md`). Everything below is designed
around them:

1. **WYSIWYG is mandatory.** Faithful render **or** a loud notice — never a
   silent divergence/approximation.
2. **No browser anywhere** — not even headless. Forbidden for the guarantee or
   any test: headless Chromium/Playwright/Puppeteer/Selenium/Electron, `jsdom`,
   and in‑app pixel oracles (`getImageData`, rasterizing `getSvg()`, screenshot
   diff). *Owner carve‑out:* a canvas may be used **only** to embed external
   image artwork as a data URI so it prints faithfully — not to build a
   verification oracle.
3. **Guarantee by construction, verified browser‑free.** The bake re‑derives
   every object from its stencil/style geometry headlessly; there is no live‑DOM
   transcription path.
4. **Frozen engine/contract boundary.** The engine contains zero drawio/mxGraph
   concepts (enforced by `INV‑1`); contract‑schema changes require an explicit
   owner decision.
5. **No silent heuristic fallbacks.** Last‑resort approximations
   (`shapePath`, `plainLabel` flattening, `edgeLabelBox`) must be loudly noticed
   wherever they would diverge from drawio.

The corollary used throughout this document: **a WYSIWYG defect is, precisely, a
*silent* divergence** — output that differs from the drawio canvas with **no**
`Degradation`/notice. A faithful render is correct; a divergence *with* a loud
notice is acceptable‑by‑policy; a *silent* divergence is the only failure class.

---

## 2. How native print works (the pipeline)

```
 .drawio XML
     │   (1) HEADLESS BAKE  — no browser
     ▼
 tools/native-print-bake/*.mjs  +  src/main/webapp/plugins/nativeprint/exporter.js  +  svg-shim
     │        parse → resolve styles/placeholders → re-derive each object →
     │        emit primitive paint nodes (or a loud notice)
     ▼
 FROZEN JSON CONTRACT  (schema 1.1)   — pages[] of paint nodes: path | svg | image
     │   (2) ENGINE
     ▼
 src/main/native-print-engine/  (contract_loader → renderer → RenderTrace)
     │        validate strictly → transcribe verbatim to ops, no re-layout
     ▼
 RenderTrace (device-independent draw ops)
     │   (3) RASTERIZE / HOST
     ▼
 Rust resvg cdylib (host/svg-rasterizer)  +  Win32/GDI+ host (host/win32_services.cpp)
     │        svg/text/gradients → real resvg pixels;  paths/images → GDI+;
     │        compose at device DPI
     ▼
 device-DPI bitmap  ──(4) blit 1:1, opaque──▶  PRINTER
```

There are two production entry points, both consuming the **same** bake →
contract → engine path:

- **Interactive** — the Native Print dialog (`src/main/webapp/plugins/nativeprint.js`)
  bakes the current diagram, surfaces any notices (blocking ones require an
  acknowledgement), and prints.
- **Unattended service** — `tools/native-print-service/index.mjs` (+ `print-file.mjs`)
  bakes a `.drawio` file, runs a **font preflight**, and streams the contract to
  the host engine over a framed protocol. Used for batch/medical‑label printing.

### 2.1 The four links

| Link | What happens | Faithful‑or‑loud rule in this link |
|---|---|---|
| **1 canvas→contract** | Every object/label becomes a primitive paint node. | Any object that cannot be re‑derived faithfully emits a loud bake notice (`Exporter*`, `*Approx`). |
| **2 contract→trace** | Engine validates the contract and transcribes `svg_source`/path/image **verbatim** — no heuristic re‑layout. | Malformed/unsupported contract is **rejected at load** (typed error); version skew emits `SchemaMinorAhead`. |
| **3 trace→pixels** | Real resvg renders the full SVG vocabulary (text, gradients, markers, filters); paths/images go through GDI+. | A failed SVG rasterize becomes a loud `StubbedSvgArtwork`; never a silent blank. |
| **4 pixels→printer** | Device‑DPI bitmap blitted 1:1, opaque, `UnitPixel`. | Content past the sheet → loud `HardwareMarginClip`; never a silent scale. |

Link 4's final blit is the only OS‑specific step (Win32/GDI+). Its input — the
device‑DPI bitmap — is exactly what links 1–3 produce and what the Linux
**render gate** rasterizes using the *same* production resvg backend, so links
1–3 are fully provable on CI without Windows.

---

## 3. How it's implemented (stage by stage)

### 3.1 The bake — `tools/native-print-bake/` + `exporter.js`

The bake is pure Node/JS, browser‑free. Key modules:

- **`drawio-parser.mjs`** — parses the `.drawio`/`mxfile` XML into pages and
  cells with no DOM. Responsibilities:
  - Flattens `<object>`/`<UserObject>` wrappers (preserving attrs).
  - Computes absolute geometry (parent/group offsets, with depth/cycle guards),
    z‑order, reachability (orphan cells excluded exactly as drawio drops them).
  - **Placeholder resolution** (`resolvePlaceholders`/`npResolveName`/`npGlobalVar`),
    a faithful port of `Graph.replacePlaceholders`/`getGlobalVariable`:
    resolution order id → `width[_unit]`/`height[_unit]` → `length` → cell/ancestor
    attribute → page‑arithmetic/date‑time globals → literal; `%%` escape;
    `%label%`/`%tooltip%` left literal.
    - Units use drawio's canonical `Editor.toUnit` constants
      (`PIXELS_PER_INCH=100`, `PIXELS_PER_MM=3.937`) — *not* the physical 96/25.4 —
      so `%width_mm%` matches the editor.
    - Dates are a faithful `Graph.formatDate` port (named masks, `UTC:` prefix,
      quoted literals, full flag set).
    - `%page%` → page **name**; `%pagenumber%` → 1‑based index;
      `%pagecount%`/`±N` arithmetic via drawio's prefix‑guard + unanchored match.
  - Captures page **background colour** and **background image**
    (`<mxGraphModel backgroundImage="{src,x,y,width,height}">`).
- **`exporter.js`** (the re‑derivation engine, ~8k lines) — turns each cell into
  paint nodes from its **stencil/style geometry** (never from a live DOM):
  - **Shapes** → `path` nodes (rounded/partial rect, note/cube/cylinder,
    flowchart/BPMN/UML, arrows, stencils via `stencil-loader.mjs`), with
    `fill`/`stroke` descriptors. Rotated/gradient/filtered shapes that must stay
    faithful are emitted as inline **`svg`** nodes instead.
  - **Edges** → routed with a real `mxEdgeStyle` port (`mx-edge-router.mjs`):
    orthogonal/entity‑relation/elbow, waypoints, rounded corners, all markers
    (classic/open/oval/diamond/box/ER…), `startFill`/`endFill`, edge‑label
    placement at fractional positions, edge‑label wrap to `labelWidth`.
  - **Text/labels** → `svg` nodes with positioned `<text>` runs. Layout is
    computed headlessly from bundled **AFM advance‑width tables** (the canonical
    Adobe Core‑14 metrics for Arial/Helvetica, Times, Courier — plus a bold and a
    serif‑bold table and the WinAnsi Latin‑1/punctuation symbol set). Rich HTML
    labels are parsed by the **svg‑shim** (`svg-shim/index.mjs`, an HTML‑fragment
    parser with full named‑entity decoding) into per‑run styles.
  - **Colour** → a single `resolveColor()` resolves the full CSS set
    (named, `rgb()`/`rgba()`, `hsl()`/`hsla()`, 3/6/8‑digit hex, percentage
    alpha); `isPaintable`/`hex`/`solid` and the gradient/stop builders all route
    through it, folding per‑channel alpha into `fill-opacity`/`stop-opacity`.
  - **Images** → `image` nodes (PNG bytes) or `svg`‑wrapped `<image>` for other
    formats; external URLs are embedded via the owner‑sanctioned canvas path
    (`embedExternalImages`) or loudly noticed.
- **`bake.mjs`** — orchestrates per‑page bake, threads page context
  (`pageNumber`/`pageCount`/`pageName`), runs the **ink‑extent pass**, and
  converts px → µm via **`px-to-um.mjs`** (uniform `×25400/96`, arc flags
  skipped, `svg`/`image` source left in px and mapped into the scaled box).
- **`font-preflight.mjs`** — referenced‑font extraction + availability check
  (wired into the service so a missing design face fails loudly, HTTP 422).

**Notices the bake can raise** (all loud; see severity in §3.4):
`ExporterUnsupportedShape`, `ExporterUnsupportedStencilFeature`,
`ExporterUnsupportedImage`, `ExporterUnsupportedColor`, `GradientDirectionApprox`,
`FontMetricApprox` (non‑metric‑compatible font family),
`GlyphMetricApprox` (glyphs outside the AFM tables — non‑Latin scripts, arrows,
symbols, emoji).

### 3.2 The frozen contract (schema 1.1)

The bake's output is a strict JSON document — the **isolated boundary** between
drawio and the engine. Shape:

```jsonc
{
  "schema": { "major": 1, "minor": 1 },
  "document": {
    "units": "um",                       // or "px" for keepPx test bakes
    "pages": [{
      "id": "page-1",
      "size":  { "w": …, "h": … },
      "tiles": [{ "origin": {…}, "size": {…} }],
      "paint": [ /* ordered back-to-front */
        { "kind": "path",  "d": "M … Z", "fill": {…}|null, "stroke": {…}|null },
        { "kind": "svg",   "box": {…}, "source": "<base64 svg>", "aspect": "preserve" },
        { "kind": "image", "box": {…}, "format": "png", "data": "<base64>", "aspect": "fill", "flipH": …, "flipV": … }
      ]
    }]
  }
}
```

Only three node kinds exist in production: **`path`**, **`svg`**, **`image`**
(`include/print_engine/contract.hpp` `NodeKind::{Path,Svg,Image}`). Paint order
is z‑order (root → layers → descendants, depth‑first). Supported version is
`major=1` (`SupportedMajor`), `minor=1` (`SupportedMinor`); a higher minor is
additive‑compatible and flagged `SchemaMinorAhead`.

### 3.3 The C++ engine — `src/main/native-print-engine/`

Header‑first, drawio‑concept‑free (`INV‑1`). Files in `src/`:

- **`contract_loader.cpp`** — strict, defensive JSON → typed `Contract`.
  Rejects (typed `ContractErrorCode`): unknown node kinds, missing required
  fields, zero/negative or non‑finite extents, huge‑but‑finite extents past the
  ceiling, malformed/mid‑padded base64, ICCP‑profiled or non‑PNG image bytes,
  duplicate page ids, negative schema minor. `path.hpp`/`path_parser.cpp` parse
  the path grammar and reject non‑finite coordinates.
- **`renderer.cpp`** — transcribes the contract into a **`RenderTrace`** of
  device‑independent ops with **no re‑layout**: it does not re‑measure text or
  re‑route edges; it draws what the contract says. It performs the
  page/tile‑coverage checks: ink outside the page edge → `HardwareMarginClip`;
  ink inside the page but outside the tile union → `TileCoverageGap`
  (escape tolerance ≈ 4 px, unit‑scaled; path nodes contribute true geometric
  bounds so the check covers them).
- **`proto.cpp` / `proto_adapter.cpp`** — the wire protocol and the
  `DegradationNoticeType → NoticeKind` mapping. Engine `NoticeKind`s:
  `StubbedBarcode`, `StubbedSvgArtwork`, `HardwareMarginClip`, `FontSubstituted`,
  `MergeClip`, `SchemaMinorAhead`, `ProtoMinorAhead`, `SvgArtworkRasterized`,
  `TileCoverageGap`.
- **`devmode.cpp` / custom stock** — paper‑size / DEVMODE handling
  (named + custom stocks, orientation coercion, microns→tenths‑mm rounding).
- **`native_print.cpp` / `host_main.cpp`** — the engine entry point and host loop.

### 3.4 Rasterizer + host — `src/main/native-print-engine/host/`

- **`svg-rasterizer/` (Rust cdylib)** — wraps **resvg** (the production SVG
  renderer) behind a stable C ABI (`svg_rasterizer_abi.h`). `spe_svg_render`
  rasterizes an `svg` node's source to RGBA at the target box/DPI; guards refuse
  external `<image>`/`foreignObject` hrefs and non‑finite/oversized rasters.
  `spe_text_measure` exposes real ttf‑parser advances for **host‑side font
  preflight** (the JS bake does its own AFM layout; the two are intentionally
  separate, gated by `FontMetricApprox` + the service preflight).
- **`win32_services.cpp`** (Windows‑only; not compiled on Linux) — GDI+ host:
  fills/strokes/dashes/gradients for `path` nodes, blits resvg output for `svg`
  nodes, decodes `image` nodes, and does the final **banded `DrawImage` at
  `UnitPixel`** — 1:1, opaque, device DPI. Every `DrawImage`/decode return is
  status‑checked; on failure it emits a loud notice (e.g. `StubbedSvgArtwork`,
  `ImageDecodeError`) rather than dropping content.
- **`stub_services.cpp` / `engine_services_factory.hpp`** — host‑agnostic
  seams so the engine and its tests run on Linux against the same rasterizer.

### 3.5 Notice severity taxonomy

The single source of truth is `noticeSeverity()` in `exporter.js`, keyed by the
same `kind` string the dialog receives from **both** the bake and the
engine/host:

- **`silent`** — a confirmed‑faithful render with nothing to review
  (e.g. `SvgArtworkRasterized`). Not surfaced; never blocks.
- **`info`** — shown for traceability, never blocks (e.g. `HardwareMarginClip`,
  `SchemaMinorAhead`).
- **`degradation`** — a real fidelity loss the operator must consciously
  acknowledge; **blocks Print** until ticked. Unknown kinds **fail safe to
  `degradation`**.

This taxonomy is what makes "faithful **or** loud" operational: anything that is
not a faithful render lands as `info` (visible) or `degradation` (blocking), and
nothing fidelity‑relevant is classified `silent`.

---

## 4. How to prove WYSIWYG — from design to printer

The proof is **constructive + structural**, never a pixel diff (forbidden). It
has three pillars: (A) the four‑link chain each carries its own evidence;
(B) a browser‑free test harness asserts the structural invariants; (C) an
end‑to‑end render gate exercises the *real* production rasterizer.

### 4.1 Reproduce the per‑link evidence (commands)

```bash
# Link 1 — canvas→contract fidelity + the full object catalogue, zero notices
npm run test:nativeprint-exporter        # 205 pass (+1 pre-existing skip) — exporter structural invariants
npm run test:nativeprint-bake            # 381 pass — bake C1/contract golden + regression corpus
npm run test:nativeprint-validate        # 64 pass  — contract validator (mirrors the C++ loader)
npm run test:nativeprint-service         # 19 pass  — unattended service + font preflight
npm run audit:nativeprint-production     # 86 registered shapes + 8910 stencils — zero gating notices, 0 blank

# Link 2 — contract→trace: engine load/validate/transcribe + INV-1 isolation
( cd src/main/native-print-engine && cmake -S . -B build >/dev/null && cmake --build build -j )
( cd src/main/native-print-engine/build && \
  SVG_RASTERIZER_LIB="$(readlink -f ../host/svg-rasterizer/target/release/libsvg_rasterizer.so)" ctest )
#   -> 217/217 pass (incl. INV-1 architecture scan, contract loader/validation, golden render determinism)

# Link 3 — trace→pixels through the REAL resvg cdylib
( cd src/main/native-print-engine/host/svg-rasterizer && cargo build --release && cargo test )   # 9 pass
export SVG_RASTERIZER_LIB="$(readlink -f src/main/native-print-engine/host/svg-rasterizer/target/release/libsvg_rasterizer.so)"
npm run test:nativeprint-render-gate     # rasterizes every fixture through the real resvg: no blank, no blocking notice

# Render a single inspectable PNG (prints source sha256 beside it)
node tools/native-print-bake/render-artifact.mjs \
  src/main/native-print-engine/tests/fixtures/labels/test.drawio 300 /tmp/test.png
```

`docs/NATIVE_PRINT_WYSIWYG_PROOF.md` carries the canonical, machine‑checked
version of this list; the counts above are current as of the latest audit.

### 4.2 The structural invariants that *are* the guarantee

Because there is no pixel oracle, fidelity is asserted by invariants that hold
**by construction**:

1. **Every labelled object carries its own non‑empty text, verbatim** — no
   silent label loss; checked across the exporter/bake corpus.
2. **Faithful‑or‑loud** — any object the bake cannot re‑derive emits an
   `Exporter*`/`*Approx` notice; any contract the engine cannot honor is rejected
   at load or noticed. Tests assert the *expected* notice set per fixture
   (e.g. `master-test` expects only `GradientDirectionApprox` + `GlyphMetricApprox`).
3. **Measurement == emission** — the AFM tables used to *measure* wrap/alignment
   are the same tables (and the same `fontMetricClass`, driven by
   `FONT_METRIC_EXACT`) used to decide the no‑notice set, so the frozen text
   layout cannot disagree with the gate. A dedicated invariant asserts every
   metric‑compatible family wraps identically to its core face.
4. **Frozen boundary (`INV‑1`)** — `architecture_tests.cpp` fails the build if any
   engine source mentions a drawio/mxGraph concept.
5. **Strict contract gate** — the JS validator (`native-print-validate-contract`)
   and the C++ loader independently reject the same malformed inputs
   (non‑finite, zero/negative/huge extents, bad base64, duplicate page ids).
6. **No silent blank** — the render gate verifies every fixture object rasterizes
   to > 0 opaque pixels (or is loudly noticed).
7. **Determinism** — repeated bakes are byte‑identical (golden contracts); the
   rasterizer is pixel‑deterministic (engine `svg_pixel_determinism_tests`).

### 4.3 The end‑to‑end render gate (Linux‑provable links 1–3)

`tools/native-print-bake/render-artifact.test.mjs` drives every fixture
`.drawio` through `bake → contract → engine → real resvg cdylib`, then asserts:
no silent blank object, and no *blocking* notice (deployment/content‑dependent
`FontMetricApprox`/`GlyphMetricApprox` are excluded from this object‑renders
gate exactly as the corpus audit excludes them — they remain loud in the print
dialog). This is the closest browser‑free analogue to "print and look", using
the same resvg backend the Windows host blits.

### 4.4 What Windows‑only step is *not* covered on CI, and why that's safe

Only **link 4** (the GDI+ `DrawImage` blit) is Windows‑specific and not compiled
on Linux. Its input is the device‑DPI bitmap that links 1–3 produce and that the
render gate already rasterizes with the *same* resvg backend; the blit itself is
a 1:1, opaque, `UnitPixel` copy with every return value status‑checked
(`win32_services.cpp`) and covered by INV‑5 preview/print‑parity ctests. So the
un‑run step is a verbatim copy of already‑proven pixels, not a re‑interpretation.

### 4.5 How the assurance was hardened (audit campaign)

The pipeline was driven to convergence by repeated **independent** adversarial
audit rounds (each round = a fresh auditor that probes the bake against drawio's
own mxGraph source and reports any *silent* divergence). The exit condition was
**two consecutive independent rounds with no findings** plus advisor sign‑off.
Representative defects found and fixed (each had been a silent divergence; each
fix is a faithful render or a new loud notice, locked by a regression test):

- Unit placeholders used physical 96/25.4 instead of drawio's 100/3.937.
- Non‑hex colours (`red`/`rgb()`/`rgba()`/`hsl()`/8‑digit) baked blank or black.
- Gradient‑stop and text/font/border **alpha** silently dropped.
- `%page%` printed the page number instead of the page name.
- Explicit‑page origin shifted a whole sheet off‑paper on a 1 px overhang.
- Non‑Latin/symbol glyph metrics silently approximated (now `GlyphMetricApprox`).
- Page **background image** silently dropped.
- Zero‑length dash segments, HTML named entities, serif‑bold metrics,
  edge‑label wrap‑to‑`labelWidth`, `minStrokeWidth=1`, and the
  `fontMetricClass` vs `FONT_METRIC_EXACT` disagreement.

`docs/WYSIWYG_ASSURANCE_CASE.md` carries the structured claim/evidence argument;
this section is the narrative of how it was reached.

---

## 5. Practical: print a file and read the result

```bash
# Bake + (optionally) print a .drawio file via the unattended path
node tools/native-print-bake/print-file.mjs <file.drawio> [--printer NAME] [--force]
#   - bakes, prints the notice list with severities,
#   - blocks on any 'degradation' notice unless --force.
```

When reviewing a print for fidelity, the workflow is: **read the notice list**.
A clean print emits none (or only `info`). A `degradation` is the system telling
you *exactly* where and why the print would differ from the canvas — which is the
whole point: the divergence is never silent.

---

## 6. File map (quick reference)

| Area | Path |
|---|---|
| Bake orchestration / px→µm | `tools/native-print-bake/bake.mjs`, `px-to-um.mjs` |
| Parser / placeholders | `tools/native-print-bake/drawio-parser.mjs` |
| Re‑derivation (shapes/edges/text/colour/images) | `src/main/webapp/plugins/nativeprint/exporter.js` |
| Rich‑text HTML shim | `src/main/webapp/plugins/nativeprint/svg-shim/index.mjs` |
| Edge routing | `tools/native-print-bake/mx-edge-router.mjs` |
| Font preflight | `tools/native-print-bake/font-preflight.mjs` |
| Contract validator (JS, mirrors loader) | `tools/native-print-validate-contract*.mjs` |
| Engine (load/validate/render) | `src/main/native-print-engine/src/*.cpp`, `include/print_engine/*.hpp` |
| resvg cdylib | `src/main/native-print-engine/host/svg-rasterizer/` |
| Win32/GDI+ host | `src/main/native-print-engine/host/win32_services.cpp` |
| Render gate / production audit | `tools/native-print-bake/render-artifact.mjs`, `production-audit.mjs` |
| Unattended service | `tools/native-print-service/` |
| Interactive dialog | `src/main/webapp/plugins/nativeprint.js` |
| Proof / assurance docs | `docs/NATIVE_PRINT_WYSIWYG_PROOF.md`, `docs/WYSIWYG_ASSURANCE_CASE.md`, this file |

---

*Constraints recap:* faithful render **or** a loud notice — never silent; no
browser anywhere; the engine/contract boundary is frozen; no silent heuristic
fallbacks. Every section above is in service of those four rules.
