# Audio Playback Session Architecture (RB-AF0)

> **Status.** The playback session described here is **implemented and proven against a real
> Windows audio device**. The decisive runtime record is
> [`docs/evidence/playback-runtime.json`](../evidence/playback-runtime.json), reproducible with
> `yarn evidence:playback`. §6 states plainly what this slice does **not** establish.

## 1. Synthesis is not playback

TTS provider authority ends at producing audio:

* synthesize text;
* stream encoded/PCM audio chunks;
* provide timing/alignment;
* cancel generation.

`ITtsProvider` and `ITtsStreamSession` are unchanged by this slice. They have no pause, no resume,
and no cursor, and they must not acquire any: a provider's `isFinal` means **its input is
finished**, never that audio was heard.

Playback authority is a separate seam, `IAudioPlaybackSink` / `IAudioPlaybackSession`
([`src/core/audio/playback-interface.ts`](../../src/core/audio/playback-interface.ts)). The
**playback session owns the output cursor**.

```
 TextSourceAdapter          ITtsStreamSession           IAudioPlaybackSession
   (text + geometry)   ->     (audio + timings)   ->      (device + cursor)
          \                          |                            /
           \                         v                           /
            +--------------  ReaderController  ----------------+
                        (single application-level authority)
```

`ReaderController` remains the single application-level playback authority. The playback session is
a *device*-level state machine underneath it, not a competing one: it never transitions
`ReaderController`, and `ReaderController` never reaches around it to touch a device.

## 2. Runtime topology, and why the backend lives where it does

ReadBridge runs as two processes and this slice did not add a third:

| Process | Owns |
| :--- | :--- |
| Node/TypeScript host | `ReaderController`, adapters, TTS providers, playback **seam** |
| `ReadBridge.Companion` (`net10.0-windows`) | UIA inspection, highlight overlay, and now audio **output** |

The companion is already the process that owns every native Windows surface, is already spawned as
a child of the host, and already speaks newline-delimited JSON over stdin/stdout. Audio output is a
native Windows surface, so it went there. Consequences: no Electron or browser host was invented
(ReadBridge has neither), no resident service was added, no second companion exists, and no new
transport was introduced — the audio methods are seven more methods on the existing IPC channel.

**Backend: WinMM `waveOut`, via P/Invoke, with no new dependency.** It is the smallest platform API
that satisfies the contract this slice needs:

* `waveOutPause` / `waveOutRestart` suspend and resume the **same open device handle** — nothing is
  reopened, requeued, or replayed, which is why the cursor continues instead of restarting;
* `waveOutGetPosition(TIME_BYTES)` is a monotonic cursor that is frozen for the whole duration of a
  pause;
* multiple `waveOutWrite` buffers queue, which is what streamed TTS needs.

Alternatives considered and rejected: `System.Media.SoundPlayer` (WAV only, no pause, no
streaming); a managed audio library such as NAudio (a dependency whose `WaveOutEvent` is a wrapper
over exactly these calls); a Node-side audio module (would need a native build step in the host,
and would put the device in the process that owns no other native surface); Web Audio (ReadBridge
has no browser host). Interop lives in
[`Infrastructure/NativeMethods.Audio.cs`](../../native/ReadBridge.Companion/Infrastructure/NativeMethods.Audio.cs),
alongside the existing user32 interop and following the same `partial class` convention.

## 3. The session contract

```
 created ──first ACCEPTED write──► playing ──pause──► paused
                                     │  ▲               │
                                     │  └────resume─────┘
                            drained  │  stop
                                     ▼    ▼
                                completed  stopped        (both terminal)
```

* **One session identity.** The playback session id **is** the `ReaderController` session id, so
  playback ownership and read ownership cannot drift apart.
* **`playing` means the output took audio.** A session is `created` until its first accepted write.
  An empty chunk is accepted but is not audio and does not start playback.
* **Pause and resume are idempotent and say so**: `alreadyPaused` / `alreadyPlaying` are returned as
  successes rather than silently reported as transitions.
* **A pause that never happened is never reported as one.** Pausing a `created` session returns
  `notStarted`, not success.
* **`completed` and `stopped` are terminal.** Resume, pause and write after either fail closed.
* **Stale sessions cannot control current playback.** The companion serves exactly one session; any
  command naming a different one is refused with `staleSession` rather than applied.
* **Teardown is bounded.** The monitor thread polls at 20 ms and `Dispose` joins it with a 2 s cap;
  `waveOutReset` → `waveOutUnprepareHeader` → `waveOutClose` is idempotent, so the device handle is
  released exactly once.
* **No hidden automatic restart** exists anywhere in the path.

