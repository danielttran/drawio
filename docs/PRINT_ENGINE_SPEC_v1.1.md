# Native Print Engine — System Design & TDD Implementation Spec

**Version:** 1.1 (supersedes 1.0; changelog at §13)
**Audience:** an autonomous coding agent implementing this engine.
**Authority:** this document is the contract. Where it is silent or you find a contradiction, STOP and ask — do not infer. Confident inference on an unspecified point is the primary defect class this project guards against.
**Inputs status:** the schema is designed without sample `.drawio` files or a real merge payload (deliberate — §1.3, §11). Mitigated by mandatory versioning (INV-3), not ignored.

---

## 1. Scope

### 1.1 In scope (build this)
1. **The versioned baked-contract schema** — the frozen interface the engine consumes. The spine. Built and tested first (Phase 0).
2. **The C++ / GDI+ print engine** consuming a baked file, producing printed output and preview images.
3. **The shared SVG rasterizer component** (embedded vector artwork → raster), used by both preview and print.
4. **The merge-resolution seam, the merge-text-fitting component, the barcode seam, and the preview paths** — first-class engine stages with defined interfaces. The barcode implementation and the merge-data *source* are stubbed; the seams and the text-fitting component are real and tested now.

### 1.2 Explicitly deferred (do NOT build, do NOT spec around)
- The bake-at-save exporter (draw.io / mxGraph side).
- Merge data *sourcing* (operator UI, payload transport, payload format).
- Palette / shape-coverage enumeration.
- enLabel's vetted barcode SDK internals — consumed via interface only.
- Image color management (CMYK→sRGB, ICC) — happens in the deferred exporter; see precondition §3.5.

The engine **only ever deals with baked files**. It has zero knowledge of draw.io, mxGraph, the merge transport, or the palette. Any code violating this is a defect regardless of whether it "works."

### 1.3 Confirmed requirements driving the design
- **Field-fill only.** Merge never changes layout/structure. The engine never recomputes *structural diagram geometry* (see INV-2, narrowed in v1.1).
- **Operator must verify merged output** before committing a run → an operator print-time merged-preview path is mandatory.
- **Merge can drive barcode values** → barcode symbology is generated at print from a runtime value; it cannot be baked.
- **enLabel has a vetted barcode SDK** → barcode generation is an interface; the real SDK plugs in later.
- **Preview + high-DPI print** → vector artwork is rasterized on demand per consumer DPI from retained source, by one shared rasterizer; preview and print must agree visually.

---

## 2. Architectural principles (testable invariants)

Each invariant has an enforcing test (§8). Violating one is a failing build. Some invariants are **activated** only in the phase that first makes them satisfiable (§2.1); the enforcement rule applies to *activated* invariants.

| ID | Principle | Enforcing mechanism |
|----|-----------|---------------------|
| **INV-1** | Engine consumes only the baked contract. No draw.io/mxGraph/merge-transport/palette types anywhere in the engine. | Static dependency-direction test (§8.5); suite builds & passes with zero draw.io present. |
| **INV-2** *(narrowed in v1.1)* | Engine never recomputes **structural diagram geometry**: shape outlines, perimeter intersections, edge routing, parent/relative resolution, Z-order. These are baked and consumed verbatim. | Architecture test: no perimeter/edge-routing/layout-solver/Z-resolution symbols in engine; structural coords consumed verbatim (§8.5). |
| **INV-2a** *(new in v1.1)* | The **only** render-time layout computation permitted is **merge-text fitting** (line-breaking / size-fitting of merge-bound text whose value is unknown until print) and **barcode module/quiet-zone sizing** (content, not diagram geometry). Both are bounded, isolated in named components (§4.5, §4.2), and exhaustively tested. No other render-time layout exists. | Component-boundary test: text-fitting logic exists only in the MergeTextFitter unit; barcode sizing only behind IBarcodeRenderer. Static text carries pre-resolved breaks and is never re-fitted (§8.2). |
| **INV-3** | Unknown schema **major** → hard refuse, loud, no best-effort render. | Contract test: vN+1 file → typed refusal, zero paint emitted. |
| **INV-4** | Single world transform, contract-units → device-dots. No integer device-unit intermediate anywhere. Paths, text, images, barcodes share the same transform. | Numeric-drift test at 300/600/1200 dpi, sub-half-dot tolerance, all node kinds (§8.4). |
| **INV-5** | Preview and print render from the same baked file through the same P1–P6 pipeline; only output sink and DPI differ. | Preview/print consistency test (§8.3). |
| **INV-6** | Vector artwork rasterized on demand at consumer DPI from retained source; never pre-flattened in the file. | Schema test: `svg.source` opaque; one source → two DPIs test (§8.2). |
| **INV-7** | Merge-bound fields and barcode descriptors exist in schema v1 even though merge plumbing is deferred. | Schema-completeness test: v1 fixture with merge text + barcode descriptor routes through (stubbed) seams (§8.2). |

