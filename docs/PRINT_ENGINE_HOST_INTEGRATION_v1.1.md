# Host Integration Spec v1.1 — Electron/Node draw.io ↔ C++ Print Engine

**Version:** 1.1 (supersedes Host Integration v1.0; changelog §13). Corrects protocol-completeness and internal-consistency defects found in audit; **no architectural change**.
**Status:** companion to `PRINT_ENGINE_SPEC_v1.1.md` (architecture of record) and `PRINT_ENGINE_SPEC_v2.0.md` (native-printing milestone). This document does NOT change the engine, the contract schema, the engine invariants, or the pipeline. It specifies the **host integration layer**: how the Electron-based draw.io clone drives the standalone engine, the "Print Native" UI, and the IPC contract.

**Authority & escalation:** same discipline as the spec set — silence or contradiction ⇒ STOP and ask; no inference on unspecified points.

**Terminology note:** this document uses **"flow step N"** for the numbered steps in §2 and **"§N"** only for document sections. Cross-references are explicit (e.g. "flow step 5", not "§2.5") to remove the ambiguity present in v1.0.

---

## 0. The load-bearing decision (read first)

**The engine is a standalone child process. It is NOT a Node native addon.**

Rejected: compiling the engine as an N-API `.node` module loaded into Electron's main process. Reason — this links the engine against the Node/Electron ABI, forces a rebuild per Electron version, and makes an engine fault crash the whole app. That re-couples the engine to draw.io's runtime and **violates INV-1** (engine knows nothing about draw.io; must build and run with zero draw.io/host presence). A native addon is the architecturally wrong choice here regardless of convenience.

Chosen: the engine is the standalone executable the spec set already describes. Electron's **main** process manages it as a long-lived child process and communicates over a **versioned IPC protocol** with the same loud-fail/version-reject discipline as the baked-file schema (an IPC-layer analog of INV-3). The engine is host-agnostic: driven by this Electron app, a CLI, or a test harness identically, knowing about none of them.

**"No browser" is not contradicted.** That constraint meant the *engine* must not depend on a browser/Chromium to render. Electron here is draw.io's UI shell (the host app already in use), not a rendering dependency of the engine. The engine still has zero browser dependency. The bake runs in the Electron renderer using the mxGraph already loaded in the app and hands a contract file to the engine; the engine never sees a browser or draw.io.

---

## 1. Process topology

```
┌─────────────────────────── Electron app (the draw.io clone) ───────────────────────────┐
│  Renderer process (Chromium + draw.io UI + mxGraph)                                      │
│    • "Print Native" menu/command                                                         │
│    • Bake: current diagram → v1.1 contract file  (the deferred exporter; §5)              │
│    • Print Native UI: printer/stock selection, merge-field entry, PREVIEW display,        │
│      DegradationNotice display + acknowledgment, operator confirm                          │
│        │  Electron contextBridge / ipcRenderer (in-app, trusted)                          │
│        ▼                                                                                  │
│  Main process (Node)  ── the ONLY component that talks to the engine ──                   │
│    • Engine lifecycle (spawn, health, restart)                                            │
│    • IPC client over the engine protocol (§3)                                             │
│    • Temp contract-file management (§6)                                                   │
│        │  engine IPC protocol (length-prefixed frames; §3)                                │
└────────┼─────────────────────────────────────────────────────────────────────────────────┘
         ▼
┌──────────────────────────────┐
│  Engine process (C++/GDI+)    │  standalone; zero draw.io/Node knowledge (INV-1)
│   P1..P7 per v1.1/v2.0         │  consumes baked contract files; renders preview;
│   printer/stock enumeration    │  drives the real printer DC; returns typed results
└──────────────────────────────┘
         ▼
   Windows print subsystem → printer / label stock
```

Rules:
- The **renderer never talks to the engine directly.** Renderer ↔ main via Electron `contextBridge`/`ipcRenderer` (trusted, in-app). Main ↔ engine via the engine protocol (§3). The engine's only external surface is one protocol with exactly one client (main).
- The engine never imports/links Node or draw.io (INV-1; enforced by the v1.1 §8.5 dependency-direction test — the engine repo has no Node/Electron/draw.io dependency).
- Printer and label-stock enumeration live **in the engine** (it owns the DC/DEVMODE/spooler interaction). The UI displays what the engine reports. Windows printing concerns stay in one place, out of Node.

