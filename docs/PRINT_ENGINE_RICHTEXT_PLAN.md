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
      "listMarker": "none|bullet|number",     // optional, default "none"
      "runs": [
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
- Hard line breaks within a paragraph are modeled as separate paragraphs (the
  sink already treats each as a measured line); `<br>` → new paragraph with the
  inherited run style. Vertical/horizontal block alignment still comes from the
  existing `align{h,v}` (paragraph `align` overrides `h` per paragraph).
- Run fields mirror the existing `font` object names so the sink reuses the
  same `font_style_for`/family/colour code.
- **Appendix A delta:** add the `rich` content alternative under the `text`
  node in `PRINT_ENGINE_ACCURACY_TODO.md` Appendix A (the authoritative frozen
  copy) in the same commit as the loader change, so spec and code never drift.

---

## 7. Exporter design (`exporter.js`)

Replace flatten-only with a model builder, behind an internal capability flag
(`richText`, default on; off → current plain behavior, for bisecting).

1. **Find the rendered label node.** Prefer `state.text && state.text.node`
   (the mxText DOM mxGraph rendered). If absent (headless), build a detached
   element from `graph.getLabel(cell)` for the §5 tokenizer fallback.
2. **Resolve the base run** from the cell's drawio style (family, sizePx from
   `fontSize`, weight from `fontStyle&1`, italic `&2`, underline `&4`, strike
   `&8`, color `fontColor`) — this is the inherited default for text nodes that
   carry no explicit CSS.
3. **DOM walk** (never regex on the live path). Depth-first over the label node:
   - Text node → push a run: text = node data with **HTML whitespace
     collapsing** (runs of space/tab/newline → single space; leading/trailing
     per CSS `white-space:normal`; respect `pre`/`nowrap` if drawio set it);
     style = `getComputedStyle(parentElement)` mapped to run fields
     (`font-weight≥600`→700, `font-style:italic`, `text-decoration-line`
     contains `underline`/`line-through`, `font-family` first family,
     `font-size` px, `color`→`#rrggbb`).
   - `<br>` → end current paragraph, start a new one inheriting the current run
     style.
   - Block element (`div`,`p`,`li`,header) → flush/begin a paragraph; read its
     computed `text-align` for the paragraph `align`; `li` sets `listMarker`
     from the `ul`/`ol` parent (single level; nested → degrade notice).
   - Skip & **notice** unsupported nodes (`img`, `table`, `sub`, `sup`,
     background-color spans, etc.) via `degradation('RichUnsupported', …,
     cell.id)`; still emit their text as a best-effort plain run.
4. **Normalize:** drop empty runs; merge adjacent runs with identical style;
   drop empty trailing paragraphs; ensure ≥1 paragraph (empty label already
   short-circuits before `textNode`).
5. **Emit** `content:{type:'rich', paragraphs:[…]}` from `textNode()`; keep the
   existing top-level `font`/`align` as the block default + back-compat for any
   consumer reading only those. Edge labels use the same builder (replace the
   `edgeLabelBox` heuristic width with the rendered label node's measured
   bounds when available — more accurate box).
6. **Tests:** extend `exporter.test.mjs` with a jsdom/fake-DOM matrix
   (bold/italic/underline/strike, multi-color, mixed sizes, multi-paragraph
   mixed align, single-level list, nested-list degrade, img-in-label degrade,
   whitespace collapsing, `<font>` vs CSS precedence, edge labels). Node-pure
   where possible; browser e2e for the live-node path.

---

## 8. Engine changes (`include/`, `src/`) — stays HTML-free

1. **`contract_loader.cpp` `validate_text_content()`** (≈L817 region): add a
   `type=="rich"` branch *before* the unknown-enum error. Validate:
   `paragraphs` is a non-empty array; each paragraph has `align∈{left,center,
   right}`, optional `listMarker∈{none,bullet,number}`, `runs` non-empty; each
   run has non-empty handling for `text` (string), `sizePx>0`, `weight` int,
   bools, `color` `#rrggbb`. Reject `static`/`merge`-only fields on a `rich`
   node (mirror the existing cross-field rejection style). Populate a new
   `TextContentType::Rich` + a `std::vector<RichParagraph>` on
   `PaintNodeSummary` (additive struct fields; keep the C++20 designated-init
   pattern that §2 left in place). Set a `document.has_rich_text` flag for
   notice/telemetry parity.
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
3. **Run-aware `build(emScale)`** replacing the single-font lambda: walk
   paragraphs; within a paragraph, word-wrap **across runs** when
   `wrap=="word"` — accumulate words carrying their run identity, break when
   the measured candidate width exceeds `box.Width`; `line_h` = max run height
   on that line (`Font::GetHeight`); `block_w`/`block_h` from the laid lines;
   list markers emitted as a leading run with hanging indent.
4. **Shrink-to-fit** (≈L601–607): scale **all** runs' `em` by the same factor
   in the existing loop (uniform scale preserves relative sizing → still
   WYSIWYG); same `floor_em`, same loud `MergeOverflowError`/`MergeClip`/clip
   semantics (§2 unchanged).
5. **Vertical block align** (≈L624–629) unchanged (uses `block_h`).
   **Per-line horizontal align** unchanged but x advances run-by-run:
   `DrawString` each run at the running x with its own font/brush;
   **underline/strikethrough drawn as lines** (GDI+ underline is unreliable
   across arbitrary fonts — draw a 1·scale rule at the run baseline metrics).
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
