# Windows UI Automation (UIA) Feasibility Analysis

## 1. Executive Summary & Core Verdict

**Can ReadBridge reliably track text closely enough across ordinary Windows applications to make the original source application feel like it is reading aloud?**

**PROBABLY YES — but this slice has not yet proven it end to end.** Source analysis and the UI Automation API contract indicate that Windows UI Automation (COM `IUIAutomation8` / `TextPattern`) can supply physical screen bounding rectangles for individual words across major desktop frameworks (Win32 RichEdit, modern WinUI/XAML, Chromium/Electron Monaco Editor). What this slice actually establishes, and what it does not, is set out claim by claim in §2 — read that before relying on the verdict.

The mechanism depends on four requirements, all of which are implemented in committed code:

1. **Whitespace Endpoint Arithmetic**: `TextUnit.Word` in UI Automation includes trailing whitespace (e.g. `"quick "` is one word). The range `End` endpoint must be shifted backward by the trailing whitespace count (`MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, -trailingCount)`) to isolate visible glyph bounds.
2. **Multi-Rect Handling**: Words or phrases spanning soft line breaks return multiple contiguous bounding boxes in `GetBoundingRectangles()`. The overlay renderer must support multi-box rendering.
3. **Per-Monitor DPI v2 Coordinate Mapping**: All coordinates extracted from UI Automation are in physical screen pixels. The overlay must declare `PerMonitorV2` in its application manifest.
4. **Degradation to Level C (Owned Reader Surface)**: When text is virtualized, unrendered, or obscured by modal dialogs, narration should shift to an owned typography surface without halting speech. Only part of this is implemented today — see §4.

---

## 2. Claim Reconciliation & Evidence Classification

Claims are classified by **what actually backs them**, not by how confident they feel. The tiers below deliberately keep "the code does X" separate from "we watched X happen", because this slice has captured runtime evidence for process lifecycle only.

### Tier 1: Implemented in Committed Code (mechanism reviewed; UIA runtime not captured)

* **UIA TextPattern Crawler**: `UiaEngine.cs` implements `TextPattern` / `TextPattern2` discovery over top-level and descendant elements, with a `RawViewWalker` fallback for lazily-created providers.
* **Whitespace Trimming**: `TextRangeNavigator.cs` shifts the End endpoint back by the trailing-whitespace count, falling back to the untrimmed range when a provider rejects the endpoint move.
* **Non-Activating Click-Through Overlay**: `HighlightOverlayWindow.cs` sets `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST` and answers `WM_MOUSEACTIVATE -> MA_NOACTIVATE` and `WM_NCHITTEST -> HTTRANSPARENT`. These are the documented mechanism for click-through; **pass-through has not been observed under test.**
* **Capture Exclusion**: `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` is *called* on the overlay HWND. The return value is not checked, so this slice shows the call is attempted, not that exclusion took effect.
* **Authoritative Controller & State Machine**: `src/core/state-machine.ts` and `src/core/reader-controller.ts` enforce session tokens (`sessionId`), discarding stale asynchronous callbacks. Covered by `tests/state-machine.test.ts` and `tests/reader-controller.test.ts`.

### Tier 1b: Proven by Committed Runtime Evidence

* **Companion process lifecycle**: `docs/evidence/companion-lifecycle-runtime.json` is the recorded output of `scripts/run_lifecycle_runtime_checks.js`, observed against real OS process state. It covers startup, the request/response path, overlay show/clear, cancellation, graceful shutdown, five repeated start/stop cycles, and the `--parent-pid` watchdog under host force-kill — including an A/B control that reproduces a genuine orphan when the flag is absent. Reproduce with `yarn evidence:lifecycle`.

### Tier 2: Vendor-Documentation Claims (uncited — re-verify against live docs before relying on these)

These describe third-party APIs. No citation, retrieval date, or captured response is committed, and no live call is made anywhere in this slice.

