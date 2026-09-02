/*
 * Cross-process audio-focus runtime checks.
 *
 * The whole convergence, running as it actually ships - real processes, real IPC, a real
 * audio device - with no ChatGPT UI, no microphone, no cloud TTS and no user interaction:
 *
 *   VoiceMediaBridge.NativeHost.exe (browser proxy)      <- synthetic Dictate frames
 *            |  local named pipe
 *            v
 *   VoiceMediaBridge.NativeHost.exe --arbiter            <- the one AudioFocusLedger
 *            ^  local named pipe
 *            |
 *   ReadBridge host (this process)
 *            |  stdio JSON-lines
 *            v
 *   ReadBridge.Companion.exe -> WinMM waveOut -> a real output device
 *
 *   node scripts/run_audio_focus_runtime_checks.js [--out <path>]
 *
 * Requires Windows, a built ReadBridge (`yarn verify:build`) and an INSTALLED
 * VoiceMediaBridge. The arbiter is discovered exactly the way production discovers it -
 * through the installed endpoint descriptor - so this also proves ReadBridge does not
 * depend on a VoiceMediaBridge development checkout.
 *
 * The decisive cases are X4 and X6: a Dictate participant in a different process preempts
 * an exact ReadBridge read, the SUSPEND crosses two process boundaries, and the real
 * device cursor freezes; then the restoration continues THE SAME read, TTS stream and
 * playback session from the same cursor.
 *
 * AUDIBILITY: the test signal is a 220 Hz tone at roughly -46 dBFS, a few seconds long.
 * waveOut opens in shared mode and does not interrupt other audio. The harness never
 * pauses or resumes the operator's background media: whether a concrete PauseLease is
 * acquired at all depends on whether the configured GSMTC source happens to be playing,
 * and either answer is recorded honestly rather than engineered.
 */
const { spawn, spawnSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist/src/index.js');
const COMPANION = path.join(REPO_ROOT, 'native/ReadBridge.Companion/bin/Debug/net10.0-windows/ReadBridge.Companion.exe');

const outFlag = process.argv.indexOf('--out');
const OUT_PATH = outFlag >= 0 && process.argv[outFlag + 1] ? path.resolve(process.argv[outFlag + 1]) : null;

const SAMPLE_RATE = 24000;
const FORMAT = { sampleRate: SAMPLE_RATE, channels: 1, bitDepth: 16 };
const CHUNK_MS = 300;
const CHUNK_COUNT = 200;

const DICTATE_REQUESTER = {
  class: 'VOICE_CAPTURE',
  adapterId: 'chatgpt-dictate',
  tabId: 4242,
  instanceId: 'evidence-instance',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function installRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'VoiceMediaBridge', 'NativeHost');
}

function tone(durationMs, startSample) {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * (startSample + i)) / SAMPLE_RATE) * 160), i * 2);
  }
  return new Uint8Array(buf);
}

