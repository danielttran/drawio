# Native Print Engine

C++20 implementation of `docs/PRINT_ENGINE_SPEC_v1.1.md`. Isolated from
draw.io / mxGraph by construction: builds + tests without any drawio
source present (INV-1, enforced by `tests/architecture_tests.cpp`).

## Status (2026-05-21)

- Phase 0 (contract + harness), Phase 1 (path emit + transform),
  Phase 2 (static text), Phase 3 (raster image + SVG rasterizer seam),
  Phase 4 (merge-resolve seam + barcode seam stubs), Phase 5
  (print/preview targets via Win32 + GDI+), Phase 6 (adversarial /
  hardening), and Phase 7 (v2 native bridge — real `EnumPrintersW`,
  DEVMODE merge incl. `DMPAPER_USER` custom stocks, `StartDoc`/
  `EndDoc` discipline, AbortDoc-on-failure) all green.
- Engine library: `src/` + `include/`. Win32 host: `host/` (compiles
  with the device-free stub on non-Windows so tests run anywhere).
- Cross-platform SVG rasterizer: Rust cdylib in `host/svg-rasterizer/`
  (resvg 0.47 behind the hand-owned `host/svg_rasterizer_abi.h`).
- Test count: **151/151** ctest green on Linux (6 svg-rasterizer-cdylib
  tests SKIP cleanly when the resvg shim isn't built and the
  Windows-only `print_engine_host_tests` target is not generated).
- Active invariants enforced as gating tests: INV-1, INV-2/2a (static
  half), INV-3, INV-4, INV-5, INV-6, INV-7.
- Stubs that remain (per spec §1.2 / §12): barcode renderer (loud
  crosshatch stub until enLabel SDK adapter ships); merge data source
  (loud refusal when a merge value is missing at print).

## Build

```powershell
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

On Windows the host links GDI+ + winspool and produces
`print_engine_host.exe`. The Rust SVG-rasterizer crate
(`host/svg-rasterizer/`) builds independently via `cargo build
--release`; drop the resulting cdylib next to `print_engine_host.exe`.
