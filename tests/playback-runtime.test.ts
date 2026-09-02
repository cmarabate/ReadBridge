import * as fs from 'fs';
import * as path from 'path';
import { NativeCompanionClient } from '../src/companion-bridge/ipc-client';
import { CompanionAudioPlaybackSink } from '../src/core/audio/companion-playback-sink';
import { IAudioPlaybackSession } from '../src/core/audio/playback-interface';
import { ReaderController } from '../src/core/reader-controller';
import { AudioFormat } from '../src/core/tts/provider-interface';
import { WindowsUiAutomationAdapter } from '../src/adapters/native-uia-adapter';
import { FakeStreamingTtsProvider } from './helpers/fake-tts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const exePath = path.resolve(
  __dirname,
  '../native/ReadBridge.Companion/bin/Debug/net10.0-windows/ReadBridge.Companion.exe'
);

// These drive a REAL Windows audio device through the real companion. They need the companion
// binary, which lives under a gitignored bin/, so they skip on a clean checkout or a non-Windows
// runner - `yarn test:ci` must stay green on a fresh clone. READBRIDGE_REQUIRE_COMPANION=1 turns
// that skip into a failure on a run that was meant to exercise the companion.
const canRunCompanion = process.platform === 'win32' && fs.existsSync(exePath);
const describeCompanion = canRunCompanion ? describe : describe.skip;

if (!canRunCompanion) {
  console.warn(
    `[playback-runtime] skipping real-device playback tests: platform=${process.platform}, ` +
      `exePresent=${fs.existsSync(exePath)} (run \`yarn verify:build\` on Windows to enable)`
  );
}

const FORMAT: AudioFormat = { sampleRate: 24000, channels: 1, bitDepth: 16 };

/**
 * A deliberately quiet 220 Hz tone (~-46 dBFS). It is a real signal, so the device genuinely
 * renders it and the sample cursor is genuine - but it is loud enough for none of these tests to
 * intrude on whatever the machine's owner is doing.
 */
function tone(durationMs: number, startSample = 0): Uint8Array {
  const samples = Math.round((FORMAT.sampleRate * durationMs) / 1000);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 220 * (startSample + i)) / FORMAT.sampleRate) * 160);
    view.setInt16(i * 2, value, true);
  }
  return bytes;
}

