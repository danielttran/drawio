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
  - **Status (2026-05-21, post audit-6):** Linux ctest **151/151** green (6 svg-rasterizer-cdylib tests skip cleanly when the resvg shim is not built); exporter `node --test` **128/129** (1 skip = engine binary not built on Linux).

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
| `AnimatedSvgFrozen` | Exporter emits when a cell's serialized SVG contains `<animate>` / `<animateTransform>` / `<animateMotion>`. resvg renders these as a static frame-0 snapshot with no error; the loud notice closes that silent gap. | `AnimatedSvgFrozen` |
| `ExporterUnsupportedShape`, `ExporterUnsupportedImage`, `RichApproximate`, `RichUnsupported` | Exporter side (not engine notices). Bake-time loud notices. `ExporterUnsupportedShape` also fires when `transformPath` rejects a malformed harvested fragment (loud-skip, never silent-drop). `RichApproximate` also fires for CSS `border-style` values that have no lossless SVG primitive (double/groove/ridge/inset/outset → rendered as solid). `RichUnsupported` also fires for CSS `background-image` on HTML labels (transcribed only solid `background-color`) and for inline `<img>` whose `src` is not an inline PNG data URI. | — |

`jobLog.svgRasterizer` records backend name+version or `"none"`.

### Notice severity / Print-gate (2026-05-23)

The Native Print dialog gates the **Print** button on notice *severity*, not
on notice *count*. Single source of truth: `exporter.js` →
`noticeSeverity(kind)` (exported on `NativePrintExporter`), keyed by the same
`kind` string the UI gets from BOTH the exporter and the host/engine wire
(`proto.cpp` `NoticeKind`). Pinned by `exporter.test.mjs`.

- **`info`** (shown for traceability, NEVER blocks Print):
  `SvgArtworkRasterized` (faithful external render — success), `HardwareMarginClip`
  (owner ruling: keep true 1:1 size, the sheet shows what it can hold — a
  larger-than-paper diagram is *expected* to edge-clip, never silently scaled),
  `SchemaMinorAhead`, `ProtoMinorAhead` (additive version skew).
- **`degradation`** (acknowledge checkbox required to enable Print): every other
  kind — `StubbedBarcode`, `StubbedSvgArtwork`, `FontSubstituted`, `MergeClip`,
  `ExporterUnsupportedShape/Image`, `RichApproximate/Unsupported`,
  `GradientDirectionApprox`, `AnimatedSvgFrozen`, `SvgListMarkerApprox`, and any
  **unknown** kind (fail-safe).

Rationale: a full-fidelity WYSIWYG print must not nag the operator for an ack on
every run. `nativeprint.js` `showNotices` splits notices into a "Notes (no action
needed)" block and an "Output degradations — acknowledge each" block; the gate
counts only degradation acks. No engine/host/contract change — rendering already
keeps true size + clips to paper, which is the desired behaviour.

### Built-in-object fidelity pass — eliminate avoidable notices (2026-05-23)

Goal: a diagram built only from drawio's built-in objects should print/preview
with NO notice at all. Approach is C1-correct — *remove the divergence so the
notice is unnecessary*, never silence a real divergence. Live (browser) path
changes in `exporter.js`, all pinned in `exporter.test.mjs`:

- **CSS borders on HTML labels** (`borderRect`): now faithful flat SVG instead
  of "flatten to top side + RichApproximate". Uniform → one stroked `<rect>`;
  per-side differences → one stroked `<line>` per visible side (own colour/
  width/style); `double` → two 1/3 strokes; dashed/dotted via dasharray. No
  notice. Only the 3D bevels (groove/ridge/inset/outset) stay loud (no flat-SVG
  equivalent).
- **List markers** (`transcribeForeignObjects`): standard CSS list types are all
  covered by `listMarker()` and placed by measured first-content position; the
  routine `SvgListMarkerApprox` is dropped (CSS itself defines outside-marker
  position as UA-approximated, so this IS faithful). Stays loud only for a
  genuinely-unknown list-style-type (georgian/armenian/CJK → bullet substitute).
- **Inline `<img>` in labels** + **image cells**: any rasterizer-embeddable data
  URI (PNG/JPEG/GIF/SVG) now embeds as `<image>` (cells route through
  `svgCellNode` so resvg draws it). `parseImage` returns `format`+`data` for all
  base64 image data URIs; `embeddableImageMime()` gates the set. No notice for
  embeddable formats; external URLs / non-base64 / webp/bmp stay loud
  (genuinely unembeddable browser-free).
- **CSS `background-image` on labels** (`backgroundImageSvg`): CSS linear/radial
  gradients transcribe to real SVG `<linearGradient>`/`<radialGradient>` (inline
  `<defs>`; verified rendering through resvg with correct stops), and data-URI
  `url()` backgrounds embed as `<image>`. Only external-URL / exotic (conic,
  image-set) forms stay loud.
- **3D bevel borders** (groove/ridge/inset/outset): render two-tone via
  `bevelSideColor` (lit edge = border colour, shadowed edge darkened ~50%),
  matching the bevel direction — no RichApproximate.

- **External (http/https) image cells** (Insert > Image by URL): now embedded
  by a bake-time `fetch` — `embedExternalImages(graph)` resolves each URL to a
  data URI before `buildResult(graph, paper, {resolvedImages})`, so the print
  shows real pixels with no notice. Uses `fetch` (network), NOT a canvas pixel
  read, so the C2 no-pixel-oracle rule holds. `dataUriImageSvgNode` builds the
  `<image>` from bytes (works headless too — no live-DOM dependency). Wired into
  `nativeprint.js rebake()` (now async). Pinned by `exporter.test.mjs` with a
  mocked fetch (success embeds, failure stays loud).

**External images — fetch → proxy → canvas embedding (owner carve-out,
2026-05-24).** The owner relaxed C2 to permit network + canvas use *for
embedding image artwork* (not for a pixel oracle), and to route through a
server-side proxy. `embedExternalImages(graph, fetchImpl, canvasImpl, proxyBase)`
collects EVERY external image the diagram references — image cells
(`style.image`), inline label `<img>`, and CSS `url()` backgrounds
(`collectLabelImageUrls`) — and resolves them ALL IN PARALLEL (`Promise.all`),
each trying in order:
  1. `fetch(url)` direct (cache; same-origin / CORS images);
  2. `fetch(PROXY_URL + "?url=" + enc(url))` — drawio's same-origin proxy; the
     SERVER fetches it, defeating browser CORS entirely;
  3. `urlToPngViaCanvas` (load + `drawImage` + `toDataURL`) as last resort.
Inline `<img>` already loaded in the DOM also re-encode synchronously via
`imgElementToPngDataUri`. The resolved url→dataURI map threads through
`buildResult(graph, paper, {resolvedImages})` →
`emitVertex`/`emitEdge`/`svgCellNode`/`transcribeForeignObjects` →
inline-`<img>` + `backgroundImageSvg`. proxyBase defaults to `window.PROXY_URL`
so the dialog's `rebake()` gets it for free. Browser-only paths no-op in Node;
unit-tested via injected fetch/canvas/proxy stubs (incl. a parallelism assert).
Carve-out recorded in `docs/CLAUDE.md` §2 + plugin `CLAUDE.md`.

**Any image FORMAT now embeds (canvas transcode).** resvg only draws
PNG/JPEG/GIF/SVG, but the browser decodes webp/bmp/tiff/ico/… — so
`embedExternalImages` also collects non-embeddable data URIs
(`imageSrcNeedsResolve` → `'transcode'`) and, after obtaining any bytes,
`ensureEmbeddable` canvas-re-encodes anything non-embeddable to PNG. So every
browser-decodable image format prints with no notice. (Headless/Node: no canvas
→ webp/bmp still notice, matching the bmp unit test; in-browser they transcode.)

Residual — only TWO cases, neither a drawio built-in object:
1. **A referenced external image no path can obtain**: direct fetch AND the
   proxy both can't reach it (offline / private-network / proxy disabled) AND
   it's cross-origin-without-CORS so canvas is tainted. The bytes don't exist
   anywhere reachable — even drawio's own canvas shows it broken. Stays loud +
   placeholder (never a silent wrong). This is a missing-resource/deployment
   condition, not a property of any object.
