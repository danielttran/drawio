# Print Engine — Rich-Text (HTML label) Implementation Plan

**Status:** authoritative, code-grounded implementation plan. Supersedes the
*planning* portion of `PRINT_ENGINE_RICHTEXT_TODO.md` (kept as the originating
work order). Read `PRINT_ENGINE_ACCURACY_TODO.md` §0 ground rules and §2 first
— this work *extends* the §2 measure-at-the-sink layout, it does not replace it.

**Owner decision recorded (2026-05-18):** the additive `content.type:"rich"`
shape is **authorized as a backward-compatible v1.x addition** (minor-level,
same pattern as `font.underline`/`font.strikethrough`). Schema *version* does
not affect fidelity — WYSIWYG accuracy comes from the run model + the device
metric sink, not the version label — so the lowest-risk additive path is taken.
`static` and `merge` are unchanged; the engine keeps loudly rejecting unknown
shapes. The metrics gate is already cleared (§2 done & audited).

---

## 1. Goal, restated as testable requirements

| # | Requirement | How it is met | How it is verified |
|---|-------------|---------------|--------------------|
| G1 | Print drawio rich-text labels via the C++ engine | Neutral run model in the contract; engine + GDI+ sink draw it | Golden suite below |
| G2 | **WYSIWYG, absolute accuracy** | Styling captured from the *live rendered label DOM* (exactly what the user sees); line-breaking + sizing done with the *device's own* font metrics in the one shared sink (preview == print) | Golden-image diff; §2 acceptance bars extended to runs |
| G3 | **No browser dependency** | HTML→run conversion happens at *bake time inside drawio's already-running renderer* (authoring side). The engine, the sink, and the print path contain zero HTML/CSS/browser code (INV-1). No headless Chromium, no `foreignObject`, no html2canvas. | `architecture_tests.cpp` banned-token scan; engine builds with no DOM |

**Honest accuracy boundary (G2).** Pixel-identical reproduction of an arbitrary
browser CSS box model *without a browser* is not attainable in general. It is
not required here: drawio labels are a constrained subset, and drawio's own
label layout is simple (it fixes the label width from the cell geometry and
lets the browser wrap inside it). The attainable and committed bar is:

> Every run's **style** (family, size, weight, italic, underline,
> strikethrough, color) is faithful to what drawio rendered on screen; line
> breaking, alignment, vertical placement and shrink are computed with the
> **real device glyph metrics that actually print** (same numbers preview and
> print); anything outside the modeled subset produces a **loud
> `DegradationNotice`** the operator must acknowledge — never a silent wrong
> result.

This is exactly the standard §2 already set and audited for plain text; rich
text is the multi-run generalization §2 was explicitly designed to allow
(`PRINT_ENGINE_ACCURACY_TODO.md` §2 "Coupled work").

---

## 2. Where the code is today (grounded)

Pipeline: **exporter (browser) → JSON contract → engine (validate + forward) →
sink (measure + draw)**.

- **Exporter** `src/main/webapp/plugins/nativeprint/exporter.js`
  - `plainLabel()` (≈L216–227) **strips all HTML**: `<br>`→`\n`, regex-removes
    every tag, then `textContent`. All formatting is lost here.
  - `textNode()` (≈L229–248) emits one uniform run:
    `content:{type:'static', lines:[…]}` with a single `font` from the cell
    style and `fontStyle` bitmask (1 bold / 2 italic / 4 underline / 8 strike).
  - `emitVertex()` (≈L361–405) / `emitEdge()` (≈L407–437) call
    `plainLabel()`+`textNode()`. Edge label box is heuristically sized in
    `edgeLabelBox()` (≈L259–273).
- **Contract** — frozen v1.1 schema, Appendix A of
  `PRINT_ENGINE_ACCURACY_TODO.md` (≈L363–400). `text` node carries
  `box / font / align / content{static|merge}`.
- **Engine** `src/main/native-print-engine/`
  - `src/contract_loader.cpp` `validate_text_content()` (≈L793–865): requires
    `content.type`; `static`→`lines[]`, `merge`→keyed fields; **unknown
    `type`→`ContractEnumError`** (≈L817). Unknown *scalar* fields are tolerated.
  - `src/renderer.cpp` `render_to_trace()` (≈L99–145): **no layout in the
    engine** — builds one `EmittedCommand{kind:Text}` (≈L126–144) forwarding
    raw `label` (with `\n`), `font_*`, `box`, and `align/wrap/overflow/
    shrink_floor` policy verbatim ("measure-at-the-sink"). INV-1: no HTML/editor
    concept anywhere in `include/`+`src/` (scanned by
    `tests/architecture_tests.cpp`).
  - v2 bridge: `src/proto.cpp` / `src/proto_adapter.cpp` /
    `src/native_print.cpp` carry the trace as `NativeDrawCommand`s
    (`DrawText` carries label+font+box+policy, no pre-layout).
