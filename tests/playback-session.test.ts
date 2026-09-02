import { NativeCompanionClient } from '../src/companion-bridge/ipc-client';
import { CompanionAudioPlaybackSink } from '../src/core/audio/companion-playback-sink';
import { IAudioPlaybackSession } from '../src/core/audio/playback-interface';
import {
  SimulatedAudioPlaybackSession,
  SimulatedAudioPlaybackSink,
} from '../src/core/audio/simulated-playback-sink';
import { TEST_FORMAT, bytesForMs, fakeClock, pcmForMs } from './helpers/fake-tts';

async function openSession(
  sink: SimulatedAudioPlaybackSink,
  id = 'pb-1'
): Promise<SimulatedAudioPlaybackSession> {
  return (await sink.createSession(id, TEST_FORMAT)) as SimulatedAudioPlaybackSession;
}

describe('Playback session contract (deterministic clock)', () => {
  test('1. a session starts only once the output has actually accepted audio', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink);

    expect(session.state).toBe('created');
    expect(session.lastObservedPositionMs).toBe(0);

    // An empty chunk is accepted but is not audio, so it must not start playback.
    const empty = await session.write(new Uint8Array(0));
    expect(empty.accepted).toBe(true);
    expect(empty.reason).toBe('empty');
    expect(session.state).toBe('created');

    const written = await session.write(pcmForMs(1000));
    expect(written.accepted).toBe(true);
    expect(written.state).toBe('playing');
  });

  test('2. the output cursor advances while playing', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink);
    await session.write(pcmForMs(2000));

    expect(session.lastObservedPositionMs).toBe(0);
    clock.advance(400);
    expect(session.lastObservedPositionMs).toBe(400);
    clock.advance(300);
    expect(session.lastObservedPositionMs).toBe(700);
  });

  test('3 & 4. pause freezes the cursor and the paused state is stable over time', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink);
    await session.write(pcmForMs(5000));

    clock.advance(700);
    const paused = await session.pause();
    expect(paused.ok).toBe(true);
    expect(paused.state).toBe('paused');
    expect(paused.positionMs).toBe(700);

    // Wall-clock time advances well past the pause; the cursor must not.
    clock.advance(3000);
    expect(session.state).toBe('paused');
    expect(session.lastObservedPositionMs).toBe(700);

    clock.advance(3000);
    expect(session.state).toBe('paused');
    expect((await session.getStatus()).positionMs).toBe(700);
  });

  test('5 & 6. resume continues the SAME session from the frozen cursor, it does not restart', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink, 'pb-resume');
    await session.write(pcmForMs(5000));

    clock.advance(900);
    await session.pause();
    clock.advance(2500);

    const resumed = await session.resume();
    expect(resumed.ok).toBe(true);
    expect(resumed.state).toBe('playing');

    // Same session identity: no new session was created to resume with.
    expect(resumed.positionMs).toBe(900);
    expect(session.playbackSessionId).toBe('pb-resume');
    expect(sink.sessions).toHaveLength(1);

    clock.advance(400);
    expect(session.lastObservedPositionMs).toBe(1300);
    // The 2500ms spent paused was not silently credited to playback.
    expect(session.lastObservedPositionMs).toBeLessThan(900 + 2500);
  });

  test('7 & 9. stop is terminal and resume after stop fails closed', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink);
    await session.write(pcmForMs(5000));
    clock.advance(500);

    const stopped = await session.stop();
    expect(stopped.ok).toBe(true);
    expect(stopped.state).toBe('stopped');
    expect(stopped.positionMs).toBe(500);

    clock.advance(1000);
    expect(session.lastObservedPositionMs).toBe(500);

    expect((await session.resume()).ok).toBe(false);
    expect((await session.resume()).reason).toBe('terminalState');
    expect((await session.pause()).ok).toBe(false);
    expect((await session.write(pcmForMs(100))).accepted).toBe(false);
    expect(session.state).toBe('stopped');
  });

  test('8 & 10. natural completion is terminal and resume after completion fails closed', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink);

    const completions: Array<[string, number]> = [];
    session.onCompleted((id, positionMs) => completions.push([id, positionMs]));

    await session.write(pcmForMs(1000));
    await session.completeInput();

    clock.advance(400);
    expect(session.state).toBe('playing');
    expect(completions).toHaveLength(0);

    clock.advance(600);
    expect(session.state).toBe('completed');
    expect(completions).toEqual([['pb-1', 1000]]);

    // Terminal: the cursor stops at the full duration and nothing can restart it.
    clock.advance(5000);
    expect(session.lastObservedPositionMs).toBe(1000);
    expect((await session.resume()).ok).toBe(false);
    expect((await session.resume()).reason).toBe('terminalState');
    expect((await session.stop()).ok).toBe(false);
  });

  test('11 & 12. repeated pause and repeated resume are safe and say which no-op they were', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink);
    await session.write(pcmForMs(5000));
    clock.advance(300);

    expect(await session.pause()).toMatchObject({ ok: true, reason: null, state: 'paused' });
    expect(await session.pause()).toMatchObject({ ok: true, reason: 'alreadyPaused', state: 'paused' });
    expect(await session.pause()).toMatchObject({ ok: true, reason: 'alreadyPaused' });
    expect(session.lastObservedPositionMs).toBe(300);

    expect(await session.resume()).toMatchObject({ ok: true, reason: null, state: 'playing' });
    expect(await session.resume()).toMatchObject({ ok: true, reason: 'alreadyPlaying', state: 'playing' });
    clock.advance(200);
    expect(session.lastObservedPositionMs).toBe(500);
  });

  test('pause before any audio was accepted is refused rather than reported as a pause', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink);

    const result = await session.pause();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('notStarted');
    expect(session.state).toBe('created');
  });

  test('13. dispose releases the session and stops it reporting completion', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink);

    let completed = 0;
    session.onCompleted(() => completed++);

    await session.write(pcmForMs(1000));
    await session.completeInput();
    clock.advance(200);

    await session.dispose();
    expect(session.state).toBe('stopped');

    clock.advance(5000);
    expect(session.state).toBe('stopped');
    expect(completed).toBe(0);
    await expect(session.dispose()).resolves.toBeUndefined();
  });

  test('14. an old session cannot control the session that replaced it', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });

    const first = await openSession(sink, 'pb-old');
    await first.write(pcmForMs(5000));
    clock.advance(400);
    await first.stop();

    const second = await openSession(sink, 'pb-new');
    await second.write(pcmForMs(5000));
    clock.advance(300);

    // Every command on the dead session fails and leaves the live one untouched.
    expect((await first.pause()).ok).toBe(false);
    expect((await first.resume()).ok).toBe(false);
    expect((await first.write(pcmForMs(100))).accepted).toBe(false);

    expect(second.state).toBe('playing');
    expect(second.lastObservedPositionMs).toBe(300);
    expect(first.playbackSessionId).not.toBe(second.playbackSessionId);
  });

  test('the paused-buffering bound refuses audio rather than dropping it or growing without limit', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now, maxQueuedSeconds: 2 });
    const session = await openSession(sink);

    expect((await session.write(pcmForMs(1500))).accepted).toBe(true);
    await session.pause();

    // Already-generated audio keeps being accepted while paused, up to the bound.
    const withinBound = await session.write(pcmForMs(400));
    expect(withinBound.accepted).toBe(true);
    expect(withinBound.queuedBytes).toBe(bytesForMs(1900));

    const overBound = await session.write(pcmForMs(400));
    expect(overBound.accepted).toBe(false);
    expect(overBound.reason).toBe('queueFull');
    expect(overBound.maxQueuedBytes).toBe(bytesForMs(2000));

    // Refusal is not loss of state: the session is intact and still paused.
    expect(session.state).toBe('paused');
    expect((await session.resume()).ok).toBe(true);
  });

  test('a misaligned PCM frame is refused instead of being handed to the output', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const session = await openSession(sink);

    const odd = await session.write(new Uint8Array(101));
    expect(odd.accepted).toBe(false);
    expect(odd.reason).toBe('misalignedFrame');
    expect(session.state).toBe('created');
  });

  test('the simulated sink labels itself as producing no audible output', () => {
    const sink = new SimulatedAudioPlaybackSink();
    expect(sink.producesAudibleOutput).toBe(false);
    expect(sink.sinkId).toBe('simulated-playback');
  });
});