/** A rate-bound, flow-control-compliant provider written against the published contract. */
function createPacedProvider() {
  const sessions = [];

  function createSession(id) {
    let flowState = 'running';
    let inFlight = 0;
    let delivered = 0;
    const runningWaiters = [];
    const quiescentWaiters = [];
    let credit = 4;
    const creditWaiters = [];
    const audioListeners = [];
    const alignmentListeners = [];
    const deliveredChunkIndices = [];
    const deliveredAlignmentIndices = [];

    const flush = (list) => { for (const r of list.splice(0, list.length)) r(); };

    async function begin() {
      for (;;) {
        if (flowState === 'terminal') return false;
        if (flowState === 'running') { inFlight++; return true; }
        await new Promise((r) => runningWaiters.push(r));
      }
    }
    function end() {
      if (inFlight === 0) return;
      inFlight--; delivered++;
      if (inFlight === 0) flush(quiescentWaiters);
    }
    async function deliver(emit) {
      if (!(await begin())) return false;
      try { emit(); } finally { end(); }
      return true;
    }
    async function take() {
      if (credit > 0) { credit--; return; }
      await new Promise((r) => creditWaiters.push(r));
    }

    const session = {
      sessionId: id,
      deliveredChunkIndices,
      deliveredAlignmentIndices,
      get outputFlowState() { return flowState; },
      get deliveredCount() { return delivered; },
      grant(n) {
        credit += n;
        while (credit > 0 && creditWaiters.length > 0) { credit--; creditWaiters.shift()(); }
      },
      async sendTextDelta() {
        for (let i = 0; i < CHUNK_COUNT; i++) {
          await take();
          if (flowState === 'terminal') return;
          if (!(await deliver(() => {
            deliveredAlignmentIndices.push(i);
            for (const l of [...alignmentListeners]) {
              l({ word: `w${i}`, charStart: 0, charLength: 2, audioStartMs: i * CHUNK_MS, audioEndMs: (i + 1) * CHUNK_MS });
            }
          }))) return;

          await take();
          if (flowState === 'terminal') return;
          if (!(await deliver(() => {
            deliveredChunkIndices.push(i);
            for (const l of [...audioListeners]) {
              l({
                audioData: tone(CHUNK_MS, i * Math.round((SAMPLE_RATE * CHUNK_MS) / 1000)),
                format: FORMAT,
                durationMs: CHUNK_MS,
                isFinal: false,
              });
            }
          }))) return;
        }
      },
      async completeInput() {
        await deliver(() => {
          for (const l of [...audioListeners]) {
            l({ audioData: new Uint8Array(0), format: FORMAT, durationMs: 0, isFinal: true });
          }
        });
      },
      onAudioChunk(l) { audioListeners.push(l); return () => audioListeners.splice(audioListeners.indexOf(l), 1); },
      onWordAlignment(l) { alignmentListeners.push(l); return () => alignmentListeners.splice(alignmentListeners.indexOf(l), 1); },
      async suspendOutput() {
        if (flowState === 'terminal') return { ok: true, outcome: 'terminal', state: flowState, deliveredCount: delivered };
        const already = flowState === 'suspended';
        flowState = 'suspended';
        if (inFlight > 0) await new Promise((r) => quiescentWaiters.push(r));
        return { ok: true, outcome: already ? 'alreadySuspended' : 'suspended', state: flowState, deliveredCount: delivered };
      },
      async resumeOutput() {
        if (flowState === 'terminal') return { ok: true, outcome: 'terminal', state: flowState, deliveredCount: delivered };
        if (flowState === 'running') return { ok: true, outcome: 'alreadyRunning', state: flowState, deliveredCount: delivered };
        flowState = 'running';
        flush(runningWaiters);
        return { ok: true, outcome: 'resumed', state: flowState, deliveredCount: delivered };
      },
      async cancel() {
        flowState = 'terminal';
        flush(runningWaiters); flush(quiescentWaiters); flush(creditWaiters);
      },
    };

    sessions.push(session);
    return session;
  }

  return {
    providerId: 'evidence-paced-tts',
    supportsWordLevelTimestamps: true,
    supportsIncrementalStreaming: true,
    sessions,
    async initialize() {},
    async createStreamSession() { return createSession(`evidence-stream-${sessions.length + 1}`); },
    async synthesize(text, options, onChunk, onAlignment) {
      const s = await this.createStreamSession(options);
      s.onAudioChunk(onChunk); s.onWordAlignment(onAlignment);
      await s.sendTextDelta(text); await s.completeInput();
    },
  };
}

/** Generated text only. No user document is ever read. */
function syntheticAdapter() {
  const fullText = 'ReadBridge is the first real spoken output participant in VoiceMediaBridge.';
  const doc = {
    id: 'evidence-doc',
    title: 'Synthetic audio-focus document',
    sourceIdentity: { adapterId: 'evidence', title: 'synthetic', appType: 'test' },
    fullText,
    sentences: [{ index: 0, text: fullText, charStart: 0, charLength: fullText.length }],
  };
  return {
    id: 'evidence',
    name: 'Synthetic evidence adapter',
    async identifySource() { return doc.sourceIdentity; },
    async getCapabilities() {
      return {
        level: 'READER_FALLBACK',
        supportsSelection: false, supportsDocumentText: true, supportsVisibleText: true,
        supportsWordGeometry: false, supportsSentenceGeometry: false,
        supportsClickToSeek: false, supportsWindowTracking: false,
      };
    },
    async getSelection() { return null; },
    async getVisibleText() { return doc; },
    async getDocumentText() { return doc; },
    async resolveRangeGeometry() { return null; },
    observeInvalidation() { return () => {}; },
  };
}

