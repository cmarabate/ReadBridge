# ReadBridge

Universal Windows AI Read Aloud with synchronized text highlighting across applications.

> **Slice status.** This repository currently contains the **Windows UI Automation feasibility
> slice**: a native companion that inspects UIA text providers and renders a click-through
> highlight overlay, plus a TypeScript reader controller driven by in-memory TTS simulators. There
> is no live text-to-speech, no audio playback, and no browser extension yet. Read
> [`docs/feasibility/windows-uia.md`](docs/feasibility/windows-uia.md) — especially §2, which
> separates what is proven from what is expected — before drawing conclusions from anything here.

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

`yarn test:ci` passes on a fresh clone. The companion lifecycle tests need the built companion
binary, which lives under a gitignored `bin/`, so they **skip** until you run `yarn verify:build`
on Windows. To make that skip a failure instead — on a run that is meant to exercise the
companion — set `READBRIDGE_REQUIRE_COMPANION=1`.

## Running the companion

```powershell
yarn inspect:live        # inspect the current foreground window's UIA text providers
yarn matrix:scan         # inspect every visible window whose process is in the target set
yarn highlight:test      # step the overlay across the first words of the focused window
yarn evidence:lifecycle  # re-record docs/evidence/companion-lifecycle-runtime.json
```

`matrix:scan` inspects **all** visible windows belonging to its target process set, including
applications you already had open — not just ones a script launched.

## Scripts

* `scripts/run_lifecycle_runtime_checks.js` — deterministic companion lifecycle checks (startup,
  IPC, overlay, cancellation, shutdown, restart cycles, and the parent-watchdog A/B). Writes the
  committed evidence artifact.
* `scripts/run_matrix_tests.ps1` — launches each target application in turn and runs `inspect-proc`
  against it.
* `scripts/scan_all_apps.ps1` — launches the target applications, then runs a single `matrix-scan`.

Both PowerShell scripts require `yarn verify:build` first and will **open and close real
application windows** on your desktop.

## Documentation

* [`docs/feasibility/windows-uia.md`](docs/feasibility/windows-uia.md) — feasibility verdict and evidence classification
* [`docs/architecture/reader-controller.md`](docs/architecture/reader-controller.md) — playback state machine and session tokens
* [`docs/architecture/tts-providers.md`](docs/architecture/tts-providers.md) — Slice 2 TTS provider specifications
* [`docs/evidence/`](docs/evidence) — committed runtime evidence, and analyst-authored expectations clearly labelled as such
