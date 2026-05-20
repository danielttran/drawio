# Implementation Status

All phases from `PRINT_ENGINE_SPEC_v1.1.md` have an implemented, cumulative, tested C++ slice. The first `PRINT_ENGINE_SPEC_v2.0.md` native-print bridge slice is also implemented and tested.

## Completed Phase Gates

- **Phase 0:** Contract loader, schema/version gate, typed errors, fixture builder, Catch2 tooling, CI workflow, active INV-1/INV-3/INV-7 tests.
- **Phase 1:** Deterministic emit trace, path parser, single world transform, path/stroke/fill validation, numeric-drift tests at 300/600/1200 DPI.
- **Phase 2:** Static pre-wrapped text rendering, alignment, baseline correction, and preservation of requested font family/weight/italic styling for device-side substitution notices.
- **Phase 3:** Raster image validation, image payload propagation into the host GDI+ decoder/draw path, non-sRGB refusal, retained SVG source validation, and v2 loud SVG stub geometry through the shared transform.
- **Phase 4:** Merge source seam, merge text fitting, overflow handling, barcode seam, and v2 loud barcode stub behavior with structured degradation notices.
- **Phase 5:** Print trace wrapper, tiling, tile-stacked operator preview, design-time preview, print/preview consistency checks.
- **Phase 6:** Adversarial ingest corpus, deterministic fuzz ingest, regression-pair tests, residual-risk documentation.
- **Phase 7 / v2 bridge:** Structured degradation notices, spec-literal loud barcode/SVG stubs, mockable native GDI surface trace, printer device caps validation, preflight-before-StartDoc failure behavior, content-based hardware-margin notice, DEVMODE stock/copies/orientation merge, physical copy iteration, document/page/tile lifecycle, AbortDoc-on-failure tests, robust host-side stroke scaling, and host-side paint/alpha/gradient/arc rasterization.

## Verification

Latest local verification:

```text
cmake --build src/main/native-print-engine/build --config Debug
ctest --test-dir src/main/native-print-engine/build -C Debug --output-on-failure
```

**Image fix (2026-05-17):** drawio image cells (`shape=image` / `image=` style)
were wrongly degraded to a bounding box (`ExporterUnsupportedShape`) even though
the engine renders raster natively. The exporter now bakes embedded **PNG**
images to a faithful `kind:"image"` contract node (data-URI prefix stripped;
`aspect`/`flipH`/`flipV` mapped); non-PNG / external-URL / missing images get a
**specific** `ExporterUnsupportedImage` loud notice + a placeholder box (never
the generic notice, never silent). Verified end-to-end: a real embedded PNG
renders through the engine (visual check), not an empty box.

**Text-property fix (2026-05-17):** `underline`/`strikethrough` were dropped at
every layer (exporter never read drawio `fontStyle` bits 4/8; schema/renderer/
sink had no field) — italic+underline printed italic-only. Added as additive,
backward-compatible optional `font.underline`/`font.strikethrough` (absent ⇒
false; present-but-wrong-type ⇒ loud reject), plumbed exporter → schema →
renderer → GDI+ (`FontStyleUnderline`/`Strikeout`). Visually verified across
combos. All other text properties (family/size/bold/italic/color/align/wrap/
overflow/multiline) were audited and are correct.

The cumulative suite passed locally at **96/96** tests after the accuracy-pass
audit, the §2 measure-at-the-sink text-layout rework (engine text path is now
a pure pass-through; real wrap/shrink/align/clip/reject live in the host sink,
host-e2e-verified), and the WYSIWYG-parity engine net
(`tests/wysiwyg_parity_tests.cpp`). The web exporter suite passed locally at
**54/54** via `npm run test:nativeprint-exporter`, including a cross-process
test that drives the real engine binary with a complex all-shapes document.

### WYSIWYG-parity safety contract (tested)

The exporter is a named-shape subset and is NOT pixel-identical to drawio for
every stencil — by design. The enforced, tested guarantee is: **every drawio
object is rendered faithfully OR loudly flagged with an
`ExporterUnsupportedShape` `DegradationNotice` (operator-acknowledged) — never
silently mis-rendered — and every emitted contract is v1.1-schema-valid so the
engine never silently rejects/diverges.** Coverage: every supported vertex
shape, 14+ unsupported stencils (must degrade loudly), fill/stroke/gradient/
opacity/dash/cap/join, full font matrix (family/size/bold/italic/color), the
h×v alignment matrix, multi-line + HTML-label stripping, edge variants
(straight/orthogonal/rounded/arrows/labels), zoom-independence across scales,
a complex mixed-document invariant sweep, and a real-engine cross-process
render. Preview==print is structural (one shared `draw_trace`, INV-5).

