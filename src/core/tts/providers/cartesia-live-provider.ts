import { TtsOutputGate } from '../output-gate.js';
import {
  AudioFormat,
  ITtsProvider,
  ITtsStreamSession,
  TtsAudioChunk,
  TtsFlowControlResult,
  TtsOptions,
  TtsOutputFlowState,
  TtsWordAlignment,
} from '../provider-interface.js';

/**
 * The minimum of a WebSocket this client needs.
 *
 * Declared structurally so the transport is injectable: the deterministic tests drive a
 * real local `ws` server, and nothing here depends on a browser `WebSocket` global that
 * ReadBridge's Node host does not have.
 */
export interface CartesiaSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
}

export type CartesiaSocketFactory = (url: string, headers: Record<string, string>) => CartesiaSocket;

export interface CartesiaLiveOptions {
  /**
   * Injected, never hardcoded and never committed. Read it from the environment or a
   * config store at construction; this class neither logs it nor puts it in the URL.
   */
  apiKey: string;
  /** Defaults to the documented production endpoint. */
  baseUrl?: string;
  /**
   * The `cartesia_version` query parameter. Pinned rather than defaulted to "latest" so a
   * server-side change cannot silently alter the wire shape this client parses.
   */
  cartesiaVersion?: string;
  modelId?: string;
  sampleRate?: number;
  /** Supply a factory in tests; production uses `ws`. */
  createSocket?: CartesiaSocketFactory;
  /** How long to wait for the socket to open before failing the stream. */
  connectTimeoutMs?: number;
}

const DEFAULT_BASE_URL = 'wss://api.cartesia.ai/tts/websocket';

/**
 * Pinned. The API version is a query parameter, not a header - the earlier repository
 * prose said otherwise and was wrong; see docs/architecture/tts-providers.md §2.
 */
const DEFAULT_CARTESIA_VERSION = '2026-08-14';
const DEFAULT_MODEL_ID = 'sonic-3.6';
const DEFAULT_SAMPLE_RATE = 24000;

/**
 * Live Cartesia Sonic streaming client.
 *
 * **No credential ever appears in the URL or in a log line.** The key goes in the
 * `X-API-Key` header; only the non-secret `cartesia_version` is a query parameter.
 *
 * Everything else about this class is shaped by one problem: Cartesia PUSHES. Once a
 * transcript is sent the server streams at its own pace and documents no "stop sending"
 * message, so `suspendOutput()` cannot be satisfied by asking the server to pause. It is
 * satisfied on this side, in two parts:
 *
 * 1. while suspended, no further transcript is fed, which bounds what the server will
 *    generate because it only generates what it was given;
 * 2. the socket keeps being READ - refusing to read would apply TCP backpressure and
 *    eventually stall the connection - but each message is queued in order instead of
 *    being delivered, and a drain task hands the queue to listeners through the output
 *    gate. A suspension therefore parks the drain, not the reader.
 *
 * That is what makes quiescence and exact continuation both true: no callback after
 * `suspendOutput()` resolves, and an ordered queue that cannot duplicate or skip.
 */
export class CartesiaLiveTtsProvider implements ITtsProvider {
  public readonly providerId = 'cartesia-live';
  public readonly supportsWordLevelTimestamps = true;
  public readonly supportsIncrementalStreaming = true;

  private readonly options: Required<Omit<CartesiaLiveOptions, 'createSocket'>> & {
    createSocket?: CartesiaSocketFactory;
  };

  constructor(options: CartesiaLiveOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error(
        'CartesiaLiveTtsProvider requires an API key. Inject it from the environment or a config ' +
          'store - it must never be hardcoded or committed.'
      );
    }

