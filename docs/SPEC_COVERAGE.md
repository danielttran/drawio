# PRINT_ENGINE_SPEC_v1.1 and v2.0 Coverage

This matrix maps `docs/PRINT_ENGINE_SPEC_v1.1.md` and the v2 bridge in `docs/PRINT_ENGINE_SPEC_v2.0.md` to implementation/test coverage in this module.

## Coverage Legend

- **Covered:** implemented and pinned by automated tests.
- **Seam-covered:** interface/trace behavior is implemented and tested, but the production adapter is intentionally deferred or blocked by a spec open item.
- **Deferred/Open:** the spec explicitly says not to infer or build this yet.

## Section Coverage

| Spec Area | Status | Evidence |
|-----------|--------|----------|
| 1.1 versioned baked contract schema | Covered | `contract_loader_tests.cpp`, `contract_validation_tests.cpp` |
| 1.1 C++ print engine consuming baked files | Seam-covered | deterministic print trace target in `renderer.cpp`; Phase 5 tests |
| 1.1 shared SVG rasterizer | Deferred/Open under v2.0 | retained SVG source validation remains; real rasterizer deferred as a loud stub |
| 1.1 merge, text fitting, barcode seams | Covered/seam-covered | Phase 4 tests; barcode SDK internals deferred |
| 1.2 bake-at-save exporter | Deferred/Open | explicitly out of scope |
| 1.2 merge data sourcing | Deferred/Open | real source deferred; runtime map seam tested |
| 1.2 barcode SDK internals | Deferred/Open | exact SDK adapter and symbology set blocked by spec section 12 |
| 1.2 color management conversion | Deferred/Open | engine refuses ICC/profiled PNG and does not convert |
| 2 INV-1 baked-only dependency | Covered | `architecture_tests.cpp` |
| 2 INV-2 no structural geometry recomputation | Covered | architecture checks and path verbatim/normalization tests |
| 2 INV-2a bounded runtime layout | Covered/seam-covered | static text does not fit; merge fitting tests; barcode sizing seam tests |
| 2 INV-3 major version refusal | Covered | contract version tests |
| 2 INV-4 single transform/no integer intermediate | Covered | numeric drift tests for path, text, image, SVG, barcode |
| 2 INV-5 one P1-P6 pipeline for print/preview | Covered | Phase 5 target/preview consistency tests |
| 2 INV-6 SVG retained source, consumer-DPI rasterization | Partially covered/pending | source retention covered; rasterization-DPI sub-test pending per v2.0 section 3.2 |
| 2 INV-7 merge/barcode descriptors in schema v1 | Covered | Phase 0 descriptor tests |
| 3.1 JSON UTF-8 fixture-friendly form | Covered | synthetic JSON tests |
| 3.2 versioning and degradation notice | Covered | major refusal and future minor notice tests |
| 3.3 page/tile/paint structure | Covered | page/tile validation and all paint-node kind tests |
| 3.3 path nodes | Covered | absolute path parser, H/V normalization, arc command tests |
| 3.3 text nodes | Covered | static and merge text tests; alignment and overflow tests |
| 3.3 image nodes | Covered/seam-covered | PNG/base64/aspect/flip/schema tests; real GDI+ decode deferred |
| 3.3 SVG nodes | Seam-covered | base64/aspect/source retention and loud-stub geometry tests |
| 3.3 barcode nodes | Seam-covered | static/merge value tests; real SDK adapter deferred |
| 3.3 Paint/Stroke | Partially covered | solid/linear/radial accepted structurally; stroke enum/dash validation covered; real gradient pixels deferred |
| 3.4 static vs merge wrapping rules | Covered | static wrap refusal, static no-fit tests, merge fitter tests |
| 3.5 image color precondition | Covered/seam-covered | PNG `iCCP` refusal; no conversion code |
| 4.1 P1-P7 pipeline | Seam-covered | trace pipeline tests; real printer DC adapter deferred |
| 4.2 seam result discipline | Covered | typed `Result` paths and warnings-as-errors build |
| 4.3 merge overflow policy | Covered | reject, clip, shrink, maxLen, missing value tests |
| 4.4 GDI+ / DC discipline | Seam-covered | transform/tiling trace tests; real GDI+ printer DC not implemented |
| 4.5 MergeTextFitter behavior | Covered | word/no-wrap, shrink, clip, reject, maxLen tests |
| 4.6 barcode representation constraint | Seam-covered | v2 loud stub produces no fixed-DPI raster output; real SDK blocked |
| 5 print/operator/design previews | Covered/seam-covered | target trace tests and merge-vs-sample assertions |
| 6 shared SVG rasterizer | Deferred/Open under v2.0 | loud stub seam tested; concrete library/license open |
| 6.1 radial/font characterization | Partially covered | font substitution pinned; radial gradient pixel characterization awaits real deterministic bitmap/GDI+ sink |
| 7 TDD methodology | Process-covered | cumulative append-only tests; red-first history not fully auditable for earliest slices |
| 8 L0-L5 taxonomy | Covered/seam-covered | L0/L1/L2/L3/L5 trace coverage; L4 pixel goldens await deterministic bitmap sink |
| 9 phases 0-6 | Covered/seam-covered | tests grouped by phase 0-6 |
| 10 definition of done | Partially covered | automated suite green; pixel goldens and production adapters remain open |
| 11 ratified tradeoffs | Covered by design docs | `RESIDUAL_RISK.md`, `IMPLEMENTATION_STATUS.md` |
| 12 open items | Deferred/Open | exact barcode SDK, SVG library license, real adapter details |
| v2.0 section 3 barcode loud stub | Covered | Phase 4 and Phase 7 stub tests; spec-literal label and structured `StubbedBarcode` notices |
| v2.0 section 3 SVG loud stub | Covered | Phase 7 stub tests; structured `StubbedSvgArtwork` notices |
| v2.0 section 4 GDI+ surface config/primitive seam | Seam-covered | mockable native surface trace config and draw-kind tests |
| v2.0 section 4 image decode failure | Covered/seam-covered | native surface `ImageDecodeError` test; real GDI+ bitmap adapter still open |
| v2.0 section 5 DEVMODE custom stock | Seam-covered | `DMPAPER_USER` model and driver-private byte preservation tests |
| v2.0 section 5 printer lifecycle | Seam-covered | invalid caps and preflight failures happen before StartDoc; StartDoc/StartPage/EndPage/EndDoc and AbortDoc-on-mid-job-failure tests |
| v2.0 section 5 hardware margins | Covered | content-based `HardwareMarginClip` notice tests with mock caps |
| v2.0 section 5 real-caps numeric drift | Covered | 203/300/600 DPI-class mock caps test |
| v2.0 section 6 testing boundary | Covered | `TESTING_READINESS.md` |

## Current Automated Coverage Summary

- Test count: 58
- Coverage includes L0 invariants, contract validation, component behavior, pipeline trace integration, numeric drift, and adversarial/fuzz ingest.
- The suite is synthetic and independent of draw.io/mxGraph artifacts.

## Not Honestly Fully Covered Yet

The following are intentionally not claimed as complete because the spec itself requires external choices or real hardware/adapter validation:

- Real Win32/GDI+ printer DC implementation and driver/label-stock validation.
- Real deterministic bitmap/pixel golden corpus.
- Concrete SVG rasterizer library and license clearance.
- Real enLabel barcode SDK adapter and exact symbology/params.
- Radial-gradient pixel characterization under the eventual deterministic bitmap sink.
