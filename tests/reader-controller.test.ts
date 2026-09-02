import { BrowserDomAdapter } from '../src/adapters/browser-adapter';
import { ReaderFallbackAdapter } from '../src/adapters/fallback-adapter';
import { WindowsUiAutomationAdapter } from '../src/adapters/native-uia-adapter';
import {
  IAudioPlaybackSession,
  IAudioPlaybackSink,
  PlaybackCommandResult,
} from '../src/core/audio/playback-interface';
import {
  SimulatedAudioPlaybackSession,
  SimulatedAudioPlaybackSink,
} from '../src/core/audio/simulated-playback-sink';
import { ReaderController } from '../src/core/reader-controller';
import { CartesiaTtsProvider } from '../src/core/tts/providers/cartesia-provider';
import { OpenAiTtsProvider } from '../src/core/tts/providers/openai-provider';
import { AudioFormat } from '../src/core/tts/provider-interface';
import { FakeStreamingTtsProvider, TEST_FORMAT, bytesForMs, fakeClock } from './helpers/fake-tts';

/**
 * Wraps a real simulated session so a single operation can be made to fail, proving the controller
 * reports what the OUTPUT did rather than what it was asked to do.
 */
class FailingPlaybackSink implements IAudioPlaybackSink {
  public readonly sinkId = 'failing-test-sink';
  public readonly producesAudibleOutput = false;
  public readonly inner: SimulatedAudioPlaybackSink;

  constructor(
    private readonly failOn: 'pause' | 'resume' | 'write',
    private readonly now: () => number
  ) {
    this.inner = new SimulatedAudioPlaybackSink({ now });
  }

