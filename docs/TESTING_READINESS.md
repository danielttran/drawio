# Testing Readiness

This build implements the `PRINT_ENGINE_SPEC_v2.0` bridge boundary for hardware-free native print testing.

## Delivered for Testing

- The v1.1 baked contract, invariants, pipeline shape, merge text behavior, and print/preview trace paths remain intact.
- Barcode nodes are retained in the schema and pipeline, but render as loud barcode stubs for this milestone.
- Embedded SVG artwork nodes are retained in the schema and pipeline, but render as loud SVG artwork stubs for this milestone.
- Stubbed barcode and SVG output is surfaced through structured `DegradationNotice` records and visible reserved styles.
- A native-print bridge now covers mockable GDI surface behavior, printer device caps validation, preflight failures before StartDoc, content-based hardware-margin notices, DEVMODE custom stock discipline, and document/page/tile lifecycle.
- Typed loud failures now include native image decode and print device errors in addition to the existing contract/merge/color errors.

## Explicitly Not Production-Ready

- Real scannable barcode rendering is not delivered. Barcode output is intentionally unscannable and marked as a stub.
- Real embedded SVG artwork rasterization is not delivered. SVG output is intentionally marked as a stub.
- Hardware-in-the-loop qualification is not delivered. Printer model coverage, physical label-stock dimensional checks, DPI/margin checks on real media, and barcode scan validation are a separate IQ/OQ validation workstream.
- Rasterizer library license clearance is not complete.
- Barcode SDK feasibility and representation details remain a human/vendor decision before the barcode stub can be lifted.

A passing test run means the engine is ready for native-print bridge testing of non-barcode, non-SVG-artwork content. It is not safe for regulated production label output.
