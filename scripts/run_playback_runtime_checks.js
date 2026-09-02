/*
 * Audio playback runtime checks.
 *
 * Deterministic Windows runtime cases against a REAL audio output device, driven through the
 * companion's real IPC surface. Every case is decided by what the device's own sample cursor did -
 * no case is decided by reasoning about the source.
 *
 *   node scripts/run_playback_runtime_checks.js [--out <path>]
 *
 * Requires Windows and a built companion (`yarn verify:build`). Writes a machine-readable record;
 * docs/evidence/playback-runtime.json is a committed run of this script.
 *
 * The decisive cases are P4/P5: the cursor is read, the device is paused, ~900ms of wall clock is
 * allowed to pass, and the cursor is read again. A cursor that moved would mean pause did not
 * suspend output; a cursor that returned to zero on resume would mean resume restarted the session
 * rather than continuing it. Both are what ReadBridge must never do.
 *
 * AUDIBILITY: the test signal is a 220 Hz tone at roughly -46 dBFS, a few seconds long. It is a
 * real signal - the device genuinely renders it, which is what makes the cursor genuine - but it is
 * quiet enough not to intrude on whatever else the machine is doing. waveOut opens in shared mode
 * and does not interrupt other audio.
 */
const { spawn, spawnSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXE = path.join(REPO_ROOT, 'native/ReadBridge.Companion/bin/Debug/net10.0-windows/ReadBridge.Companion.exe');

const outFlag = process.argv.indexOf('--out');
const OUT_PATH = outFlag >= 0 && process.argv[outFlag + 1] ? path.resolve(process.argv[outFlag + 1]) : null;

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function waitForExit(pid, timeoutMs) {
  const step = 50;
  for (let waited = step; waited <= timeoutMs; waited += step) {
    await sleep(step);
    if (!isAlive(pid)) return waited;
  }
  return null;
}

function companionCensus() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command',
        "(Get-Process -Name ReadBridge.Companion -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','"],
      { encoding: 'utf8' }
    ).trim();
    return out ? out.split(',').map(Number) : [];
  } catch {
    return [];
  }
}

function forceKill(pid) {
  spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
}

/** Quiet 220 Hz PCM of a known duration. Length is what the cursor is checked against. */
function tone(durationMs, startSample = 0) {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * (startSample + i)) / SAMPLE_RATE) * 160), i * 2);
  }
  return buf.toString('base64');
}

/** Minimal stdio JSON-RPC client that also surfaces the companion's unsolicited events. */
function attach(child) {
  let buffer = '';
  const waiters = [];
  const events = [];

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.event === 'string') {
        events.push(Object.assign({ observedAt: Date.now() }, msg));
        continue;
      }
      const idx = waiters.findIndex((w) => w.id === msg.id);
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
    }
  });

  let n = 0;
  const call = function (method, params = {}, timeoutMs = 20000) {
    const id = 'p' + ++n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + method)), timeoutMs);
      waiters.push({ id, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };

  return { call, events };
}

const cases = [];
function record(o) {
  cases.push(o);
  console.error(`[case] ${o.id} -> ${o.outcome}`);
}

const verdict = (ok) => (ok ? 'PASS' : 'FAIL');

