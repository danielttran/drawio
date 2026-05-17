# Implementation Status

All phases from `docs/PRINT_ENGINE_SPEC_v1.1.md` have an implemented, cumulative, tested C++ slice in this module. The first `docs/PRINT_ENGINE_SPEC_v2.0.md` native-print bridge slice is also implemented and tested.

## Completed Phase Gates

- **Phase 0:** Contract loader, schema/version gate, typed errors, fixture builder, Catch2 tooling, CI workflow, active INV-1/INV-3/INV-7 tests.
- **Phase 1:** Deterministic emit trace, path parser, single world transform, path/stroke/fill validation, numeric-drift tests at 300/600/1200 DPI.
- **Phase 2:** Static pre-wrapped text rendering, alignment, baseline correction, and preservation of requested font family for device-side substitution notices.
- **Phase 3:** Raster image validation, image payload propagation into the host GDI+ decoder/draw path, non-sRGB refusal, retained SVG source validation, and v2 loud SVG stub geometry through the shared transform.
- **Phase 4:** Merge source seam, merge text fitting, overflow handling, barcode seam, and v2 loud barcode stub behavior with structured degradation notices.
- **Phase 5:** Print trace wrapper, tiling, operator preview, design-time preview, print/preview consistency checks.
- **Phase 6:** Adversarial ingest corpus, deterministic fuzz ingest, regression-pair tests, residual-risk documentation.
- **Phase 7 / v2 bridge:** Structured degradation notices, spec-literal loud barcode/SVG stubs, mockable native GDI surface trace, printer device caps validation, preflight-before-StartDoc failure behavior, content-based hardware-margin notice, DEVMODE stock/copies/orientation merge, document/page/tile lifecycle, AbortDoc-on-failure tests, and host-side paint/alpha/gradient/arc rasterization.

## Verification

Latest local verification:

```text
cmake --build src/main/native-print-engine/build --config Debug
ctest --test-dir src/main/native-print-engine/build -C Debug --output-on-failure
```

The cumulative suite passed locally at 86/86 tests after the accuracy pass audit.
The web exporter suite also passed locally at 5/5 via `npm run test:nativeprint-exporter`.

## Spec-Governed Open Items

These are not inferred in code because the spec says they must be escalated or deferred:

- Concrete SVG rasterizer library and distribution license clearance.
- Exact barcode symbology enum/params from the enLabel SDK.
- Real barcode SDK adapter behavior.
- Real text metrics/shaping model and overflow authority (blocked by `PRINT_ENGINE_ACCURACY_TODO.md` §2 `[ESCALATE]`).
- Hardware-margin policy: fit-to-printable vs true-size-with-clip (blocked by `PRINT_ENGINE_ACCURACY_TODO.md` §6 `[ESCALATE]`).
- Hardware-in-the-loop printer-driver and label-stock validation.
- Full host golden-image/PDF/printer-driver validation harness.

See `SPEC_COVERAGE.md` for the full section-by-section coverage matrix.
