# Native Print — Full Draw.io Shape Coverage: Implementation Specification

**Status:** Revised — advisor review complete (2026-05-25)  
**Date:** 2026-05-25  
**Repository:** `danielttran/drawio`  
**Branch:** `claude/native-print-unattended-5qWWK`  
**Companion docs:**  
- `docs/NATIVE_PRINT_UNATTENDED_IMPLEMENTATION_SPEC.md` (prior spec, already implemented)  
- `docs/PRINT_ENGINE_SPEC_v1.1.md` (engine contract schema)  
- `docs/CLAUDE.md` (non-negotiable constraints)  
- `src/main/webapp/plugins/nativeprint/CLAUDE.md` (plugin-level guardrails)

---

## 0. Non-Negotiable Constraints

All constraints from `docs/CLAUDE.md` and the prior spec remain in force unchanged:

1. **No browser anywhere** — no Chromium, Playwright, jsdom, pixel oracles.  
2. **WYSIWYG by construction** — transcribe draw.io's actual rendering, never re-derive.  
3. **Faithful OR loud** — never a silent divergence, never a silent approximation.  
4. **Frozen engine boundary (INV-1)** — no draw.io/mxGraph concepts in C++; contract schema unchanged by this spec.  
5. **D5 failure policy** — any degradation notice → job refused (HTTP 422).

**Allowed-renderer boundary (D1):** Running draw.io's own stencil XML through a pure arithmetic
renderer (no mxGraph runtime, no DOM shim, no browser) is permitted and is *not* a browser.
The renderer implements only coordinate arithmetic, SVG path string assembly, and XML attribute
reading. It must not implement HTML layout, CSS cascade, box layout, measurement, event
handling, or produce pixels. The existing svg-shim (`tools/native-print-bake/svg-shim/`) is
not required for Phase 1 — the stencil renderer is pure math.

---

## 1. Problem Statement

The headless bake path (Node.js, no browser) currently supports only ~8 named shape types:
`rectangle`, `ellipse`, `rhombus`, `triangle` (4 directions), `cylinder`, `cloud`, `label`.

Any cell whose style includes `shape=<anything else>` — including all `mxgraph.*` stencil
shapes (~3,798 uniquely named shapes across 202 XML files), plus built-in shapes like
`hexagon`, `actor`, `parallelogram` — hits `ExporterUnsupportedShape`, emits a degradation
notice, and causes D5 job refusal.

The live-browser path works for all shapes because `harvestShape` transcribes the
already-rendered SVG from `state.shape.node`. Headless has no such rendered state.

**Goal:** Extend headless coverage to 100% of draw.io shapes without a browser by implementing
a stencil XML → SVG renderer that uses the same stencil definitions the browser uses — WYSIWYG
by construction.

---

## 2. Root Cause and Insight

Draw.io's shape library is defined as XML in `src/main/webapp/stencils/` (202 files, ~3,798
shapes). Each stencil shape is a sequence of drawing commands in a well-defined mini-language:

```xml
<shape name="Card" h="60" w="98" aspect="variable" strokewidth="inherit">
  <background>
    <path>
      <move x="19" y="0"/>
      <line x="93" y="0"/>
      <arc rx="5" ry="5" x-axis-rotation="0" large-arc-flag="0" sweep-flag="1" x="98" y="5"/>
      <close/>
    </path>
  </background>
  <foreground>
    <fillstroke/>
  </foreground>
</shape>
```

These commands map to SVG with a coordinate transform. The full command → SVG mapping:

| Stencil command | SVG path token | Notes |
|---|---|---|
| `<move x y>` | `M ox+x*sw oy+y*sh` | Absolute moveto |
| `<line x y>` | `L ox+x*sw oy+y*sh` | Absolute lineto |
| `<curve x1 y1 x2 y2 x3 y3>` | `C` (6 values scaled) | Cubic Bezier |
| `<quad x1 y1 x2 y2>` | `Q` (4 values scaled) | Quadratic Bezier |
| `<arc rx ry xrot laf sf x y>` | `A su*rx su*ry xrot laf sf ox+x*sw oy+y*sh` | Arc; radii scale by uniform factor (see §3.3) |
| `<close>` | `Z` | |
| `<rect x y w h>` | `<rect x="ox+x*sw" y="oy+y*sh" width="w*sw" height="h*sh"/>` | |
| `<roundrect x y w h arcsize>` | `<rect ... rx="r" ry="r"/>` | r = arcsize/100 * min(w*sw, h*sh); if arcsize=0 → r = 10 (mxConstants default) |
| `<ellipse x y w h>` | `<ellipse cx="ox+(x+w/2)*sw" cy="oy+(y+h/2)*sy" rx="w/2*sw" ry="h/2*sh"/>` | Note: stencil x,y is top-left, NOT center |

Where `ox`, `oy`, `sw`, `sh` come from `computeAspect` (see §3.3 step 2). For `aspect="variable"` shapes: `ox=0, oy=0, sw=cellW/w0, sh=cellH/h0`. For `aspect="fixed"` shapes the formula is different — see §3.3 step 2.

---

## 3. Architecture

### 3.1 Overview

The shape rendering pipeline adds one new step before the existing fallback:

```
emitVertex(cell)
  ├─ harvestShape()              (live path only — requires state.shape.node)
  ├─ inlineStencilDecode()       ← NEW: decode stencil(base64...) inline shapes
  ├─ stencilRegistryLookup()     ← NEW: look up mxgraph.* stencil XML shapes
  │    └─ stencilToSvg()         ← NEW: render stencil XML → SVG string
  ├─ shapePath()                 (existing: basic 8 shapes)
  └─ ExporterUnsupportedShape notice  (truly unresolvable shapes only)
```

### 3.2 Stencil Registry — Correct Key Format

**IMPORTANT: The key format is derived from the `<shapes name="...">` XML attribute, NOT from
the file path.** This is how `mxStencilRegistry` (`parseStencilSet` in `Graph.js` line ~11308)
works:

```
key = shapes_element_name_attr.toLowerCase() + "." + shape_name.replace(/ /g, "_").toLowerCase()
```

Examples:
- `stencils/basic.xml` has `<shapes name="mxgraph.basic">` → `"mxgraph.basic.4_point_star"`, `"mxgraph.basic.star"`, etc. (NOT `"mxgraph.basic.4 Point Star"`)
- `stencils/flowchart.xml` has `<shapes name="mxGraph.flowchart">` → lowercased → `"mxgraph.flowchart.card"`, `"mxgraph.flowchart.start_1"`
- `stencils/aws2/compute.xml` has `<shapes name="mxgraph.aws2.compute">` → `"mxgraph.aws2.compute.ec2"`

**Note:** `basic.xml` shapes are `"mxgraph.basic.*"` (not plain names). Plain names like
`"parallelogram"`, `"hexagon"` are built-in JS shapes, not stencil XML shapes.

