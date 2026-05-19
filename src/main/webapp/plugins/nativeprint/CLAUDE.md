# Native Print — agent guardrails (read before changing anything here)

These are **hard business requirements** from the project owner. They are
settled. Do not propose, design, or implement anything that violates them,
and do not ask to revisit them. Full text + rationale:
`docs/CLAUDE.md` → "Native Print — NON-NEGOTIABLE CONSTRAINTS".

1. **WYSIWYG is mandatory.** Faithful render OR a loud notice — never a
   silent divergence/approximation.

2. **No browser, ever — not even headless.** Forbidden for the guarantee,
   verification, or tests: headless Chromium, Playwright, Puppeteer,
   Selenium, Electron, `jsdom`, and in-app pixel oracles (canvas
   `getImageData`, rasterizing `getSvg()`, screenshot diff). No pixel
   comparison oracle is possible under this rule — do not add one. A
   browser-based self-check was already built and **reverted**; do not
   recreate it.

3. **Guarantee by construction, verified browser-free.** Transcribe
   drawio's actual rendered SVG (`harvestShape`); remove re-derived /
   heuristic geometry; enforce with structural invariants in the existing
   `node --test` (exporter) and `ctest` (engine) harnesses.

4. **Frozen engine/contract boundary.** Don't bypass the engine; contract
   schema changes need an explicit owner decision (escalate, don't infer).

5. **No silent heuristic fallbacks** on the live path (`shapePath`,
   `plainLabel` flattening, `edgeLabelBox`) — headless last-resort only,
   loudly noticed when they would diverge.

If a task seems to need a browser to "prove" WYSIWYG: remove the
re-derivation so there is nothing to prove — do not add a browser.