**Loud-fail bias (regulated-output requirement):** every error path is a typed, explicit failure aborting the affected page/job with a diagnostic. Silent substitution, silent skip, or best-effort partial output is forbidden. A refused label beats a wrong label, always.

### 2.1 Invariant-activation matrix (resolves the v1.0 Phase-0 impossibility)
An invariant test is **activated** in the phase that first makes it satisfiable; before activation it exists as a documented, tracked **pending** entry (NOT a red test in the gating suite, NOT xfail — it is simply not yet in the gating set, listed in `INVARIANT_STATUS.md`). Once activated it is permanently gating and may never be skipped/xfail/removed.

| Invariant | Activated in |
|-----------|--------------|
| INV-1, INV-3, INV-7 | Phase 0 |
| INV-2, INV-2a (structural half), INV-4 | Phase 1 |
| INV-2a (merge-text half) | Phase 4 |
| INV-5 | Phase 5 |
| INV-6 | Phase 3 |

"Full regression green every loop" (§7) means **all activated** invariant + feature tests green. Pending invariants are tracked, not executed as failing.

---

## 3. The baked contract schema (the spine — Phase 0)

### 3.1 Form
JSON, UTF-8. Human-inspectable for fixtures; trivially synthesizable in tests without any draw.io dependency (required for INV-1 test independence). Binary image/SVG payloads are base64 within typed nodes.

### 3.2 Versioning (INV-3)
```json
{ "schema": { "major": 1, "minor": 0 } }
```
- Engine declares `SUPPORTED_MAJOR = 1`, `SUPPORTED_MINOR = 0`.
- `major != SUPPORTED_MAJOR` → `ContractVersionError`, job refused, nothing rendered.
- `minor > SUPPORTED_MINOR` → render, emit `DegradationNotice` (the notice is surfaced, never swallowed).
- **Assumption (not engine-enforceable):** minor bumps are additive/optional-only. The engine cannot verify this; it is an exporter governance rule recorded here so the agent does not attempt to validate semantics it cannot see. If a minor-versioned file fails structural validation, that is a normal typed refusal — the engine does not special-case it.
- Every fixture pins its schema version. New field = minor bump + new fixture. Changed meaning = major bump + migration note.

### 3.3 Document structure (normative)
```
{ "schema": {...},
  "document": { "units": "px", "pages": [ Page, ... ] } }
```

**Page**
```
{ "id": str,
  "size":  { "w": num, "h": num },        // contract units
  "tiles": [ Tile, ... ],                  // physical-sheet tiling; >= 1
  "paint": [ PaintNode, ... ] }            // explicit back-to-front order
```
`paint` is flat and pre-Z-ordered at bake. Engine renders in array order. No parent/child traversal, no Z-resolution (INV-2).

**Tile**
```
{ "origin": {"x":num,"y":num}, "size": {"w":num,"h":num} }
```
One `StartPage`/`EndPage` per tile; clip = tile rect; per-tile origin translate; all through the single world transform (INV-4).

**PaintNode** — discriminated union on `"kind"`:

`kind:"path"` — pre-resolved structural outline (shapes/edges/perimeters/routing already computed at bake; INV-2)
```
{ "kind":"path", "d": "<SVG path syntax, absolute, contract units>",
  "fill": Paint|null, "stroke": Stroke|null }
```

