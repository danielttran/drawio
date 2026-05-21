# draw.io Workspace Memory (MEMORY.md)

## Project Overview & Context
- **Repository**: Local fork of `jgraph/drawio` mapped as `danielttran/drawio`.
- **Purpose**: Local deployment, customization, and developer environment setup.
- **License/Policy**: JGraph does not accept outside pull requests. Do not attempt to push upstream. All code belongs to the local fork.

---

## Local Development Configuration
- **Package Manager**: NPM
- **Local Server**: Vite (dev dependency)
- **Server Entrypoint**: Serving `src/main/webapp/` at `http://localhost:3000`.
- **Running the Server**: `npm run dev`
- **Developer Mode**: `http://localhost:3000/?dev=1` loads unminified sources from `js/diagramly/` and `js/grapheditor/`.

---

## Codebase Architecture
- **`src/main/webapp/`**: web frontend.
  - `js/diagramly/`, `js/grapheditor/`: app and UI.
  - `mxgraph/src/`: mxGraph engine.
  - `plugins/nativeprint.js`: the Native Print dialog.
  - `plugins/nativeprint/exporter.js`: bake (browser-side; harvest path).
- **`src/main/java/`**: Java backend servlets.
- **`etc/build/`**: Ant.
- **`src/main/native-print-engine/`**: C++20 native print engine + Win32 host.
  - Build/test: `cmake -S src/main/native-print-engine -B src/main/native-print-engine/build -DBUILD_TESTING=ON`; `cmake --build … -j`; `ctest --test-dir …`. Catch2 v3 via FetchContent. MSVC `/W4 /WX /permissive-`. CI: `.github/workflows/native-print-engine.yml`.
  - **Status (2026-05-21, post audit-3):** Linux ctest **151/151** green (6 svg-rasterizer-cdylib tests skip cleanly when the resvg shim is not built); exporter `node --test` **125/126** (1 skip = engine binary not built on Linux).

---

## WYSIWYG ARCHITECTURE (settled)

The end-to-end WYSIWYG pipeline (drawio canvas → printed paper) is:

1. **Bake (browser, drawio runtime):** `plugins/nativeprint/exporter.js`
   walks drawio's *own rendered SVG* per cell via `harvestShape` /
   `svgCellNode`. Each cell becomes a contract `kind: "svg"` node whose
   `source` is base64-encoded drawio-rendered SVG. HTML labels
   (`<foreignObject>`) are **transcribed in-place** to plain SVG
   `<text>` / `<rect>` using `Range.getClientRects()` per text fragment
   so the engine never sees foreignObject. Re-derived geometry
   (`rectPath`, `polyPath`, `shapePath`, named-shape outlines) is a
   **headless last resort only**, always with a loud
   `ExporterUnsupportedShape` notice — never silent.

2. **Engine (C++, INV-1-clean):** loads + validates the frozen v1.1
   contract, emits a `RenderTrace` with one `EmittedKind::Svg` per
   harvested cell carrying `svg_source` verbatim. No re-layout.

3. **Host (Windows-only, GDI+ + resvg):** `draw_trace` decodes
   base64, calls `ISvgRasterizer::render(bytes, w, h, dpi)`, converts
   straight RGBA → premul BGRA, blits via GDI+ `DrawImage`. The same
   `ISvgRasterizer*` is threaded into both `render_preview` and
   `print` so preview and print get identical pixels (INV-5 by
   construction).

4. **Backend (Rust cdylib, `host/svg-rasterizer/`):** resvg-0.47
   behind the hand-owned C ABI `host/svg_rasterizer_abi.h`. Panic-safe
   (`catch_unwind` every export). Swap to librsvg/cairo = drop a
   different DLL implementing the same ABI; zero C++ changes.

### The WYSIWYG-killer that WAS silent and is now LOUD (2026-05-20)

resvg's parser **silently skips `<foreignObject>`** and returns
`SPE_SVG_OK` with a fully-transparent output buffer. If any
foreignObject slipped through into `svg_source` (exporter bug, edge
case), the printer would draw a **silent blank box** — the exact C1
violation. Closed in three places (defense-in-depth):