**Bake loader algorithm** (`bake.mjs`):
1. Recursively read every `.xml` file from `src/main/webapp/stencils/`.
2. Parse each file with `@xmldom/xmldom` (already a project dependency) — Node.js does not have a built-in DOMParser.
3. Read the `name` attribute from the root `<shapes>` element → `packagePrefix = name.toLowerCase()`.
4. For each `<shape name="N">` child: `key = packagePrefix + "." + N.replace(/ /g,"_").toLowerCase()`.
5. Store `Map<key, shapeElement>` — the raw `<shape>` DOM node.
6. Call `exporter.registerStencils(map)` before any bake calls.

Memory cost: all stencil XML is ~8 MB text, parsed once at startup.

### 3.3 `computeAspect` — Coordinate Transform (Critical)

Every coordinate in a stencil must be transformed through `computeAspect` before scaling.
This mirrors `mxStencil.computeAspect` exactly.

**Inputs:** `w0`, `h0` (stencil native dimensions), `cellW`, `cellH` (actual cell px), `aspect` attribute value.

**For `aspect="variable"` (most shapes):**
```
sw = cellW / w0
sh = cellH / h0
ox = 0
oy = 0
```
Arc radii: `rx_scaled = rx * sw`, `ry_scaled = ry * sh`.

**For `aspect="fixed"` (many icon-style shapes like AWS, Azure, etc.):**
```
su = min(cellW / w0, cellH / h0)    // uniform scale
sw = su,  sh = su
ox = (cellW - w0 * su) / 2          // centering offset
oy = (cellH - h0 * su) / 2
```
Arc radii: `rx_scaled = rx * su`, `ry_scaled = ry * su` (same factor for both — preserves circle arcs).

Applying the transform to a coordinate: `xOut = ox + x * sw`, `yOut = oy + y * sh`.

**`direction` style property**: If the cell style has `direction=north` or `direction=south`,
width and height are swapped when computing the aspect transform:
```
if direction == "north" or "south":
    swap(cellW, cellH) when calling computeAspect
    then wrap the resulting SVG in <g transform="rotate(-90, cx, cy)"> or <g transform="rotate(90, cx, cy)">
```
For `direction=north`: rotate −90°, pivot at `(cellW/2, cellH/2)`.  
For `direction=south`: rotate +90°, pivot at `(cellW/2, cellH/2)`.  
For `direction=west`: rotate 180°.  
`direction=east` is the default (no rotation).

### 3.4 `stencilToSvg(shapeNode, cellW, cellH, style)` — Full Algorithm

**Signature:** `stencilToSvg(shapeNode, cellW, cellH, style) → string | null`

Returns an SVG string, or `null` + pushes a notice if an unsupported feature is encountered.

**Step 1 — Read shape metadata:**
```
w0 = parseFloat(shapeNode.getAttribute("w")) || 100
h0 = parseFloat(shapeNode.getAttribute("h")) || 100
aspect = shapeNode.getAttribute("aspect") || "variable"
stencilStrokeWidth = shapeNode.getAttribute("strokewidth")  // may be "inherit" or a number
```

**Step 2 — Compute aspect transform** via §3.3.

**Step 3 — Compute initial stroke width:**
```
if stencilStrokeWidth == "inherit" or null:
    sw_px = cellStyle.strokeWidth (from parsed style, default 1)
else:
    sw_px = parseFloat(stencilStrokeWidth) * min(sw, sh)   // stencil units → px
```

**Step 4 — Initialize render state stack** (for `<save>`/`<restore>`):
```
state = {
  fillColor:    style.fillColor,
  strokeColor:  style.strokeColor,
  strokeWidth:  sw_px,
  dashed:       style.dashed,
  dashPattern:  style.dashPattern,
  lineCap:      style.lineCap || "butt",
  lineJoin:     style.lineJoin || "miter",
  miterLimit:   style.miterLimit || 10,
  alpha:        opacity(style, "opacity"),
  fontColor:    style.fontColor || "#000000",
  fontSize:     style.fontSize || 11,
  fontFamily:   style.fontFamily || "Arial",
  fontStyle:    style.fontStyle || 0,
}
stateStack = []
```

**Step 5 — Walk `<background>` and `<foreground>` nodes in order**, processing sibling nodes:

The walker operates at the child level of `<background>` and `<foreground>`. At this level,
nodes are one of: `<path>`, `<rect>`, `<roundrect>`, `<ellipse>`, `<fillstroke>`, `<fill>`,
`<stroke>`, state-modifier commands, or `<save>`/`<restore>`.

**`<fillstroke>`, `<fill>`, `<stroke>` are siblings of `<path>`, NOT children.** A typical
stencil has: `<path>…commands…</path>` then `<fillstroke/>` as the next sibling. The walker
must maintain a "current path accumulator" that is populated by a `<path>` block and then
consumed by the next `<fillstroke>`/`<fill>`/`<stroke>` sibling.

**Step 6 — Processing `<path>` blocks:**

When the walker encounters a `<path>` node:
1. Check for `rounded` attribute: if `rounded="1"`, the path uses Bezier rounding of polyline points. This is a distinct rendering mode. **Raise `ExporterUnsupportedStencilFeature` notice and return `null`** for Phase 1 (these are rare but visually distinct — cannot be silently approximated as sharp corners).
2. Otherwise: walk child nodes in order and build an SVG `d` string:
   - `<move x y>` → `"M " + fmt(ox+x*sw) + " " + fmt(oy+y*sh)`
   - `<line x y>` → `"L " + fmt(ox+x*sw) + " " + fmt(oy+y*sh)`
   - `<curve x1 y1 x2 y2 x3 y3>` → `"C " + (6 scaled values)`
   - `<quad x1 y1 x2 y2>` → `"Q " + (4 scaled values)`
   - `<arc rx ry xrot laf sf x y>` → `"A " + fmt(rx*su_or_sw) + " " + fmt(ry*su_or_sh) + " " + xrot + " " + laf + " " + sf + " " + fmt(ox+x*sw) + " " + fmt(oy+y*sh)` (arc radii use uniform scale for `aspect="fixed"`, asymmetric for `aspect="variable"`)
   - `<close>` → `"Z"`
3. Store the accumulated `d` string as the current path.

**Step 7 — Processing `<rect>`, `<roundrect>`, `<ellipse>` directly:**

These are self-contained; they become the current path (as SVG element strings, not `d` strings):
- `<rect x y w h>` → `<rect x="ox+x*sw" y="oy+y*sh" width="w*sw" height="h*sh"/>`
- `<roundrect x y w h arcsize>` → compute corner radius `r = (arcsize || mxConstants.RECTANGLE_ROUNDING_FACTOR*100) / 100 * min(w*sw, h*sh)` → `<rect ... rx="r" ry="r"/>`
- `<ellipse x y w h>` → Note: `x`,`y` are the **top-left corner** of the ellipse bounding box: `<ellipse cx="ox+(x+w/2)*sw" cy="oy+(y+h/2)*sh" rx="w/2*sw" ry="h/2*sh"/>`