- **Sink** `src/main/native-print-engine/host/win32_services.cpp`
  `draw_trace()` text branch (≈L494–650): the real layout engine. Splits the
  label on `\n` (≈L530–541); `measure_w` lambda = GDI+ `MeasureString`
  (≈L545–552); `build(em)` lambda (≈L560–596) does measured word-wrap
  (`wrap=="word"`), computes `line_h` from `Font::GetHeight`, block w/h;
  shrink-to-fit loop (≈L601–607); loud `MergeOverflowError`/`MergeClip`
  (≈L610–622); vertical align (≈L624–629); per-line horizontal align +
  `DrawString` (≈L636–649). Preview and print both call this one function
  (INV-5). The measurer is **single-font today** — this is the one place that
  becomes run-aware.

**Conclusion:** the architecture already routes text the right way. Rich text
is: (a) stop flattening in the exporter, capture runs; (b) carry a neutral run
model in the contract; (c) forward it unchanged through the engine; (d)
generalize the *one* sink layout function from "lines of one font" to "lines of
mixed runs". No new rendering subsystem; no browser anywhere on the print path.

---

## 3. Architecture decision — the chosen path (and rejected ones)

**Chosen:** parse the label into a **neutral paragraph/run model in the
exporter**, prefer reading the **live rendered label DOM** (`state.text.node`)
over re-parsing the HTML string, carry the model in the contract, forward it
verbatim through the engine, and lay it out **run-aware in the existing sink**
with device metrics.

Why read the *live rendered* label node and not just re-parse the HTML string
(a refinement over the original TODO): drawio has already applied the cell base
style, `html=1` container styles, theme CSS and the actual wrap width to the
on-screen label. `getComputedStyle` on the *rendered* node yields exactly the
pixels the user sees — true WYSIWYG — and gives us drawio's *actual* wrap width
and whitespace handling instead of re-deriving them. Re-parsing a detached
string requires us to re-implement drawio's base-style merge and is strictly
less accurate. The detached parse is kept only as a headless fallback (§5).

**Rejected (do not revisit):**
- **`foreignObject` → SVG rasterizer.** resvg does not render `foreignObject`;
  librsvg's support is poor → blank labels. Fenced in
  `PRINT_ENGINE_SVG_TODO.md` §0.
- **Browser/DOM rasterization (html2canvas) → embedded bitmap.** Bakes text at
  one DPI, prints at another → blurry; resolution-dependent; breaks INV-5.
- **Headless Chromium / WebView in the engine or host.** Reintroduces the
  browser dependency G3 forbids; non-deterministic; INV-1 violation.

---

## 4. Supported subset and the loud-degrade contract

**Supported (faithful target):**
- Block structure: `<div>`, `<p>`, `<br>` → paragraphs / hard line breaks.
- Inline runs: `<b>/<strong>`, `<i>/<em>`, `<u>`, `<s>/<strike>/<del>`,
  `<font color size face>`, `<span style>`, nested inline styles.
- Per-run: font family, size (px, resolved from pt/em/% by `getComputedStyle`),
  weight, italic, underline, strikethrough, color.
- Per-paragraph horizontal alignment; block vertical alignment.
- Simple `<ul>/<ol>/<li>` (single level): bullet/number prefix as a run.