  public async createSession(id: string, format: AudioFormat): Promise<IAudioPlaybackSession> {
    const session = (await this.inner.createSession(id, format)) as SimulatedAudioPlaybackSession;
    const failOn = this.failOn;

    return new Proxy(session, {
      get(target, prop, receiver) {
        if (prop === failOn) {
          return async (): Promise<PlaybackCommandResult> => ({
            ok: false,
            reason: 'deviceError:8',
            state: target.state,
            positionMs: target.lastObservedPositionMs,
            queuedBytes: 0,
          });
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as IAudioPlaybackSession;
  }
}

function controllerWith(clock: { now: () => number }, audioMs = 5000) {
  const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
  const tts = new FakeStreamingTtsProvider({ audioMs });
  return { sink, tts, controller: new ReaderController(tts, sink) };
}

describe('ReaderController', () => {
  test('starts playback and receives word highlights in SOURCE_OVERLAY mode', async () => {
    const controller = new ReaderController(new CartesiaTtsProvider(), new SimulatedAudioPlaybackSink());
    const highlights: any[] = [];
    controller.onHighlight((h) => {
      if (h) highlights.push(h);
    });

    await controller.startRead(new BrowserDomAdapter());

    const snap = controller.getSnapshot();
    // startRead returning means the TTS input was sent and playback STARTED - not that audio
    // finished. Only the output draining can end a read.
    expect(snap.state).toBe('playing');
    expect(snap.followMode).toBe('SOURCE_OVERLAY');
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0].rects.length).toBeGreaterThan(0);

    await controller.stop();
  });

  test('falls back to READER_SURFACE mode when using fallback adapter', async () => {
    const controller = new ReaderController(new CartesiaTtsProvider(), new SimulatedAudioPlaybackSink());
    await controller.startRead(new ReaderFallbackAdapter('This is a test paragraph for fallback mode.'));
    expect(controller.getSnapshot().followMode).toBe('READER_SURFACE');
    await controller.stop();
  });

  test('falls back to READER_SURFACE mode when TTS provider does not support timestamps', async () => {
    const controller = new ReaderController(new OpenAiTtsProvider(), new SimulatedAudioPlaybackSink());
    await controller.startRead(new WindowsUiAutomationAdapter());
    expect(controller.getSnapshot().followMode).toBe('READER_SURFACE');
    await controller.stop();
  });

  // ---- Truthful start ---------------------------------------------------------------

  test('15. a start produces exactly one playback session, identified by the read session id', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock);

    await controller.startRead(new WindowsUiAutomationAdapter());

    expect(sink.sessions).toHaveLength(1);
    expect(controller.playbackSessionId).toBe(controller.sessionId);
    expect(sink.sessions[0].playbackSessionId).toBe(controller.sessionId);
    expect(controller.getSnapshot().playbackSessionId).toBe(controller.sessionId);
  });

  test('16. TTS audio chunks are routed into that playback session', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock, 3000);

    await controller.startRead(new WindowsUiAutomationAdapter());

    const session = sink.sessions[0];
    expect(session.state).toBe('playing');

    // 3000ms of audio was accepted: the cursor can run that far and no further.
    clock.advance(3000);
    expect(session.lastObservedPositionMs).toBe(3000);
    clock.advance(1000);
    expect(session.lastObservedPositionMs).toBe(3000);
  });

  test('a controller does not claim `playing` when the provider produced no audio', async () => {
    const sink = new SimulatedAudioPlaybackSink({ now: fakeClock().now });
    const tts = new FakeStreamingTtsProvider({ emitNoAudio: true });
    const controller = new ReaderController(tts, sink);

    await expect(controller.startRead(new WindowsUiAutomationAdapter())).rejects.toThrow(
      /produced no audio/
    );

    expect(controller.getSnapshot().state).toBe('error');
    expect(controller.getSnapshot().playbackSessionId).toBeNull();
    expect(sink.sessions).toHaveLength(0);
  });

  test('the snapshot reports whether the configured output is actually audible', async () => {
    const clock = fakeClock();
    const { controller } = controllerWith(clock);
    await controller.startRead(new WindowsUiAutomationAdapter());

    expect(controller.getSnapshot().producesAudibleOutput).toBe(false);
    expect(controller.getSnapshot().playbackState).toBe('playing');
  });

  // ---- Truthful pause / resume -------------------------------------------------------

  test('17 & 18. a refused pause leaves the reader in `playing`, not `paused`', async () => {
    const clock = fakeClock();
    const sink = new FailingPlaybackSink('pause', clock.now);
    const controller = new ReaderController(new FakeStreamingTtsProvider({ audioMs: 5000 }), sink);

    await controller.startRead(new WindowsUiAutomationAdapter());
    expect(controller.getSnapshot().state).toBe('playing');

    await expect(controller.pause()).rejects.toThrow(/did not pause/);

    expect(controller.getSnapshot().state).toBe('playing');
    expect(controller.getSnapshot().playbackState).toBe('playing');
  });

  test('19. a successful pause reaches `paused` and freezes the output cursor', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock);

    await controller.startRead(new WindowsUiAutomationAdapter());
    clock.advance(800);

    await controller.pause();
    expect(controller.getSnapshot().state).toBe('paused');
    expect(controller.getSnapshot().playbackState).toBe('paused');
    expect(controller.getSnapshot().lastObservedPlaybackPositionMs).toBe(800);

    clock.advance(4000);
    expect(sink.sessions[0].lastObservedPositionMs).toBe(800);
    expect(controller.getSnapshot().state).toBe('paused');
  });

  test('20. a refused resume leaves the reader in `paused`, not `playing`', async () => {
    const clock = fakeClock();
    const sink = new FailingPlaybackSink('resume', clock.now);
    const controller = new ReaderController(new FakeStreamingTtsProvider({ audioMs: 5000 }), sink);

    await controller.startRead(new WindowsUiAutomationAdapter());
    clock.advance(500);
    await controller.pause();
    expect(controller.getSnapshot().state).toBe('paused');

    await expect(controller.resume()).rejects.toThrow(/did not resume/);
    expect(controller.getSnapshot().state).toBe('paused');
  });

  test('21, 22 & 23. resume returns to `playing` on the SAME reader and playback session', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock);

    await controller.startRead(new WindowsUiAutomationAdapter());
    const readSessionId = controller.sessionId;
    const playbackSessionId = controller.playbackSessionId;
    const canonicalOffsetBefore = controller.getSnapshot().canonicalTextOffset;

    clock.advance(900);
    await controller.pause();
    clock.advance(2500);
    await controller.resume();

    expect(controller.getSnapshot().state).toBe('playing');
    expect(controller.sessionId).toBe(readSessionId);
    expect(controller.playbackSessionId).toBe(playbackSessionId);
    expect(controller.getSnapshot().canonicalTextOffset).toBe(canonicalOffsetBefore);

    // No second TTS session and no second playback session were created.
    expect(sink.sessions).toHaveLength(1);

    // The cursor continued rather than restarting, and the pause was not credited as playback.
    clock.advance(300);
    expect(sink.sessions[0].lastObservedPositionMs).toBe(1200);
  });

  test('pause and resume are no-ops from states where they do not apply', async () => {
    const clock = fakeClock();
    const { controller } = controllerWith(clock);

    await controller.resume();
    expect(controller.getSnapshot().state).toBe('idle');

    await controller.startRead(new WindowsUiAutomationAdapter());
    await controller.resume();
    expect(controller.getSnapshot().state).toBe('playing');

    await controller.pause();
    await controller.pause();
    expect(controller.getSnapshot().state).toBe('paused');
  });

  // ---- Stop and natural completion ---------------------------------------------------

  test('24. stop clears the playback session and reaches idle', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock);

    await controller.startRead(new WindowsUiAutomationAdapter());
    clock.advance(400);
    await controller.stop();

    expect(controller.getSnapshot().state).toBe('idle');
    expect(controller.playbackSessionId).toBeNull();
    expect(sink.sessions[0].state).toBe('stopped');
    expect(sink.sessions[0].lastObservedPositionMs).toBe(400);
  });

  test('25. natural output completion - not TTS input completion - ends the read', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock, 1000);

    const states: string[] = [];
    controller.onStateChange((snap) => states.push(snap.state));

    await controller.startRead(new WindowsUiAutomationAdapter());
    // The TTS stream has already signalled isFinal, yet the read is still playing: audio has not drained.
    expect(controller.getSnapshot().state).toBe('playing');

    clock.advance(600);
    await sink.sessions[0].getStatus();
    expect(controller.getSnapshot().state).toBe('playing');

    clock.advance(400);
    await sink.sessions[0].getStatus();

    expect(controller.getSnapshot().state).toBe('idle');
    expect(controller.playbackSessionId).toBeNull();
    expect(states.filter((s) => s === 'idle')).toHaveLength(1);
  });

  test('completion clears the highlight exactly once', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock, 500);
    const highlightClears: number[] = [];
    controller.onHighlight((geom) => {
      if (geom === null) highlightClears.push(1);
    });

    await controller.startRead(new WindowsUiAutomationAdapter());
    clock.advance(500);
    await sink.sessions[0].getStatus();
    await sink.sessions[0].getStatus();

    expect(controller.getSnapshot().state).toBe('idle');
    expect(highlightClears).toHaveLength(1);
  });

  // ---- Session fencing ---------------------------------------------------------------

  test('26. a completion from a stale playback session cannot end the current read', async () => {
    const clock = fakeClock();
    const { controller, sink, tts } = controllerWith(clock, 5000);

    await controller.startRead(new WindowsUiAutomationAdapter());
    const staleSession = sink.sessions[0];
    const staleTts = tts.sessions[0];
    await controller.stop();

    await controller.startRead(new WindowsUiAutomationAdapter());
    const liveSessionId = controller.sessionId;
    expect(sink.sessions).toHaveLength(2);

    // A's playback session is terminal, so it can never announce a completion again; its stream
    // still can, and those signals are the ones that must not reach B. The clock advance is well
    // short of B's own 5000ms of audio, so anything that ends B here came from A.
    expect(staleSession.state).toBe('stopped');
    clock.advance(1500);
    await staleSession.getStatus();
    staleTts.emitChunk({
      audioData: new Uint8Array(bytesForMs(500)),
      format: TEST_FORMAT,
      durationMs: 500,
      isFinal: true,
    });
    staleTts.emitAlignment({ word: 'stale', charStart: 0, charLength: 5, audioStartMs: 0, audioEndMs: 1 });
    await new Promise((r) => setImmediate(r));

    expect(controller.getSnapshot().state).toBe('playing');
    expect(controller.sessionId).toBe(liveSessionId);
    expect(controller.playbackSessionId).toBe(liveSessionId);
    expect(controller.getSnapshot().currentWord).not.toBe('stale');
  });

  test('27. stop immediately followed by start leaves exactly one live playback owner', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock, 5000);

    await controller.startRead(new WindowsUiAutomationAdapter());
    const first = sink.sessions[0];

    const stopping = controller.stop();
    const starting = stopping.then(() => controller.startRead(new WindowsUiAutomationAdapter()));
    await starting;

    expect(sink.sessions).toHaveLength(2);
    expect(first.state).toBe('stopped');
    expect(sink.sessions[1].state).toBe('playing');
    expect(controller.playbackSessionId).toBe(sink.sessions[1].playbackSessionId);
    expect(controller.getSnapshot().state).toBe('playing');
  });

  test('28. a start while already playing releases the previous playback session first', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock, 5000);

    await controller.startRead(new WindowsUiAutomationAdapter());
    const first = sink.sessions[0];
    clock.advance(500);

    await controller.startRead(new WindowsUiAutomationAdapter());

    expect(first.state).toBe('stopped');
    expect(sink.sessions).toHaveLength(2);
    expect(controller.playbackSessionId).toBe(sink.sessions[1].playbackSessionId);
  });

  // ---- Audio-focus seam ---------------------------------------------------------------

  test('the audio-focus seam suspends and restores through the same truthful path', async () => {
    const clock = fakeClock();
    const { controller, sink } = controllerWith(clock);

    await controller.startRead(new WindowsUiAutomationAdapter());
    clock.advance(700);

    expect(await controller.suspendForAudioFocusAsync()).toBe(true);
    expect(controller.getSnapshot().state).toBe('paused');
    clock.advance(3000);
    expect(sink.sessions[0].lastObservedPositionMs).toBe(700);

    // Suspending twice is safe and still reports the truth.
    expect(await controller.suspendForAudioFocusAsync()).toBe(true);

    expect(await controller.resumeForAudioFocusAsync()).toBe(true);
    expect(controller.getSnapshot().state).toBe('playing');
    expect(controller.playbackSessionId).toBe(sink.sessions[0].playbackSessionId);
    clock.advance(200);
    expect(sink.sessions[0].lastObservedPositionMs).toBe(900);
  });

  test('releasing audio focus does not override a pause the user asked for', async () => {
    const clock = fakeClock();
    const { controller } = controllerWith(clock);

    await controller.startRead(new WindowsUiAutomationAdapter());
    await controller.pause();

    expect(await controller.resumeForAudioFocusAsync()).toBe(false);
    expect(controller.getSnapshot().state).toBe('paused');
  });

  test('the audio-focus seam reports failure rather than pretending, when nothing is playing', async () => {
    const clock = fakeClock();
    const { controller } = controllerWith(clock);

    expect(await controller.suspendForAudioFocusAsync()).toBe(false);
    expect(await controller.resumeForAudioFocusAsync()).toBe(false);
    expect(controller.getSnapshot().state).toBe('idle');
  });
});