## Spec-Governed Open Items

These are not inferred in code because the spec says they must be escalated or deferred:

- Concrete SVG rasterizer library and distribution license clearance.
- Exact barcode symbology enum/params from the enLabel SDK.
- Real barcode SDK adapter behavior.
- ~~Real text metrics/shaping model and overflow authority~~ — **RESOLVED**: owner directive "max-accuracy WYSIWYG" → measure-at-the-sink (real GDI+ metrics in `draw_trace`; engine forwards text+box+policy). Implemented & audited; see `PRINT_ENGINE_ACCURACY_TODO.md` §2.
- ~~Hardware-margin policy~~ — **RESOLVED** by the same directive: true-size, never silent scale, loud `HardwareMarginClip` notice; already implemented. Only hardware-in-the-loop validation remains (a test, not a decision).
- Hardware-in-the-loop printer-driver and label-stock validation.
- Full host golden-image/PDF/printer-driver validation harness.
- Custom stock protocol/UI shape for dimensions that do not map to a named printer paper ID.

See `SPEC_COVERAGE.md` for the full section-by-section coverage matrix.


## Rich-text (HTML labels) progress

- Additive contract support for `content.type:"rich"` is implemented in loader with validation and loud enum refusal for unknown content types.
- Exporter emits rich paragraphs/runs for HTML labels with feature-flag kill switch and fallback static path.
- Renderer and native bridge forward `rich_paragraphs` through emitted/native draw commands.
- Win32 sink consumes rich paragraph alignment/indent and applies paragraph run style for line measurement and draw with rich font-substitution notices, including run-level wrap at token boundaries, per-line max-ascent baseline alignment across mixed-style runs, and explicit underline/strikethrough line drawing.
- Engine-side structural goldens pin per-run attribute survival (text/family/size/weight/italic/underline/strikethrough/color/paragraph-align) — see `wysiwyg_parity_tests.cpp`.
- Remaining: pixel-level rich golden suite (Windows-only host) + HIL validation.

## SVG TODO #2 — embedded SVG rasterizer (resvg)

- Phase 5 wired: `draw_trace`'s `EmittedKind::Svg` branch now invokes the
  external rasterizer behind the hand-owned ABI (`ISvgRasterizer*` threaded
  through both `render_preview` and `print` from a single Win32Services
  member — INV-5 holds by construction). On success: base64-decode →
  `render(bytes, device_box, dpi)` → straight RGBA8 → premul BGRA → GDI+
  `DrawImage`, with a device-side `SvgArtworkRasterized` `DegradationNotice`
  carrying backend identity. On ANY failure (missing DLL, parse, unsupported,
  internal): existing loud crosshatch + `StubbedSvgArtwork` fallback notice
  carrying the failure reason. Engine library is unchanged (INV-1).
- §6 escalation: the engine's `StubbedSvgArtwork` notice is preserved verbatim
  pending spec-owner sign-off; the new `SvgArtworkRasterized` notice is
  additive (loud success notice naming the backend). The owner can later
  flip the engine notice off (one-line change in `renderer.cpp`).
- `jobLog.svgRasterizer` records backend name+version or "none" for
  regulated traceability.
- Phase 6: SVG golden-image suite remains pixel-level Windows-only. ABI
  symbol verification is gated by the new CI workflow on every push.

## Custom stock (DMPAPER_USER)

- `host/custom_stock.{hpp,cpp}` parses the synthetic `"custom:<wMicrons>x<hMicrons>"`
  stockId shape; tested cross-platform on Linux CI.
- `host/win32_services.cpp::merged_devmode_for` recognises the parsed value
  and sets `DEVMODE.dmPaperSize=DMPAPER_USER` + dmPaperWidth/Length (tenths
  of mm) + orientation, before merging through `DocumentPropertiesW` so the
  driver-private `dmDriverExtra` bytes are preserved.
- `plugins/nativeprint.js` UI offers a "Custom… (set physical dimensions)"
  stock option with W×H mm inputs; Print is gated on positive dims.

## CI

- `.github/workflows/native-print-engine.yml` gates the engine library +
  tests on Linux, the full Win32 host build + ctest + SVG ABI swap test on
  Windows, the Rust cdylib on both runners (with ABI-symbol export
  verification), and the exporter Node `--test` suite on Linux.