`kind:"text"` — positioned text run. Content is static or merge-bound. **Wrap/overflow semantics differ by content type — read §3.4 carefully.**
```
{ "kind":"text",
  "box": {"x":n,"y":n,"w":n,"h":n},
  "font": {"family":str,"sizePx":n,"weight":n,"italic":bool,"color":"#rrggbb"},
  "align": {"h":"left|center|right","v":"top|middle|bottom"},
  "content":
     { "type":"static",
       "lines": ["pre-wrapped literal line", ...] }      // see §3.4
   | { "type":"merge",
       "key":"FIELD_KEY",
       "sample":"design-time sample string",             // used by design-time preview
       "maxLen": int,                                     // validated max input length
       "wrap":"none|word",                                // fitter behavior (§4.5)
       "overflow":"reject|clip|shrink",                   // policy (§4.3)
       "shrinkFloorPx": num }                             // required iff overflow=="shrink"
}
```

`kind:"image"` — raster artwork (precondition: already sRGB, §3.5)
```
{ "kind":"image", "box":{...}, "format":"png", "data":"base64",
  "aspect":"fill|preserve", "flipH":bool, "flipV":bool }
```

`kind:"svg"` — retained vector artwork (INV-6), rasterized on demand
```
{ "kind":"svg", "box":{...}, "source":"base64 of svg bytes",
  "aspect":"fill|preserve" }
```
`source` is opaque to the engine; only the shared rasterizer (§6) interprets it.

`kind:"barcode"` — symbology descriptor; value static or merge-bound
```
{ "kind":"barcode",
  "box":{"x":n,"y":n,"w":n,"h":n},
  "symbology":"<enum; exact set TBD via SDK, §12>",
  "params": { ... },                       // opaque to engine; passed verbatim to IBarcodeRenderer
  "value":
     { "type":"static","data":"literal" }
   | { "type":"merge","key":"FIELD_KEY","sample":"design sample",
       "maxLen":int,"errorOnUnencodable":true } }
```
Module size / quiet zone vs. runtime value are computed by `IBarcodeRenderer` at print (content sizing, the bounded INV-2a exception — not diagram geometry).

**Paint / Stroke**
```
Paint  = {"type":"solid","color":"#rrggbb","alpha":0..1}
       | {"type":"linear","stops":[{"o":0..1,"color":"#rrggbb","alpha":0..1},...],
          "p0":{"x":n,"y":n},"p1":{"x":n,"y":n}}
       | {"type":"radial", "stops":[...], "center":{"x":n,"y":n}, "radius":n,
          "focus":{"x":n,"y":n} }       // GDI+ PathGradientBrush approximation; documented gap §6.1
Stroke = {"paint":Paint,"width":n,"cap":"butt|round|square",
          "join":"miter|round|bevel","miterLimit":n,"dash":[n,...]|null}
```

### 3.4 Static vs. merge text — wrapping rule (resolves a v1.0 ambiguity)
- **Static text is fully resolved at bake.** It arrives as an explicit ordered `lines` array — each entry is one literal display line. The engine performs **no** wrapping, no measurement, no fitting on static text. It positions the given lines per `align` with baseline correction. (This keeps INV-2 true for static text.)
- **Merge text is unknown until print**, so the engine **must** fit it at render time using the `MergeTextFitter` component (§4.5): apply `wrap` and `overflow` against the resolved value and `box`. This is the *only* text layout the engine performs and is the merge half of the INV-2a exception.
- A `static` node MUST NOT carry `wrap`/`overflow`; a `merge` node MUST carry `wrap`, `overflow`, `maxLen` (and `shrinkFloorPx` iff `overflow=="shrink"`). Validation (§4.1 P2) rejects violations with a typed error.

### 3.5 Image color precondition (resolves a v1.0 ambiguity)
All `image` and `svg` payloads in a baked file are **already in sRGB**. Color management (CMYK→sRGB, ICC) is performed by the deferred exporter, not the engine. The engine MUST NOT contain color-management code. If GDI+ surfaces a non-sRGB/profiled image at runtime, that is a contract violation → typed `ImageColorError`, page refused (loud-fail). The engine does not attempt to convert it.

### 3.6 Schema authority
This schema is **v1.1 frozen for implementation**. Revisions before first real `.drawio` data are expected (§11.2) and handled by the version discipline — never by editing v1.1 in place. Build to v1.1 exactly.

---

## 4. Engine architecture

