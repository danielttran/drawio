# Residual Risk

Phase 6 hardening status for `docs/PRINT_ENGINE_SPEC_v1.1.md`.

## Accepted / Open Risks

- **SVG rasterizer library:** The implementation currently uses a deterministic seam-level raster trace. A concrete SVG library still requires license clearance before shipping preview/print binaries.
- **Radial gradient fidelity:** Characterized as an accepted GDI+ approximation risk in the spec. The current trace engine records the feature boundary but does not yet pin real GDI+ pixels.
- **Font substitution:** Deterministic substitution to Arial is pinned in tests. Real host font discovery can still vary and must remain behind the same notice behavior.
- **Barcode SDK adapter:** The real enLabel SDK adapter is deferred. The current barcode seam rejects unencodable values and fixed-DPI raster representation in tests.
- **Printer driver validation:** The deterministic trace target is stable, but real label stock and driver behavior still need manual validation before production use.

## Regression Policy

The test suite is cumulative. Phase tests are append-only unless a schema major bump documents why a behavior changed. L0 invariant tests and numeric-drift tests are gating.
