import { WindowsUiAutomationAdapter } from '../src/adapters/native-uia-adapter';
import {
  IAudioPlaybackSession,
  IAudioPlaybackSink,
} from '../src/core/audio/playback-interface';
import {
  SimulatedAudioPlaybackSession,
  SimulatedAudioPlaybackSink,
} from '../src/core/audio/simulated-playback-sink';
import { ReaderController } from '../src/core/reader-controller';
import {
  AudioFormat,
  ITtsProvider,
  ITtsStreamSession,
  TtsFlowControlResult,
  TtsOptions,
} from '../src/core/tts/provider-interface';
import { TEST_FORMAT, bytesForMs, fakeClock } from './helpers/fake-tts';
import { PacedTtsProvider, PacedTtsStreamSession, settleAsyncWork } from './helpers/paced-tts';

const BYTES_PER_SECOND = TEST_FORMAT.sampleRate * TEST_FORMAT.channels * (TEST_FORMAT.bitDepth / 8);
/** RB-AF0's defence-in-depth bound, unchanged by this slice. */
const QUEUE_CAP_SECONDS = 32;

type FlowFailure = 'suspend' | 'resume' | null;
type PlaybackFailure = 'pause' | 'resume' | null;

interface Harness {
  controller: ReaderController;
  sink: SimulatedAudioPlaybackSink;
  provider: PacedTtsProvider;
  /** Ordered record of the calls the pause/resume transaction actually made. */
  order: string[];
  /** Reasons the playback output gave for refusing audio. Empty means nothing was ever refused. */
  refusals: string[];
  clock: { now: () => number; advance: (ms: number) => void };
}

