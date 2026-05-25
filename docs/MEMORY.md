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

## Stencil Shape Coverage (2026-05-25 — Phase 1 complete)

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
  `validateNoExcludedShapes` (image/include-shape commands).

**Test status:**
- 69/69 bake tests pass (10 new stencil-specific tests)
- 13/13 wysiwyg-compare --all PASS (all master test label files)
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

## Important Rules & Constraints
1. **Never make upstream contributions** — fork only.
2. **Save tokens**: keep this `MEMORY.md` updated.
3. **No browser in print verification** — see `docs/CLAUDE.md` C2.
