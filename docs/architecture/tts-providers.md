# TTS Provider Architecture & Protocol Specifications

> **Status.** The providers shipped in `src/core/tts/providers/` are in-memory simulators
> (`SimulatedCartesiaTtsProvider`, `SimulatedElevenLabsTtsProvider`, `SimulatedOpenAiTtsProvider`).
> No WebSocket is opened and no network call is made anywhere in this slice; the simulators derive
> word timings by splitting text on whitespace, and emit a fixed placeholder audio buffer rather
> than speech. Audio *playback* is now real (see [`audio-playback.md`](audio-playback.md)) — what it
> plays is simulator output, not synthesized speech.
>
> Everything below is a **specification for Slice 2**,
> transcribed from vendor documentation without a citation or retrieval date and **not** observed
> traffic. Re-verify against live vendor docs before implementing.

## 0. Output flow control (IMPLEMENTED, provider-neutral)

> Unlike the rest of this document, this section describes **shipped, tested behaviour**, not a
> specification. Runtime record:
> [`../evidence/tts-flow-control-runtime.json`](../evidence/tts-flow-control-runtime.json).

`ITtsStreamSession` requires every provider to be able to stop and restart the delivery of its own
stream output:

```typescript
readonly outputFlowState: 'running' | 'suspended' | 'terminal';
suspendOutput(): Promise<TtsFlowControlResult>;
resumeOutput(): Promise<TtsFlowControlResult>;
```

This exists because `ReaderController.pause()` pauses a real audio device. A provider that keeps
producing into a paused device fills a bounded playback queue and eventually has its audio refused,
which ends a perfectly valid read. Suspending the provider makes pause duration independent of that
queue: a five-second pause and a five-minute pause are the same.

**Required semantics.**

* **Quiescence is the contract.** Once `suspendOutput()` *resolves*, no further audio chunk and no
  further word alignment may be delivered for that session until `resumeOutput()`. One
  already-started delivery may complete before it resolves; none may complete after.
* **Audio and alignments are gated together.** Alignments that kept flowing during a pause would
  advance the highlight past speech nobody is hearing. There is deliberately no second, independent
  alignment pause state.
* **Resume continues, it does not restart.** Delivery resumes at the next unconsumed item of the
  same session — no duplicate, no skip, no restart from the top of the document, and the same
  `sessionId` throughout.
* **Flow control is not cancellation.** The session, its input and its position all survive.
* **Idempotent and named.** Outcomes are `suspended` / `alreadySuspended` / `resumed` /
  `alreadyRunning` / `terminal` / `failed`. `terminal` reports `ok: true` — a finished or cancelled
  session has nothing left to gate — while `failed` is the only `ok: false`.
* **`cancel()` must wake every waiter.** A producer blocked on a suspended gate, or a
  `suspendOutput()` awaiting quiescence, must never survive its session's cancellation.
* **A new session always starts `running`.** Flow state is scoped to one stream session and can
  never be inherited by its replacement.

**Implementation.** [`src/core/tts/output-gate.ts`](../../src/core/tts/output-gate.ts) provides
`TtsOutputGate`, which all three shipped simulators use: a producer hands each emission to
`deliver()`, which blocks *before* emitting while suspended. Using it is optional — the evidence
harness in `scripts/run_flow_control_runtime_checks.js` implements the contract from scratch in
plain JavaScript, which is how provider-neutrality is demonstrated rather than asserted.

**For the live cloud clients in §4**, the contract says nothing about transport. Each provider must
choose an appropriate mechanism — pausing socket reads, buffering internally behind the gate, or a
protocol-level flow-control message — and must satisfy the quiescence and exact-continuation rules
above. **No cloud provider's ability to do this has been demonstrated**; only the in-repo providers
and the evidence harness's provider have been.

---

## 1. Provider Comparison Matrix (from vendor documentation — uncited)

| Feature / Dimension | Cartesia Sonic-3.5 | ElevenLabs (Flash v2.5 / Turbo v2.5) | OpenAI Audio Speech (`tts-1`) |
| :--- | :--- | :--- | :--- |
| **Model Family** | `sonic-3.5`, `sonic-3.6` | `eleven_flash_v2_5`, `eleven_turbo_v2_5` | `tts-1`, `tts-1-hd` |
| **Protocol** | Bidirectional WebSocket (`/tts/websocket`) | Bidirectional WebSocket (`/stream-input`) | HTTP POST (`/v1/audio/speech`) |
| **Word Alignment Timestamps** | **Native first-class `word_timestamps` array** | Character alignment arrays (`charStartTimesMs`, `charsDurationsMs`) | **None** (Opaque binary audio body) |
| **Context Multiplexing** | Unlimited streams via `context_id` | Up to 5 concurrent streams | None (1 HTTP request = 1 stream) |
| **Cancellation** | Send `{"context_id": "...", "cancel": true}` | Send `close_context` message | Abort TCP connection |
| **Client Token Security** | API Key / Ephemeral token proxy | `POST /v1/single-use-token` ephemeral tokens | API Key |
| **ReadBridge Plan (Slice 2)** | **Planned primary provider (Level A & B)** | **Planned secondary / high-emotion (Level A & B)** | **Planned fallback (Level C only)** |