1. **Rust shim (`host/svg-rasterizer/src/lib.rs`)**: byte-level scan
   for `<foreignObject` before parsing; returns
   `SPE_SVG_ERR_UNSUPPORTED` (-3) with a typed message.
2. **Host `draw_trace`**: same scan as defense-in-depth (in case an
   older shim DLL is dropped in); fails loud + crosshatch + named
   notice before ever calling the shim.
3. **Exporter Node tests (`exporter.test.mjs`)**: existing
   `assert.ok(!/<foreignObject/i.test(svg), 'foreignObject NEVER shipped')`
   invariants on every harvest path.

Pinned by `tests/svg_pixel_determinism_tests.cpp`: a real
drawio-flavor corpus (solid fill, linear+radial gradients,
shadow-as-clone, multiline text, marker arrowheads, dashed strokes,
clipPath) all renders to > 0 opaque pixels (no silent blanks); the
foreignObject case returns -3 with `"foreignObject"` in the err
message.

---

## Cross-platform pixel-determinism golden

`tests/svg_pixel_determinism_tests.cpp` opens the real resvg cdylib
via dlopen/LoadLibrary (test-local, NOT through the Windows-only
`SvgRasterizerDll`) and pins:

- ABI handshake + four required exports.
- Byte-identical RGBA for two consecutive renders of the same SVG
  (INV-5 pixel half).
- The pinned pixel contract (straight RGBA8, R,G,B,A, top-down).
- Panic-safety on malformed input (typed status, never UB).
- Buffer-too-small returns the typed `SPE_SVG_ERR_BUFFER_TOO_SMALL`.
- A 5-SVG × 4-size hardening pack (incl. 1×1 and a non-square box)
  all deterministic.
- **The foreignObject refusal contract** (NEW).
- A 9-SVG drawio-flavor realism corpus all producing > 0 opaque
  pixels.

SKIPs cleanly when `SVG_RASTERIZER_LIB` isn't configured.

---

## Custom stock (DMPAPER_USER)

- Wire shape: synthetic `stockId = "custom:<wMicrons>x<hMicrons>"`.
- Parser `host/custom_stock.{hpp,cpp}` — cross-platform, strict; bound
  is `SHRT_MAX * 100` microns (~3.27 m) so DEVMODE
  `dmPaperWidth/Length` (signed SHORT, tenths-of-mm) cannot truncate.
- Host: `merged_devmode_for` recognises the prefix; sets
  `dmPaperSize = DMPAPER_USER` + dims + orientation; merges through
  `DocumentPropertiesW` so `dmDriverExtra` survives.
- UI: `plugins/nativeprint.js` "Custom… (set physical dimensions)"
  option with W×H mm inputs; Print loud-gates on positive dims
  ≤ 3276.7 mm.

---

## Notice taxonomy

| Notice | When | Wire kind |
|---|---|---|
| `StubbedSvgArtwork` | Engine emits unconditionally on every SVG node (v2.0 §3.3 posture, unchanged). Host also emits when rasterization fails — naming the reason in `detail`. | `StubbedSvgArtwork` |
| `SvgArtworkRasterized` | Host emits **on rasterization success**, carrying backend identity (e.g. `"resvg 0.47"`). Additive — operator sees both notices on success. | `SvgArtworkRasterized` |
| `StubbedBarcode` | Engine emits on every barcode node (real adapter deferred). | `StubbedBarcode` |
| `HardwareMarginClip` | Engine emits when content escapes the printable area. | `HardwareMarginClip` |
| `FontSubstitution` | Host emits when a requested font family is not installed. | `FontSubstituted` |
| `MergeClip` | Host emits when text was clipped to its box on `overflow:"clip"`. | `MergeClip` |
| `GradientDirectionApprox` | Exporter emits (once, deduped) when ANY fallback-path paint node carries a gradient fill/stroke. The v1 contract has no `p0/p1` (linear) or `center/focus/radius` (radial), so the host renders linear gradients always L→R and radial gradients always box-centered. Live path (`kind:"svg"`) is unaffected — direction lives inside the literal SVG bytes. | `GradientDirectionApprox` |
| `ExporterUnsupportedShape`, `ExporterUnsupportedImage`, `RichApproximate`, `RichUnsupported` | Exporter side (not engine notices). Bake-time loud notices. `ExporterUnsupportedShape` also fires when `transformPath` rejects a malformed harvested fragment (loud-skip, never silent-drop). | — |

