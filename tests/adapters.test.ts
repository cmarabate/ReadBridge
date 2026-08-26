import { BrowserDomAdapter } from '../src/adapters/browser-adapter';
import { ReaderFallbackAdapter } from '../src/adapters/fallback-adapter';
import { WindowsUiAutomationAdapter } from '../src/adapters/native-uia-adapter';

describe('TextSourceAdapters', () => {
  test('BrowserDomAdapter provides LEVEL A (SOURCE_NATIVE) capabilities', async () => {
    const adapter = new BrowserDomAdapter('https://news.ycombinator.com', 'Hacker News');
    const identity = await adapter.identifySource();
    expect(identity?.url).toBe('https://news.ycombinator.com');

    const caps = await adapter.getCapabilities();
    expect(caps.level).toBe('SOURCE_NATIVE');
    expect(caps.supportsClickToSeek).toBe(true);
    expect(caps.supportsWordGeometry).toBe(true);

    const doc = await adapter.getDocumentText();
    expect(doc?.sentences.length).toBeGreaterThan(0);
  });

  test('WindowsUiAutomationAdapter provides LEVEL B (UI_AUTOMATION) capabilities', async () => {
    const adapter = new WindowsUiAutomationAdapter();
    const caps = await adapter.getCapabilities();
    expect(caps.level).toBe('UI_AUTOMATION');
    expect(caps.supportsWordGeometry).toBe(true);
    expect(caps.supportsClickToSeek).toBe(false);

    const doc = await adapter.getSelection();
    expect(doc?.fullText).toContain('ReadBridge');
  });

  test('ReaderFallbackAdapter provides LEVEL C (READER_FALLBACK) capabilities', async () => {
    const adapter = new ReaderFallbackAdapter('Sample fallback text for narration', 'Test Doc');
    const caps = await adapter.getCapabilities();
    expect(caps.level).toBe('READER_FALLBACK');
    expect(caps.supportsWordGeometry).toBe(false);

    const doc = await adapter.getDocumentText();
    expect(doc?.title).toBe('Test Doc');
    expect(doc?.fullText).toBe('Sample fallback text for narration');
  });
});
