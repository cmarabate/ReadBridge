import {
  ITtsProvider,
  ITtsStreamSession,
  TtsAudioChunk,
  TtsOptions,
  TtsWordAlignment,
} from '../provider-interface.js';

/**
 * Architecture prototype and simulator for ElevenLabs Text-to-Speech.
 * Emulates the streaming character/word alignment contract of ElevenLabs WebSockets
 * for architecture and controller testing. (Live network client is implemented in Slice 2).
 */
export class SimulatedElevenLabsTtsProvider implements ITtsProvider {
  public readonly providerId = 'elevenlabs-simulator';
  public readonly supportsWordLevelTimestamps = true;
  public readonly supportsIncrementalStreaming = true;

  private apiKey: string;

  constructor(apiKey: string = '') {
    this.apiKey = apiKey;
  }

  public async initialize(): Promise<void> {}

  public async createStreamSession(options: TtsOptions): Promise<ITtsStreamSession> {
    return new ElevenLabsStreamSession(options, this.apiKey);
  }

  public async synthesize(
    fullText: string,
    options: TtsOptions,
    onChunk: (chunk: TtsAudioChunk) => void,
    onAlignment: (alignment: TtsWordAlignment) => void
  ): Promise<void> {
    const session = await this.createStreamSession(options);
    session.onAudioChunk(onChunk);
    session.onWordAlignment(onAlignment);
    await session.sendTextDelta(fullText, true);
    await session.completeInput();
  }
}

class ElevenLabsStreamSession implements ITtsStreamSession {
  public readonly sessionId: string;
  private options: TtsOptions;
  private apiKey: string;
  private audioListeners: Array<(chunk: TtsAudioChunk) => void> = [];
  private alignmentListeners: Array<(alignment: TtsWordAlignment) => void> = [];
  private isCancelled: boolean = false;

  constructor(options: TtsOptions, apiKey: string) {
    this.sessionId = `elevenlabs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.options = options;
    this.apiKey = apiKey;
  }

  public async sendTextDelta(text: string, _flush: boolean = false): Promise<void> {
    if (this.isCancelled) return;

    // ElevenLabs streams character-level alignments; aggregate into word bounds
    const words = text.split(/\s+/).filter(Boolean);
    let currentOffset = 0;
    let currentAudioTime = 0;

    for (const word of words) {
      const charStart = text.indexOf(word, currentOffset);
      const charLength = word.length;
      currentOffset = charStart + charLength;

      const duration = Math.max(170, word.length * 60);
      const alignment: TtsWordAlignment = {
        word,
        charStart,
        charLength,
        audioStartMs: currentAudioTime,
        audioEndMs: currentAudioTime + duration,
      };

      currentAudioTime += duration;
      for (const listener of this.alignmentListeners) {
        listener(alignment);
      }
    }

    const dummyAudio = new Uint8Array(1024);
    for (const listener of this.audioListeners) {
      listener({
        audioData: dummyAudio,
        format: { sampleRate: 44100, channels: 1, bitDepth: 16 },
        durationMs: currentAudioTime,
        isFinal: false,
      });
    }
  }

  public async completeInput(): Promise<void> {
    if (this.isCancelled) return;
    for (const listener of this.audioListeners) {
      listener({
        audioData: new Uint8Array(0),
        format: { sampleRate: 44100, channels: 1, bitDepth: 16 },
        durationMs: 0,
        isFinal: true,
      });
    }
  }

  public onAudioChunk(listener: (chunk: TtsAudioChunk) => void): () => void {
    this.audioListeners.push(listener);
    return () => {
      this.audioListeners = this.audioListeners.filter((l) => l !== listener);
    };
  }

  public onWordAlignment(listener: (alignment: TtsWordAlignment) => void): () => void {
    this.alignmentListeners.push(listener);
    return () => {
      this.alignmentListeners = this.alignmentListeners.filter((l) => l !== listener);
    };
  }

  public async cancel(): Promise<void> {
    this.isCancelled = true;
    this.audioListeners = [];
    this.alignmentListeners = [];
  }
}

export const ElevenLabsTtsProvider = SimulatedElevenLabsTtsProvider;
export type ElevenLabsTtsProvider = SimulatedElevenLabsTtsProvider;
