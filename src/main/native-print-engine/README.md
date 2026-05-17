# Native Print Engine

This directory is the isolated C++ implementation home for `docs/PRINT_ENGINE_SPEC_v1.1.md`.

The engine is intentionally separate from draw.io web code. It consumes only the baked JSON contract and must build/test without any draw.io or mxGraph source present.

## Current Phase

Phase 0: contract and harness.

Implemented here:

- CMake C++20 build with warnings as errors.
- Catch2 test framework selection.
- Version-gated baked contract loader.
- Typed contract refusal surface.
- Fixture builder for synthetic baked JSON.
- Invariant status tracking.

Still required before claiming the full Phase 0 exit gate:

- A recorded red-to-green TDD log for each feature slice, if the project wants auditable proof beyond the committed tests.

## Build

```powershell
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build
ctest --test-dir build --output-on-failure
```