## 4. Paused buffering policy (bounded, deterministic, tested)

Audio that upstream has **already generated** keeps being accepted while paused, into a queue
bounded at **32 seconds** of audio at the session's format
(`WaveOutPlaybackSession.DefaultMaxQueuedSeconds`).

A write that would exceed the bound is **refused** — `accepted: false, reason: "queueFull"` — and is
neither dropped nor truncated. `ReaderController` surfaces a refusal as a playback failure rather
than pretending the audio played.

No provider-specific flow control was invented for this slice. **Accepted debt:** upstream flow
control (suspending synthesis while output is paused) belongs to a later slice; until then a pause
long enough to fill the bound ends the read with an honest error instead of silently losing speech.

## 5. `ReaderController` semantics

| Operation | What it now does |
| :--- | :--- |
| `startRead` | Ends any in-flight read first, then acquires text and creates the TTS stream. Stays in `preparing` until the playback session **accepts audio**; only then `playing`. A provider that produced no audio at all raises an error rather than leaving the reader in limbo. |
| audio chunk | Routed to the current playback session through an ordered pump. `isFinal` calls `completeInput()` on the playback session — it does **not** end the read. |
| `pause` | Requires `playing`, locates the exact current playback session, calls `pause()`, **confirms the output reported `paused`**, and only then transitions. A refused pause throws and leaves the reader in `playing`. |
| `resume` | Requires `paused`, uses the **same** playback session, confirms `playing`, then transitions. No new TTS session, no re-acquired document, no reset offset, no reset session id. |
| `stop` | Drops read ownership before any `await`, cancels the TTS stream, stops and disposes the playback session, then `stopping` → `idle`. |
| natural completion | The **output draining** ends the read: the session reports `completed`, and the controller reaches `idle` exactly once. |

The snapshot gained `playbackSessionId`, `playbackState`, `lastObservedPlaybackPositionMs` and
`producesAudibleOutput`, so no consumer can mistake a modelled session for an audible one.
`lastObservedPlaybackPositionMs` is a mirror updated when the controller talks to the output, not a
live probe.

### Session fencing

`ReaderStateMachine.sessionId` is retained across `stop()` so the machine can report which read
reached idle — which means it alone would still admit a callback from a read that has ended.
`ReaderController` therefore also holds `activeReadSessionId`, cleared the moment a read ends, and
every callback is fenced on **both**.

### Audio-focus seam (internal, not connected to anything)

`suspendForAudioFocusAsync()` / `resumeForAudioFocusAsync()` exist for a future external audio-focus
arbiter to call. They delegate to the same `pause()` / `resume()` path, add no second pause
mechanism, and return whether output is *genuinely* suspended or playing. They know nothing about
any wire format, lease or priority. `resumeForAudioFocusAsync()` refuses to resume a pause it did
not cause, so releasing focus cannot override a pause the user asked for.

**Nothing is wired to VoiceMediaBridge. This slice contains no VMB code of any kind.**

## 6. What this slice proves, and what it does not

**PROVEN (runtime-observed against a real device — `docs/evidence/playback-runtime.json`):**

* a real playback session starts, and only once audio was accepted (`P2`);
* the device cursor advances in real time while playing (`P3`);
* **pause freezes the device cursor: 0 ms drift across 900 ms of wall clock** (`P4`);
* **resume continues the same session from the frozen cursor** — 611 ms → 894 ms over a 300 ms
  window, never restarting from zero and never crediting the paused time to playback (`P5`);
* repeated pause / resume are safe and named (`P6`);
* a stale session id cannot control live playback (`P7`);
* stop is terminal (`P8`);
* natural completion is the **output draining**, not TTS input ending, and is terminal (`P9`);
* a replacement session takes sole ownership of the device (`P10`);
* the companion still serves IPC afterwards, shuts down cleanly, and leaves no orphan (`P11`, `P12`).

`tests/playback-runtime.test.ts` re-proves the same behaviour through the production TypeScript
path (`ReaderController` → `CompanionAudioPlaybackSink` → IPC → `waveOut`) and skips without the
built companion, exactly as the lifecycle tests do.

**NOT claimed by this slice:**

* live cloud TTS — Cartesia, ElevenLabs and OpenAI remain **simulators**, no network call is made,
  and no credential handling exists;
* any VoiceMediaBridge integration;
* seeking, or any `seeking`-state behaviour;
* device-change / default-endpoint-switch handling (unplugging the output mid-read is untested);
* multi-format or non-PCM audio — only PCM matching the session's opening format is accepted;
* upstream flow control while paused (see §4);
* any production UI.