**Out of subset → emit `DegradationNotice` (operator must ack; never silent
flatten):** embedded images inside labels, tables, multi-level/nested lists,
arbitrary CSS we don't model (letter/word-spacing, text-shadow, transforms,
writing-mode), background highlight, sub/superscript, RTL/bidi & complex
scripts, `merge` combined with `rich`. Degrade to best-effort styled plain text
**and say so loudly** (consistent with the project's loud-fail philosophy).
Reuse the existing `degradation()` helper in the exporter and the engine
`DegradationNotice` surface.

**HTML-label transcription (implemented, exporter `svgCellNode`).** HTML
labels are NEVER shipped as `<foreignObject>` and are NEVER re-laid-out by
the engine. At bake time the live-DOM rendered label is transcribed to
plain SVG primitives at the exact screen positions: one `<g matrix>` (M =
screen→cell-SVG-local, carrying drawio's rotation/zoom/flip), top-anchored
`<text>` per measured word (no baseline/metric guessing), `<rect>` for
label + inline backgrounds, `text-decoration` for underline/strike/overline,
deterministic glyphs for standard list markers. Notices:
- `SvgListMarkerApprox` — list marker position derived from content
  metrics, or a non-standard `list-style-type` rendered as a bullet
  (faithful-or-loud).
- **Hard fail (no notice — aborts the whole export):** a foreignObject
  with real text but an unmeasurable live DOM throws `NativePrintFatal`.
  Per owner ruling, a missing/approximated object on print is unacceptable
  and there is no faithful source without the DOM (a browser is forbidden,
  G3), so the export refuses rather than emit a wrong/partial page. The
  legacy `SvgForeignObject` verbatim-passthrough notice is retired.

---

## 5. Browser-dependency analysis (G3 — explicit)

- The exporter **already runs inside drawio's live renderer** (it reads
  `graph.view`, computed state). Reading the rendered label DOM there adds
  **zero** new browser dependency — that browser is the authoring app, not the
  print path.
- The **contract is pure JSON** containing only the neutral run model. The
  engine library and the GDI+ host contain **no** HTML/CSS/DOM/browser code;
  this is enforced by `architecture_tests.cpp` (INV-1 banned-token scan) and by
  the engine building with no DOM present.
- **Print/preview path is browser-free end to end:** JSON → C++ validate →
  C++/GDI+ measure+draw. No Chromium, no WebView, no `foreignObject`.
- **Headless/CLI bake fallback:** if a contract is ever baked outside a live
  drawio (no rendered node), the exporter uses a small **deterministic HTML
  tokenizer** over the constrained subset above (tag/style → run attributes).
  This is a *parser*, not a layout/CSS engine, and still emits the same neutral
  model — the print path stays browser-free. Live-DOM path is preferred for
  accuracy; tokenizer path emits a `RichApproximate` notice when it must guess
  an inherited value.

---

## 6. Contract schema change (additive, v1.x)

Add a third `content.type`. `static`/`merge` byte-unchanged.

```jsonc
"content": {
  "type": "rich",
  "paragraphs": [
    {
      "align": "left|center|right",          // per-paragraph horizontal
      "indentPx": <num >= 0>,                 // optional, default 0 (list hang)
      "runs": [                                // MAY be empty -> blank line
        {
          "text": "<string, no newlines>",
          "fontFamily": "<string>",
          "sizePx": <num > 0>,
          "weight": <int 100..900>,
          "italic": <bool>,
          "underline": <bool>,
          "strikethrough": <bool>,
          "color": "#rrggbb"
        }
      ]
    }
  ]
}
```

Notes:
- **Blank lines are real (WYSIWYG).** An empty paragraph (`runs: []`, or a
  single whitespace run) is **valid** and the sink must still advance one line
  height. Double `<br>` / empty `<div>` → an empty paragraph. The loader MUST
  NOT require `runs` non-empty (see §8); WYSIWYG fidelity (G2) depends on this.
- Hard line breaks within a paragraph are modeled as separate paragraphs (the
  sink already treats each as a measured line). `<br>` → new paragraph that
  **inherits the containing block's `align` and the current run style** (it is
  not reset to the default).
- **List markers are baked as text, not interpreted.** The engine/sink stay
  list-agnostic (INV-1, no stateful numbering in the sink). The *exporter*
  emits the literal marker ("• ", "1. ", "a. ") as the **first run** of the
  paragraph and sets `indentPx` for the hanging indent. There is no
  `listMarker` enum — numbering is computed once, in the exporter, from the DOM.
- Block vertical alignment still comes from the existing top-level `align.v`.
  Top-level `align.h` is the block default; **per-paragraph `align` overrides
  it** and is the value the sink must use for each line (see §9).
- Run fields mirror the existing `font` object names so the sink reuses the
  same `font_style_for`/family/colour code.
- **Appendix A delta:** add the `rich` content alternative under the `text`
  node in `PRINT_ENGINE_ACCURACY_TODO.md` Appendix A (the authoritative frozen
  copy) in the same commit as the loader change, so spec and code never drift.

---

## 7. Exporter design (`exporter.js`)

Replace flatten-only with a model builder, behind an internal capability flag
(`richText`, default on; off → current plain behavior, for bisecting).