### 4.1 Pipeline (single direction; each stage independently testable)
```
baked file bytes
 → [P1 Ingest]        decode container, JSON parse, schema-version gate (INV-3)
 → [P2 Validate]      structural validation incl. §3.4/§3.5 rules → typed model OR typed refusal
 → [P3 Merge-Resolve] bind merge text/barcode values via IMergeSource (stub now)
 → [P4 Barcode]       resolved barcode values → barcode graphics via IBarcodeRenderer (stub now)
 → [P5a SvgRaster]    svg nodes → raster at target DPI via shared rasterizer (§6)
 → [P5b ImageDecode]  image nodes → in-memory bitmap (PNG via IStream→Gdiplus::Bitmap)
 → [P5c TextFit]      merge-text nodes → fitted line/size set via MergeTextFitter (§4.5)
 → [P6 Emit]          paint list → GDI+ primitives via the single world transform (INV-4)
 → [P7 Target]        print sink (DEVMODE/DC/tiling)  |  preview sink (in-memory bitmap)
```
P5a/P5b/P5c are listed as distinct stages so granularity is consistent (resolves a v1.0 inconsistency where image decode was hidden inside P6). P3/P4 are **real seams with stubbed implementations**: P3 stub = identity/sample substitution; P4 stub = deterministic placeholder graphic. Seams, data flow, and typed-error contracts are built and tested now so the real `IMergeSource` and vetted barcode SDK drop in later with no core change.

INV-2 lives at P6: structural `path`/`box` coords are consumed verbatim — no perimeter/route/layout/Z math anywhere in P1–P7. The only render-time computation is P5c (merge-text fit) and P4's barcode sizing (INV-2a).

### 4.2 Interfaces (the seams)
```cpp
struct IMergeSource {                 // P3 — real impl deferred; stub = sample/identity
  virtual Result<std::string> Resolve(std::string_view key) const = 0;
  virtual ~IMergeSource() = default;
};

struct IBarcodeRenderer {             // P4 — real impl = enLabel SDK adapter (deferred)
  // value already merge-resolved. MUST return geometry in CONTRACT UNITS
  // (vector path preferred; if raster, see §4.6 constraint), so the emitter
  // places it through the SAME single world transform (INV-4). The
  // implementation MUST NOT internally rasterize to a fixed device DPI.
  virtual Result<BarcodeGraphic> Render(const BarcodeRequest&) const = 0;
  virtual ~IBarcodeRenderer() = default;
};

struct ISvgRasterizer {               // §6 — same instance feeds preview AND print (INV-5)
  virtual Result<RasterImage> Rasterize(std::span<const std::byte> svg,
                                         PxSize boxPx, double dpi) const = 0;
  virtual ~ISvgRasterizer() = default;
};

struct IMergeTextFitter {             // §4.5 — real component, built & tested now
  virtual Result<FittedText> Fit(const FitRequest&) const = 0; // value, box, font, wrap, overflow
  virtual ~IMergeTextFitter() = default;
};
```
`Result<T>` is an explicit success/typed-error type. No exceptions cross seam boundaries; every failure is a value the caller must handle. `Result<T>` is `[[nodiscard]]` **and CI compiles with warnings-as-errors**, so an ignored `Result` fails the build (corrects the v1.0 overstatement that `[[nodiscard]]` alone is a compile error).

### 4.3 Merge overflow policy (validated behavior, per field, decided at design time)
For merge content:
- `reject` → resolved value length > `maxLen`, OR fitted text exceeds `box` with `wrap`/sizing applied ⇒ typed `MergeOverflowError`, page refused. (Default for unsafe-to-truncate regulated text.)
- `clip` → render fitted text clipped to `box`; emit `DegradationNotice`.
- `shrink` → `MergeTextFitter` reduces point size to fit down to `shrinkFloorPx`; still overflowing at the floor ⇒ `MergeOverflowError`.
- Barcode `errorOnUnencodable:true` + value not encodable in `symbology` ⇒ typed `BarcodeEncodeError`, page refused. Never emit a partial/invalid barcode (UDI correctness — non-negotiable).
The engine **enforces** the contract-specified policy; it never **chooses** one.

