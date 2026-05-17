# Print Engine — Rich-Text (HTML label) Handling (TODO #3)

**Audience:** the engineer/agent making formatted labels print accurately.
**Companion to:** `PRINT_ENGINE_ACCURACY_TODO.md` (esp. §2 text metrics — this
work is coupled to that decision) and `PRINT_ENGINE_SVG_TODO.md` (which
explicitly does NOT cover this — see the "wrong path" section below).
Read `PRINT_ENGINE_ACCURACY_TODO.md` §0 ground rules first; they apply.

---

## Status (reviewed 2026-05-17)

**Metrics gate CLEARED; one decision remains.** Originally gated on two things:
(1) the `content.type:"rich"` additive **schema change**, and (2) the
**text-metrics model**. Gate (2) is **resolved** — accuracy §2 landed
(measure-at-the-sink); `draw_trace` now does real measured word-wrap / shrink /
align, which this work extends to *per-run* styling. The only remaining gate
is (1): the owner authorizes the additive `content.type:"rich"` schema (the
owner is the schema authority for this fork; "max-accuracy WYSIWYG" implies
wanting faithful formatted labels, so this is expected to be a yes — confirm
the exact shape before coding). Until then the exporter flattens labels to
plain text (documented interim behavior — not a bug). This document is
complete *as a plan*; implementation is the next workstream once (1) is
confirmed, sequenced after the accuracy pass.

---

## The problem

When a label is edited in drawio, drawio stores it as **HTML** (the
contentEditable editor; the cell `style` carries `html=1`, the value/`<object>`
label is an HTML string). It can contain: `<b>/<i>/<u>`, `<font color size
face>`, `<span style="...">`, `<br>`, `<div>`/`<p>` blocks, per-paragraph
alignment, `<ul>/<ol>/<li>`, sub/sup, nested inline styles, and CSS.

The current exporter (`plugins/nativeprint/exporter.js`) **flattens labels to
plain text**. Everything formatting-bearing is lost: bold/italic/underline,
text color, per-run font family/size, paragraph alignment, hard line breaks,
bullet lists. For "extremely accurate" printing this is wrong — a label that
is "**RISK** (red, 18pt) / normal line (black, 11pt)" prints as one flat run.

This applies to **vertex labels and edge labels** alike (the exporter now
emits edge labels as text nodes too).

---

## The wrong path (do not do this)

Do **not** try to render HTML labels by emitting them as SVG `<foreignObject>`
and routing through the TODO #2 rasterizer. **resvg does not render
`foreignObject`** and librsvg's support is poor — the label comes out blank.
This is fenced off in `PRINT_ENGINE_SVG_TODO.md` §0. Rich text is solved in the
**native text pipeline**, not the SVG one.

Also reject: rasterizing the label via the browser DOM (html2canvas-style) and
embedding a bitmap. It bakes text at one DPI, prints at another → blurry, and
breaks INV-5 (resolution-dependent, not the shared trace). Not acceptable for
accuracy.

---

## The right path

**Parse the label HTML in the exporter** (the renderer — the only place the
DOM, the cell base style, and computed styles exist) into a **neutral
structured rich-text model**, carry that model in the contract, lay it out in
the engine, and draw it run-by-run in the rasterizer.

1. **Exporter (renderer side):** parse the label using the **browser's own DOM
   parser** (set the HTML on a detached element and walk nodes — never regex).
   - Base style = the cell's resolved drawio style (fontFamily, fontSize,
     fontColor, fontStyle bold/italic/underline bits, horizontal/vertical
     align). HTML tags/inline CSS **override per run** via `getComputedStyle`
     on each text node.
   - Produce: `paragraphs[] → { align, runs[] }`, `run = { text, fontFamily,
     sizePx, bold, italic, underline, color }`. Block elements / `<br>` →
     paragraph or line breaks; collapse HTML whitespace per the HTML rules.
   - Handle drawio specifics: `html=1`, `<object label=...>` wrappers, the
     mxGraph label container, `&nbsp;`, `<font face>` vs CSS `font-family`.
