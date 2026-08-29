import {
  ITtsProvider,
  ITtsStreamSession,
  TtsAudioChunk,
  TtsOptions,
  TtsWordAlignment,
} from '../provider-interface.js';

/**
 * Architecture prototype and simulator for OpenAI Text-to-Speech (/v1/audio/speech).
 * Emulates the audio streaming contract while verifying that standard OpenAI TTS
 * lacks word-level timestamps (triggering Level C Reader Fallback).
 */
export class SimulatedOpenAiTtsProvider implements ITtsProvider {
  public readonly providerId = 'openai-simulator';
  // OpenAI standard TTS does not provide native word timestamps
  public readonly supportsWordLevelTimestamps = false;
  public readonly supportsIncrementalStreaming = false;

  private apiKey: string;

  constructor(apiKey: string = '') {
    this.apiKey = apiKey;
  }

  public async initialize(): Promise<void> {}

  public async createStreamSession(options: TtsOptions): Promise<ITtsStreamSession> {
    return new OpenAiStreamSession(options, this.apiKey);
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

class OpenAiStreamSession implements ITtsStreamSession {
  public readonly sessionId: string;
  private options: TtsOptions;
  private apiKey: string;
  private audioListeners: Array<(chunk: TtsAudioChunk) => void> = [];
  private isCancelled: boolean = false;

  constructor(options: TtsOptions, apiKey: string) {
    this.sessionId = `openai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.options = options;
    this.apiKey = apiKey;
  }

  public async sendTextDelta(_text: string, _flush: boolean = false): Promise<void> {
    if (this.isCancelled) return;

    // OpenAI streams raw audio chunk without word timestamp metadata
    const dummyAudio = new Uint8Array(2048);
    for (const listener of this.audioListeners) {
      listener({
        audioData: dummyAudio,
        format: { sampleRate: 24000, channels: 1, bitDepth: 16 },
        durationMs: 1200,
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

  public onWordAlignment(_listener: (alignment: TtsWordAlignment) => void): () => void {
    // OpenAI standard TTS does not support word alignment events
    return () => {};
  }

  public async cancel(): Promise<void> {
    this.isCancelled = true;
    this.audioListeners = [];
  }
}

export const OpenAiTtsProvider = SimulatedOpenAiTtsProvider;
export type OpenAiTtsProvider = SimulatedOpenAiTtsProvider;
