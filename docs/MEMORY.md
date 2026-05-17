# draw.io Workspace Memory (MEMORY.md)

## Project Overview & Context
- **Repository**: Local fork of `jgraph/drawio` mapped as `danielttran/drawio`.
- **Purpose**: Local deployment, customization, and developer environment setup.
- **License/Policy**: JGraph does not accept outside pull requests. Do not attempt to push upstream. All code belongs to the local fork.

---

## Local Development Configuration
- **Package Manager**: NPM
- **Local Server**: Vite (dev dependency)
- **Root Configuration**: `package.json` at root (`E:\Dev\drawio\package.json`)
- **Server Entrypoint**: Serving `src/main/webapp/` at `http://localhost:3000`.
- **Running the Server**: `npm run dev`
- **Development vs. Production Modes**:
  - **Standard Run**: Accessing `http://localhost:3000/` loads the minified production bundle `js/app.min.js`.
  - **Developer Mode**: Accessing `http://localhost:3000/?dev=1` (or `?dev=1&test=1`) forces the app to bypass the minified bundle and load the individual source scripts directly from `js/diagramly/` and `js/grapheditor/`, enabling live debugging and code changes.

---

## Codebase Architecture
- **`src/main/webapp/`**: The core frontend static directory.
  - `index.html`: Main HTML template.
  - `js/bootstrap.js`: Handles URL parameters, electron check, and loading script blocks dynamically.
  - `js/diagramly/`: Primary application controllers, files, and clients (e.g. `App.js`, `EditorUi.js`, etc.).
  - `js/grapheditor/`: Graphical UI elements and shape libraries.
  - `mxgraph/src/`: Core mxGraph graph visualization engine source.
- **`src/main/java/`**: Java backend server servlets.
- **`etc/build/`**: Build scripts using Apache Ant (`build.xml`).

---

## Important Rules & Constraints
1. **Never make upstream contributions**: Commit and push only to your fork (`danielttran/drawio`).
2. **Build bats over make**: If there is a `build.bat` present, use it. Do not use make.
3. **Save tokens**: Keep this `MEMORY.md` updated so future turns can quickly understand the active state and repository design.
