# Compatibility Expectations (Analyst-Authored — Not Yet Runtime-Captured)

> **Status.** This document records what we *expect* Windows UI Automation to expose in each
> application, based on source analysis and the UIA API contract. **It is not scan output, and no
> scan output is committed.** `compatibility-matrix.expected.json` holds the same content in the
> shape of `ApplicationCompatibilityRecord`; several of its values cannot be produced by
> `UiaEngine.EvaluateCompatibility` under any input, which is called out in that file's header.
>
> **Evidence-collection constraint.** Do **not** run `yarn matrix:scan` against a normal live
> desktop and commit the result: it inspects every visible window of its target process set, so the
> artifact could capture information about whatever applications and browser state the operator had
> open. UIA runtime evidence is to be collected only in a **controlled test environment** with
> deliberately opened applications and documents, with the raw output inspected before commit.
>
> The absence of that artifact is **accepted** for this feasibility slice (PR #1). That acceptance
> is a collection constraint — it is **not** evidence that UIA runtime behaviour was proven. The
> only runtime evidence committed in this slice is `companion-lifecycle-runtime.json` (process
> lifecycle, not UIA behaviour).

## Environment Context

* **Host OS**: Windows 11, Build 26200.9168 (64-bit)
* **SDK / Toolchains**: .NET 10.0.302 SDK, Node.js v22.16.0, Yarn 1.22.22
* **DPI Mode**: `PerMonitorV2` declared in `native/ReadBridge.Companion/app.manifest` (declaration, not a measurement)
* **Intended Harness**: `native/ReadBridge.Companion` (CLI `matrix-scan` and `inspect-proc`)

Two caveats about the harness apply to every row below:

* Word enumeration stops at `UiaEngine.WordSampleCap` (15) and document text is read through a
  `UiaEngine.DocumentTextProbeChars` (500) probe. Any "N words" or "N chars" figure the scanner
  emits is **the cap being reached, not coverage**.
* `matrix-scan` only inspects processes named `notepad`, `code`, `chrome`, `brave`, `msedge`,
  `winword`, `discord`, `slack`. Acrobat Reader (`AcroRd32`) is **not reachable** by it.

---

## Expected Capability Matrix

Every cell is an expectation. Nothing in this table has been measured.

| Application | Engine / Provider | TextPattern | TextPattern2 | Selection Capture | Document Text Extraction | Word Navigation | Bounding Rects | Window Move Tracking | Expected Capability Level |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Windows Notepad (Win11)** | `RichEditD2DPT` (Win32 in XAML shell) | Expected Yes | Expected Yes | Expected | Expected | Expected (sampled, capped at 15) | Expected High — accuracy not measured | Hook available; **re-resolution not wired** | **LEVEL B (UI_AUTOMATION)** |
| **VS Code (Monaco Editor)** | `Chrome` Framework (`RenderWidgetHostHWND`) | Expected Yes | Expected No | Expected | Expected (500-char probe cap) | Expected (sampled, capped at 15) | Expected High — accuracy not measured | Hook available; **re-resolution not wired** | **LEVEL B (UI_AUTOMATION)** |
| **Chromium Browsers (Chrome / Brave / Edge)** | Blink AXTree (`RenderWidgetHostHWND`) | Expected Yes (after AX init) | Expected No | Expected | Expected in viewport | Expected | Expected High within active viewport | Hook available; **re-resolution not wired** | **LEVEL A (Extension)** / **LEVEL B (UIA)** |
| **Microsoft Word (Office 16)** | `OpusApp` / `_WwG` | Expected Yes | Expected Yes | Expected | Expected | Expected | Expected High (multi-rect) | Hook available; **re-resolution not wired** | **LEVEL B (Doc)** / **LEVEL C (Modals)** |
| **Digital PDF Viewers (Edge PDF)** | Chromium PDF Plugin | Expected Yes | Expected No | Expected | Expected (text layer) | Expected | Expected High (digital text layer) | Hook available; **re-resolution not wired** | **LEVEL B (Digital)** / **LEVEL C (Scanned)** |

The **LEVEL A** recommendation is a product decision about where to source text, not something the
scanner can emit: `EvaluateCompatibility` has only `LEVEL B` and `LEVEL C` branches.

---

## Per-Application Notes (expectations and open questions)

### 1. Windows Notepad (Win11)
* **Expected UIA architecture**: a Direct2D RichEdit control (`RichEditD2DPT`) inside a WinUI 3 XAML container.
* **To confirm**: that both `TextPattern` (10014) and `TextPattern2` (10024) are exposed, and that document and selection ranges behave as expected. `GetCaretRange` is **not** exercised anywhere in this repo.
* **Bounding rectangles**: expected to be physical screen coordinates. Sub-pixel accuracy is **not measured** — the scanner only records whether a sampled word returned any rectangle.

### 2. VS Code (Monaco Editor)
* **Expected UIA architecture**: Chromium Blink accessibility peer exposed via `Chrome_RenderWidgetHostHWND`.
* **To confirm**: `TextPattern` with document range and selection; `TextPattern2` expected absent.

### 3. Chromium Web Browsers
* **Expectation**: Blink initializes its accessibility tree on the renderer thread on first UIA query, so an initial query or interaction may be needed before text is available. *(Domain expectation — not observed here.)*
* **Recommendation**: prefer **LEVEL A (browser extension)** for full semantic DOM context and URL metadata; use **LEVEL B (UI Automation)** as the zero-install universal fallback.

### 4. Microsoft Word / PDF viewers
* Modal dialogs (`#32770`) and scanned bitmap PDFs are the expected Level C triggers. Note that
  neither empty-bounds nor modal-occlusion detection is implemented yet (see feasibility §4b), and
  no committed script opens a PDF or launches Acrobat.
