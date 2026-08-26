export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export interface TtsAudioChunk {
  audioData: Uint8Array;
  format: AudioFormat;
  durationMs: number;
  isFinal: boolean;
}

export interface TtsWordAlignment {
  word: string;
  charStart: number;
  charLength: number;
  audioStartMs: number;
  audioEndMs: number;
}

export interface TtsOptions {
  voiceId: string;
  modelId?: string;
  speakingRate?: number;
  pitch?: number;
}

export interface ITtsStreamSession {
  readonly sessionId: string;
  sendTextDelta(text: string, flush?: boolean): Promise<void>;
  completeInput(): Promise<void>;
  onAudioChunk(listener: (chunk: TtsAudioChunk) => void): () => void;
  onWordAlignment(listener: (alignment: TtsWordAlignment) => void): () => void;
  cancel(): Promise<void>;
}

export interface ITtsProvider {
  readonly providerId: string;
  readonly supportsWordLevelTimestamps: boolean;
  readonly supportsIncrementalStreaming: boolean;
  initialize(): Promise<void>;
  createStreamSession(options: TtsOptions): Promise<ITtsStreamSession>;
  synthesize(
    fullText: string,
    options: TtsOptions,
    onChunk: (chunk: TtsAudioChunk) => void,
    onAlignment: (alignment: TtsWordAlignment) => void
  ): Promise<void>;
}
