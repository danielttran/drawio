# draw.io Workspace Memory (MEMORY.md)

## Project Overview & Context
- **Repository**: Local fork of `jgraph/drawio` mapped as `danielttran/drawio`.
- **Purpose**: Local deployment, customization, and developer environment setup.
- **License/Policy**: JGraph does not accept outside pull requests. Do not attempt to push upstream. All code belongs to the local fork.

---

## Local Development Configuration
- **Package Manager**: NPM
- **Local Server**: Vite (dev dependency)
- **Root Configuration**: `package.json` at root (`E:\Dev\drawio\package.json`)
- **Server Entrypoint**: Serving `src/main/webapp/` at `http://localhost:3000`.
- **Running the Server**: `npm run dev`
- **Development vs. Production Modes**:
  - **Standard Run**: Accessing `http://localhost:3000/` loads the minified production bundle `js/app.min.js`.
  - **Developer Mode**: Accessing `http://localhost:3000/?dev=1` (or `?dev=1&test=1`) forces the app to bypass the minified bundle and load the individual source scripts directly from `js/diagramly/` and `js/grapheditor/`, enabling live debugging and code changes.

---

## Codebase Architecture
- **`src/main/webapp/`**: The core frontend static directory.
  - `index.html`: Main HTML template.
  - `js/bootstrap.js`: Handles URL parameters, electron check, and loading script blocks dynamically.
  - `js/diagramly/`: Primary application controllers, files, and clients (e.g. `App.js`, `EditorUi.js`, etc.).
  - `js/grapheditor/`: Graphical UI elements and shape libraries.
  - `mxgraph/src/`: Core mxGraph graph visualization engine source.
- **`src/main/java/`**: Java backend server servlets.
- **`etc/build/`**: Build scripts using Apache Ant (`build.xml`).
- **`src/main/native-print-engine/`**: Isolated C++20 native print engine scaffold for `docs/PRINT_ENGINE_SPEC_v1.1.md` plus the `PRINT_ENGINE_SPEC_v2.0.md` native-print bridge.
  - Current phase: Phases 0-6 have tested C++ slices; first v2 bridge slice has tested native seams; production Win32/GDI+ and hardware validation remain for spec-governed open items.
  - Build/test: `cmake -S src/main/native-print-engine -B src/main/native-print-engine/build -DBUILD_TESTING=ON`, `cmake --build src/main/native-print-engine/build --config Debug`, `ctest --test-dir src/main/native-print-engine/build -C Debug --output-on-failure`.
  - Test tooling: Catch2 v3 via CMake FetchContent.
  - Implemented: baked contract loader, typed contract errors, fixture builder, invariant status, INV-1/INV-2/INV-2a structural architecture checks, schema/version/merge-text/barcode descriptor tests, deterministic Phase 1 trace sink, path parser, world transform, numeric drift tests, Phase 2 static pre-wrapped text rendering/alignment/baseline/font substitution tests.
  - Phase coverage now includes Phase 3 image/SVG seams, Phase 4 merge text fitting and v2 barcode stub, Phase 5 print/operator/design preview traces, Phase 6 adversarial/fuzz hardening, and Phase 7/v2 bridge tests for degradation notices, SVG/barcode loud stubs, device caps validation, preflight-before-StartDoc, DEVMODE, content-based hardware margins, lifecycle, and AbortDoc.
  - Latest verification: CMake build green and CTest green 58/58 after v2 bridge audit.
  - Spec coverage matrix: `src/main/native-print-engine/SPEC_COVERAGE.md`.
  - CI wiring: `.github/workflows/native-print-engine.yml`.

---

## Important Rules & Constraints
1. **Never make upstream contributions**: Commit and push only to your fork (`danielttran/drawio`).
2. **Build bats over make**: If there is a `build.bat` present, use it. Do not use make.
3. **Save tokens**: Keep this `MEMORY.md` updated so future turns can quickly understand the active state and repository design.
