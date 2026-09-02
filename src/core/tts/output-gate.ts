import { TtsFlowControlResult, TtsOutputFlowState } from './provider-interface.js';

/**
 * Provider-neutral output flow control for one TTS stream session.
 *
 * A producer hands every emission to this gate. While the gate is suspended, `beginDelivery()`
 * does not resolve, so the producer blocks *before* emitting rather than emitting into a paused
 * output. Audio chunks and word alignments go through the SAME gate, so highlights can never
 * advance past audio that is not being heard.
 *
 * Quiescence is the load-bearing guarantee. `suspend()` marks the gate suspended and then waits
 * for any delivery already in flight to finish, so by the time it resolves no further callback can
 * be delivered. At most one already-started delivery completes before that resolution; none
 * completes after it.
 *
 * The gate knows nothing about audio devices, playback cursors, audio focus, or any provider's
 * wire protocol. It only starts and stops the delivery of stream output.
 */
export class TtsOutputGate {
  private state: TtsOutputFlowState = 'running';
  private inFlight = 0;
  private deliveries = 0;
  private runningWaiters: Array<() => void> = [];
  private quiescentWaiters: Array<() => void> = [];

  public get flowState(): TtsOutputFlowState {
    return this.state;
  }

  /** Completed deliveries. A caller can prove quiescence by watching this stop moving. */
  public get deliveredCount(): number {
    return this.deliveries;
  }

  public get isQuiescent(): boolean {
    return this.inFlight === 0;
  }

  /**
   * Claims a delivery slot, blocking while suspended.
   *
   * @returns false once the session is terminal - the producer must stop, not retry.
   */
  public async beginDelivery(): Promise<boolean> {
    for (;;) {
      if (this.state === 'terminal') return false;
      if (this.state === 'running') {
        // Claimed synchronously in the same microtask as the check, so a suspend() cannot slip
        // between "the gate is running" and "this delivery is in flight".
        this.inFlight++;
        return true;
      }
      await new Promise<void>((resolve) => this.runningWaiters.push(resolve));
    }
  }

  public endDelivery(): void {
    if (this.inFlight === 0) return;
    this.inFlight--;
    this.deliveries++;
    if (this.inFlight === 0) {
      this.flush(this.quiescentWaiters);
    }
  }

  /**
   * Gates exactly one emission.
   *
   * @returns false if the session went terminal before the emission was admitted.
   */
  public async deliver(emit: () => void): Promise<boolean> {
    if (!(await this.beginDelivery())) return false;
    try {
      emit();
    } finally {
      this.endDelivery();
    }
    return true;
  }

  public async suspend(): Promise<TtsFlowControlResult> {
    if (this.state === 'terminal') return this.result('terminal');

    const alreadySuspended = this.state === 'suspended';
    this.state = 'suspended';
    await this.awaitQuiescence();
    return this.result(alreadySuspended ? 'alreadySuspended' : 'suspended');
  }

  public async resume(): Promise<TtsFlowControlResult> {
    if (this.state === 'terminal') return this.result('terminal');
    if (this.state === 'running') return this.result('alreadyRunning');

    this.state = 'running';
    this.flush(this.runningWaiters);
    return this.result('resumed');
  }

  /**
   * Terminal and irreversible. Wakes every waiter: a producer blocked on a suspended gate must
   * never survive its session's cancellation, and a `suspend()` awaiting quiescence must never
   * outlive the session it was waiting on.
   */
  public terminate(): void {
    this.state = 'terminal';
    this.flush(this.runningWaiters);
    this.flush(this.quiescentWaiters);
  }

  private async awaitQuiescence(): Promise<void> {
    if (this.inFlight === 0) return;
    await new Promise<void>((resolve) => this.quiescentWaiters.push(resolve));
  }

  private flush(waiters: Array<() => void>): void {
    const pending = waiters.splice(0, waiters.length);
    for (const resolve of pending) resolve();
  }

  private result(outcome: TtsFlowControlResult['outcome']): TtsFlowControlResult {
    return {
      ok: outcome !== 'failed',
      outcome,
      state: this.state,
      deliveredCount: this.deliveries,
    };
  }
}
