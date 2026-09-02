/*
 * TTS output flow-control runtime checks.
 *
 * Deterministic Windows runtime cases driving the PRODUCTION path end to end:
 *
 *   third-party TTS provider -> ReaderController -> CompanionAudioPlaybackSink
 *     -> companion IPC -> WinMM waveOut -> a real audio output device
 *
 *   node scripts/run_flow_control_runtime_checks.js [--out <path>]
 *
 * Requires Windows, a built companion AND a built `dist/` (`yarn verify:build`). Writes a
 * machine-readable record; docs/evidence/tts-flow-control-runtime.json is a committed run.
 *
 * The provider below is written in plain JavaScript against the published interface and shares no
 * code with the TypeScript simulators. That is deliberate: it demonstrates that the flow-control
 * contract is provider-NEUTRAL, and that a provider ReadBridge has never seen can satisfy it.
 *
 * The decisive case is F4/F5. The producer is authorised to emit far more audio than the 32-second
 * playback queue can hold, while the read is paused. If flow control were absent, the queue would
 * grow and eventually refuse audio with `queueFull` - the RB-AF0 failure mode this slice removes.
 * F7 is the CONTROL: it pauses only the device, leaving upstream running, and is EXPECTED to
 * reproduce that overflow.
 *
 * AUDIBILITY: the test signal is a 220 Hz tone at roughly -46 dBFS. waveOut opens in shared mode
 * and does not interrupt other audio.
 */
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
// tsconfig rootDir is the repo root, so compiled output mirrors src/ under dist/.
const DIST = path.join(REPO_ROOT, 'dist/src/index.js');
const EXE = path.join(REPO_ROOT, 'native/ReadBridge.Companion/bin/Debug/net10.0-windows/ReadBridge.Companion.exe');

const outFlag = process.argv.indexOf('--out');
const OUT_PATH = outFlag >= 0 && process.argv[outFlag + 1] ? path.resolve(process.argv[outFlag + 1]) : null;

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const FORMAT = { sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: BIT_DEPTH };
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
const QUEUE_CAP_SECONDS = 32;

const CHUNK_MS = 300;
const CHUNK_COUNT = 300; // 90 seconds of audio - almost three times the queue cap.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Quiet 220 Hz PCM of a known duration. */
function tone(durationMs, startSample) {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * (startSample + i)) / SAMPLE_RATE) * 160), i * 2);
  }
  return new Uint8Array(buf);
}

/**
 * A flow-control-compliant streaming provider written from scratch against the public contract.
 * `grant()` decides how much the producer is ALLOWED to attempt, so "tried and was blocked" is
 * distinguishable from "never tried".
 */