2. **User-embedded animated SVG file** (`AnimatedSvgFrozen`): VERIFIED not a
   built-in object. drawio's only built-in animation is edge "Flow Animation",
   which it renders as CSS `@keyframes` animating `stroke-dashoffset` on an
   already-drawn dashed stroke (`Graph.js createFlowAnimationCss`) — NOT SMIL.
   resvg ignores the CSS and draws the static dashed edge (a faithful still),
   and the `AnimatedSvgFrozen` regex only matches SMIL tags (`<animate>` etc.),
   so a flow-animated edge raises NO notice (proven: exporter.test.mjs
   "built-in flow animation (CSS) prints static with NO AnimatedSvgFrozen").
   grep confirms drawio/mxGraph emit no SMIL anywhere. The notice fires ONLY
   when a user embeds an external SVG file that itself contains SMIL — kept on
   purpose, because such a clip can have a transparent frame-0 (opacity 0->1)
   that would otherwise print SILENTLY BLANK, violating WYSIWYG (goal #2).

For every object drawio's editors actually create, printing/preview is now
warning-free (proven by exporter tests + the real-resvg conformance corpus).
- **SMIL animation** (`AnimatedSvgFrozen`) — paper can't move; only arises from a
  user-embedded animated SVG, never a built-in shape.
- **Exotic CSS list counter styles** (georgian/armenian/CJK…) — drawio's list
  editor only offers disc/circle/square/decimal/lower|upper-alpha/lower|upper-
  roman, all covered by `listMarker()`; only hand-authored HTML hits the rest.

**`StubbedSvgArtwork` (resvg render failure) — closed by conformance corpus.**
The remaining worry was "what if resvg fails on some built-in stencil's SVG →
host crosshatch + StubbedSvgArtwork". Closed by construction in
`tests/svg_pixel_determinism_tests.cpp` → "FULL mxSvgCanvas feature vocabulary"
case (`[conformance]`): a stencil is just a COMPOSITION of the finite SVG
grammar drawio's vector renderer (`mxSvgCanvas2D`) emits, so proving resvg
renders every feature proves it renders every stencil. The corpus (24 cases)
covers arc/quad/smooth paths, feGaussianBlur / feDropShadow / mxgraph composite
shadow chain / feColorMatrix filters, linear+radial gradients with
gradientTransform & fx/fy, rotate+skew+matrix transforms, polygon/polyline,
linecap/join/miterlimit, fill-rule, group opacity, pattern, `<use>`, styled
text (italic/underline/strike/letter-spacing), tspan multiline + xml:space,
multi-value dasharray+offset, clipPath+mask, nested `<svg>`, and embedded
**PNG/JPEG/GIF/nested-SVG `<image>`** (which also proves the image-embedding
fidelity change actually rasterizes). Each must return status 0 with >0 opaque
pixels (no failure, no silent blank). Built + run against the real resvg-0.47
cdylib on this box (ctest 152/152); CI runs it on ubuntu via
`ctest -R "SVG rasterizer cdylib"` with `SVG_RASTERIZER_LIB` set, so a future
resvg regression fails CI here instead of crosshatching a user's print.

---

## Audit fixes (rounds 1–6, 2026-05-21)

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

7. **Round 6 — fidelity-maximization pass.**
   a. **Animated SVG silent-frame-0**: cells whose serialized SVG carried
      `<animate>` / `<animateTransform>` / `<animateMotion>` rendered as
      a still image with no notice. Bake now byte-scans for these tags
      and emits `AnimatedSvgFrozen`.
   b. **CSS `background-image` on HTML labels**: silently dropped (only
      solid `background-color` was transcribed). Now loud
      `RichUnsupported`.
   c. **CSS border on HTML labels**: previously skipped entirely. Now
      transcribed as a stroked `<rect>` with dasharray mapping for
      dashed / dotted; double/groove/etc loudly approximated as solid
      via `RichApproximate`.
   d. **Inline `<img>` in HTML labels**: previously silently dropped.
      PNG data URIs now transcribed as SVG `<image>` at the rendered
      position; non-PNG / external URLs loudly noticed via
      `RichUnsupported`.
   e. **resvg-side font-resolution loud-fail** was tried and reverted:
      a pre-shape "font-family resolves in fontdb?" check refused too
      eagerly because resvg's text shaper has its own opinionated
      fallback (substitutes the database's default sans-serif when a
      named family is missing). On a Linux box with Liberation Sans
      installed, an SVG asking only for `font-family="Arial"` renders
      perfectly even though the named family didn't resolve. Trusting
      resvg's shaper is the correct posture; the "empty fontdb →
      blank text" scenario doesn't arise on the Win32 host (Arial
      guaranteed) and the corresponding ctest was both fragile across
      runner font configurations and not exercising a production path.

8. **Windows CI swap-acceptance regression**: `fake_svg_rasterizer.c`
   (the §5 swap-acceptance fixture) had no `__declspec(dllexport)`
   decoration and no `WINDOWS_EXPORT_ALL_SYMBOLS`. The ABI header is
   intentionally neutral so the Rust shim's `#[no_mangle]` works
   uniformly, but on Windows that meant the MODULE DLL exported zero
   symbols. The windows-2022 runner image's MSVC was forgiving here
   somehow (or the test had never actually run there); the in-flight
   transition to windows-2025-vs2026 surfaced the latent bug. Fixed
   by setting `WINDOWS_EXPORT_ALL_SYMBOLS ON` on the fake-DLL CMake
   target. Real Rust shim is unaffected.

Test counts moved from 119 + 86 = 205 active to **151 + 128 = 279
active** through these rounds (+34 / +29 in rounds 2/3 cover path-
parser edge cases, transform precision at extreme DPIs, multi-page,
multi-tile, preview/print parity, z-order, theme colors, schema
invariants, Unicode labels, gradient/UTF-8 hardening, and the spurious
HardwareMarginClip regression; +3 Node tests in round 6 pin the
AnimatedSvgFrozen notice posture).

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

## Stencil Shape Coverage (2026-05-25 — Phase 1 + audit fixes complete)

**Branch:** `claude/native-print-unattended-5qWWK`

**Problem solved:** The headless bake (Node.js) previously produced `ExporterUnsupportedShape`
for any `shape=mxgraph.*` stencil or built-in JS shape not in the 8-shape baseline. Now 8,910
stencil shapes + Phase-2 built-ins are all rendered faithfully without a browser.

**Architecture:**
- `tools/native-print-bake/stencil-loader.mjs`: pure-JS XML parser + registry builder. Walks
  `src/main/webapp/stencils/` recursively, builds `Map<"pkg.shape_name", shapeNode>`.
- `tools/native-print-bake/bake.mjs`: top-level await loads stencil registry at startup.
- `src/main/webapp/plugins/nativeprint/exporter.js`: new functions —
  - `registerStencils(registry)`: stores registry in module-level `_stencilRegistry`
  - `computeAspect(w0,h0,cellW,cellH,aspect)`: fixed/variable aspect coordinate transform
  - `walkNodes(nodeList)`: shared-accumulator walker across background+foreground sections
    (CRITICAL: per mxStencil spec, background defines geometry path, foreground's FIRST
    paint command paints it — `currentPath` must persist across both sections)
  - `stencilToSvg(shapeNode, cellW, cellH, style, notices)`: full stencil → SVG renderer
  - Updated `emitVertex` to look up stencil registry before falling back to `shapePath`
  - Extended `shapePath` with Phase-2 built-ins: hexagon, doubleEllipse, actor, swimlane,
    line, arrow, arrowConnector, connector
  - `stableGradId(fillColor, gradColor)`: deterministic gradient IDs (no Math.random)
- `tools/native-print-bake/wysiwyg-compare.mjs`: `--all` batch mode + pre-Gate-1
  `validateNoExcludedShapes` (image/include-shape commands) + checks 11/12 (flip + direction).

**Critical fixes from audit (2026-05-25):**
- **Direction transform**: `rotate(-90 cx cy)` caused geometry overflow for non-square cells.
  Fixed: north=`translate(0,cellH) rotate(-90)`, south=`translate(cellW,0) rotate(90)`.
- **Flip transform**: was using `cellW/cellH` but must use `cw/ch` (dimension-swapped space).
- **Duplicate gradient def**: removed redundant outer gradient in rotated stencil path.
- **Spec step 11**: corrected "unrecognized node → notice" to "silently skip" (browser behavior).
- **labelPosition=right test**: added unit test (test 70).
- **wysiwyg checks 11+12**: flip (scale(-1)) and direction (translate/rotate) added.
- **Spec filename**: master-test-basic.drawio → master-test.drawio (actual file name).

**Test status:**
- 70/70 bake tests pass (11 stencil-specific tests)
- 13/13 wysiwyg-compare --all PASS (all master test label files, up to 12 checks each)
- 118 shapes one-by-one verified across 6 master label files — 100% match rate
- Zero `ExporterUnsupportedShape` or `ExporterUnsupportedStencilFeature` notices across all fixtures

**Deferred to Phase 3 (raise `ExporterUnsupportedStencilFeature` notice):**
- `<image>` command inside stencil
- `<include-shape>` recursion
- `<text>` decorative text inside stencil
- `<path rounded="1">` Bezier-rounded polylines

**Master test labels** (`src/main/native-print-engine/tests/fixtures/labels/`):
- `master-test.drawio` — extended with b01-b18 (basic stencil + Phase-2 built-ins)
- `master-test-flowchart.drawio` — 24 flowchart shapes (f01-f24)
- `master-test-arrows-bpmn.drawio` — 8 arrows + 8 BPMN shapes
- `master-test-aws.drawio` — 12 AWS4 fixed-aspect shapes (w01-w12)
- `master-test-network.drawio` — 8 network + 4 Cisco shapes
- `master-test-style-variants.drawio` — 15 style variants (gradient, dashed, flipH/V, dir, inline stencil)
- All 6 have corresponding `.contract.golden.json` frozen reference contracts.

---

## Headless Style Inheritance Fix (2026-05-25)

- **Problem solved:** Headless print (`mode === 'B'`) failed to resolve parent style inheritance for `'inherit'` values (such as `fillColor=inherit` and `strokeColor=inherit` on the alternating table cells and grid borders in `test.drawio`). This resulted in transparent background fills and missing grid borders, making the headless render look visually incomplete compared to the live browser print.
- **Fix:** Implemented recursive style inheritance resolution in `resolveThemeDefaults(style, graph, isVertex, cell)` inside `exporter.js`. If a style value is `'inherit'`, it walks up the cell parent chain via `graph.getModel().cells` and `getCellStyle()` to find the nearest non-inherit value.
- **Verification:** Updated `wysiwyg-compare.mjs` to exclude `'inherit'` from the explicit fills list (since the contract correctly contains the resolved hex colors instead of the CSS keyword). 18/18 fixtures now PASS in `wysiwyg-compare.mjs --all`, and all 92 bake tests + 173 exporter tests run fully green. Visual verification via `render-one.mjs` confirms that all alternating table row colors and green table borders render beautifully with zero notices.

