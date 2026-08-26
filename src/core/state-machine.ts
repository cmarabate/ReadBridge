import { ReaderLifecycleState } from './types.js';

export interface StateTransitionResult {
  from: ReaderLifecycleState;
  to: ReaderLifecycleState;
  sessionId: string;
  timestamp: number;
}

export class ReaderStateMachine {
  private _state: ReaderLifecycleState = 'idle';
  private _currentSessionId: string = '';
  private _lastError: string | null = null;

  private static readonly ALLOWED_TRANSITIONS: Record<ReaderLifecycleState, ReaderLifecycleState[]> = {
    idle: ['acquiring', 'preparing', 'error'],
    acquiring: ['preparing', 'idle', 'stopping', 'error'],
    preparing: ['playing', 'idle', 'stopping', 'error'],
    playing: ['paused', 'seeking', 'stopping', 'idle', 'error'],
    paused: ['playing', 'seeking', 'stopping', 'idle', 'error'],
    seeking: ['playing', 'paused', 'stopping', 'idle', 'error'],
    stopping: ['idle', 'error'],
    error: ['idle', 'acquiring'],
  };

  public get state(): ReaderLifecycleState {
    return this._state;
  }

  public get sessionId(): string {
    return this._currentSessionId;
  }

  public get lastError(): string | null {
    return this._lastError;
  }

  public startSession(sessionId: string): StateTransitionResult {
    this._currentSessionId = sessionId;
    this._lastError = null;
    return this.transitionTo('acquiring', sessionId);
  }

  public transitionTo(
    nextState: ReaderLifecycleState,
    sessionId: string,
    errorMessage?: string
  ): StateTransitionResult {
    if (this._currentSessionId && sessionId !== this._currentSessionId) {
      throw new Error(
        `Session mismatch: Stale session '${sessionId}' attempted to transition state for active session '${this._currentSessionId}'.`
      );
    }

    const allowed = ReaderStateMachine.ALLOWED_TRANSITIONS[this._state];
    if (!allowed.includes(nextState)) {
      throw new Error(
        `Invalid state transition: Cannot transition from '${this._state}' to '${nextState}' in session '${sessionId}'.`
      );
    }

    const from = this._state;
    this._state = nextState;
    if (errorMessage) {
      this._lastError = errorMessage;
    } else if (nextState === 'idle') {
      this._lastError = null;
    }

    return {
      from,
      to: nextState,
      sessionId,
      timestamp: Date.now(),
    };
  }

  public reset(sessionId?: string): void {
    if (!sessionId || sessionId === this._currentSessionId) {
      this._state = 'idle';
      this._currentSessionId = '';
      this._lastError = null;
    }
  }
}