`jobLog.svgRasterizer` records backend name+version or `"none"`.

---

## Audit fixes (rounds 1–4, 2026-05-21)

Closed silent-divergence holes against the C1 WYSIWYG mandate. Each
fix has a red-then-green regression test on the appropriate side.

1. **Z-order**: `buildResult` walked `Object.keys(model.cells)`
   (creation-order dict) → "Send to Back" / "Bring to Front" silently
   re-stacked nothing on print. Now walks `model.getRoot()` via
   `getChildAt`/`getChildCount` depth-first when the model exposes the
   mxGraphModel tree API; the dict iteration remains the fallback for
   minimal Node fixtures only.

2. **Spurious `HardwareMarginClip`**: exporter pads each `kind:"svg"`
   node's box by `SVG_PAD = 2` contract units per side for stroke/marker
   slop. A cell at the canvas top-left (`state.x == bounds.x`) mapped
   to `box.x == -2`, which made `escapes_page` fire on EVERY real print.
   Engine now applies a 4-unit tolerance (= `SVG_PAD * 2`) in
   `escapes_page`; real overhang (> 4 units) still fires the notice.

3. **Silent gradient direction loss on fallback paths**: contract has
   no `p0/p1` / `center/focus/radius`, so the host always renders
   linear gradients L→R and radial gradients box-centered. Fixed by
   emitting a single deduped `GradientDirectionApprox` notice when any
   fallback-path paint node carries a gradient. The live (`kind:"svg"`)
   path is unaffected.

4. **Silent path-fragment drop**: `transformPath` returning null
   (numbers after Z, missing args, etc.) silently lost geometry. Now
   pushes a loud `ExporterUnsupportedShape` notice naming the cell and
   tag; the rest of the shape stays faithful.

5. **Invalid UTF-8 for lone surrogates**: `utf8Bytes` manual fallback
   would emit corrupt 3-byte sequences for unpaired surrogates. Now
   substitutes U+FFFD so the encoded output is always valid UTF-8.

6. **CI on Linux had a self-consistent silent-blank**: the SVG corpus
   determinism test asks resvg to render `font-family="Arial"`, but
   `ubuntu-latest` ships no Arial. fontdb v0.23's `load_system_fonts()`
   is exact-name-match at query time (fontconfig is used for
   enumeration but NOT for alias resolution), so Liberation Sans
   doesn't satisfy an Arial lookup. resvg then silently emits zero
   opaque pixels -- which the test correctly flagged but couldn't
   distinguish from a real C1 bug, so the corpus self-tripped on every
   Linux CI run. Fixed by giving the two text cases a CSS fallback
   chain `Arial, "Liberation Sans", "DejaVu Sans", sans-serif`. Plus
   `fonts-liberation` install on the runner for determinism. Note: the
   underlying "resvg silently blanks unknown fonts" is real for
   non-Windows deployments; the host print path is Win32-only today,
   where Arial is always installed, so it does not affect production
   WYSIWYG. Tracked here as a future audit item if a Linux host is
   ever introduced.

