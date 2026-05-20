# Native Print — Manual Validation Runbook

This is the **C5 manual validation pass** that
`docs/NATIVE_PRINT_WYSIWYG_HANDOFF.md` §7 reserves as the one allowed
manual step. It is **the only step in the pipeline that needs a human
+ a physical printer**, so it is documented click-by-click so it can be
executed reliably and signed off.

The constraints in `docs/CLAUDE.md` "Native Print — NON-NEGOTIABLE
CONSTRAINTS" still apply: **no browser-based pixel oracle**. This runbook
does **not** ask the operator to pixel-diff against a screen — that would
re-introduce the forbidden browser comparison. It asks the operator to
**eyeball-compare what the canvas shows to what the printer produces**,
which is the only WYSIWYG check that survives C2.

## 0. Prerequisites

- Windows machine with at least one local printer **or** "Microsoft Print
  to PDF" installed (the latter is acceptable for the structural pass —
  use a real printer for the hardware-margin / paper-stock pass).
- A printable test diagram exported into the repo at
  `docs/fixtures/manual_validation_diagram.drawio` (commit it the first
  time you exercise this runbook; subsequent passes load the same
  diagram so results are comparable).
- A built native-print engine + Rust SVG cdylib + drawio webapp dev
  server. See `docs/PRINT_ENGINE_ACCURACY_TODO.md` §0 build commands.

## 1. Structural self-check (browser-free, automated)

Before any printer touches paper, run the structural self-check on the
test diagram. This is the **automated** half of the manual step — it
catches contract-shape regressions without needing a human eyeball:

```
node tools/native-print-validate-contract.mjs <path-to-contract.json>
```

The script (see §5) asserts the contract that the exporter produced for
this specific diagram has every invariant the engine requires:

- Every `text` node either carries `content.type: "static"` lines or a
  non-empty `content.type: "rich"` paragraphs array; never an empty
  label string.
- Every `svg` node carries a non-empty base64 `source`.
- Every node has device-positive box dimensions.
- Every `paint` node carries `fill`/`stroke`/`text_color` resolved.
- `units` is `"px"`; schema major is 1.

A failure here is a **hard stop** — the manual pass cannot proceed
with a malformed contract. Fix the bake before printing.

## 2. The manual eyeball pass (one operator, one diagram, one printer)

For every printer + stock combination you intend to ship for:

| # | Action | What to check |
|---|--------|---------------|
| 1 | Open drawio dev server (`npm run dev`), load `manual_validation_diagram.drawio` | Diagram renders normally in the canvas. |
| 2 | File → Native Print | Dialog opens; printer dropdown populated; selected stock has reasonable dimensions in the label. |
| 3 | Acknowledge any notice checkboxes | Every loud notice has its own checkbox; Print is disabled until all are checked. |
| 4 | Compare the preview thumbnail to the canvas | Same shapes, same edge routing, same arrowheads, same labels in the same positions. Pixel-identity is **not** required (driver halftoning differs); geometric/layout parity **is**. |
| 5 | Click Print | A page comes out of the printer. |
| 6 | Compare printed page to the canvas | Same eyeball check as #4, on paper. Specifically check: |
|   |        | a. Every shape outline is present and in the same position. |
|   |        | b. Every label text is fully readable and not truncated. |
|   |        | c. Every arrowhead points the same direction as the canvas. |
|   |        | d. Colors are recognizable (printer color-space differs from screen; no exact ΔE claim, but red should look red). |
|   |        | e. No object is silently missing. If a `DegradationNotice` was acknowledged, the spot it covers should still show **something** (loud crosshatch or substituted text), not blank. |

Repeat #1–#6 for the **rich-text matrix** by selecting
`manual_validation_diagram_richtext.drawio` (also at `docs/fixtures/`).
That diagram exercises:

- A single label with **bold + italic + underline + strikethrough** runs.
- A label with **mixed font sizes on one line**.
- A label with **mixed colors per run**.
- A bullet list and an ordered list.
- A label with `<br>` hard line breaks across multiple paragraphs.

## 3. Hardware-in-the-loop (HIL) pass

Use the printer's **physical capabilities** to verify (see
`docs/HIL_TEST_PLAN.md` for the precise contracts to exercise):

1. **Multi-page** — a 2-page contract prints 2 sheets in order. Tear the
   stack and confirm the page numbers (or the bottom-right page-id marker
   on the printed page) ascend.
2. **Multi-copy** — set Copies = 3, confirm 3 identical sheets.
3. **Stock change** — select two different paper sizes; confirm the
   output size matches each.
4. **Custom stock** — select "Custom… (set physical dimensions)", enter a
   non-standard size (e.g. 80 × 40 mm). Confirm the output is exactly that
   size (measure with a ruler).
5. **Hardware-margin clip** — load `docs/fixtures/edge_clip_test.drawio`
   (a diagram with content touching all four page edges); confirm the
   `HardwareMarginClip` notice fires AND the printout clips at the
   printer's hardware-margin (true-size, never silent scale).
6. **SVG artwork** — load `docs/fixtures/with_embedded_svg.drawio`;
   confirm:
   - The embedded SVG prints as real artwork (not crosshatch) **when the
     `svg_rasterizer.dll` is dropped next to `print_engine_host.exe`**.
   - With the DLL removed, the crosshatch + `StubbedSvgArtwork` notice
     appear.
   - `jobLog.svgRasterizer` records the backend identity (e.g.
     `"resvg 0.47"`) on success or `"none"` on fallback.

## 4. Sign-off

After §1–§3 pass, fill in the bottom of this file in a follow-up commit:

```
Signed-off-by: <operator name>
Date:          <YYYY-MM-DD>
Printer:       <make + model>
Driver:        <version>
Engine build:  <git sha>
Notes:         <anything anomalous; "none" if clean>
```

Sign-off blocks land in `docs/MANUAL_VALIDATION_SIGNOFFS.md` so the
runbook itself stays canonical and historical sign-offs accrue
separately.

## 5. The self-check script

See `tools/native-print-validate-contract.mjs`. It is a Node script
(no browser, no jsdom, no Playwright) that loads a JSON contract from
the disk and asserts the engine-invariants list above. It is the
automated half of the manual step; running it is a hard precondition
to clicking Print on a diagram.

The script's exit code is **0 on every invariant satisfied, 1 on any
violation** (with a precise `path: detail` printout). It is wired into
the engine-linux CI job under `tools/native-print-validate-contract.test.mjs`
which runs the script against a checked-in fixture contract.