**Step 8 — Processing paint commands (`<fillstroke>`, `<fill>`, `<stroke>`):**

When the walker encounters a paint command, it takes the current path accumulator and emits an
SVG element. **If the path accumulator is empty (no geometry accumulated since the last paint
command or since the start of the section), silently skip the paint command — no-op.** This
matches the browser's behaviour (mxSvgCanvas2D silently draws nothing if no path is begun).
This case is common in stencils that use paint commands to set up state or as structural
markers before the actual geometry.

If the accumulator is non-empty:
- Determine fill attr: `fillSvgAttr(state)` — uses `state.fillColor` and gradient if present.
- Determine stroke attrs: `strokeSvgAttrs(state)` — uses `state.strokeColor`, `state.strokeWidth`, `state.dashed`, etc.
- For `<fill>`: emit with fill, `stroke="none"`.
- For `<stroke>`: emit with `fill="none"`, stroke attrs.
- For `<fillstroke>`: emit with both fill and stroke attrs.
- Reset the current path accumulator.

**Step 9 — Gradient fill for stencil shapes:**

If `state.fillColor` is paintable AND `style.gradientColor` is paintable, emit a `<linearGradient>` in the SVG `<defs>` block. Reuse the same `<defs>` handling already implemented for the basic-shape rotation path in `emitVertex`. Do not silently drop gradients.

**Step 10 — Processing state modifiers** (all are siblings at the `<background>`/`<foreground>` child level):

