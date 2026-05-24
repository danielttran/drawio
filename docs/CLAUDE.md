# draw.io Agent Instructions (CLAUDE.md)

## CRITICAL INSTRUCTIONS: UPSTREAM PUSH RESTRICTION
> [!WARNING]
> **DO NOT push any commits, branches, or pull requests upstream to the main `jgraph/drawio` repository.**
> Draw.io does not accept public pull requests, and all development is managed by the core team. 
> All work, staging, commits, and pushes MUST be done exclusively in your current local workspace or personal fork: `danielttran/drawio`.

---

## Local Development Commands

- **Install dependencies**: `npm install`
- **Run local development web server**: `npm run dev`
  - Starts Vite serving `src/main/webapp` at `http://localhost:3000`.
- **Run in unminified Dev Mode**: Add `?dev=1` to the browser URL (e.g., `http://localhost:3000/index.html?dev=1`) to load individual JS files in `src/main/webapp/js/diagramly/` instead of the compiled `app.min.js`.

---

## Codebase Guidelines & Style

- **Memory File Rule**: Always refer to and update `MEMORY.md` at the start and end of each turn to save tokens and maintain local context.
- **Languages**: HTML/JavaScript for the web app frontend (`src/main/webapp/`), Java for server-side utilities (`src/main/java/`).
- **Formatting**: Preserve original files' tab-based or double-space indentation, comment structure, and naming conventions.
- **Java Build**: If modifying Java files, build is managed via Apache Ant (uses `etc/build/build.xml`). Never use make. If there is a `build.bat`, use it.

---

## jCodeMunch MCP Integration
Always prioritize using `jcodemunch-mcp` tools over native shell commands (`grep`, `find`, `glob`) for this indexed repository.

### Quick Start
1. `resolve_repo` / `list_repos` — confirm indexing status.
2. `search_symbols` — find files and symbol IDs.
3. `get_context_bundle` — get source code + imports in one call.
4. `search_text` — search literals and comments with context.

---

## Native Print — NON-NEGOTIABLE CONSTRAINTS (do not relitigate)

> [!WARNING]
> These are hard business requirements set by the project owner. Do NOT
> propose, design, scaffold, or implement anything that contradicts them,
> and do NOT ask to revisit them. Treat any violation as a defect.

1. **WYSIWYG is a hard requirement.** What the operator sees in drawio is
   what must come out of the printer. Every object is either rendered
   faithfully OR a loud `Degradation`/notice says exactly why not —
   **never a silent divergence, never a silent approximation.**

2. **No browser anywhere — not even headless.** The WYSIWYG guarantee and
   any verification/conformance/test harness MUST NOT depend on a browser.
   This explicitly forbids: headless Chromium/Chrome, Playwright,
   Puppeteer, Selenium, Electron, `jsdom`, and **in-app/runtime pixel
   oracles** (canvas `drawImage`/`getImageData`, rasterizing `getSvg()`,
   screenshot diffing). There is no "but it's only the app's own browser"
   exception. A pixel-comparison oracle is impossible under this rule —
   do not try to sneak one in.

   > **Owner carve-out (2026-05-24): image embedding may use canvas.**
   > To keep external/URL-referenced image artwork WYSIWYG, the bake MAY
   > fetch the image and/or re-encode it via an offscreen `canvas`
   > (`drawImage` + `toDataURL`) to embed it as a data URI
   > (`exporter.js` `embedExternalImages` / `urlToPngViaCanvas` /
   > `imgElementToPngDataUri`). This is authorised **only** for
   > *embedding image data so it prints faithfully* — NOT for building a
   > verification / pixel-comparison oracle, which stays forbidden. The
   > WYSIWYG guarantee itself still holds by construction (§3), and the
   > test harness stays browser-free (the canvas path no-ops in Node and
   > is unit-tested via an injected stub).

3. **Therefore the guarantee holds by construction, not by comparison.**
   The bake must losslessly transcribe drawio's *actual rendered* SVG
   (the existing `harvestShape` approach), eliminating re-derived/heuristic
   geometry. It is enforced by **structural invariants that run in the
   existing Node/C++ test harness with zero browser** (e.g. every contract
   node maps to a harvested element; no heuristic geometry remains; every
   labelled object carries its own non-empty text verbatim).

4. **The engine + JSON contract are a frozen, isolated boundary.**
   `architecture_tests.cpp` / INV-1 forbid drawio/mxGraph concepts in the
   engine. Do not bypass or rewrite the engine to "make WYSIWYG easier".
   Contract-schema changes require an explicit owner decision (escalate;
   do not infer) per `docs/PRINT_ENGINE_SPEC_v1.1.md`.

5. **No silent heuristic fallbacks.** Named-shape geometry, `plainLabel`
   blob flattening, `edgeLabelBox`, etc. are headless-only last resorts
   and must remain loudly noticed where they would diverge. Do not
   reintroduce them on the live path.

Rationale is in the git history of `src/main/webapp/plugins/nativeprint/`
(harvest-everything, paragraph fix, the reverted browser self-check). If a
task seems to need a browser to "prove" WYSIWYG, the answer is to remove
re-derivation so there is nothing to prove — not to add a browser.