/** The REAL browser native-messaging host, driven with valid synthetic Dictate frames. */
function startBrowserProxy(exePath) {
  const child = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = Buffer.alloc(0);
  const waiters = [];
  const stderr = [];

  child.stderr.on('data', (d) => stderr.push(d.toString()));
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readInt32LE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
    }
  });

  function send(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeInt32LE(body.length, 0);
    body.copy(frame, 4);
    child.stdin.write(frame);
  }

  function request(payload, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser proxy did not answer')), timeoutMs);
      waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
      send(payload);
    });
  }

  return {
    child,
    stderr,
    request,
    voice: (event) => request({ kind: 'VMB_VOICE_LIFECYCLE', event, requester: DICTATE_REQUESTER }),
    stop: () => { try { child.stdin.end(); } catch { /* already closed */ } },
    // PID liveness, not Node's 'close' event: 'close' additionally waits for every stdio
    // handle to reach EOF, so a handle held elsewhere would report a process that has
    // genuinely exited as if it were still running.
    waitForExit: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isAlive(child.pid)) return Date.now();
        await sleep(100);
      }
      return null;
    },
    get pid() { return child.pid; },
  };
}

function processCensus(name) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ','`],
      { encoding: 'utf8' }).trim();
    return out ? out.split(',').map(Number) : [];
  } catch { return []; }
}

const cases = [];
function record(o) { cases.push(o); console.error(`[case] ${o.id} -> ${o.outcome}`); }
const verdict = (ok) => (ok ? 'PASS' : 'FAIL');

async function main() {
  if (process.platform !== 'win32') throw new Error('these checks are Windows-only');
  if (!fs.existsSync(DIST)) throw new Error(`built dist not found: ${DIST} (run \`yarn verify:build\`)`);
  if (!fs.existsSync(COMPANION)) throw new Error(`companion not found: ${COMPANION} (run \`yarn verify:build\`)`);

  const {
    NativeCompanionClient,
    CompanionAudioPlaybackSink,
    ReaderController,
    VoiceMediaBridgeFocusClient,
    readVmbEndpointDescriptor,
  } = require(DIST);

  // X1: production discovery. ReadBridge finds VoiceMediaBridge where it is INSTALLED,
  // never in a development checkout.
  const descriptor = readVmbEndpointDescriptor(installRoot());
  record({
    id: 'X1-readbridge-discovers-installed-voicemediabridge',
    outcome: verdict(
      descriptor !== null &&
      descriptor.protocolVersion === 1 &&
      typeof descriptor.pipeName === 'string' &&
      fs.existsSync(descriptor.executablePath) &&
      !descriptor.executablePath.toLowerCase().includes('\\_dev\\')
    ),
    installRoot: installRoot(),
    protocolVersion: descriptor && descriptor.protocolVersion,
    pipeName: descriptor && descriptor.pipeName,
    executablePath: descriptor && descriptor.executablePath,
    dependsOnDevCheckout: descriptor ? descriptor.executablePath.toLowerCase().includes('\\_dev\\') : null,
  });

  if (!descriptor) throw new Error('VoiceMediaBridge is not installed; run tools/Install-NativeHost.ps1');

  const arbitersBefore = processCensus('VoiceMediaBridge.NativeHost');
  const companionsBefore = processCensus('ReadBridge.Companion');

  let proxyExited = false;
  let proxyPid = null;
  let proxyExitMs = null;
  const proxy = startBrowserProxy(descriptor.executablePath);
  const companion = new NativeCompanionClient(COMPANION);
  const focus = new VoiceMediaBridgeFocusClient({ endpoint: descriptor });
  let controller = null;

  try {
    await companion.start();
    if ((await companion.ping()) !== 'pong') throw new Error('the ReadBridge companion did not answer');

    const provider = createPacedProvider();
    controller = new ReaderController(provider, new CompanionAudioPlaybackSink(companion), focus);

    // X2: ReadBridge takes SPOKEN_OUTPUT focus and becomes audible on a real device.
    await controller.startRead(syntheticAdapter());
    const readSessionId = controller.sessionId;
    const playbackSessionId = controller.playbackSessionId;
    const stream = provider.sessions[0];
    const startSnap = controller.getSnapshot();

    await sleep(400);
    const playing = await companion.call('audioStatus', { sessionId: playbackSessionId });

    record({
      id: 'X2-readbridge-holds-focus-and-is-audible',
      outcome: verdict(
        startSnap.state === 'playing' &&
        startSnap.focusArbitrated === true &&
        startSnap.holdsAudioFocus === true &&
        startSnap.producesAudibleOutput === true &&
        playbackSessionId === readSessionId &&
        playing.state === 'playing' &&
        playing.positionMs > 100
      ),
      readSessionId,
      playbackSessionId,
      focusArbitrated: startSnap.focusArbitrated,
      holdsAudioFocus: startSnap.holdsAudioFocus,
      producesAudibleOutput: startSnap.producesAudibleOutput,
      deviceCursorAfter400msMs: playing.positionMs,
      arbiterPipe: descriptor.pipeName,
    });

    // X3: the browser proxy and ReadBridge are on ONE arbiter. A synthetic Dictate start
    // crosses browser proxy -> arbiter -> ReadBridge and preempts the exact read.
    const cursorBeforePreempt = playing.positionMs;
    const deliveredBeforePreempt = stream.deliveredCount;
    const chunksBeforePreempt = [...stream.deliveredChunkIndices];
    const wordBeforePreempt = controller.getSnapshot().currentWord;

    const voiceStarted = await proxy.voice('VOICE_STARTED');
    const preemptedSnap = controller.getSnapshot();

    // The frozen cursor is whatever the device reached by the time the suspension landed.
    // Sampling it before sending VOICE_STARTED would measure the cross-process round trip
    // rather than drift, and would report a freeze that never drifted as if it had.
    const suspendedStatus = await companion.call('audioStatus', { sessionId: playbackSessionId });
    const cursorAtSuspend = suspendedStatus.positionMs;

    record({
      id: 'X3-dictate-preempts-readbridge-through-one-arbiter',
      outcome: verdict(
        voiceStarted.kind === 'VMB_NATIVE_RESULT' &&
        voiceStarted.event === 'VOICE_STARTED' &&
        voiceStarted.outcome !== 'FocusUnsupported' &&
        preemptedSnap.state === 'paused' &&
        preemptedSnap.pausedByAudioFocus === true
      ),
      voiceStartedOutcome: voiceStarted.outcome,
      deviceCursorBeforePreemptionMs: cursorBeforePreempt,
      deviceCursorWhenSuspensionLandedMs: cursorAtSuspend,
      crossProcessPreemptionCostMs: cursorAtSuspend - cursorBeforePreempt,
      voiceStartedReason: voiceStarted.reason ?? null,
      backgroundMediaOutcome: voiceStarted.outcome,
      readerStateAfterPreemption: preemptedSnap.state,
      pausedByAudioFocus: preemptedSnap.pausedByAudioFocus,
      focusStillHeldByReadBridge: preemptedSnap.holdsAudioFocus,
      note: 'A preemption is not an ending: ReadBridge keeps its logical focus while suspended.',
    });

    // X4 (decisive): the real device cursor and the TTS producer are BOTH frozen, and
    // stay frozen while the preemption is held.
    stream.grant(400);
    const holdMs = 1500;
    await sleep(holdMs);

    const held = await companion.call('audioStatus', { sessionId: playbackSessionId });
    const heldSnap = controller.getSnapshot();

    record({
      id: 'X4-suspension-freezes-real-device-cursor-and-producer',
      outcome: verdict(
        held.state === 'paused' &&
        held.positionMs === cursorAtSuspend &&
        stream.deliveredCount === deliveredBeforePreempt &&
        stream.outputFlowState === 'suspended' &&
        heldSnap.currentWord === wordBeforePreempt &&
        heldSnap.state === 'paused' &&
        controller.playbackSessionId === playbackSessionId
      ),
      wallClockHeldSuspendedMs: holdMs,
      audioAuthorisedButUndeliveredMs: (CHUNK_COUNT - chunksBeforePreempt.length) * CHUNK_MS,
      deviceCursorAtSuspendMs: cursorAtSuspend,
      deviceCursorAfterHoldMs: held.positionMs,
      cursorDriftMs: held.positionMs - cursorAtSuspend,
      ttsDeliveriesAtSuspend: deliveredBeforePreempt,
      ttsDeliveriesAfterHold: stream.deliveredCount,
      ttsOutputState: stream.outputFlowState,
      highlightWordAtSuspend: wordBeforePreempt,
      highlightWordAfterHold: heldSnap.currentWord,
      playbackSessionUnchanged: controller.playbackSessionId === playbackSessionId,
    });

    // X5 / X6 (decisive): Dictate ends, the arbiter restores the exact ReadBridge read,
    // and the RESUME crosses back the same way.
    const voiceEnded = await proxy.voice('VOICE_ENDED');
    const resumedSnap = controller.getSnapshot();
    await sleep(400);
    const resumed = await companion.call('audioStatus', { sessionId: playbackSessionId });

    record({
      id: 'X5-dictate-release-restores-the-exact-readbridge-read',
      outcome: verdict(
        resumedSnap.state === 'playing' &&
        controller.sessionId === readSessionId &&
        controller.playbackSessionId === playbackSessionId &&
        provider.sessions.length === 1 &&
        stream.outputFlowState === 'running'
      ),
      voiceEndedOutcome: voiceEnded.outcome,
      voiceEndedReason: voiceEnded.reason ?? null,
      readSessionUnchanged: controller.sessionId === readSessionId,
      playbackSessionUnchanged: controller.playbackSessionId === playbackSessionId,
      ttsStreamCount: provider.sessions.length,
      ttsOutputState: stream.outputFlowState,
    });

    record({
      id: 'X6-same-session-continues-from-the-same-cursor',
      outcome: verdict(
        resumed.positionMs > cursorAtSuspend &&
        resumed.positionMs < cursorAtSuspend + holdMs &&
        stream.deliveredChunkIndices.slice(0, chunksBeforePreempt.length).join(',') === chunksBeforePreempt.join(',') &&
        new Set(stream.deliveredChunkIndices).size === stream.deliveredChunkIndices.length
      ),
      deviceCursorAtSuspendMs: cursorAtSuspend,
      deviceCursorAfterResumeMs: resumed.positionMs,
      advancedSinceSuspendMs: resumed.positionMs - cursorAtSuspend,
      suspendedTimeCreditedToPlayback: resumed.positionMs - cursorAtSuspend >= holdMs,
      restartedFromZero: resumed.positionMs < cursorAtSuspend,
      duplicateChunksDelivered: stream.deliveredChunkIndices.length - new Set(stream.deliveredChunkIndices).size,
      chunksBeforeSuspend: chunksBeforePreempt.length,
      chunksAfterResume: stream.deliveredChunkIndices.length,
    });

    // X7: ReadBridge ends, releasing the last participant and clearing the episode.
    await controller.stop();
    const endedSnap = controller.getSnapshot();
    await sleep(300);

    record({
      id: 'X7-readbridge-end-clears-the-focus-episode',
      outcome: verdict(
        endedSnap.state === 'idle' &&
        controller.playbackSessionId === null &&
        endedSnap.holdsAudioFocus === false &&
        stream.outputFlowState === 'terminal'
      ),
      readerState: endedSnap.state,
      holdsAudioFocus: endedSnap.holdsAudioFocus,
      ttsOutputState: stream.outputFlowState,
    });

    // X8: the lower participant ENDING WHILE PREEMPTED. The higher holder stays active,
    // nothing is resumed for the dead read, and the episode clears only when Dictate ends.
    const provider2 = createPacedProvider();
    const controller2 = new ReaderController(provider2, new CompanionAudioPlaybackSink(companion), focus);
    await controller2.startRead(syntheticAdapter());
    const read2 = controller2.sessionId;
    await sleep(250);

    await proxy.voice('VOICE_STARTED');
    const preempted2 = controller2.getSnapshot();

    await controller2.stop();
    const stoppedWhilePreempted = controller2.getSnapshot();
    await sleep(200);

    const voiceEnded2 = await proxy.voice('VOICE_ENDED');
    await sleep(300);

    record({
      id: 'X8-lower-participant-ending-while-preempted',
      outcome: verdict(
        preempted2.state === 'paused' &&
        stoppedWhilePreempted.state === 'idle' &&
        controller2.playbackSessionId === null &&
        controller2.getSnapshot().state === 'idle' &&
        voiceEnded2.outcome !== 'FocusUnsupported'
      ),
      readSessionId: read2,
      stateWhenPreempted: preempted2.state,
      stateAfterStopWhilePreempted: stoppedWhilePreempted.state,
      dictateEndOutcome: voiceEnded2.outcome,
      dictateEndReason: voiceEnded2.reason ?? null,
      readerNotResurrectedByDictateEnd: controller2.getSnapshot().state === 'idle',
    });

    await controller2.dispose();

    // X9: the browser wire vocabulary Dictate depends on is unchanged.
    const contextResult = await proxy.request({ kind: 'VMB_MEDIA_CONTEXT_QUERY' });
    const anonymous = await proxy.request({ kind: 'VMB_VOICE_LIFECYCLE', event: 'VOICE_ENDED' });

    record({
      id: 'X9-browser-boundary-behaviour-unchanged',
      outcome: verdict(
        contextResult.kind === 'VMB_MEDIA_CONTEXT_RESULT' &&
        ['Found', 'NotFound', 'Ambiguous', 'Error'].includes(contextResult.outcome) &&
        anonymous.outcome === 'RequesterRequired' &&
        anonymous.reason === 'MissingRequester'
      ),
      mediaContextOutcome: contextResult.outcome,
      mediaContextSource: contextResult.source ?? null,
      anonymousLifecycleOutcome: anonymous.outcome,
      anonymousLifecycleReason: anonymous.reason,
    });
  } finally {
    if (controller) {
      try { await controller.dispose(); } catch { /* teardown */ }
    }
    try { await focus.dispose(); } catch { /* teardown */ }
    companion.stop();
    proxy.stop();
    proxyPid = proxy.pid;
    const exitStart = Date.now();
    const exitedAt = await proxy.waitForExit(15000);
    proxyExited = exitedAt !== null;
    proxyExitMs = exitedAt === null ? null : exitedAt - exitStart;
    await sleep(500);
  }

  // X10: no process is left behind that was not there before, apart from the on-demand
  // arbiter, which exits on its own after its idle grace.
  const arbitersAfter = processCensus('VoiceMediaBridge.NativeHost');
  const companionsAfter = processCensus('ReadBridge.Companion');
  const newArbiters = arbitersAfter.filter((pid) => !arbitersBefore.includes(pid));

  record({
    id: 'X10-process-census',
    outcome: verdict(
      proxyExited &&
      companionsAfter.length <= companionsBefore.length &&
      newArbiters.length <= 1 &&
      !newArbiters.includes(proxyPid)
    ),
    browserProxyPid: proxyPid,
    browserProxyExitedOnStdinEof: proxyExited,
    voiceMediaBridgeBefore: arbitersBefore,
    voiceMediaBridgeAfter: arbitersAfter,
    newVoiceMediaBridgeProcesses: newArbiters,
    readBridgeCompanionsBefore: companionsBefore,
    readBridgeCompanionsAfter: companionsAfter,
    note: 'Exactly one new VoiceMediaBridge process may remain: the on-demand arbiter, whose own idle exit is X11.',
  });

  // X11: the arbiter is genuinely on demand - with no client connected and no focus
  // state, it exits by itself. Nothing is left resident.
  const idleDeadline = Date.now() + 45000;
  let arbiterStillRunning = newArbiters;
  while (Date.now() < idleDeadline && arbiterStillRunning.length > 0) {
    await sleep(1000);
    const now = processCensus('VoiceMediaBridge.NativeHost');
    arbiterStillRunning = newArbiters.filter((pid) => now.includes(pid));
  }

  record({
    id: 'X11-arbiter-exits-on-its-own-when-idle',
    outcome: verdict(arbiterStillRunning.length === 0),
    arbiterPids: newArbiters,
    stillRunningAfterIdleGrace: arbiterStillRunning,
    note: 'No service, no scheduled task, no autostart: nothing stays resident once no participant needs audio focus.',
  });

  const failureCount = cases.filter((c) => String(c.outcome).startsWith('FAIL')).length;
  const report = {
    harness: 'scripts/run_audio_focus_runtime_checks.js',
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    topology: 'browser-proxy process -> named pipe -> VMB arbiter process -> named pipe -> ReadBridge -> companion -> WinMM waveOut',
    audioBackend: 'WinMM waveOut (ReadBridge.Companion), PCM 24000Hz/1ch/16bit',
    testSignal: '220 Hz sine at approximately -46 dBFS',
    dictateRequester: DICTATE_REQUESTER,
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