### 4.4 GDI+ / DC discipline (enforceable rules)
- Printer DC from a merged DEVMODE; label stock via `DMPAPER_USER` + explicit physical dimensions (reuse the established `BuildMergedDevMode` discipline).
- Exactly one world transform contract-units→device-dots, set once per tile. No code path rounds to integer device units before the transform (INV-4). All node kinds pass through it identically.
- Non-printable margin via `PHYSICALOFFSETX/Y`, `PHYSICALWIDTH/HEIGHT` vs `HORZRES/VERTRES`. Tiling: per-tile clip + origin translate; one `StartPage`/`EndPage` per tile.
- Text baseline corrected via `FontFamily::GetCellAscent` (contract `box` is top-left; GDI+ baseline differs). `TextRenderingHintAntiAlias`. Never ClearType on paper. Missing font ⇒ deterministic substitution + `DegradationNotice` (never silent).
- Raster: `InterpolationModeHighQualityBicubic`. Alpha compositing verified over gradient fills (the known failure point).

### 4.5 MergeTextFitter (the bounded render-time layout component — INV-2a)
A single, isolated component. Inputs: resolved string, `box`, `font`, `wrap`, `overflow`, `shrinkFloorPx`. Behavior:
- `wrap:"none"` → single line; if wider than `box.w`, apply `overflow`.
- `wrap:"word"` → greedy word-wrap to `box.w` using GDI+ text measurement; if total height > `box.h`, apply `overflow`.
- `overflow:"shrink"` → monotonic point-size reduction (documented step) until fit or `shrinkFloorPx`; below floor ⇒ `MergeOverflowError`.
This is the **only** place line-breaking/size-fitting exists. Static text never enters it. It is exhaustively tested (boundary: value exactly at `maxLen`; adversarial: zero-width box, single very long unbreakable token, value forcing exactly floor size; numeric: fitted metrics asserted, not eyeballed).

### 4.6 Barcode graphic representation constraint (resolves v1.0 flaw D)
`IBarcodeRenderer` MUST return `BarcodeGraphic` as geometry in **contract units** (preferred: vector path/rectangles for 1D/2D modules). If a future SDK adapter can only produce raster, the adapter MUST produce it at a resolution derived from the *final device DPI for the current tile* and hand the engine enough metadata to place it through the single world transform with **no intermediate fixed-DPI rasterization** — because a barcode rasterized at the wrong DPI then transformed is the label-dimension-drift defect class on the one element where wrong == unscannable == compliance failure. The engine asserts the returned graphic carries contract-unit geometry; a fixed-DPI raster with no DPI provenance ⇒ typed `BarcodeRepresentationError` (loud-fail). This constraint is also tracked in §12.

---

## 5. Output targets & the two previews
Three render consumers, **one pipeline** (INV-5):
1. **Print** (P7 print sink): `StartDoc/StartPage/EndPage/EndDoc`, per tile, device DPI.
2. **Operator print-time merged preview** (mandatory, §1.3): P1–P6 run **with real merge data** (real `IMergeSource`, real barcode SDK at preview DPI) to an in-memory bitmap, so the operator verifies the *actual* output before committing the run.
3. **Design-time preview**: P1–P6 with **no merge data available**; merge nodes render their `sample` text/`sample` barcode value. Used away from the printer.
The only permitted divergence among the three is sink + DPI + (merge data present vs. `sample`). They share P1–P6 byte-for-logic-identically; this is asserted by the preview/print consistency test (§8.3).

---

## 6. Shared SVG rasterizer
- One component implementing `ISvgRasterizer`, linked once, called by every consumer that has `svg` nodes.
- Library: resvg or LunaSVG, behind the interface (swappable). **Licensing must be cleared against enLabel distribution terms before lock — it ships in preview and print (critical path, §12).**
- Rasterizes `svg.source` at the consumer's DPI and node box; same source at preview vs print DPI must be geometrically consistent (INV-5/INV-6 test §8.2).
- The engine never parses SVG bytes itself (INV-1/INV-6).

### 6.1 Documented fidelity gaps (must have characterization tests so they cannot silently worsen)
- **Radial gradient:** GDI+ `PathGradientBrush` is an imperfect match for SVG radial focal semantics. Accepted gap. A **characterization test** renders a fixed radial fixture and pins the current output as the reference; any change to it must be deliberately adjudicated (§8.2), preventing silent regression of an already-approximate feature.
- **Font substitution:** deterministic substitute + `DegradationNotice`; characterization test pins substitution behavior for a known-missing font.