---

## 2. Cartesia WebSocket (REVALIDATED against the official reference, 2026-09-02)

> Unlike the rest of this document, this section was checked against
> <https://docs.cartesia.ai/api-reference/tts/tts> on 2026-09-02 rather than transcribed
> from memory. **Two facts the earlier draft asserted were wrong**, and one mechanism it
> did not know about turns out to matter for flow control. Still specification, not
> observed traffic: no live call has been made.

* **Endpoint**: `wss://api.cartesia.ai/tts/websocket`
* **Version**: a `cartesia_version` **query parameter** (e.g. `2026-08-14`) — **not** the
  `Cartesia-Version: 2024-06-10` *header* this document previously claimed.
* **Auth**: `X-API-Key` header, or an `access_token` query parameter. Never hardcoded, never
  logged, never committed — injected from environment or config at construction.
* **Models**: `sonic-3.6`, `sonic-3.5`, `sonic-3`, `sonic-latest`. The earlier draft named
  `sonic-3.5` and `sonic-3.6`; both are still valid, and `sonic-3` and `sonic-latest` were
  not listed before.
* **Encodings**: `pcm_f32le`, `pcm_s16le`, `pcm_mulaw`, `pcm_alaw`, container `raw` only.
  Sample rates 8000 / 16000 / 22050 / 24000 / 44100 / 48000. ReadBridge's playback session
  currently accepts PCM matching its opening format, so `pcm_s16le` at 24000 is the
  natural pairing.

### Request

```json
{
  "model_id": "sonic-3.6",
  "transcript": "Hello, world! ",
  "voice": { "mode": "id", "id": "<voice-id>" },
  "output_format": { "container": "raw", "encoding": "pcm_s16le", "sample_rate": 24000 },
  "context_id": "<uuid>",
  "continue": true,
  "add_timestamps": true
}
```

`flush` is also accepted, and is acknowledged by a `flush_done` carrying a `flush_id`
counter — a message type the earlier draft did not mention at all.

### Responses

| `type` | Carries |
| :--- | :--- |
| `chunk` | `data` (**base64** audio), `done`, `status_code`, `step_time`, `context_id` |
| `timestamps` | `word_timestamps: { words[], start[], end[] }` — **times in seconds** |
| `flush_done` | `flush_id` |
| `done` | `done: true` |
| `error` | `title`, `message`, `error_code`, `status_code` |

Cancellation is `{ "context_id": "...", "cancel": true }`.

### How a Cartesia client must satisfy the RB-AF1 flow-control contract

This is the question that actually gates a live implementation, and the answer is not
obvious from the protocol.

**Cartesia pushes.** Once a transcript is sent, the server streams `chunk` and `timestamps`
messages at its own pace. There is no documented "stop sending" message, so a client
cannot satisfy `suspendOutput()` by asking the server to pause.

It must therefore satisfy it **on its own side**, in two parts:

1. **Stop feeding the server.** While suspended, send no further transcript continuation.
   This bounds how much the server will generate, because it only generates what it has
   been given.
2. **Keep reading the socket, but stop delivering.** The tail already in flight must still
   be read — refusing to read would apply TCP backpressure and eventually stall or
   time out the connection — but it must be queued in order rather than handed to
   `onAudioChunk` / `onWordAlignment`. `resumeOutput()` then drains that queue in order
   before resuming live delivery.

That satisfies the contract exactly: quiescence holds (no callback after `suspendOutput()`
resolves), continuation is exact (an ordered queue has no duplicates and no skips), and the
session identity, `context_id` and position are all preserved.

**The cost is a bounded client-side buffer**, holding whatever the server had already
generated when the suspension landed. That is finite because of (1). **This bound has not
been measured**, and measuring it is part of the live-provider slice, not this document.

**Conclusion: Cartesia can satisfy the contract cleanly.** No change to
`ITtsStreamSession`, `ReaderController` or VoiceMediaBridge is required to accommodate it.

---

## 3. ElevenLabs WebSocket Specification

* **Endpoint**: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`

### Alignment Response Payload:
```json
{
  "audio": "UklGRiQAAABXQVZFZm10IBAAAA...",
  "isFinal": false,
  "alignment": {
    "chars": ["H", "e", "l", "l", "o", " "],
    "charStartTimesMs": [0, 25, 52, 78, 104, 130],
    "charsDurationsMs": [25, 27, 26, 26, 26, 35]
  }
}
```

---

## 4. Implementation Plan for Slice 2 (Streaming Audio & Live TTS)

In Slice 2:
1. Implement live `CartesiaWebSocketClient` streaming PCM into the existing `IAudioPlaybackSink`
   seam, satisfying the §0 flow-control contract by the two-part client-side mechanism in §2.
   (The Web Audio worklet named in earlier drafts does not apply: ReadBridge has no browser host,
   and audio output lives in the Windows companion — see
   [`audio-playback.md`](audio-playback.md) §2.) Credentials are injected from environment or
   config, never hardcoded and never committed.
2. Implement live `ElevenLabsWebSocketClient` with single-use ephemeral token auth, likewise
   satisfying §0.
3. Measure live empirical round-trip latencies, buffer continuity, and audio/highlight synchronization under network jitter.
