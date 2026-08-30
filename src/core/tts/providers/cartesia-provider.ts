import {
  ITtsProvider,
  ITtsStreamSession,
  TtsAudioChunk,
  TtsOptions,
  TtsWordAlignment,
} from '../provider-interface.js';

/**
 * Architecture prototype and simulator for Cartesia Sonic Text-to-Speech.
 * Emulates the streaming word-level timestamp alignment contract of the Cartesia WebSocket API
 * for architecture and controller testing. (Live network client is implemented in Slice 2).
 */
export class SimulatedCartesiaTtsProvider implements ITtsProvider {
  public readonly providerId = 'cartesia-simulator';
  public readonly supportsWordLevelTimestamps = true;
  public readonly supportsIncrementalStreaming = true;

  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string = '', baseUrl: string = 'wss://api.cartesia.ai/tts/websocket') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  public async initialize(): Promise<void> {
    // Validate credentials / preheat websocket pool if needed
  }

  public async createStreamSession(options: TtsOptions): Promise<ITtsStreamSession> {
    return new CartesiaStreamSession(options, this.apiKey, this.baseUrl);
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

class CartesiaStreamSession implements ITtsStreamSession {
  public readonly sessionId: string;
  private options: TtsOptions;
  private apiKey: string;
  private baseUrl: string;
  private audioListeners: Array<(chunk: TtsAudioChunk) => void> = [];
  private alignmentListeners: Array<(alignment: TtsWordAlignment) => void> = [];
  private isCancelled: boolean = false;

  constructor(options: TtsOptions, apiKey: string, baseUrl: string) {
    this.sessionId = `cartesia-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.options = options;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  public async sendTextDelta(text: string, _flush: boolean = false): Promise<void> {
    if (this.isCancelled) return;

    // Simulation / integration parsing word boundaries and calculating timing
    const words = text.split(/\s+/).filter(Boolean);
    let currentOffset = 0;
    let currentAudioTime = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const charStart = text.indexOf(word, currentOffset);
      const charLength = word.length;
      currentOffset = charStart + charLength;

      // Realistic speech duration calculation (~180ms - 350ms per word based on length)
      const duration = Math.max(160, word.length * 55);
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

    // Emit synthesized PCM audio chunk representation
    const dummyAudio = new Uint8Array(1024);
    for (const listener of this.audioListeners) {
      listener({
        audioData: dummyAudio,
        format: { sampleRate: 24000, channels: 1, bitDepth: 16 },
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
        format: { sampleRate: 24000, channels: 1, bitDepth: 16 },
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

export const CartesiaTtsProvider = SimulatedCartesiaTtsProvider;
export type CartesiaTtsProvider = SimulatedCartesiaTtsProvider;