---

## 7. TDD methodology (core working discipline)

**Rule: no feature code before its tests exist and fail for the right reason.** Per unit of work, strictly:
1. **Write tests first**, including ≥1 complex/adversarial case; confirm red for the right reason.
2. **Implement minimally** to green.
3. **Run the full activated regression suite** (every activated invariant + every prior feature test, §2.1). A feature that reds any prior/activated test is not done.
4. **Refactor** under green.
5. **Record** the test permanently. Tests are append-only; weakening/removing one requires a documented reason tied to a schema major bump.

**"Complex tests first" — mandatory four categories per feature** (a feature lacking any is incomplete by definition; do not advance):
- **boundary** (empty paint list, zero-size box, single-point path, merge value exactly at `maxLen`, shrink value forcing exactly `shrinkFloorPx`),
- **adversarial** (malformed `d`, NaN/inf coords, unknown enum, schema minor ahead, truncated base64, merge value at `maxLen+1`, unencodable barcode, `static` node carrying `wrap`, non-sRGB image),
- **regression-pair** (a fixture exercising a *previous* feature, re-asserted unchanged),
- **numeric-invariant** (assert metrics/coordinates analytically — never pixel-eyeballing; §8.4).

**Test independence (INV-1 applied to tests):** every engine test runs against **synthetic baked fixtures** built by hand or by the in-code fixture-builder — never against draw.io/mxGraph output. The full engine test suite must build and pass with **no draw.io artifact present anywhere**. This is what makes the regression suite trustworthy and the immune boundary real.

---

## 8. Test taxonomy & harness

### 8.1 Layers
| Layer | Pins | Independence |
|-------|------|--------------|
| **L0 Invariant** | Activated invariants INV-1..INV-7 directly. | Synthetic. Gating. Never skip/xfail once activated. |
| **L1 Schema/contract** | Version gating, structural validation, every PaintNode kind, §3.4/§3.5 rules, typed refusals. | Synthetic JSON. |
| **L2 Component unit** | Path engine (arc→GDI+), transform/clip stack, stroke/dash, gradients, text baseline/align, MergeTextFitter, image alpha, svg-rasterizer DPI, merge-resolve, barcode seam, overflow policy. | Synthetic. |
| **L3 Pipeline integration** | P1→P7 end to end, print sink + both preview modes. | Synthetic. |
| **L4 Golden render regression** | Output of a frozen synthetic corpus vs frozen references — see deterministic model §8.2. | Synthetic corpus, references in-repo. |
| **L5 Numeric-drift** | INV-4 device-unit fidelity at 300/600/1200 dpi. | Analytic; no reference image. |

### 8.2 Golden render regression — deterministic model (resolves v1.0 flaw C)
GDI+ printer-DC output is **not** bit-deterministic across machines/drivers; exact-pixel goldens on it flake and a flaky suite gets ignored, destroying the no-regression guarantee. Therefore:
- Goldens render to a **deterministic in-memory bitmap sink with pinned configuration** (fixed pixel dimensions, fixed `TextRenderingHintAntiAlias`, fixed bicubic interpolation, pinned font set bundled with the test corpus — never the printer DC).
- **Geometry is asserted exactly**: emitted bounding boxes / path control points / node order compared to analytic expectation with zero tolerance. This is the primary regression signal.
- **Pixels are asserted under an explicit, documented perceptual tolerance** (bounded max per-channel delta + bounded changed-pixel fraction), as a secondary signal that catches rendering changes geometry can't.
- **References are never auto-regenerated.** Any diff fails CI and must be adjudicated in writing: defect (fix) or intended improvement (regenerate + CHANGELOG entry with commit + reason).
- Characterization tests (§6.1) use this same model with the explicit purpose of pinning *approximate* features so they cannot silently worsen.

This is the mechanism delivering "add features without breaking existing ones": every prior feature has a frozen fixture with an exact-geometry assertion plus a tolerance-bounded perceptual check; a regression is caught mechanically pre-merge, deterministically, without flake.

