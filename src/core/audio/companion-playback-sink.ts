import { CompanionEvent, NativeCompanionClient } from '../../companion-bridge/ipc-client.js';
import { AudioFormat } from '../tts/provider-interface.js';
import {
  IAudioPlaybackSession,
  IAudioPlaybackSink,
  PlaybackCommandResult,
  PlaybackSessionState,
  PlaybackWriteResult,
} from './playback-interface.js';

/**
 * Production playback sink. Audio output lives in the Windows companion - the process that already
 * owns every native Windows surface - and is reached over the companion's existing stdio JSON-lines
 * channel. Nothing new is spawned and no second companion exists.
 *
 * The companion drives WinMM `waveOut`: `waveOutPause` / `waveOutRestart` suspend and resume the
 * same open device handle, so the device's own sample cursor is what survives a pause.
 */
export class CompanionAudioPlaybackSink implements IAudioPlaybackSink {
  public readonly sinkId = 'winmm-waveout-companion';
  public readonly producesAudibleOutput = true;

  constructor(private readonly client: NativeCompanionClient) {}

  public async createSession(
    playbackSessionId: string,
    format: AudioFormat
  ): Promise<IAudioPlaybackSession> {
    const result = await this.client.call('audioOpen', {
      sessionId: playbackSessionId,
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitDepth: format.bitDepth,
    });

    if (!result?.ok) {
      throw new Error(
        `Companion refused a playback session for '${playbackSessionId}': ${result?.reason ?? 'unknown reason'}`
      );
    }

    return new CompanionAudioPlaybackSession(this.client, playbackSessionId);
  }
}

export class CompanionAudioPlaybackSession implements IAudioPlaybackSession {
  public readonly playbackSessionId: string;

  private readonly client: NativeCompanionClient;
  private readonly unsubscribeEvents: () => void;

  private _state: PlaybackSessionState = 'created';
  private _lastObservedPositionMs = 0;
  private disposed = false;
  private completionListeners: Array<(id: string, positionMs: number) => void> = [];

  constructor(client: NativeCompanionClient, playbackSessionId: string) {
    this.client = client;
    this.playbackSessionId = playbackSessionId;

    this.unsubscribeEvents = client.onEvent((evt: CompanionEvent) => {
      // The companion serves one device for whatever read is current; an event naming a different
      // session belongs to a read this session has nothing to do with.
      if (evt.event !== 'playbackCompleted' || evt.sessionId !== this.playbackSessionId) return;
      this.handleCompleted(typeof evt.positionMs === 'number' ? evt.positionMs : this._lastObservedPositionMs);
    });
  }

  public get state(): PlaybackSessionState {
    return this._state;
  }

  public get lastObservedPositionMs(): number {
    return this._lastObservedPositionMs;
  }

  public async write(audioData: Uint8Array): Promise<PlaybackWriteResult> {
    if (this.disposed) {
      return {
        accepted: false,
        reason: 'terminalState',
        state: this._state,
        positionMs: this._lastObservedPositionMs,
        queuedBytes: 0,
        maxQueuedBytes: 0,
      };
    }

    const result = await this.client.call('audioWrite', {
      sessionId: this.playbackSessionId,
      audioBase64: Buffer.from(audioData).toString('base64'),
    });

    this.absorb(result);
    return {
      accepted: Boolean(result?.accepted),
      reason: result?.reason ?? null,
      state: this._state,
      positionMs: this._lastObservedPositionMs,
      queuedBytes: result?.queuedBytes ?? 0,
      maxQueuedBytes: result?.maxQueuedBytes ?? 0,
    };
  }

  public completeInput(): Promise<PlaybackCommandResult> {
    return this.command('audioCompleteInput');
  }

  public pause(): Promise<PlaybackCommandResult> {
    return this.command('audioPause');
  }

  public resume(): Promise<PlaybackCommandResult> {
    return this.command('audioResume');
  }

  public stop(): Promise<PlaybackCommandResult> {
    return this.command('audioStop');
  }

  public getStatus(): Promise<PlaybackCommandResult> {
    return this.command('audioStatus');
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
    this.unsubscribeEvents();
    this.completionListeners = [];

    // Best effort: the companion may already have released this session, and a transport failure
    // during teardown must not propagate out of dispose.
    try {
      if (this._state !== 'completed' && this._state !== 'stopped') {
        await this.client.call('audioStop', { sessionId: this.playbackSessionId });
      }
    } catch {
      // Companion already gone or unreachable; there is nothing left to release.
    }
  }

  private async command(method: string): Promise<PlaybackCommandResult> {
    if (this.disposed) {
      return {
        ok: false,
        reason: 'terminalState',
        state: this._state,
        positionMs: this._lastObservedPositionMs,
        queuedBytes: 0,
      };
    }

    const result = await this.client.call(method, { sessionId: this.playbackSessionId });
    this.absorb(result);
    return {
      ok: Boolean(result?.ok),
      reason: result?.reason ?? null,
      state: this._state,
      positionMs: this._lastObservedPositionMs,
      queuedBytes: result?.queuedBytes ?? 0,
    };
  }

  /** Mirrors whatever the companion just reported. Never invents a state or a cursor. */
  private absorb(result: any): void {
    if (result && typeof result.state === 'string') {
      this._state = result.state as PlaybackSessionState;
    }
    if (result && typeof result.positionMs === 'number') {
      this._lastObservedPositionMs = result.positionMs;
    }
  }

  private handleCompleted(positionMs: number): void {
    if (this.disposed) return;
    this._state = 'completed';
    this._lastObservedPositionMs = positionMs;

    const listeners = this.completionListeners;
    this.completionListeners = [];
    for (const listener of listeners) {
      listener(this.playbackSessionId, positionMs);
    }
  }
}
