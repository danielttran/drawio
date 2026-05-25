# Native Print — Unattended (Headless, No-Browser) Printing: Implementation Gap

**Status:** Gap analysis / implementation plan (not yet built)
**Date:** 2026-05-25
**Repository:** `danielttran/drawio`
**Companion docs:** `docs/NATIVE_PRINT_DESIGN_TO_CPP_OUTPUT_SPEC.md` (current engine spec),
`docs/CLAUDE.md` (non-negotiable constraints).
**Audience:** engineering leadership and maintainers planning an unattended,
server-side draw.io print path for medical/industrial label output.

## 1. Goal

A Windows-server **service** — no UI, no browser, no operator — that takes a
draw.io file and prints it to a medical/industrial printer such that:

1. **No browser anywhere**, at design time or print time (per `docs/CLAUDE.md` §2).
2. **Every object** (shapes, edges, markers, gradients, stencils, images, text,
   groups) prints faithfully. "Done correctly" means the print emits **zero loud
   notices** — every object is rendered, nothing falls to a stub or an
   `Exporter*`/`Rich*`/`Stubbed*`/`FontSubstituted` degradation.
3. **Fonts come from the Windows host** (host-installed; not embedded in the
   contract). This is an accepted operational requirement, not a defect.
4. **Resolution is future-proof** for medical/industrial printers (high DPI,
   dimensional accuracy, deterministic output).

## 2. Scope

| In scope (this track) | Separate track (hooks defined here) |
|---|---|
| Headless `.drawio` → frozen contract with no browser | **Dynamic data** (merge/variable fields): `T-Data` |
| Unattended host/service + machine API (no UI, no dev broker) | **Barcodes** (native symbology rendering): `T-Barcode` |
| Full-object fidelity → zero loud notices for static content | |
| Future-proof resolution / dimensional accuracy | |
| Host-font operational guarantee (preflight + clear failure) | |

The contract, protocol, and engine **already** support merge maps and barcode
nodes (`contract.hpp`, `contract_loader.cpp`, `renderer.cpp`); the separate
tracks wire the *producers* (exporter) and the *barcode renderer*. This track
must not block them — see §7.

## 3. Constraints honored (do not relitigate)

From `docs/CLAUDE.md`:

- **No browser** — not even headless Chromium / Playwright / Puppeteer /
  Electron / `jsdom`, and no in-app/runtime pixel oracle.
- **WYSIWYG by construction, not by comparison** — capture draw.io's *actual
  rendered* output; never re-derive geometry; never silently approximate.
- **Frozen, isolated engine/contract boundary** — no draw.io concepts in the
  engine; **contract-schema changes require an explicit owner decision**
  (escalate, do not infer).
- **No silent heuristic fallbacks** on the live path.

Any item below that touches the contract schema or the meaning of "browser" is
flagged **[OWNER DECISION]**.

## 4. Current state

Already browser-free and Windows-native (reusable as-is):

- **Engine core** (`src/main/native-print-engine/`): contract validation,
  transform, render trace, merge resolution — all pure C++, builds/tests on
  Linux, zero browser.
- **Win32 host** (`host/win32_services.cpp`): GDI+ drawing, printer DC output,
  `DEVMODE`/custom-stock, host-font text layout via GDI+ `MeasureString`.
- **resvg backend** (`host/svg-rasterizer/`): rasterizes `svg` artwork nodes
  from host-installed fonts; refuses `<foreignObject>` loudly.
- **Protocol** (`proto.cpp`/`proto_adapter.cpp`): `Hello`/`GetCapabilities`/
  `RenderPreview`/`Print`/… already accept a `mergeData` map and resolve it with
  no browser.

**Not** browser-free today (the gaps):

- **The bake (`src/main/webapp/plugins/nativeprint/exporter.js`) runs only in
  the browser.** It harvests draw.io's *live rendered DOM* (`graph.view`, live
  SVG nodes via `svgCellNode`, HTML labels via `transcribeForeignObjects`,
  `Range.getClientRects()`). There is no `.drawio` → contract path without a
  browser. **This is the central blocker.**
