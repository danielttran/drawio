# Native Print — Hardware-In-The-Loop (HIL) Test Plan

The engine + host + exporter are netted by automated tests (engine
ctest, exporter `node --test`, the cross-platform SVG cdylib pixel
golden, and the contract self-check validator). What those nets do
**not** cover is the physical printer driver, the physical paper
stock, the physical ink/toner, the physical hardware margin, and the
physical multi-page paper-handling. This document is the precise,
ordered HIL pass that exercises everything the automated nets cannot.

It is paired with `docs/MANUAL_VALIDATION_RUNBOOK.md` (the broader
runbook that the C5 manual sign-off references). HIL is the §3
subset of that runbook.

## 0. Pre-flight

| Requirement | How to satisfy |
|---|---|
| A real printer reachable by the host | Local USB, network, or "Microsoft Print to PDF" for the structural HIL subset (does NOT cover physical margins or ink/toner — use a real printer for those). |
| `print_engine_host.exe` built Release on the SUT machine | See `PRINT_ENGINE_ACCURACY_TODO.md` §0. |
| `svg_rasterizer.dll` dropped next to `print_engine_host.exe` | `cargo build --release` in `host/svg-rasterizer/`; copy `target/release/svg_rasterizer.dll`. |
| The drawio dev server can reach the host | `npm run dev` from the repo root; the Vite middleware broker connects to the engine over framed stdio. |
| Calipers / ruler | Required for the custom-stock and hardware-margin tests. |
| A second machine / camera | Optional; useful for capturing a side-by-side photo of canvas vs paper for the sign-off. |

## 1. The test contracts

Each row below references a fixture that lives at
`docs/fixtures/<name>.drawio`. When you exercise HIL for the first
time, **commit the fixture files** so subsequent passes load
byte-identical inputs and results are comparable across drivers.

| Fixture | Purpose |
|---|---|
| `manual_validation_diagram.drawio` | Mixed shapes/edges/labels — the WYSIWYG smoke. |
| `manual_validation_diagram_richtext.drawio` | Bold/italic/underline/strikethrough mixed-run labels + a bullet list + an ordered list + a `<br>` paragraph break. |
| `edge_clip_test.drawio` | Content touching all four page edges (drives `HardwareMarginClip`). |
| `with_embedded_svg.drawio` | An embedded `<svg>` artwork shape (drives the resvg pipeline + `SvgArtworkRasterized`). |
| `two_pages.drawio` | A 2-page document; pages have distinct content (top-right page-id marker). |

## 2. The 9 HIL cases (canonical ordering)

Run them in order. Each case has a single, **physically measurable**
acceptance criterion — no eyeballing aside from the WYSIWYG diff in case 1.

### HIL-1 — WYSIWYG smoke

- Load `manual_validation_diagram.drawio`. File → Native Print.
- Stock: default. Copies: 1.
- **Acceptance:** the printed page geometry/layout matches the canvas
  the operator sees, with all shapes/edges/labels in the same positions.
  Pixel-identity is not claimed; the operator decides "matches" by eye.

### HIL-2 — Multi-copy

- Same diagram. Set Copies = 3.
- **Acceptance:** the printer produces **exactly 3** sheets, each
  identical to HIL-1's output.

### HIL-3 — Multi-page

- Load `two_pages.drawio`. Copies: 1.
- **Acceptance:** exactly **2** sheets in order. The page-id marker on
  each sheet identifies the page; ordering must be page-1 → page-2.

### HIL-4 — Stock change (named)

- Same diagram. Change the stock to a different named entry
  (e.g. A4 vs Letter). Copies: 1.
- **Acceptance:** the output paper size matches the **selected** stock
  (verify with a ruler or by comparing to a known sheet). Diagram
  content stays 1:1 (no scaling); extra paper is whitespace.

### HIL-5 — Custom stock (DMPAPER_USER)

- Same diagram. Select "Custom… (set physical dimensions)". Enter
  W = 80 mm, H = 40 mm.
- **Acceptance:** the printed sheet measures **80 × 40 mm ± 0.5 mm**
  (printer feed tolerance). Diagram content stays 1:1.

