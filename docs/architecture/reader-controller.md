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
* `playing` → `paused` happens only after the output has reported that it paused. A refused pause
  throws and leaves the state at `playing`, which is the truth.
* `paused` → `playing` uses the **same** playback session and the same read `sessionId`; no new TTS
  session is created, the document is not re-acquired, and `canonicalTextOffset` is not reset.
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
  lastObservedPlaybackPositionMs: number;
  producesAudibleOutput: boolean;
  error: string | null;
}
```

`producesAudibleOutput` reports whether the configured sink drives a real device, so a consumer can
never mistake `SimulatedAudioPlaybackSink` for one that makes sound.
`lastObservedPlaybackPositionMs` is the last cursor the controller observed, not a live probe.

No component outside `ReaderController` maintains independent state booleans (`isPlaying`, `isPaused`, `isHighlighting`).

## 4. Session fencing across two tokens

`ReaderStateMachine.sessionId` is deliberately retained across `stop()` so the machine can report
which read reached idle. That means it alone would still admit a callback from a read that has
already ended, so `ReaderController` also holds `activeReadSessionId`, cleared the moment a read
ends, and fences every callback on **both** tokens. The playback session id is the same string, so
playback ownership and read ownership cannot drift apart.

## 5. Audio-focus seam

`suspendForAudioFocusAsync()` / `resumeForAudioFocusAsync()` are a narrow internal entry point for a
future external audio-focus arbiter. They delegate to the same `pause()` / `resume()` path, add no
second pause mechanism, and report whether output is genuinely suspended or playing. Nothing is
connected to them; there is no VoiceMediaBridge code in this repository.
