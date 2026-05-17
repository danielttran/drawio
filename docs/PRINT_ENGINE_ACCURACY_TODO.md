# Print Engine — Accuracy Completion TODO

**Audience:** the next engineer/agent ("codex") finishing the native print engine.
**Goal:** printing must be **extremely accurate** — what the operator designed is
what comes out of the printer, pixel/typographically faithful, in correct color,
at correct size, on the correct paper.

This document is the work order. It is prioritized by accuracy impact. Each item
states the *root cause with file references*, the *required change*, and a
*measurable acceptance bar*. Do them in order — later items assume earlier ones.

---

## 0. Ground rules (read before touching anything)

- **Authority:** `docs/PRINT_ENGINE_SPEC_v1.1.md`, `PRINT_ENGINE_SPEC_v2.0.md`,
  `PRINT_ENGINE_HOST_INTEGRATION_v1.1.md` are the architecture of record.
  Silence or contradiction ⇒ **STOP and ask**, do not infer. Items below that
  require a spec-level decision are marked **[ESCALATE]**.
- **INV-1:** the engine library (`include/`, `src/`) must contain **no host /
  editor / diagram / OS concept**. It is scanned by
  `tests/architecture_tests.cpp` for a banned-token list (draw.io, drawio,
  mxGraph, mxCell, mxGeometry, mxPerimeter, mxGraphModel, palette, perimeter,
  edgeRouting, routeEdge, layoutSolver, zOrder) **including in comments**.
  All Windows/GDI+ code stays under `host/` (not scanned).
- **INV-5 (non-negotiable for accuracy):** preview and print must be driven by
  the *same* render trace through the *same* rasterizer code at the *same* DPI,
  so they receive **identical draw calls**. Note this means *geometry/layout
  parity*, **not** byte-identical pixels: the printer driver applies its own
  halftoning/color management to the DC, which the preview bitmap does not get.
  The bar is "the same shapes, text and positions at the same size", not "the
  same bytes". Any change that makes the *draw calls* diverge is a regression
  even if each output looks fine alone.
- **Line numbers in this doc are approximate** — locate code by the named
  symbol/function, not the line number (the tree will have moved).
- **Build is strict:** `/W4 /WX /permissive-` (MSVC) / `-Wall -Wextra
  -Wpedantic -Werror`. System headers are wrapped in `#pragma warning(push,0)`;
  your code must be warning-clean.
- **Contract schema is frozen and exact** — see Appendix A at the end of this
  document (self-contained; do not rely on working memory). Do not change the
  schema without a spec change.
- Build/test (run from the repo root `E:\Dev\drawio`):
  ```
  cmake -S src/main/native-print-engine -B src/main/native-print-engine/build -DBUILD_TESTING=ON
  cmake --build src/main/native-print-engine/build --config Debug
  ctest --test-dir src/main/native-print-engine/build -C Debug --output-on-failure
  ```
  Engine baseline is **83/83 green** — keep it green at every step.
- Never push upstream (see `docs/CLAUDE.md`).
- Dev harnesses: `host/tools/smoke.js`, `host/tools/exporter_e2e.js`.

---

## 1. Color / alpha / gradient fidelity  — **highest impact**

**Symptom:** every stroke and **all text prints black**; fill alpha ignored;
linear/radial gradients are validated but never painted.

**Root cause (not just the rasterizer — the data is destroyed upstream):**
- `include/print_engine/contract.hpp` `PaintNodeSummary` keeps only
  `has_fill`/`has_stroke`/`stroke_width` — **the actual colors, alpha and
  gradient stops parsed by `src/contract_loader.cpp` (`validate_paint`) are
  discarded at load**.
- `include/print_engine/renderer.hpp` `EmittedCommand` carries no color either
  (only a `style_signature` string).
- `host/win32_services.cpp` `draw_trace()` therefore has nothing to use and
  hard-codes a black `SolidBrush`/`Pen`.

**Required change (engine + host, INV-1-clean):**
1. Add a `Paint` value type to the engine (solid: rgba; gradient: kind +
   sorted stops). Extend `PaintNodeSummary` to retain fill paint, stroke paint,
   and font color+alpha; populate them in `contract_loader.cpp` (the values are
   already parsed — stop throwing them away).
2. Extend `EmittedCommand` with resolved `fill`, `stroke` (paint + width + cap
   + join + miter + dash) and `text_color`. Populate in `renderer.cpp` where
   `EmittedKind::Path`/`Text` are pushed (lines ~227 and ~320).
3. In `draw_trace()` build `Gdiplus::SolidBrush`/`LinearGradientBrush`/
   `PathGradientBrush` and `Pen` (with cap/join/miter/dash) from the command;
   draw text with the command's color. Honor alpha (`Color(a,r,g,b)`).

