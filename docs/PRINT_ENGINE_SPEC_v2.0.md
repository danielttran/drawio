# Native Print Engine — v2.0 Bridge Spec: Real GDI+ Printing (minus barcode & embedded SVG)

**This is the single instruction document for the native-printing milestone. It SUPERSEDES v1.2 entirely (retire v1.2). It REFERENCES v1.1 as the architecture of record.**

**Documents Codex needs:** exactly two — `PRINT_ENGINE_SPEC_v1.1.md` (architecture, contract schema, invariants, pipeline, TDD harness — unchanged, authoritative) and **this v2.0 bridge** (what to build to reach real native printing, and the scope cut). Do not use v1.2.

**Goal of this milestone:** take the engine from "passes deterministic/trace-level tests" to "draw.io content baked to the v1.1 contract prints on a real printer via GDI+," with barcode and embedded-SVG-artwork rendered as loud, tested stubs. Output is **testing-ready, not production-validated** (see §6 — this boundary is mandatory and travels with the build).

**Authority & escalation (from v1.1, restated):** this document is the contract for this milestone. Silence or contradiction ⇒ STOP and ask. Inference on an unspecified point is the defect class this project exists to prevent. No change in this milestone may touch the v1.1 contract schema, invariants, or pipeline shape; if a change seems to require that, escalate instead of acting.

---

## 1. Relationship to v1.1 (read first)

Everything in v1.1 remains in force **except** as explicitly modified below. In particular, unchanged and authoritative:

- **Contract schema** (v1.1 §3) — every PaintNode kind, including `barcode` and `svg`, **stays in the schema**. Nothing removed.
- **Invariants** INV-1, INV-2, INV-2a, INV-3, INV-4, INV-5, INV-7 and the activation matrix (v1.1 §2, §2.1) — unchanged and gating. One INV-6 sub-test status change is specified in §3.2.
- **Pipeline** P1→P7 (v1.1 §4.1) — unchanged in shape. This milestone makes P6 (emit) and P7 (print sink) render for real via GDI+; it does not alter the stage graph.
- **MergeTextFitter** (v1.1 §4.5), merge-resolve seam and overflow policy (v1.1 §4.3) — fully built and tested, NOT deferred.
- **TDD discipline** (v1.1 §7), test taxonomy and the **deterministic golden model** (v1.1 §8.2), dependency-direction/immune-boundary tests (v1.1 §8.5) — unchanged and applied to all new code in this milestone.
- **Ratified tradeoffs** (v1.1 §11) and **escalate-don't-infer open items** (v1.1 §12) — unchanged.

This milestone modifies exactly: (a) barcode → loud stub (§3.1), (b) embedded SVG → loud stub (§3.2), (c) P6 emit specified as **real GDI+** (§4), (d) P7 specified as the **real GDI+ printer-DC sink** (§5), (e) adds the loud-stub safety contract (§3.3), the testing-readiness boundary (§6), and the milestone Definition of Done + tests (§7–§8).

---

## 2. Scope of this milestone

**In:** real GDI+ rendering of `path`, `text` (static + merge-fitted), and raster `image` nodes; the real GDI+ printer-DC output sink (DEVMODE, document/page/tile lifecycle, the single world transform, physical printable-area handling); loud tested stubs for `barcode` and `svg`; the testing-readiness boundary doc.

**Out (deferred, NOT removed — kept as loud stubs with seams intact):** real barcode symbology rendering (enLabel SDK adapter); real embedded-SVG rasterization (concrete rasterizer library + license clearance). Their schema descriptors and pipeline seams **remain and stay gating** so adding them later requires **zero pipeline change** (this is the explicit reason they are stubbed, not deleted — per v1.1 §11.4).

**Forbidden in this milestone:** removing any PaintNode kind; "simplifying the engine to match what draw.io supports" (that re-couples the engine to draw.io = INV-1 regression; "what draw.io supports" is a property of the *deferred exporter*, never the engine); altering the contract schema, invariants, or pipeline graph; re-architecting anything in v1.1.

---

## 3. The scope cut: barcode & embedded SVG as loud stubs