- **The transport is a dev broker** (`vite.config.mjs` Vite middleware) and the
  **UI is a draw.io dialog** (`nativeprint.js`). Neither is an unattended
  service.
- **Resolution is screen-pixel based**: contract units are `px` at 96/in, scaled
  by float `dpi/96` (`renderer.cpp`), and print is a single full-page
  antialiased raster blit at the device DPI (`win32_services.cpp` `print()`).

## 5. Gaps

| ID | Area | Current | Required | Flag |
|---|---|---|---|---|
| **U1** | Headless bake | `.drawio` → contract needs the browser DOM | `.drawio` → faithful contract with no browser | [OWNER DECISION] |
| **U2** | Unattended host/API | Vite dev broker + draw.io UI dialog | Windows service + machine API, no UI | |
| **U3** | Full-object fidelity | Loud notices on gaps; 3 text shapers | Every object faithful → **zero** loud notices | partial [OWNER DECISION] |
| **U4** | Future-proof resolution | px@96 + float scale + full-page AA blit | Physical-unit, DPI-independent, deterministic, AA-controlled | [OWNER DECISION] |
| **U5** | Host fonts | Missing face → Arial + notice | Preflight + hard, clear failure (never silent) | |

### U1 — Headless `.drawio` → faithful contract (the blocker)

The WYSIWYG guarantee depends on capturing draw.io's *actual rendered* SVG. To
keep that guarantee with no browser, we must run **draw.io's own renderer**
headlessly rather than reimplement it. Options:

- **Approach A (recommended, needs ruling): run the existing renderer/exporter
  in Node under a minimal SVG-element shim.** mxGraph's `mxSvgCanvas` and the
  exporter's `svgCellNode`/`harvestShape`/`collectDefs` build SVG by constructing
  DOM elements and serializing them — vector shape drawing is *geometry →
  element construction*, which needs **no browser layout engine**. Provide a
  narrow, purpose-built SVG element/serialization shim (explicitly **not** jsdom,
  **not** a browser, **not** a pixel oracle) so the *same* exporter code produces
  the *same* SVG bytes server-side. This is faithful **by construction** because
  it is literally draw.io's renderer, just hosted in Node.
  - **[OWNER DECISION]** Does a non-jsdom, non-pixel-oracle SVG element shim that
    runs draw.io's real rendering code count as "a browser" under `CLAUDE.md` §2?
    The rule names `jsdom` explicitly, so this must be ruled on before building.
    The *intent* of the rule (WYSIWYG-by-construction, no pixel comparison) is
    satisfied; the letter (`jsdom`) needs an explicit carve-out or rejection.
  - **The genuinely hard part is text/label layout.** `<foreignObject>` HTML
    labels and label word-wrap currently use DOM measurement. Headless, this must
    come from **font metrics** (FreeType/HarfBuzz, or the Win32 GDI+ host as a
    measurement service) — never a browser. Complex HTML/CSS labels that cannot
    be measured/transcribed faithfully stay **loud notices** (they cannot be
    silently approximated), which means U3's "zero notices" holds only for the
    object vocabulary we can measure headlessly (see U3).

- **Approach B (safe interim, fully compliant today): design-time pre-bake.** A
  human authors the label once in draw.io (browser allowed by the rule); the
  frozen contract is stored as a **template**; the unattended service consumes
  *contracts*, not `.drawio`. This works now and needs no shim ruling, but it
  prints pre-baked templates rather than arbitrary `.drawio` files.

- **Approach C (rejected): C++ reimplementation of draw.io rendering.** Violates
  the frozen-boundary rule (INV-1) and §19 of the spec; brittle; will diverge
  silently. Do not pursue.

**Recommendation:** pursue **A** for true "print any `.drawio` file unattended,"
with **B** as the immediate, compliant stepping stone. Both feed the *same*
contract the engine already consumes.

### U2 — Unattended host + machine API

