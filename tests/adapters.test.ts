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

  // Regression guard: sentence offsets were resolved with a bare indexOf(), which returns the
  // FIRST occurrence. Any repeated sentence therefore reported the first copy's offset, which
  // propagates into currentSentenceIndex and the highlight geometry derived from it.
  test('repeated sentences get their own character offsets, not the first occurrence', async () => {
    const fullText = 'Go now. Stop. Go now.';
    const adapter = new ReaderFallbackAdapter(fullText, 'Repeats');
    const doc = await adapter.getDocumentText();

    expect(doc?.sentences.map((s) => s.text)).toEqual(['Go now.', 'Stop.', 'Go now.']);
    expect(doc?.sentences.map((s) => s.charStart)).toEqual([0, 8, 14]);

    // Each recorded offset must actually address its own sentence in the source text.
    for (const s of doc!.sentences) {
      expect(fullText.slice(s.charStart, s.charStart + s.charLength)).toBe(s.text);
    }
  });
});
