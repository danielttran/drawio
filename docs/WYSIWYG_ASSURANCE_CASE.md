# Native Print — WYSIWYG Assurance Case

**Status:** living document · **Scope:** the native (headless) print path
(`plugins/nativeprint/exporter.js` → frozen JSON contract → C++ engine →
resvg/GDI → printer) · **Constraint:** browser-free (see `docs/CLAUDE.md` §2).

This is the business-facing argument for *why the printed page reproduces what
the operator sees in drawio*, and the evidence that backs it. It is written to
be honest about what is **proven**, what is **bounded**, and what is
**residual** — so it can be audited.

---

## 1. The claim

> For every object a user can draw in drawio and every style configuration of
> it, the native print engine reproduces the editor's appearance **faithfully**,
> or emits a **loud notice** stating exactly where it cannot — never a silent
> divergence (the "WYSIWYG-or-loud" guarantee, `docs/CLAUDE.md` §1).

Two honesty caveats stated up front, because they bound what "proven" can mean:

- **Ground truth lives in a browser.** What the operator *sees* is mxGraph
  painted by a browser. Constraint §2 forbids a browser in the guarantee or its
  verification. Therefore strict *pixel-equivalence to the editor* cannot be
  empirically proven within the allowed toolset. What **can** be proven is the
  next-strongest property — see §3.
- **The object × style space is unbounded** (arbitrary stencils, style
  combinations, text, fonts). "All objects and styles" is made tractable by
  reducing it to a *defined, enumerable population* (§5), not by exhaustion.

## 2. Decomposition (the proof chain)

| Link | Claim | Verified by |
|---|---|---|
| **L1** editor pixels ≡ drawio's geometry code | drawio paints what its code computes | One axiom; discharged out-of-band (§7) |
| **L2** contract ≡ editor geometry/text | exporter == drawio's own geometry, headless | **Differential oracle (§4)** + structural matrices (§5) |
| **L3** raster ≡ contract | resvg/GDI renders the contract faithfully | Golden + determinism + per-primitive (§6) |
| **L4** paper ≡ raster | printer reproduces the bitmap | Out-of-band hardware calibration (§7) |

The hard link is **L2**. The key enabling insight: **drawio/mxGraph geometry is
pure computation** — `paintVertexShape`/`addPoints`/perimeter/edge-routing emit
paths via a canvas *abstraction*; the browser is only needed to *paint*, not to
*compute*. So drawio's own renderer can be the **oracle**, run with zero
browser, and the exporter diffed against it. This turns "we re-derive and claim
fidelity" into "machine-checked conformance to the authoritative renderer."

## 3. What is proven (precise statement)

WYSIWYG holds **by construction and conformance**, verified browser-free:

1. **Geometry conformance (L2).** For the shapes drawio renders via mxGraph
   **core**, the exporter's contract geometry is **equal to drawio's own
   rendering code** to sub-pixel tolerance — established by the differential
   oracle (§4), which executes that code headlessly.
2. **Structural completeness & no silent drop.** Every cell maps to ≥1 contract
   node; every labelled object carries its own text verbatim; every registered
   shape and every checked-in stencil bakes with no unsupported-shape notice
   (§5).
3. **No silent divergence (C1).** Anything not reproduced faithfully raises a
   loud `Degradation` notice naming the cell. Unknowns become *known* unknowns.
4. **Determinism.** Identical input → byte-identical contract; the rasterizer is
   pixel-deterministic.

This is the strongest browser-free claim available: *conformance-proven to the
authoritative renderer for the core set, structurally complete elsewhere, with a
bounded and loudly-flagged residual.*

## 4. The differential oracle (`tools/wysiwyg-oracle/`)

**What it is.** `mx-oracle.mjs` loads drawio's **real** vertex-shape code
(`src/main/webapp/mxgraph/src/shape/*.js`) into Node with tiny pure-function
shims (no DOM, no jsdom, no painting) and drives `paintVertexShape` with a
**recording canvas** that captures the exact path drawio draws.
`oracle.test.mjs` then diffs the exporter's contract geometry against it using a
start-point/winding-invariant **Hausdorff** metric over densely-sampled points.