function buildHarness(options: {
  chunkCount: number;
  chunkMs?: number;
  initialGrants?: number;
  failFlow?: FlowFailure;
  failPlayback?: PlaybackFailure;
}): Harness {
  const clock = fakeClock();
  const order: string[] = [];
  const refusals: string[] = [];

  const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
  const provider = new PacedTtsProvider({
    chunkCount: options.chunkCount,
    chunkMs: options.chunkMs ?? 500,
    initialGrants: options.initialGrants,
  });

  const failedFlow = (): TtsFlowControlResult => ({
    ok: false,
    outcome: 'failed',
    state: 'running',
    deliveredCount: 0,
  });

  const wrappedProvider: ITtsProvider = {
    providerId: provider.providerId,
    supportsWordLevelTimestamps: provider.supportsWordLevelTimestamps,
    supportsIncrementalStreaming: provider.supportsIncrementalStreaming,
    initialize: () => provider.initialize(),
    synthesize: (t, o, c, a) => provider.synthesize(t, o, c, a),
    createStreamSession: async (opts: TtsOptions): Promise<ITtsStreamSession> => {
      const session = await provider.createStreamSession(opts);
      return new Proxy(session, {
        get(target, prop, receiver) {
          if (prop === 'suspendOutput' || prop === 'resumeOutput') {
            const label = prop === 'suspendOutput' ? 'tts:suspend' : 'tts:resume';
            return async (): Promise<TtsFlowControlResult> => {
              order.push(label);
              if (
                (options.failFlow === 'suspend' && prop === 'suspendOutput') ||
                (options.failFlow === 'resume' && prop === 'resumeOutput')
              ) {
                return failedFlow();
              }
              return (target as any)[prop]();
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as ITtsStreamSession;
    },
  };

  const wrappedSink: IAudioPlaybackSink = {
    sinkId: sink.sinkId,
    producesAudibleOutput: sink.producesAudibleOutput,
    createSession: async (id: string, format: AudioFormat): Promise<IAudioPlaybackSession> => {
      const session = (await sink.createSession(id, format)) as SimulatedAudioPlaybackSession;
      return new Proxy(session, {
        get(target, prop, receiver) {
          if (prop === 'pause' || prop === 'resume') {
            const label = prop === 'pause' ? 'playback:pause' : 'playback:resume';
            return async () => {
              order.push(label);
              if (options.failPlayback === prop) {
                return {
                  ok: false,
                  reason: 'deviceError:8',
                  state: target.state,
                  positionMs: target.lastObservedPositionMs,
                  queuedBytes: 0,
                };
              }
              return (target as any)[prop]();
            };
          }
          if (prop === 'write') {
            return async (audio: Uint8Array) => {
              const result = await target.write(audio);
              if (!result.accepted && result.reason) refusals.push(result.reason);
              return result;
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as unknown as IAudioPlaybackSession;
    },
  };

  const controller = new ReaderController(wrappedProvider, wrappedSink);
  controller.onStateChange((snap) => order.push(`state:${snap.state}`));

  return { controller, sink, provider, order, refusals, clock };
}

const streamOf = (h: Harness): PacedTtsStreamSession => h.provider.sessions[h.provider.sessions.length - 1];
const playbackOf = (h: Harness): SimulatedAudioPlaybackSession => h.sink.sessions[h.sink.sessions.length - 1];

describe('ReaderController pause is a two-layer transaction', () => {
  test('15 & 16. a successful pause suspends upstream BEFORE it pauses playback, and only then reports paused', async () => {
    const h = buildHarness({ chunkCount: 40 });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    await settleAsyncWork(4);

    h.order.length = 0;
    await h.controller.pause();

    expect(h.order).toEqual(['tts:suspend', 'playback:pause', 'state:paused']);
    expect(h.controller.getSnapshot().state).toBe('paused');
    expect(h.controller.getSnapshot().playbackState).toBe('paused');
    expect(h.controller.getSnapshot().ttsOutputState).toBe('suspended');
    expect(streamOf(h).outputFlowState).toBe('suspended');
    expect(playbackOf(h).state).toBe('paused');
  });

  test('17. an upstream suspend failure leaves BOTH playback and the reader playing', async () => {
    const h = buildHarness({ chunkCount: 40, failFlow: 'suspend' });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    await settleAsyncWork(4);

    h.order.length = 0;
    await expect(h.controller.pause()).rejects.toThrow(/TTS output did not suspend/);

    // The device was never touched: pausing audio the provider cannot stop feeding is the exact
    // failure mode this slice exists to remove.
    expect(h.order).toEqual(['tts:suspend']);
    expect(h.controller.getSnapshot().state).toBe('playing');
    expect(playbackOf(h).state).toBe('playing');
    expect(streamOf(h).outputFlowState).toBe('running');
  });

  test('18. a playback pause failure rolls upstream back to running', async () => {
    const h = buildHarness({ chunkCount: 40, failPlayback: 'pause' });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    await settleAsyncWork(4);

    h.order.length = 0;
    await expect(h.controller.pause()).rejects.toThrow(/rolled back to running/);

    expect(h.order).toEqual(['tts:suspend', 'playback:pause', 'tts:resume']);
    expect(h.controller.getSnapshot().state).toBe('playing');
    // Not left suspended: a read that is still playing must still be fed.
    expect(streamOf(h).outputFlowState).toBe('running');
    expect(h.controller.getSnapshot().ttsOutputState).toBe('running');
  });
});

describe('ReaderController resume is a two-layer transaction', () => {
  test('19, 22, 23 & 24. resume restores upstream and the SAME read, playback and TTS sessions', async () => {
    const h = buildHarness({ chunkCount: 40 });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    await settleAsyncWork(4);

    const readId = h.controller.sessionId;
    const playbackId = h.controller.playbackSessionId;
    const streamId = streamOf(h).sessionId;
    const offsetBefore = h.controller.getSnapshot().canonicalTextOffset;

    h.clock.advance(300);
    await h.controller.pause();
    h.clock.advance(5000);

    h.order.length = 0;
    await h.controller.resume();

    expect(h.order).toEqual(['tts:resume', 'playback:resume', 'state:playing']);
    expect(h.controller.getSnapshot().state).toBe('playing');
    expect(h.controller.sessionId).toBe(readId);
    expect(h.controller.playbackSessionId).toBe(playbackId);
    expect(streamOf(h).sessionId).toBe(streamId);
    expect(h.provider.sessions).toHaveLength(1);
    expect(h.sink.sessions).toHaveLength(1);
    expect(h.controller.getSnapshot().canonicalTextOffset).toBe(offsetBefore);
    expect(h.controller.getSnapshot().ttsOutputState).toBe('running');
  });

  test('20. an upstream resume failure leaves playback and the reader paused', async () => {
    const h = buildHarness({ chunkCount: 40, failFlow: 'resume' });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    await settleAsyncWork(4);
    await h.controller.pause();

    h.order.length = 0;
    await expect(h.controller.resume()).rejects.toThrow(/TTS output did not resume/);

    // The device was never restarted: audio that cannot be refilled must not start draining.
    expect(h.order).toEqual(['tts:resume']);
    expect(h.controller.getSnapshot().state).toBe('paused');
    expect(playbackOf(h).state).toBe('paused');
  });

  test('21. a playback resume failure re-suspends upstream and leaves the reader paused', async () => {
    const h = buildHarness({ chunkCount: 40, failPlayback: 'resume' });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    await settleAsyncWork(4);
    await h.controller.pause();

    h.order.length = 0;
    await expect(h.controller.resume()).rejects.toThrow(/rolled back to suspended/);

    expect(h.order).toEqual(['tts:resume', 'playback:resume', 'tts:suspend']);
    expect(h.controller.getSnapshot().state).toBe('paused');
    expect(streamOf(h).outputFlowState).toBe('suspended');
    expect(h.controller.getSnapshot().ttsOutputState).toBe('suspended');
  });
});

describe('Pause ownership and lifecycle under flow control', () => {
  test('25. a user pause is not auto-resumed when audio focus is released', async () => {
    const h = buildHarness({ chunkCount: 40 });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    await settleAsyncWork(4);

    await h.controller.pause();
    expect(streamOf(h).outputFlowState).toBe('suspended');

    expect(await h.controller.resumeForAudioFocusAsync()).toBe(false);
    expect(h.controller.getSnapshot().state).toBe('paused');
    // Upstream stays quiesced too - a half-restored read would feed a paused device.
    expect(streamOf(h).outputFlowState).toBe('suspended');
  });

  test('26. a focus-owned pause suspends and restores upstream through the same transaction', async () => {
    const h = buildHarness({ chunkCount: 40 });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    await settleAsyncWork(4);

    h.order.length = 0;
    expect(await h.controller.suspendForAudioFocusAsync()).toBe(true);
    expect(h.order).toEqual(['tts:suspend', 'playback:pause', 'state:paused']);
    expect(streamOf(h).outputFlowState).toBe('suspended');

    h.order.length = 0;
    expect(await h.controller.resumeForAudioFocusAsync()).toBe(true);
    expect(h.order).toEqual(['tts:resume', 'playback:resume', 'state:playing']);
    expect(streamOf(h).outputFlowState).toBe('running');
    expect(h.controller.getSnapshot().state).toBe('playing');
  });

  test('27. stopping while suspended releases the stream, the producer and the playback session', async () => {
    const h = buildHarness({ chunkCount: 500, initialGrants: 2 });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const stream = streamOf(h);
    const playback = playbackOf(h);

    await h.controller.pause();
    expect(stream.outputFlowState).toBe('suspended');

    // A producer holding credit it cannot spend. Stop must wake it; if it did not, this await
    // would never return.
    stream.grantProduction(1000);
    await settleAsyncWork(4);

    await h.controller.stop();

    expect(h.controller.getSnapshot().state).toBe('idle');
    expect(stream.outputFlowState).toBe('terminal');
    expect(stream.cancelled).toBe(true);
    expect(playback.state).toBe('stopped');
    expect(h.controller.playbackSessionId).toBeNull();
    expect(h.controller.getSnapshot().ttsOutputState).toBeNull();

    // Nothing from the stopped read surfaces afterwards.
    const deliveredAtStop = stream.deliveredCount;
    await settleAsyncWork(30);
    expect(stream.deliveredCount).toBe(deliveredAtStop);
  });

  test('28. a replacement read starts with a fresh, running output flow', async () => {
    const h = buildHarness({ chunkCount: 500, initialGrants: 2 });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const first = streamOf(h);
    await h.controller.pause();
    expect(first.outputFlowState).toBe('suspended');

    await h.controller.stop();
    await h.controller.startRead(new WindowsUiAutomationAdapter());

    const second = streamOf(h);
    expect(second).not.toBe(first);
    expect(second.outputFlowState).toBe('running');
    expect(h.controller.getSnapshot().ttsOutputState).toBe('running');
    expect(h.controller.getSnapshot().state).toBe('playing');
    expect(first.outputFlowState).toBe('terminal');
  });
});

// ---------------------------------------------------------------------------------------
// The reason RB-AF1 exists: a pause long enough to fill the playback queue used to end a
// valid read. These two tests are a matched pair - the control reproduces that failure, and
// the acceptance case shows flow control removing it.
// ---------------------------------------------------------------------------------------

describe('Long-pause acceptance: pause duration is independent of the playback queue bound', () => {
  // 200 chunks x 500ms = 100s of audio, over three times the 32s playback queue cap.
  const CHUNK_COUNT = 200;
  const CHUNK_MS = 500;
  const TOTAL_AUDIO_MS = CHUNK_COUNT * CHUNK_MS;

  test('the arithmetic is actually adversarial: the attempted production far exceeds the cap', () => {
    expect(TOTAL_AUDIO_MS).toBeGreaterThan(QUEUE_CAP_SECONDS * 1000 * 3);
    expect(bytesForMs(TOTAL_AUDIO_MS)).toBeGreaterThan(QUEUE_CAP_SECONDS * BYTES_PER_SECOND);
  });

  // CONTROL. Pausing only the device - RB-AF0's behaviour - lets the producer keep filling the
  // queue until it is refused. This is the failure RB-AF1 removes; it is expected to reproduce.
  test('CONTROL: pausing playback alone still fills the queue and ends in queueFull', async () => {
    const h = buildHarness({ chunkCount: CHUNK_COUNT, chunkMs: CHUNK_MS, initialGrants: 2 });
    await h.controller.startRead(new WindowsUiAutomationAdapter());

    const stream = streamOf(h);
    const playback = playbackOf(h);

    // Reach around the controller, straight to the device, leaving upstream running.
    await playback.pause();
    expect(playback.state).toBe('paused');

    stream.grantProduction(CHUNK_COUNT * 2);
    await settleAsyncWork(400);

    expect(h.refusals).toContain('queueFull');
    expect(playback.queuedBytes()).toBeGreaterThan(QUEUE_CAP_SECONDS * BYTES_PER_SECOND * 0.9);
  });

  test('ACCEPTANCE: with flow control, a paused read absorbs the same production without growing', async () => {
    const h = buildHarness({ chunkCount: CHUNK_COUNT, chunkMs: CHUNK_MS, initialGrants: 2 });
    await h.controller.startRead(new WindowsUiAutomationAdapter());

    const stream = streamOf(h);
    const playback = playbackOf(h);
    expect(h.controller.getSnapshot().state).toBe('playing');

    await h.controller.pause();
    expect(h.controller.getSnapshot().state).toBe('paused');
    expect(stream.outputFlowState).toBe('suspended');

    const queuedAtPause = playback.queuedBytes();
    const deliveredAtPause = stream.deliveredCount;
    const chunksAtPause = [...stream.deliveredChunkIndices];
    const alignmentsAtPause = [...stream.deliveredAlignmentIndices];
    const wordAtPause = h.controller.getSnapshot().currentWord;
    const offsetAtPause = h.controller.getSnapshot().canonicalTextOffset;
    const positionAtPause = playback.lastObservedPositionMs;

    // Authorise the producer to attempt every remaining item - 100 seconds of audio - and let
    // the event loop run freely. Also advance the clock far past any real pause.
    stream.grantProduction(CHUNK_COUNT * 2);
    for (let i = 0; i < 10; i++) {
      h.clock.advance(60_000);
      await settleAsyncWork(40);
    }

    // Nothing crossed the suspension.
    expect(stream.deliveredCount).toBe(deliveredAtPause);
    expect(stream.deliveredChunkIndices).toEqual(chunksAtPause);
    expect(stream.deliveredAlignmentIndices).toEqual(alignmentsAtPause);

    // The queue did not grow, and nothing was ever refused.
    expect(playback.queuedBytes()).toBe(queuedAtPause);
    expect(h.refusals).toEqual([]);

    // The cursor is frozen and the highlight has not advanced past unheard speech.
    expect(playback.lastObservedPositionMs).toBe(positionAtPause);
    expect(h.controller.getSnapshot().currentWord).toBe(wordAtPause);
    expect(h.controller.getSnapshot().canonicalTextOffset).toBe(offsetAtPause);

    // The read is still valid: 10 minutes of virtual pause changed nothing.
    expect(h.controller.getSnapshot().state).toBe('paused');
    expect(h.controller.playbackSessionId).toBe(h.controller.sessionId);

    // Hand pacing back before resuming. The burst above was deliberately unrealistic - no real
    // provider can emit 100s of audio instantly - and RB-AF1's claim is about PAUSE duration, not
    // about rate-limiting a runaway producer while playing (that is what the 32s cap is still for).
    stream.resetProduction();

    await h.controller.resume();
    expect(h.controller.getSnapshot().state).toBe('playing');

    // One (alignment, chunk) pair produced per chunk-worth of drain, as a rate-bound provider is.
    for (let i = 0; i < 900 && h.controller.getSnapshot().state !== 'idle'; i++) {
      stream.grantProduction(2);
      await settleAsyncWork(2);
      h.clock.advance(CHUNK_MS);
      await playback.getStatus();
    }

    // Exactly the whole stream, once each, in order - the pause skipped and duplicated nothing.
    expect(stream.deliveredChunkIndices).toEqual([...Array(CHUNK_COUNT).keys()]);
    expect(stream.deliveredAlignmentIndices).toEqual([...Array(CHUNK_COUNT).keys()]);
    expect(h.refusals).toEqual([]);
    expect(h.controller.getSnapshot().state).toBe('idle');
    expect(playback.state).toBe('completed');
    expect(playback.lastObservedPositionMs).toBe(TOTAL_AUDIO_MS);
  }, 30000);
});

// ---------------------------------------------------------------------------------------

describe('Adversarial flow-control sequence', () => {
  test('A: run, pause, burst, resume, pause, stop while suspended - then B is untouched', async () => {
    const h = buildHarness({ chunkCount: 300, chunkMs: 500, initialGrants: 6 });

    const assertInvariants = (label: string): void => {
      const live = h.sink.sessions.filter((s) => s.state === 'playing' || s.state === 'paused');
      expect(live.length).toBeLessThanOrEqual(1);
      const liveStreams = h.provider.sessions.filter((s) => s.outputFlowState !== 'terminal');
      expect(liveStreams.length).toBeLessThanOrEqual(1);
      if (h.controller.playbackSessionId) {
        expect(h.controller.playbackSessionId).toBe(h.controller.sessionId);
      }
      expect(h.refusals).toEqual([]);
      expect(label).toBeTruthy();
    };

    // --- start A, chunks 1..N flow ---
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const sessionA = h.controller.sessionId;
    const streamA = streamOf(h);
    const playbackA = playbackOf(h);
    await settleAsyncWork(10);

    expect(h.controller.getSnapshot().state).toBe('playing');
    expect(streamA.deliveredChunkIndices).toEqual([0, 1, 2]);
    assertInvariants('A running');

    h.clock.advance(400);

    // --- pause A: upstream quiescent, device frozen ---
    await h.controller.pause();
    expect(streamA.outputFlowState).toBe('suspended');
    const frozenCursor = playbackA.lastObservedPositionMs;
    const deliveredAtPause = streamA.deliveredCount;
    const wordAtPause = h.controller.getSnapshot().currentWord;
    assertInvariants('A paused');

    // --- the producer attempts a large burst; none of it may cross the suspension ---
    streamA.grantProduction(600);
    h.clock.advance(120_000);
    await settleAsyncWork(60);

    expect(streamA.deliveredCount).toBe(deliveredAtPause);
    expect(streamA.deliveredChunkIndices).toEqual([0, 1, 2]);
    expect(playbackA.lastObservedPositionMs).toBe(frozenCursor);
    expect(h.controller.getSnapshot().currentWord).toBe(wordAtPause);
    expect(h.controller.getSnapshot().state).toBe('paused');
    assertInvariants('A burst blocked');

    // --- resume A: delivery continues at chunk 3, the cursor continues from where it froze ---
    streamA.resetProduction();
    await h.controller.resume();
    streamA.grantProduction(4);
    await settleAsyncWork(10);

    expect(h.controller.sessionId).toBe(sessionA);
    expect(streamA.deliveredChunkIndices.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(new Set(streamA.deliveredChunkIndices).size).toBe(streamA.deliveredChunkIndices.length);

    h.clock.advance(200);
    expect(playbackA.lastObservedPositionMs).toBe(frozenCursor + 200);
    assertInvariants('A resumed');

    // --- pause A again, then stop it while suspended ---
    await h.controller.pause();
    expect(streamA.outputFlowState).toBe('suspended');
    streamA.grantProduction(600);
    await settleAsyncWork(6);

    await h.controller.stop();
    expect(h.controller.getSnapshot().state).toBe('idle');
    expect(streamA.outputFlowState).toBe('terminal');
    expect(playbackA.state).toBe('stopped');

    // --- start B ---
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const sessionB = h.controller.sessionId;
    const streamB = streamOf(h);
    const playbackB = playbackOf(h);
    expect(sessionB).not.toBe(sessionA);
    expect(streamB).not.toBe(streamA);
    expect(streamB.outputFlowState).toBe('running');
    assertInvariants('B running');

    h.clock.advance(250);
    const bCursor = playbackB.lastObservedPositionMs;
    const bChunks = [...streamB.deliveredChunkIndices];

    // --- release every stale A gate and callback there is ---
    const aDeliveredAtStop = streamA.deliveredCount;
    streamA.grantProduction(2000);
    await streamA.resumeOutput();
    await streamA.suspendOutput();
    await settleAsyncWork(40);

    // A is terminal: none of that produced anything, and none of it reached B.
    expect(streamA.deliveredCount).toBe(aDeliveredAtStop);
    expect(h.controller.sessionId).toBe(sessionB);
    expect(h.controller.playbackSessionId).toBe(playbackB.playbackSessionId);
    expect(h.controller.getSnapshot().state).toBe('playing');
    expect(streamB.deliveredChunkIndices.slice(0, bChunks.length)).toEqual(bChunks);
    expect(playbackB.lastObservedPositionMs).toBe(bCursor);
    assertInvariants('B unaffected by stale A');

    // --- and B still pauses truthfully afterwards ---
    await h.controller.pause();
    expect(h.controller.getSnapshot().state).toBe('paused');
    expect(streamB.outputFlowState).toBe('suspended');
    expect(h.refusals).toEqual([]);
  }, 30000);
});