// ---------------------------------------------------------------------------------------
// The companion sink is the production path. These cover its transport contract with a stub
// companion; the real device semantics are covered by scripts/run_playback_runtime_checks.js.
// ---------------------------------------------------------------------------------------

interface StubCall {
  method: string;
  params: any;
}

function stubCompanion(
  responder: (method: string, params: any) => any
): { client: NativeCompanionClient; calls: StubCall[]; emit: (evt: any) => void } {
  const calls: StubCall[] = [];
  let listeners: Array<(evt: any) => void> = [];

  const client = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      return responder(method, params);
    },
    onEvent: (listener: (evt: any) => void) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
  } as unknown as NativeCompanionClient;

  return {
    client,
    calls,
    emit: (evt: any) => {
      for (const listener of [...listeners]) listener(evt);
    },
  };
}

describe('Companion playback sink (transport contract)', () => {
  test('opens a companion session and refuses to hand back one the companion rejected', async () => {
    const rejecting = stubCompanion(() => ({ ok: false, reason: 'sessionIdInUse', state: 'stopped' }));
    const sink = new CompanionAudioPlaybackSink(rejecting.client);

    await expect(sink.createSession('read-1', TEST_FORMAT)).rejects.toThrow(/sessionIdInUse/);
  });

  test('mirrors companion state and cursor rather than inventing them', async () => {
    let state = 'created';
    let positionMs = 0;
    const stub = stubCompanion((method) => {
      if (method === 'audioOpen') return { ok: true, state: 'created', positionMs: 0 };
      if (method === 'audioWrite') {
        state = 'playing';
        return { accepted: true, state, positionMs, queuedBytes: 4, maxQueuedBytes: 100 };
      }
      if (method === 'audioPause') {
        state = 'paused';
        positionMs = 742;
        return { ok: true, state, positionMs, queuedBytes: 4 };
      }
      if (method === 'audioResume') {
        state = 'playing';
        return { ok: true, state, positionMs, queuedBytes: 4 };
      }
      return { ok: true, state, positionMs, queuedBytes: 0 };
    });

    const sink = new CompanionAudioPlaybackSink(stub.client);
    expect(sink.producesAudibleOutput).toBe(true);

    const session = await sink.createSession('read-1', TEST_FORMAT);
    expect(session.state).toBe('created');

    await session.write(pcmForMs(500));
    expect(session.state).toBe('playing');

    const paused = await session.pause();
    expect(paused).toMatchObject({ ok: true, state: 'paused', positionMs: 742 });
    expect(session.lastObservedPositionMs).toBe(742);

    // Resuming continues the same companion-side session: no reopen is issued.
    await session.resume();
    expect(session.state).toBe('playing');
    expect(stub.calls.filter((c) => c.method === 'audioOpen')).toHaveLength(1);
    expect(stub.calls.every((c) => c.params.sessionId === 'read-1')).toBe(true);
  });

  test('audio is transported as base64 of exactly the bytes written', async () => {
    const stub = stubCompanion((method) =>
      method === 'audioOpen'
        ? { ok: true, state: 'created', positionMs: 0 }
        : { accepted: true, state: 'playing', positionMs: 0, queuedBytes: 0, maxQueuedBytes: 1 }
    );
    const sink = new CompanionAudioPlaybackSink(stub.client);
    const session = await sink.createSession('read-1', TEST_FORMAT);

    const audio = pcmForMs(250);
    await session.write(audio);

    const write = stub.calls.find((c) => c.method === 'audioWrite')!;
    expect(Buffer.from(write.params.audioBase64, 'base64')).toHaveLength(audio.length);
  });

  test('a completion event for a DIFFERENT session is ignored', async () => {
    const stub = stubCompanion((method) =>
      method === 'audioOpen'
        ? { ok: true, state: 'created', positionMs: 0 }
        : { accepted: true, ok: true, state: 'playing', positionMs: 0, queuedBytes: 0, maxQueuedBytes: 1 }
    );
    const sink = new CompanionAudioPlaybackSink(stub.client);
    const session: IAudioPlaybackSession = await sink.createSession('read-current', TEST_FORMAT);

    const completions: string[] = [];
    session.onCompleted((id) => completions.push(id));

    stub.emit({ event: 'playbackCompleted', sessionId: 'read-stale', positionMs: 999 });
    expect(completions).toEqual([]);
    expect(session.state).toBe('created');

    stub.emit({ event: 'playbackCompleted', sessionId: 'read-current', positionMs: 1234 });
    expect(completions).toEqual(['read-current']);
    expect(session.state).toBe('completed');
    expect(session.lastObservedPositionMs).toBe(1234);
  });

  test('dispose stops the companion session and detaches its event subscription', async () => {
    const stub = stubCompanion((method) =>
      method === 'audioOpen'
        ? { ok: true, state: 'created', positionMs: 0 }
        : { ok: true, accepted: true, state: 'playing', positionMs: 5, queuedBytes: 0, maxQueuedBytes: 1 }
    );
    const sink = new CompanionAudioPlaybackSink(stub.client);
    const session = await sink.createSession('read-1', TEST_FORMAT);
    await session.write(pcmForMs(100));

    const completions: string[] = [];
    session.onCompleted((id) => completions.push(id));

    await session.dispose();
    expect(stub.calls.some((c) => c.method === 'audioStop')).toBe(true);

    stub.emit({ event: 'playbackCompleted', sessionId: 'read-1', positionMs: 10 });
    expect(completions).toEqual([]);

    // Post-dispose commands fail closed rather than reaching the companion.
    const callsAfterDispose = stub.calls.length;
    expect((await session.resume()).ok).toBe(false);
    expect(stub.calls).toHaveLength(callsAfterDispose);
  });
});