2. **Contract:** add a rich content type to the `text` node, e.g.
   `content:{ type:"rich", paragraphs:[ { align, runs:[ {text,font,sizePx,
   bold,italic,underline,color} ] } ] }`. **This is a frozen-schema change —
   [ESCALATE]** to the spec owner (Appendix A in `PRINT_ENGINE_ACCURACY_TODO.md`
   is authoritative; the engine loudly rejects unknown shapes by design).
   Keep `static`/`merge` working; `rich` is additive.
3. **Engine (`renderer.cpp`):** lay out runs into lines — per-run advance, line
   breaking across runs of mixed font/size, per-paragraph alignment, vertical
   alignment of the block. **This is the same problem as
   `PRINT_ENGINE_ACCURACY_TODO.md` §2 (real text metrics) — it cannot be done
   correctly on the `fontSize × 0.6` heuristic.** This work is **gated by and
   must reuse** the §2 metrics decision (the injected measurer or the
   measure-at-sink model). Do not solve metrics twice.
4. **Rasterizer (`draw_trace`):** draw each run with its own GDI+ `Font` +
   color (color plumbing already landing via the accuracy §1 `Paint` work) at
   the computed run position; underline as a drawn line (GDI+ has no reliable
   underline for arbitrary fonts — draw it).

INV-1 stays intact: **the engine never sees HTML.** The exporter (renderer
side) does all HTML→model conversion; the contract carries only the neutral
run model; the engine library has no HTML/editor/diagram concept.

---

## Scope a supported subset; loud-degrade the rest

Supported (target): paragraphs + line breaks, bold/italic/underline, font
family/size/color per run, horizontal + vertical alignment, simple bullet/
numbered lists.

Out of subset → emit a `DegradationNotice` the operator must acknowledge
(never silently flatten): embedded images in labels, tables, arbitrary CSS we
don't model, RTL/bidi and complex scripts, sub/superscript, background
highlight, letter/word spacing. Degrade to best-effort plain styled text **and
say so loudly** — consistent with the project's loud-fail philosophy.

---

## Interactions / boundaries

- **Merge fields:** `content.type:"merge"` stays plain for now; a rich+merge
  combination is out of scope until asked (note it, don't silently support).
- **Edge labels:** same rich pipeline (exporter already emits them as text).
- **Preview == print (INV-5):** rich layout happens once in the engine trace;
  both sinks draw the same runs at the same DPI.
- **Determinism / fonts:** run fonts must resolve against the same font set the
  rasterizer uses; missing-font substitution raises the existing
  `FontSubstituted` notice (accuracy §9). Record substitutions for regulated
  traceability.

---

## Phased plan

1. **[ESCALATE]** the schema addition (`content.type:"rich"`) and confirm the
   §2 text-metrics model is decided — both gate real work.
2. Exporter: HTML → neutral paragraph/run model (DOM walk + base-style merge),
   behind a feature flag; emit `rich` content; loud-degrade unsupported HTML.
   Pure/Node-testable with a fake DOM where possible; otherwise browser test.
3. Engine: `rich` validation in `contract_loader.cpp`; multi-run line layout in
   `renderer.cpp` on the §2 metrics model; numeric layout tests.
4. Rasterizer: per-run draw (font/color/underline) in `draw_trace`.
5. Golden-image tests (mixed bold/color/size/align/list) into the
   `PRINT_ENGINE_ACCURACY_TODO.md` §9 harness; `ctest` green.

---

## Definition of done

1. A label with mixed bold/italic/underline, multiple colors, mixed font
   sizes, multiple aligned paragraphs, and a bullet list prints with each run's
   style faithful and correct line breaking/alignment.
2. Preview and print draw the identical runs at the print DPI (INV-5).
3. Engine library contains zero HTML/editor concept (INV-1; arch test green).
4. Every unsupported HTML construct produces an acknowledged
   `DegradationNotice` — no silent flattening anywhere.
5. Plain (`static`) and `merge` labels still work unchanged.
6. `ctest` green; rich-text golden suite green in CI.

Update `docs/MEMORY.md` as milestones land.
