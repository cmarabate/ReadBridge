/**
 * What an audio-focus authority told ReadBridge about a request.
 *
 * Deliberately coarse. ReadBridge does not know VoiceMediaBridge's priority numbers,
 * lease chain, preemption rules or background-media ownership, and must not learn them:
 * it asks whether it may be audible, and is told.
 */
export type FocusGrantOutcome =
  /** Focus is held. Playback may begin. */
  | 'granted'
  /** This exact read already holds focus. Idempotent. */
  | 'alreadyHeld'
  /** Something more important is using the audio device. Do not become audible. */
  | 'blockedByHigherFocus'
  /** Another participant of the same class holds focus. Do not become audible. */
  | 'classConflict'
  /** No authority could be reached, or it refused for a reason ReadBridge cannot act on. */
  | 'unavailable';

export interface FocusGrantResult {
  outcome: FocusGrantOutcome;
  /** The only field playback is allowed to branch on. */
  granted: boolean;
  detail?: string;
}

export type FocusCommandAction = 'suspend' | 'resume';

/**
 * A command from the focus authority, naming the exact read it means.
 *
 * There is no "the current read" command and no fallback to the newest one: a command
 * for a read that has ended must be refused, not applied to its replacement.
 */
export interface FocusCommand {
  action: FocusCommandAction;
  readSessionId: string;
}

/**
 * The answer ReadBridge gives back. It is only `applied` once the suspension or
 * restoration is TRUE - the audio is really stopped or really running again.
 */
export type FocusCommandOutcome = 'applied' | 'participantUnavailable' | 'rejected' | 'failed';

export type FocusCommandHandler = (command: FocusCommand) => Promise<FocusCommandOutcome>;

/**
 * ReadBridge's narrow view of an external audio-focus authority.
 *
 * The split of responsibility is the whole point:
 *
 * * the authority decides whether ReadBridge may be audible, when it is preempted, when
 *   it is restored, and what happens to the user's background media;
 * * ReadBridge decides how its own TTS and playback actually stop and start, and remains
 *   the only thing that knows whether they truly did.
 *
 * `ReaderController` therefore never sees a lease, a priority, a GSMTC session or a
 * browser tab, and the authority never sees a TTS stream or a playback cursor.
 */
export interface IReadAudioFocusCoordinator {
  readonly coordinatorId: string;

  /**
   * Whether this coordinator really arbitrates. A controller wired to one that does is
   * in INTEGRATED mode and may not become audible without a grant - including when the
   * authority is unreachable, which is a refusal, not a licence to play.
   */
  readonly arbitrates: boolean;

  /** True while the authority believes this exact read holds focus. */
  holdsFocus(readSessionId: string): boolean;

  requestSpokenOutputFocus(readSessionId: string): Promise<FocusGrantResult>;

  /**
   * Releases focus for exactly this read. Idempotent, and never called for a suspension
   * the authority itself ordered - a preempted read keeps its logical focus.
   */
  releaseSpokenOutputFocus(readSessionId: string): Promise<void>;

  /** Registers the handler that carries out SUSPEND/RESUME. At most one is meaningful. */
  onCommand(handler: FocusCommandHandler): () => void;

  /**
   * Fires when the authority connection is lost while ReadBridge may be audible. The
   * controller's answer is to fall silent, never to keep speaking unarbitrated.
   */
  onConnectionLost(listener: () => void): () => void;

  dispose(): Promise<void>;
}

/**
 * The explicit opt-out: a coordinator that arbitrates nothing.
 *
 * `arbitrates` is false and is surfaced on the reader's snapshot, so a caller can always
 * tell an unarbitrated ReadBridge from an integrated one. It exists for tests and for
 * running ReadBridge standalone - never as a silent fallback when the real authority is
 * missing, which is exactly the failure it would be designed to hide.
 */
export class UnarbitratedAudioFocusCoordinator implements IReadAudioFocusCoordinator {
  public readonly coordinatorId = 'unarbitrated';
  public readonly arbitrates = false;

  private readonly held = new Set<string>();

  public holdsFocus(readSessionId: string): boolean {
    return this.held.has(readSessionId);
  }

  public async requestSpokenOutputFocus(readSessionId: string): Promise<FocusGrantResult> {
    this.held.add(readSessionId);
    return { outcome: 'granted', granted: true, detail: 'No audio-focus authority is configured.' };
  }

  public async releaseSpokenOutputFocus(readSessionId: string): Promise<void> {
    this.held.delete(readSessionId);
  }

  public onCommand(_handler: FocusCommandHandler): () => void {
    return () => {};
  }

  public onConnectionLost(_listener: () => void): () => void {
    return () => {};
  }

  public async dispose(): Promise<void> {
    this.held.clear();
  }
}
