# Empirical Compatibility Matrix & Telemetry Evidence

## Environment Context
* **Host OS**: Windows 11 Build 26100 (64-bit)
* **SDK / Toolchains**: .NET 10.0.302 SDK, Node.js v22.16.0, Yarn 1.22.22
* **DPI Mode**: Per-Monitor DPI Awareness v2
* **Test Harness**: `native/ReadBridge.Companion` (CLI `matrix-scan` & `inspect-proc`)

---

## Empirical Matrix Findings

| Application | Engine / Provider | TextPattern | TextPattern2 | Selection Capture | Document Text Extraction | Word Navigation | Bounding Rect Precision | Window Move Tracking | Recommended Capability Level |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Windows Notepad (Win11)** | `RichEditD2DPT` (Win32 in XAML shell) | **Yes** | **Yes** | Supported | Supported (Exact text) | Supported (15/15 words) | **High** (Exact Physical Glyph Bounds) | Supported via WinEvent | **LEVEL B (UI_AUTOMATION)** |
| **VS Code (Monaco Editor)** | `Chrome` Framework (`RenderWidgetHostHWND`) | **Yes** | **No** | Supported | Supported (500+ chars) | Supported (15/15 words) | **High** (Exact Physical Glyph Bounds) | Supported via WinEvent | **LEVEL B (UI_AUTOMATION)** |
| **Chromium Browsers (Chrome / Brave / Edge)** | Blink AXTree (`RenderWidgetHostHWND`) | **Yes** (after AX init) | **No** | Supported | Supported in Viewport | Supported | **High** within active viewport | Supported via WinEvent | **LEVEL A (Extension)** / **LEVEL B (UIA)** |
| **Microsoft Word (Office 16)** | `OpusApp` / `_WwG` | **Yes** | **Yes** | Supported | Supported | Supported | **High** (Multi-Rect Support) | Supported via WinEvent | **LEVEL B (Doc)** / **LEVEL C (Modals)** |
| **Digital PDF Viewers (Edge PDF)** | Chromium PDF Plugin | **Yes** | **No** | Supported | Supported (Text Layer) | Supported | **High** (Digital text layer) | Supported via WinEvent | **LEVEL B (Digital)** / **LEVEL C (Scanned)** |

---

## Detailed Application Analysis

### 1. Windows Notepad (Win11)
* **UIA Architecture**: Employs a Direct2D RichEdit control (`RichEditD2DPT`) inside a WinUI 3 XAML container.
* **Findings**: Implements both `TextPattern` (10014) and `TextPattern2` (10024). Full support for `GetCaretRange`, active selection, and document ranges.
* **Bounding Rectangles**: Subpixel precision matching physical screen coordinates.
* **Capability**: **LEVEL B (UI_AUTOMATION)**.

### 2. VS Code (Monaco Editor)
* **UIA Architecture**: Chromium Blink accessibility peer exposed via `Chrome_RenderWidgetHostHWND`.
* **Findings**: Exposes `TextPattern` with full document range and selection. `TextPattern2` is not exposed.
* **Bounding Rectangles**: High precision within the visible viewport.
* **Capability**: **LEVEL B (UI_AUTOMATION)**.

### 3. Chromium Web Browsers
* **Findings**: Blink initializes its accessibility tree on the renderer thread upon the first UIA query.
* **Recommendation**: Use **LEVEL A (Browser Extension)** for complete semantic DOM context and URL metadata; use **LEVEL B (UI Automation)** as universal zero-install fallback.
