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
- **`src/main/native-print-engine/`**: Isolated C++20 native print engine (`docs/PRINT_ENGINE_SPEC_v1.1.md` + `_v2.0.md` bridge) plus its host-integration layer.
  - Build/test: `cmake -S src/main/native-print-engine -B src/main/native-print-engine/build -DBUILD_TESTING=ON`, `cmake --build … --config Debug`, `ctest --test-dir … -C Debug --output-on-failure`. Catch2 v3 via FetchContent. Strict `/W4 /WX /permissive-`. CI: `.github/workflows/native-print-engine.yml`. Spec matrix: `docs/SPEC_COVERAGE.md`; status: `docs/IMPLEMENTATION_STATUS.md`.
  - **Status: native print accuracy pass partially landed; CTest 87/87 green plus `npm run test:nativeprint-exporter` 5/5 green.**

---

## Native Print — host integration (current state)

End-to-end working: launch webapp → design diagram → **File > Native Print** → dialog with PC printers (enumerated by the C++ engine) → live preview → acknowledge notices → print. Run: `npm run dev` from `E:\Dev\drawio`. Only the in-browser click and a physical sheet remain for the user to exercise.

**Where things live**
- Engine library (INV-1-clean, scanned): `include/print_engine/proto*.hpp`, `src/proto.cpp`, `src/proto_adapter.cpp` + `tests/proto*_tests.cpp`.
- Host (not scanned): `host/host_main.cpp` (framed **stdio** transport), `host/win32_services.cpp` (real EnumPrintersW + GDI+ PNG preview + printer DC w/ AbortDoc; paint/alpha/gradient, raster PNG, SVG arcs, stock/copies/orientation DEVMODE, per-tile pages, and device-side font-substitution notices), `host/stub_services.cpp` (non-Windows), `host/engine_services_factory.hpp`, `host/tools/{smoke,exporter_e2e}.js`.
- Webapp: `src/main/webapp/vite.config.mjs` (broker = Vite middleware, 127.0.0.1 + Origin check, temp-file + ReleaseContract), `plugins/nativeprint.js` (UI + mandatory notice-ack gate; preview uses selected stock DPI), `plugins/nativeprint/exporter.js` (Node-tested bake for common shapes, routed edges, arrowheads, edge labels, gradients/opacity/dashes, zoom-independent), wired in `index.html`.

**Load-bearing constraints (do not regress)**
- INV-1 banned tokens in `include/`+`src/` (incl. comments): draw.io, drawio, mxGraph, mxCell, mxGeometry, mxPerimeter, mxGraphModel, palette, perimeter, edgeRouting, routeEdge, layoutSolver, zOrder. Keep host concepts under `host/`.
- INV-5: preview and print share one trace + one rasterizer; never let draw calls diverge.
- Engine read loop must use low-level `_read`/`read` (fread blocks until buffer full — fatal for small frames).
- Decisions (user-confirmed, override spec defaults): no Electron; broker is the only engine client; bake is in-scope native subset; block-until-real (no stub milestone); browser↔broker localhost hop is a documented dev-only deviation from spec §3.1.

**Remaining work & exact contract schema:** `docs/PRINT_ENGINE_ACCURACY_TODO.md` (the accuracy work order; Appendix A is the authoritative frozen schema). Accuracy pass has landed for §§1, 3, 4, 5, 7 and parts of §§8-9, including bold/italic text propagation, tile-stacked preview composition, robust stroke scaling, and physical copy iteration. Still spec-blocked: §2 real text metrics/shaping and §6 hardware-margin policy (both marked `[ESCALATE]`), plus custom-stock protocol shape and hardware/golden-image validation that need spec/harness decisions. Embedded-SVG rendering has its own work order: `docs/PRINT_ENGINE_SVG_TODO.md` (decided: resvg via a hand-owned C ABI in a runtime-loaded Rust cdylib, librsvg+cairo swappable behind the same ABI; engine stays rasterizer-agnostic per INV-1).

---

## Important Rules & Constraints
1. **Never make upstream contributions**: Commit and push only to your fork (`danielttran/drawio`).
2. **Build bats over make**: If there is a `build.bat` present, use it. Do not use make.
3. **Save tokens**: Keep this `MEMORY.md` updated so future turns can quickly understand the active state and repository design.