### 3.1 Barcode → permanent loud stub for this release
- `barcode` PaintNode (v1.1 §3.3), P4 stage (v1.1 §4.1), `IBarcodeRenderer` (v1.1 §4.2): **retained, unchanged, gating**. INV-7 and the Phase-4 seam tests stay active.
- `IBarcodeRenderer` has exactly one implementation this milestone: the **loud stub** (§3.3). No enLabel SDK adapter is built.

### 3.2 Embedded SVG artwork → permanent loud stub for this release
- `svg` PaintNode (v1.1 §3.3), P5a stage (v1.1 §4.1), `ISvgRasterizer` (v1.1 §4.2): **retained, unchanged, gating** at the schema level. INV-6's schema assertion (`svg.source` opaque, retained, never pre-flattened) stays **active and gating**.
- INV-6's *rasterization-DPI* sub-test moves to **pending** via the v1.1 §2.1 activation mechanism (tracked in `INVARIANT_STATUS.md`, NOT red, NOT xfail), reason: "SVG rasterizer deferred per v2.0 §3.2." It re-activates when a real rasterizer is built in a future milestone.
- `ISvgRasterizer` has exactly one implementation this milestone: the **loud stub** (§3.3). No rasterizer library is selected or integrated.

### 3.3 Loud-stub safety contract (regulated-domain — non-negotiable)
A stub that renders nothing, or renders something mistakable for real content, is a safety defect in a medical-device labeling engine. Both stubs MUST be loud, visible, unmistakable, and reported:

- **Barcode stub:** within the node `box`, a placeholder in a reserved non-content style (e.g. diagonal hatch) plus literal text `BARCODE STUB — symbology=<sym> value=<resolved-or-sample>` clipped to the box; AND a `DegradationNotice{type=StubbedBarcode, symbology, resolvedValue, pageId}`.
- **SVG-artwork stub:** within the node `box`, a placeholder in a *distinct* reserved style plus literal text `SVG ARTWORK STUB`; AND a `DegradationNotice{type=StubbedSvgArtwork, pageId, box}`.
- Every stub `DegradationNotice` is **collected and surfaced on the job result**, and **displayed on the operator preview path** — never swallowed. Any print or preview containing a stubbed node MUST report it.
- Stub placeholder geometry passes through the **same single world transform** as all other content (INV-4) — a stub is still subject to the no-drift discipline.
- The two stub reserved styles and normal-content style are **mutually visually distinct**, asserted by test §8.4. A tester or regulated reviewer must never be unsure whether a barcode/logo on a sheet is real or stubbed. Loud-by-construction follows directly from v1.1 §11.5 (loud-fail over best-effort).

---

## 4. Real GDI+ rendering of the emit path (P6)

The trace/deterministic sink remains the **test** sink (v1.1 §8.2 golden model is unchanged and still the regression mechanism). This section specifies the **real GDI+ rendering** P6 performs when targeting an actual `Gdiplus::Graphics` surface (both the printer DC of §5 and the in-memory preview bitmap of v1.1 §5). If any P1–P6 step is currently trace-only, it is made real GDI+ here. Build test-first per v1.1 §7; INV-2 still holds (P6 consumes coordinates verbatim — no geometry recomputation, no node-kind logic beyond rendering the already-resolved primitive).

### 4.1 Surface configuration (once per page, identical for print and preview)
`SetTextRenderingHint(TextRenderingHintAntiAlias)` (never ClearType on paper), `SetInterpolationMode(InterpolationModeHighQualityBicubic)`, `SetSmoothingMode(SmoothingModeAntiAlias)`, `SetPixelOffsetMode(PixelOffsetModeHalf)`. Page unit configured so the §5.4 world transform is the **only** unit mapping (no second implicit scale).

### 4.2 `path` nodes
- SVG path `d` → `Gdiplus::GraphicsPath`. **Elliptical arc (`A`)**: convert SVG endpoint-parameterization to center-parameterization, then emit via `AddArc`/Bézier approximation — there is no direct GDI+ arc-from-endpoints; this conversion is a unit-tested component (boundary: large-arc/sweep flag combinations, near-zero radii, degenerate same-point arcs).
- Fill: `solid`→`SolidBrush`; `linear`→`LinearGradientBrush` honoring `p0/p1` and stop offsets/alpha; `radial`→`PathGradientBrush` (documented approximation, v1.1 §6.1 — characterization test pins it so it cannot silently worsen).
- Stroke: `Pen` with width in contract units (scaled by the world transform, never pre-rounded), `cap`/`join`/`miterLimit` mapped to GDI+ enums, `dash`→`SetDashPattern`.
- Nested transform/clip: use `BeginContainer`/`EndContainer` for grouped transform+clip so clips do not leak across groups (a `Save`/`Restore`-only approach is a known defect here).