* **Cartesia Sonic-3.5 API**: WebSocket endpoint `wss://api.cartesia.ai/tts/websocket` reported to deliver native `word_timestamps` alongside PCM audio with `context_id` multiplexing and `{"cancel": true}` interruption.
* **ElevenLabs WebSocket Streaming**: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input` reported to provide character-level alignment arrays (`charStartTimesMs`, `charsDurationsMs`) convertible to word bounds, with ephemeral single-use client tokens (`/v1/single-use-token`).
* **OpenAI Audio Speech**: `/v1/audio/speech` reported to provide opaque binary audio streams without word alignment timestamps — the basis for routing OpenAI to the Level C Reader Fallback.

### Tier 3: Architecture Prototypes & Simulators (Implemented for Contract Testing)

* **TypeScript TTS Providers (`src/core/tts/providers/`)**: `SimulatedCartesiaTtsProvider`, `SimulatedElevenLabsTtsProvider`, and `SimulatedOpenAiTtsProvider` emulate the streaming alignment contracts in-memory to test the state machine. They open no network connection and emit placeholder audio buffers. Live streaming is Slice 2.
* **TypeScript Source Adapters (`src/adapters/`)**: `WindowsUiAutomationAdapter` and `BrowserDomAdapter` prototype capability negotiation and state routing against in-memory fixtures. Neither is wired to the companion or to a browser extension.

### Tier 4: Known Gaps & Next-Slice Scope

* **Mixed-DPI Multi-Monitor Setups**: A single WPF overlay covers `VirtualScreen` and converts coordinates with one DPI factor taken from the window's own monitor. On heterogeneous setups (e.g. 100% primary, 175% secondary) this distorts non-primary coordinates, and the window may not actually span the virtual screen, silently clipping highlights. Production Slice 3 will use per-monitor overlay instances or DirectComposition.
* **Window movement tracking is not wired end to end.** `WindowTracker.cs` attaches an out-of-context `SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE)` filtered to the target process id, but nothing re-resolves highlight geometry from it: the only consumer is the `highlight-test` demo, whose callback just writes a console line, and the `ipc` path constructs no tracker at all. Out-of-context hooks also require the installing thread to pump messages, which that demo thread does not do. **Highlights do not currently follow a window that is dragged or resized.**
* **Sampling is capped, not exhaustive.** Word enumeration stops at `UiaEngine.WordSampleCap` (15) and document text is read through a `UiaEngine.DocumentTextProbeChars` (500) probe. Scanner output reports what was sampled; it is not full-document coverage.
* **No kernel-level lifetime backstop.** `ProcessJobTracker.cs` implements a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` tracker but is never instantiated; the guarantee is not in force. Companion lifetime rests on the `--parent-pid` watchdog plus stdin EOF. Wiring the job object requires the handle to be owned by the launching host, which is a lifecycle-architecture change rather than a patch.
* **No C# test project.** Every claim about the native companion is currently guarded only by the Node-level lifecycle checks above.

---

## 3. Capability Negotiation Model

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ LEVEL A: SOURCE_NATIVE (Highest Fidelity)                               │
│ - Source: Browser Extension (DOM Range API), VS Code Plugin             │
│ - Capabilities: Semantic DOM structure, exact layout rects, click-to-   │
│   seek, source-native viewport scrolling.                               │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ (fallback if no extension)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ LEVEL B: UI_AUTOMATION (Universal Windows Accessibility)                │
│ - Source: Windows UI Automation (IUIAutomationTextPattern / TextPattern2)│
│ - Capabilities: Foreground window text capture, word range expansion,   │
│   bounding boxes, ReadBridge click-through overlay, location tracking.  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ (fallback if geometry missing)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ LEVEL C: READER_FALLBACK (Guaranteed Narration)                         │
│ - Source: Plain text capture without stable layout geometry             │
│   (e.g., scanned PDFs, virtualized scroll lists, obscured windows).     │
│ - Capabilities: ReadBridge renders its own clean reader window and      │
│   highlights text synchronously on its owned typography surface.        │
└─────────────────────────────────────────────────────────────────────────┘
```

Level A is a design target: no browser extension or VS Code plugin exists in this slice.

---

## 4. Conditions Triggering Level C Reader Fallback

### 4a. Implemented today

`ReaderController` selects `READER_SURFACE` at session start, from the adapter's declared capabilities (`reader-controller.ts`), when:

1. **The adapter reports no word geometry**: capability level is `READER_FALLBACK`, or `supportsWordGeometry` is false — covering custom canvases, games, and non-accessible surfaces.
2. **The TTS provider lacks timestamps**: `supportsWordLevelTimestamps` is false (for example the OpenAI path).

It also degrades mid-session if `resolveRangeGeometry` **throws**.

### 4b. Planned triggers (not yet implemented)

These are design intent for Slice 3. Nothing in `src/` detects them today, and an empty geometry result is currently accepted rather than treated as a fallback signal:

3. **Virtualized off-screen text**: non-rendered ranges return empty bounding rectangles (`double[0]`) in virtualized readers (long PDFs, `content-visibility: auto`).
4. **Modal dialog occlusion**: an uncooperative modal (e.g. a `#32770` prompt) blocks access to the document window.