1. **Gate rich vs plain.** Use `graph.isHtmlLabel(cell)` (Graph.js ≈L360). If
   false, the label is plain — keep the existing `static` path unchanged
   (do not emit `rich`). Only HTML labels go through the builder.
2. **Find the rich *content* node — not the wrapper.** `state.text` is the
   mxText shape; `state.text.node` is a **positioning wrapper**, the rich
   markup is **nested inside it** (mxText resolves the content element itself —
   it is `node.firstChild.firstChild` in the HTML-label case; see
   `shape/mxText.js` ≈L463–470). **Reuse mxText's own resolved content node;
   do not hard-code the nesting** (it differs by dialect and drawio version).
   Rooting the walk at the wrapper would pollute `getComputedStyle` with the
   wrapper's layout styles. The `<object label="…">` value wrapper is already
   resolved by drawio before render, so the rendered content node is correct;
   the §5 fallback uses `graph.getLabel(cell)` which also resolves it.
   `getComputedStyle` requires the node be attached & rendered (true at bake
   time) — if not, take the §5 tokenizer path and emit `RichApproximate`.
3. **Resolve the base run** from the cell's resolved drawio style (family,
   sizePx from `fontSize`, weight from `fontStyle&1`, italic `&2`, underline
   `&4`, strike `&8`, color `fontColor`) — inherited default for text/nodes
   carrying no explicit CSS.
4. **DOM walk** (never regex on the live path). Depth-first over the content
   node:
   - Text node → push a run: text = node data with **HTML whitespace
     collapsing driven by the element's computed `white-space`** (read it —
     drawio sets `whiteSpace=wrap|nowrap`; do not assume `normal`): for
     `normal/nowrap` collapse runs of space/tab/newline → single space and trim
     per CSS; for `pre*` preserve. Style = `getComputedStyle(parentElement)`
     mapped to run fields: `font-weight ≥ 600 → 700 else 400`;
     `font-style:italic`; `text-decoration-line` (computed, not the `text-
     decoration` shorthand) contains `underline`/`line-through`; `font-family`
     first resolved family; `font-size` already px; **`color` is returned as
     `rgb(...)`/`rgba(...)` by `getComputedStyle` — convert to `#rrggbb`** (the
     existing `hex()` only handles `#`; add an `rgb()` parser; drop CSS alpha
     with a `RichApproximate` notice since the run colour model is opaque).
   - `<br>` → end current paragraph, start a new one **inheriting the
     containing block's `align`** and the current run style.
   - Block element (`div`,`p`,`li`,header) → flush/begin a paragraph; paragraph
     `align` = computed `text-align` of that block. For `li`: compute the
     marker **in the exporter** ("• " for `ul`; the running counter "1. ",
     "2. " … for `ol`, honoring `start`/`type`) and emit it as the paragraph's
     **first run** (base style), set `indentPx`. **Single level only**; a
     nested `ul/ol` → `RichUnsupported` notice + best-effort flat runs.
   - An empty block / consecutive `<br>` → an **empty paragraph** (`runs: []`)
     — preserved (blank line, §6).
   - Skip & **notice** unsupported nodes (`img`, `table`, `sub`, `sup`,
     background-highlight spans, etc.) via `degradation('RichUnsupported', …,
     cell.id)`; still emit their text as a best-effort plain run.
5. **Normalize:** merge adjacent runs with identical style; **keep** empty
   paragraphs (blank lines); drop a single trailing empty paragraph only if it
   is an artifact of a final block close (match drawio's own trailing-newline
   behavior — verify against a live label, do not guess); ensure ≥1 paragraph.
6. **Emit** `content:{type:'rich', paragraphs:[…]}` from `textNode()`; keep the
   existing top-level `font`/`align` as the block default + back-compat for
   consumers reading only those.
7. **Edge labels — keep the box, enrich only the content (v1).** Reuse the
   existing `edgeLabelBox()` geometry unchanged; only swap its `content` to
   `rich`. Replacing the box with measured DOM bounds requires converting
   client-rect px back through `origin`/`scale` and risks regressing edge-label
   placement — **explicitly deferred / out of scope for v1** (revisit only with
   a dedicated test).
