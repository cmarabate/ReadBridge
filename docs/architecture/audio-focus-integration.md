# Audio-Focus Integration (RB-AF2)

> **Status.** Implemented and proven cross-process against a real Windows audio device.
> The decisive record is [`docs/evidence/audio-focus-runtime.json`](../evidence/audio-focus-runtime.json),
> reproducible with `yarn evidence:audio-focus`. The committed run was recorded against
> VoiceMediaBridge installed from commit `c0c45bf`, whose installed `ProductVersion` the
> installer asserts equals that commit. §7 states plainly what is **not** claimed.

## 1. What changed

RB-AF0 and RB-AF1 made ReadBridge's own playback truthful: it really starts, really
pauses the same `waveOut` session, really resumes from the same cursor, and really stops
feeding itself while paused. What was still missing was *permission*: nothing decided
**when ReadBridge was allowed to be audible**.

ReadBridge is now the first real `SPOKEN_OUTPUT` participant in VoiceMediaBridge's audio
focus, under the fixed ordering

```
VOICE_CAPTURE (ChatGPT Dictate)  >  SPOKEN_OUTPUT (ReadBridge)  >  BACKGROUND_MEDIA
```

## 2. The seam

`IReadAudioFocusCoordinator`
([`src/core/focus/audio-focus-contract.ts`](../../src/core/focus/audio-focus-contract.ts))
is the whole of what `ReaderController` knows about audio focus. It asks whether **this
exact read** may be audible and is told; it never sees a lease, a priority number, a GSMTC
session or a browser tab, and the authority never sees a TTS stream or a playback cursor.

| Owns | ReadBridge | VoiceMediaBridge |
| :--- | :--- | :--- |
| whether ReadBridge may be audible | | ✔ |
| preemption, restoration, ordering | | ✔ |
| the user's background media | | ✔ |
| how TTS and playback actually stop and start | ✔ | |
| whether they *truly* did | ✔ | |

`VoiceMediaBridgeFocusClient` implements the seam over the arbiter's current-user-only
named pipe. It is a transport, not an authority. Production discovers the endpoint from
the **installed** VoiceMediaBridge
(`%LOCALAPPDATA%\VoiceMediaBridge\NativeHost\audio-focus-endpoint.json`), never from a
development checkout, and starts the arbiter on demand without a console window. If
VoiceMediaBridge is not installed, the client raises an actionable error — it does not
degrade to unarbitrated audio.

**Integrated vs standalone is explicit and visible.** A controller constructed with an
arbitrating coordinator is integrated. One constructed without is standalone, and says so
on its snapshot (`focusArbitrated: false`). `UnarbitratedAudioFocusCoordinator` exists for
tests and standalone runs — never as a silent fallback when the real authority is missing,
which is exactly the failure such a fallback would hide.

## 3. Participant identity

The participant is `SPOKEN_OUTPUT` / `readbridge` / **the exact `ReaderController` read
session id**.

Not the process, not "the current reader", not a window title, not the text. A stopped or
replaced read is a *different participant*, so a command naming the old one fails closed
with `participantUnavailable`. There is no fallback to the newest read.

## 4. Focus is settled before ReadBridge is ever audible

The gate sits at the last possible moment before sound: real audio has arrived from the
TTS stream and is about to be handed to an output, and the playback session has **not yet
been created**.

```
 text acquired -> TTS stream created -> first real audio chunk arrives
                                              |
                                     request SPOKEN_OUTPUT focus
                                              |
                    granted ──────────────────┴────────────── refused
                       |                                        |
              open playback session                    no output is opened
              write, become `playing`                  reader goes to `error`
```

* A refusal — `blockedByHigherFocus`, `classConflict`, or an unreachable authority, which
  **is** a refusal — opens no output at all. Zero audible playback.
* A grant whose playback then fails to open is handed straight back, so the user's
  background media is never left paused for a read that never spoke.

## 5. Two kinds of pause, one pause mechanism

