# Windows UI Automation (UIA) Feasibility Analysis

## 1. Executive Summary & Core Verdict

**Can ReadBridge reliably track text closely enough across ordinary Windows applications to make the original source application feel like it is reading aloud?**

**YES.** Empirical investigation and runtime testing confirm that Windows UI Automation (COM `IUIAutomation8` / `TextPattern`) provides exact physical sub-pixel bounding rectangles for individual words across major desktop frameworks (Win32 RichEdit, modern WinUI/XAML, Chromium/Electron Monaco Editor), subject to four critical requirements:

1. **Whitespace Endpoint Arithmetic**: `TextUnit.Word` in UI Automation includes trailing whitespace (e.g. `"quick "` is one word). The range `End` endpoint must be shifted backward by the trailing whitespace count (`MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, -trailingCount)`) to isolate visible glyph bounds.
2. **Multi-Rect Handling**: Words or phrases spanning soft line breaks return multiple contiguous bounding boxes in `GetBoundingRectangles()`. The overlay renderer must support multi-box rendering.
3. **Per-Monitor DPI v2 Coordinate Mapping**: All coordinates extracted from UI Automation are in physical screen pixels. The overlay must declare `PerMonitorV2` in its application manifest.
4. **Degradation to Level C (Owned Reader Surface)**: When text is virtualized, unrendered, or obscured by modal dialogs, narration gracefully shifts to an owned typography surface without halting speech.

---

## 2. Claim Reconciliation & Evidence Classification

To maintain scientific rigor, all technical claims are classified into explicit evidence tiers:

### Tier 1: Proven by Committed Code & Runtime Execution
* **UIA TextPattern Crawler**: `UiaEngine.cs` successfully identifies `TextPattern` elements across top-level and descendant HWNDs.
* **Whitespace Trimming**: `TextRangeNavigator.cs` accurately trims trailing spaces/tabs, preventing highlight gaps.
* **Non-Activating Click-Through Overlay**: `HighlightOverlayWindow.cs` combines `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST` with `WM_MOUSEACTIVATE -> MA_NOACTIVATE` and `WM_NCHITTEST -> HTTRANSPARENT`. Mouse clicks pass through seamlessly to the underlying application.
* **Window Movement Tracking**: `WindowTracker.cs` attaches out-of-context `SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE)` filtered to the target process ID, keeping highlights synchronized when the window is dragged or resized.
* **Capture Exclusion**: `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` prevents highlight boxes from appearing in screen capture / OCR loops.
* **Authoritative Controller & State Machine**: `ReaderStateMachine.ts` and `ReaderController.ts` enforce strict session tokens (`playbackSessionId`), preventing stale asynchronous callbacks from corrupting playback.

### Tier 2: Verified by Official Documentation (2026)
* **Cartesia Sonic-3.5 API**: WebSocket endpoint `wss://api.cartesia.ai/tts/websocket` delivers native `word_timestamps` alongside PCM audio with `context_id` multiplexing and `{"cancel": true}` interruption.
* **ElevenLabs WebSocket Streaming**: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input` provides character-level alignment arrays (`charStartTimesMs`, `charsDurationsMs`) convertible to word bounds, with ephemeral single-use client tokens (`/v1/single-use-token`).
* **OpenAI Audio Speech**: `/v1/audio/speech` provides opaque binary audio streams without word alignment timestamps, confirming that OpenAI requires Level C Reader Fallback.

### Tier 3: Architecture Prototypes & Simulators (Implemented for Contract Testing)
* **TypeScript TTS Providers (`src/core/tts/providers/`)**: `SimulatedCartesiaTtsProvider`, `SimulatedElevenLabsTtsProvider`, and `SimulatedOpenAiTtsProvider` emulate the streaming alignment contracts in-memory to test the state machine. Live network WebSocket streaming will be implemented in Slice 2.
* **TypeScript Source Adapters (`src/adapters/`)**: `WindowsUiAutomationAdapter` and `BrowserDomAdapter` prototype capability negotiation and state routing.

### Tier 4: Limitations & Next-Slice Scope (Unproven on Mixed Hardware)
* **Mixed-DPI Multi-Monitor Setups**: In the prototype, a single WPF overlay covers `VirtualScreen`. On heterogeneous multi-monitor setups (e.g. 100% on primary, 175% on secondary), WPF's single-DPI window context can distort non-primary monitor coordinates. Production Slice 3 will use per-monitor overlay instances or DirectComposition.

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

---

## 4. Exact Conditions Triggering Level C Reader Fallback

ReadBridge automatically switches from `SOURCE_OVERLAY` to `READER_SURFACE` mode when:
1. **No UIA TextPattern**: The target control is a custom canvas, game, or non-accessible surface.
2. **Virtualized Off-Screen Text**: In virtualized document readers (e.g., long PDFs or web pages with `content-visibility: auto`), non-rendered text ranges return empty bounding rectangles (`double[0]`).
3. **Modal Dialog Occlusion**: An uncooperative modal dialog (e.g. `#32770` prompt) blocks access to the document window.
4. **TTS Provider Lacks Timestamps**: When a provider (such as standard OpenAI `tts-1`) returns opaque audio without word timing metadata.