8. **Tests:** extend `exporter.test.mjs` with a jsdom/fake-DOM matrix
   (bold/italic/underline/strike, multi-color, mixed sizes, multi-paragraph
   mixed align, single-level ol numbering + bullet, nested-list degrade,
   img-in-label degrade, **blank line via double `<br>`**, whitespace
   collapsing incl. `white-space:nowrap`, **`rgb()`/`rgba()` → `#rrggbb`**,
   `<font>` vs CSS precedence, `<br>` inherits block align, edge labels keep
   box). Node-pure where possible; browser e2e for the live-node path.

---

## 8. Engine changes (`include/`, `src/`) — stays HTML-free

1. **`contract_loader.cpp` `validate_text_content()`** (function at L793): the
   `rich` branch goes **after the `static` block and immediately before the
   `if (type.value() != "merge")` enum-reject guard at ≈L816–818** (so an
   unknown type still falls through to `ContractEnumError "unknown text content
   type"`). Use the existing primitives (`require_array` L284, `require_string`
   L301, `reject_key` L551). Validate: `paragraphs` is a **non-empty** array;
   each paragraph has `align ∈ {left,center,right}`, optional `indentPx ≥ 0`,
   and a `runs` array that **MAY be empty** (empty = blank line — do **not**
   reject it; §6 / WYSIWYG G2 depend on this); each present run has `text` (string,
   may be empty), `sizePx > 0`, `weight` int, the three bools, `color`
   `#rrggbb`. Reject `static`/`merge`-only keys on a `rich` node via
   `reject_key` (mirror the `static` block at ≈L808). Populate a new
   `TextContentType::Rich` + `std::vector<RichParagraph>` on `PaintNodeSummary`
   (additive fields; keep the C++20 designated-init pattern §2 left in place).
   Set `document.has_rich_text` for notice/telemetry parity.
2. **`renderer.cpp` `render_to_trace()`** (≈L126–144): for `Rich`, **forward
   the runs verbatim** into the `EmittedCommand` — *no layout in the engine*
   (preserve measure-at-the-sink and INV-1). Extend `EmittedCommand`/
   `RenderTrace` with an optional `std::vector<RichParagraph> rich` (designated
   initializer; default empty → existing static/merge path untouched). `merge`
   stays plain; `rich`+`merge` is rejected at validation (out of subset).
3. **v2 bridge** (`proto.cpp`/`proto_adapter.cpp`/`native_print.cpp`): carry
   the run vector on the `DrawText` `NativeDrawCommand` (additive field).
   No layout here either.
4. **INV-1:** no token from the banned list enters `include/`+`src/`; the run
   model uses neutral names (`RichRun`, `paragraphs`). `architecture_tests.cpp`
   must stay green.

---

## 9. Sink changes (`host/win32_services.cpp` `draw_trace`) — the only layout

Generalize the **existing** text branch (≈L494–650) from "lines of one font"
to "lines of mixed runs". This is additive: if `c.rich` is empty, the current
code path runs unchanged.

1. **Per-run GDI+ font/brush cache** keyed by (family, em·scale, style,
   color); font-substitution notice per missing family (reuse existing
   `FontSubstitution` push at ≈L508–515, now per run).
2. **`measure_w` → per-run measure.** Keep the same
   `MeasureString`+`GenericTypographic`+`MeasureTrailingSpaces` flags (§2
   parity) but measure each run with *its own* font; a line's width = Σ run
   widths.
3. **Run-aware `build(emFactor)`** replacing the single-font lambda. `emFactor`
   is a **uniform scale applied to every run's own size** (not a single em — a
   refinement vs the §2 single-font lambda; rename accordingly). Walk
   paragraphs; within a paragraph word-wrap **across runs** when `wrap=="word"`
   — accumulate words carrying their run identity, break when the measured
   candidate width (Σ per-run widths) exceeds `box.Width − indentPx`.
   - **Blank line:** a paragraph with no runs (or only whitespace) still
     produces **one line** whose `line_h` = the base-font height at the current
     factor (use the node's top-level `font`). It must occupy vertical space
     (WYSIWYG, §6).
   - **`line_h` = the max run height on that line** (`Font::GetHeight` per run).
   - Record, per laid line, the **max ascent** over its runs (from
     `FontFamily::GetCellAscent`/`GetEmHeight`) — needed for baseline alignment
     in step 5. `block_w`/`block_h` from the laid lines.
4. **Shrink-to-fit** (≈L601–607): the loop now decrements **`emFactor`** (start
   1.0). Every run scales by the same factor (relative sizing preserved →
   WYSIWYG). **Floor:** stop when reducing further would push the **smallest
   run** below `shrink_floor_px·scale` (define the floor in factor terms:
   `floor_factor = (shrink_floor_px·scale) / min_run_px`); same loud
   `MergeOverflowError` / `MergeClip` / clip semantics as §2 (unchanged).
5. **Vertical block align** (≈L624–629) unchanged (uses `block_h`).
   **Horizontal align is now per-paragraph:** for each line use **that
   paragraph's `align`** (NOT the single `c.align_h`; `c.align_h` is only the
   block default / non-rich path). Line start x = box.X + `indentPx`, then
   `+ (boxW−indentPx − lineW)·{0|½|1}` for left/center/right.
   **Mixed-size baseline alignment (required for WYSIWYG):** runs of different
   sizes on one line MUST share a baseline. Draw each run at
   `y = lineTop + (lineMaxAscent − runAscent)` (do **not** draw all runs at the
   same top y — that top-aligns glyphs and looks broken). Advance x run-by-run
   by each run's measured width; each run uses its own cached font/brush.
   **Underline/strikethrough are drawn as lines** (GDI+ underline unreliable
   across fonts): underline at the run baseline + descent fraction,
   strikethrough at ~0.5 ascent, thickness ≈ max(1, em·scale·0.06), in the run
   colour.
