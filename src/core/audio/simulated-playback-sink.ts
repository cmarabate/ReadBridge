import { AudioFormat } from '../tts/provider-interface.js';
import {
  IAudioPlaybackSession,
  IAudioPlaybackSink,
  PlaybackCommandResult,
  PlaybackSessionState,
  PlaybackWriteResult,
  bytesPerSecond,
} from './playback-interface.js';

export interface SimulatedPlaybackOptions {
  /**
   * Clock used to advance the output cursor. Supplying one puts the sink in DETERMINISTIC mode:
   * no timers are armed and completion is evaluated only when the session is observed, so a test
   * decides exactly when time passes. Omitting it uses the wall clock and arms a drain timer.
   */
  now?: () => number;
  /** Bound on undrained audio, in seconds. Matches the companion sink's policy. */
  maxQueuedSeconds?: number;
}

const DEFAULT_MAX_QUEUED_SECONDS = 32;

/**
 * A playback sink that models the full session contract - cursor, pause/resume, terminal states,
 * bounded queue - WITHOUT touching an audio device.
 *
 * It is named for what it is. `producesAudibleOutput` is `false`, and `ReaderController` puts that
 * on its snapshot, so a caller cannot mistake a modelled session for one that makes sound. It
 * exists so playback semantics are testable without a device, and so a headless host degrades to
 * something honest rather than to a `ReaderController` that claims `playing` with no output.
 */
export class SimulatedAudioPlaybackSink implements IAudioPlaybackSink {
  public readonly sinkId = 'simulated-playback';
  public readonly producesAudibleOutput = false;

  /** Every session this sink has created, in order. Lets callers assert session identity. */
  public readonly sessions: SimulatedAudioPlaybackSession[] = [];

  private readonly options: SimulatedPlaybackOptions;

  constructor(options: SimulatedPlaybackOptions = {}) {
    this.options = options;
  }

  public async createSession(
    playbackSessionId: string,
    format: AudioFormat
  ): Promise<IAudioPlaybackSession> {
    const session = new SimulatedAudioPlaybackSession(playbackSessionId, format, this.options);
    this.sessions.push(session);
    return session;
  }
}

export class SimulatedAudioPlaybackSession implements IAudioPlaybackSession {
  public readonly playbackSessionId: string;
  public readonly maxQueuedBytes: number;

  private readonly format: AudioFormat;
  private readonly bytesPerSec: number;
  private readonly now: () => number;
  private readonly deterministic: boolean;

  private _state: PlaybackSessionState = 'created';
  private inputComplete = false;
  private disposed = false;

  /** Total audio accepted, in ms. The cursor can never pass this. */
  private acceptedMs = 0;
  /** Cursor accumulated across previous playing intervals. */
  private playedBeforeMs = 0;
  /** Wall-clock instant the current playing interval began; null while not playing. */
  private playingSince: number | null = null;

  private completionListeners: Array<(id: string, positionMs: number) => void> = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(playbackSessionId: string, format: AudioFormat, options: SimulatedPlaybackOptions) {
    this.playbackSessionId = playbackSessionId;
    this.format = format;
    this.bytesPerSec = bytesPerSecond(format);
    this.deterministic = typeof options.now === 'function';
    this.now = options.now ?? (() => Date.now());
    this.maxQueuedBytes =
      this.bytesPerSec * (options.maxQueuedSeconds ?? DEFAULT_MAX_QUEUED_SECONDS);
  }

  public get state(): PlaybackSessionState {
    this.observe();
    return this._state;
  }

  public get lastObservedPositionMs(): number {
    return this.observe();
  }

  public get audioFormat(): AudioFormat {
    return this.format;
  }

  public async write(audioData: Uint8Array): Promise<PlaybackWriteResult> {
    this.observe();

    if (this.isTerminal()) return this.writeResult(false, 'terminalState');
    if (this.inputComplete) return this.writeResult(false, 'inputComplete');
    if (audioData.length === 0) return this.writeResult(true, 'empty');

    const blockAlign = this.format.channels * (this.format.bitDepth / 8);
    if (blockAlign > 0 && audioData.length % blockAlign !== 0) {
      return this.writeResult(false, 'misalignedFrame');
    }
    if (this.queuedBytes() + audioData.length > this.maxQueuedBytes) {
      return this.writeResult(false, 'queueFull');
    }

    this.acceptedMs += (audioData.length * 1000) / this.bytesPerSec;

    if (this._state === 'created') {
      this._state = 'playing';
      this.playingSince = this.now();
    }

    this.armDrainTimer();
    return this.writeResult(true, null);
  }

  public async completeInput(): Promise<PlaybackCommandResult> {
    this.observe();
    if (this.isTerminal()) return this.commandResult(false, 'terminalState');
    this.inputComplete = true;
    this.observe();
    this.armDrainTimer();
    return this.commandResult(true, null);
  }