async function main() {
  if (process.platform !== 'win32') throw new Error('these checks are Windows-only');
  if (!fs.existsSync(EXE)) throw new Error(`companion binary not found: ${EXE} (run \`yarn verify:build\`)`);

  const censusStart = companionCensus();
  const child = spawn(EXE, ['ipc', '--parent-pid', String(process.pid)], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const { call, events } = attach(child);
  const companionPid = child.pid;

  try {
    // P1: an output device exists, so every later cursor reading means something.
    const pong = await call('ping');
    const device = await call('audioDeviceInfo');
    record({
      id: 'P1-output-device-present',
      outcome: verdict(pong.result === 'pong' && device.result.hasOutputDevice === true),
      companionPid,
      ping: pong.result ?? null,
      hasOutputDevice: device.result.hasOutputDevice,
      outputDeviceCount: device.result.outputDeviceCount,
    });

    // P2: a session becomes `playing` only once the device has actually accepted audio.
    const opened = await call('audioOpen', {
      sessionId: 'evid-main', sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: BIT_DEPTH,
    });
    const beforeAudio = await call('audioStatus', { sessionId: 'evid-main' });
    const firstWrite = await call('audioWrite', { sessionId: 'evid-main', audioBase64: tone(2000, 0) });
    record({
      id: 'P2-playing-only-after-audio-accepted',
      outcome: verdict(
        opened.result.ok === true &&
        beforeAudio.result.state === 'created' &&
        firstWrite.result.accepted === true &&
        firstWrite.result.state === 'playing'
      ),
      stateAtOpen: beforeAudio.result.state,
      stateAfterFirstWrite: firstWrite.result.state,
      writeAccepted: firstWrite.result.accepted,
      audioWrittenMs: 2000,
    });

    // P3: the device cursor advances in real time while playing.
    const t0 = await call('audioStatus', { sessionId: 'evid-main' });
    await sleep(300);
    const t300 = await call('audioStatus', { sessionId: 'evid-main' });
    await sleep(300);
    const t600 = await call('audioStatus', { sessionId: 'evid-main' });
    record({
      id: 'P3-cursor-advances-while-playing',
      outcome: verdict(t300.result.positionMs > t0.result.positionMs && t600.result.positionMs > t300.result.positionMs),
      positionAtStartMs: t0.result.positionMs,
      positionAfter300msMs: t300.result.positionMs,
      positionAfter600msMs: t600.result.positionMs,
    });

    // P4 (decisive): pause freezes the cursor for the whole duration of the pause.
    const paused = await call('audioPause', { sessionId: 'evid-main' });
    const pausedAt = paused.result.positionMs;
    const pauseHeldMs = 900;
    await sleep(pauseHeldMs);
    const stillPaused = await call('audioStatus', { sessionId: 'evid-main' });
    record({
      id: 'P4-pause-freezes-device-cursor',
      outcome: verdict(
        paused.result.ok === true &&
        paused.result.state === 'paused' &&
        stillPaused.result.state === 'paused' &&
        stillPaused.result.positionMs === pausedAt
      ),
      positionAtPauseMs: pausedAt,
      wallClockHeldPausedMs: pauseHeldMs,
      positionAfterHoldMs: stillPaused.result.positionMs,
      cursorDriftMs: stillPaused.result.positionMs - pausedAt,
    });

    // P5 (decisive): resume continues THE SAME session from the frozen cursor.
    const resumed = await call('audioResume', { sessionId: 'evid-main' });
    const observeMs = 300;
    await sleep(observeMs);
    const afterResume = await call('audioStatus', { sessionId: 'evid-main' });
    const advanced = afterResume.result.positionMs - pausedAt;
    record({
      id: 'P5-resume-continues-same-session-not-restart',
      outcome: verdict(
        resumed.result.ok === true &&
        resumed.result.state === 'playing' &&
        resumed.result.positionMs === pausedAt &&
        afterResume.result.positionMs > pausedAt &&
        advanced < pauseHeldMs
      ),
      positionAtResumeMs: resumed.result.positionMs,
      positionAfterObserveMs: afterResume.result.positionMs,
      observationWindowMs: observeMs,
      advancedSincePauseMs: advanced,
      restartedFromZero: afterResume.result.positionMs < pausedAt,
      pausedTimeCreditedToPlayback: advanced >= pauseHeldMs,
    });

    // P6: idempotence. Repeated pause and repeated resume are safe and named.
    await call('audioPause', { sessionId: 'evid-main' });
    const pauseAgain = await call('audioPause', { sessionId: 'evid-main' });
    await call('audioResume', { sessionId: 'evid-main' });
    const resumeAgain = await call('audioResume', { sessionId: 'evid-main' });
    record({
      id: 'P6-repeated-pause-and-resume-are-safe',
      outcome: verdict(
        pauseAgain.result.ok === true && pauseAgain.result.reason === 'alreadyPaused' &&
        resumeAgain.result.ok === true && resumeAgain.result.reason === 'alreadyPlaying'
      ),
      repeatedPause: { ok: pauseAgain.result.ok, reason: pauseAgain.result.reason, state: pauseAgain.result.state },
      repeatedResume: { ok: resumeAgain.result.ok, reason: resumeAgain.result.reason, state: resumeAgain.result.state },
    });

    // P7: a stale session id cannot control the live session.
    const beforeStale = await call('audioStatus', { sessionId: 'evid-main' });
    const stalePause = await call('audioPause', { sessionId: 'evid-abandoned' });
    const staleStop = await call('audioStop', { sessionId: 'evid-abandoned' });
    const staleWrite = await call('audioWrite', { sessionId: 'evid-abandoned', audioBase64: tone(200, 0) });
    const afterStale = await call('audioStatus', { sessionId: 'evid-main' });
    record({
      id: 'P7-stale-session-cannot-control-live-playback',
      outcome: verdict(
        stalePause.result.ok === false && stalePause.result.reason === 'staleSession' &&
        staleStop.result.ok === false && staleStop.result.reason === 'staleSession' &&
        staleWrite.result.accepted === false && staleWrite.result.reason === 'staleSession' &&
        afterStale.result.state === 'playing' &&
        afterStale.result.positionMs >= beforeStale.result.positionMs
      ),
      stalePause: { ok: stalePause.result.ok, reason: stalePause.result.reason },
      staleStop: { ok: staleStop.result.ok, reason: staleStop.result.reason },
      staleWrite: { accepted: staleWrite.result.accepted, reason: staleWrite.result.reason },
      liveStateAfterStaleCommands: afterStale.result.state,
    });

    // P8: stop is terminal and releases the device.
    const stopped = await call('audioStop', { sessionId: 'evid-main' });
    const resumeAfterStop = await call('audioResume', { sessionId: 'evid-main' });
    record({
      id: 'P8-stop-is-terminal',
      outcome: verdict(
        stopped.result.ok === true && stopped.result.state === 'stopped' &&
        resumeAfterStop.result.ok === false
      ),
      stopState: stopped.result.state,
      positionAtStopMs: stopped.result.positionMs,
      resumeAfterStop: { ok: resumeAfterStop.result.ok, reason: resumeAfterStop.result.reason },
    });

    // P9: natural completion. The device drains and announces it; TTS input completion did not.
    const drainMs = 700;
    events.length = 0;
    await call('audioOpen', {
      sessionId: 'evid-drain', sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: BIT_DEPTH,
    });
    await call('audioWrite', { sessionId: 'evid-drain', audioBase64: tone(drainMs, 0) });
    const inputDone = await call('audioCompleteInput', { sessionId: 'evid-drain' });
    const stateAtInputComplete = inputDone.result.state;

    let completion = null;
    for (let waited = 0; waited < 8000 && !completion; waited += 50) {
      await sleep(50);
      completion = events.find((e) => e.event === 'playbackCompleted' && e.sessionId === 'evid-drain') || null;
    }
    const afterCompletion = await call('audioStatus', { sessionId: 'evid-drain' });
    const resumeAfterCompletion = await call('audioResume', { sessionId: 'evid-drain' });
    record({
      id: 'P9-natural-completion-is-output-drain-not-input-end',
      outcome: verdict(
        stateAtInputComplete === 'playing' &&
        completion !== null &&
        Math.abs(completion.positionMs - drainMs) < 150 &&
        afterCompletion.result.state === 'completed' &&
        resumeAfterCompletion.result.ok === false
      ),
      audioWrittenMs: drainMs,
      stateWhenTtsInputCompleted: stateAtInputComplete,
      completionEventReceived: completion !== null,
      completionPositionMs: completion ? completion.positionMs : null,
      stateAfterCompletion: afterCompletion.result.state,
      resumeAfterCompletion: { ok: resumeAfterCompletion.result.ok, reason: resumeAfterCompletion.result.reason },
    });

    // P10: opening a replacement session releases the previous one.
    await call('audioOpen', {
      sessionId: 'evid-first', sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: BIT_DEPTH,
    });
    await call('audioWrite', { sessionId: 'evid-first', audioBase64: tone(3000, 0) });
    await sleep(200);
    await call('audioOpen', {
      sessionId: 'evid-second', sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: BIT_DEPTH,
    });
    const firstAfterReplace = await call('audioStatus', { sessionId: 'evid-first' });
    const ownership = await call('audioDeviceInfo');
    await call('audioStop', { sessionId: 'evid-second' });
    record({
      id: 'P10-replacement-session-takes-sole-ownership',
      outcome: verdict(
        firstAfterReplace.result.ok === false &&
        firstAfterReplace.result.reason === 'staleSession' &&
        ownership.result.currentSessionId === 'evid-second'
      ),
      previousSessionAfterReplacement: { ok: firstAfterReplace.result.ok, reason: firstAfterReplace.result.reason },
      currentSessionId: ownership.result.currentSessionId,
    });

    // P11: the companion still serves IPC after all of that, and shuts down cleanly.
    const finalPing = await call('ping');
    child.stdin.end();
    const exitMs = await waitForExit(companionPid, 10000);
    record({
      id: 'P11-companion-serving-then-clean-shutdown',
      outcome: verdict(finalPing.result === 'pong' && exitMs !== null),
      finalPing: finalPing.result ?? null,
      exitObservedWithinMs: exitMs,
    });
    if (exitMs === null) forceKill(companionPid);
  } finally {
    if (isAlive(companionPid)) forceKill(companionPid);
    try { child.stdin.end(); } catch { /* already closed */ }
  }

  await sleep(500);
  const censusEnd = companionCensus();
  record({
    id: 'P12-orphan-census-final',
    outcome: verdict(censusEnd.length === censusStart.length),
    companionPidsBefore: censusStart,
    companionPidsAfter: censusEnd,
  });

  const failureCount = cases.filter((c) => String(c.outcome).startsWith('FAIL')).length;
  const report = {
    harness: 'scripts/run_playback_runtime_checks.js',
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    audioBackend: 'WinMM waveOut (companion), WAVE_MAPPER, PCM 24000Hz/1ch/16bit',
    testSignal: '220 Hz sine at approximately -46 dBFS',
    cases,
    failureCount,
  };

  const serialized = JSON.stringify(report, null, 2);
  if (OUT_PATH) {
    fs.writeFileSync(OUT_PATH, serialized + '\n');
    console.error(`[out] ${OUT_PATH}`);
  } else {
    console.log(serialized);
  }
  process.exit(failureCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR: ' + err.stack);
  process.exit(2);
});
