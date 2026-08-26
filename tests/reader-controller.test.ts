import { ReaderController } from '../src/core/reader-controller';
import { CartesiaTtsProvider } from '../src/core/tts/providers/cartesia-provider';
import { OpenAiTtsProvider } from '../src/core/tts/providers/openai-provider';
import { BrowserDomAdapter } from '../src/adapters/browser-adapter';
import { ReaderFallbackAdapter } from '../src/adapters/fallback-adapter';
import { WindowsUiAutomationAdapter } from '../src/adapters/native-uia-adapter';

describe('ReaderController', () => {
  test('starts playback and receives word highlights in SOURCE_OVERLAY mode', async () => {
    const tts = new CartesiaTtsProvider();
    const controller = new ReaderController(tts);
    const adapter = new BrowserDomAdapter();

    const highlights: any[] = [];
    controller.onHighlight((h) => {
      if (h) highlights.push(h);
    });

    await controller.startRead(adapter);

    const snap = controller.getSnapshot();
    expect(snap.state).toBe('idle'); // Completed playback
    expect(snap.followMode).toBe('SOURCE_OVERLAY');
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0].rects.length).toBeGreaterThan(0);
  });

  test('falls back to READER_SURFACE mode when using fallback adapter', async () => {
    const tts = new CartesiaTtsProvider();
    const controller = new ReaderController(tts);
    const adapter = new ReaderFallbackAdapter('This is a test paragraph for fallback mode.');

    await controller.startRead(adapter);
    const snap = controller.getSnapshot();
    expect(snap.followMode).toBe('READER_SURFACE');
  });

  test('falls back to READER_SURFACE mode when TTS provider does not support timestamps', async () => {
    const tts = new OpenAiTtsProvider(); // No timestamps
    const controller = new ReaderController(tts);
    const adapter = new WindowsUiAutomationAdapter();

    await controller.startRead(adapter);
    const snap = controller.getSnapshot();
    expect(snap.followMode).toBe('READER_SURFACE');
  });

  test('pause and resume state machine operations work as expected', async () => {
    // Custom mock provider that does not auto-complete immediately
    const mockProvider = {
      providerId: 'mock',
      supportsWordLevelTimestamps: true,
      supportsIncrementalStreaming: true,
      initialize: jest.fn().mockResolvedValue(undefined),
      createStreamSession: jest.fn().mockResolvedValue({
        sessionId: 'mock-session',
        sendTextDelta: jest.fn().mockResolvedValue(undefined),
        completeInput: jest.fn().mockResolvedValue(undefined),
        onAudioChunk: jest.fn(),
        onWordAlignment: jest.fn(),
        cancel: jest.fn().mockResolvedValue(undefined),
      }),
      synthesize: jest.fn().mockResolvedValue(undefined),
    };

    const controller = new ReaderController(mockProvider);
    const adapter = new WindowsUiAutomationAdapter();

    await controller.startRead(adapter);
    expect(controller.getSnapshot().state).toBe('playing');

    await controller.pause();
    expect(controller.getSnapshot().state).toBe('paused');

    await controller.resume();
    expect(controller.getSnapshot().state).toBe('playing');

    await controller.stop();
    expect(controller.getSnapshot().state).toBe('idle');
  });
});