  public async pause(): Promise<PlaybackCommandResult> {
    this.observe();
    if (this.isTerminal()) return this.commandResult(false, 'terminalState');
    if (this._state === 'paused') return this.commandResult(true, 'alreadyPaused');
    if (this._state === 'created') return this.commandResult(false, 'notStarted');

    this.playedBeforeMs = this.observe();
    this.playingSince = null;
    this._state = 'paused';
    this.clearDrainTimer();
    return this.commandResult(true, null);
  }

  public async resume(): Promise<PlaybackCommandResult> {
    this.observe();
    if (this.isTerminal()) return this.commandResult(false, 'terminalState');
    if (this._state === 'playing') return this.commandResult(true, 'alreadyPlaying');
    if (this._state !== 'paused') return this.commandResult(false, 'notPaused');

    this.playingSince = this.now();
    this._state = 'playing';
    this.armDrainTimer();
    return this.commandResult(true, null);
  }

  public async stop(): Promise<PlaybackCommandResult> {
    this.observe();
    if (this._state === 'stopped') return this.commandResult(true, 'alreadyStopped');
    if (this._state === 'completed') return this.commandResult(false, 'terminalState');

    this.playedBeforeMs = this.observe();
    this.playingSince = null;
    this._state = 'stopped';
    this.clearDrainTimer();
    return this.commandResult(true, null);
  }

  public async getStatus(): Promise<PlaybackCommandResult> {
    this.observe();
    return this.commandResult(true, null);
  }

  public onCompleted(listener: (playbackSessionId: string, positionMs: number) => void): () => void {
    this.completionListeners.push(listener);
    return () => {
      this.completionListeners = this.completionListeners.filter((l) => l !== listener);
    };
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.isTerminal()) {
      this.playedBeforeMs = this.observe();
      this.playingSince = null;
      this._state = 'stopped';
    }
    this.clearDrainTimer();
    this.completionListeners = [];
  }

  // ---- internals ------------------------------------------------------------------

  private isTerminal(): boolean {
    return this._state === 'completed' || this._state === 'stopped';
  }

  /**
   * Advances the cursor to "now" and completes the session if its audio has fully drained.
   * Called on every observation so a deterministic clock needs no timer to reach completion.
   */
  private observe(): number {
    if (this._state === 'playing' && this.playingSince !== null) {
      const elapsed = Math.max(0, this.now() - this.playingSince);
      const position = Math.min(this.acceptedMs, this.playedBeforeMs + elapsed);

      if (this.inputComplete && position >= this.acceptedMs) {
        this.playedBeforeMs = this.acceptedMs;
        this.playingSince = null;
        this._state = 'completed';
        this.clearDrainTimer();
        const listeners = this.completionListeners;
        this.completionListeners = [];
        for (const listener of listeners) {
          listener(this.playbackSessionId, Math.round(this.playedBeforeMs));
        }
        return Math.round(this.playedBeforeMs);
      }

      return Math.round(position);
    }

    return Math.round(this.playedBeforeMs);
  }

  private currentPositionMs(): number {
    if (this._state === 'playing' && this.playingSince !== null) {
      const elapsed = Math.max(0, this.now() - this.playingSince);
      return Math.round(Math.min(this.acceptedMs, this.playedBeforeMs + elapsed));
    }
    return Math.round(this.playedBeforeMs);
  }

  /** Audio accepted but not yet rendered. Public so tests can assert the queue does not grow. */
  public queuedBytes(): number {
    const undrainedMs = Math.max(0, this.acceptedMs - this.currentPositionMs());
    return Math.round((undrainedMs / 1000) * this.bytesPerSec);
  }

  /**
   * Wall-clock mode only. In deterministic mode a test owns the clock, so a real timer would fire
   * at a time that has nothing to do with the simulated cursor.
   */
  private armDrainTimer(): void {
    if (this.deterministic || this.disposed) return;
    if (!this.inputComplete || this._state !== 'playing') return;

    this.clearDrainTimer();
    const remaining = Math.max(0, this.acceptedMs - this.currentPositionMs());
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.observe();
    }, Math.ceil(remaining) + 1);
    this.drainTimer.unref?.();
  }

  private clearDrainTimer(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private writeResult(accepted: boolean, reason: string | null): PlaybackWriteResult {
    return {
      accepted,
      reason,
      state: this._state,
      positionMs: this.currentPositionMs(),
      queuedBytes: this.queuedBytes(),
      maxQueuedBytes: this.maxQueuedBytes,
    };
  }

  private commandResult(ok: boolean, reason: string | null): PlaybackCommandResult {
    return {
      ok,
      reason,
      state: this._state,
      positionMs: this.currentPositionMs(),
      queuedBytes: this.queuedBytes(),
    };
  }
}
