import { TtsOutputGate } from '../../src/core/tts/output-gate';
import {
  AudioFormat,
  ITtsProvider,
  ITtsStreamSession,
  TtsAudioChunk,
  TtsFlowControlResult,
  TtsOptions,
  TtsOutputFlowState,
  TtsWordAlignment,
} from '../../src/core/tts/provider-interface';

export const TEST_FORMAT: AudioFormat = { sampleRate: 24000, channels: 1, bitDepth: 16 };

export function bytesForMs(ms: number, format: AudioFormat = TEST_FORMAT): number {
  const bytesPerSecond = format.sampleRate * format.channels * (format.bitDepth / 8);
  const blockAlign = format.channels * (format.bitDepth / 8);
  const raw = Math.round((bytesPerSecond * ms) / 1000);
  return raw - (raw % blockAlign);
}

/** Deterministic PCM of a known duration. Content is irrelevant; length carries the meaning. */
export function pcmForMs(ms: number, format: AudioFormat = TEST_FORMAT): Uint8Array {
  return new Uint8Array(bytesForMs(ms, format));
}

export interface FakeTtsOptions {
  /** Duration of the single audio chunk emitted per `sendTextDelta`. */
  audioMs?: number;
  format?: AudioFormat;
  /** When true the stream emits alignments but never any audio - a provider that produced none. */
  emitNoAudio?: boolean;
}

/**
 * A TTS provider that emits real, correctly sized PCM so playback routing can be asserted by byte
 * count, and whose stream sessions are recorded so a test can drive or inspect them directly.
 *
 * The shipped simulators emit a fixed 1 KB placeholder buffer, which is not a duration a playback
 * cursor can be checked against.
 */
export class FakeStreamingTtsProvider implements ITtsProvider {
  public readonly providerId = 'fake-streaming-tts';
  public readonly supportsWordLevelTimestamps = true;
  public readonly supportsIncrementalStreaming = true;
  public readonly sessions: FakeTtsStreamSession[] = [];

  private readonly options: Required<FakeTtsOptions>;

  constructor(options: FakeTtsOptions = {}) {
    this.options = {
      audioMs: options.audioMs ?? 1000,
      format: options.format ?? TEST_FORMAT,
      emitNoAudio: options.emitNoAudio ?? false,
    };
  }

  public async initialize(): Promise<void> {}

  public async createStreamSession(_options: TtsOptions): Promise<ITtsStreamSession> {
    const session = new FakeTtsStreamSession(`fake-tts-${this.sessions.length + 1}`, this.options);
    this.sessions.push(session);
    return session;
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

export class FakeTtsStreamSession implements ITtsStreamSession {
  public readonly sessionId: string;
  public cancelled = false;

  private readonly options: Required<FakeTtsOptions>;
  private readonly outputGate = new TtsOutputGate();
  private audioListeners: Array<(chunk: TtsAudioChunk) => void> = [];
  private alignmentListeners: Array<(alignment: TtsWordAlignment) => void> = [];

  constructor(sessionId: string, options: Required<FakeTtsOptions>) {
    this.sessionId = sessionId;
    this.options = options;
  }

  public async sendTextDelta(text: string, _flush: boolean = false): Promise<void> {
    if (this.cancelled) return;

    let cursor = 0;
    let audioTime = 0;
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const charStart = text.indexOf(word, cursor);
      cursor = charStart + word.length;
      const alignment: TtsWordAlignment = {
        word,
        charStart,
        charLength: word.length,
        audioStartMs: audioTime,
        audioEndMs: audioTime + 200,
      };
      audioTime += 200;
      if (!(await this.outputGate.deliver(() => this.emitAlignment(alignment)))) return;
    }

    if (!this.options.emitNoAudio) {
      await this.outputGate.deliver(() =>
        this.emitChunk({
          audioData: pcmForMs(this.options.audioMs, this.options.format),
          format: this.options.format,
          durationMs: this.options.audioMs,
          isFinal: false,
        })
      );
    }
  }

  public async completeInput(): Promise<void> {
    if (this.cancelled) return;
    await this.outputGate.deliver(() =>
      this.emitChunk({
        audioData: new Uint8Array(0),
        format: this.options.format,
        durationMs: 0,
        isFinal: true,
      })
    );
  }

  public get outputFlowState(): TtsOutputFlowState {
    return this.outputGate.flowState;
  }

  public suspendOutput(): Promise<TtsFlowControlResult> {
    return this.outputGate.suspend();
  }

  public resumeOutput(): Promise<TtsFlowControlResult> {
    return this.outputGate.resume();
  }

  /**
   * Emits an alignment outside the normal flow, DELIBERATELY BYPASSING the output gate - it is how
   * tests inject the stale events a rogue or abandoned stream would produce.
   */
  public emitAlignment(alignment: TtsWordAlignment): void {
    for (const listener of [...this.alignmentListeners]) listener(alignment);
  }

  /** Emits an audio chunk outside the normal flow, deliberately bypassing the output gate. */
  public emitChunk(chunk: TtsAudioChunk): void {
    for (const listener of [...this.audioListeners]) listener(chunk);
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
    this.cancelled = true;
    this.outputGate.terminate();
  }
}

/** A controllable clock, so cursor behaviour is asserted rather than slept for. */
export function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}