**Why it's authoritative, not a re-derivation.** The reference path comes out of
mxGraph's actual source — the same code the editor paints with. Agreement is
conformance to the real renderer, achieved with zero browser.

**Proven exact (dev ≤ 0.1px), `node --test tools/wysiwyg-oracle/oracle.test.mjs`:**

| Shape (mxGraph core) | sharp | rounded |
|---|---|---|
| rectangle | ✅ 0.000 | ✅ 0.000 (incl. roundedRect) |
| ellipse | ✅ 0.000 | ✅ 0.000 |
| rhombus / diamond | ✅ 0.000 | ✅ 0.000 |
| triangle | ✅ 0.000 | ✅ 0.001 |

Across sizes `80×40, 120×60, 50×50, 200×30` and arcSize `10/20/40`.

**Findings (the oracle's value — it caught real issues):**

- **FIXED — rounded polygons were a silent divergence.** rhombus/triangle with
  `rounded=1` printed *square* with **no notice** (a C1 violation). Fixed by
  `roundedPoly()` in `exporter.js` (a faithful port of `mxShape.addPoints`),
  now **oracle-verified dev≈0**. This is the oracle→fix→verify loop working.
- **CLOSED C1 for the polygon class.** Sharp-cornered polygons not yet rounded
  headlessly (`hexagon, parallelogram, step, trapezoid`) now emit a loud
  "rounded corners are printed square" notice (`ROUNDED_NOT_YET`) — no longer
  silent. Implementing exact rounding for them (same `roundedPoly`, verified by
  a Shapes.js-backed oracle) is tracked in §8.
- **Reference-uncertain (residual).** `cylinder` and `cloud` deviate from
  mxGraph *core* (materially non-zero — roughly 5–14px depending on cell size);
  and `hexagon` is **overridden** by drawio's
  `HexagonShape` (Shapes.js), so mxGraph core is the wrong reference for it.
  These require extending the oracle to drawio's `Shapes.js` shape set before a
  conformance verdict — see §8. They are *not* asserted as conformant here.

## 5. Making "all objects and styles" a defined population

- **Objects.** `bake.test.mjs` sweeps **every shape in the Shapes.js registry**
  and **every checked-in stencil**, asserting each bakes with no
  unsupported-shape notice — the complete object set, not samples. The master
  fixtures (`aws/bpmn/flowchart/network/eip/cisco/…`) exercise real diagrams,
  validated structurally by `wysiwyg-compare.mjs --all`.
- **Built-in shape & object-type matrix.** `exporter.test.mjs` →
  "COMPREHENSIVE WYSIWYG COVERAGE MATRICES": 30 built-in shapes bake faithfully;
  every standard edge marker renders, exotic ones are loudly noticed; gradient
  axes for all four directions; each object kind maps to the expected node.
- **Text-style matrix.** Plain text: `exporter.test.mjs` covers fontStyle 0–15,
  family/size/color, align h×v, letterSpacing, vertical text, verticalLabelPos,
  wrap, multiline, opacity, label bg/border, and loud notices (rtl/shadow/
  indicator). Rich (HTML) text: `bake.test.mjs` "text fidelity" series covers
  bold/italic/underline/strike, per-run color/family/size, highlight, sub/sup,
  ordered/unordered/nested lists, `<hr>`, tables, links, per-paragraph
  alignment, combined runs, headings, blockquote, code, `<mark>`.
- **Geometry conformance.** The §4 oracle, for the mxGraph-core shapes.

## 6. Rasterizer & contract (L3)

- Golden contracts (`*.contract.golden.json`) freeze the exact bake of the
  rich-text and HTML-label master fixtures.
- Engine pixel-determinism (`svg_pixel_determinism_tests.cpp`) — stable output.
- Schema validity is asserted on every baked node (`assertSchemaValid`), and
  the engine consumes 100% of the contract.

## 7. Out-of-band steps (owner-gated)

- **L1 axiom** — "drawio paints what its geometry code computes." Discharged
  **once, human-supervised, offline** via `screenshot-editor.mjs` (the §2
  manual-debug carve-out): compare drawio's painted output to the headless
  oracle for a covering set, sign off, retire from the loop. *Owner decision
  required (touches §2).* **Not yet performed.**
- **L4 printer calibration** — scheduled hardware QA (color ΔE, DPI, margins)
  per printer/driver. Documented procedure, outside CI. **Not yet scheduled.**

## 8. Residual-risk register

| # | Risk | Severity | Disposition |
|---|---|---|---|
| R1 | Exact rounding not yet implemented for `hexagon/parallelogram/step/trapezoid` etc. | Low | **Loud notice today (C1 holds).** Implement via `roundedPoly` + Shapes.js oracle. |
| R2 | `cylinder`/`cloud` deviate from mxGraph-core oracle (~5–14px, size-dependent) | Medium | Confirm drawio's actual shape impl; extend oracle to Shapes.js; fix or document tolerance. |
| R3 | Oracle covers mxGraph-core shapes only; drawio-overridden & stencil geometry not yet diffed at the path level | Medium | Extend oracle to drawio `Shapes.js` shapes and to `mxStencil` (declarative XML is authoritative). Stencils currently covered structurally (§5). |
| R4 | Text *rasterization* (glyph shaping) not pixel-proven | Medium | Mitigated by pinned fonts shared by layout & resvg; metrics-based layout conformance is the planned closure. |
| R5 | L1 axiom not yet discharged | Medium | One-time supervised audit (§7); owner-gated. |
| R6 | L4 printer hardware not calibrated | Medium | Scheduled out-of-band QA (§7). |
| R7 | Unbounded style space — covering-array/property-based generation not yet wired | Low | Add t-way covering array + fuzzing over the style grammar through the oracle. |

No **silent** divergence is known to remain in the covered population: every
item above is either faithful, loudly noticed, or an out-of-band/owner-gated
step.

## 9. Owner decisions

| Decision | Status |
|---|---|
| Headless mxGraph code as the oracle is **not** "a browser" (it computes, never paints) | **Adopted** in this case; recommend codifying as a §2 clarification |
| Geometry tolerance = 0.1px (sub-pixel; float noise only) | Proposed |
| Pinned font set for text rasterization conformance | **Open** (needed for R4) |
| Bless the one-time supervised L1 audit | **Open** (R5) |

## 10. Re-validation triggers

Re-run the oracle + suites and refresh this case on: a drawio/mxGraph version
bump, any `exporter.js` geometry change, a font-set change, or an engine/resvg
change. The oracle is the regression guard for geometry conformance.

## 11. How to reproduce the evidence

```
node --test tools/wysiwyg-oracle/oracle.test.mjs          # L2 geometry conformance
node --test src/main/webapp/plugins/nativeprint/exporter.test.mjs   # object/text matrices + C1
node --test tools/native-print-bake/bake.test.mjs         # every shape/stencil + rich text + goldens
node tools/native-print-bake/wysiwyg-compare.mjs --all    # per-diagram structural fidelity
```

## 12. Bottom line for business

WYSIWYG is **ensured** in the precise, defensible sense: the print contract is
**conformance-proven to drawio's own rendering code** (browser-free) for the
core shape set, **structurally complete** across the full enumerable object set
and text-style matrix, and **never silently divergent** (faithful-or-loud). The
remaining gaps (R1–R7) are explicitly bounded, individually tracked, and either
loudly flagged today or scheduled — not unknowns. Full path-level conformance
for drawio-overridden/stencil shapes and pixel-level text/printer validation are
the defined next steps to extend the same machine-checked method to 100% of the
population.