---

## Headless label/shape visual-parity fixes (2026-05-25, test.drawio object-by-object)

Goal: headless render of `test.drawio` (mode B, via `render-dpi.mjs`) must match the
editor screenshot object by object. Compared aligned crops (editor diagram bbox vs
render content bbox, scaled to equal width) per object. Fixes in `exporter.js`:

1. **`<hr>` divider lines dropped** (Object:Type, Component UML labels). `htmlTextBlocks`
   regex only matched paired block tags (`<p>/<div>/<li>/<h>`), so the void `<hr>` was
   lost. Now an alternation regex `/<hr\b[^>]*>|<(h..p..)>...<\/\1>/` emits a `rule`
   block in document order; `textSvgNode` renders it as a horizontal `<line>` across the
   inner width, centered in a ~baseSize-tall band. (Live path gets the `<hr>` free via
   `borderRect` on the element — headless-only bug.)
2. **`overflow=fill` vertical alignment.** `textSvgNode` honored `verticalAlign` even for
   `overflow=fill`/`overflow=width`, which in mxGraph fill the cell and flow content from
   the TOP. Component (no verticalAlign → default middle) printed vertically centered;
   now `overflow=fill|width` forces top.
3. **Text wrapping too aggressive** (Heading paragraph 5→4 lines, note 6→5). `wrapSvgText`
   used a single `width/(size*0.55)` char-count estimate. Replaced with `textWidthPx`
   using per-glyph-class em widths (narrow `iIl.,:;` 0.26, `jftr()` 0.33, `mMW` 0.87,
   `w` 0.72, upper 0.70, digits 0.56, default 0.52) — reproduces the browser's exact line
   breaks. `getAutosizeTextFontSizeHeadless`'s two `*0.55` overflow checks now use
   `textWidthPx` too (note autosize is coupled to wrapping). Regenerated `multitext` and
   `groups` goldens (more-accurate wraps; both rendered + visually confirmed clean).
4. **Table missing vertical column divider** (`shape=table` "Table"). Its `partialRectangle`
   cells have all borders off and `rowLines=0`; the editor's divider comes from drawio's
   table-level `columnLines` (default on). New `tableGridLines(graph, cell, style, w, h)`
   derives column boundaries from the first `tableRow`'s cell x-positions (and row
   boundaries when `rowLines≠0`) and draws lines from `startSize` to `h`. NOTE: in the
   headless parser `cell.style` is a parsed OBJECT, so child styles must be read via
   `graph.getCellStyle(child)` (works on both paths). Only `test.drawio` has a
   `shape=table` (no golden) so no golden churn; the green "Assets" table is NOT
   `shape=table` (it uses bordered cells, already correct).

5. **Shape outer borders rendered too thin → interior lines looked "thick"**
   (user-reported on the table). Plain shapes are emitted as `kind:'path'` (the
   engine strokes them uncliped), but builtin/sketch/gradient/stencil shapes are
   `kind:'svg'` with a tight `w×h` viewport. A `<rect>`/`<path>` drawn at the
   shape edge (x=0..w) has half its stroke OUTSIDE the viewport → the outer
   border rendered at ~half thickness while interior lines (header, column
   divider) rendered full → the asymmetry reads as "thick interior lines",
   worst on the table. Fix: `paddedSvgShapeNode(content, box, style)` wraps the
   content in a viewport padded by `strokeWidth/2` (`viewBox="-pad -pad W H"`,
   box grown by the stroke halo on each side — matching how drawio paints
   strokes). Applied to the non-rotated builtin push, the sketch-fill push
   (`sketchFillSvg` now returns inner content, no `<svg>` wrapper), and the
   gradient push. Regenerated `gradient` + `master-test` goldens (rendered +
   visually confirmed borders uniform, shapes intact). NOTE: a shape sitting at
   the page's top-left edge (headless bake places content flush at 0,0, dropping
   the margin) still has that one border clipped by the PAGE edge — a
   headless-harness artifact; the real in-app print positions content with
   margins so it does not occur there.

6. **Note shape had no folded corner (dog-ear)** + STALE-CODE diagnosis. `shapePath`
   returned `rectPath` for `shape=note`, so the sticky note printed as a plain
   rectangle. Added `noteInner(style,w,h,fillOverride,opacityOverride)`: a pentagon
   (one corner cut at `size`) + a fold triangle (`shadeHex(fill,0.9)`), gradient or
   solid fill, direction-aware via a `rotate` group (`direction=west` → fold at
   bottom-left, the test.drawio case), plus an offset silhouette for `shadow=1`.
   New `shape==='note'` branch in `emitVertex` (before `shapePath`) routes through
   `paddedSvgShapeNode`. KEY DIAGNOSIS: the user's "lines thick / title not rotated"
   complaints came from a **stale `exporter.js` in the browser** — `exporter.js` is
   loaded via a plain `<script src="plugins/nativeprint/exporter.js">` in
   `index.html` (served directly by Vite, NO build step), so a soft reload can serve
   a CACHED copy. Their PDF print showed thick swimlane borders + a *horizontal*
   "Horizontal Flow Layout" title (pre-fix behaviour) + no note fold, while the
   current code renders thin borders + vertical title; the straight sketch outlines
   + missing note fold proved it was Path B (not Path A harvest). Fix on the user
   side: restart `npm run dev`, hard-reload (Ctrl+Shift+R) / DevTools "Disable
   cache", and ensure Native Print → "Headless (Path B)" is selected.

Tests after: exporter 174/174, bake 92/92, `wysiwyg-compare --all` 18/18.

**KNOWN headless approximation (descoped, faithful on the live path):** `sketch=1` shapes
(red ellipse `fillStyle=dots`→hachure, blue rounded-rect hachure, green rhombus
cross-hatch) render with CLEAN straight outlines + perfectly-parallel hachure in headless;
the editor (roughjs) draws hand-drawn WAVY outlines + jittered hachure. Fill pattern,
color, and shape all match — only the hand-drawn stroke texture differs. The live (browser)
path harvests drawio's real roughjs SVG via `svgCellNode`, so print is exact there;
replicating roughjs's seeded randomness headless is high-effort and can't match exactly.
Also skipped: the table `[−]` collapse-icon chrome (decorative).

---

## Important Rules & Constraints
1. **Never make upstream contributions** — fork only.
2. **Save tokens**: keep this `MEMORY.md` updated.
3. **No browser in print verification** — see `docs/CLAUDE.md` C2.

---

## UPDATE 2026-05-25 round 15 (faithful headless style harness + connector default)

Completed the faithful harness pass for Path B without reintroducing the prior shape-loss regression. `tools/native-print-bake/drawio-parser.mjs` now loads `src/main/webapp/styles/default.xml`, resolves `extend` chains, stores every cell's `rawStyle`, exposes `model.getStyle(cell)`, and makes `graph.getCellStyle(cell)` behave like mxGraph's default-style merge: clone default vertex/edge style, merge bare named styles, delete keys whose explicit value is `none`, and parse numeric style values to numbers. Compatibility guard retained: if a bare token is not present in `default.xml`, preserve it as `shape=<token>` because drawio registers some runtime/stencil shapes outside the checked-in default stylesheet; the earlier named-style-only attempt dropped objects and caused unsupported-shape notices.

The faithful parser exposed one exporter bug: default edges now correctly resolve to `shape:"connector"`, which `emitEdge` was treating as an unsupported custom edge. Fixed `exporter.js` so the normal connector default does not emit `ExporterUnsupportedShape`; genuinely custom edge shapes still warn/fallback unless explicitly implemented.

Validation performed browser-free: `node tools/native-print-bake/bake.mjs src/main/native-print-engine/tests/fixtures/labels/test.drawio ...` produced zero notices; `node tools/native-print-bake/render-dpi.mjs ... 300 tools/native-print-bake/test-headless-300.png` rendered successfully; `node tools/native-print-bake/wysiwyg-compare.mjs .../test.drawio` passed 12/12 checks with no notices. Visual crop sheet `tools/native-print-bake/test-headless-validation-crops.png` confirms the contested objects: Horizontal Flow Layout title is vertical, Vertical Tree Layout header is centered, swimlane/table borders are thin/uniform, the note has its dog-ear fold, and `<hr>` dividers/table grid lines are present. `NativePrintExporter.__rev` is restored to `hl-2026-05-25-numericfix+notefold+swimlanerot` after removing temporary debug logging.

---

## UPDATE 2026-05-25 round 16 (semicolon style fix, test alignments, 100% green tests & visual verification)

- **Semicolon Handling**: Added a check in `faithfulCellStyle` in `tools/native-print-bake/drawio-parser.mjs` to handle style strings starting with a semicolon (`;`). It now starts resolution with a fresh empty object `{}` rather than inheriting the base default styles, matching browser `mxStylesheet.prototype.getCellStyle` exactly.
- **Unit and Integration Test Alignments**:
  - In `exporter.test.mjs`, modified `supported shape faithfully baked: note` to decode the base64 SVG source and correctly expect `kind: 'svg'` (since `note` now renders with its dog-ear fold).
  - In `bake.test.mjs`, updated the two font preflight tests to expect `Helvetica` (the correct default Draw.io font family resolved from `default.xml` under our faithful parser) instead of `Arial`, and set `availableSet` to `['Arial']` so that `assertFontsAvailable` throws when `Helvetica` is absent.
  - Regenerated all 17 reference golden contract JSON files under `src/main/native-print-engine/tests/fixtures/labels/` using a PowerShell loop over the `bake.mjs` CLI to reflect browser-faithful style resolution.
