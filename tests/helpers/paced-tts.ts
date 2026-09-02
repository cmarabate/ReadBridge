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
import { TEST_FORMAT, pcmForMs } from './fake-tts';

/**
 * Lets a test decide exactly how much output the producer is ALLOWED to attempt, so "the producer
 * tried and was blocked" can be distinguished from "the producer never tried".
 *
 * The producer takes a grant first and only then meets the output gate, so a granted item that
 * does not arrive is a producer parked at the gate - which is precisely the thing under test.
 */
class ProductionPacer {
  private credit: number;
  private waiters: Array<() => void> = [];

  constructor(initial: number) {
    this.credit = initial;
  }

  public get availableCredit(): number {
    return this.credit;
  }

  public grant(count: number): void {
    this.credit += count;
    while (this.credit > 0 && this.waiters.length > 0) {
      this.credit--;
      this.waiters.shift()!();
    }
  }

  public async take(): Promise<void> {
    if (this.credit > 0) {
      this.credit--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Drops unspent credit. Lets a test hand back production pacing after a burst. */
  public reset(): void {
    this.credit = 0;
  }

  /** Wakes everything, so a cancelled session never strands its producer. */
  public release(): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const resolve of pending) resolve();
  }
}

export interface PacedTtsOptions {
  /** Number of (alignment, audio chunk) pairs the stream will produce. */
  chunkCount: number;
  /** Audio duration carried by each chunk. */
  chunkMs: number;
  format?: AudioFormat;
  /**
   * Items the producer may attempt before a test grants more. `Infinity` (the default) lets it run
   * as fast as the output gate allows.
   */
  initialGrants?: number;
}

/**
 * A deterministic multi-chunk streaming provider.
 *
 * The shipped simulators emit one placeholder buffer for an entire document, which cannot exercise
 * backpressure: there is no second item for a suspension to block. This one emits an ordered,
 * individually identifiable sequence, so a test can prove that a resumed stream continues at
 * exactly the next item - no duplicate, no skip.
 */
export class PacedTtsProvider implements ITtsProvider {
  public readonly providerId = 'paced-test-tts';
  public readonly supportsWordLevelTimestamps = true;
  public readonly supportsIncrementalStreaming = true;
  public readonly sessions: PacedTtsStreamSession[] = [];

  private readonly options: Required<PacedTtsOptions>;

  constructor(options: PacedTtsOptions) {
    this.options = {
      chunkCount: options.chunkCount,
      chunkMs: options.chunkMs,
      format: options.format ?? TEST_FORMAT,
      initialGrants: options.initialGrants ?? Infinity,
    };
  }

  public async initialize(): Promise<void> {}

  public async createStreamSession(_options: TtsOptions): Promise<ITtsStreamSession> {
    const session = new PacedTtsStreamSession(`paced-tts-${this.sessions.length + 1}`, this.options);
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

export class PacedTtsStreamSession implements ITtsStreamSession {
  public readonly sessionId: string;

  /** Ordered indices actually delivered. The witness for "no duplicates, no skips". */
  public readonly deliveredChunkIndices: number[] = [];
  public readonly deliveredAlignmentIndices: number[] = [];
  public cancelled = false;

  private readonly options: Required<PacedTtsOptions>;
  private readonly outputGate = new TtsOutputGate();
  private readonly pacer: ProductionPacer;
  private audioListeners: Array<(chunk: TtsAudioChunk) => void> = [];
  private alignmentListeners: Array<(alignment: TtsWordAlignment) => void> = [];
  private words: string[] = [];
  private text = '';

  constructor(sessionId: string, options: Required<PacedTtsOptions>) {
    this.sessionId = sessionId;
    this.options = options;
    this.pacer = new ProductionPacer(options.initialGrants);
  }

  /** Total audio this stream will have produced once it runs to completion. */
  public get totalAudioMs(): number {
    return this.options.chunkCount * this.options.chunkMs;
  }

  public get deliveredCount(): number {
    return this.outputGate.deliveredCount;
  }

  public get outputFlowState(): TtsOutputFlowState {
    return this.outputGate.flowState;
  }

  /** Allows the producer to attempt `count` more deliveries. */
  public grantProduction(count: number): void {
    this.pacer.grant(count);
  }

  /**
   * Drops unspent production credit. A real provider is rate-bound; this lets a test hand pacing
   * back after granting an unrealistic burst, so the resumed phase measures continuity rather than
   * how fast an unthrottled loop can run.
   */
  public resetProduction(): void {
    this.pacer.reset();
  }

  public async sendTextDelta(text: string, _flush: boolean = false): Promise<void> {
    if (this.cancelled) return;
    this.text = text;
    this.words = text.split(/\s+/).filter(Boolean);

    for (let i = 0; i < this.options.chunkCount; i++) {
      // An alignment and its audio are separate deliveries through the SAME gate, so a suspension
      // between them resumes at the audio rather than replaying the alignment.
      await this.pacer.take();
      if (this.cancelled) return;
      if (!(await this.outputGate.deliver(() => this.emitAlignment(i)))) return;

      await this.pacer.take();
      if (this.cancelled) return;
      if (!(await this.outputGate.deliver(() => this.emitChunk(i)))) return;
    }
  }

  public async completeInput(): Promise<void> {
    if (this.cancelled) return;
    await this.outputGate.deliver(() => {
      for (const listener of [...this.audioListeners]) {
        listener({
          audioData: new Uint8Array(0),
          format: this.options.format,
          durationMs: 0,
          isFinal: true,
        });
      }
    });
  }

  public suspendOutput(): Promise<TtsFlowControlResult> {
    return this.outputGate.suspend();
  }

  public resumeOutput(): Promise<TtsFlowControlResult> {
    return this.outputGate.resume();
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
    // Both, in this order: the gate wakes a producer blocked on a suspension, the pacer wakes one
    // blocked waiting for credit. Either alone would leave a stop-while-paused task stranded.
    this.outputGate.terminate();
    this.pacer.release();
  }

  private emitAlignment(index: number): void {
    const word = this.words.length > 0 ? this.words[index % this.words.length] : `w${index}`;
    const charStart = this.text.indexOf(word) >= 0 ? this.text.indexOf(word) : 0;
    this.deliveredAlignmentIndices.push(index);
    for (const listener of [...this.alignmentListeners]) {
      listener({
        word,
        charStart,
        charLength: word.length,
        audioStartMs: index * this.options.chunkMs,
        audioEndMs: (index + 1) * this.options.chunkMs,
      });
    }
  }

  private emitChunk(index: number): void {
    this.deliveredChunkIndices.push(index);
    for (const listener of [...this.audioListeners]) {
      listener({
        audioData: pcmForMs(this.options.chunkMs, this.options.format),
        format: this.options.format,
        durationMs: this.options.chunkMs,
        isFinal: false,
      });
    }
  }
}

/**
 * Lets every pending microtask and immediate run. Backpressure is asserted by showing that a
 * producer given every opportunity to run still delivered nothing - not by sleeping.
 */
export async function settleAsyncWork(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
