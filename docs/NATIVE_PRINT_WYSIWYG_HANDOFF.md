# Native Print — Absolute WYSIWYG Hand-off

**Goal:** every drawio object — shapes, stencils, edges, markers, gradients,
filters, images, plain text, **and HTML rich-text labels** — must print and
print-preview **exactly** as it appears on screen, or the export fails
loudly. No silent divergence, ever.

This document is the authoritative hand-off. It is self-contained: an AI or
engineer should be able to continue the work from this file alone.

---

## 1. Non-negotiable constraints (owner-set — do not relitigate)

These are mirrored in `src/main/webapp/plugins/nativeprint/CLAUDE.md` and
`docs/CLAUDE.md` (“Native Print — NON-NEGOTIABLE CONSTRAINTS”).

- **C1 — WYSIWYG or loud.** Faithful render, or a loud `degradation`
  notice / hard fail saying exactly why. Never a silent approximation,
  never a silently missing or wrong object.
- **C2 — No browser anywhere in the guarantee.** Forbidden: headless
  Chromium, Playwright, Puppeteer, Selenium, Electron, `jsdom`, and in-app
  pixel oracles (`getImageData`, rasterizing `getSvg()`, screenshot diff).
  Reading drawio’s **own already-rendered DOM at bake time** (the
  authoring app) is **not** “a browser” — it is the endorsed harvest
  pattern and is allowed.
- **C3 — Frozen engine/contract boundary.** The C++ engine and the JSON
  contract schema do not change. No drawio/mxGraph concepts leak into the
  engine (`architecture_tests.cpp` / INV-1). Schema changes need an
  explicit owner decision.
- **C4 — Guarantee by construction, verified browser-free.** Transcribe
  drawio’s actual rendered SVG; no re-derived/heuristic geometry on the
  live path. Enforce with structural invariants in the existing
  `node --test` (exporter) and `ctest` (engine) harnesses.
- **C5 — One manual step max.** Everything is automated and browser-free
  except a single declared manual in-app validation pass.

---

## 2. Architecture (the chosen, implemented design)

drawio renders everything to SVG.

- **Classes 1–7** (shapes/stencils/edges/markers/gradients/filters/images,
  plain SVG `<text>`): the exporter transcribes drawio’s *own rendered SVG*
  verbatim into a contract `svg` node. The host SVG rasterizer draws it. If
  a host build has no SVG backend it emits a loud `SvgArtworkStub` (never
  silent). This was already solved before this work.

- **Class 8 — HTML rich-text labels.** drawio renders these as SVG
  `<foreignObject>` containing HTML/CSS. Native SVG rasterizers cannot draw
  `<foreignObject>`, and the frozen engine must **not** re-lay-it-out
  (engine layout ≠ browser layout = not WYSIWYG). **Decision:**
  `<foreignObject>` is **never** placed in the contract. At bake time the
  exporter reads the *actual laid-out* label from the live drawio DOM (the
  C2-endorsed read) and **transcribes it into plain SVG primitives**
  (`<text>`, `<rect>`) positioned exactly where the browser drew them.
  Native rasterizers draw `<text>`/`<rect>` faithfully, so print == screen
  **by construction**. The engine and contract are untouched (C3).

Rejected alternatives (do not revisit): host renders `foreignObject`
(needs a browser, C2/C3); engine re-lays-out as `rich` text (measure-at-
sink ≠ browser layout, C1); ship `foreignObject` verbatim and hope the
backend supports it (no conformant native backend does, C1).

---

## 3. Code map (single file: `plugins/nativeprint/exporter.js`)

| Symbol | Line¹ | Role |
|---|---|---|
| `findForeignObjects(node, out)` | ~1157 | Collect **all** `<foreignObject>` under a cell’s text node (multiplicity). |
| `nativePrintFatal(msg, cellId)` | ~1173 | Build the `Error` (`.nativePrintFatal=true`) used for the hard-fail. |
| `listMarker(type, idx)` | ~1197 | Deterministic glyph for standard `list-style-type`. Returns `null` for unknown → caller raises a loud notice. |
| `fontRun(cs)` | ~1215 | Computed-style → run attributes (family/size/weight/italic/color+alpha/decoration/letter-spacing). |
| `bgRect(cs, rect)` | ~1238 | Computed `background-color` + client rect → `<rect>` or `''`. |
| `transcribeForeignObjects(fos, M, cellId, notices)` | ~1261 | **Core.** Walk the live DOM; emit one `<g matrix>` of `<rect>`+`<text>`; raise fatal when a present label is unmeasurable. Returns `''` for a genuinely empty label. |
| `svgCellNode(...)` | ~1378 | Builds the contract `svg` node. Computes `M` and splices the transcription in place of the label. |
| `emitVertex` / `emitEdge` | ~1549 / ~1632 | Call `svgCellNode`; the vertex **and edge** label paths share the transcription. |
| `buildResult(graph, paper)` | ~1500 | Top-level bake. **Does not** catch `nativePrintFatal` (it must propagate). |

