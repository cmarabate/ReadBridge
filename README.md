# ReadBridge

Universal Windows AI Read Aloud with synchronized text highlighting across applications.

> **Slice status.** This repository contains the **Windows UI Automation feasibility slice** plus
> the **resumable audio playback session** (RB-AF0), **TTS output flow control** (RB-AF1), and
> **VoiceMediaBridge audio-focus integration** (RB-AF2). The native companion inspects UIA text
> providers, renders a click-through highlight overlay, and now drives a real Windows audio device
> whose playback can genuinely pause, stay suspended, and resume the *same* session from the *same*
> position — and a pause now quiesces the TTS producer too, so pause duration is unbounded.
> ReadBridge is also the first real `SPOKEN_OUTPUT` participant in VoiceMediaBridge: it
> acquires audio focus before it is ever audible, and ChatGPT Dictate preempts and restores
> the exact read across process boundaries. There is still **no live text-to-speech** — the TTS providers are in-memory simulators,
> no network call is made, and no credential handling exists — and there is no browser extension
> and no UI. Read [`docs/feasibility/windows-uia.md`](docs/feasibility/windows-uia.md) §2 and
> [`docs/architecture/audio-playback.md`](docs/architecture/audio-playback.md) §6 and
> [`docs/architecture/audio-focus-integration.md`](docs/architecture/audio-focus-integration.md) §7,
> which separate what is proven from what is expected, before drawing conclusions from anything here.
>
> “Pause duration is unbounded” assumes a TTS provider that honours the flow-control contract in
> [`docs/architecture/tts-providers.md`](docs/architecture/tts-providers.md) §0. The shipped
> simulators do; no live cloud provider has been shown to, because none exists yet.

## Prerequisites

* **Windows** — the companion targets `net10.0-windows` and uses WPF; it does not build elsewhere.
* **.NET 10 SDK** (developed against 10.0.302)
* **Node.js 22** and **Yarn 1.22.22** (pinned via `packageManager`)

## Build and verify

```powershell
yarn install
yarn verify:build   # tsc, then dotnet build ReadBridge.slnx
yarn test:ci        # jest with coverage
yarn verify:ts      # typecheck only
yarn verify:lint    # eslint
```

`yarn test:ci` passes on a fresh clone. The companion lifecycle tests and the real-device playback
tests need the built companion binary, which lives under a gitignored `bin/`, so they **skip** until
you run `yarn verify:build` on Windows. To make that skip a failure instead — on a run that is meant
to exercise the companion — set `READBRIDGE_REQUIRE_COMPANION=1`.

`tests/playback-runtime.test.ts` plays a few seconds of a quiet test tone through a real output
device; see the note under the evidence commands below.

## Running the companion

```powershell
yarn inspect:live        # inspect the current foreground window's UIA text providers
yarn matrix:scan         # inspect every visible window whose process is in the target set
yarn highlight:test      # step the overlay across the first words of the focused window
yarn evidence:lifecycle  # re-record docs/evidence/companion-lifecycle-runtime.json
yarn evidence:playback      # re-record docs/evidence/playback-runtime.json (plays a quiet test tone)
yarn evidence:flow-control  # re-record docs/evidence/tts-flow-control-runtime.json (same tone)
yarn evidence:audio-focus   # re-record docs/evidence/audio-focus-runtime.json (same tone)
```

`evidence:audio-focus` additionally needs an **installed** VoiceMediaBridge (run its
`tools/Install-NativeHost.ps1`). It drives the whole convergence across real processes:
a real browser-proxy host, the shared audio-focus arbiter, this ReadBridge host, the
ReadBridge companion and a real output device. It never pauses or resumes your background
media — whether a background pause happens at all depends on what was already playing, and
either answer is recorded honestly.

`evidence:flow-control` needs a built `dist/` as well as the companion, because it drives the
production TypeScript path end to end. Both harnesses open a real audio output device and render a
220 Hz tone at roughly -46 dBFS for a few seconds. `waveOut` opens in shared mode, so it does not
interrupt other audio, and the tone is quiet enough not to intrude — but it is a real signal, which
is what makes the recorded device cursor real.

`matrix:scan` inspects **all** visible windows belonging to its target process set, including
applications you already had open — not just ones a script launched.

> **Do not commit `matrix:scan` output taken from a normal live desktop.** Because it sweeps every
> visible target window, the result can capture information about whatever applications and browser
> state you had open. Gather UIA runtime evidence only in a controlled test environment with
> deliberately opened applications and documents, and inspect the raw output before committing it.

## Scripts

* `scripts/run_lifecycle_runtime_checks.js` — deterministic companion lifecycle checks (startup,
  IPC, overlay, cancellation, shutdown, restart cycles, and the parent-watchdog A/B). Writes the
  committed evidence artifact.
* `scripts/run_playback_runtime_checks.js` — deterministic audio playback checks against a real
  output device (cursor advance, pause freeze, same-session resume, stale-session refusal, stop,
  natural drain, orphan census). Writes the committed evidence artifact.
* `scripts/run_flow_control_runtime_checks.js` — deterministic TTS output flow-control checks over
  the production path, including a control case that reproduces the playback-queue overflow this
  behaviour removes. Writes the committed evidence artifact.
* `scripts/run_audio_focus_runtime_checks.js` — cross-process audio-focus checks: real browser-proxy
  process, real shared arbiter, real companion, real device. Writes the committed evidence artifact.
* `scripts/run_matrix_tests.ps1` — launches each target application in turn and runs `inspect-proc`
  against it.
* `scripts/scan_all_apps.ps1` — launches the target applications, then runs a single `matrix-scan`.

Both PowerShell scripts require `yarn verify:build` first and will **open and close real
application windows** on your desktop.

## Documentation

* [`docs/feasibility/windows-uia.md`](docs/feasibility/windows-uia.md) — feasibility verdict and evidence classification
* [`docs/architecture/reader-controller.md`](docs/architecture/reader-controller.md) — playback state machine and session tokens
* [`docs/architecture/audio-playback.md`](docs/architecture/audio-playback.md) — the resumable audio playback session, its Windows backend, paused-buffering policy, and its runtime evidence
* [`docs/architecture/audio-focus-integration.md`](docs/architecture/audio-focus-integration.md) — ReadBridge as a VoiceMediaBridge SPOKEN_OUTPUT participant, and its cross-process evidence
* [`docs/architecture/tts-providers.md`](docs/architecture/tts-providers.md) — the implemented output flow-control contract (§0), then Slice 2 TTS provider specifications
* [`docs/evidence/`](docs/evidence) — committed runtime evidence, and analyst-authored expectations clearly labelled as such