### 4.3 `text` nodes (static + merge-fitted)
- Static text: render the contract's pre-resolved `lines` verbatim — no measuring, no wrapping (INV-2; v1.1 §3.4).
- Merge text: render the `FittedText` produced by MergeTextFitter at P5c (v1.1 §4.5) — the fitter already decided lines/size; P6 only positions and draws.
- Baseline correction: contract `box` is top-left; GDI+ text origin differs — offset by `FontFamily::GetCellAscent`/`GetEmHeight` so text sits where the box specifies (the classic vertically-shifted-text defect). `align.h/v` → `StringFormat` alignment. Missing font ⇒ deterministic substitution + `DegradationNotice` (never silent).

### 4.4 `image` nodes (raster)
- base64 → bytes → `IStream` (`SHCreateMemStream`/`CreateStreamOnHGlobal`) → `Gdiplus::Bitmap`. Decode failure ⇒ typed `ImageDecodeError`, page refused (loud).
- Precondition (v1.1 §3.5): payload is already sRGB. The engine contains **no** color-management code; a surfaced non-sRGB/profiled image ⇒ typed `ImageColorError`, page refused. Do not convert.
- Draw via the `DrawImage(dstRect, src…, UnitPixel, ImageAttributes)` overload so placement is driven by the contract `box`, not the bitmap's embedded DPI metadata (embedded DPI is unreliable — a classic wrong-size defect). `aspect=preserve` respects aspect within the box; `fill` stretches. `flipH/flipV` applied. Alpha compositing correctness verified over a gradient fill (the known failure point — test §8.x).

### 4.5 `barcode` / `svg` nodes
Routed through their real seams to the loud stubs (§3.3). The stub draws its reserved-style placeholder + literal label through the same surface and the same world transform.

### 4.6 P6 prohibitions (INV-1/INV-2 still gating)
P6 must not: recompute any structural geometry; re-measure/re-fit text (done at P5c); re-rasterize images/SVG; reorder paint nodes; branch on any draw.io concept (none exist past the contract). Architecture tests (v1.1 §8.5) re-run green over the new P6 code.

---

## 5. Real GDI+ printer-DC output sink (P7 print)

The single piece of genuinely new engineering that enables native testing. It consumes the P6-emitted primitive stream; it does NOT re-run layout or branch on node kind (INV-2). Build test-first.

### 5.1 Device context & DEVMODE
- Acquire the printer DC from a **merged DEVMODE** using the established `BuildMergedDevMode` discipline (reuse — do not reinvent). The merge MUST preserve the driver's private `dmDriverExtra` region intact.
- Label stock is selected via `DMPAPER_USER` + **explicit physical paper dimensions**, never a named paper enum — named-enum rounding is a known device-dot drift source (the historical label-dimension defect class).
- DC acquisition or DEVMODE merge failure ⇒ typed `PrintDeviceError`, job refused, nothing printed (loud-fail).
- `Gdiplus::Graphics g(hdcPrinter)` is the surface; configure per §4.1 each page.

### 5.2 Document / page / tile lifecycle
- `StartDoc` once per job (docinfo name = caller-supplied job label, ASCII-sanitized).
- For each Page → each Tile: `StartPage`; configure surface; set per-tile clip + world transform (§5.4); replay the P6 primitive stream for that tile; `EndPage`. Exactly one `StartPage`/`EndPage` per tile.
- `EndDoc` once on success. **Any** mid-job error ⇒ `AbortDoc` (never `EndDoc`), surface the typed error with the failing page/tile id. A partially printed job is reported failed with its failure point — never silently truncated.

