import {
  FocusCommand,
  FocusCommandHandler,
  FocusCommandOutcome,
  FocusGrantOutcome,
  FocusGrantResult,
  IReadAudioFocusCoordinator,
} from '../../src/core/focus/audio-focus-contract';

/**
 * A focus authority a test can drive.
 *
 * It arbitrates, so a controller wired to it is in INTEGRATED mode and may not become
 * audible without a grant. Every request, release and command is recorded in one ordered
 * log alongside the playback events, which is how "focus was settled BEFORE the output
 * opened" is asserted rather than assumed.
 */
export class FakeAudioFocusCoordinator implements IReadAudioFocusCoordinator {
  public readonly coordinatorId = 'fake-focus';
  public readonly arbitrates = true;

  /** Ordered record of everything this coordinator was asked to do. */
  public readonly log: string[];

  /** Exact participants focus was requested for, in order. */
  public readonly requested: string[] = [];

  /** Exact participants focus was released for, in order. */
  public readonly released: string[] = [];

  /** The next outcome each request returns; defaults to a grant. */
  public nextOutcome: FocusGrantOutcome = 'granted';

  private readonly held = new Set<string>();
  private handler: FocusCommandHandler | null = null;
  private connectionLostListeners: Array<() => void> = [];
  private disposed = false;

  constructor(log: string[] = []) {
    this.log = log;
  }

  public holdsFocus(readSessionId: string): boolean {
    return this.held.has(readSessionId);
  }

  public async requestSpokenOutputFocus(readSessionId: string): Promise<FocusGrantResult> {
    this.requested.push(readSessionId);
    this.log.push(`focus:request(${this.label(readSessionId)})`);

    const outcome = this.nextOutcome;
    const granted = outcome === 'granted' || outcome === 'alreadyHeld';
    if (granted) {
      this.held.add(readSessionId);
    }

    this.log.push(`focus:${outcome}`);
    return { outcome, granted };
  }

  public async releaseSpokenOutputFocus(readSessionId: string): Promise<void> {
    this.released.push(readSessionId);
    this.held.delete(readSessionId);
    this.log.push(`focus:release(${this.label(readSessionId)})`);
  }

  public onCommand(handler: FocusCommandHandler): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  public onConnectionLost(listener: () => void): () => void {
    this.connectionLostListeners.push(listener);
    return () => {
      this.connectionLostListeners = this.connectionLostListeners.filter((l) => l !== listener);
    };
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.handler = null;
    this.held.clear();
  }

  // ---- test drive ------------------------------------------------------------

  /** Sends one command exactly as the arbiter would, and returns the truthful answer. */
  public async command(action: 'suspend' | 'resume', readSessionId: string): Promise<FocusCommandOutcome> {
    if (!this.handler || this.disposed) {
      return 'participantUnavailable';
    }

    this.log.push(`command:${action}(${this.label(readSessionId)})`);
    const command: FocusCommand = { action, readSessionId };
    const outcome = await this.handler(command);
    this.log.push(`ack:${outcome}`);
    return outcome;
  }

  /** Simulates the authority connection dying. */
  public dropConnection(): void {
    this.held.clear();
    this.log.push('focus:connectionLost');
    for (const listener of [...this.connectionLostListeners]) listener();
  }

  /** Keeps assertions readable when read ids are random. */
  public labels = new Map<string, string>();

  public label(readSessionId: string): string {
    return this.labels.get(readSessionId) ?? readSessionId;
  }
}