function createPacedProvider(chunkCount, chunkMs, initialGrants) {
  const sessions = [];

  function createSession(id) {
    let flowState = 'running';
    let inFlight = 0;
    let delivered = 0;
    const runningWaiters = [];
    const quiescentWaiters = [];

    let credit = initialGrants;
    const creditWaiters = [];

    const audioListeners = [];
    const alignmentListeners = [];
    const deliveredChunkIndices = [];

    const flush = (list) => {
      const pending = list.splice(0, list.length);
      for (const resolve of pending) resolve();
    };

    async function beginDelivery() {
      for (;;) {
        if (flowState === 'terminal') return false;
        if (flowState === 'running') {
          inFlight++;
          return true;
        }
        await new Promise((resolve) => runningWaiters.push(resolve));
      }
    }

    function endDelivery() {
      if (inFlight === 0) return;
      inFlight--;
      delivered++;
      if (inFlight === 0) flush(quiescentWaiters);
    }

    async function deliver(emit) {
      if (!(await beginDelivery())) return false;
      try {
        emit();
      } finally {
        endDelivery();
      }
      return true;
    }

    async function takeCredit() {
      if (credit > 0) {
        credit--;
        return;
      }
      await new Promise((resolve) => creditWaiters.push(resolve));
    }

    const session = {
      sessionId: id,
      deliveredChunkIndices,
      get outputFlowState() {
        return flowState;
      },
      get deliveredCount() {
        return delivered;
      },
      grant(n) {
        credit += n;
        while (credit > 0 && creditWaiters.length > 0) {
          credit--;
          creditWaiters.shift()();
        }
      },
      resetGrants() {
        credit = 0;
      },
      async sendTextDelta() {
        for (let i = 0; i < chunkCount; i++) {
          await takeCredit();
          if (flowState === 'terminal') return;
          const alignmentOk = await deliver(() => {
            for (const listener of [...alignmentListeners]) {
              listener({
                word: `w${i}`,
                charStart: 0,
                charLength: 2,
                audioStartMs: i * chunkMs,
                audioEndMs: (i + 1) * chunkMs,
              });
            }
          });
          if (!alignmentOk) return;

          await takeCredit();
          if (flowState === 'terminal') return;
          const chunkOk = await deliver(() => {
            deliveredChunkIndices.push(i);
            for (const listener of [...audioListeners]) {
              listener({
                audioData: tone(chunkMs, i * Math.round((SAMPLE_RATE * chunkMs) / 1000)),
                format: FORMAT,
                durationMs: chunkMs,
                isFinal: false,
              });
            }
          });
          if (!chunkOk) return;
        }
      },
      async completeInput() {
        await deliver(() => {
          for (const listener of [...audioListeners]) {
            listener({ audioData: new Uint8Array(0), format: FORMAT, durationMs: 0, isFinal: true });
          }
        });
      },
      onAudioChunk(listener) {
        audioListeners.push(listener);
        return () => audioListeners.splice(audioListeners.indexOf(listener), 1);
      },
      onWordAlignment(listener) {
        alignmentListeners.push(listener);
        return () => alignmentListeners.splice(alignmentListeners.indexOf(listener), 1);
      },
      async suspendOutput() {
        if (flowState === 'terminal') return { ok: true, outcome: 'terminal', state: flowState, deliveredCount: delivered };
        const already = flowState === 'suspended';
        flowState = 'suspended';
        if (inFlight > 0) await new Promise((resolve) => quiescentWaiters.push(resolve));
        return {
          ok: true,
          outcome: already ? 'alreadySuspended' : 'suspended',
          state: flowState,
          deliveredCount: delivered,
        };
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
        flush(runningWaiters);
        flush(quiescentWaiters);
        flush(creditWaiters);
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
    async createStreamSession() {
      return createSession(`evidence-stream-${sessions.length + 1}`);
    },
    async synthesize(text, options, onChunk, onAlignment) {
      const session = await this.createStreamSession(options);
      session.onAudioChunk(onChunk);
      session.onWordAlignment(onAlignment);
      await session.sendTextDelta(text);
      await session.completeInput();
    },
  };
}

/** A minimal adapter over generated text - no user document is ever read. */
function syntheticAdapter() {
  const fullText = 'ReadBridge suspends its own stream output while playback is paused.';
  const doc = {
    id: 'evidence-doc',
    title: 'Synthetic flow-control document',
    sourceIdentity: { adapterId: 'evidence', title: 'synthetic', appType: 'test' },
    fullText,
    sentences: [{ index: 0, text: fullText, charStart: 0, charLength: fullText.length }],
  };
  return {
    id: 'evidence',
    name: 'Synthetic evidence adapter',
    async identifySource() {
      return doc.sourceIdentity;
    },
    async getCapabilities() {
      return {
        level: 'READER_FALLBACK',
        supportsSelection: false,
        supportsDocumentText: true,
        supportsVisibleText: true,
        supportsWordGeometry: false,
        supportsSentenceGeometry: false,
        supportsClickToSeek: false,
        supportsWindowTracking: false,
      };
    },
    async getSelection() {
      return null;
    },
    async getVisibleText() {
      return doc;
    },
    async getDocumentText() {
      return doc;
    },
    async resolveRangeGeometry() {
      return null;
    },
    observeInvalidation() {
      return () => {};
    },
  };
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
  if (!fs.existsSync(DIST)) throw new Error(`built dist not found: ${DIST} (run \`yarn verify:build\`)`);

  const { NativeCompanionClient, CompanionAudioPlaybackSink, ReaderController } = require(DIST);

  const client = new NativeCompanionClient(EXE);
  await client.start();

  // Every audio write the output refused, whatever the reason. Empty means the queue never filled.
  const refusals = [];
  const baseSink = new CompanionAudioPlaybackSink(client);
  const sink = {
    sinkId: baseSink.sinkId,
    producesAudibleOutput: baseSink.producesAudibleOutput,
    async createSession(id, format) {
      const session = await baseSink.createSession(id, format);
      const write = session.write.bind(session);
      session.write = async (audio) => {
        const result = await write(audio);
        if (!result.accepted && result.reason) refusals.push(result.reason);
        return result;
      };
      return session;
    },
  };

  try {
    const device = await client.call('audioDeviceInfo');
    record({
      id: 'F1-output-device-present',
      outcome: verdict(device.hasOutputDevice === true),
      hasOutputDevice: device.hasOutputDevice,
      outputDeviceCount: device.outputDeviceCount,
      distUnderTest: path.relative(REPO_ROOT, DIST),
    });

    const provider = createPacedProvider(CHUNK_COUNT, CHUNK_MS, 4);
    const controller = new ReaderController(provider, sink);

    // F2: a read starts, with upstream output running.
    await controller.startRead(syntheticAdapter());
    const stream = provider.sessions[0];
    const playbackSessionId = controller.playbackSessionId;
    const startSnap = controller.getSnapshot();
    record({
      id: 'F2-read-starts-with-running-output-flow',
      outcome: verdict(
        startSnap.state === 'playing' &&
        startSnap.ttsOutputState === 'running' &&
        startSnap.producesAudibleOutput === true &&
        playbackSessionId === controller.sessionId
      ),
      readState: startSnap.state,
      ttsOutputState: startSnap.ttsOutputState,
      producesAudibleOutput: startSnap.producesAudibleOutput,
      playbackSessionId,
      providerId: provider.providerId,
    });

    // F3: the real device cursor advances while playing.
    await sleep(300);
    const playing = await client.call('audioStatus', { sessionId: playbackSessionId });
    record({
      id: 'F3-device-cursor-advances-while-playing',
      outcome: verdict(playing.state === 'playing' && playing.positionMs > 100),
      positionAfter300msMs: playing.positionMs,
      deliveredOutputItems: stream.deliveredCount,
    });

    // F4 (decisive): pause quiesces the producer, and the whole remaining stream cannot cross it.
    await controller.pause();
    const pausedSnap = controller.getSnapshot();
    const paused = await client.call('audioStatus', { sessionId: playbackSessionId });
    const deliveredAtPause = stream.deliveredCount;
    const chunksAtPause = stream.deliveredChunkIndices.length;
    const wordAtPause = pausedSnap.currentWord;

    stream.grant(CHUNK_COUNT * 2); // authorise all 90s of remaining audio
    const holdMs = 1500;
    await sleep(holdMs);

    const held = await client.call('audioStatus', { sessionId: playbackSessionId });
    const heldSnap = controller.getSnapshot();
    record({
      id: 'F4-paused-read-quiesces-producer-and-device',
      outcome: verdict(
        pausedSnap.state === 'paused' &&
        pausedSnap.ttsOutputState === 'suspended' &&
        held.state === 'paused' &&
        held.positionMs === paused.positionMs &&
        stream.deliveredCount === deliveredAtPause &&
        stream.deliveredChunkIndices.length === chunksAtPause &&
        heldSnap.currentWord === wordAtPause &&
        refusals.length === 0
      ),
      ttsOutputStateAtPause: pausedSnap.ttsOutputState,
      audioAuthorisedButUndeliveredMs: (CHUNK_COUNT - chunksAtPause) * CHUNK_MS,
      playbackQueueCapMs: QUEUE_CAP_SECONDS * 1000,
      wallClockHeldPausedMs: holdMs,
      positionAtPauseMs: paused.positionMs,
      positionAfterHoldMs: held.positionMs,
      cursorDriftMs: held.positionMs - paused.positionMs,
      deliveredItemsAtPause: deliveredAtPause,
      deliveredItemsAfterHold: stream.deliveredCount,
      highlightWordAtPause: wordAtPause,
      highlightWordAfterHold: heldSnap.currentWord,
      queueRefusals: [...refusals],
    });

    // F5 (decisive): resume restores upstream and the SAME device session, continuing both.
    stream.resetGrants();
    await controller.resume();
    stream.grant(10);
    const resumedSnap = controller.getSnapshot();
    await sleep(400);
    const resumed = await client.call('audioStatus', { sessionId: playbackSessionId });
    const uniqueChunks = new Set(stream.deliveredChunkIndices).size;
    record({
      id: 'F5-resume-restores-producer-and-same-device-session',
      outcome: verdict(
        resumedSnap.state === 'playing' &&
        resumedSnap.ttsOutputState === 'running' &&
        controller.playbackSessionId === playbackSessionId &&
        resumed.positionMs > paused.positionMs &&
        resumed.positionMs < paused.positionMs + holdMs &&
        stream.deliveredCount > deliveredAtPause &&
        uniqueChunks === stream.deliveredChunkIndices.length &&
        refusals.length === 0
      ),
      ttsOutputStateAfterResume: resumedSnap.ttsOutputState,
      playbackSessionUnchanged: controller.playbackSessionId === playbackSessionId,
      positionAfterResumeMs: resumed.positionMs,
      advancedSincePauseMs: resumed.positionMs - paused.positionMs,
      pausedTimeCreditedToPlayback: resumed.positionMs - paused.positionMs >= holdMs,
      deliveredItemsAfterResume: stream.deliveredCount,
      duplicateChunksDelivered: stream.deliveredChunkIndices.length - uniqueChunks,
      queueRefusals: [...refusals],
    });

    // F6: stopping a paused read releases the stream, its blocked producer and the device.
    await controller.pause();
    stream.grant(CHUNK_COUNT * 2);
    await sleep(200);
    const stopStart = Date.now();
    await controller.stop();
    const stopMs = Date.now() - stopStart;
    const stoppedSnap = controller.getSnapshot();
    const deliveredAtStop = stream.deliveredCount;
    await sleep(400);
    record({
      id: 'F6-stop-while-suspended-releases-everything',
      outcome: verdict(
        stoppedSnap.state === 'idle' &&
        stream.outputFlowState === 'terminal' &&
        stoppedSnap.ttsOutputState === null &&
        controller.playbackSessionId === null &&
        stream.deliveredCount === deliveredAtStop
      ),
      readStateAfterStop: stoppedSnap.state,
      ttsOutputStateAfterStop: stream.outputFlowState,
      stopCompletedWithinMs: stopMs,
      deliveriesAfterStop: stream.deliveredCount - deliveredAtStop,
    });

    // F7 CONTROL: pause the DEVICE only, leaving upstream running - RB-AF0's behaviour. This is
    // EXPECTED to fill the queue and be refused; it is what F4 shows flow control removing.
    const controlRefusals = [];
    const controlSink = {
      sinkId: baseSink.sinkId,
      producesAudibleOutput: baseSink.producesAudibleOutput,
      async createSession(id, format) {
        const session = await baseSink.createSession(id, format);
        const write = session.write.bind(session);
        session.write = async (audio) => {
          const result = await write(audio);
          if (!result.accepted && result.reason) controlRefusals.push(result.reason);
          return result;
        };
        return session;
      },
    };
    const controlProvider = createPacedProvider(CHUNK_COUNT, CHUNK_MS, 4);
    const controlController = new ReaderController(controlProvider, controlSink);
    await controlController.startRead(syntheticAdapter());
    const controlStream = controlProvider.sessions[0];
    const controlPlaybackId = controlController.playbackSessionId;

    await client.call('audioPause', { sessionId: controlPlaybackId });
    controlStream.grant(CHUNK_COUNT * 2);
    for (let i = 0; i < 40 && controlRefusals.length === 0; i++) {
      await sleep(100);
    }
    const controlQueue = await client.call('audioStatus', { sessionId: controlPlaybackId });
    await controlController.stop();
    record({
      id: 'F7-control-device-only-pause-still-overflows-the-queue',
      outcome: controlRefusals.includes('queueFull')
        ? 'PASS (RB-AF0 overflow reproduced as expected)'
        : 'FAIL (control did not reproduce the overflow)',
      note: 'Upstream left running while only the device paused - the failure RB-AF1 removes.',
      queueRefusals: controlRefusals.slice(0, 3),
      refusalCount: controlRefusals.length,
      queuedBytesAtOverflow: controlQueue.queuedBytes,
      playbackQueueCapBytes: QUEUE_CAP_SECONDS * BYTES_PER_SECOND,
      deliveredChunks: controlStream.deliveredChunkIndices.length,
    });

    const finalPing = await client.call('ping');
    record({
      id: 'F8-companion-still-serving-after-all-cases',
      outcome: verdict(finalPing === 'pong'),
      finalPing,
    });
  } finally {
    client.stop();
  }

  await sleep(300);
  const failureCount = cases.filter((c) => String(c.outcome).startsWith('FAIL')).length;
  const report = {
    harness: 'scripts/run_flow_control_runtime_checks.js',
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    pathUnderTest: 'third-party TTS provider -> ReaderController -> CompanionAudioPlaybackSink -> companion IPC -> WinMM waveOut',
    audioBackend: 'WinMM waveOut (companion), WAVE_MAPPER, PCM 24000Hz/1ch/16bit',
    testSignal: '220 Hz sine at approximately -46 dBFS',
    streamShape: `${CHUNK_COUNT} chunks x ${CHUNK_MS}ms = ${(CHUNK_COUNT * CHUNK_MS) / 1000}s of audio`,
    playbackQueueCapSeconds: QUEUE_CAP_SECONDS,
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