### 8.3 Preview/print consistency (L0, INV-5)
Same fixture → print sink @ device DPI, operator preview sink @ preview DPI, design preview sink @ preview DPI. Assert: normalized-space element bounding boxes equal within tolerance across all three; identical emitted node count and order; merge-resolved content identical between print and operator preview; `sample` content in design preview. Any divergence beyond {sink, DPI, merge-vs-sample} fails.

### 8.4 Numeric-drift (L5, INV-4)
For known geometry (e.g. 100×40-unit box at known origin) compute the analytic device-dot rectangle at 300/600/1200 dpi; render through the engine transform; read back emitted device coords; assert |error| < 0.5 device dot. Run for path, text box, image box, barcode box — proving one shared transform with no integer rounding step (the label-drift defect class as a failing test).

### 8.5 Architecture / dependency-direction (L0, INV-1/INV-2/INV-2a)
- Static: no engine source references draw.io/mxGraph/merge-transport/palette headers or types.
- Static: no perimeter/edge-routing/layout-solver/Z-resolution symbols in the engine; structural coords only read, never derived (INV-2).
- Static: text line-breaking/size-fitting symbols exist only within the `MergeTextFitter` translation unit; barcode sizing only behind `IBarcodeRenderer` (INV-2a).
- Build the entire engine test suite with zero draw.io presence; must pass. Failure ⇒ immune boundary leaked.

### 8.6 Tooling
- C++ test framework: GoogleTest **or** Catch2 — agent chooses one, records the choice in `TEST_TOOLING.md`, never mixes.
- Fixture-builder: a typed C++ helper constructing valid/invalid baked JSON programmatically (no brittle hand-edited JSON for complex/adversarial fixtures).
- CI: builds with **warnings-as-errors**, runs L0–L5 every commit. L0 (activated) and L5 are gating and may never be skip/xfail.

---

## 9. Phased build plan (each phase test-first, §7; activation per §2.1)

**Phase 0 — Contract & harness (spine).** Schema types; version gate (INV-3); structural validation incl. §3.4/§3.5 typed refusals; fixture-builder; chosen test framework; CI with warnings-as-errors; activate INV-1/INV-3/INV-7; `INVARIANT_STATUS.md` listing pending invariants. *Exit:* schema fixtures round-trip; version-gate + dependency-direction tests green; harness passes in a draw.io-free environment; no red gating test exists.

**Phase 1 — Emit core + transform.** Single world transform (INV-4), path engine incl. arc→GDI+, stroke/dash, solid+linear fill, clip/transform container stack. Activate INV-2, INV-2a(structural half), INV-4. *Exit:* L5 numeric-drift green @3 DPIs; path/stroke/fill boundary+adversarial green; first goldens frozen (deterministic sink §8.2).

**Phase 2 — Static text.** Pre-wrapped `lines` rendering, baseline correction, align, font substitution + `DegradationNotice`. No fitting (static never fits, §3.4). *Exit:* static-text unit/boundary/adversarial green incl. "`static` carrying `wrap` ⇒ typed refusal"; golden text fixture frozen; full regression green.

**Phase 3 — Raster image + shared SVG rasterizer.** P5b image (alpha-over-gradient, aspect, flip, bicubic, non-sRGB ⇒ `ImageColorError`); P5a `ISvgRasterizer` integration, consume-time DPI; radial-gradient + font-substitution characterization tests (§6.1). Activate INV-6. *Exit:* alpha-over-gradient golden green; one-source-two-DPIs test green; characterization references frozen; regression green.

**Phase 4 — Merge-resolve, MergeTextFitter, barcode seam.** P3 seam + stub; `MergeTextFitter` fully implemented & exhaustively tested; P4 seam + stub honoring §4.6 representation constraint; overflow policy §4.3 fully enforced. Activate INV-2a(merge-text half). *Exit:* merge-text + barcode-merge fixtures route through seams; every overflow/encode/representation error path yields the correct typed refusal; INV-7 still green; regression green.

**Phase 5 — Targets: print DC + tiling; both previews.** DEVMODE/`DMPAPER_USER`/DC; per-tile clip+translate; `StartDoc..EndDoc`; operator merged preview and design-time preview sinks reusing P1–P6 (INV-5). Activate INV-5. *Exit:* preview/print consistency test green across all three consumers; multi-tile golden green; full L0–L5 green.