    this.options = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      cartesiaVersion: options.cartesiaVersion ?? DEFAULT_CARTESIA_VERSION,
      modelId: options.modelId ?? DEFAULT_MODEL_ID,
      sampleRate: options.sampleRate ?? DEFAULT_SAMPLE_RATE,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      createSocket: options.createSocket,
    };
  }

  public async initialize(): Promise<void> {
    // Nothing to preheat: a session opens its own socket on first use, so an unused
    // provider holds no connection and no credential in flight.
  }

  public async createStreamSession(options: TtsOptions): Promise<ITtsStreamSession> {
    return new CartesiaLiveStreamSession(this.options, options);
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

type Delivery = () => void;

export class CartesiaLiveStreamSession implements ITtsStreamSession {
  public readonly sessionId: string;

  private readonly config: Required<Omit<CartesiaLiveOptions, 'createSocket'>> & {
    createSocket?: CartesiaSocketFactory;
  };
  private readonly voiceOptions: TtsOptions;
  private readonly outputGate = new TtsOutputGate();
  private readonly format: AudioFormat;

  private audioListeners: Array<(chunk: TtsAudioChunk) => void> = [];
  private alignmentListeners: Array<(alignment: TtsWordAlignment) => void> = [];

  private socket: CartesiaSocket | null = null;
  private connecting: Promise<void> | null = null;
  private cancelled = false;
  private inputComplete = false;
  private serverDone = false;

  /** Ordered, undelivered messages. The reader fills it; the drain empties it. */
  private readonly pending: Delivery[] = [];
  private drainSignal: (() => void) | null = null;
  private drainLoop: Promise<void> | null = null;

  /** Everything sent so far, so word timestamps can be mapped back to character offsets. */
  private sentText = '';
  private alignmentCursor = 0;

  constructor(
    config: Required<Omit<CartesiaLiveOptions, 'createSocket'>> & { createSocket?: CartesiaSocketFactory },
    voiceOptions: TtsOptions
  ) {
    this.config = config;
    this.voiceOptions = voiceOptions;
    this.sessionId = `cartesia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.format = { sampleRate: config.sampleRate, channels: 1, bitDepth: 16 };
  }

  public get outputFlowState(): TtsOutputFlowState {
    return this.outputGate.flowState;
  }

  /** Messages read from the socket but not yet delivered. Bounded by what the server sent. */
  public get bufferedDeliveryCount(): number {
    return this.pending.length;
  }

  public async sendTextDelta(text: string, flush: boolean = false): Promise<void> {
    if (this.cancelled) return;

    // Feeding is what bounds generation, so a suspended session stops feeding. Waiting
    // here rather than sending means the server is never asked to produce audio that
    // nobody is going to accept.
    await this.awaitRunning();
    if (this.cancelled) return;

    await this.ensureConnected();
    if (this.cancelled) return;

    this.sentText += text;

    this.send({
      model_id: this.config.modelId,
      transcript: text,
      voice: { mode: 'id', id: this.voiceOptions.voiceId },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: this.config.sampleRate,
      },
      context_id: this.sessionId,
      continue: !flush,
      add_timestamps: true,
    });
  }

  public async completeInput(): Promise<void> {
    if (this.cancelled || this.inputComplete) return;

    await this.awaitRunning();
    if (this.cancelled) return;

    this.inputComplete = true;

    if (this.socket) {
      // An empty transcript with `continue: false` is how the context is closed without
      // adding speech to it.
      this.send({
        model_id: this.config.modelId,
        transcript: '',
        voice: { mode: 'id', id: this.voiceOptions.voiceId },
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: this.config.sampleRate,
        },
        context_id: this.sessionId,
        continue: false,
        add_timestamps: true,
      });
    } else {
      // Nothing was ever streamed, so there is no server to wait for.
      this.enqueue(() => this.emitFinal());
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

  public suspendOutput(): Promise<TtsFlowControlResult> {
    return this.outputGate.suspend();
  }

  public async resumeOutput(): Promise<TtsFlowControlResult> {
    const result = await this.outputGate.resume();
    this.wakeDrain();
    return result;
  }

  public async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;

    // Tell the server to stop generating for this exact context before dropping the
    // socket, so a cancelled read does not keep costing money on the far side.
    if (this.socket) {
      try {
        this.send({ context_id: this.sessionId, cancel: true });
      } catch {
        // A dead socket cannot be told anything; closing it is enough.
      }
    }

    // Terminate BEFORE clearing listeners, so a producer or a pending suspendOutput()
    // blocked on the gate is woken rather than stranded.
    this.outputGate.terminate();
    this.wakeDrain();

    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
    this.socket = null;

    this.pending.length = 0;
    this.audioListeners = [];
    this.alignmentListeners = [];
  }

  // ---- transport --------------------------------------------------------------------

  private ensureConnected(): Promise<void> {
    if (this.socket) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private connect(): Promise<void> {
    const factory = this.config.createSocket ?? defaultSocketFactory;

    // Only the non-secret version is a query parameter. The key goes in a header so it
    // never lands in a URL, a redirect, or a log line.
    const url = `${this.config.baseUrl}?cartesia_version=${encodeURIComponent(this.config.cartesiaVersion)}`;
    const socket = factory(url, { 'X-API-Key': this.config.apiKey });

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Cartesia did not accept a connection within ${this.config.connectTimeoutMs}ms.`));
      }, this.config.connectTimeoutMs);
      timer.unref?.();

      socket.on('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.startDrain();
        resolve();
      });

      socket.on('message', (data: unknown) => this.readMessage(data));

      socket.on('error', (error: Error) => {
        clearTimeout(timer);
        // Never interpolate the key; the message is the transport's own.
        reject(new Error(`Cartesia connection failed: ${error.message}`));
      });

      socket.on('close', () => {
        clearTimeout(timer);
        this.socket = null;
        if (!this.serverDone && !this.cancelled) {
          // A socket that closed before `done` cannot deliver the rest of this read.
          this.enqueue(() => this.emitFinal());
        }
        this.wakeDrain();
      });
    });
  }

  private send(payload: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(payload));
  }

  /**
   * Reads one server message. Deliberately does NOT deliver: it queues, so the socket
   * keeps draining even while output is suspended.
   */
  private readMessage(data: unknown): void {
    if (this.cancelled) return;

    let message: Record<string, any>;
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      // Unparseable input must never be interpreted as audio.
      return;
    }

    // A message for another context is not this session's business.
    if (typeof message.context_id === 'string' && message.context_id !== this.sessionId) {
      return;
    }

    switch (message.type) {
      case 'chunk': {
        if (typeof message.data !== 'string') return;
        const audioData = new Uint8Array(Buffer.from(message.data, 'base64'));
        if (audioData.length === 0) return;
        const durationMs = (audioData.length * 1000) / (this.format.sampleRate * 2);
        this.enqueue(() =>
          this.emitChunk({ audioData, format: this.format, durationMs, isFinal: false })
        );
        break;
      }

      case 'timestamps': {
        for (const alignment of this.mapTimestamps(message.word_timestamps)) {
          this.enqueue(() => this.emitAlignment(alignment));
        }
        break;
      }

      case 'done': {
        this.serverDone = true;
        this.enqueue(() => this.emitFinal());
        break;
      }

      case 'error': {
        this.serverDone = true;
        const detail = typeof message.message === 'string' ? message.message : 'unknown error';
        this.enqueue(() => {
          // The read ends; the controller sees the stream stop rather than a silent hang.
          this.emitFinal();
        });
        console.error(`[ReadBridge] Cartesia reported an error: ${detail}`);
        break;
      }

      default:
        // flush_done and anything else are transport bookkeeping, not output.
        break;
    }
  }

  /**
   * Cartesia reports words and times in seconds, with no character offsets, so they are
   * mapped back onto the transcript actually sent. The cursor only moves forward, so a
   * word repeated later in the text cannot rewind the highlight.
   */
  private mapTimestamps(raw: unknown): TtsWordAlignment[] {
    const timestamps = raw as { words?: unknown; start?: unknown; end?: unknown } | undefined;
    if (
      !timestamps ||
      !Array.isArray(timestamps.words) ||
      !Array.isArray(timestamps.start) ||
      !Array.isArray(timestamps.end)
    ) {
      return [];
    }

    const alignments: TtsWordAlignment[] = [];
    for (let i = 0; i < timestamps.words.length; i++) {
      const word = timestamps.words[i];
      const start = timestamps.start[i];
      const end = timestamps.end[i];
      if (typeof word !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
        continue;
      }

      const found = this.sentText.indexOf(word, this.alignmentCursor);
      const charStart = found >= 0 ? found : this.alignmentCursor;
      if (found >= 0) {
        this.alignmentCursor = found + word.length;
      }

      alignments.push({
        word,
        charStart,
        charLength: word.length,
        audioStartMs: Math.round(start * 1000),
        audioEndMs: Math.round(end * 1000),
      });
    }

    return alignments;
  }

  // ---- gated delivery ---------------------------------------------------------------

  private enqueue(delivery: Delivery): void {
    this.pending.push(delivery);
    this.startDrain();
    this.wakeDrain();
  }

  private startDrain(): void {
    if (this.drainLoop || this.cancelled) return;
    this.drainLoop = this.drain();
  }

  /**
   * The only thing that hands messages to listeners, and it does so through the gate - so
   * a suspension parks this loop while the reader keeps the socket moving.
   */
  private async drain(): Promise<void> {
    for (;;) {
      if (this.cancelled) return;

      const next = this.pending.shift();
      if (next === undefined) {
        if (this.serverDone && this.outputGate.flowState === 'terminal') return;
        await new Promise<void>((resolve) => {
          this.drainSignal = resolve;
        });
        continue;
      }

      if (!(await this.outputGate.deliver(next))) {
        return;
      }
    }
  }

  private wakeDrain(): void {
    const signal = this.drainSignal;
    this.drainSignal = null;
    signal?.();
  }

  private async awaitRunning(): Promise<void> {
    // Uses the gate's own admission so "running" means exactly what it means everywhere
    // else, then immediately gives the slot back: this is a wait, not a delivery.
    if (await this.outputGate.beginDelivery()) {
      this.outputGate.endDelivery();
    }
  }

  private emitChunk(chunk: TtsAudioChunk): void {
    for (const listener of [...this.audioListeners]) listener(chunk);
  }

  private emitAlignment(alignment: TtsWordAlignment): void {
    for (const listener of [...this.alignmentListeners]) listener(alignment);
  }

  private emitFinal(): void {
    this.emitChunk({
      audioData: new Uint8Array(0),
      format: this.format,
      durationMs: 0,
      isFinal: true,
    });
  }
}

/**
 * Production transport. `ws` is already a dependency of this repository; it is required
 * lazily so a test that injects its own socket never loads it.
 */
const defaultSocketFactory: CartesiaSocketFactory = (url, headers) => {
  const { WebSocket } = require('ws');
  return new WebSocket(url, { headers }) as unknown as CartesiaSocket;
};
