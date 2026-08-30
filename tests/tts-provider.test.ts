import { CartesiaTtsProvider } from '../src/core/tts/providers/cartesia-provider';
import { ElevenLabsTtsProvider } from '../src/core/tts/providers/elevenlabs-provider';
import { OpenAiTtsProvider } from '../src/core/tts/providers/openai-provider';
import { TtsWordAlignment, TtsAudioChunk } from '../src/core/tts/provider-interface';

describe('TTS Providers', () => {
  test('Cartesia provider supports word timestamps and emits alignments', async () => {
    const provider = new CartesiaTtsProvider();
    expect(provider.supportsWordLevelTimestamps).toBe(true);

    const alignments: TtsWordAlignment[] = [];
    const chunks: TtsAudioChunk[] = [];

    await provider.synthesize(
      'ReadBridge is fast',
      { voiceId: 'test-voice' },
      (chunk) => chunks.push(chunk),
      (alignment) => alignments.push(alignment)
    );

    expect(alignments.length).toBe(3);
    expect(alignments[0].word).toBe('ReadBridge');
    expect(alignments[1].word).toBe('is');
    expect(alignments[2].word).toBe('fast');
    expect(alignments[0].audioStartMs).toBe(0);
    expect(alignments[1].audioStartMs).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(0);
  });

  // The simulator splits on whitespace; aggregating ElevenLabs character-level alignment arrays
  // into word bounds is Slice 2. The test name must not imply that derivation exists yet.
  test('ElevenLabs simulator declares word-timestamp support and emits word alignments', async () => {
    const provider = new ElevenLabsTtsProvider();
    expect(provider.supportsWordLevelTimestamps).toBe(true);

    const alignments: TtsWordAlignment[] = [];
    await provider.synthesize(
      'Natural AI Speech',
      { voiceId: 'test-voice' },
      () => {},
      (alignment) => alignments.push(alignment)
    );

    expect(alignments.length).toBe(3);
    expect(alignments[0].word).toBe('Natural');
    expect(alignments[1].word).toBe('AI');
    expect(alignments[2].word).toBe('Speech');
  });

  test('OpenAI provider indicates lack of native word timestamps', async () => {
    const provider = new OpenAiTtsProvider();
    expect(provider.supportsWordLevelTimestamps).toBe(false);

    const alignments: TtsWordAlignment[] = [];
    const chunks: TtsAudioChunk[] = [];

    await provider.synthesize(
      'Testing OpenAI TTS without timestamps',
      { voiceId: 'alloy' },
      (chunk) => chunks.push(chunk),
      (alignment) => alignments.push(alignment)
    );

    expect(alignments.length).toBe(0);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