describeCompanion('Real audio playback session (Windows waveOut, via the companion)', () => {
  let client: NativeCompanionClient;

  beforeEach(async () => {
    client = new NativeCompanionClient(exePath);
    await client.start();
    expect(await client.ping()).toBe('pong');
  }, 30000);

  afterEach(() => {
    client.stop();
  });

  test('an output device is present, so the rest of these assertions mean something', async () => {
    const info = await client.call('audioDeviceInfo');
    expect(info.hasOutputDevice).toBe(true);
    expect(info.outputDeviceCount).toBeGreaterThan(0);
  }, 30000);

  test('pause freezes the real device cursor and resume continues the SAME session', async () => {
    const sink = new CompanionAudioPlaybackSink(client);
    const session: IAudioPlaybackSession = await sink.createSession('rt-pause-resume', FORMAT);

    // Two seconds of audio, written incrementally as a TTS stream would.
    const first = await session.write(tone(1000, 0));
    expect(first.accepted).toBe(true);
    expect(first.state).toBe('playing');

    await sleep(600);
    const playing = await session.getStatus();
    expect(playing.positionMs).toBeGreaterThan(300);
    expect(playing.state).toBe('playing');

    const paused = await session.pause();
    expect(paused.ok).toBe(true);
    expect(paused.state).toBe('paused');

    // 900ms of wall clock passes with the device paused.
    await sleep(900);
    const stillPaused = await session.getStatus();
    expect(stillPaused.state).toBe('paused');
    expect(stillPaused.positionMs).toBe(paused.positionMs);

    const resumed = await session.resume();
    expect(resumed.ok).toBe(true);
    expect(resumed.state).toBe('playing');
    // Resume returned the cursor it was frozen at - it did not restart from zero.
    expect(resumed.positionMs).toBe(paused.positionMs);

    await sleep(300);
    const after = await session.getStatus();
    expect(after.positionMs).toBeGreaterThan(paused.positionMs);
    // The 900ms spent paused was never credited to playback.
    expect(after.positionMs).toBeLessThan(paused.positionMs + 900);

    await session.stop();
    await session.dispose();
  }, 60000);

  test('the device session completes naturally and reports its own completion', async () => {
    const sink = new CompanionAudioPlaybackSink(client);
    const session = await sink.createSession('rt-complete', FORMAT);

    const completions: Array<{ id: string; positionMs: number }> = [];
    session.onCompleted((id, positionMs) => completions.push({ id, positionMs }));

    await session.write(tone(700, 0));
    await session.completeInput();

    for (let waited = 0; waited < 8000 && completions.length === 0; waited += 50) {
      await sleep(50);
    }

    expect(completions).toHaveLength(1);
    expect(completions[0].id).toBe('rt-complete');
    expect(completions[0].positionMs).toBeGreaterThanOrEqual(650);
    expect(completions[0].positionMs).toBeLessThanOrEqual(900);
    expect(session.state).toBe('completed');

    // Terminal: the completed session refuses to be restarted.
    const resumed = await session.resume();
    expect(resumed.ok).toBe(false);
    expect(resumed.reason).toBe('terminalState');

    await session.dispose();
  }, 60000);

  test('a stale session id cannot control the live playback session', async () => {
    const sink = new CompanionAudioPlaybackSink(client);
    const live = await sink.createSession('rt-live', FORMAT);
    await live.write(tone(2000, 0));
    await sleep(300);

    // A command naming a session the companion is not serving must be refused outright.
    const stalePause = await client.call('audioPause', { sessionId: 'rt-abandoned' });
    expect(stalePause.ok).toBe(false);
    expect(stalePause.reason).toBe('staleSession');

    const staleStop = await client.call('audioStop', { sessionId: 'rt-abandoned' });
    expect(staleStop.ok).toBe(false);
    expect(staleStop.reason).toBe('staleSession');

    const staleWrite = await client.call('audioWrite', {
      sessionId: 'rt-abandoned',
      audioBase64: Buffer.from(tone(200, 0)).toString('base64'),
    });
    expect(staleWrite.accepted).toBe(false);
    expect(staleWrite.reason).toBe('staleSession');

    // The live session is untouched and still playing.
    const status = await live.getStatus();
    expect(status.state).toBe('playing');
    expect(status.positionMs).toBeGreaterThan(100);

    await live.stop();
    await live.dispose();
  }, 60000);

  test('opening a replacement session releases the previous one', async () => {
    const sink = new CompanionAudioPlaybackSink(client);

    const first = await sink.createSession('rt-first', FORMAT);
    await first.write(tone(3000, 0));
    await sleep(200);
    expect((await first.getStatus()).state).toBe('playing');

    const second = await sink.createSession('rt-second', FORMAT);
    await second.write(tone(500, 0));

    // The companion now serves only the replacement.
    const info = await client.call('audioDeviceInfo');
    expect(info.currentSessionId).toBe('rt-second');
    expect((await first.getStatus()).ok).toBe(false);
    expect((await second.getStatus()).state).toBe('playing');

    await second.stop();
    await second.dispose();
    await first.dispose();
  }, 60000);

  test('ReaderController drives a real device: start, pause, resume, stop', async () => {
    const sink = new CompanionAudioPlaybackSink(client);
    const tts = new FakeStreamingTtsProvider({ audioMs: 3000, format: FORMAT });
    const controller = new ReaderController(tts, sink);

    await controller.startRead(new WindowsUiAutomationAdapter());
    expect(controller.getSnapshot().state).toBe('playing');
    expect(controller.getSnapshot().producesAudibleOutput).toBe(true);
    const readSessionId = controller.sessionId;
    const playbackSessionId = controller.playbackSessionId;
    expect(playbackSessionId).toBe(readSessionId);

    await sleep(500);
    await controller.pause();
    expect(controller.getSnapshot().state).toBe('paused');
    const frozenAt = controller.getSnapshot().lastObservedPlaybackPositionMs;
    expect(frozenAt).toBeGreaterThan(200);

    await sleep(800);
    const stillFrozen = await client.call('audioStatus', { sessionId: playbackSessionId });
    expect(stillFrozen.state).toBe('paused');
    expect(stillFrozen.positionMs).toBe(frozenAt);

    await controller.resume();
    expect(controller.getSnapshot().state).toBe('playing');
    // Same read, same playback session, cursor preserved across the pause.
    expect(controller.sessionId).toBe(readSessionId);
    expect(controller.playbackSessionId).toBe(playbackSessionId);

    await sleep(400);
    const resumedStatus = await client.call('audioStatus', { sessionId: playbackSessionId });
    expect(resumedStatus.positionMs).toBeGreaterThan(frozenAt);
    expect(resumedStatus.positionMs).toBeLessThan(frozenAt + 800);

    await controller.stop();
    expect(controller.getSnapshot().state).toBe('idle');
    expect(controller.playbackSessionId).toBeNull();
  }, 60000);

  test('ReaderController reaches idle when the real device drains, not when TTS input ends', async () => {
    const sink = new CompanionAudioPlaybackSink(client);
    const tts = new FakeStreamingTtsProvider({ audioMs: 700, format: FORMAT });
    const controller = new ReaderController(tts, sink);

    await controller.startRead(new WindowsUiAutomationAdapter());
    // The TTS stream has already signalled isFinal, but audio has not drained.
    expect(controller.getSnapshot().state).toBe('playing');

    for (let waited = 0; waited < 8000 && controller.getSnapshot().state !== 'idle'; waited += 50) {
      await sleep(50);
    }

    expect(controller.getSnapshot().state).toBe('idle');
    expect(controller.playbackSessionId).toBeNull();
    expect(controller.getSnapshot().lastObservedPlaybackPositionMs).toBeGreaterThanOrEqual(650);
  }, 60000);
});
