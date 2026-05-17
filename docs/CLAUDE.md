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