6. **INV-5:** still one `draw_trace`; preview and print emit identical run draw
   calls at the same DPI.

---

## 10. Phasing (TDD slices — keep ctest green every step)

1. **Schema + loader.** Appendix A delta; `rich` validation + reject tests in
   `contract_loader_tests.cpp`/`contract_validation_tests.cpp`. (Engine green.)
2. **Renderer forward.** `Rich` → runs in trace, no layout; extend
   `wysiwyg_parity_tests.cpp`/`phase2_static_text_tests.cpp` to assert verbatim
   forward + box invariant + INV-1 (`architecture_tests.cpp` green).
3. **Exporter.** DOM-walk builder + degrade notices behind the flag; jsdom
   matrix in `exporter.test.mjs`; real-engine cross-process render test.
4. **Sink.** Run-aware `build`/measure/draw + drawn underline/strike; numeric
   layout asserts; extend host e2e (`host/tools/exporter_e2e.js`).
5. **Golden suite.** Mixed bold/italic/underline/strike, multi-color, mixed
   size, multi-paragraph mixed align, single-level list → into the §9 golden
   harness; preview==print structural check; `ctest` + exporter suite green.
6. **v2 bridge** parity for `DrawText` runs; proto tests.

---

## 11. Definition of done

1. A label with mixed bold/italic/underline/strike, multiple colors, mixed
   font sizes, multiple aligned paragraphs, and a single-level list prints with
   every run faithful and correct measured line-breaking/alignment.
2. Preview and print emit identical run draw calls at the print DPI (INV-5);
   §2 acceptance bars (advance error <0.5 px @600 dpi; align ±1 px) hold
   per run.
3. Engine `include/`+`src/` contains zero HTML/editor concept
   (`architecture_tests.cpp` green); print path has no browser dependency.
4. Every unsupported HTML construct yields an acknowledged
   `DegradationNotice` — no silent flattening anywhere.
5. `static` and `merge` labels unchanged (byte-identical contracts; existing
   tests green).
6. `ctest` green; `npm run test:nativeprint-exporter` green; rich golden suite
   green in CI.

Update `docs/MEMORY.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/SPEC_COVERAGE.md`
as milestones land.

---

## 12. Risks & mitigations

- **Browser↔device metric gap.** Mitigated by the §2 model: drawio fixes the
  wrap *width*; the *breaking and sizing* are done with device metrics that
  also print (preview==print). Residual sub-pixel wrap differences vs the
  browser are accepted (documented, same as §2) — not silent errors.
- **`getComputedStyle` only on attached nodes.** The live-node path requires
  the label rendered (true at bake time in drawio). Headless → §5 tokenizer +
  `RichApproximate` notice.
- **Schema drift.** Appendix A delta lands in the *same commit* as the loader
  branch; loader rejects malformed `rich` loudly.
- **Scope creep (tables/nested lists/bidi).** Explicitly out of subset →
  loud-degrade; do not silently half-implement.
- **CJK/complex shaping.** GDI+ measures actual glyph runs, so width is honest;
  bidi reordering is out of subset → notice.

---

## 13. Open items

- None blocking. Schema authorized (additive v1.x, §6). All other gates
  (metrics §2) already cleared. Proceed at Phase 1.
