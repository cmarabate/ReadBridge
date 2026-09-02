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

/**
 * Whether a stream session is currently delivering output.
 *
 * `terminal` means the session is cancelled or finished: there is no output left to gate, and
 * flow-control calls become harmless no-ops rather than failures.
 */
export type TtsOutputFlowState = 'running' | 'suspended' | 'terminal';

export type TtsFlowControlOutcome =
  | 'suspended'
  | 'alreadySuspended'
  | 'resumed'
  | 'alreadyRunning'
  | 'terminal'
  | 'failed';

export interface TtsFlowControlResult {
  /** `false` only for `failed`. A terminal session is not a failure - there is nothing to gate. */
  ok: boolean;
  outcome: TtsFlowControlOutcome;
  state: TtsOutputFlowState;
  /**
   * Completed output deliveries so far. Comparing this across a suspension proves quiescence
   * without knowing anything about the provider.
   */
  deliveredCount: number;
}

export interface ITtsStreamSession {
  readonly sessionId: string;

  /** Whether this session is currently delivering output. */
  readonly outputFlowState: TtsOutputFlowState;

  sendTextDelta(text: string, flush?: boolean): Promise<void>;
  completeInput(): Promise<void>;
  onAudioChunk(listener: (chunk: TtsAudioChunk) => void): () => void;
  onWordAlignment(listener: (alignment: TtsWordAlignment) => void): () => void;

  /**
   * Stops delivering stream output, and does not resolve until delivery is QUIESCENT: once this
   * promise settles, no further audio chunk or word alignment may be delivered for this session
   * until `resumeOutput()`. At most one already-started delivery may complete before it resolves.
   *
   * This is output flow control, not device control and not cancellation. The session identity,
   * its input, and its position are all preserved; no new stream is created.
   *
   * Audio and alignments are gated together on purpose: alignments that kept flowing during a
   * pause would advance the highlight past speech nobody is hearing.
   */
  suspendOutput(): Promise<TtsFlowControlResult>;

  /**
   * Resumes delivery on the SAME session from its next unconsumed item - no duplicates, no skips,
   * and never a restart from the beginning of the document.
   */
  resumeOutput(): Promise<TtsFlowControlResult>;

  /**
   * Terminal. Must also wake anything blocked on a suspended output gate: a cancelled session may
   * never leave a producer or a pending `suspendOutput()` blocked forever.
   */
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