| Command | Effect on state |
|---|---|
| `<save>` | Push copy of current state onto `stateStack` |
| `<restore>` | Pop state from `stateStack` |
| `<strokecolor color="...">` | `state.strokeColor = color` |
| `<fillcolor color="...">` | `state.fillColor = color` |
| `<strokewidth width="..." fixed="...">` | `state.strokeWidth = fixed=="1" ? w : w * min(sw,sh)` |
| `<dashed dashed="...">` | `state.dashed = dashed=="1"` |
| `<dashpattern pattern="...">` | `state.dashPattern = pattern` |
| `<linecap cap="...">` | `state.lineCap = cap` (attr name is `cap`) |
| `<linejoin join="...">` | `state.lineJoin = join` (attr name is `join`) |
| `<miterlimit limit="...">` | `state.miterLimit = limit` |
| `<alpha alpha="...">` | `state.alpha = alpha` (note: `fillalpha` and `strokealpha` in stencil XML BOTH map to `alpha` in mxGraph's canvas — there is no separate fill/stroke alpha in the stencil engine) |
| `<fontcolor color="...">` | `state.fontColor = color` (used if `<text>` encountered) |
| `<fontsize size="...">` | `state.fontSize = size * min(sw,sh)` (scaled by aspect) |
| `<fontstyle style="...">` | `state.fontStyle = style` |
| `<fontfamily family="...">` | `state.fontFamily = family` |

**Step 11 — Unsupported commands** (raise notice + return null):

- `<image>`: requires external image embedding — defer to Phase 3.
- `<include-shape>`: recursive stencil composition — defer to Phase 3.
- `<text>`: label-within-shape decorative text — defer to Phase 3.
- `<path rounded="1">`: Bezier-rounded polylines — defer to Phase 3.
- Any unrecognized node type: raise `ExporterUnsupportedStencilFeature` notice and return `null`.

**Step 12 — Flip transforms:**

After building the inner SVG, check cell style:
- `style.flipH == "1"` → wrap inner content in `<g transform="scale(-1,1) translate(-cellW, 0)">`.
- `style.flipV == "1"` → wrap in `<g transform="scale(1,-1) translate(0, -cellH)">`.
- `style.stencilFlipH` / `style.stencilFlipV`: same treatment (stencil-specific override).

**Step 13 — Assemble SVG:**

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="cellW" height="cellH">
  <defs><!-- linearGradient if needed --></defs>
  <!-- direction rotation wrapper if needed -->
  <!-- flip wrapper if needed -->
  <!-- background paths -->
  <!-- foreground paths -->
</svg>
```

### 3.5 Inline Stencil Shapes (`stencil(base64...)`)

Some cells embed their stencil XML inline in the style string:
```
style="shape=stencil(PHNoYXBlIG5hbWU9...)"
```

The value is the base64-encoded stencil XML. These are used by custom shapes and cells
copied between draw.io instances.

**Handling in `emitVertex`** (before registry lookup):
```javascript
var shapeVal = style.shape || "";
if (shapeVal.startsWith("stencil(") && shapeVal.endsWith(")")) {
  var b64 = shapeVal.slice(8, -1);
  var xml = Buffer.from(b64, "base64").toString("utf8");
  var inlineNode = parseStencilXml(xml);  // returns <shape> element
  if (inlineNode) {
    // proceed with stencilToSvg(inlineNode, ...)
  }
}
```

`parseStencilXml` uses the same XML parser used by the stencil loader (`@xmldom/xmldom`).
If parsing fails, raise `ExporterUnsupportedShape` notice.

### 3.6 Label Placement

For non-rotated stencil shapes, emit a separate `kind:'text'` node centered on the cell box.
This matches draw.io's default label placement for stencil shapes (mxShape.getLabelMargins
returns `null` for stencil-based shapes, meaning no inset).

**Style overrides that change label placement** — these must be checked and respected:

| Style property | Effect | Handling |
|---|---|---|
| `labelPosition=left/right` | Label to the left/right of the cell | Adjust text node x position |
| `verticalLabelPosition=top/bottom` | Label above/below the cell | Adjust text node y position |
| `labelWidth` | Override label width | Pass to text node width |
| `align` | Horizontal text alignment | Already handled by existing text rendering |
| `verticalAlign` | Vertical text alignment | Already handled |

If `labelPosition` or `verticalLabelPosition` is present and non-center, the label box shifts
outside the cell bounding box. The existing `edgeLabelBox` / `plainLabel` machinery already
handles this for basic shapes; stencil shapes must follow the same code path.

For rotated stencil shapes (`style.rotation !== 0`), the label is embedded in the SVG exactly
as it is for basic shapes today (see §3.7).

### 3.7 Rotation

Stencil shapes with `style.rotation !== 0` follow the existing rotation pattern:
- Compute expanded viewport: `expW = cellW*|cos θ| + cellH*|sin θ|`, `expH = cellW*|sin θ| + cellH*|cos θ|`.
- `stencilToSvg` produces the inner shape geometry at the original `cellW × cellH` size.
- Wrap inner SVG content in `<g transform="rotate(deg cx cy)">` where `cx = expW/2`, `cy = expH/2`, and the stencil geometry is offset by `((expW-cellW)/2, (expH-cellH)/2)`.
- Embed label in the same SVG via `textSvgStr`.
- Emit single `kind:'svg'` node sized `expW × expH` centered on the cell center point.

### 3.8 Built-in JS Shapes (Phase 2)

The following shape names are registered in `mxCellRenderer.defaultShapes` (authoritative list
from `mxClient.js` `mxConstants` + `registerShape` calls). These are NOT in stencil XML:

`rectangle`, `ellipse`, `doubleEllipse`, `rhombus`, `line`, `arrow`, `arrowConnector`,
`label`, `cylinder`, `swimlane`, `connector`, `actor`, `cloud`, `triangle`, `hexagon`

**NOT built-in JS** (despite common assumption): `parallelogram` (does not exist anywhere),
`trapezoid` (stencil: `mxgraph.basic.trapezoid`), `cross` (stencil: `mxgraph.basic.cross`),
`plus` (does not exist anywhere), `process` (does not exist as built-in or stencil).

Phase 1 already handles `rectangle`, `ellipse`, `rhombus`, `cylinder`, `cloud`, `label`,
`triangle` via the existing `shapePath` function. Phase 2 adds the remaining built-ins:
`doubleEllipse`, `line`, `arrow`, `arrowConnector`, `swimlane`, `connector`, `actor`, `hexagon`.

These are a finite, bounded list. Each will be added to the existing `shapePath` function as
an additional `else if (name === '...')` branch.

Acceptance criterion: `shapePath` returns a valid SVG `d` string for each built-in, matching
the browser-rendered geometry to within the coordinate precision already in use.

---

## 4. File Changes

| File | Change |
|---|---|
| `tools/native-print-bake/bake.mjs` | Add stencil XML loader: read `stencils/` recursively, parse with `@xmldom/xmldom`, build `Map<key, Element>` using correct key formula (§3.2), call `exporter.registerStencils(map)` |
| `src/main/webapp/plugins/nativeprint/exporter.js` | Add `registerStencils(map)`, `computeAspect(w0,h0,cellW,cellH,aspect)`, `stencilToSvg(node,w,h,style)`, inline stencil decoder, and integration in `emitVertex`; extend `shapePath` with ~20 built-in shapes |
| `tools/native-print-bake/bake.test.mjs` | Add tests (see §7) |
| `src/main/native-print-engine/tests/fixtures/labels/master-test.drawio` | Add representative stencil shape + built-in shape |

No changes to the C++ engine, contract schema, or `docs/PRINT_ENGINE_SPEC_v1.1.md`.  
`kind:'svg'` already exists in v1.1 and is already handled by `pxContractToUm`.

---

## 5. Contract Impact

**None.** `kind:'svg'` already exists and is handled by the C++ engine. No schema version bump.

---

## 6. Stencil Name Mapping — Authoritative Reference

Draw.io resolves `style="shape=X"` in this priority order:

1. Check if `X` starts with `"stencil("` → inline base64 XML (§3.5).
2. Look up `X` in `mxStencilRegistry.stencils` → registered stencil XML.
3. Look up `X` in `mxCellRenderer.defaultShapes` → built-in JS class (Phase 2).
4. Fall back to rectangle (current behavior; continues to apply for any remaining gaps).

The key format for step 2, derived from `parseStencilSet` in `Graph.js`:
```
key = xml_shapes_element_name_attr.toLowerCase()
    + "."
    + shape_name_attr.replace(/ /g, "_").toLowerCase()
```

The XML `<shapes name="...">` root attribute is the authoritative package prefix. The file path
is not part of the key. The bake loader reads this attribute to build keys that exactly match
what the browser registers at runtime.

---

## 7. Testing Strategy

### 7.1 Unit Tests (bake.test.mjs, node --test)

For each new capability:
1. Create a minimal `.drawio` XML string with one cell using the target style.
2. Call `bake(xml)`.
3. Assert: correct contract node type, no unexpected notices, label preserved.

Required test cases:

| Test | Style | Expected |
|---|---|---|
| Variable-aspect stencil | `shape=mxgraph.flowchart.start_1` | `kind:'svg'`, no notice |
| Fixed-aspect stencil (centering) | `shape=mxgraph.aws2.general.generic_office_365` (or any `aspect="fixed"`) | `kind:'svg'`, SVG width=height when cell is square |
| Stencil with gradient | `shape=mxgraph.basic.star` + `gradientColor=#ff0000` | `kind:'svg'`, SVG defs contains `linearGradient` |
| Stencil with rotation | `shape=mxgraph.flowchart.card` + `rotation=30` | `kind:'svg'`, SVG contains `rotate(30` |
| Stencil with direction | `shape=mxgraph.flowchart.start_1` + `direction=north` | `kind:'svg'`, SVG contains rotation transform |
| Inline base64 stencil | `shape=stencil(<base64 of simple shape XML>)` | `kind:'svg'`, no notice |
| Unsupported: `<image>` in stencil | mock stencil node with `<image>` child | `ExporterUnsupportedStencilFeature` notice |
| Unsupported: `<path rounded="1">` | mock stencil with `rounded="1"` | `ExporterUnsupportedStencilFeature` notice |
| Built-in hexagon | `shape=hexagon` | no `ExporterUnsupportedShape` notice |
| Label on stencil shape | any stencil + `value="Hello"` | label text present in contract |
| `labelPosition=right` | stencil + `labelPosition=right` | text node x > cell right edge |

### 7.2 Golden Contract Test (C1)

Extend `master-test.drawio` with one stencil shape (variable-aspect), one fixed-aspect stencil,
and one built-in. Regenerate golden. C1 test in `bake.test.mjs` verifies bake output matches.

### 7.3 WYSIWYG Structural Check (wysiwyg-compare.mjs)

Extend `compare()` with:
- Stencil shape cells produce `kind:'svg'` nodes (no `ExporterUnsupportedShape` notices).
- SVG defs contain gradient elements for cells with `gradientColor`.

### 7.4 Engine Tests (ctest)

No new C++ tests needed. Existing tests must pass unchanged.

---

## 8. Coverage After This Spec

| Shape category | Count | Headless guarantee |
|---|---|---|
| Basic shapes (rectangle, ellipse, etc.) | ~8 types | ✓ Already done |
| Built-in JS shapes (hexagon, actor, etc.) | ~20-30 | ✓ Phase 2 |
| Stencil XML — variable-aspect | ~2,500+ | ✓ Phase 1b |
| Stencil XML — fixed-aspect | ~1,200+ | ✓ Phase 1b (computeAspect) |
| Stencil with direction/flip | spread across above | ✓ Phase 1b (§3.3/§3.4 step 12) |
| Inline `stencil(base64...)` shapes | unknown count | ✓ Phase 1a (§3.5) |
| Stencil with `<image>` command | ~few dozen | Loud notice + D5 refusal (Phase 3) |
| Stencil with `<include-shape>` | ~few dozen | Loud notice + D5 refusal (Phase 3) |
| Stencil with `<path rounded="1">` | ~handful | Loud notice + D5 refusal (Phase 3) |
| **Total faithfully printable** | **~3,820+** | **100% or loud refusal** |

---

## 9. Do-Not List

- Do **not** run `mxSvgCanvas2D`, `mxStencil`, `mxShape`, or `mxCellRenderer` headlessly.
- Do **not** add `window`, `document.body`, or layout measurement to the SVG shim.
- Do **not** change the engine contract schema or C++ engine code.
- Do **not** add a pixel-comparison oracle or screenshot diff.
- Do **not** add a browser (headless or otherwise).
- Do **not** silently approximate `aspect="fixed"` centering — compute it exactly (§3.3).
- Do **not** silently drop gradient fills for stencil shapes — emit gradient SVG or notice.
- Do **not** silently approximate `<path rounded="1">` as sharp corners — raise notice.

---

## 10. Implementation Order

**TEST LABELS FIRST.** No implementation code may be written until all master test label
`.drawio` files described in §11 exist on disk and are committed. This is a hard gate.

1. **Gate 0 — Create all master test labels** (§11): create each `.drawio` file with the
   shapes specified, commit to `src/main/native-print-engine/tests/fixtures/labels/`.
   Verify each file opens correctly in draw.io (visual inspection at this stage only; bake
   will fail until implementation exists — that is expected and acceptable at this gate).

2. **Phase 1a** — Stencil loader in `bake.mjs`: read XML, build registry with correct key
   formula (§3.2); inline stencil base64 decoder in `emitVertex`.

3. **Phase 1b** — `computeAspect` and `stencilToSvg` in `exporter.js`: `<path>` with
   `<move>/<line>/<curve>/<quad>/<arc>/<close>`, `<rect>/<roundrect>/<ellipse>`, state
   modifiers, fill/stroke/fillstroke paint commands, gradient support, direction/flip wrappers.
   Wire into `emitVertex`.

4. **Phase 1c** — Bake all master test labels, verify zero `ExporterUnsupportedShape` notices
   across all files (§12.3 Gate 1). Generate and commit golden contracts for all files.

5. **Phase 2** — Extend `shapePath` for ~20 built-in JS shapes; unit tests; re-run §12.3 Gate 1.

6. **Phase 3** — `<path rounded="1">` Bezier rounding; `<image>` via `embedExternalImages`;
   `<include-shape>` recursion; re-run §12.3 Gate 1.

7. **Done Gate** — All §12.5 Done Declaration criteria pass. Only then is the implementation complete.

---

## 11. Master Test Label Suite (Test-First Mandate)

### 11.1 Mandate

**Master test labels must be created and committed BEFORE any implementation code is written.**
The test labels define the target; the implementation must satisfy them — not the other way around.

Each label file is a `.drawio` diagram containing shapes arranged on a grid, evenly spaced so
no two shapes overlap, with varied rotation angles. Every cell carries a text label that names
the shape, enabling the WYSIWYG checker to verify label preservation.

Grid layout rule: shapes are placed on a regular grid. Each cell is 120 × 100 px unless the
shape has `aspect="fixed"`, in which case use 100 × 100 px. The grid pitch (top-left to
top-left) is: **220 px horizontally, 200 px vertically**.

**Overlap analysis (verified):**
A 120×100 cell at the worst-case rotation (45°) has an axis-aligned bounding box of ~156×156 px.
The gap between adjacent cells at pitch 220×200 is 64 px horizontally and 44 px vertically —
both positive, so no two adjacent cells ever overlap.

**Canvas overflow analysis (verified):**
At 45°, the rotated bbox extends 78 px above the cell centre. With a cell top-left at y=20,
the centre is at y=70, and the top of the rotated bbox reaches y=−8 — overflowing the canvas.
The fix is to start the grid at **x=100, y=100** so the first-row centre is at (160, 150),
giving a minimum canvas clearance of 72 px even at 45°.

Explicit positioning: cell `(col, row)` (0-indexed) is placed at:
```
x = 100 + col * 220
y = 100 + row * 200
```
These are the `x`,`y` values in `<mxGeometry>` (top-left corner of the cell bounding box,
before rotation). Rows wrap every 8 shapes.

Canvas size: `pageWidth = 100 + 8 * 220 + 100 = 1960`, `pageHeight = 100 + numRows * 200 + 100`.

Rotation rule: within each file, apply a mix of 0°, 15°, 30°, 45°, −20°, and −35° rotations
spread across cells so that every rotation-sensitive code path is exercised at least once per
file. No two adjacent cells (same row) both use the same extreme rotation (±45°).

### 11.2 Test Label Files

All files live in `src/main/native-print-engine/tests/fixtures/labels/`.

---

#### `master-test-basic.drawio` *(already exists — extend)*

**Purpose:** Basic and built-in shapes, style variants.  
**Add to existing file:** shapes from `basic.xml` stencil and the built-in JS shapes.

New cells to add (on top of existing 22 cells):

| Cell ID | Shape style | Label | Rotation |
|---|---|---|---|
| b01 | `shape=mxgraph.basic.star` | `Star` | 0° |
| b02 | `shape=mxgraph.basic.4_point_star` | `4pt Star` | 20° |
| b03 | `shape=mxgraph.basic.cross` | `Cross` | 0° |
| b04 | `shape=mxgraph.basic.x` | `X Shape` | 15° |
| b05 | `shape=mxgraph.basic.hexagon` | `Hex Stencil` | 0° |
| b06 | `shape=mxgraph.basic.pentagon` | `Pentagon` | −15° |
| b07 | `shape=mxgraph.basic.octagon` | `Octagon` | 0° |
| b08 | `shape=mxgraph.basic.arrow` | `Arrow` | 30° |
| b09 | `shape=hexagon` | `Built-in Hex` | 0° |
| b10 | `shape=doubleEllipse` | `Dbl Ellipse` | 0° |
| b11 | `shape=actor` | `Actor` | 10° |
| b12 | `shape=swimlane` | `Swimlane` | 0° |
| b13 | `shape=mxgraph.basic.star;flipH=1` | `Star FlipH` | 0° |
| b14 | `shape=mxgraph.basic.arrow;flipV=1` | `Arrow FlipV` | 0° |
| b15 | `shape=mxgraph.basic.star;direction=north` | `Star North` | 0° |
| b16 | `shape=mxgraph.basic.arrow;gradientColor=#ff0000` | `Gradient Arrow` | 0° |
| b17 | `shape=mxgraph.basic.trapezoid` | `Trapezoid` | 15° |
| b18 | `shape=arrowConnector` | `Arrow Conn` | 0° |

---

#### `master-test-flowchart.drawio` *(new)*

**Purpose:** Covers `flowchart.xml` — the most commonly used stencil family.  
All shapes are `aspect="variable"` (non-icon, stretch to cell size).

Cells (8 per row, 120×100 px each):

| Cell ID | Shape style | Label | Rotation |
|---|---|---|---|
| f01 | `shape=mxgraph.flowchart.start_1` | `Start` | 0° |
| f02 | `shape=mxgraph.flowchart.start_2` | `Start 2` | 0° |
| f03 | `shape=mxgraph.flowchart.process` | `Process` | 0° |
| f04 | `shape=mxgraph.flowchart.decision` | `Decision` | 15° |
| f05 | `shape=mxgraph.flowchart.data` | `Data` | 0° |
| f06 | `shape=mxgraph.flowchart.predefined_process` | `Predefined` | 0° |
| f07 | `shape=mxgraph.flowchart.stored_data` | `Stored Data` | −15° |
| f08 | `shape=mxgraph.flowchart.internal_storage` | `Int Storage` | 0° |
| f09 | `shape=mxgraph.flowchart.sequential_data` | `Seq Data` | 0° |
| f10 | `shape=mxgraph.flowchart.direct_data` | `Direct Data` | 20° |
| f11 | `shape=mxgraph.flowchart.manual_input` | `Manual In` | 0° |
| f12 | `shape=mxgraph.flowchart.manual_operation` | `Manual Op` | 0° |
| f13 | `shape=mxgraph.flowchart.card` | `Card` | 30° |
| f14 | `shape=mxgraph.flowchart.punched_tape` | `Tape` | 0° |
| f15 | `shape=mxgraph.flowchart.terminator` | `Terminator` | 0° |
| f16 | `shape=mxgraph.flowchart.summing_function` | `Sum Func` | 0° |
| f17 | `shape=mxgraph.flowchart.or` | `Or` | 0° |
| f18 | `shape=mxgraph.flowchart.collate` | `Collate` | 0° |
| f19 | `shape=mxgraph.flowchart.sort` | `Sort` | −20° |
| f20 | `shape=mxgraph.flowchart.preparation` | `Preparation` | 0° |
| f21 | `shape=mxgraph.flowchart.merge_or_storage` | `Merge/Store` | 0° |
| f22 | `shape=mxgraph.flowchart.delay` | `Delay` | 0° |
| f23 | `shape=mxgraph.flowchart.display` | `Display` | 0° |
| f24 | `shape=mxgraph.flowchart.annotation_1` | `Annotation` | 0° |

---

#### `master-test-arrows-bpmn.drawio` *(new)*

**Purpose:** Covers `arrows.xml` (`<shapes name="mxgraph.arrows">`) and `bpmn.xml`. Exercises
a mix of `aspect="variable"` and `aspect="fixed"` shapes, and path commands including arc and
curve.

Arrows section (120×80 px, first two rows):

| Cell ID | Shape style | Label | Rotation |
|---|---|---|---|
| a01 | `shape=mxgraph.arrows.arrow_down` | `Arrow Down` | 0° |
| a02 | `shape=mxgraph.arrows.arrow_left` | `Arrow Left` | 0° |
| a03 | `shape=mxgraph.arrows.arrow_up` | `Arrow Up` | 0° |
| a04 | `shape=mxgraph.arrows.arrow_right` | `Arrow Right` | 0° |
| a05 | `shape=mxgraph.arrows.arrow_down;flipH=1` | `Arrow FH` | 0° |
| a06 | `shape=mxgraph.arrows.arrow_right;rotation=45` | `Arrow 45` | 45° |
| a07 | `shape=mxgraph.arrows.bent_right_arrow` | `Bent Right` | 0° |
| a08 | `shape=mxgraph.arrows.bent_left_arrow;rotation=-30` | `Bent L −30` | −30° |

BPMN section (100×100 px, next rows):

Note: BPMN shapes are individual stencil shapes in `bpmn.xml` (`<shapes name="mxgraph.bpmn">`).
The `shape=mxgraph.bpmn.shape;symbol=...` pattern used in the draw.io palette is a
parameterised UI composite — the underlying stencil shapes are registered individually.

| Cell ID | Shape style | Label | Rotation |
|---|---|---|---|
| p01 | `shape=mxgraph.bpmn.terminate` | `BPMN Term` | 0° |
| p02 | `shape=mxgraph.bpmn.general_start` | `BPMN Start` | 0° |
| p03 | `shape=mxgraph.bpmn.general_end` | `BPMN End` | 0° |
| p04 | `shape=mxgraph.bpmn.gateway_complex` | `Gateway X` | 0° |
| p05 | `shape=mxgraph.bpmn.gateway_and` | `Gateway +` | 0° |
| p06 | `shape=mxgraph.bpmn.user_task` | `User Task` | 0° |
| p07 | `shape=mxgraph.bpmn.timer_start` | `Timer Start` | 15° |
| p08 | `shape=mxgraph.bpmn.loop` | `Loop` | 0° |

---

#### `master-test-aws.drawio` *(new)*

**Purpose:** Covers `aws4.xml` (`<shapes name="mxgraph.aws4">`). All AWS4 shapes are
`aspect="fixed"` — this file primarily tests the `computeAspect` centering path.
All cells: 100×100 px, `fillColor=#232F3E;strokeColor=#ffffff;fontColor=#ffffff`.

Note: AWS4 shapes are referenced directly by their stencil name (e.g. `shape=mxgraph.aws4.lambda`).
The `resourceIcon;resIcon=` pattern used in the draw.io UI palette is a composite/parameterised
container that is NOT a stencil shape — it does not exist in the stencil registry and must not
be used here.

| Cell ID | Shape style | Label | Rotation |
|---|---|---|---|
| w01 | `shape=mxgraph.aws4.lambda` | `Lambda` | 0° |
| w02 | `shape=mxgraph.aws4.s3` | `S3` | 0° |
| w03 | `shape=mxgraph.aws4.ec2` | `EC2` | 0° |
| w04 | `shape=mxgraph.aws4.rds` | `RDS` | 0° |
| w05 | `shape=mxgraph.aws4.dynamodb` | `DynamoDB` | 15° |
| w06 | `shape=mxgraph.aws4.sqs` | `SQS` | 0° |
| w07 | `shape=mxgraph.aws4.sns` | `SNS` | −15° |
| w08 | `shape=mxgraph.aws4.cloudwatch` | `CloudWatch` | 0° |
| w09 | `shape=mxgraph.aws4.api_gateway` | `API GW` | 0° |
| w10 | `shape=mxgraph.aws4.general` | `General` | 0° |
| w11 | `shape=mxgraph.aws4.vpc` | `VPC` | 0° |
| w12 | `shape=mxgraph.aws4.route_53` | `Route 53` | 30° |

---

#### `master-test-network.drawio` *(new)*

**Purpose:** Covers `networks.xml` (`<shapes name="mxgraph.networks">`) and representative
Cisco shapes. Mix of `aspect="variable"` shapes. Cells: 100×100 px.

| Cell ID | Shape style | Label | Rotation |
|---|---|---|---|
| n01 | `shape=mxgraph.networks.server` | `Server` | 0° |
| n02 | `shape=mxgraph.networks.router` | `Router` | 0° |
| n03 | `shape=mxgraph.networks.hub` | `Hub` | 0° |
| n04 | `shape=mxgraph.networks.firewall` | `Firewall` | 0° |
| n05 | `shape=mxgraph.networks.laptop` | `Laptop` | 15° |
| n06 | `shape=mxgraph.networks.desktop_pc` | `Desktop PC` | 0° |
| n07 | `shape=mxgraph.networks.cloud` | `Cloud` | −15° |
| n08 | `shape=mxgraph.networks.load_balancer` | `Load Bal` | 0° |
| n09 | `shape=mxgraph.cisco.computers_and_peripherals.laptop` | `Cisco Laptop` | 0° |
| n10 | `shape=mxgraph.cisco.routers.atm_router` | `Cisco Router` | 0° |
| n11 | `shape=mxgraph.cisco.switches.atm_switch` | `Cisco Switch` | 0° |
| n12 | `shape=mxgraph.cisco.security.firewall` | `Cisco FW` | 20° |

---

#### `master-test-style-variants.drawio` *(new)*

**Purpose:** Cross-cutting style properties — gradient, dashed, thick stroke, flipH, flipV,
`direction=north/south/west`, labelPosition outside cell, and `stencil(base64...)` inline
shape. Uses the same `mxgraph.flowchart.process` shape as base to isolate style rendering
from shape geometry.

Cells: 120×100 px each.

| Cell ID | Shape / Style override | Label | Purpose |
|---|---|---|---|
| s01 | `shape=mxgraph.flowchart.process;fillColor=#dae8fc;gradientColor=#6c8ebf` | `Gradient` | Gradient fill |
| s02 | `shape=mxgraph.flowchart.process;dashed=1` | `Dashed` | Dashed stroke |
| s03 | `shape=mxgraph.flowchart.process;strokeWidth=4` | `Thick` | Thick stroke |
| s04 | `shape=mxgraph.flowchart.process;opacity=50` | `Opacity 50` | Shape opacity |
| s05 | `shape=mxgraph.flowchart.data;flipH=1` | `Flip H` | Horizontal flip |
| s06 | `shape=mxgraph.flowchart.data;flipV=1` | `Flip V` | Vertical flip |
| s07 | `shape=mxgraph.flowchart.data;flipH=1;flipV=1` | `Flip HV` | Both flips |
| s08 | `shape=mxgraph.flowchart.data;direction=north` | `Dir N` | Direction north |
| s09 | `shape=mxgraph.flowchart.data;direction=south` | `Dir S` | Direction south |
| s10 | `shape=mxgraph.flowchart.data;direction=west` | `Dir W` | Direction west |
| s11 | `shape=mxgraph.flowchart.process;rotation=45;gradientColor=#ff8000` | `Rot+Grad` | Rotation + gradient |
| s12 | `shape=mxgraph.flowchart.process;rotation=-30;dashed=1` | `Rot+Dash` | Rotation + dashed |
| s13 | `shape=mxgraph.flowchart.process;labelPosition=right;align=left` | `Label Right` | Label outside cell |
| s14 | `shape=mxgraph.flowchart.process;verticalLabelPosition=bottom;verticalAlign=top` | `Label Below` | Label below cell |
| s15 | `shape=stencil(PHNoYXBlIG5hbWU9InRlc3QiIHc9IjEwMCIgaD0iMTAwIiBhc3BlY3Q9InZhcmlhYmxlIj48YmFja2dyb3VuZD48cGF0aD48bW92ZSB4PSIwIiB5PSIwIi8+PGxpbmUgeD0iMTAwIiB5PSIwIi8+PGxpbmUgeD0iMTAwIiB5PSIxMDAiLz48bGluZSB4PSIwIiB5PSIxMDAiLz48Y2xvc2UvPjwvcGF0aD48L2JhY2tncm91bmQ+PGZvcmVncm91bmQ+PGZpbGxzdHJva2UvPjwvZm9yZWdyb3VuZD48L3NoYXBlPg==)` | `Inline Stencil` | Inline base64 shape |

The `stencil(...)` value in s15 is a base64-encoded simple rectangle stencil XML, pre-computed
and hardcoded in the .drawio file.

---

### 11.3 Test Label Creation Rules

1. All `.drawio` files use `host="bake-test"` and `modified="2026-05-25T00:00:00.000Z"` to
   produce deterministic bake output.
2. All cells use `fontFamily=Arial;fontSize=11` for consistent text rendering.
3. No two cells overlap. Minimum 20 px gap between any two cell bounding boxes (including
   the expanded bounding box for rotated cells).
4. Every cell carries a non-empty `value` attribute (the label). The label names the shape.
5. Stencil shapes that are known to use `<image>` or `<include-shape>` internally are
   intentionally excluded from Phase 1 test labels — they would produce expected notices and
   are tracked separately in §11.4.
6. After creating each file, run `node tools/native-print-bake/bake.mjs <file>` to confirm the
   file parses as valid XML. Before implementation, bake will fail with notices — that is
   expected. The files are correct if they parse without XML errors.

### 11.4 Shapes Intentionally Excluded (Phase 1)

These shapes are known to use stencil features deferred to Phase 3. Including them in Phase 1
test labels would produce legitimate notices and mask real failures. They are tracked here so
they can be added to a `master-test-phase3.drawio` file when Phase 3 is implemented.

- Shapes with `<image>` stencil commands (identified by grepping the stencil XML for `<image`).
- Shapes with `<include-shape>` stencil commands.
- Shapes with `<path rounded="1">` (identified by grepping for `rounded="1"`).

**Validation requirement:** Before running Gate 1 (§12.3), the `wysiwyg-compare.mjs --all`
tool must scan each test label `.drawio` file and explicitly error if any cell's shape name
maps to a stencil that contains an excluded command (`<image>`, `<include-shape>`, or
`<path rounded="1">`). This prevents excluded shapes from slipping into Phase 1 test files
undetected and masking real failures with expected notices. Implement this as a pre-Gate-1
validation step in `wysiwyg-compare.mjs`.

---

## 12. WYSIWYG Verification and Done Criteria

### 12.1 Verification Approach

WYSIWYG is guaranteed **by construction**, not by pixel comparison (which is forbidden by
`docs/CLAUDE.md §2`). The stencil XML defines exactly what draw.io renders; the headless
renderer uses the same XML. There is nothing to "compare against a browser" — the source of
truth is the stencil XML itself.

Verification is therefore **structural and deterministic**:

1. **Structural check**: every vertex cell in the `.drawio` file maps to a `kind:'svg'` (or
   `kind:'path'`) node in the bake output. No cell is silently missing.
2. **Label check**: every cell with a non-empty `value` has its label text preserved verbatim
   in the contract (in a `kind:'text'` node or embedded in the `kind:'svg'` source).
3. **Notice check**: zero `ExporterUnsupportedShape` notices in the bake output for any cell
   using a shape that Phase 1/2/3 is expected to support.
4. **Gradient check**: cells with `gradientColor` produce `kind:'svg'` nodes whose `source`
   (base64-decoded) contains a `<linearGradient` element in the SVG defs.
5. **Rotation check**: cells with `rotation != 0` produce `kind:'svg'` nodes whose SVG source
   contains a `transform="rotate(` attribute.
6. **Flip check**: cells with `flipH=1` or `flipV=1` produce SVG source containing
   `scale(-1` or `scale(1,-1`.
7. **Direction check**: cells with `direction=north/south/west` produce SVG source containing
   a rotation transform.
8. **Golden contract**: baking the same `.drawio` file twice produces byte-identical contract
   JSON (determinism check). The golden is committed at
   `src/main/native-print-engine/tests/fixtures/labels/<filename>.contract.golden.json`.
9. **Cell count**: the number of paint nodes in the contract equals the number of vertex cells
   in the `.drawio` file (connectors/edges are separate).

### 12.2 `wysiwyg-compare.mjs` Extension

Extend `compare(drawioXml)` in `tools/native-print-bake/wysiwyg-compare.mjs` to run all 9
checks above. The function already exists; add the new checks as named assertions. Each
check reports pass/fail with the specific cell ID and failure reason.

Add a CLI batch mode:
```
node wysiwyg-compare.mjs --all
```
which runs `compare()` on every `.drawio` file in the fixtures labels directory and exits 0
only if all files pass all checks.

### 12.3 Gate 1: Zero Unsupported Shape Notices

**Gate 1 is the primary passing criterion for Phase 1/2.**

After Phase 1b and Phase 2 are implemented, running:
```
node tools/native-print-bake/wysiwyg-compare.mjs --all
```
must produce zero `ExporterUnsupportedShape` notices across all master test label files
(excluding Phase 1 intentionally excluded shapes from §11.4).

Gate 1 failure blocks "done" declaration. No exceptions.

### 12.4 Gate 2: Golden Contract Match

For each master test label file, a golden contract is generated after Gate 1 passes and
committed to the repository. Subsequent runs of `node --test` include a C1-style test for
each golden file:

```javascript
test('C1 master-test-<name>: bake output matches golden', async () => {
  const xml = readFileSync(join(fixtureDir, 'master-test-<name>.drawio'), 'utf8');
  const result = await bake(xml);
  const golden = JSON.parse(readFileSync(join(fixtureDir, 'master-test-<name>.contract.golden.json'), 'utf8'));
  assert.deepStrictEqual(result, golden);
});
```

This enforces determinism: the renderer produces exactly the same output on every run.
Golden contracts are regenerated only when the stencil XML or renderer logic intentionally
changes, and the diff is reviewed in the PR.

### 12.5 Done Declaration

The implementation is **done** when ALL of the following are true:

| Check | Command | Requirement |
|---|---|---|
| All unit tests pass | `node --test tools/native-print-bake/bake.test.mjs` | 0 failures |
| Gate 1: zero unsupported shapes | `node wysiwyg-compare.mjs --all` | 0 `ExporterUnsupportedShape` notices |
| Gate 2: golden contracts match | `node --test tools/native-print-bake/bake.test.mjs` (C1 tests) | All golden tests pass |
| Engine tests pass | `ctest` in `src/main/native-print-engine/build/` | 0 failures |
| All 9 structural checks pass | `node wysiwyg-compare.mjs --all` | All checks pass for all files |
| Bake is deterministic | Run bake twice on each file, compare output | Byte-identical |

---

## Appendix: Advisor Review Summary

### Review 1 (2026-05-25) — Core spec, 10 defects corrected

| # | Defect | Fix |
|---|---|---|
| 1 | Key format derived from file path, not `<shapes name="...">` attr | §3.2 rewritten with correct formula |
| 2 | No space→underscore replacement in shape names | Added to §3.2 key formula |
| 3 | `aspect="fixed"` centering offset missing | §3.3 `computeAspect` added |
| 4 | `direction` / `flipH` / `flipV` transforms not mentioned | §3.3 direction handling + §3.4 step 12 |
| 5 | Gradient fills silently dropped | §3.4 step 9 gradient handling added |
| 6 | `<path rounded="1">` silently approximated as sharp | §3.4 step 6: raise notice for rounded paths |
| 7 | Inline `stencil(base64...)` shapes not handled | §3.5 added |
| 8 | `strokewidth="inherit"` initial setup not described | §3.4 step 3 added |
| 9 | `labelPosition`/`verticalLabelPosition` not handled | §3.6 style overrides table added |
| 10 | `<fillstroke>` described as child of `<path>` (wrong — it's a sibling) | §3.4 step 5 clarified with explicit sibling walker model |

### Review 2 (2026-05-25) — Test label suite, 8 defects corrected (prior round)

### Review 3 (2026-05-25) — Full plan audit, 6 defects corrected

| # | Defect | Fix |
|---|---|---|
| 1 | `mxgraph.flowchart.connector/extract/merge` don't exist in flowchart.xml | f15→`terminator`, f20→`preparation`, f21→`merge_or_storage` |
| 2 | `mxgraph.bpmn.shape` doesn't exist; BPMN uses individual stencil shapes | p01-p08 rewritten with `mxgraph.bpmn.terminate`, `gateway_complex`, etc. |
| 3 | `parallelogram`, `plus` don't exist anywhere; `cross`/`trapezoid` are stencils not JS built-ins | §3.8 built-in list corrected to authoritative 15-shape set; b11→`actor`, b12→`swimlane`, b17/b18 added for missing built-ins |
| 4 | §3.4 step 8: no handling for paint command with empty path accumulator (orphaned paint) — affects 11,000+ stencils | Step 8 amended: empty accumulator → silent no-op (matches browser behaviour) |
| 5 | Spacing: 30°/45°/−35° overflow canvas top at origin (20,20) | Grid origin moved to (100,100); verified clearance ≥72 px at 45° |
| 6 | Done criteria: structural checks cannot catch gradient correctness or edge-case geometry errors | §12.5 note added; test files must be comprehensive and include all known edge cases |

### Review 2 (2026-05-25) — Test label suite, 8 defects corrected

| # | Defect | Fix |
|---|---|---|
| 1 | `mxgraph.arrows2.*` package doesn't exist; correct is `mxgraph.arrows` | §11.2 arrows table rewritten with verified shape names from `arrows.xml` |
| 2 | `summing_junction` → `summing_function` (actual XML name is "Summing Function") | f16 cell corrected |
| 3 | AWS `resourceIcon` shape doesn't exist in stencil registry; is a UI container | §11.2 AWS table rewritten using direct `mxgraph.aws4.*` shape names |
| 4 | `mxgraph.network.*` → `mxgraph.networks.*` (package name has trailing 's'); cisco shapes used wrong names | §11.2 network table corrected with verified shape/package names |
| 5 | Grid overlap unspecified: 20 px gutter insufficient for 45° rotated cells (~155 px bbox) | §11.1 grid pitch changed to 220×200 px with explicit coordinate formula |
| 6 | `§13` cross-references (section doesn't exist) | All `§13` replaced with `§12.3` or `§12.5` |
| 7 | Duplicate §10 section (merge error) | Duplicate removed; single §10 retained |
| 8 | Excluded shapes validation unspecified: slipped-in excluded shapes would silently corrupt Gate 1 | §11.4 adds mandatory pre-Gate-1 validation scan in `wysiwyg-compare.mjs` |