**Acceptance:** a contract with a semi-transparent fill, a colored 3px dashed
stroke, a linear gradient, and red bold text renders with **ΔE (CIE76) < 3** vs
a reference raster at 300 dpi for solid regions; gradient direction/stops
correct; dash pattern visible. Add `tests/` numeric tests for the new `Paint`
plumbing and a host-side golden-image check (see §9).

---

## 2. Real text metrics & shaping  — **highest impact**

**Symptom:** text position, wrapping, centering and shrink-to-fit are wrong for
any proportional font.

**Root cause:** `src/renderer.cpp` fakes metrics:
`measured_text_width` ≈ `chars × fontSize × 0.6` (l.~106),
`fitted_height` ≈ `lines × fontSize × 1.2` (l.~102),
`fit_lines` wraps on that fake width (l.~50). The text box, alignment offset
and merge overflow/shrink decisions (`MergeOverflowError`) are all computed from
this guess (l.~149–238).

**[ESCALATE] — design decision required before coding:** real metrics need a
font engine, but `renderer.cpp` is platform-agnostic (INV-1) and its overflow/
shrink verdicts are **contractual and must be deterministic & host-independent**
(spec v1.1 §4.3). You may not simply call GDI+ from the renderer. Resolve with
the spec owner which model holds:
- (a) Introduce an injected `ITextMeasurer` seam: the engine ships a
  *deterministic, specified* metric model used for the *contractual* fit/
  overflow decision; the device sink (`draw_trace`) does *pixel-accurate*
  shaping for drawing. Then prove they cannot disagree (engine model must be a
  conservative upper bound on real width/height, else preview shows fit but the
  printer clips — an INV-5 break). **Document the metric model in the spec.**
- (b) Move *all* text layout to the rasterizer and carry only unshaped text +
  box + font in the trace; both preview and print measure with the same GDI+
  call (INV-5 holds because both sinks are the same code). Overflow becomes a
  device verdict — a spec change to §4.3.

Either way: implement, then add tests that a 40-char proportional string in a
known box wraps / aligns / shrinks **identically in the contractual decision
and in the drawn output** (no preview/print divergence).

**Acceptance:** for Arial/Segoe UI/Times at 8–48 px, glyph advance error vs the
device metric **< 0.5 px at 600 dpi**; centered/right-aligned text visually
centered to **±1 px**; shrink-to-fit lands within the box without clipping;
preview and print receive identical text draw calls (same shaped runs, same
positions) at the same DPI.

---

## 3. Raster image rendering

**Symptom:** image nodes print as an empty rectangle.

**Root cause:** `PaintNodeSummary` has `image_data`/`image_format` and the
loader validates the PNG signature, but `EmittedCommand` does not carry the
bytes, so `draw_trace()` only strokes the box (`EmittedKind::Image` branch).

**Required change:** carry the (validated) image bytes (or an index into a
trace-side blob table to avoid copies) through `EmittedCommand`; in
`draw_trace()` decode via `Gdiplus::Bitmap` from an `IStream` over the bytes and
`DrawImage` into `device_box`, honoring `image_aspect`, `flip_h/flip_v`.
Keep the existing loud `ImageDecodeError` path for malformed data.

**Acceptance:** a 200×100 PNG placed at a known box prints at the correct
position/scale, aspect honored; corrupt bytes still produce a typed
`ImageDecodeError`, never a blank box.

---

## 4. True elliptical arcs

**Symptom:** circles / rounded rectangles / pie shapes print as straight chords.

**Root cause:** `host/win32_services.cpp` `add_path_command()` —
`PathCommandKind::ArcTo` is approximated by a single `AddLine` (chord).
`parse_absolute_svg_path` already yields full arc parameters.

**Required change:** implement SVG arc endpoint→center parameterization and emit
a sequence of `Gdiplus::GraphicsPath::AddBezier` cubic segments (≤90° per
segment) — standard SVG-A→Bézier conversion. Handle large-arc/sweep flags and
the degenerate (rx=0|ry=0 ⇒ line) case.

**Acceptance:** a unit circle built from two `A` commands is round to within
**0.25 px at 600 dpi** (max radial error); rounded-rectangle corners are
smooth; numeric arc-conversion unit tests added.

---

## 5. DEVMODE: correct paper, copies, orientation

**Symptom:** picked stock/copies are ignored — output uses the printer driver
default (a contract-vs-reality mismatch the operator cannot see).

**Root cause:** `host/win32_services.cpp` `print()` calls
`CreateDCW(L"WINSPOOL", name, nullptr, nullptr)` — **NULL DEVMODE**; `copies`
and `stock_id` are only logged.