Both go through the same truthful two-layer transaction from RB-AF1 (quiesce upstream TTS
to quiescence, then pause the device, confirm, only then transition). They differ **only**
in what happens to focus.

| | user pause | authority preemption |
| :--- | :--- | :--- |
| suspends TTS + device | ✔ | ✔ |
| releases focus | ✔ | ✘ — deliberately |
| resume path | `resume()` reacquires focus **first** | `resumeForAudioFocusAsync()` asks for nothing new |
| background media | free to come back | stays paused for the episode |

A user who paused is not waiting to be restored, so holding focus would suppress their
background media indefinitely. A preemption is the opposite: the authority already owns
the Active → Preempted transition, and releasing there would turn a preemption into an
ending — the read would never be restored and the background media would come back early.

**Ownership can change hands.** If the user pauses or stops a read the authority
suspended, they take that pause over: a later restoration command is answered `rejected`
rather than putting audio back the user stopped, which lets the authority invalidate that
phantom participant.

## 6. Ending, and losing the authority

* **Natural completion** and **stop** each release the exact participant exactly once.
* **Stopping while preempted** releases the preempted participant, so the authority skips
  a dead predecessor when the higher holder ends rather than trying to restore it.
* **Losing the authority while audible** falls silent — quiesce upstream, pause the
  device, report an actionable error. It does not keep speaking unarbitrated, and it does
  not resume itself when the connection returns; focus has to be truthfully reacquired.

The snapshot gained `focusArbitrated`, `holdsAudioFocus` and `pausedByAudioFocus`, so no
consumer can mistake a standalone reader for an arbitrated one, or a user pause for a
preemption.

## 7. What this proves, and what it does not

**PROVEN** (`docs/evidence/audio-focus-runtime.json` — real processes, real pipes, a real
output device; no ChatGPT UI, no microphone, no cloud TTS, no user interaction):

* `X0` four arbiters started at once leave **exactly one** listening, every loser exiting
  `0` — a pipe name permits many server instances, so the named mutex is what makes one
  authority;
* `X1` ReadBridge discovers the **installed** VoiceMediaBridge, not a dev checkout;
* `X2` it holds focus and is audible on a real device before anything else happens;
* `X3` a synthetic Dictate `VOICE_STARTED` through the **real browser-proxy process**
  preempts the exact read across two process boundaries in tens of milliseconds (33 ms in
  the committed run), and ReadBridge
  keeps its logical focus while suspended;
* `X4` the suspension freezes the real device cursor with **0 ms drift across 1.5 s**
  (420 ms → 420 ms), with **59.4 s of authorised-but-undelivered audio**, and freezes the
  highlight word;
* `X5` `VOICE_ENDED` restores the same read, the same TTS stream and the same playback
  session (`SpokenOutputRestored`);
* `X6` the cursor continues **420 ms → 839 ms** — 419 ms over a 400 ms window — with
  **zero duplicate chunks** and no credit for the 1.5 s it spent suspended;
* `X7` ending the read clears the focus episode;
* `X8` a read that ends while preempted is **not** resurrected when Dictate ends;
* `X9` the browser boundary is unchanged;
* `X10`/`X11` the proxy exits on stdin EOF and the arbiter exits by itself when idle —
  nothing stays resident.

Deterministic coverage: 10 suites, 118 tests, 0 skipped with the companion required
(22 of them audio-focus specific; the 96 accepted RB-AF1 tests are unmodified and green).

**NOT claimed:**

* the full **physical background-media** sequence (media playing → ReadBridge pauses it →
  Dictate → ReadBridge → causal resume). The evidence run recorded `NoPlayingSession`,
  because the machine's configured GSMTC source was paused and holds the operator's own
  content; starting it purely to obtain evidence was deliberately declined. The causal
  ownership rules are proven deterministically in VoiceMediaBridge against a fake catalog;
* live cloud TTS — the providers remain simulators and no network call is made;
* ChatGPT Read Aloud as a browser spoken-output producer — parked;
* recovery behaviour after the authority returns beyond "does not auto-resume": a user
  resume is what reacquires focus.