### HIL-6 — Hardware margin

- Load `edge_clip_test.drawio`. Copies: 1.
- **Acceptance:**
  - The notice list shows a loud `HardwareMarginClip` notice **before**
    Print is enabled.
  - The printed page **clips** content at the printer's
    physical-margin boundary — no silent scaling to fit.
  - Measure the clip distance from each edge: it should match
    `GetDeviceCaps(PHYSICALOFFSETX/Y)` for that printer.

### HIL-7 — SVG artwork rendered

- Drop `svg_rasterizer.dll` next to `print_engine_host.exe`.
- Load `with_embedded_svg.drawio`. Copies: 1.
- **Acceptance:**
  - The notice list includes both `StubbedSvgArtwork` (engine posture)
    and `SvgArtworkRasterized` (device-side success, with backend
    identity like `"resvg 0.47"` in the detail).
  - The printed embedded SVG is **real artwork** (not crosshatch).
  - `jobLog.svgRasterizer` value reported in the dialog or the spool
    log is `"resvg <version>"`.

### HIL-8 — SVG artwork loud-stub fallback

- Remove (or rename) `svg_rasterizer.dll` so the loader fails.
- Re-open the same diagram. Native Print.
- **Acceptance:**
  - Only the engine's `StubbedSvgArtwork` notice fires (no
    `SvgArtworkRasterized`).
  - The printed page shows a loud diagonal crosshatch where the SVG was
    — **never silently blank**.
  - `jobLog.svgRasterizer` is `"none"`.

### HIL-9 — AbortDoc on mid-job failure

- This requires a printer that can be made to fail mid-job
  (out-of-paper, taken offline, etc.). Use any natural fault method.
- Load `two_pages.drawio` and start printing.
- Trigger the fault between page 1 and page 2 (eject paper / power off /
  unplug network).
- **Acceptance:**
  - The host returns a typed `PrintDeviceError` whose detail names
    the failing page id and tile index.
  - The spooler shows the job **aborted**, not partially completed.
    (No half-printed page-2 should reach the output tray.)
  - On the *next* attempt with the fault cleared, the full 2-page job
    succeeds — no leftover state.

## 3. Pass / fail recording

Capture the outcome in `docs/MANUAL_VALIDATION_SIGNOFFS.md` (one entry
per printer + driver combination). Required fields:

```
Printer model:   <make/model>
Driver version:  <as reported by Windows>
Engine SHA:      <git rev-parse HEAD>
SVG cdylib SHA:  <git rev-parse HEAD of host/svg-rasterizer/Cargo.toml>
Date:            <YYYY-MM-DD>
Operator:        <name>
HIL-1..HIL-9:    [pass|fail|skipped: <reason>]
Notes:           <anomalies; "none" if clean>
```

A printer/driver combination is "passing" iff HIL-1..HIL-8 are pass and
HIL-9 is pass OR explicitly skipped with "printer cannot be faulted on
demand". HIL-9 is the highest-confidence test of the
v2.0 §5.2 "never a silent partial" rule and should be skipped only
when the hardware genuinely cannot be made to fault.

## 4. What this does NOT cover (out of scope for HIL)

- Color management / ICC profiles. Engine refuses ICC-profiled PNG
  loudly; further color-fidelity is a separate spec workstream
  (`PRINT_ENGINE_SPEC_v2.0.md` §3.5).
- Barcode SDK behavior. The barcode primitive is a loud stub until the
  external enLabel SDK adapter lands. Out of HIL.
- Cross-OS validation. Print is Windows-only by owner decision.

## 5. Why no automated HIL

The non-negotiable C2 rule forbids browser-based pixel oracles. Real
printer driver behavior cannot be simulated without re-introducing a
forbidden oracle. The closest automated substitute is the trace-based
synthetic device-caps tests in `tests/phase7_v2_native_bridge_tests.cpp`
(mock GDI+ surface, mock device caps, mock paper-stock lookup). These
catch the engine-level regressions; the printer-driver regressions
require this HIL pass.
