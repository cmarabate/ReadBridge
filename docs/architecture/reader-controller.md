# ReaderController & Playback State Machine Architecture

## 1. Single Authority Principle

All playback state, text acquisition, synchronization, audio routing, and visual highlighting are owned by a single authority: `ReaderController`.

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
                    │  stopping   │ ◄── Cleanup overlay, abort TTS session, release hooks
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │    idle     │
                    └─────────────┘
```

## 2. Session Token (`playbackSessionId`) Integrity

To eliminate race conditions in asynchronous workflows:
* Every reading invocation creates a unique `playbackSessionId` (e.g. `read-1771968800000-a7b9c`).
* All downstream callbacks (TTS audio chunks, word alignment events, geometry evaluations, prefetch tasks) carry this `sessionId`.
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
