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
  - **Status: native print accuracy pass landed & audited; CTest 96/96 green plus `npm run test:nativeprint-exporter` 54/54 green.**

---

## Native Print — host integration (current state)

End-to-end working: launch webapp → design diagram → **File > Native Print** → dialog with PC printers (enumerated by the C++ engine) → live preview → acknowledge notices → print. Run: `npm run dev` from `E:\Dev\drawio`. Only the in-browser click and a physical sheet remain for the user to exercise.

**Where things live**
- Engine library (INV-1-clean, scanned): `include/print_engine/proto*.hpp`, `src/proto.cpp`, `src/proto_adapter.cpp` + `tests/proto*_tests.cpp`.
- Host (not scanned): `host/host_main.cpp` (framed **stdio** transport), `host/win32_services.cpp` (real EnumPrintersW + GDI+ PNG preview + printer DC w/ AbortDoc; paint/alpha/gradient, raster PNG, SVG arcs, stock/copies/orientation DEVMODE, per-tile pages, and device-side font-substitution notices), `host/stub_services.cpp` (non-Windows), `host/engine_services_factory.hpp`, `host/tools/{smoke,exporter_e2e}.js`.
- Webapp: `src/main/webapp/vite.config.mjs` (broker = Vite middleware, 127.0.0.1 + Origin check, temp-file + ReleaseContract), `plugins/nativeprint.js` (UI + mandatory notice-ack gate; preview uses selected stock DPI), `plugins/nativeprint/exporter.js` (Node-tested bake for common shapes, routed edges, arrowheads, edge labels, gradients/opacity/dashes, **embedded-PNG image cells → `kind:"image"`; non-PNG/URL → loud `ExporterUnsupportedImage`**, zoom-independent), wired in `index.html`.

**Load-bearing constraints (do not regress)**
- INV-1 banned tokens in `include/`+`src/` (incl. comments): draw.io, drawio, mxGraph, mxCell, mxGeometry, mxPerimeter, mxGraphModel, palette, perimeter, edgeRouting, routeEdge, layoutSolver, zOrder. Keep host concepts under `host/`.
- INV-5: preview and print share one trace + one rasterizer; never let draw calls diverge.
- Engine read loop must use low-level `_read`/`read` (fread blocks until buffer full — fatal for small frames).
- Decisions (user-confirmed, override spec defaults): no Electron; broker is the only engine client; bake is in-scope native subset; block-until-real (no stub milestone); browser↔broker localhost hop is a documented dev-only deviation from spec §3.1.

**Audit (2026-05-17, 2 rounds): NO functional bugs.** Engine **96/96** ctest, exporter **54/54**, `/W4 /WX` clean, INV-1/INV-5 + schema/version gate intact, live e2e correct; arc math = W3C F.6.5; DEVMODE/PrinterHandle RAII no leaks. Tech-debt resolved: positional `EmittedCommand` init → C++20 designated initializers. **Text-property audit (2026-05-17): underline & strikethrough were dropped at every layer (exporter never read fontStyle bits 4/8; schema/renderer/sink had no field) — FIXED end-to-end** (additive optional `font.underline`/`font.strikethrough`, default false → backward-compatible; GDI+ `FontStyleUnderline`/`Strikeout`); italic+underline now renders both, visually verified. All other text props (family/size/bold/italic/color/align/wrap/overflow/multiline) audited correct.

**WYSIWYG-parity safety net (tested, extensive).** The exporter is a named-shape subset — NOT pixel-identical to drawio for every stencil by design. The tested guarantee: every drawio object is faithful OR loudly `ExporterUnsupportedShape`-flagged (operator-acked) — never silently wrong — and every contract is schema-valid so the engine never silently rejects/diverges. `exporter.test.mjs` (54): per supported shape, 14+ unsupported stencils, fill/stroke/gradient/opacity/dash/cap/join, **fontStyle bitmask matrix (bold=1/italic=2/underline=4/strikethrough=8 + combos incl. italic+underline=6)**, h×v align matrix, multiline/HTML-strip, edge variants, **image cells (PNG faithful as `kind:"image"`; non-PNG/URL/missing → specific `ExporterUnsupportedImage`)**, zoom-independence, complex sweep, **real-engine cross-process render**. `tests/wysiwyg_parity_tests.cpp` (engine side): every exporter shape/attr through `render_to_trace` + geometry preserved + loud-reject of non-conformant contracts. Preview==print is structural (one `draw_trace`, INV-5). NOTE: this proves the *no-silent-divergence safety invariant*, not pixel-perfection vs drawio for loud-degraded stencils.