---

## 2. End-to-end "Print Native" flow

**Flow step 1 — Menu/command.** A "Print Native" item is added (Electron `Menu` in main, or an in-app command in the renderer that messages main). Trigger arrives in the renderer.
**Flow step 2 — Bake.** Renderer serializes the current diagram to a **v1.1 contract file** via the bake/exporter (§5). On bake failure → show error in-app, abort (loud; nothing handed to the engine).
**Flow step 3 — Hand-off.** Renderer → main (Electron ipc): "native-print requested," with the contract (path or bytes; §6). Main writes/secures the temp contract file.
**Flow step 4 — Preview render.** Main → engine: `RenderPreview { contractRef, mergeData?, dpi }`. Engine runs P1–P6 to an in-memory bitmap (v1.1 §5 operator/design preview) and returns `PreviewResult` (the preview image as a correlated binary frame + all DegradationNotices + typed result).
**Flow step 5 — Print Native UI.** Renderer shows a modal: printer + label-stock selection (from `GetCapabilities`), copies, merge-field inputs (§4), the rendered preview image, and a **loud panel listing every DegradationNotice** (stubbed barcode/SVG, hardware-margin clip, font substitution, version-minor-ahead). The **Print button stays disabled until the operator explicitly acknowledges every notice** (regulated verification gate; ties to v2.0 §3.3 and v1.1 §11.5).
**Flow step 6 — Re-preview on change.** Editing a merge field or changing stock re-issues `RenderPreview`, so the operator always verifies the *actual* output (INV-5: preview is the same pipeline as print). Changing inputs **re-arms** the acknowledgment gate (prior acknowledgment is invalidated; notices must be re-acknowledged for the new preview).
**Flow step 7 — Confirm → Print.** Operator confirms → renderer → main → engine: `Print { contractRef, mergeData, printerId, stockId, copies }`. Engine runs P1–P7 real printer-DC sink (v2.0 §5), returns `PrintResult` (typed job result + notices + structured job-log record; §7).
**Flow step 8 — Result.** Main surfaces success/typed-failure to the renderer; UI shows it loudly. Temp contract file securely cleaned (§6) **after** the engine confirms it has finished reading (§6, no mid-read deletion). On failure the UI states which page/tile failed (engine `AbortDoc` discipline, v2.0 §5.2) — never a silent partial.

---

## 3. The engine IPC protocol (a versioned contract — same discipline as the schema)

### 3.1 Transport & framing
- Transport: a dedicated duplex channel between main and the engine — **a local named pipe (Windows) or the engine's stdio** (implementer chooses one, documents it, does not mix), NOT a TCP port (no network surface; regulated/desktop). The protocol is transport-agnostic above the frame layer.
- **Frame format is FROZEN for all protocol major versions.** Only the *payload schema* is versioned (§3.2). This resolves the handshake chicken-and-egg: the frame layer must always be parseable so `Hello` can always be read, regardless of payload-version drift. Changing the frame format itself is not a protocol-minor or protocol-major change — it would be a new transport entirely and is out of scope; do not design for it.
- Frame: `[uint32 frameLen][uint8 frameType][uint32 streamId][payload]`, `frameLen` covering `frameType`+`streamId`+`payload`, little-endian, fixed for all versions.
  - `frameType 0x01` = control (UTF-8 JSON payload).
  - `frameType 0x02` = binary blob (e.g. preview image bytes).
  - `streamId` correlates a binary blob frame to the control message that announced it (e.g. a `PreviewResult` control frame carries `imageStreamId`; the bytes arrive in an `0x02` frame with the same `streamId`).
- Length-prefixing eliminates the stdio message-boundary defect class. Binary payloads (preview bitmaps) are sent as `0x02` blobs, never base64-in-JSON — base64 is not an accepted alternative for image payloads (it inflates ~33% and pressures GC on multi-MB previews). JSON control payloads are always small; no size concern there.

