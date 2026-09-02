# ReaderController & Playback State Machine Architecture

## 1. Single Authority Principle

All playback state, text acquisition, synchronization, and visual highlighting are owned by a single authority: `ReaderController`.

Audio output is real. `ReaderController` drives an `IAudioPlaybackSession` whose `pause` and
`resume` suspend and restore an actual Windows audio device, and its `playing` / `paused` states
are confirmed against that output rather than asserted. The playback contract, the backend, and
what is and is not proven about it are in
[`audio-playback.md`](audio-playback.md). Live cloud TTS is still not implemented: the providers
remain simulators, so the audio being played is simulator-produced.

```
                    ┌─────────────────────────┐
                    │          idle           │
                    └────────────┬────────────┘
                                 │ startRead(source)
                                 ▼
                    ┌─────────────────────────┐
                    │        acquiring        │ ◄── Fetch selection / document text & capabilities
                    └────────────┬────────────┘
                                 │ text acquired
                                 ▼
                    ┌─────────────────────────┐
                    │        preparing        │ ◄── Initialize TTS stream & parse sentence boundaries
                    └────────────┬────────────┘
                                 │ playback session ACCEPTED audio
                                 ▼
                    ┌─────────────────────────┐
       ┌───────────►│         playing         │◄──────────┐
       │            └──────┬───────────┬──────┘           │
       │                   │           │                  │
       │       pause()     │           │ seek()           │ resume()
       │                   ▼           ▼                  │
┌──────┴──────┐     ┌─────────────┐ ┌─────────────┐       │
│   paused    │     │   seeking   │ │   playing   ├───────┘
└─────────────┘     └──────┬──────┘ └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  stopping   │ ◄── Abort the TTS session, clear the active highlight
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │    idle     │
                    └─────────────┘
```

**Not shown**: the `error` state, which is reachable from every state and is covered by
`tests/state-machine.test.ts`. The `seeking` state exists in the transition table, but
`ReaderController` exposes no `seek()` method yet, so `seeking` is currently unreachable from the
controller — the `seek()` edge above is planned, not implemented. Overlay teardown and WinEvent
hook release live in the native companion, not in `ReaderController`, which holds no overlay
handle, companion client, or hook.

**The transitions above are gated on real output, not on intent:**

* `preparing` → `playing` happens when the playback session accepts audio, never merely because a
  TTS stream object exists.
* `playing` → `paused` happens only after **both** upstream TTS output has gone quiescent and the
  device has reported that it paused. A refusal at either layer throws, rolls the other layer
  back, and leaves the state at `playing`, which is the truth.
* `paused` → `playing` restores upstream output and the **same** playback session, under the same
  read `sessionId`; no new TTS session is created, the document is not re-acquired, and
  `canonicalTextOffset` is not reset.
* `playing` → `idle` on its own happens when the **audio output drains**. A TTS stream's `isFinal`
  means its input ended; it calls `completeInput()` on the playback session and nothing more.

## 2. Session Token (`sessionId`) Integrity

To eliminate race conditions in asynchronous workflows:
* Every reading invocation creates a unique session id (e.g. `read-1771968800000-a7b9c`), exposed as `sessionId` on the state machine and on the snapshot.
* All downstream callbacks (TTS audio chunks, word alignment events, geometry evaluations) carry this `sessionId`.
* If a callback arrives with a mismatched or stale `sessionId`, it is immediately discarded:

```typescript
if (this.stateMachine.sessionId !== sessionId) {
  return; // Discard stale asynchronous callback
}
```

## 3. Playback State Snapshot

The complete system state is exposed to the UI via an immutable snapshot:

```typescript
export interface PlaybackStateSnapshot {
  sessionId: string;
  state: ReaderLifecycleState;
  sourceIdentity: TextSourceIdentity | null;
  documentTitle: string | null;
  totalCharacters: number;
  canonicalTextOffset: number;
  currentSentenceIndex: number;
  currentWord: string | null;
  activeGeometry: TextRangeGeometry | null;
  followMode: 'SOURCE_OVERLAY' | 'READER_SURFACE';
  playbackSessionId: string | null;
  playbackState: PlaybackSessionState | null;
  ttsOutputState: TtsOutputFlowState | null;
  lastObservedPlaybackPositionMs: number;
  producesAudibleOutput: boolean;
  error: string | null;
}
```

`producesAudibleOutput` reports whether the configured sink drives a real device, so a consumer can
never mistake `SimulatedAudioPlaybackSink` for one that makes sound.
`lastObservedPlaybackPositionMs` is the last cursor the controller observed, not a live probe.
`ttsOutputState` reports whether the current stream is still delivering output — `suspended` means a
pause has quiesced the producer, not merely the device.

No component outside `ReaderController` maintains independent state booleans (`isPlaying`, `isPaused`, `isHighlighting`).

## 4. Session fencing across two tokens

`ReaderStateMachine.sessionId` is deliberately retained across `stop()` so the machine can report
which read reached idle. That means it alone would still admit a callback from a read that has
already ended, so `ReaderController` also holds `activeReadSessionId`, cleared the moment a read
ends, and fences every callback on **both** tokens. The playback session id is the same string, so
playback ownership and read ownership cannot drift apart.

## 5. The pause/resume transaction (RB-AF1)

Pausing a read means stopping two things: the audio device, and the provider that feeds it.
Doing only the first is what let a long pause fill the playback queue and end a valid read.

**Pause** — upstream first, because pausing a device the provider keeps feeding is the failure being
removed:

1. identify the exact current read, TTS stream and playback session;
2. `suspendOutput()` on the stream, and await **quiescence** — once it resolves no further audio
   chunk or alignment can be delivered;
3. drain the audio pump, which the quiesced gate can no longer extend;
4. `pause()` the exact playback session and confirm it reported `paused`;
5. only then transition to `paused`.

**Resume** — upstream first again, because audio that cannot be refilled should not start draining:

1. verify the same read is still paused;
2. `resumeOutput()` on the same stream;
3. `resume()` the same playback session and confirm it reported `playing`;
4. only then transition to `playing`.

**Rollback.** Neither half is left applied on its own:

| Failure | Result |
| :--- | :--- |
| upstream suspend fails | the device is never touched; reader stays `playing`; throws |
| playback pause fails | upstream is resumed back to running; reader stays `playing`; throws |
| upstream resume fails | the device stays paused; reader stays `paused`; throws |
| playback resume fails | upstream is re-suspended; reader stays `paused`; throws |

Rollback only undoes what *this* call did: an `alreadySuspended` or `terminal` outcome is not
rolled back, because this call is not what caused it. Output the provider generates during a
resume rollback is bounded by the playback queue cap.

**Production runs in the background.** A suspended output gate blocks its producer, so `startRead`
streams text in a background task and awaits only the truthful start boundary — the playback
session accepting audio. Awaiting the whole stream would strand the caller behind a pause.

## 6. Audio-focus seam

`suspendForAudioFocusAsync()` / `resumeForAudioFocusAsync()` are a narrow internal entry point for a
future external audio-focus arbiter. They delegate to the same `pause()` / `resume()` transaction in
§5 — including its upstream flow control and its rollback — and add no second pause mechanism. A
user pause and a focus pause are therefore the same production path, and
`resumeForAudioFocusAsync()` still refuses to resume a pause it did not cause. Nothing is connected
to them; there is no VoiceMediaBridge code in this repository.