¹ Line numbers are indicative; search by symbol name (the file evolves).

Removed: `foreignObjectToSvgText`, `findForeignObject` (singular), the
`SvgForeignObject` verbatim-passthrough notice. Do not reintroduce them.

---

## 4. The transcription algorithm (precise)

Triggered in `svgCellNode` when `findForeignObjects(state.text.node, [])`
is non-empty.

### 4.1 Coordinate model (rotation/zoom/flip correct)

One wrapper `<g transform="matrix(M)">` is emitted; every child is
positioned in **screen pixels** (the units of `getClientRects()` /
`getBoundingClientRect()`), and `M` maps screen → this cell-svg’s local
space. Because `M` is the group transform, glyphs inherit drawio’s
rotation/zoom/flip exactly.

```
cellGroup = state.shape.node.parentNode      // local space == view-px
Sinv      = inverse( cellGroup.getScreenCTM() )   // screen -> view-px
Mtr       = { a:1/scale, d:1/scale,               // view-px -> svg-local
              e: SVG_PAD - vb.x/scale,
              f: SVG_PAD - vb.y/scale }            // (= the existing `tr`)
M         = mMul(Mtr, Sinv)                        // screen -> svg-local
```

`view-px == cellGroup-local` is the same identity `harvestMatrix` relies
on (`inv(parent.getCTM()) * el.getCTM()` lands in state.x/y space). We use
`getScreenCTM` (not `getCTM`) because client rects are screen-relative;
the target space (`cellGroup-local`) is identical either way.

### 4.2 Text, decoration, backgrounds

Walk the foreignObject subtree:

- **Text nodes:** for each whitespace-delimited word make a `Range`; use
  `range.getClientRects()` (fallback `getBoundingClientRect()`) — these are
  the *actual rendered* fragment rects (exact wrapping/justification/bidi
  by construction). Emit one `<text>` per fragment at `(rect.left,
  rect.top)`, `text-anchor="start"`, `dominant-baseline="text-before-edge"`
  (top-anchored ⇒ **no baseline/metric guessing**), with `fontRun()`
  attributes and `xml:space="preserve"`.
- **Decoration:** `underline`/`line-through`/`overline` → SVG
  `text-decoration` attribute (rasterizer-native, exact).
- **Backgrounds:** the outermost element’s `background-color` (drawio label
  background) → one `<rect>` over its client rect; any descendant element’s
  `background-color` → a `<rect>` over its client rect.
- **List items** (`display:list-item`, `list-style-type != none`):
  synthesize the marker glyph (`disc/circle/square/decimal/
  decimal-leading-zero/lower|upper-roman/lower|upper-alpha`) at the list
  item’s rect; index counts prior `<li>` siblings. Unknown types fall back
  to `•`. Either way a loud `SvgListMarkerApprox` notice fires (the marker
  *glyph* is exact; its *x-inset* is metric-derived — see §6.2).

### 4.3 Output

`<g transform="matrix(a b c d e f)">` + background `<rect>`s + `<text>`s.
`<foreignObject>` is **never** emitted.

---

## 5. Faithful-or-loud taxonomy (complete)

| Situation | Behavior |
|---|---|
| Live DOM measurable | Transcribe to SVG. **No notice** (faithful). |
| Standard list, glyph exact, x-inset metric-derived | Transcribe + loud `SvgListMarkerApprox`. |
| Non-standard `list-style-type` | `•` + loud `SvgListMarkerApprox`. |
| **foreignObject with real text but unmeasurable DOM** (no `getComputedStyle`/`createRange`/`getBoundingClientRect`, or cell transform unreadable) | **`NativePrintFatal` thrown — the whole export aborts.** No partial/wrong/missing page is produced. Owner ruling: a missing or approximated object on print is unacceptable, and there is no faithful source without the DOM (a browser is forbidden, C2), so refuse rather than mislead. |
| foreignObject with only whitespace/empty | Returns `''` — not an error (nothing to draw). |
| Classes 1–7, host has no SVG backend | Existing loud `SvgArtworkStub`. |