### 3.2 Versioning (IPC-layer analog of INV-3)
- Every control message carries `proto: { major, minor }`. Engine declares `SUPPORTED_PROTO_MAJOR` and `SUPPORTED_PROTO_MINOR`.
- **`Hello` MUST be the first control message.** Until a successful `HelloOk`, the engine accepts only `Hello`; any other operation before handshake ⇒ `ProtoHandshakeError` and the operation is refused (ordering is defined, not implementation-dependent).
- `proto.major != SUPPORTED_PROTO_MAJOR` ⇒ engine returns `ProtoVersionError`, refuses all further ops; main surfaces a hard, loud failure ("engine/app version mismatch") and does NOT attempt best-effort. Identical philosophy to the schema version gate.
- `proto.minor > SUPPORTED_PROTO_MINOR` ⇒ proceed, and the engine emits a `DegradationNotice{ kind:"ProtoMinorAhead" }` on the handshake result. (Assumption, not engine-verifiable, mirroring the schema rule: protocol-minor bumps are additive/optional-only.)
- Protocol version and contract-schema version are **independent**. Every op that references a contract still triggers the engine's full v1.1 §3.2 schema gate on the file itself. Two independent version gates, both loud, neither best-effort.

### 3.3 Operations
All requests are control frames; all responses are a typed `Result` (`Ok` variant named per op below, or a typed error from §3.6). `Hello` must precede all others (§3.2).

- `Hello { proto }` → `HelloOk { engineVersion, proto, supportedSchemaMajor, supportedSchemaMinor }` | `ProtoVersionError`.
- `Ping {}` → `Pong { engineUptimeMs }`. Liveness probe used by main's health check (§8). No side effects.
- `GetCapabilities {}` → `Capabilities { printers: [ { id, name, defaultStockId, stocks: [ { id, name, widthMicrons, heightMicrons, dpiX, dpiY } ] } ], engineFeatures }`. Engine owns enumeration (§1); UI renders from this; no printer logic in Node.
- `GetContractFields { contractRef }` → `ContractFields { schemaVersion, fields: [ { key, kind: "text"|"barcode", maxLen, sampleValue } ] }` | typed error. Lets the UI build the merge-field form without the host parsing the contract (host stays draw.io-agnostic; engine is the single contract authority). Triggers the full schema gate on the file (§3.5).
- `RenderPreview { contractRef, mergeData?, dpi }` → `PreviewResult { imageStreamId, widthPx, heightPx, imageFormat:"png", notices: [DegradationNotice], schemaVersion }` | typed error. The image bytes follow in an `0x02` frame with `streamId == imageStreamId`.
- `Print { contractRef, mergeData, printerId, stockId, copies }` → `PrintResult { jobId, notices: [DegradationNotice], jobLog }` | typed error with `failedPage`/`failedTile` populated where applicable (`AbortDoc` discipline). Never reports partial success without an explicit failure marker.
- `ReleaseContract { contractRef }` → `Released {}`. Engine acknowledges it has finished reading the file and holds no handle; main deletes the temp file only after this (resolves the mid-read deletion race; §6).
- `Shutdown {}` → `ShutdownAck {}` then graceful exit (main controls lifecycle; §8).

### 3.4 Operation ordering & concurrency (defined, not implementation-dependent)
- `Hello` first (§3.2). `GetCapabilities`, `GetContractFields`, `RenderPreview`, `Print` permitted only after `HelloOk`.
- **Single-flight for `Print`:** at most one `Print` in progress per engine instance; main serializes (flow is one operator, one job; v1.1 reliability bias).
- **`RenderPreview` during an in-flight `Print` is rejected** with `EngineBusyError` (a regulated print in progress must not contend with a preview render on the same engine; main must not issue it). `Ping` is always permitted (it has no engine-state interaction).
- `ReleaseContract` for a given `contractRef` is sent by main only after the op using it has returned.

### 3.5 `contractRef`
Either an absolute temp-file path (preferred — §6) or inline bytes for small contracts. The engine treats it as opaque input and applies the full P1–P2 schema/version gate; it does **not** trust the host to have validated it. The engine validates everything it consumes regardless of source (defensive; consistent with loud-fail). Path-passing is a transport optimization, not a trust delegation.

### 3.6 Typed error taxonomy (mirrors the engine's internal `Result<T>` types)
Errors cross the boundary as **typed, named** values — never flattened to strings — so the UI can act on type. The set:
`ProtoHandshakeError`, `ProtoVersionError`, `ContractVersionError`, `ContractValidationError`, `MergeOverflowError`, `ImageDecodeError`, `ImageColorError`, `PrintDeviceError`, `EngineBusyError`, `EngineInternalError`.
Notes (outside the enumeration, deliberately not annotated inline): `BarcodeEncodeError` exists in the engine taxonomy but is **not raised in the stub era** (barcode is a loud stub per v2.0 §3.1) — it is reserved for the future barcode milestone and listed here only so the host's error-handling switch is forward-complete. `PrintDeviceError` cannot arise from `RenderPreview` (no device is opened for preview); it is a `Print`-only error. `HardwareMarginClip` and font substitution are **not errors** — they are `DegradationNotice`s (§3.7), because content still renders.

