import { AudioFormat } from '../tts/provider-interface.js';

/**
 * Lifecycle of one playback session.
 *
 * `created` -> `playing` -> (`paused` <-> `playing`)* -> `completed` | `stopped`
 *
 * A session becomes `playing` on its first ACCEPTED audio write, never on construction: the point
 * of this seam is that nothing may claim audible playback before an output has taken audio.
 * `completed` and `stopped` are terminal and every later command fails closed.
 */
export type PlaybackSessionState = 'created' | 'playing' | 'paused' | 'completed' | 'stopped';

/**
 * Why a playback operation was refused, or - for `ok`/`accepted` results - which no-op it was.
 *
 * `alreadyPaused` / `alreadyPlaying` are successes: pause and resume are idempotent, and say so
 * rather than silently pretending a transition happened.
 */
export type PlaybackReason =
  | 'alreadyPaused'
  | 'alreadyPlaying'
  | 'alreadyStopped'
  | 'empty'
  | 'notStarted'
  | 'notPaused'
  | 'inputComplete'
  | 'terminalState'
  | 'staleSession'
  | 'queueFull'
  | 'misalignedFrame'
  | 'sessionIdInUse'
  | 'hostDisposed'
  | string;

export interface PlaybackWriteResult {
  accepted: boolean;
  reason: PlaybackReason | null;
  state: PlaybackSessionState;
  /** Output cursor after the write, in milliseconds of audio actually rendered. */
  positionMs: number;
  /** Audio handed to the output and not yet drained. */
  queuedBytes: number;
  /** Bound on `queuedBytes`; a write that would exceed it is refused, never dropped. */
  maxQueuedBytes: number;
}

export interface PlaybackCommandResult {
  ok: boolean;
  reason: PlaybackReason | null;
  state: PlaybackSessionState;
  positionMs: number;
  queuedBytes: number;
}

/**
 * One resumable playback session. The session - not the TTS provider - owns the output cursor.
 *
 * Implementations must guarantee that `pause()` freezes `positionMs` for the whole duration of the
 * pause and that `resume()` continues THE SAME session from that cursor rather than restarting it.
 */
export interface IAudioPlaybackSession {
  readonly playbackSessionId: string;

  /**
   * Last state observed from the output. It is a mirror, not a live probe - call `getStatus()`
   * for a fresh reading.
   */
  readonly state: PlaybackSessionState;

  /** Last cursor observed from the output, in milliseconds. Mirror, as above. */
  readonly lastObservedPositionMs: number;

  write(audioData: Uint8Array): Promise<PlaybackWriteResult>;

  /** No more audio will be written. The session completes once what was written has drained. */
  completeInput(): Promise<PlaybackCommandResult>;

  pause(): Promise<PlaybackCommandResult>;
  resume(): Promise<PlaybackCommandResult>;

  /** Terminal. Abandons queued audio and releases the output. */
  stop(): Promise<PlaybackCommandResult>;

  getStatus(): Promise<PlaybackCommandResult>;

  /** Fires once when the session drains naturally. Carries its own id so callers can fence it. */
  onCompleted(listener: (playbackSessionId: string, positionMs: number) => void): () => void;

  dispose(): Promise<void>;
}

export interface IAudioPlaybackSink {
  readonly sinkId: string;

  /**
   * Whether this sink drives a real audio device. A sink that reports `false` models playback
   * faithfully but makes no sound; `ReaderController` surfaces this on its snapshot so no caller
   * can mistake a modelled session for an audible one.
   */
  readonly producesAudibleOutput: boolean;

  createSession(playbackSessionId: string, format: AudioFormat): Promise<IAudioPlaybackSession>;
}

/** Bytes of PCM per second for a format - the conversion between queue depth and cursor time. */
export function bytesPerSecond(format: AudioFormat): number {
  return format.sampleRate * format.channels * (format.bitDepth / 8);
}