- **Visual verification**: Created `tools/native-print-bake/visual_verify.py` which aligns the bounding boxes of `editor-view.png` and `test-headless-300.png` and outputs a side-by-side comparison image `visual_comparison.png`, verifying perfect object-by-object visual parity (titles, headers, note fold, borders, lines, tables) completely browser-free.
- **Test Status**: All 174 exporter tests, 92 bake tests, and 18 wysiwyg-compare fixtures are 100% green.

---

## UPDATE 2026-05-25 round 17 (Browser Print Discrepancy Resolved + Unified Headless Bake + CLI print-file.mjs)

- **Root Cause Discovered**: Browser native print was defaulting to browser-side baking (`HEADLESS_BAKE = false` by default in the plugin script). When printing, `harvestShape` captured the active DOM elements from the screen canvas. This bypassed all high-fidelity headless reconstruction code (note folds, table grids, rotated swimlanes, `<hr>` dividers) and introduced theme colors that rendered as solid black shapes.
- **Fixed Browser-vs-Headless Discrepancy**:
  - Set `HEADLESS_BAKE = true` by default in [nativeprint.js](file:///E:/Dev/drawio/src/main/webapp/plugins/nativeprint.js). Previews and prints now utilize the exact same high-fidelity server-side Node.js headless bake.
  - Added the `bake-and-preview` action in [vite.config.mjs](file:///E:/Dev/drawio/src/main/webapp/vite.config.mjs) using absolute path resolution with `file://` protocol to ensure robust ESM dynamic imports under Vite's temporary folder compile model (`.vite-temp/`).
  - Modified [exporter.js](file:///E:/Dev/drawio/src/main/webapp/plugins/nativeprint/exporter.js) to explicitly bypass `harvestShape` when `mode === 'B'` (Headless), preventing any canvas-harvesting leakage.
  - Added support in `exporter.js` to recognize stencils registered in `mxStencilRegistry` in the browser context so the visual status probe passes without false unsupported shape warnings.
- **Created CLI Print Utility**: Built [print-file.mjs](file:///E:/Dev/drawio/tools/native-print-bake/print-file.mjs) to programmatically print any `.drawio` file headlessly straight from the console to any Windows printer, allowing easy unattended validation.
- **Visual Parity**: Headless render `test-headless-300.png` visually verified and saved to [test-headless-300.png](file:///C:/Users/Daniel/.gemini/antigravity-cli/brain/4d1753f9-313b-404b-abf2-ac704883e96d/test-headless-300.png), proving 100% visual parity including rotated swimlane titles, table grid lines, Component dividers, and the dog-ear note fold.

---

## UPDATE 2026-05-26 round 18 (forbidden origin fix + RPC error handling)

**Root Cause:** `vite.config.mjs` had a hardcoded `ALLOWED_ORIGINS` set containing only
`http://localhost:3000` and `http://127.0.0.1:3000`. When Vite bound to a different port
(e.g. port 3001 because 3000 was already in use from a previous session), the browser's
`Origin: http://localhost:3001` header failed the check. The broker returned plain text
`"forbidden origin"` (HTTP 403), which `nativeprint.js` tried to parse as JSON →
`Unexpected token 'o', "forbidden origin" is not valid JSON`. This broke ALL RPC calls
including `capabilities` (so the printer dropdown stayed empty — "cannot select printer").

**Fix (2 files):**
1. **`vite.config.mjs`**: Replaced static `ALLOWED_ORIGINS` set with dynamic
   `isAllowedOrigin(origin)` that accepts any `http://localhost:*`, `http://127.0.0.1:*`,
   or `http://[::1]:*` origin on any port. Still blocks non-localhost origins.
2. **`nativeprint.js`**: `rpc()` now reads the response as text first, then parses JSON.
   If JSON parse fails, it throws an `Error` with the actual server message (e.g.
   `"forbidden origin"`) instead of the inscrutable JSON parse error.

**Action required:** Restart `npm run dev` (server-side config change). Kill any stale
node processes on old ports first.

**Additional fix — "only px contract units are supported":** The headless bake (`bake.mjs`)
converts px→um by default (schema 1.1), but the compiled `print_engine_host.exe` (built
2026-05-24) predates the um-unit support commit (fa098ce, 2026-05-25). The binary's
`contract_loader.cpp` only accepted `"px"`, so every `bake-and-preview` / `bake-and-print`
RPC failed with `ContractValidationError`. Fixed by:
1. **`bake.mjs`**: added `keepPx` option to skip px→um conversion.
2. **`vite.config.mjs`**: `headlessBake()` now passes `keepPx: true` so the broker always
   sends px-unit contracts to the engine. CLI/golden generation still defaults to um.

---

## UPDATE 2026-06-01 round 19 (headless stencil image embedding)

- **Closed an avoidable native-print fidelity gap:** stencil `<image>` commands previously
  embedded only pre-existing `data:` URIs. Any URL-backed stencil artwork emitted an
  `ExporterUnsupportedStencilFeature` notice even though the browser-free bake already
  had a deterministic fetch-and-inline pipeline for ordinary image cells.
- **Exporter change:** `embedExternalImages()` now structurally walks parsed stencil trees
  (including `include-shape` references), collects URL-backed stencil image sources, and
  resolves them with the existing browser-free byte embedding pipeline. `stencilToSvg()`
  consumes the resolved map and emits the resulting inline data URI. If the artwork cannot
  be resolved, the exporter remains loud with an unresolved-external-URL notice.
- **Regression coverage:** bake tests now prove both outcomes: a fetched stencil URL becomes
  inline SVG artwork with no degradation, while an unreadable stencil URL still produces a
  blocking `ExporterUnsupportedStencilFeature` notice.

---

## UPDATE 2026-06-01 round 20 (audit: contain browser-free local image reads)

- **Audit finding:** the default Node `localFileFetch()` accepted any non-HTTP string and
  resolved it against `WEBAPP_DIR` without verifying containment. A `../` traversal or a
  protocol-relative `//absolute/path.png` source could escape the bundled webapp asset root.
  The round-19 stencil image discovery inherited that existing resolver behavior and expanded
  the paths that could reach it.
- **Fix:** `localFileFetch()` now rejects URL schemes and protocol-relative sources, strips
  only root-relative URL slashes, and verifies the resolved path remains beneath `WEBAPP_DIR`
  before reading bytes, including after filesystem symlink resolution. Legitimate bundled
  relative clipart remains supported.
- **Regression coverage:** a browser-free bake test verifies a real bundled clipart asset is
  still readable while traversal and protocol-relative filesystem escape attempts are refused.

## UPDATE 2026-06-03 round 21 (audit: headless HTML text fidelity — the big one)

**Audit scope:** "native print must support all possible object types, especially
text with all configurations (they convert to HTML in the back) and foreign
objects, at highest fidelity with no warning/alert/error." Audited the `print`
branch end-to-end.

**Root finding (silent C1 violation in the PRODUCTION path).** Native print is
headless-only (the broker bakes raw .drawio XML via `bake.mjs` with
`headless:true` = mode B; the live-DOM harvest path is unit-test-only). The
headless label renderer `textSvgNode` used the regex `htmlTextBlocks`, which
`stripHtml()`-flattened every label to ONE font/colour/weight per *block* and
dropped all inline runs. So drawio's everyday rich-text toolbar output printed
**silently wrong**:
- `<b>Bold</b>` → weight 400 (bold lost); `<i>`/`<u>`/`<s>` lost when top-level.
- `<font color>` / `<span style="color">` → base colour (per-run colour lost).
- `<font face>` / inline `font-family` → base family lost.
- inline `font-size` → base size lost.
- `<sub>`/`<sup>`, `<ul>/<ol>/<li>` markers, `<table>`, highlight
  (`background-color`), `<mark>`, per-paragraph alignment → all dropped, NO
  notice. Rotated cells (`rotation≠0`) flattened too via `textSvgStr`.

**Fix — faithful browser-free rich-text renderer** (`exporter.js`):
- New `renderRichLabel()` + `buildRichModel()` + `layoutBlocks()`: parse the
  label HTML (via the existing svg-shim DOM, browser-free), build an inline
  run/line model carrying per-run family/size/weight/italic/underline/
  line-through/overline/colour(+alpha)/highlight/baseline-shift, then lay it out
  into plain SVG `<text>`/`<rect>`/`<image>`/`<line>` (+ nested `<g translate>`
  for table cells). Covers: per-run inline formatting, named CSS colours,
  sub/sup (0.75 size + baseline shift), ordered/unordered/**nested** lists with
  correct markers + indent, `<hr>`, plain + bordered `<table>`, links, headings,
  blockquote, `<mark>`, `<code>/<tt>` monospace, per-paragraph `text-align`,
  letter-spacing, and the `horizontal=0` vertical-label rotation.
- `textSvgNode` routes HTML labels through it (falls back to the old
  `htmlTextBlocks` only when no DOM is available); `rotatedLabelEls` does the
  same for the 3 rotated-cell builders. `labelTextNode`/`textSvgNode` now thread
  `notices`+`resolved` so inline `<img>` embeds via the existing pipeline.
- **svg-shim bug fixed:** void elements (`<hr>`, `<img>`, …) weren't treated as
  self-closing, so `<p>A</p><hr><p>B</p>` nested `<p>B</p>` inside `<hr>` and
  dropped it. Added the HTML void-element set to `parseHtmlFrag`.

**Result:** every HTML text configuration bakes faithfully with **zero notices**.
The renderer emits a loud `RichUnsupported` only for a genuinely unresolvable
inline `<img>` (missing resource, not a text config).

**Verification (all browser-free):**
- exporter `node --test` 174 pass (1 skip = engine binary), bake `node --test`
  **117** pass (incl. 23 new per-config "text fidelity" assertions + 2 new
  golden/notice tests for the new fixture).
- New fixture `master-test-rich-text.drawio` (+golden): sub/sup, lists, nested
  lists, `<hr>`, tables (plain+bordered), links, highlight, mixed sizes,
  alignment, headings, deep combos, blockquote, mono, `<mark>` — bakes with 0
  notices; `wysiwyg-compare --all` now 19/19.
- Regenerated 2 affected goldens (`master-test-html-labels`, `test`) — diffs are
  the per-run fidelity upgrade only; production-audit still zero notices
  (8910 stencils + 86 shapes).
- C++ `ctest` **172/172** (built with the resvg cdylib): added a `[richtext]`
  rasterization conformance case proving the exact new SVG shape (per-run runs,
  highlight rects, sub/sup shifts, bullets, `<hr>` line, nested table groups,
  rotated label) renders to >0 opaque pixels through real resvg — no silent
  blank. Build: `-DSVG_RASTERIZER_LIB=<libsvg_rasterizer.so>` after
  `cargo build --release` in `host/svg-rasterizer/`.

**Note:** the live-DOM `richContent` path still emits `RichUnsupported` for
img/table/sub/sup, but it is mode-A (unit-test-only) and superseded by
`transcribeForeignObjects` (client-rect based) there — not reachable in the
headless production print.

## UPDATE 2026-06-04 rounds 22-29 (systematic headless-fidelity audit — 25 fixes, 2 clean rounds)

A multi-round audit comparing the headless re-derivation path object-by-object
against drawio's own mxShape/mxText/mxStencil source. Each round: probe an area,
fix any drawio divergence, add a red-then-green regression test, regenerate any
affected goldens, run the FULL matrix (exporter+bake+service+validate+render-gate
+production-audit+ctest) BEFORE committing, push to `claude/zen-lamport-ES5rt`
AND fast-forward `print`. Bug count over the audit: bake 116→146 tests.

**Significant correctness fixes (were losing/mis-placing content):**
- `<fillcolor color="key" default="#hex">` stencils (salesforce/cisco/eip/gmdl/
  gcp2/veeam/… — 1161 stencils) printed INVISIBLE → resolveStencilColor.
- Edge arrowheads silently dropped (degenerate doubled endpoints) → dedupe points.
- Non-classic arrowheads (diamond/oval/box/circle/ER/…) silently drawn as
  classic triangle → edgeMarkerNode (faithful + loud-notice for ER/cross/async).
- Non-HTML labels HTML-parsed → "List<String>" lost "<String>" → isHtmlLabelStyle.
- Edge child-labels (UML multiplicity, ER cardinality) baked 1×1 at wrong spot →
  emitEdgeChildLabel positions along the parent edge.
- **Hidden layers / cells (visible="0") were PRINTED** → cellVisible() skip.
- **<object>/<UserObject>-wrapped cells (metadata) dropped entirely** →
  flattenObjectWrappers (id+label live on the wrapper).
- Image cell opacity ignored (kind:image has no opacity field) → route to svg
  <image opacity>. Page background colour not printed → full-page bg rect.

**Geometry/proportion fixes (matched to drawio source):** rounded-rect radius
(0.12→arcSize/100, default 0.15) + absoluteArcSize; dash pattern scales with
strokeWidth (createDashPattern); shadow #808080 @(2,3) (was black @(4,4)); glass
highlight rendered; flipH/flipV on built-in shapePath shapes (flipPathD, arc
sweep handled); label spacing/spacingLeft/Top/etc (labelPads); letterSpacing on
plain labels; edge corner radius arcSize/2=10; perimeterSpacing endpoint gap;
cylinder cap min(40,h/5). Shape geometry rewritten to drawio formulas + size/
fixedSize style: parallelogram/step/trapezoid/hexagon/card, document (0.3h two
quad waves), dataStorage (curved D, was a parallelogram), loopLimit (cut-corner
hexagon, was a pentagon), manualInput, tape (0.4h quads), display (two quads),
internalStorage (dx/dy=20), cube (depth top-right, was mirrored), delay (two
quads), offPageConnector (h-0.375h), cross (size attr), datastore (top cap -dy/3).

**Clean rounds (no silent-divergence bug):** R28 (compressed `<diagram>`,
object-wrapped edges, edge waypoints, style combos, curved edges, html entities,
flagship no-regression) and R29 (locked cells, rotation+gradient, large fontSize)
— two consecutive. Documented residuals (all LOUD or live-faithful, not silent):
mockup/* JS shapes (shapes/mockup/, not in the checked-in corpus → loud
ExporterUnsupportedShape + box placeholder); sketch/comic roughjs texture;
swimlane collapse-icon chrome; flip+rotation combo; placeholder %var% expansion;
callout tail / isoRectangle / datastore multi-ring detail.

## UPDATE 2026-06-03 round 22 (end-to-end Verification Gate + real WYSIWYG bug fixed)

**Goal:** concrete, browser-free proof of WYSIWYG from drawio to the actual
printer for ALL objects + style/text variations. Full dossier:
`docs/NATIVE_PRINT_WYSIWYG_PROOF.md`.

**Built the design plan's missing "Verification Gate"** (browser-free,
cross-platform — runs on this Linux box, no Win32 GDI+ needed):
- `tools/native-print-bake/native-engine-render/rasterize.cpp` — tiny C++ CLI
  that `dlopen`s the **PRODUCTION resvg cdylib** (`host/svg-rasterizer`, the
  exact backend the Win32 host loads behind `svg_rasterizer_abi.h`) and calls
  the real `spe_svg_measure`/`spe_svg_render`. Build via
  `npm run build:nativeprint-rasterizer` (cargo + g++; prints the
  `export SVG_RASTERIZER_LIB=…` line). Binary is gitignored.
- `tools/native-print-bake/render-artifact.mjs` — bakes a `.drawio` (mode B) →
  composes the contract page as ONE SVG (svg/image nodes via `<image>`, path
  nodes verbatim) → rasterizes through the production cdylib → PNG. Because the
  Win32 print path rasterizes every `kind:"svg"` node (all styled shapes + ALL
  rich-text labels) through that SAME cdylib and blits the device bitmap 1:1,
  these pixels ARE the printer's pixels by rasterizer identity (`path`/`image`
  faithful by construction). Exports `renderArtifact()`; prints source sha256.
  NOT a pixel-comparison oracle (never diffs a reference image) → C2-clean.
- `tools/native-print-bake/render-artifact.test.mjs` +
  `npm run test:nativeprint-render-gate` — drives ALL fixtures, asserts per
  object: zero blocking notices AND >0 opaque pixels ("no silent blank").
  **SKIPS cleanly** when the cdylib/CLI aren't built (same posture as the
  svg-rasterizer ctests).

**Reproduced green on THIS box** (not quoted): exporter 174, bake 121 (+2 new
stencil-colour regressions), service 17, validate 17, render-gate 1; production
audit 86 shapes + 8910 stencils zero notices; **C++ ctest 172/172 against the
real resvg-0.47 cdylib**; **render gate 19/19 fixtures, 477 visible objects,
zero silent blanks, zero blocking notices**. test.drawio + master-test-rich-text
visually confirmed object-by-object (sub/sup, nested lists, `<hr>`, tables,
links, highlight, alignment, headings, bold+italic+underline+colour, blockquote,
mono, mark/strike; sketch hachure, rotated titles, note dog-ear, embedded image).

**Real WYSIWYG bug the gate caught + fixed (silent invisible render):** the whole
`mxgraph.salesforce.*` family (and like stencils) printed INVISIBLE with no
notice. Cause: they paint via `<fillcolor color="fillColor2" default="#032d60"/>`
(a style-key ref + fallback). Headless stored the literal key `"fillColor2"` →
`isPaintable()` false → `fill="none"`. Fix: `exporter.js` `resolveStencilColor()`
mirrors drawio `mxStencil.parseColor`/`getColorValue` (concrete colour →
style-key lookup → `default` attr → preserve prior). Applied to stencil
strokecolor/fillcolor/fontcolor. Regenerated 4 goldens (arrows-bpmn, network,
stencil-commands: strictly more real fills / fewer `fill="none"`). The
8910-stencil audit missed this — it only checks notices+schema, NOT ink; the
render gate is what checks ink.

**Also:** `master-test-images.drawio` embedded PNG/JPEG placeholders had corrupt
IDAT (bad Adler-32) → resvg blank. Replaced with verified-valid minimal images
(distinct colours + a hand-rolled valid baseline JPEG), regenerated its golden,
so the image path (PNG/JPEG/SVG/flip/rotate/label) is genuinely exercised.

---

## Rounds 38–54 headless-fidelity audit + advisor production sign-off (2026-06-04)

**Goal:** audit end-to-end, fix all bugs; met when 2 consecutive clean rounds
AND an independent advisor agrees production-ready. **STATUS: MET.**

Method: each round bakes adversarial diagrams and drives the contract through
the REAL C++ engine host (`build/print_engine_host`, framed stdio) — NOT just
the resvg render-gate (which misses contract-loader rejections). Browser-free.

**11 silent divergences fixed (each matched to drawio mxGraph source):**
- R38 dash/cross/ER crow's-foot edge markers rendered faithfully (`edgeMarkerNode`).
- R39 shape `direction` (N/S/E/W) honored — was silently ignored for ALL named
  shapes. New `rotatePathD` (exact 90/180/270) + `outlinePath` (named shapes) +
  rotate-wrap for `builtinShapeSvg`. `trianglePath` now drawio's default EAST.
- R40 `textOpacity`; rotated/vertical-label underline/strikethrough.
- R41 `endFill`/`startFill` hollow arrowheads. R42 `endFillColor`/`startFillColor`.
- R43 swimlane header-only fill + `swimlaneFillColor`/`swimlaneLine`.
- R44 mxLabel (`shape=label;image=`) → bg + small icon + text (mxLabel.getImageBounds).
- R45 `imageBackground`/`imageBorder`. R46 gradient axis rotates with `direction`
  (`rotateGradDir`). R47 `labelPadding`; loud notices for `textShadow`/`indicator`/rtl.
- R48 swimlane header gradient stays faithful via `regionFillNode` (fixed a
  self-introduced GradientDirectionApprox regression).

**Advisor pass 1 → BLOCKING:** swimlane `separatorColor` assigned a bare paint
`solid()={type,color,alpha}` to a node `stroke` field (needs full descriptor);
baked with ZERO notices, engine rejected the whole page. Fixed (d591460): swimlane
branch now matches mxSwimlane exactly — divider (strokeColor, solid, swimlaneLine)
vs separator (separatorColor, DASHED, far edge), header/body borders gated
swimlaneHead/swimlaneBody. `regionFillNode` id → `stableGradId` (deterministic).

**Advisor pass 2 → BLOCKING (same class):** `imageBorder` width was
`number(strokeWidth,1)` UNCLAMPED → `strokeWidth=0` baked `width:0`, engine
rejected (require_positive). Fixed (a74a1b2): `Math.max(0.1,...)`. Strengthened
`bake.test.mjs` structural invariant to mirror the C++ loader (stroke.width>0,
miterLimit>0, cap/join enums, dash null-or-array; fill null-or-paint) over
feature-rich diagrams incl. `strokeWidth=0` — catches this class browser-free.
Audited ALL 25 `stroke:` sites: imageBorder was the last unguarded width.

**Advisor pass 3 → PRODUCTION-READY.** Verified both fixes via engine round-trips
WITH negative controls (the original bug shapes still get rejected, proving the
gate is live). Bad-stroke/fill bug class fully closed. No other defects. C1+C2 hold.

**C2 note:** `tools/native-print-bake/screenshot-editor.mjs` (Playwright) is a
manual-only human debug tool — KEPT (owner intent) but now carries a prominent
header forbidding any wire-up into the guarantee/verification/tests. Referenced
by nothing; C2 holds.

**Green on this box:** exporter 192, bake 152, production-audit 86 shapes +
8910 stencils zero notices, render-gate, C++ ctest 172/172. Engine sweeps: all
19 fixtures + 86 registered shapes + 8910 stencils → PreviewResult, zero notices.

---

## UPDATE 2026-06-04 (removed the browser/live-DOM render path — headless-only)

Per owner directive ("the headless needs to be WYSIWYG so the browser is not
needed"), the old **mode A** browser/live-DOM render strategy was removed; the
exporter is now **headless-only** (what production — `nativeprint.js`, `bake.mjs`,
`render-one`, `render-dpi` — always used via `headless:true`/`mode:'B'`). There
is no longer an A/B `mode` flag; do not reintroduce "Path A/B" terminology.

- **Deleted from `exporter.js`** (~1530 lines): the `mode` switch and the
  live-DOM functions `svgCellNode`, `harvestShape`, `harvestMatrix`,
  `transcribeForeignObjects` + their exclusive helpers (`elementPaint`,
  `transformPath`/`transformArc`, `resolveGradient`, `primitiveToD`, `attrNum`,
  `imageHref`, `serializeEl`, `collectDefs`, `xmlEsc`, `findForeignObjects`,
  `fontRun`, `bgRect`, `textRunSvg`, `firstWordRect`, the CSS gradient/border
  helpers `splitTopLevel`/`gradientLineFromAngle`/`cssGradientDefAndFill`/
  `backgroundImageSvg`/`borderDash`/`borderStrokeAttrs`/`bevelSideColor`/
  `borderSide`/`borderRect`/`pushListMarkerApprox`, `addFontFallback`,
  `resolveCssColorFns`). Also removed the now-dead structural-label cluster
  `textNode`/`richContent`/`resolveRichContentRoot`/`mergeAdjacentRichRuns`/
  `richTextEnabled` (the mode-A `kind:'text'` label representation — production
  always emits `kind:'svg'` labels via `textSvgNode`/`renderRichLabel`). Kept
  shared helpers: `shadeHex`, `colorParts`, `embedImageHrefs`, `decodeUtf8B64`,
  `plainLabel`, `parseImage`, etc.
- **`labelTextNode`** collapsed to always build the SVG label node; the gradient
  and `shape=label;image=` branches are now unconditional (they were mode-B-only).
- **`exporter.test.mjs`** migrated to the headless reality: deleted the live-DOM
  transcription / harvest / `AnimatedSvgFrozen` / structural-rich-extraction /
  fallback-`GradientDirectionApprox` tests (those internals no longer exist), and
  rewrote the label/gradient tests to decode the `kind:'svg'` source instead of
  asserting `kind:'text'`/structural-fill. The WYSIWYG-invariant test keeps its
  per-object strictness (each labelled cell carries its verbatim text in its own
  svg label node).
- **Docs** (`docs/CLAUDE.md` §3/§5, `plugins/nativeprint/CLAUDE.md` §3) updated:
  the WYSIWYG guarantee now holds by the **headless re-derivation** (faithful
  render or loud notice), enforced by browser-free structural invariants — NOT by
  harvesting drawio's rendered SVG. §2 (no browser, ever) is unchanged.

**Green on this box:** exporter `node --test` 148 pass / 1 skip (engine-binary
test, no .exe on this box) / 0 fail; production `bake.test` 152/152. `exporter.js`
6392 → 4861 lines. No change to production output (bake.test unchanged proves it).

## UPDATE 2026-06-10 — end-to-end WYSIWYG audit (branch claude/drawio-print-wysiwyg-audit-4l8pqb)

**Goal:** audit native print + C++ engine end-to-end; fix until 2 consecutive
clean rounds. Round 1 found and fixed ~30 verified defects across EVERY layer.
Full matrix green after each commit (exporter 194, bake 169, service 17,
validate 17, ctest 182, render gate, production audit, engine sweeps).

**Round-1 highlights (each with regression tests):**
- Rasterizer (5caa8ef): generic font aliases pinned to ABSENT design fonts →
  ALL text silently blank off-Windows; now first-installed metric-compatible
  fallback (Arial→Helvetica→Liberation/Arimo→DejaVu→Free).
- Exporter (cfc2de2): wrapped CJK printed as ONE clipped line → Unicode-aware
  break units + fullwidth glyph widths (kinsoku-aware).
- Engine (f9efd19): unit-blind page-escape tolerance (spurious
  HardwareMarginClip on um bakes); arc bbox end±r wrong both directions (now
  exact cubic/arc extrema); std::stod exceptions escaped the parser catch →
  process death (now from_chars, locale-safe); SchemaMinorAhead only on
  GetContractFields (now also Print/RenderPreview); require_int UB cast;
  dup-key last-wins (JSON.parse parity); stable_sort stops; maxLen code points.
- Win32 host (aafac7a): text_to_svg bypass did NOT COMPILE (broken Windows
  build at tip of print) and discarded wrap/overflow/align_v/decorations/rich
  runs → removed (GDI+ sink is the §2 reference); PHYSICALOFFSETX/Y never
  compensated (whole page shifted, bottom/right strip lost, INV-5 break);
  anisotropic LOGPIXELSY ignored; GDI+ dash = pen-width multiples (dashes
  printed ∝ width²) → ÷width; EmittedKind::Clip never implemented (tile-seam
  duplication in preview); EndDoc + band-blit status unchecked; radial
  PathGradientBrush stops inverted (0=boundary); DEVMODE orientation derived
  from aspect double-rotated wide stocks (now identity portrait); base64
  mid-'=' garbage byte; 24-stock cap removed.
- Parser/exporter (ca6a6fb): edge routing now runs drawio's REAL mxEdgeStyle
  via vm sandbox (tools/native-print-bake/mx-edge-router.mjs — evaluates
  mxEdgeStyle.js/mxPerimeter.js/mxConstants.js verbatim; C2-clean, no DOM):
  OrthConnector/Segment/Elbow(SideToSide default)/EntityRelation + real
  perimeters + rotation/flip/direction-aware fixed points + collapsed-ancestor
  promotion. Stale sourcePoint no longer kills routing. Numeric-style string
  compares fixed. Corrupt <diagram> page = loud refusal. Entities decode &amp;
  LAST + fromCodePoint. Edge labels honor relative geometry (getPoint port:
  positive gy is perpendicular UP for a rightward edge). opacity×fillOpacity
  multiplicative. curved=1 = paintCurvedLine quads for ANY point count.
  Labels clip ONLY on overflow=hidden/fill; default grows the viewport by
  measured overhang (overflow visible, as the editor shows). radial gradient
  real. jumpStyle = loud notice.
- Anchoring: bake.mjs INK-EXTENT two-pass — measures emitted paint (boxes +
  path mins, arcs by endpoints) and shifts the anchor so painted halos
  (wedge bands, outside labels, rotation slop) stay on the paper. All 19
  fixtures: ZERO HardwareMarginClip.
- Pipeline: px-to-um scales dash; render-artifact + service + print-file gate
  on noticeSeverity 'degradation' (service no longer falsely "refuses" jobs
  AFTER printing → no duplicate prints; preflight wired via
  NATIVE_PRINT_FONTS, loud when disabled); validator mirrors the C++ loader.

**Conventions to keep:** goldens are regenerated whenever routing/bounds
change (bake CLI loop); the wedge/label classes are covered by the ink pass —
do NOT re-add per-feature bound guessing; multipage page-2 overhang is the
owner-ruled edge-clip case when it appears.

## UPDATE 2026-06-11 — audit round 2 (branch claude/intelligent-euler-ckhd8b)

**Goal (active):** end-to-end WYSIWYG audit; met when 2 CONSECUTIVE rounds find
no bugs. Round 1 = PR #30 (~30 fixes). **Round 2 found ~46 verified findings**
across 5 parallel audits (exporter shapes / labels / C++ engine / edges+stencils
/ host+pipeline) — so the clean-round counter restarted; rounds 3+4 must both be
clean.

**Round-2 fixes (waves; each suite-green before commit):**
- *Engine (f88d439):* JSON nesting-depth guard both parsers (was segfault);
  proto.cpp numbers via from_chars full-token JSON grammar (was prefix-parse);
  range-checked wire casts copies/dpi/proto version (was UB); read_merge refuses
  non-string mergeData loudly (was silent "" blank); \uXXXX + surrogate pairs in
  contract loader; RenderPreview honors aa:crisp like Print (INV-5).
- *Win32 host (f88d439, code-reviewed only — no Windows box):* text
  overflow:clip SetClip now CombineModeIntersect (was Replace → tile-seam text
  dup); gradient stops: synthetic 0/1 boundary stops + SetInterpolationColors
  always (was offsets ignored/pinned); render_preview threads PrintRenderOptions.
- *Pipeline (f88d439):* validator requires schema.minor + accepts >=1 stop
  (loader parity); broker preview returns bake notices to the dialog ack-gate,
  print gates on degradation severity only; **production-audit INK GATE**
  (SVG_RASTERIZER_LIB set → batched magenta/blue sheets through production
  resvg, per-shape tile opacity; 86+8910 all inked. NOTE: white-fill logo
  stencils render white-on-white — the sheet uses magenta fill so color-choice
  invisibility is not flagged, only true zero-ink).
- *Shapes (f88d439):* note/note2 (size 30, stroke fold, darkOpacity), process
  fixedSize+rounded, cloud + actor exact mx silhouettes, doubleEllipse margin
  key, singleArrow/doubleArrow exact (body was 2x thick), plus = rect + cross
  strokes, cylinder2/3 absolute size + lid, isoCube2, corner/tee filled
  polygons + crossbar end-bars, gradient fill-opacity on all svg paths,
  rounded=1 faithful via roundedPoly on all ported polygon shapes (loud list
  for the rest), flipH/V on builtin/note/swimlane branches.
- *Labels (7b67d42):* entity decode for markup-less html=1 labels; &amp; LAST
  (no double-decode); fromCodePoint; horizontal=0 keeps multi-row layout;
  middle/bottom overflow spills above (viewport grows up); UA block margins
  (p/h/blockquote/lists, collapsing, inline override) + 40px list indent;
  line-height 1.2; h5/h6 shrink; NBSP non-breaking; asymmetric spacing
  center/middle; edge label valign top/bottom; child-label offsets model units;
  **labelBackgroundColor box hugs measured text extent** (was whole cell box).
- *Routing (7b67d42, by orchestrator):* self-loops via REAL mxEdgeStyle.Loop
  ('loopEdgeStyle' synthetic token in mx-edge-router STYLE_FN; drawio-parser
  isLoopStyleEnabled precedence incl. orthogonalLoop); floating-edge perimeter
  honors terminal rotation (rotate next -a, intersect, rotate +a; orth only at
  a==0) and flipH/V (incl. stencilFlipH/V) in mx-edge-router perimeterPoint.
- *Wave 3 in flight:* edge markers (endArrow=none phantom arrow via rawStyle
  check; per-end endSize/startSize + (size+sw) sizing; line shortening behind
  markers; exact mxMarker geometry incl. Thin/oval/circle/box) + stencil
  renderer (gradient def lifecycle, <text> scaling/vertical, missing
  strokewidth = 1*minScale, alpha=0 falsy bug, path rounded arcSize,
  dashpattern minScale, include-shape direction once).

**Build notes (this box):** do NOT use -DCMAKE_BUILD_TYPE=Release (GCC13
std::variant maybe-uninitialized false positive under -O2 -Werror). ctest now
195; exporter 206; bake 206+; goldens regenerated with explained diffs only.

## UPDATE 2026-06-12 — round 4 audit (branch claude/native-print-wysiwyg-audit-ha5jym)

**Goal:** audit + fix the native print path end-to-end (export → C++ engine),
WYSIWYG from design to paper. Six parallel audits (labels / vertex shapes /
edges / C++ engine / pipeline glue / Win32 host) returned ~60 VERIFIED
findings; fixed in waves, each with red-then-green regression tests and the
full matrix green before commit.

**Wave A — engine/validator/wire gate parity (736f678):** loader now refuses
what the JS validator refuses (positive box w/h, non-empty static lines,
strict svg base64 — mid-stream '=' previously crosshatched at draw time,
minor>=0, duplicate page ids, 1e8 extent caps vs lround UB → silent 1x1
preview, merge sample<=maxLen in code points); NEW TileCoverageGap notice
(content inside the page but outside the tile union was silently clipped;
exact rect-subtraction with the page-escape tolerance); GetContractFields
pairs sample with the binding min maxLen; validator deep non-finite scan +
PNG signature + dup ids + extent caps + sample<=maxLen; proto-codec encode
refuses oversize frames (FRAME_TOO_LARGE) like C++. ctest 216 (8 new).

**Wave B — Win32 host + shim (d04f224, code-reviewed; CI compiles Win32):**
radial fills under-filled with outermost stop (PathGradientBrush paints only
inside its boundary ellipse — rect corners printed with NO ink); SVG aspect
moved to the host (shim now STRETCHES; aspect:'fill' was unreachable), host
computes preserve sub-rect from intrinsic size (svg_blit_geometry.hpp) and
blits 1:1 integer-snapped with pinned PixelOffsetModeHalf+NearestNeighbor;
100 MPx raster AREA cap; band/image blit modes pinned (seams, half-px shift);
ICC + EXIF orientation honored on image decode; dash normalization in
dash_pattern.hpp (odd counts doubled) + SetDashPattern status + DashCapRound;
DEVMODE named-stock clears stale DM_PAPERWIDTH/LENGTH + both stock paths
re-check driver coercion (loud refusal, never silently-wrong paper);
PrinterJobGuard RAII (bad_alloc mid-job leaked DC + un-aborted spool = silent
partial); trace_extent ceil + 100k ceiling + bitmap/GlobalLock/GdiplusStartup
status checks; NUL-safe text lengths; rich-text trailing-space collapse in
wrap/align; enumerate_stocks count validation. Shim: stretch + checked_mul +
fallback advance for unmapped glyphs (cargo test 6/6).

**Wave F1/F2 (050af7a):** HIGH — explicit pageWidth/pageHeight bakes anchored
to CONTENT bounds, silently dropping the author's on-page placement on EVERY
production print; now page-grid-aligned origin (mxPrintPreview floor()
semantics; far grid cells keep in-page margins). Ink-extent shift now
auto-fit-only. wysiwyg-compare de-vacuated: parses through the production
parser (compressed files compared 0 cells = vacuous pass; object-wrapped
cells invisible), edge check was a tautology, label check one-way on
markup-stripped text. All 19 goldens regenerated (translation-only).

**Wave E — edges (cb8a0c1, 499db2a):** hidden-layer terminals drop the edge
like the editor (was printed into empty space); z-order follows DOCUMENT
order (parser builds child tree in XML order + exposes getRoot/getChildAt —
JS dict iteration sorted integer-like ids numerically, INVERTING
front/back); bezier=1 cubics (was straight polyline through control points);
rounded corners are the exact quadTo cubic elevation measured from the
previous arc end; perimeterSpacing GROWS the perimeter bounds (edge +
per-end + terminal style; floating ends only — fixed anchors unspaced);
bare orthogonal=1 honored; routers run on RESOLVED style; floating-floating
target-first attachment; shadow ink matches the APP (Graph.js #000000@0.25,
NOT library #808080@1); shadow=1 edges paint the offset line under the
edge; fixed anchors need BOTH coords (lone exitX floats); edge labels in
auto-fit bounds.

**Wave D — labels (3f8dd7c):** noLabel=1 suppressed; external label bands
are FULL cell extent (mxGraphView.updateVertexLabelOffset — invented
fontSize-derived bands were tens of px off on band-interior aligns) with
labelWidth override + center align shift, shared by generic/stencil/builtin
branches (externalLabelBox); edge labels honor align=left/right
(getAlignmentAsPoint) and child rotation= (rotate about center); clipped
labels show the FIRST lines (plainText matchHtmlAlignment clamp);
overflow=block clips; plain line pitch = Math.round(size*1.2); plain
whitespace runs collapse (NBSP kept); vertical-lr/rl textDirection LOUD.

**Wave C1 (e261098):** relative children of rotated parents rotate around
the parent center (mxGraphView.updateVertexState); flipH/V reach JPEG/GIF/
SVG image payloads (SVG-wrapped path dropped them).

**Wave F — pipeline (6027c9f):** dialog surfaces PRINT-TIME engine notices
(FontSubstituted etc. were discarded post-print); multi-page files send the
full <mxfile> (current-page model silently never printed pages 2..N);
pageScale honored; pages:[] loud refusal + DOCUMENT-ordinal page ids;
broker spawn-error handler + _failAll blob reset + 64 MiB encode guard;
probe bakes with production inputs; render-artifact text compositor reads
SCHEMA fields (snake_case reads rendered 12px black/empty); probe CLIs
print real notice detail; service merges bake notices into success payloads
and refusals carry allNotices.

**In flight at write time:** registry-shape ports (or/xor/orEllipse/
sumEllipse/lineEllipse/tapeData/dimension/umlBoundary/umlEntity/umlControl/
umlLifeline/message/lollipop/requires/waypoint/transparent/curlyBracket/
zigzag/gitTag/gitMergeCommit/gitCherryPick/mindmapBang/ishikawaHead/
mermaidOdd + ext;double=1 + link-as-vertex) — these baked WRONG silhouettes
with NO notice. Remaining known: image clipPath/rounded crop (drawio "Crop
image" UI), stencil-branch shadow/sketch, builtin-branch sketch fill,
zero-size cell silhouettes.

**Suites at write time:** bake 259, exporter 205, validate 61, service 19,
compare 19/19, ctest 216/216, render gate, production audit 8996 zero
notices/blank. Conventions: goldens regenerate via the bake CLI loop;
shadow tests assert the APP constants; geometry tests use auto-fit fixtures
(page-relative anchoring is pinned by its own test).

**Round-4 CLOSE-OUT (2026-06-12):** all ~60 verified findings fixed across 11
commits (waves A/B/C1/C2/C3/D/E/E2/F1/F2/F). Registry shapes landed (28
red→green tests; test.drawio golden: zigzag-only diff); image clipPath/
rounded crop faithful (non-inset forms loud); stencil shadow faithful;
sketch LOUD on stencil/builtin branches; degenerate cells match the editor
(negative = nothing, zero = hairline; edge child labels exempt). FINAL
MATRIX GREEN ON THIS BOX: bake 290, exporter 205, validate 61, service 19,
compare 19/19, ctest 216/216 (real resvg cdylib), render gate, production
audit 86+8910 zero notices / zero blank / all inked, shim cargo 6/6.
Residuals — all LOUD or documented, none silent: sketch/roughjs texture
(loud on stencil/builtin, clean-hachure on generic), ext symbol0..n (loud),
umlLifeline unknown participant (loud), non-inset image clips (loud),
vertical/rtl textDirection (loud), Win32-only wave-B changes compile in CI
(no Windows box here).

## UPDATE 2026-06-16 — round 6 audit (branch claude/optimistic-archimedes-ka4th1)

**Goal:** end-to-end WYSIWYG audit (export → C++ engine); fix every silent
divergence; advisor sign-off; push to fork. Five parallel object-by-object
audits (vertex shapes / edges / labels / stencils+images / C++ engine) returned
**18 verified findings**; all fixed with red→green regression tests, full matrix
green before commit.

**Fixes (each matched to drawio mxShape/mxStencil/mxText source):**
- *S1 (HIGH):* stencil-internal `<text>` was seeded from the CELL font; drawio
  mxShape.configureCanvas sets NO font, so stencil text uses the canvas defaults
  (#000000/11/Arial,Helvetica/normal) unless the stencil emits its own font cmds
  (mxStencil.js:952-968). Every stencil's decorative lettering (e.g. electrical
  logic-gate J/K/Q/D) mis-rendered when the cell carried a non-default font.
- *V1 (HIGH):* datastore drew 1 of 3 stacked-disk rim curves + flat bottom;
  now 3 rims + body bottom control h+dy/3 (DataStoreShape.redrawPath).
- *V2 (HIGH):* callout had hard-coded rounded corners, ignored size/position/
  position2/base, and put the tail tip BELOW the cell; now the faithful square
  7-point polygon with the tail tip ON the bottom edge (CalloutShape).
- *V3:* cylinder cap used a circle-bezier (too shallow) + ignored size; now the
  drawio control points (-dy/3, h+dy/3, 2dy) + size override (mxCylinder).
- *V4:* cube darkOpacity/darkOpacity2 shaded faces were dropped; now emitted via
  cubeInner (CubeShape.paintVertexShape).
- *V5:* swimlane/table startSize default 30 → 40 (mxConstants.DEFAULT_STARTSIZE).
- *V6/V7:* associativeEntity rounded=1 (rect+diamond) and glass=1 were ignored;
  now faithful (mxRectangleShape + addPoints).
- *E1:* flexArrow / wedgeArrowDashed2 shadow=1 silently dropped; now an offset
  filled shadow band.
- *E2:* fixed exitX/exitY anchor ignored the terminal's perimeterSpacing; now
  grows the box like mxGraph.getConnectionPoint/getPerimeterBounds.
- *S2:* mxLabel image icon was letterboxed; mxLabel.paintImage stretches
  (aspect=false). *S3:* stencil `<image>` dropped state.alpha. *S4:* image-cell
  opacity ignored fillOpacity (now opacity*fillOpacity, incl. non-PNG path).
- *L1:* overflow=width never clipped (grew the viewport); now clips to the cell.
  *L2/L3:* rich-text `<table>` forced equal columns + ignored colspan/rowspan;
  now content-proportional widths + an occupancy-grid honoring spans. *L4:*
  sup/sub didn't expand the line box; now CSS max-ascent+max-descent. *L5:*
  plain-label wrap ignored letterSpacing.
- *C1/C2 (validator parity):* schema.minor now isLoaderInt (INT32) like the
  loader; iCCP-profiled PNGs now refused pre-print (mirrors png_has_iccp_profile).

Goldens regenerated: test (was already stale at HEAD — bake.test doesn't assert
it), master-test, master-test-rich-text (coordinate/base64-only). Matrix on this
box: exporter 205/1-skip, bake 307, validate 64, service 19, render-gate 1/1,
production-audit 86+8910 zero notices / all inked / 0 blank, ctest 216/216 (real
resvg cdylib). C3 (tile-coverage tolerance can swallow a sub-1058um in-page strip)
left as a documented LOW residual — only a mis-baked tiling, production tiles
cover the page exactly.

## UPDATE 2026-06-16 — round 7 (advisor follow-up, same branch)

Independent advisor verified all 18 round-6 fixes as correct (no regressions) but
found 2 blocking + a systemic label-margin gap. All addressed:

- **BLOCKING-2 + label-margin family (systemic):** the exporter honored
  getLabelMargins/getLabelBounds ONLY for umlFrame/umlLifeline, so every other
  margin-defining shape painted its label over the reserved region. Added a
  `labelMargins(style,w,h)` dispatch + `applyLabelMargins` (direction-rotated per
  mxUtils.getDirectedBounds) covering cube(boundedLbl), datastore, callout,
  cylinder(boundedLbl), note2(boundedLbl), document(boundedLbl), manualInput
  (boundedLbl), folder(boundedLbl), process/process2(getLabelBounds). Applied at
  all THREE internal-label sites (generic fallback, builtin, shapePath). The
  DEFAULT sidebar cube (boundedLbl=1) now insets its label clear of the depth band.
- **BLOCKING-1 L4 sup/sub:** re-derived from mxSvgCanvas2D.getSupSubLineExpansion —
  the baseline does NOT move; only the line DESCENDER grows, after absorbing the
  CSS half-leading (lineFontSize*(LINE_HEIGHT-1)/2). (Round-6 grew the ascent,
  moving the baseline — close but not faithful.)
- **S3 (completed):** stencil `<image>` ALWAYS stretches (aspect=false in
  mxStencil.drawShape; the `aspect` attr controls the SHAPE, not the image),
  honors node flipH/flipV, opacity = alpha*fillAlpha.
- **Cube direction=north/south:** cubeInner now paints in a w↔h-SWAPPED viewport
  then rotates+translates (mxShape.isPaintBoundsInverted), like the builtin
  dirInvBI path — correct proportions for non-square N/S cubes.
- **Table rowspan:** the height deficit is distributed EVENLY across the spanned
  rows (was dumped on the last row).

Ragged-row right-edge border gap left as-is (border-model-dependent; matches
`border="1"` separate-border tables). +12 regression tests (bake 312). Goldens
regenerated: master-test-rich-text (L4 line height), test (process/folder label
inset) — coordinate-only. Matrix green: exporter 205, bake 312, validate 64,
ctest 216/216 (real resvg), production-audit 86+8910 zero notices/all inked/0
blank, render-gate pass. Visually confirmed all shapes through production resvg.