**Phase 6 — Hardening.** Adversarial corpus expansion; fuzz JSON ingest; real-driver/label-stock manual validation; residual-risk doc (radial approximation, font substitution, barcode-representation assumptions). *Exit:* documented residual-risk list; suite stable across N consecutive CI runs; zero flake budget on L0/L5.

Phase order is strict; a phase starts only when the prior exit gate is green. Phase 0 is absolute step zero.

---

## 10. Definition of done
Per feature: four-category complex test set authored first and now green; full **activated** L0–L5 regression green; no activated L0/L5 skip introduced; any new golden/characterization reference accompanied by a written justification; no invariant violated; seam errors are typed `Result`s with no ignored returns (enforced by warnings-as-errors). Per phase: its exit gate green **and** cumulative activated regression green.

---

## 11. Ratified tradeoffs (implement as decided — do not re-litigate in code)
1. **Gated draw.io currency** — engine immune by construction; upstream fixes do not flow automatically. Accepted.
2. **Schema designed without real `.drawio`/merge data** — mitigated by mandatory versioning + loud refusal (INV-3). Later revision = controlled major/minor migration + new corpus, never in-place edit. Managed evolution, not latent defect.
3. **Vector artwork rasterized on demand** — only structure satisfying light preview + uncompromised high-DPI print from one source. Cost: native rasterizer dependency; licensing on critical path.
4. **Merge/barcode seams built now, implementations deferred; MergeTextFitter built now in full** — the explicit price of "implement merge later without redesigning the engine." Merge-text fitting cannot be deferred because merge values are unknown until print and fitting is render-time by nature (this is why INV-2 was narrowed and INV-2a added). Accepted.
5. **Loud-fail over best-effort** — refused page beats wrong regulated label. Pervasive, non-negotiable.
6. **Two bounded render-time computations only** — merge-text fitting and barcode module/quiet-zone sizing — isolated in named components, exhaustively tested. Everything else structural is baked (INV-2/INV-2a). Documented and bounded.

## 12. Open items the agent MUST escalate (not infer)
- Exact `barcode.symbology` enum set and `params` shape — pending enLabel SDK interface. Build enum extensibly; stub renders placeholder; do NOT invent symbology specifics.
- `BarcodeGraphic` representation must satisfy §4.6 (contract-unit geometry, no fixed-DPI intermediate). If the future SDK cannot, escalate before adapting — do not silently rasterize.
- Concrete SVG rasterizer library + license clearance (ships in preview and print).
- Test framework choice (GoogleTest vs Catch2): agent may choose, must record, must not mix.
- Any schema ambiguity/contradiction found during Phase 0: STOP and ask. Resolving by inference is the defect class this document exists to prevent.

## 13. Changelog v1.0 → v1.1
- **Flaw A:** INV-2 narrowed to *structural diagram geometry*; added **INV-2a** plus the **MergeTextFitter** component (§4.5) and §3.4 static-vs-merge wrapping rule. Static text now carries pre-wrapped `lines`; merge text is fitted at render time as an explicit bounded exception.
- **Flaw B:** Added the **invariant-activation matrix** (§2.1); pending invariants are tracked, not red — Phase 0 is now internally consistent; "never xfail" applies to *activated* invariants.
- **Flaw C:** Golden regression redefined to a **deterministic in-memory sink** with exact-geometry assertions + bounded perceptual tolerance; references never auto-regenerated (§8.2).
- **Flaw D:** Added **§4.6** barcode-representation constraint (contract-unit geometry, no fixed-DPI intermediate) + `BarcodeRepresentationError`; tracked in §12.
- **Ambiguities:** static-vs-merge wrap (§3.4); two preview modes split into operator-merged vs design-time (§5); image sRGB precondition + `ImageColorError` (§3.5).
- **Minor:** `[[nodiscard]]` + warnings-as-errors corrected (§4.2/§8.6); pipeline granularity made consistent — P5a/P5b/P5c explicit (§4.1); minor-version-additive stated as an unenforceable assumption (§3.2); radial-gradient + font-substitution characterization tests added (§6.1).
