# ReaderController & Playback State Machine Architecture

## 1. Single Authority Principle

All playback state, text acquisition, synchronization, and visual highlighting are owned by a single authority: `ReaderController`. (Audio output routing is Slice 2 scope: the simulated providers emit placeholder buffers and nothing plays them.)

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
                                 │ audio ready / first chunk
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
  error: string | null;
}
```

No component outside `ReaderController` maintains independent state booleans (`isPlaying`, `isPaused`, `isHighlighting`).
