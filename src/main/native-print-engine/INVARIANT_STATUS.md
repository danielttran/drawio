# Invariant Status

| Invariant | Status | Phase |
|-----------|--------|-------|
| INV-1 | Active, covered | Phase 0 |
| INV-3 | Active, covered | Phase 0 |
| INV-7 | Active, covered | Phase 0 |
| INV-2 | Active, covered | Phase 1 |
| INV-2a structural half | Active, covered | Phase 1 |
| INV-4 | Active, covered | Phase 1 |
| INV-2a merge-text half | Active, covered | Phase 4 |
| INV-6 | Active, covered | Phase 3 |
| INV-5 | Active, covered | Phase 5 |

Pending invariants are tracked here but are not part of the gating suite until their activation phase.

Phase 0 coverage note:

- INV-3 is covered by unsupported-major refusal and future-minor degradation tests.
- INV-7 is covered by merge-text and barcode descriptor schema tests.
- INV-1 is covered by the dependency-direction architecture test and by keeping this module independent from draw.io/mxGraph sources.
- INV-2 is covered by dependency-direction checks and path emission tests that consume baked path data verbatim.
- INV-2a structural half is covered by static checks blocking layout/routing/Z-order concepts outside the allowed future merge-text and barcode seams.
- INV-4 is covered by world-transform and numeric-drift tests at 300/600/1200 DPI.
- Phase 2 static text behavior is covered by pre-wrapped-line rendering, vertical alignment, baseline correction, and deterministic font substitution tests.
- INV-6 is covered by retained SVG source validation and one-source/two-DPI raster-size tests.
- INV-2a merge-text half is covered by merge text fitting tests and barcode sizing/error tests behind the renderer seam.
- INV-5 is covered by print/operator-preview/design-preview target tests that assert shared node order, normalized geometry, and correct merge-vs-sample behavior.
- Phase 6 hardening is covered by adversarial JSON corpus, deterministic fuzz ingest, regression-pair tests, and `RESIDUAL_RISK.md`.