- Replace the Vite dev broker with a **Windows service** that wraps the existing
  host stdio protocol (`Hello` → `Print`) behind a machine API
  (`POST /print {fileOrContract, printerId, stockId, copies, data?}`), with
  authentication, no `Origin`/browser assumptions, and structured job logging
  (already returned as `jobLog`).
- No UI, no acknowledgement gate. Because the goal is **zero loud notices**, the
  gate is replaced by a policy: **any** degradation notice = job **fails loudly**
  (refuse to print) rather than printing a flagged-but-wrong label. This makes
  "looks perfect or doesn't print" the machine contract.
- Reuse the host process lifecycle and contract temp-file handling from the
  existing broker pattern (`vite.config.mjs`) minus Vite.

### U3 — Full-object fidelity → zero loud notices

"Done correctly = no loud warning" is a precise definition of done. Each current
notice maps to a condition that must hold:

| Notice | Condition to eliminate it |
|---|---|
| `StubbedSvgArtwork` | resvg renders every captured object; no DLL-missing; no `<foreignObject>`. Requires resvg feature coverage of the supported vocabulary. |
| `ExporterUnsupportedShape` / `…Image` | Total capture: every cell harvested as its real SVG; all images embedded at bake. No heuristic fallback triggered. |
| `RichApproximate` / `RichUnsupported` / `SvgListMarkerApprox` | HTML-label content fully transcribed/measured headlessly, or the authoring vocabulary is constrained to what transcribes faithfully. |
| `GradientDirectionApprox` | No fallback `path` nodes (live SVG path only). |
| `AnimatedSvgFrozen` | Disallow animated content in the label vocabulary. |
| `FontSubstituted` | All required faces installed on the host (U5). |
| `StubbedBarcode` | `T-Barcode` track (native rendering). |
| `HardwareMarginClip` | Content fits the selected media (authoring/preflight). |

Two structural levers make "every object faithful" true rather than hoped-for:

- **Unify text rendering on one rasterizer.** Today three shapers can disagree:
  browser (design), resvg (baked SVG text), GDI+ (variable text). For identical
  static-vs-variable text and a single source of truth, render **all** text
  through one engine (resvg/fontdb, sized via host font metrics). This removes a
  whole class of "looks slightly different" divergence.
- **Define and test a faithful object vocabulary.** Enumerate the object/feature
  set the pipeline reproduces exactly through resvg (shapes, paths, gradients,
  markers, clips, images, supported text); for features resvg renders
  differently from a browser (certain filters, blend modes), either implement
  true support or **constrain the authoring surface** so they cannot appear.
  Enforce with the existing structural-invariant + vocabulary-coverage tests
  (`wysiwyg_parity_tests.cpp`, the `mxSvgCanvas` vocabulary test,
  `svg_pixel_determinism_tests.cpp`). This is how "every object, no notice"
  becomes a tested guarantee instead of a wish.

  **[OWNER DECISION]** The honest ceiling (from the no-browser/no-oracle rules):
  resvg is not Chromium, so "pixel-identical to a browser" is not provable
  without a forbidden oracle. The achievable guarantee is *faithful-by-
  construction for the defined vocabulary + deterministic*. The owner should
  confirm the supported vocabulary is sufficient for the label products.

### U4 — Future-proof resolution & dimensional accuracy

For medical/industrial output the print must be dimensionally exact and stable
across machines, DPIs, and time:

- **Physical-unit source of truth.** Carry true physical dimensions
  (microns/mm) in the contract instead of (or alongside) px@96, so a 25.4 mm box
  and a quiet zone are exact and device-independent rather than float-scaled
  screen pixels. **[OWNER DECISION]** — contract-schema change.
- **DPI independence with no double resampling.** Continue rasterizing at the
  device's true DPI (`GetDeviceCaps`), but ensure artwork is rendered *once* at
  target resolution (resvg renders to the device raster size) with no
  intermediate down/upsample. Critical edges should align to the device dot grid.
- **Bounded memory at high DPI.** The current full-page `PixelFormat24bppRGB`
  bitmap is large at 600–1200 DPI on big media. Add **banded/tiled
  rasterization** so memory is bounded regardless of DPI/media size.