### 3.7 DegradationNotice (crosses the boundary as structured data)
```
DegradationNotice {
  kind:   "StubbedBarcode" | "StubbedSvgArtwork" | "HardwareMarginClip"
        | "FontSubstituted" | "SchemaMinorAhead" | "ProtoMinorAhead",
  pageId: string | null,     // present when the notice is page-scoped
                             // (Stubbed*, HardwareMarginClip, FontSubstituted);
                             // null for non-page-scoped (SchemaMinorAhead, ProtoMinorAhead)
  detail: object             // kind-specific structured payload, e.g.
                             //  StubbedBarcode  -> { symbology, resolvedValue, box }
                             //  HardwareMarginClip -> { tile, clippedRegion }
                             //  FontSubstituted -> { requested, substituted }
                             //  SchemaMinorAhead/ProtoMinorAhead -> { fileVersion|peerVersion, supported }
}
```
- `pageId` is **optional** by design — several notice kinds are not page-scoped (this corrects the v1.0 schema, which implied every notice had a `pageId`).
- **Never swallowed.** The renderer MUST display every notice in the Print Native UI and block confirm until each is acknowledged (flow step 5/6). This is how the v2.0 §3.3 loud-stub safety contract reaches the operator: a stubbed barcode cannot print without the operator seeing "BARCODE STUBBED — not scannable" and explicitly acknowledging it.

---

## 4. Merge-data entry point (forward-looking; seam reserved now)
- Merge sourcing is deferred per the spec set, but the **entry point is defined now** so the protocol need not change later (same "build the seam now" discipline as the engine).
- The UI builds one input per merge-bound field from `GetContractFields` (§3.3) — the host never parses the contract; the engine is the single contract authority.
- Operator-entered values travel as `mergeData: { KEY: value, … }` in `RenderPreview`/`Print` → engine P3 `IMergeSource` (stub now: identity/echo; real adapter later). The UI flow, the protocol field, and the re-preview-on-change loop all work today against the stub; only the real data source is deferred.
- Overflow policy (v1.1 §4.3) is enforced **in the engine**, surfaced as a typed `MergeOverflowError` (reject policy) or a clipped render + `DegradationNotice` (clip policy); the UI shows this against the offending field before confirm. The host does not implement validation — it displays the engine's verdict (single source of truth).

---

## 5. Where the bake happens (and why there)
- The bake (diagram → v1.1 contract) runs in the **Electron renderer**, using the mxGraph view already loaded in the app — the only place the fully-computed view state exists. This keeps the **engine ignorant of draw.io** (INV-1): the engine receives a finished contract file, never a diagram.
- This is the **deferred exporter** (`PRINT_ENGINE_SPEC_v1.1.md` §1.2). This integration spec does NOT implement it; it specifies the *interface*: renderer produces a v1.1-schema-valid file and hands main a `contractRef`. Building the exporter is a separate, still-deferred workstream.
- **Flagged tradeoff (yours to weigh):** locating bake in the renderer means the renderer owns producing a schema-valid contract — real JS work, still deferred. Until the exporter exists, the host integration and Print Native UI are fully buildable and testable **now** using hand-authored / fixture-built contract files (the v1.1 §7 synthetic fixtures) fed through the same `contractRef` path, with the real bake slotting in later with zero protocol change. Recommended sequencing.

---