**Required change:** `OpenPrinterW` → `DocumentPropertiesW` to fetch the
driver `DEVMODE`; map `stockId` → the form (match `GetCapabilities` stock id to
`DC_PAPERNAMES`/`DC_PAPERS`; set `dmPaperSize`, or `dmPaperWidth/Length` +
`dmPaperSize=0` for custom); set `dmCopies`, `dmOrientation`; re-merge via
`DocumentPropertiesW(DM_IN_BUFFER|DM_OUT_BUFFER)`; pass that DEVMODE to
`CreateDCW`. Validate the requested stock exists → typed `PrintDeviceError`
if not (loud, never fall back silently).

**Acceptance:** selecting A4/Letter/4×6 and N copies produces exactly that on
the spooled job (verify with "Microsoft Print to PDF": output page size and
page count match the selection for 3 distinct stocks and copies=1/3).

---

## 6. Hardware-margin correctness (no silent clipping)

**Symptom:** content near the page edge is clipped; engine detects it but the
rasterizer ignores it.

**Root cause:** `draw_trace()` draws at device origin (0,0); printers have a
non-printable border. `tile_content_hits_hardware_margin` emits a notice but
nothing positions content into the printable area.

**[ESCALATE]:** "accurate" can mean *fit-to-printable* (scale down so nothing
clips) or *true-size with clip + loud notice* (regulated labels usually require
true size). Confirm the policy with the spec owner. Then in `print()`:
translate the GDI+ origin by `GetDeviceCaps(PHYSICALOFFSETX/Y)` so contract
(0,0) maps to the printable origin; apply the agreed fit/true-size policy
consistently in **both** preview and print (INV-5 — preview must show the same
clip/scale the printer will produce).

**Acceptance:** for a contract whose content touches all four page edges,
preview and print apply the *same* origin offset and the *same* fit/true-size
transform (identical draw calls); the `HardwareMarginClip` notice fires exactly
when (and only when) clipping occurs.

---

## 7. Multi-page / multi-tile printing

**Symptom:** all tiles/pages overlap on a single sheet.

**Root cause:** `print()` draws the whole trace once per *copy*; it does not
segment by tile/page. The trace already carries `StartTile`/`EndTile`
(`renderer.cpp`) and `render_print_trace` wraps `StartDocument`/`EndDocument`.

**Required change:** drive one `StartPage`/`EndPage` per tile; `draw_trace()`
must accept a command sub-range (one tile) and the per-tile device transform
(`make_printer_world_transform`). Copies iterate the whole document, not a
single page. Preserve `AbortDoc` on any page failure (state which page/tile
failed in the typed error — host integration flow step 8).

**Acceptance:** a 2-page, 2-tiles-per-page contract yields 4 printed sides in
order; a forced failure on page 2 aborts the whole job with a typed error
naming page 2 (never a partial).

---

## 8. Exporter fidelity (the bake) — beyond the bounding-box subset

**Symptom:** every shape exports as a plain rectangle; edges as straight
polylines; no arrowheads, waypoints, rounded/curved edges, edge labels, or
real shape outlines. Real diagrams look boxy.

**Root cause (by design, now to be lifted):**
`src/main/webapp/plugins/nativeprint/exporter.js` `buildContract()` approximates
every vertex as `rectPath()` and every edge as a straight `polyPath()`.

**Required change (renderer-side, spec §5; keep it pure/Node-testable):**
- Per vertex: derive the **actual shape outline** as an absolute SVG path. Use
  the rendered shape geometry (mxGraph computes it) — e.g. the cell's
  `state.shape` path, or drawio's per-cell SVG, mapped to one or more contract
  `path` nodes with the cell's real fill/stroke (now that §1 carries color).
  Cover at minimum: rounded rect, ellipse, rhombus, triangle, cylinder,
  cloud — i.e. drawio's common stencils — others fall back to outline-from-SVG.
- Per edge: emit the real routed geometry (orthogonal/curved waypoints from
  `state.absolutePoints`, rounded corners), plus arrowhead/marker geometry as
  small filled `path` nodes, plus edge labels as `text` nodes.
- Carry text style fully (already mostly present): family, px size, bold/
  italic, **color** (consumed once §1 lands), h/v align, multi-line.
- Keep it zoom-independent (already fixed: ÷ `view.scale`) and contract-exact.
- Degrade *loudly*: anything still unsupported emits a `DegradationNotice`
  the operator must acknowledge — never a silent wrong shape.

**Acceptance:** a reference diagram (rounded boxes, an ellipse, a rhombus, an
orthogonal edge with an arrowhead and a mid-label, colored fills, mixed fonts)
exports to a contract whose rendered preview is visually indistinguishable from
drawio's own SVG export at the same size (side-by-side, ≤2 px deviation on
shape outlines).