- **Antialiasing control.** Today AA is forced on (`SmoothingModeAntiAlias`,
  `TextRenderingHintAntiAlias`). Add per-job/per-object control so edges can be
  crisp where required (mono/thermal heads, and barcodes in `T-Barcode`).
- **Determinism for audit.** Pin the resvg version and the host font set;
  same contract → byte-identical pixels (extend `svg_pixel_determinism_tests`).
  Record backend identity and resolved fonts in `jobLog` for traceability.
- **Color path (future).** ICC profiles are currently refused
  (`contract_loader.cpp`). Mono labels are unaffected; color medical labels would
  need a managed color path — note as future, not this track.

### U5 — Host-font operational guarantee

Fonts are host-installed by design (no embedding). To keep that from becoming a
silent divergence in an unattended context:

- **Preflight**: before printing, verify every font the contract references is
  installed on the host (GDI+ `FontFamily::IsAvailable` / resvg fontdb). Missing
  font ⇒ **fail the job loudly** with the exact missing face — never substitute
  Arial silently in unattended mode.
- **Operational doc**: required faces are a deployment prerequisite of the print
  server (mirror in runbook).

## 6. [OWNER DECISION] summary (escalate before building)

1. **U1:** Is a non-jsdom, non-pixel-oracle SVG element shim that runs draw.io's
   real renderer in Node acceptable under the no-browser rule? (Blocks "print any
   `.drawio` unattended.")
2. **U3:** Confirm the supported object/feature vocabulary; accept "faithful-by-
   construction + deterministic" as the guarantee (pixel-identity to a browser is
   not provable without a forbidden oracle).
3. **U4:** Approve a physical-unit contract dimension (schema change).
4. Whether unattended mode should **hard-fail on any notice** (recommended) vs
   print-and-log.

## 7. Integration hooks for separate tracks

- **`T-Data` (dynamic data).** The engine already resolves a `mergeData` map with
  no browser (`renderer.cpp`, `proto_adapter.cpp`). The track must (a) make the
  bake emit `text`/`barcode` nodes with `content.type:"merge"` instead of
  freezing sample values into `svg`, and (b) add variable-text box auto-sizing
  (see spec §11.5). The unattended API already carries a `data?` field for this.
- **`T-Barcode`.** The engine emits a loud barcode stub today (`renderer.cpp`).
  The track adds a native symbology renderer (deterministic, dot-grid aligned,
  AA-controlled per U4). Until then, any barcode = loud stub, so barcode labels
  are out of "zero notices" until `T-Barcode` lands.

Neither track requires a browser; both consume the same headless pipeline.

## 8. Phased plan

1. **P0 — Compliant interim (Approach B).** Stand up the Windows service + API
   (U2) consuming pre-baked contract templates; preflight fonts (U5);
   hard-fail-on-notice policy. Proves end-to-end unattended print with no
   browser, today, no schema/shim decisions.
2. **P1 — Headless bake (Approach A).** After the U1 owner ruling: host the
   existing exporter/renderer in Node under the SVG shim; headless font-metric
   text measurement; `.drawio` → contract with no browser.
3. **P2 — Fidelity hardening (U3).** Unify text rasterizer; define + test the
   faithful object vocabulary; drive supported content to zero notices.
4. **P3 — Resolution future-proofing (U4).** Physical-unit contract (post
   ruling); banded rasterization; AA control; determinism + audit logging.
5. **Parallel tracks:** `T-Data`, `T-Barcode` (§7).

## 9. Definition of done (this track)

- An unattended Windows service prints a draw.io file to the target printer with
  **no browser** at any stage and **no UI**.
- For content within the supported vocabulary, the job completes with **zero loud
  notices**; anything outside it **fails loudly** (never prints a wrong label).
- Output is **dimensionally exact** at the device's true DPI and **deterministic**
  across servers and over time (pinned engine + host fonts; recorded in `jobLog`).
- Required fonts are verified present on the host before printing.
- `T-Data` and `T-Barcode` integrate without a browser via the same pipeline.