## 6. Temp contract-file handling (regulated context)
- The contract file may contain full label content (potentially product/lot-identifying). Treat as sensitive: per-job temp path with restrictive ACLs; never world-readable; never log its contents.
- **Lifecycle owned by main (single owner).** Engine reads only — never writes or deletes it. Deletion sequence (resolves the v1.0 mid-read race): main deletes the temp file only after the engine returns the op result **and** main has received `Released {}` for that `contractRef` (`ReleaseContract`, §3.3). On a cancelled/aborted job, main still issues `ReleaseContract` and waits for `Released {}` (or the engine's exit) before deleting — never deletes a file the engine may still hold open.
- Path-passing is preferred for non-trivial contracts (avoids large frames/double-buffering). Inline bytes only for small contracts. Either way the engine fully validates (§3.5).

---

## 7. Audit / job log (regulated callout — design hook now)
- Regulated medical-device labeling typically requires a record of what was printed, when, with which merged values, on which device, with what notices/outcome. `PrintResult.jobLog` is a structured record: job id, contract schema version, engine version, printer id, stock id, copies, merged field keys, merged values *subject to the redaction policy below*, every DegradationNotice, typed outcome, timestamps.
- This spec defines the **hook and shape**, not the retention/format/redaction policy — that is a compliance decision (boss/QA), like the IQ/OQ workstream (v2.0 §6.2). Redaction of merged values in the log (some may be controlled data) is a compliance question to resolve before production, not an engineering default. Until that decision exists, the engine emits merged values into the jobLog **only behind an explicit, default-off redaction flag** so the unsafe default cannot ship by omission.
- Loud-fail-consistent: where compliance requires the record, a failure to produce/persist the job log is itself a typed error (`EngineInternalError` with a jobLog-failure detail), not a silent omission.

---

## 8. Engine process lifecycle (owned by main)
- **Long-lived, lazy-started:** engine spawned by main on first native-print use (or app start), kept warm (avoids per-job spawn latency and repeated GDI+ init). One engine instance per app instance.
- **Handshake:** main sends `Hello` before any other op (§3.2); refuses to proceed on `ProtoVersionError` (loud, surfaced).
- **Health:** main periodically sends `Ping` (§3.3); no `Pong` within a timeout ⇒ treat as crashed.
- **Crash handling:** engine exit/crash detected by main (child exit / broken pipe / ping timeout). Main: surface a loud typed error to any in-flight UI operation ("print engine stopped — job NOT printed"); do **not** silently retry a `Print` (a regulated print must not be ambiguously re-issued); auto-restart the engine for *subsequent* operations; never mask a crash as success. A crash during `Print` is reported as a failed job of **unknown completion state** — explicitly — so the operator physically verifies the printer rather than assuming.
- **Shutdown:** main sends `Shutdown`; on `ShutdownAck` or after a grace timeout, force-kills; then cleans temp files (§6) after confirming no engine handle remains.
- **Single-flight & busy:** one `Print` at a time (§3.4); `RenderPreview` during `Print` ⇒ `EngineBusyError`; `Ping` always allowed.

---

## 9. How this preserves the spec set's invariants
- **INV-1 (immune boundary):** engine has no Node/Electron/draw.io dependency; its sole interface is the versioned protocol with exactly one client (main). v1.1 §8.5 dependency-direction test extends to: engine repo build has no host dependency; the engine's protocol-adapter layer contains no draw.io concepts.
- **INV-3 discipline replicated at the IPC layer:** unknown protocol major ⇒ loud refusal; handshake ordering defined; the file's schema version independently gated. Two version gates, both loud.
- **INV-5 (preview = print):** operator preview is the *same* P1–P6 pipeline as print, only sink+DPI differ; `RenderPreview` and `Print` share the engine path. What the operator approves is what prints; changing inputs re-arms acknowledgment (flow step 6).
- **Loud-fail / loud-stub (v1.1 §11.5, v2.0 §3.3):** typed errors and DegradationNotices cross the boundary as structured data and are mandatorily displayed and acknowledged before confirm.
- **Deferred-but-seamed (v1.1 §11.4):** merge-data entry, the exporter, and barcode/SVG are wired as interfaces/seams now (UI field, `mergeData` slot, fixture-fed `contractRef`) so real implementations slot in later with zero protocol or pipeline change.

---

## 10. Build / test sequencing (TDD-consistent with v1.1 §7)
1. **Protocol contract + frame codec + version/handshake gate** first (the spine; mirrors schema-first): frozen frame codec, `Hello`/ordering/version-reject, typed-error and notice mapping. Tested with a mock engine and mock host — no Electron, no real engine.
2. **Engine-side protocol adapter:** thin layer mapping ops to existing P1–P7 entry points + the `Result` taxonomy; `Ping`/`GetCapabilities`/`GetContractFields`/`ReleaseContract` implemented. Engine still builds/tests with zero host present (INV-1). Tested against synthetic `contractRef` fixtures (v1.1 §7).
3. **Main-side IPC client + lifecycle:** spawn/health(`Ping`)/crash/restart, single-flight, `EngineBusyError`, temp-file ownership + `ReleaseContract` deletion sequence. Tested against a stub engine emitting scripted frames (crash, version mismatch, handshake-order violation, typed errors, notices).
4. **Renderer ↔ main + Print Native UI:** menu, capabilities-driven selectors, merge-field form (from `GetContractFields`), preview display, mandatory notice acknowledgment, re-preview-on-change with acknowledgment re-arm. Tested with main+stub-engine; UI test asserts the Print button stays disabled until every notice acknowledged and re-disables on input change (the safety test for flow step 5/6 and §3.7).
5. **End-to-end against fixtures:** full flow with hand-authored contract files (real bake deferred, §5). Later, the real exporter and the real engine printer-DC sink (v2.0 §5) replace fixtures/stubs with no protocol change — proving the seams held.

Every layer is independently testable with the layer below stubbed — same discipline as the engine pipeline.

---

## 11. Open items to escalate (not infer)
- Transport choice (named pipe vs stdio): implementer chooses one, documents it, does not mix. Frame format is frozen regardless (§3.1).
- Job-log retention/format and merged-value redaction policy: compliance decision (boss/QA); engine ships redaction default-off-unsafe-disabled until resolved (§7). Resolve before production, with the IQ/OQ workstream (v2.0 §6.2).
- Whether "Print Native" replaces or coexists with draw.io's existing print path (UX/product decision).
- Exporter (bake) remains a deferred workstream (spec set §1.2); this spec defines only its interface and recommends fixture-driven host-integration development until it exists.
- The `PRINT_ENGINE_SPEC_v1.1.md` §4.6 barcode-SDK representation question remains the highest-leverage pre-future-milestone escalation; unchanged by this spec.

---

## 12. Audit corrections applied (what changed and why) 
1. Removed inline "N/A here" annotation from the `RenderPreview` error list; `PrintDeviceError`-cannot-occur-in-preview is now stated cleanly in §3.6 outside the enumeration.
2. `DegradationNotice` schema corrected: `pageId` is now explicitly **optional** with defined per-kind scoping, and a structured `detail` shape is specified (v1.0 wrongly implied every notice was page-scoped).
3. Handshake ordering made **defined, not implementation-dependent**: `Hello` must be first; pre-handshake ops ⇒ `ProtoHandshakeError` (§3.2/§3.4).
4. Ambiguous "§2.5"-style cross-references replaced throughout with explicit "flow step N" vs "§N" terminology (header note + §3.7/§10).
5. Added an explicit **frozen-frame-format** statement (§3.1) resolving the handshake chicken-and-egg (a frame must always be parseable to read `Hello`).
6. Replaced non-ASCII wire field names `wμm`/`hμm` with ASCII `widthMicrons`/`heightMicrons` (§3.3) — interoperability hazard removed.
7. Added the missing `GetContractFields` operation to the §3.3 operation list (it was used in §4/§10 but never defined).
8. Added the missing `Ping`/`Pong` operation (health check referenced in §8 but undefined).
9. Reconciled flow step 4 wording with the protocol: preview image is a correlated `0x02` frame referenced by `imageStreamId`, consistently described in §2 and §3.3.
10. Tightened base64 guidance (§3.1): base64 for image payloads is **not** an accepted alternative (was vaguely "documented fallback").
11. Added the temp-file **mid-read deletion race** fix: `ReleaseContract`/`Released {}` handshake before main deletes (§3.3/§6/flow step 8).
12. Defined `RenderPreview`-during-`Print` behavior: `EngineBusyError` (§3.4) — concurrency was previously unspecified.
13. Removed parenthetical commentary embedded inside the error enumeration; commentary moved to §3.6 notes (same anti-pattern as item 1).
14. Job-log redaction: specified a default-off-unsafe behavior so an unset compliance policy cannot silently ship merged values (§7).

## 13. Changelog
- **v1.1** — audit corrections per §12. No architectural change: topology, the subprocess decision, the versioned protocol, the UI flow, and invariant preservation are unchanged from v1.0. All edits are protocol-completeness, schema-correctness, ordering-definedness, cross-reference precision, and one regulated-default safety fix.
- **v1.0** — initial host integration spec.