`NativePrintFatal` carries `.nativePrintFatal = true` and a message naming
the cell. `buildResult` deliberately does not catch it.

---

## 6. Known residuals (must be closed for *absolute* WYSIWYG)

These are stated honestly; none is silent. Priority order:

### 6.1 Vertical anchor vs. CSS line-height (highest priority)
`getClientRects()` fragment rects are **line-box** tall. We top-anchor
(`dominant-baseline=text-before-edge`, `y=rect.top`). When CSS
`line-height > font-size`, the browser centers glyphs in the line box
(half-leading above), so transcribed glyphs sit up to
`(lineHeight - fontSize)/2` px too high (≈1–2 px at 14 px / normal).
**Fix:** set `y = rect.top + (lineHeightPx - fontSizePx)/2`, computing
`lineHeightPx` from `getComputedStyle(parent).lineHeight`, resolving
`'normal'` via a one-line measured probe (`Range` over a single
character). Until fixed, this is a sub-pixel-to-~2px vertical residual on
multi-line/large-line-height labels — validate in §7.

### 6.2 List-marker x-inset
Marker glyph and numbering are exact; the marker’s **x position** uses the
list item’s own rect (not the browser marker box), so the inset is
metric-derived → flagged loud (`SvgListMarkerApprox`). **Fix:** measure
the first content `Range` rect of the `<li>` and place the marker a
measured gap to its left; drop the notice once exact.

### 6.3 All `buildResult` call sites must surface the fatal
`plugins/nativeprint.js`: `openDialog()` (~L55) wraps `buildResult` in
try/catch and shows `ui.showError(...)` — correct. **But `rebake()`
(~L154) and the `buildContract` path (`exporter.js` ~L1690
`return buildResult(graph).contract`) do not.** A `NativePrintFatal`
thrown there would be unhandled. **Fix:** wrap every `buildResult` call
site so `NativePrintFatal` aborts the print/preview with a loud,
specific dialog and disables the Print button — never swallowed, never a
stale/partial preview.

### 6.4 Inputs assumed
Transcription assumes a live SVG DOM where elements expose
`getBoundingClientRect`, `getClientRects`, `getScreenCTM`,
`getComputedStyle`. This holds inside drawio. Outside it, §5’s hard-fail
fires (by design).

---

## 7. Verification (browser-free; one manual step)

```
# Exporter (Node, mocked DOM — the harvestShape pattern):
cd src/main/webapp/plugins/nativeprint && node --test
#   expect: tests 82 / pass 81 / fail 0 / skipped 1 (engine-binary skip)

# Engine regression gate (contract must be unaffected):
cd src/main/native-print-engine
cmake -S . -B build -DBUILD_TESTING=ON && cmake --build build -j4
ctest --test-dir build      # expect: 100% (106/106)
```

Existing structural tests cover: full transcription
(text+decoration+background), the rotation/zoom matrix, the unmeasurable
**hard-fail**, and the empty-label no-op. Add tests alongside these for
any §6 fix (e.g. line-height anchor, marker inset) — same mocked-DOM
style, **no browser**.

**The one manual step (C5):** open a representative diagram in drawio
(mixed fonts, bold/italic/underline/strikethrough, colored runs, a
bulleted and a numbered list, a rotated HTML label, an RTL label, a label
with a background) → Native Print → preview and print → eyeball that the
output matches the canvas. This is the only non-automated check and must
be signed off before claiming done.

---

## 8. Definition of Done

1. Every object class prints/previews faithfully.
2. The contract contains **zero** `<foreignObject>` on the live path.
3. Every non-faithful pixel carries a loud scoped notice; every
   unmeasurable label hard-fails the export (no missing/wrong page).
4. §6.1, §6.2, §6.3 closed (with browser-free tests).
5. Exporter `node --test` green; engine `ctest` 106/106.
6. The §7 manual validation signed off.
7. Engine and contract bytes unchanged (C3).

---

## 9. Commit / branch protocol

Branch: `claude/support-all-shapes-print-OUtEW`
(remote `danielttran/drawio`; never push to `jgraph/drawio`).
Commit small, run both test suites before pushing, push with
`git push -u origin claude/support-all-shapes-print-OUtEW`.
Do not open a PR unless explicitly asked.