// ---------------------------------------------------------------------------------------

describe('Adversarial playback sequence', () => {
  test('start A, pause A, resume A, stop A, start B - stale A events never touch B', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const tts = new FakeStreamingTtsProvider({ audioMs: 10000 });
    const controller = new ReaderController(tts, sink);

    const assertOneOwner = (): void => {
      const live = sink.sessions.filter((s) => s.state === 'playing' || s.state === 'paused');
      expect(live.length).toBeLessThanOrEqual(1);
      if (controller.playbackSessionId) {
        expect(controller.playbackSessionId).toBe(controller.sessionId);
      }
    };

    // --- start A: playback begins ---
    await controller.startRead(new WindowsUiAutomationAdapter());
    const sessionA = controller.sessionId;
    const playbackA = sink.sessions[0];
    const ttsA = tts.sessions[0];
    expect(controller.getSnapshot().state).toBe('playing');
    expect(controller.getSnapshot().playbackState).toBe('playing');
    assertOneOwner();

    clock.advance(1200);
    expect(playbackA.lastObservedPositionMs).toBe(1200);

    // --- pause A: prove the cursor is frozen ---
    await controller.pause();
    expect(controller.getSnapshot().state).toBe('paused');
    const frozenAt = playbackA.lastObservedPositionMs;
    expect(frozenAt).toBe(1200);
    assertOneOwner();

    // --- wait: 4 seconds of wall clock, zero playback progress ---
    clock.advance(4000);
    expect(playbackA.lastObservedPositionMs).toBe(frozenAt);
    expect(controller.getSnapshot().state).toBe('paused');
    expect(controller.sessionId).toBe(sessionA);

    // --- resume A: prove the cursor continues on the SAME session ---
    await controller.resume();
    expect(controller.getSnapshot().state).toBe('playing');
    expect(controller.sessionId).toBe(sessionA);
    expect(controller.playbackSessionId).toBe(playbackA.playbackSessionId);
    expect(sink.sessions).toHaveLength(1);

    clock.advance(800);
    expect(playbackA.lastObservedPositionMs).toBe(frozenAt + 800);
    expect(playbackA.lastObservedPositionMs).toBeLessThan(frozenAt + 4000);
    assertOneOwner();

    // --- stop A ---
    await controller.stop();
    expect(controller.getSnapshot().state).toBe('idle');
    expect(playbackA.state).toBe('stopped');
    expect(controller.playbackSessionId).toBeNull();

    // --- immediately start B ---
    await controller.startRead(new WindowsUiAutomationAdapter());
    const sessionB = controller.sessionId;
    const playbackB = sink.sessions[1];
    expect(sessionB).not.toBe(sessionA);
    expect(controller.getSnapshot().state).toBe('playing');
    assertOneOwner();

    clock.advance(500);
    expect(playbackB.lastObservedPositionMs).toBe(500);

    // --- inject every stale A signal there is ---
    await playbackA.pause();
    await playbackA.resume();
    await playbackA.stop();
    await playbackA.getStatus();

    ttsA.emitAlignment({
      word: 'ghost',
      charStart: 0,
      charLength: 5,
      audioStartMs: 0,
      audioEndMs: 100,
    });
    ttsA.emitChunk({
      audioData: new Uint8Array(bytesForMs(2000)),
      format: TEST_FORMAT,
      durationMs: 2000,
      isFinal: false,
    });
    ttsA.emitChunk({
      audioData: new Uint8Array(0),
      format: TEST_FORMAT,
      durationMs: 0,
      isFinal: true,
    });
    await new Promise((r) => setImmediate(r));

    // --- B is untouched: same session, same playback owner, same cursor, still playing ---
    expect(controller.getSnapshot().state).toBe('playing');
    expect(controller.sessionId).toBe(sessionB);
    expect(controller.playbackSessionId).toBe(playbackB.playbackSessionId);
    expect(controller.getSnapshot().currentWord).not.toBe('ghost');
    expect(playbackB.lastObservedPositionMs).toBe(500);
    expect(sink.sessions).toHaveLength(2);
    assertOneOwner();

    // --- and B still completes on its own terms ---
    clock.advance(9500);
    await playbackB.getStatus();
    expect(controller.getSnapshot().state).toBe('idle');
    expect(playbackB.state).toBe('completed');
  });
});