7. **Windows CI swap-acceptance regression**: `fake_svg_rasterizer.c`
   (the §5 swap-acceptance fixture) had no `__declspec(dllexport)`
   decoration and no `WINDOWS_EXPORT_ALL_SYMBOLS`. The ABI header is
   intentionally neutral so the Rust shim's `#[no_mangle]` works
   uniformly, but on Windows that meant the MODULE DLL exported zero
   symbols. The windows-2022 runner image's MSVC was forgiving here
   somehow (or the test had never actually run there); the in-flight
   transition to windows-2025-vs2026 surfaced the latent bug. Fixed
   by setting `WINDOWS_EXPORT_ALL_SYMBOLS ON` on the fake-DLL CMake
   target. Real Rust shim is unaffected.

Test counts moved from 119 + 86 = 205 active to **151 + 125 = 276
active** through these rounds (+34 / +29 in rounds 2/3 cover path-
parser edge cases, transform precision at extreme DPIs, multi-page,
multi-tile, preview/print parity, z-order, theme colors, schema
invariants, Unicode labels, gradient/UTF-8 hardening, and the spurious
HardwareMarginClip regression).

**CI gate status (post-audit, all 10 jobs green):**
- Engine library + tests (Linux, no host) ✅
- Engine + Win32 host + SVG ABI swap test (Windows) ✅
- SVG rasterizer cdylib (resvg, cross-platform) (ubuntu-latest) ✅
- SVG rasterizer cdylib (resvg, cross-platform) (windows-latest) ✅
- Exporter (Node --test) ✅

---

## Load-bearing invariants (DO NOT regress)
- **INV-1**: `include/` + `src/` (engine library) contain no
  drawio/mxGraph concept. Banned tokens: draw.io, drawio, mxGraph,
  mxCell, mxGeometry, mxPerimeter, mxGraphModel, palette, perimeter,
  edgeRouting, routeEdge, layoutSolver, zOrder. Scanned by
  `tests/architecture_tests.cpp`. Host concepts live under `host/`.
- **INV-5**: preview and print share one render trace + one
  rasterizer at the same DPI. Geometry/layout parity (not byte-equal
  pixels, because the driver halftones the print). The shared
  `draw_trace` enforces this; the `ISvgRasterizer*` is threaded into
  both call sites from the same Win32Services instance.
- **C1 / WYSIWYG**: faithful render or a loud notice — never a
  silent divergence (`docs/CLAUDE.md`).
- **C2 / No browser anywhere** in the print guarantee, verification,
  or tests — no headless Chromium, jsdom, in-app pixel oracles,
  screenshot diffs.

---

## Where things live

- **Engine library** (INV-1 scanned): `include/print_engine/*.hpp`,
  `src/*.cpp`, `tests/*.cpp`.
- **Host** (not scanned, Windows-only build for win32_services):
  `host/host_main.cpp` (framed-stdio transport),
  `host/win32_services.cpp` (real `EnumPrintersW`, DEVMODE merge incl.
  DMPAPER_USER, GDI+ paint + alpha + gradients + arcs + dashes,
  base64 PNG decode, SVG via `ISvgRasterizer*`, foreignObject
  defense-in-depth, per-tile pages, AbortDoc-on-mid-job-failure,
  font-substitution notices, jobLog backend identity),
  `host/stub_services.cpp` (non-Windows fallback),
  `host/svg_rasterizer.{hpp,cpp}` (LoadLibraryW + handshake),
  `host/svg_rasterizer_abi.h` (hand-owned ABI),
  `host/custom_stock.{hpp,cpp}` (parser; cross-platform),
  `host/svg-rasterizer/` (Rust resvg cdylib with foreignObject guard),
  `host/test_support/fake_svg_rasterizer.c` (swap-acceptance shim).
- **Webapp**: `src/main/webapp/vite.config.mjs` (broker = Vite
  middleware, localhost-only, Origin check),
  `plugins/nativeprint.js` (UI, notice-ack gate, custom-stock dims,
  preview uses selected stock DPI),
  `plugins/nativeprint/exporter.js` (Node-tested bake; harvest path).

---

## Important Rules & Constraints
1. **Never make upstream contributions** — fork only.
2. **Save tokens**: keep this `MEMORY.md` updated.
3. **No browser in print verification** — see `docs/CLAUDE.md` C2.