---

## 9. DPI alignment + verification harness — **start this first; it is the regression net for §§1–8**

- **Preview DPI must equal print DPI.** `src/main/webapp/vite.config.mjs`
  hard-codes `dpi: 150` for preview while `print()` renders at the printer's
  `LOGPIXELSX` (often 600). Geometry rounding then differs — a latent INV-5
  break. Make the broker request the preview at the **selected printer's
  DPI** (from `GetCapabilities` stock `dpiX/Y`), and the engine/host use that
  same value for the actual print.
- **Real font-substitution notice:** `draw_trace()` already falls back to Arial
  when a family is unavailable but emits nothing. Emit a real `FontSubstituted`
  `DegradationNotice` from the device when substitution actually happens
  (replace the `"DefinitelyMissingFont"` sentinel-only path in `renderer.cpp`).
- **Golden-image tests:** add a host-side test target that renders fixed
  contracts to PNG and compares against checked-in references with a tolerance
  (per-pixel ΔE + max positional error). Wire into
  `.github/workflows/native-print-engine.yml`. This is the regression net for
  every item above — "looks right once" is not acceptance; the golden test is.
- Keep `ctest` green and add numeric unit tests for every new engine type
  (Paint, metrics model, arc conversion).

---

## Definition of done (the accuracy bar)

A diagram designed in the webapp, printed via File → Native Print, is
**extremely accurate** when, against drawio's own SVG export of the same
diagram at the same physical size:

1. Shape outlines deviate **≤ 2 px @ 600 dpi** (arcs ≤ 0.25 px radial).
2. Text glyph advance error **< 0.5 px @ 600 dpi**; alignment within ±1 px;
   no unintended wrap/clip.
3. Color **ΔE < 3** for solids; alpha and gradients correct.
4. Raster images correct position/scale/aspect.
5. Output is on the **selected** paper, **selected** copies, correct
   orientation; nothing clips unless the agreed margin policy says so and the
   operator acknowledged the notice.
6. Preview and print are driven by identical draw calls at the print DPI
   (geometry/layout parity — not byte-identical pixels; the driver halftones).
7. Multi-page documents paginate correctly; any failure aborts loudly with the
   failing page/tile named.
8. Every unsupported case is a loud, acknowledged `DegradationNotice` — there
   is no silent inaccuracy anywhere.
9. `ctest` green; golden-image suite green in CI.

Update `docs/MEMORY.md` (repo working memory) as each item lands.

---

## Appendix A — exact v1.1 contract schema (frozen)

The bake must emit exactly this; the engine loudly rejects any deviation
(`contract_loader.cpp`). This is the authoritative copy — self-contained on
purpose so it survives working-memory cleanup.

```
{ "schema": { "major": 1, "minor": 0 },
  "document": {
    "units": "px",
    "pages": [ {
      "id": "<string>",
      "size":  { "w": <num>, "h": <num> },
      "tiles": [ { "origin": { "x": <num>, "y": <num> },
                   "size":   { "w": <num>, "h": <num> } } ],
      "paint": [ <node> ... ]
    } ] } }

node "path": { "kind": "path", "d": "<absolute SVG path>",
               "fill": <paint|null>, "stroke": <stroke|null> }

node "text": { "kind": "text",
               "box":  { "x": <num>, "y": <num>, "w": <num>, "h": <num> },
               "font": { "family": "<string>", "sizePx": <num >0>,
                         "weight": <int>, "italic": <bool>,
                         "color": "<string>" },
               "align": { "h": "left|center|right",
                          "v": "top|middle|bottom" },
               "content": { "type": "static", "lines": ["<string>", ...] } }
        // OR content: { "type":"merge", "key","sample","maxLen",
        //               "wrap","overflow","shrinkFloorPx" }

paint  = { "type": "solid", "color": "#rrggbb", "alpha": 0..1 }
       | { "type": "linear|radial", "stops": [ ... ] }

stroke = { "paint": <paint>, "width": <num >0>,
           "cap": "butt|round|square", "join": "miter|round|bevel",
           "miterLimit": <num >0>,
           "dash": <array of >0 numbers | null> }   // dash KEY is REQUIRED
```

Notes:
- `d` must be **absolute** SVG commands. `M/L/C/Z` are real; `A` currently
  degenerates to a chord in the GDI+ subset (fixed by §4 of this doc).
- For a `path` node the engine derives the node box from the path bounds.
- `units:"px"` ⇒ the engine uses `contract_units_per_inch = 96` in its
  `RenderTarget`; device scale = `dpi / 96`.
- The `dash` key is required even when solid — pass `null`, not omitted.