### 5.3 Physical printable area
- Honor the hardware non-printable border: `GetDeviceCaps(PHYSICALOFFSETX/Y)`, `PHYSICALWIDTH/HEIGHT` vs `HORZRES/VERTRES`.
- If a tile's content would be clipped by the device's hardware margin ⇒ emit `DegradationNotice{type=HardwareMarginClip, pageId, tile}` (loud — a tester must know if the printer's unprintable edge ate content; common real-printer surprise). The per-tile clip still prevents overdraw.

### 5.4 The single world transform on the real DC (INV-4 — highest-risk part)
- Compute once per tile: contract-units → device-dots, composing (a) tile `origin` translate, (b) contract→device scale from `GetDeviceCaps(LOGPIXELSX/Y)` at the device's true resolution, (c) the `PHYSICALOFFSETX/Y` shift so contract origin maps to the **sheet's true top-left**, not the printable-area top-left.
- Applied via `Graphics::SetTransform`; per-tile clip via `SetClip` in the same space. **No code path may convert any coordinate to integer device units before this transform.** Paths, text boxes, image boxes, and stub-placeholder boxes all pass through the identical transform. This is the label-dimension-drift defect class; the INV-4 numeric-drift test (v1.1 §8.4) is extended in §8.1 to assert against **mock real-printer device caps**, not only the synthetic sink.

### 5.5 Print-sink prohibitions
Must not re-measure/re-fit text, re-rasterize images/SVG, reorder paint nodes, or branch on draw.io concepts. Violations are INV-1/INV-2 regressions and fail v1.1 §8.5.

---

## 6. Testing-readiness boundary (mandatory; write it into the build)

### 6.1 What this milestone delivers
draw.io content baked to the v1.1 contract prints on a real printer via GDI+: `path`, static text, merge-fitted text, raster `image` rendered for real; `barcode` and `svg` rendered as loud reported stubs; every error path typed and loud; operator-merged preview and design preview producing the **same** pipeline output as print (INV-5).

### 6.2 What it explicitly does NOT deliver — state to the boss in writing (the agent produces `TESTING_READINESS.md` containing this in substance)
- **Real barcode rendering** — deferred, loudly stubbed. Any label whose correctness depends on a scannable barcode is **not** producible by this build; the stub is unscannable on purpose.
- **Embedded SVG artwork** — deferred, loudly stubbed.
- **Hardware-in-the-loop qualification** — real printer-model coverage, physical label-stock dimensional verification, DPI/margin verification on real media, barcode-scan verification. For J&J / Bayer / Boston Scientific–class clients this is very likely a **formal IQ/OQ validation deliverable**, a separate workstream with its own owner and budget, NOT the engine agent's scope. This is the largest uncosted item — flag it now, not after the engine "works."
- **Rasterizer library license clearance** and the **v1.1 §4.6 barcode-SDK representation feasibility check** — human/vendor decisions on the critical path for ever lifting the stubs. Raise the §4.6 question with the enLabel SDK owner *before* any future barcode milestone; it can invalidate a design assumption, not merely remain unbuilt.

A build passing every test here is safe to **test draw.io native printing of non-barcode, non-SVG-artwork content**. It is **not** safe to print regulated production labels. The loud stubs + loud-fail discipline make that boundary visible on every sheet rather than discoverable in the field.

---

## 7. Definition of Done (this milestone)

Per v1.1 §7 (tests first, four categories, full activated regression green every loop). Done when ALL of:

1. P6 renders `path`/`text`/`image` via **real GDI+** per §4; arc-conversion, gradient, stroke/dash, baseline, image-alpha each unit-tested (boundary+adversarial).
2. Loud barcode stub and loud SVG-artwork stub (§3.3) implemented; both `DegradationNotice`s surfaced on job result and preview; visual-distinctness test green (§8.4).
3. Real GDI+ printer-DC sink (§5): DEVMODE/DC with `dmDriverExtra` preserved, `DMPAPER_USER`+explicit dims, doc/page/tile lifecycle, single world transform with `PHYSICALOFFSET`/caps, per-tile clip, `AbortDoc` on mid-job error.
4. INV-4 numeric-drift (v1.1 §8.4) extended to assert against a **mock real-printer device-caps provider** at 203/300/600 dpi-class profiles (§8.1) and green; not only the synthetic sink.
5. `PrintDeviceError`, `HardwareMarginClip`, `ImageDecodeError`, `ImageColorError`, `AbortDoc`-on-mid-job-error each have a typed-failure test, green.
6. INV-1/INV-2 architecture tests (v1.1 §8.5) green over all new P6/P7 code (no draw.io concepts, no geometry recompute, no node-kind branching in the sink).
7. `INVARIANT_STATUS.md` updated: INV-6 rasterization-DPI sub-test → pending (reason per §3.2); all other activated invariants gating and green.
8. Full activated L0–L5 regression green; CI builds with warnings-as-errors; no L0/L5 skip introduced; deterministic golden model (v1.1 §8.2) unchanged and green.
9. `TESTING_READINESS.md` produced containing §6.2 in substance, so the boundary travels with the build.
10. v1.2 retired/removed from the handoff; only v1.1 + this v2.0 are referenced.

NOT done if any stub is silent/invisible/unreported, any error path is non-loud, INV-4 is asserted only against the synthetic sink, the contract/invariants/pipeline were altered, or §6.2 is not written down.

---

## 8. Milestone-specific tests (write first, per v1.1 §7)

### 8.1 Real-caps numeric-drift (extends v1.1 §8.4 / INV-4)
Mock device-caps provider returns realistic `LOGPIXELSX/Y`, `PHYSICALOFFSETX/Y`, `PHYSICALWIDTH/HEIGHT`, `HORZRES/VERTRES` for representative label devices (203/300/600 dpi-class). Known geometry through the real transform path: |error| < 0.5 device dot for path/text/image/stub boxes per profile. Boundary: zero-offset device. Adversarial: device whose printable area < tile content ⇒ `HardwareMarginClip`, never silent loss.

### 8.2 GDI+ primitive correctness (P6)
Per primitive, against the deterministic sink with the v1.1 §8.2 model: arc-conversion fidelity (geometry asserted exactly vs analytic centers/sweeps); gradient stop/alpha; dash pattern; text baseline offset (assert glyph-box top equals contract box top within tolerance); image alpha-over-gradient. Adversarial: malformed `d`, degenerate arc, NaN coords, missing font (→ substitution + notice), non-sRGB image (→ `ImageColorError`).

### 8.3 Doc/page/tile lifecycle (P7)
Multi-page/multi-tile fixture: exactly one `StartPage`/`EndPage` per tile, one `StartDoc`/`EndDoc`; forced mid-job emit failure ⇒ `AbortDoc` + typed error + correct failing page/tile id, never `EndDoc`.

### 8.4 Stub loudness & distinctness (safety test for §3.3)
Fixture with one merge-value `barcode` + one `svg`: both stubs render reserved-style placeholder + literal label within box; both `DegradationNotice`s present on job result with correct payload; operator-preview surfaces them; the three reserved styles (content / barcode-stub / svg-stub) are mutually distinct by the deterministic style signature.

### 8.5 Preview/print parity with stubs (extends v1.1 §8.3 / INV-5)
Same fixture with stubbed nodes → print sink, operator preview, design preview: stub placeholders and their notices identical across all three (a stub must look and report the same in preview as on paper, or operator verification is meaningless).

---

## 9. Changelog → v2.0
- Consolidated to **one** bridge document; **v1.2 superseded and retired**. Codex uses v1.1 (architecture of record) + this v2.0 only.
- Barcode and embedded-SVG: kept in schema/pipeline as **loud, tested stubs**; seams and INV-7/INV-6-schema retained and gating; INV-6 rasterization-DPI sub-test moved to pending via the v1.1 §2.1 mechanism.
- **GDI+ specified end-to-end:** real GDI+ rendering of `path`/`text`/`image` at P6 (§4), in addition to the real GDI+ printer-DC sink at P7 (§5) — closes the ambiguity that the trace sink may have stood in upstream of P7.
- Added loud-stub safety contract (§3.3), testing-readiness boundary with the IQ/OQ uncosted-workstream callout (§6), milestone Definition of Done (§7) and tests (§8).
- No change to the v1.1 contract schema, invariants (other than the one tracked INV-6 sub-test status), pipeline graph, MergeTextFitter, TDD harness, or ratified tradeoffs.