**§2 text metrics was NOT actually blocked — re-decided & implemented.** Owner directive "as accurate as possible, WYSIWYG" is the standing tie-breaker (not an open escalation). §2 = **measure-at-the-sink** (DONE & audited): engine text path is a pure pass-through (raw text + node box + align/wrap/overflow/shrink policy; only metric-independent guards stay — missing-merge, value>maxLen); `draw_trace` does real GDI+ `MeasureString` word-wrap / shrink-to-fit / h+v align / clip+`MergeClip` notice / loud `MergeOverflowError` reject; preview & print share that code (INV-5). Host e2e visually verified. §6 hardware-margin = **decided + already implemented** (true-size, never silent scale, loud clip notice); only HIL validation remains. These are NOT escalations anymore — the WYSIWYG directive resolves accuracy-vs-other trade-offs here.

**Remaining work & exact contract schema:** `docs/PRINT_ENGINE_ACCURACY_TODO.md` (the accuracy work order; Appendix A is the authoritative frozen schema). Accuracy pass landed & audited for §§1, 2, 3, 4, 5, 6, 7 and the named-subset of §8; §9 partial (preview DPI follows selected stock; golden harness deferred). Genuinely-external remaining (not decisions): the SVG rasterizer library, the barcode SDK adapter, the host golden-image CI harness, the custom-stock protocol shape, and printer hardware-in-the-loop validation. Embedded-SVG rendering has its own work order: `docs/PRINT_ENGINE_SVG_TODO.md` (decided: resvg via a hand-owned C ABI in a runtime-loaded Rust cdylib, librsvg+cairo swappable behind the same ABI; engine stays rasterizer-agnostic per INV-1). Rich-text (drawio HTML labels): **code-grounded implementation plan landed — `docs/PRINT_ENGINE_RICHTEXT_PLAN.md`** (authoritative; supersedes the planning part of `PRINT_ENGINE_RICHTEXT_TODO.md`). **Schema gate CLEARED**: owner authorized additive `content.type:"rich"` on **v1.x** (2026-05-18; same additive pattern as underline/strikethrough). Metrics gate already cleared (§2). No blocking gates — ready at Phase 1. Highest-accuracy approach: exporter walks the **live rendered label DOM** (`state.text.node`, true WYSIWYG via getComputedStyle), emits a neutral `paragraphs→runs` model; engine forwards verbatim (INV-1, no HTML); the one shared sink `draw_trace` is generalized single-font→multi-run (preview==print, INV-5). Print path stays 100% browser-free. Approach: parse HTML→neutral run model in the exporter; `draw_trace` extends its measured layout to per-run styling. Explicitly NOT via the SVG/foreignObject path (resvg can't render it).

---

## Important Rules & Constraints
1. **Never make upstream contributions**: Commit and push only to your fork (`danielttran/drawio`).
2. **Build bats over make**: If there is a `build.bat` present, use it. Do not use make.
3. **Save tokens**: Keep this `MEMORY.md` updated so future turns can quickly understand the active state and repository design.


## Rich-text implementation progress (2026-05-18)
- Landed: exporter rich extraction/flag/fallback; contract rich validation; renderer/native bridge forwarding of `rich_paragraphs`; sink paragraph align/indent + paragraph-run style measurement/draw + rich font-substitution notices; loader unknown-type hard refusal.
- Audit fix (2026-05-18): rich underline/strikethrough now bind to each emitted text segment directly (instead of style-heuristic run lookup), preventing decoration bleed/miss when multiple runs share family/size but differ in flags.
- Still open: full mixed-run intra-line layout (run-level wrap/advance/baseline), rich golden suite + host e2e/hardware validation.
