import { WindowsUiAutomationAdapter } from '../src/adapters/native-uia-adapter';
import {
  IAudioPlaybackSession,
  IAudioPlaybackSink,
} from '../src/core/audio/playback-interface';
import {
  SimulatedAudioPlaybackSession,
  SimulatedAudioPlaybackSink,
} from '../src/core/audio/simulated-playback-sink';
import { UnarbitratedAudioFocusCoordinator } from '../src/core/focus/audio-focus-contract';
import { readVmbEndpointDescriptor } from '../src/core/focus/vmb-focus-client';
import { ReaderController } from '../src/core/reader-controller';
import { AudioFormat } from '../src/core/tts/provider-interface';
import { fakeClock } from './helpers/fake-tts';
import { FakeAudioFocusCoordinator } from './helpers/fake-focus';
import { PacedTtsProvider, PacedTtsStreamSession, settleAsyncWork } from './helpers/paced-tts';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface Harness {
  controller: ReaderController;
  sink: SimulatedAudioPlaybackSink;
  provider: PacedTtsProvider;
  focus: FakeAudioFocusCoordinator;
  log: string[];
  clock: { now: () => number; advance: (ms: number) => void };
}

function build(options: {
  chunkCount?: number;
  chunkMs?: number;
  initialGrants?: number;
  failPlaybackOpen?: boolean;
} = {}): Harness {
  const clock = fakeClock();
  const log: string[] = [];
  const focus = new FakeAudioFocusCoordinator(log);
  const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
  const provider = new PacedTtsProvider({
    chunkCount: options.chunkCount ?? 40,
    chunkMs: options.chunkMs ?? 500,
    initialGrants: options.initialGrants,
  });

  const wrappedSink: IAudioPlaybackSink = {
    sinkId: sink.sinkId,
    producesAudibleOutput: sink.producesAudibleOutput,
    createSession: async (id: string, format: AudioFormat): Promise<IAudioPlaybackSession> => {
      log.push('playback:open');
      if (options.failPlaybackOpen) {
        throw new Error('the output device could not be opened');
      }

      const session = (await sink.createSession(id, format)) as SimulatedAudioPlaybackSession;
      return new Proxy(session, {
        get(target, prop, receiver) {
          if (prop === 'pause' || prop === 'resume') {
            return async () => {
              log.push(`playback:${String(prop)}`);
              return (target as any)[prop]();
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as unknown as IAudioPlaybackSession;
    },
  };

  const controller = new ReaderController(provider, wrappedSink, focus);
  controller.onStateChange((snap) => log.push(`state:${snap.state}`));

  return { controller, sink, provider, focus, log, clock };
}

const streamOf = (h: Harness): PacedTtsStreamSession => h.provider.sessions[h.provider.sessions.length - 1];
const playbackOf = (h: Harness): SimulatedAudioPlaybackSession => h.sink.sessions[h.sink.sessions.length - 1];

describe('Focus is settled before ReadBridge is ever audible', () => {
  test('1 & 2. focus is requested BEFORE the output is opened, and a grant permits playback', async () => {
    const h = build();
    await h.controller.startRead(new WindowsUiAutomationAdapter());

    const requestIndex = h.log.indexOf(`focus:request(${h.controller.sessionId})`);
    const openIndex = h.log.indexOf('playback:open');

    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(requestIndex).toBeLessThan(openIndex);

    expect(h.controller.getSnapshot().state).toBe('playing');
    expect(h.controller.getSnapshot().focusArbitrated).toBe(true);
    expect(h.controller.getSnapshot().holdsAudioFocus).toBe(true);
  });

  test.each([
    ['blockedByHigherFocus'],
    ['classConflict'],
    ['unavailable'],
  ])('3, 4 & 5. a %s answer produces ZERO audible playback', async (outcome) => {
    const h = build();
    h.focus.nextOutcome = outcome as any;

    await expect(h.controller.startRead(new WindowsUiAutomationAdapter())).rejects.toThrow(
      /Audio focus was not granted/
    );

    // No output was ever opened, so nothing could have been heard.
    expect(h.log).not.toContain('playback:open');
    expect(h.sink.sessions).toHaveLength(0);
    expect(h.controller.getSnapshot().state).toBe('error');
    expect(h.controller.getSnapshot().holdsAudioFocus).toBe(false);
  });

  test('5b. an unreachable authority is a refusal, never a licence to play', async () => {
    const h = build();
    h.focus.nextOutcome = 'unavailable';

    await expect(h.controller.startRead(new WindowsUiAutomationAdapter())).rejects.toThrow(/unavailable/);
    expect(h.sink.sessions).toHaveLength(0);
  });

  test('6. a grant followed by a failed output open hands the focus straight back', async () => {
    const h = build({ failPlaybackOpen: true });

    await expect(h.controller.startRead(new WindowsUiAutomationAdapter())).rejects.toThrow(
      /could not be opened/
    );

    // The user's background media must not stay paused for a read that never spoke.
    expect(h.focus.released).toEqual(h.focus.requested);
    expect(h.controller.getSnapshot().holdsAudioFocus).toBe(false);
  });

  test('a controller with no coordinator is standalone, and says so on its snapshot', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const controller = new ReaderController(new PacedTtsProvider({ chunkCount: 4, chunkMs: 500 }), sink);

    await controller.startRead(new WindowsUiAutomationAdapter());

    expect(controller.isFocusArbitrated).toBe(false);
    expect(controller.getSnapshot().focusArbitrated).toBe(false);
    expect(controller.getSnapshot().state).toBe('playing');
  });

  test('the explicit unarbitrated coordinator is not mistaken for an authority', async () => {
    const clock = fakeClock();
    const sink = new SimulatedAudioPlaybackSink({ now: clock.now });
    const controller = new ReaderController(
      new PacedTtsProvider({ chunkCount: 4, chunkMs: 500 }),
      sink,
      new UnarbitratedAudioFocusCoordinator()
    );

    expect(controller.isFocusArbitrated).toBe(false);
    await controller.startRead(new WindowsUiAutomationAdapter());
    expect(controller.getSnapshot().focusArbitrated).toBe(false);
  });
});

describe('Participant identity is the exact read', () => {
  test('7 & 8. each read is its own participant, and a replacement gets a different one', async () => {
    const h = build();

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const first = h.controller.sessionId;
    expect(h.focus.requested).toEqual([first]);

    await h.controller.stop();
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const second = h.controller.sessionId;

    expect(second).not.toBe(first);
    expect(h.focus.requested).toEqual([first, second]);
    expect(h.focus.released).toContain(first);
  });

  test('9 & 10. a command naming a stale read is refused and never touches the live one', async () => {
    const h = build();

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const stale = h.controller.sessionId;
    await h.controller.stop();

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const live = h.controller.sessionId;
    h.clock.advance(300);

    expect(await h.focus.command('suspend', stale)).toBe('participantUnavailable');
    expect(await h.focus.command('resume', stale)).toBe('participantUnavailable');

    // The live read is untouched: still playing, same session, cursor still moving.
    expect(h.controller.getSnapshot().state).toBe('playing');
    expect(h.controller.sessionId).toBe(live);
    h.clock.advance(200);
    expect(playbackOf(h).lastObservedPositionMs).toBe(500);
  });
});

describe('An authority-ordered suspension', () => {
  test('11-16. SUSPEND quiesces TTS, freezes alignment and the cursor, ACKs only after, and releases nothing', async () => {
    const h = build({ chunkCount: 200, initialGrants: 4 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const readId = h.controller.sessionId;
    const stream = streamOf(h);
    const playback = playbackOf(h);

    h.clock.advance(400);
    const cursorBefore = playback.lastObservedPositionMs;
    const deliveredBefore = stream.deliveredCount;
    const wordBefore = h.controller.getSnapshot().currentWord;
    const releasesBefore = h.focus.released.length;

    expect(await h.focus.command('suspend', readId)).toBe('applied');

    // The ACK only came back after all three were true.
    expect(h.controller.getSnapshot().state).toBe('paused');
    expect(h.controller.getSnapshot().pausedByAudioFocus).toBe(true);
    expect(stream.outputFlowState).toBe('suspended');
    expect(playback.state).toBe('paused');

    // And they stay true: a large authorised burst and a long wait change nothing.
    stream.grantProduction(400);
    h.clock.advance(120_000);
    await settleAsyncWork(40);

    expect(stream.deliveredCount).toBe(deliveredBefore);
    expect(playback.lastObservedPositionMs).toBe(cursorBefore);
    expect(h.controller.getSnapshot().currentWord).toBe(wordBefore);

    // A preemption is not an ending: focus is deliberately retained.
    expect(h.focus.released).toHaveLength(releasesBefore);
    expect(h.controller.getSnapshot().holdsAudioFocus).toBe(true);

    // The ordering the authority relies on: upstream first, then the device.
    const suspendAt = h.log.lastIndexOf(`command:suspend(${readId})`);
    const tail = h.log.slice(suspendAt);
    expect(tail.indexOf('playback:pause')).toBeGreaterThan(-1);
    expect(tail.indexOf('ack:applied')).toBeGreaterThan(tail.indexOf('playback:pause'));
  });

  test('17-23. RESUME restores the same read, TTS session, playback session and cursor, asking for nothing new', async () => {
    const h = build({ chunkCount: 200, initialGrants: 4 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const readId = h.controller.sessionId;
    const playbackId = h.controller.playbackSessionId;
    const stream = streamOf(h);
    const playback = playbackOf(h);

    h.clock.advance(400);
    await h.focus.command('suspend', readId);

    const frozenCursor = playback.lastObservedPositionMs;
    const chunksAtSuspend = [...stream.deliveredChunkIndices];
    const requestsBefore = h.focus.requested.length;

    h.clock.advance(30_000);
    stream.resetProduction();

    expect(await h.focus.command('resume', readId)).toBe('applied');

    expect(h.controller.getSnapshot().state).toBe('playing');
    expect(h.controller.sessionId).toBe(readId);
    expect(h.controller.playbackSessionId).toBe(playbackId);
    expect(h.provider.sessions).toHaveLength(1);
    expect(h.sink.sessions).toHaveLength(1);
    expect(stream.outputFlowState).toBe('running');

    // No new focus request during a restoration: the authority already restored us.
    expect(h.focus.requested).toHaveLength(requestsBefore);

    // The cursor continued rather than restarting, and the 30s pause was not credited.
    h.clock.advance(300);
    expect(playback.lastObservedPositionMs).toBe(frozenCursor + 300);

    // Delivery continues at the exact next item, with no duplicate and no skip.
    stream.grantProduction(6);
    await settleAsyncWork(20);
    expect(stream.deliveredChunkIndices.slice(0, chunksAtSuspend.length)).toEqual(chunksAtSuspend);
    expect(new Set(stream.deliveredChunkIndices).size).toBe(stream.deliveredChunkIndices.length);
  });

  test('a SUSPEND the output refuses is answered honestly, not acknowledged as applied', async () => {
    const h = build({ chunkCount: 40 });
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const readId = h.controller.sessionId;

    // Take the playback session out from under the controller, so the suspension cannot
    // truthfully happen.
    await h.controller.stop();

    expect(await h.focus.command('suspend', readId)).toBe('participantUnavailable');
  });
});

describe('A user pause is not a preemption', () => {
  test('24, 25 & 26. a user pause suspends truthfully and then GIVES FOCUS BACK', async () => {
    const h = build({ chunkCount: 200, initialGrants: 4 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const readId = h.controller.sessionId;
    const playback = playbackOf(h);

    h.clock.advance(400);
    await h.controller.pause();

    expect(h.controller.getSnapshot().state).toBe('paused');
    expect(streamOf(h).outputFlowState).toBe('suspended');
    expect(playback.state).toBe('paused');

    // Focus released, so the user's background media is free to come back.
    expect(h.focus.released).toEqual([readId]);
    expect(h.controller.getSnapshot().holdsAudioFocus).toBe(false);
    expect(h.controller.getSnapshot().pausedByAudioFocus).toBe(false);

    // Releasing focus did not put any audio back.
    h.clock.advance(5000);
    expect(playback.lastObservedPositionMs).toBe(400);
    expect(h.controller.getSnapshot().state).toBe('paused');
  });

  test('27. a user resume reacquires focus BEFORE anything becomes audible', async () => {
    const h = build({ chunkCount: 200, initialGrants: 4 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    h.clock.advance(400);
    await h.controller.pause();

    h.log.length = 0;
    await h.controller.resume();

    const requestIndex = h.log.indexOf(`focus:request(${h.controller.sessionId})`);
    const resumeIndex = h.log.indexOf('playback:resume');
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(resumeIndex).toBeGreaterThan(requestIndex);

    expect(h.controller.getSnapshot().state).toBe('playing');
    expect(h.controller.getSnapshot().holdsAudioFocus).toBe(true);
  });

  test('28. a user resume that is refused focus stays paused and silent', async () => {
    const h = build({ chunkCount: 200, initialGrants: 4 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    h.clock.advance(400);
    await h.controller.pause();

    h.focus.nextOutcome = 'blockedByHigherFocus';
    await expect(h.controller.resume()).rejects.toThrow(/audio focus was not granted/i);

    expect(h.controller.getSnapshot().state).toBe('paused');
    expect(playbackOf(h).state).toBe('paused');
    h.clock.advance(3000);
    expect(playbackOf(h).lastObservedPositionMs).toBe(400);
  });

  test('a stale restoration cannot undo a pause the user took over', async () => {
    const h = build({ chunkCount: 200, initialGrants: 4 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const readId = h.controller.sessionId;
    h.clock.advance(400);

    // The authority preempts, and the user then takes the pause over as their own.
    await h.focus.command('suspend', readId);
    expect(h.controller.getSnapshot().pausedByAudioFocus).toBe(true);

    await h.controller.pause();
    expect(h.controller.getSnapshot().pausedByAudioFocus).toBe(false);
    expect(h.focus.released).toContain(readId);

    // A later restoration is refused, so the authority can invalidate that phantom
    // participant rather than putting audio back the user did not ask for.
    expect(await h.focus.command('resume', readId)).toBe('rejected');
    expect(h.controller.getSnapshot().state).toBe('paused');
    h.clock.advance(3000);
    expect(playbackOf(h).lastObservedPositionMs).toBe(400);
  });
});

describe('Ending a read releases its focus exactly once', () => {
  test('30. natural completion releases focus once', async () => {
    const h = build({ chunkCount: 1, chunkMs: 500 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const readId = h.controller.sessionId;

    for (let i = 0; i < 60 && h.controller.getSnapshot().state !== 'idle'; i++) {
      await settleAsyncWork(2);
      h.clock.advance(500);
      await playbackOf(h).getStatus();
    }

    expect(h.controller.getSnapshot().state).toBe('idle');
    await settleAsyncWork(4);
    expect(h.focus.released.filter((id) => id === readId)).toHaveLength(1);
  });

  test('31. an explicit stop releases focus once', async () => {
    const h = build();
    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const readId = h.controller.sessionId;

    await h.controller.stop();
    await h.controller.stop();

    expect(h.focus.released.filter((id) => id === readId)).toHaveLength(1);
  });

  test('32. stopping while preempted releases the exact preempted participant', async () => {
    const h = build({ chunkCount: 200, initialGrants: 4 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const readId = h.controller.sessionId;
    h.clock.advance(300);
    await h.focus.command('suspend', readId);
    expect(h.focus.released).toHaveLength(0);

    await h.controller.stop();

    expect(h.focus.released).toEqual([readId]);
    expect(h.controller.getSnapshot().state).toBe('idle');

    // And a restoration for that dead participant is refused, so the authority skips it.
    expect(await h.focus.command('resume', readId)).toBe('participantUnavailable');
  });
});

describe('Losing the focus authority fails safe', () => {
  test('34, 35 & 36. a lost connection suspends audio and does not resume itself', async () => {
    const h = build({ chunkCount: 200, initialGrants: 4 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    const readId = h.controller.sessionId;
    const stream = streamOf(h);
    const playback = playbackOf(h);

    h.clock.advance(400);
    h.focus.dropConnection();
    await settleAsyncWork(10);

    // Silent, and honest about why.
    expect(playback.state).toBe('paused');
    expect(stream.outputFlowState).toBe('suspended');
    expect(h.controller.getSnapshot().state).toBe('error');
    expect(h.controller.getSnapshot().error).toMatch(/audio-focus authority became unreachable/i);
    expect(h.controller.getSnapshot().holdsAudioFocus).toBe(false);

    // Time passing alone does not put audio back.
    h.clock.advance(60_000);
    await settleAsyncWork(10);
    expect(playback.lastObservedPositionMs).toBe(400);

    // And neither does a restoration command arriving after a reconnect. The read still
    // exists, so the honest answer is a refusal - which lets the authority invalidate
    // that phantom participant rather than believing it restored something.
    expect(await h.focus.command('resume', readId)).toBe('rejected');
    expect(playback.lastObservedPositionMs).toBe(400);
  });

  test('a user resume after an authority loss must reacquire focus, not trust a stale hold', async () => {
    const h = build({ chunkCount: 200, initialGrants: 4 });

    await h.controller.startRead(new WindowsUiAutomationAdapter());
    h.clock.advance(400);

    // The authority vanishes; the reader falls silent and its hold is gone.
    h.focus.dropConnection();
    await settleAsyncWork(10);
    expect(h.controller.getSnapshot().state).toBe('error');

    // Even if the coordinator were to claim the hold again, a resume must ask.
    const requestsBefore = h.focus.requested.length;
    await h.controller.stop();
    await h.controller.startRead(new WindowsUiAutomationAdapter());

    expect(h.focus.requested.length).toBeGreaterThan(requestsBefore);
    expect(h.controller.getSnapshot().holdsAudioFocus).toBe(true);
  });

  test('a connection lost while nothing is playing changes no state', async () => {
    const h = build();

    h.focus.dropConnection();
    await settleAsyncWork(4);

    expect(h.controller.getSnapshot().state).toBe('idle');
  });
});

describe('Endpoint discovery refuses what it cannot trust', () => {
  function withDescriptor(descriptor: unknown): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-endpoint-'));
    fs.writeFileSync(path.join(root, 'audio-focus-endpoint.json'), JSON.stringify(descriptor));
    return root;
  }

  test('a well-formed descriptor naming the installed host is accepted', () => {
    const root = withDescriptor({ protocolVersion: 1, pipeName: 'VoiceMediaBridge.AudioFocus.v1.abcdef012345', executablePath: '' });
    const exe = path.join(root, 'VoiceMediaBridge.NativeHost.exe');
    fs.writeFileSync(path.join(root, 'audio-focus-endpoint.json'), JSON.stringify({
      protocolVersion: 1,
      pipeName: 'VoiceMediaBridge.AudioFocus.v1.abcdef012345',
      executablePath: exe,
    }));

    const descriptor = readVmbEndpointDescriptor(root);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.executablePath).toBe(path.resolve(exe));
  });

  test('an executable outside the install root is refused', () => {
    // The descriptor is user-writable and this client LAUNCHES what it names, so a path
    // pointing anywhere else is a hidden-process-launch primitive.
    const root = withDescriptor({
      protocolVersion: 1,
      pipeName: 'VoiceMediaBridge.AudioFocus.v1.abcdef012345',
      executablePath: 'C:\Windows\System32\cmd.exe',
    });

    expect(readVmbEndpointDescriptor(root)).toBeNull();
  });

  test('a different executable name inside the install root is refused', () => {
    const root = withDescriptor({ protocolVersion: 1, pipeName: 'VoiceMediaBridge.AudioFocus.v1.abcdef012345', executablePath: '' });
    fs.writeFileSync(path.join(root, 'audio-focus-endpoint.json'), JSON.stringify({
      protocolVersion: 1,
      pipeName: 'VoiceMediaBridge.AudioFocus.v1.abcdef012345',
      executablePath: path.join(root, 'evil.exe'),
    }));

    expect(readVmbEndpointDescriptor(root)).toBeNull();
  });

  test.each([
    ['..\..\somewhere'],
    ['VoiceMediaBridge.AudioFocus.v1.abcdef012345\..\other'],
    ['arbitrary-pipe-name'],
    ['VoiceMediaBridge.AudioFocus.vX.abcdef012345'],
  ])('a pipe name of %p is refused', (pipeName) => {
    const root = withDescriptor({ protocolVersion: 1, pipeName, executablePath: '' });
    fs.writeFileSync(path.join(root, 'audio-focus-endpoint.json'), JSON.stringify({
      protocolVersion: 1,
      pipeName,
      executablePath: path.join(root, 'VoiceMediaBridge.NativeHost.exe'),
    }));

    expect(readVmbEndpointDescriptor(root)).toBeNull();
  });

  test('a missing descriptor is simply absent, not an exception', () => {
    expect(readVmbEndpointDescriptor(path.join(os.tmpdir(), 'rb-no-such-root'))).toBeNull();
  });
});
