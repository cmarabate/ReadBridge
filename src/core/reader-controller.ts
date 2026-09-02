import {
  IAudioPlaybackSession,
  IAudioPlaybackSink,
  PlaybackSessionState,
} from './audio/playback-interface.js';
import {
  FocusCommand,
  FocusCommandOutcome,
  IReadAudioFocusCoordinator,
} from './focus/audio-focus-contract.js';
import { ReaderStateMachine } from './state-machine.js';
import {
  ITtsProvider,
  ITtsStreamSession,
  TtsAudioChunk,
  TtsFlowControlResult,
  TtsWordAlignment,
} from './tts/provider-interface.js';
import {
  PlaybackStateSnapshot,
  ReaderDocument,
  ReaderLifecycleState,
  TextRangeGeometry,
  TextSourceAdapter,
  TextSourceCapabilities,
} from './types.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  readonly settled: boolean;
}

/** A promise a producer, a routing failure, or a stop can each be the first to settle. */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T) => {
      if (settled) return;
      settled = true;
      res(value);
    };
    reject = (error: Error) => {
      if (settled) return;
      settled = true;
      rej(error);
    };
  });
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

export class ReaderController {
  /** States a new `startRead` must first bring to a truthful stop. */
  private static readonly INTERRUPTIBLE_STATES: ReaderLifecycleState[] = [
    'acquiring',
    'preparing',
    'playing',
    'paused',
    'seeking',
  ];

  private readonly stateMachine = new ReaderStateMachine();
  private readonly ttsProvider: ITtsProvider;
  private readonly playbackSink: IAudioPlaybackSink;
  private currentAdapter: TextSourceAdapter | null = null;
  private currentCapabilities: TextSourceCapabilities | null = null;
  private currentDocument: ReaderDocument | null = null;
  private activeStreamSession: ITtsStreamSession | null = null;

  /**
   * The read this controller currently owns. Cleared the moment a read ends, so a late callback
   * from an abandoned read is refused even though `stateMachine.sessionId` still names it (the
   * state machine keeps the id across `stop()` in order to report which read reached idle).
   */
  private activeReadSessionId: string | null = null;

  private activePlaybackSession: IAudioPlaybackSession | null = null;
  private unsubscribePlaybackCompleted: (() => void) | null = null;
  private playbackState: PlaybackSessionState | null = null;
  private lastObservedPlaybackPositionMs = 0;

  /**
   * Serializes audio routing. TTS chunk callbacks are synchronous but writing to the sink is not,
   * so without a queue chunks could reach the output out of order.
   */
  private audioPump: Promise<void> = Promise.resolve();
  private playbackFailure: string | null = null;

  /**
   * The background task streaming text into the TTS session and draining its output. Production
   * runs in the background because a suspended output gate blocks its producer: awaiting the whole
   * stream in `startRead` would strand the caller behind a pause.
   */
  private activeProduction: Promise<void> | null = null;

  /** Settles when playback genuinely started, or when it became certain it never would. */
  private startSignal: Deferred<void> | null = null;

  /** Set only by `suspendForAudioFocusAsync`, so a focus release cannot undo a user's own pause. */
  private pausedForAudioFocus = false;

  /**
   * The external audio-focus authority, if this controller is integrated with one.
   * Null means standalone: nothing arbitrates, and the snapshot says so.
   */
  private readonly focusCoordinator: IReadAudioFocusCoordinator | null;
  private unsubscribeFocusCommands: (() => void) | null = null;
  private unsubscribeFocusConnectionLost: (() => void) | null = null;

  /** The read this controller currently holds external audio focus for. */
  private focusHeldForSessionId: string | null = null;

  /**
   * True once the user has deliberately taken the read out of playing while the focus
   * authority believed it was merely preempted. A later restoration command must not
   * put audio back for a pause the user owns.
   */
  private userOverrodeFocusSuspension = false;

  /** True while playback is suspended because the focus authority became unreachable. */
  private suspendedByFocusLoss = false;

  private canonicalTextOffset: number = 0;
  private currentSentenceIndex: number = 0;
  private currentWord: string | null = null;
  private activeGeometry: TextRangeGeometry | null = null;
  private followMode: 'SOURCE_OVERLAY' | 'READER_SURFACE' = 'SOURCE_OVERLAY';

  private stateChangeListeners: Array<(snapshot: PlaybackStateSnapshot) => void> = [];
  private highlightListeners: Array<(geometry: TextRangeGeometry | null) => void> = [];

  /**
   * @param playbackSink Required. A controller with no audio output cannot truthfully report
   * `playing`, so the caller must choose an output explicitly - a real one, or
   * `SimulatedAudioPlaybackSink`, whose `producesAudibleOutput: false` reaches the snapshot.
   */
  /**
   * @param focusCoordinator Optional external audio-focus authority. Supplying one puts
   * this controller in INTEGRATED mode: it will not become audible without a grant, and
   * an unreachable authority is a refusal rather than a licence to play. Omitting one is
   * an explicit, snapshot-visible choice to run unarbitrated.
   */
  constructor(
    ttsProvider: ITtsProvider,
    playbackSink: IAudioPlaybackSink,
    focusCoordinator: IReadAudioFocusCoordinator | null = null
  ) {
    this.ttsProvider = ttsProvider;
    this.playbackSink = playbackSink;
    this.focusCoordinator = focusCoordinator?.arbitrates ? focusCoordinator : null;

    if (this.focusCoordinator) {
      this.unsubscribeFocusCommands = this.focusCoordinator.onCommand((command) =>
        this.handleFocusCommand(command)
      );
      this.unsubscribeFocusConnectionLost = this.focusCoordinator.onConnectionLost(() => {
        void this.handleFocusAuthorityLost();
      });
    }
  }

  /** Whether an external authority decides when this controller may be audible. */
  public get isFocusArbitrated(): boolean {
    return this.focusCoordinator !== null;
  }

  /** Detaches from the focus authority. The coordinator's own lifetime is the caller's. */
  public async dispose(): Promise<void> {
    this.unsubscribeFocusCommands?.();
    this.unsubscribeFocusCommands = null;
    this.unsubscribeFocusConnectionLost?.();
    this.unsubscribeFocusConnectionLost = null;
    await this.stop();
  }

  public get state(): ReaderLifecycleState {
    return this.stateMachine.state;
  }

  public get sessionId(): string {
    return this.stateMachine.sessionId;
  }

  /** The playback session backing the current read, if one has been opened. */
  public get playbackSessionId(): string | null {
    return this.activePlaybackSession?.playbackSessionId ?? null;
  }

  public async startRead(adapter: TextSourceAdapter): Promise<void> {
    // A start replaces whatever was playing. End that read properly first - two live playback
    // sessions would mean two owners of one output device - and go through stop() so the previous
    // read reaches idle truthfully rather than being abandoned mid-state.
    if (ReaderController.INTERRUPTIBLE_STATES.includes(this.stateMachine.state)) {
      await this.stop();
    }
    await this.releasePlayback();

    const sessionId = `read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.stateMachine.startSession(sessionId);
    this.activeReadSessionId = sessionId;
    this.currentAdapter = adapter;
    this.canonicalTextOffset = 0;
    this.currentSentenceIndex = 0;
    this.currentWord = null;
    this.activeGeometry = null;
    this.playbackState = null;
    this.lastObservedPlaybackPositionMs = 0;
    this.playbackFailure = null;
    this.pausedForAudioFocus = false;
    this.audioPump = Promise.resolve();
    this.activeProduction = null;
    this.userOverrodeFocusSuspension = false;
    this.suspendedByFocusLoss = false;
    // Every read starts with upstream output RUNNING. Flow state is owned by the stream session
    // this read creates, so a suspended predecessor can never hand its state to a successor.
    this.startSignal = null;
    this.emitState();

    try {
      // 1. Acquire capabilities & text
      const caps = await adapter.getCapabilities();
      this.currentCapabilities = caps;

      let doc = await adapter.getSelection();
      if (!doc || !doc.fullText.trim()) {
        doc = await adapter.getVisibleText();
      }
      if (!doc || !doc.fullText.trim()) {
        doc = await adapter.getDocumentText();
      }

      if (!doc || !doc.fullText.trim()) {
        throw new Error(`Unable to acquire readable text from source '${adapter.name}'.`);
      }

      this.currentDocument = doc;

      // Decide Follow Mode
      if (caps.level === 'READER_FALLBACK' || !caps.supportsWordGeometry || !this.ttsProvider.supportsWordLevelTimestamps) {
        this.followMode = 'READER_SURFACE';
      } else {
        this.followMode = 'SOURCE_OVERLAY';
      }

      // 2. Prepare TTS Stream
      this.stateMachine.transitionTo('preparing', sessionId);
      this.emitState();

      const ttsSession = await this.ttsProvider.createStreamSession({
        voiceId: 'default-neural',
        speakingRate: 1.0,
      });

      this.activeStreamSession = ttsSession;

      ttsSession.onWordAlignment(async (alignment: TtsWordAlignment) => {
        if (!this.isCurrentSession(sessionId)) return;
        await this.handleWordAlignment(alignment, sessionId);
      });

      ttsSession.onAudioChunk((chunk) => {
        if (!this.isCurrentSession(sessionId)) return;
        // Queued rather than awaited: the pump preserves chunk order and keeps a routing failure
        // from escaping into the provider's synchronous emit loop.
        this.audioPump = this.audioPump
          .then(() => this.routeAudioChunk(chunk, sessionId))
          .catch((err: any) => {
            if (!this.isCurrentSession(sessionId)) return;
            const message: string = err?.message ?? String(err);
            if (!this.playbackFailure) {
              this.playbackFailure = message;
            }
            // A routing failure must reach a caller still waiting for playback to start; the
            // producer may be blocked and would otherwise never settle the signal.
            this.startSignal?.reject(new Error(this.playbackFailure ?? message));
          });
      });

      // 3. Stream the text in the background, and wait only for the truthful start boundary: the
      //    playback session accepting audio. The controller stays in `preparing` until then - it
      //    must never claim `playing` because a stream object exists.
      const startSignal = createDeferred<void>();
      this.startSignal = startSignal;

      this.activeProduction = (async () => {
        await ttsSession.sendTextDelta(doc.fullText, true);
        await ttsSession.completeInput();
        await this.audioPump;
      })().then(
        () => {
          if (!this.isCurrentSession(sessionId)) return;
          if (this.playbackFailure) {
            startSignal.reject(new Error(this.playbackFailure));
          } else if (!this.activePlaybackSession) {
            startSignal.reject(
              new Error(
                `TTS provider '${this.ttsProvider.providerId}' produced no audio for ` +
                  `${doc.fullText.length} characters; nothing was played.`
              )
            );
          } else {
            startSignal.resolve();
          }
        },
        (err: any) => {
          if (!this.isCurrentSession(sessionId)) return;
          startSignal.reject(err instanceof Error ? err : new Error(String(err)));
        }
      );

      await startSignal.promise;
    } catch (err: any) {
      if (this.activeStreamSession) {
        // Cancelling wakes a producer that may be blocked on its own output gate.
        await this.activeStreamSession.cancel();
        this.activeStreamSession = null;
      }
      this.activeProduction = null;
      this.startSignal = null;
      await this.releasePlayback();

      // A grant that never became audible must be handed back promptly: the user's
      // background media is paused on its behalf.
      await this.releaseFocus(sessionId);
      this.activeReadSessionId = null;
      this.stateMachine.transitionTo('error', sessionId, err.message);
      this.emitState();
      throw err;
    }
  }

  /**
   * TTS audio chunk -> current playback session. The playback session, not the provider, owns the
   * output cursor; the provider's `isFinal` means its INPUT is finished, never that audio drained.
   */
  private async routeAudioChunk(chunk: TtsAudioChunk, sessionId: string): Promise<void> {
    if (!this.isCurrentSession(sessionId)) return;

    // A read that has already failed to route is finished. Continuing would re-request
    // audio focus for every remaining chunk of a read that is being torn down.
    if (this.playbackFailure) return;

    // An empty chunk carries no audio, so it must not bring a playback session into existence:
    // a session opened by the provider's final empty marker would let a read that produced no
    // audio at all look like one that played.
    if (!this.activePlaybackSession && chunk.audioData.length === 0) return;

    if (!this.activePlaybackSession) {
      // THE PRE-START GATE. Real audio exists and is about to be handed to an output, so
      // this is the last moment before ReadBridge becomes audible - and therefore the
      // moment focus must be settled. Asking after opening the device would mean
      // announcing playback that had already started.
      const grant = await this.acquireFocus(sessionId);
      if (!this.isCurrentSession(sessionId)) return;

      if (!grant.granted) {
        throw new Error(
          `Audio focus was not granted for read '${sessionId}' (${grant.outcome})` +
            `${grant.detail ? `: ${grant.detail}` : ''}; nothing was played.`
        );
      }

      const session = await this.playbackSink.createSession(sessionId, chunk.format);
      if (!this.isCurrentSession(sessionId)) {
        // The read was abandoned while the output was opening.
        await session.dispose();
        return;
      }
      // From here the grant is backed by a real playback session. If anything below
      // fails, startRead's catch releases focus rather than leaving the user's
      // background media paused for a read that never became audible.
      this.activePlaybackSession = session;
      this.unsubscribePlaybackCompleted = session.onCompleted((playbackSessionId, positionMs) => {
        this.handlePlaybackCompleted(playbackSessionId, sessionId, positionMs);
      });
    }

    const playback = this.activePlaybackSession;

    if (chunk.audioData.length > 0) {
      const result = await playback.write(chunk.audioData);
      if (!this.isCurrentSession(sessionId)) return;

      this.playbackState = result.state;
      this.lastObservedPlaybackPositionMs = result.positionMs;

      if (!result.accepted) {
        throw new Error(
          `Playback output refused ${chunk.audioData.length} bytes of audio (${result.reason ?? 'unknown reason'}); ` +
            `queued ${result.queuedBytes}/${result.maxQueuedBytes} bytes.`
        );
      }

      // The truthful start boundary: `playing` means the output has taken audio.
      if (result.state === 'playing' && this.stateMachine.state === 'preparing') {
        this.stateMachine.transitionTo('playing', sessionId);
        this.emitState();
        this.startSignal?.resolve();
      }
    }

    if (chunk.isFinal) {
      const result = await playback.completeInput();
      if (!this.isCurrentSession(sessionId)) return;
      this.playbackState = result.state;
      this.lastObservedPlaybackPositionMs = result.positionMs;
    }
  }

  private async handleWordAlignment(alignment: TtsWordAlignment, sessionId: string): Promise<void> {
    if (!this.isCurrentSession(sessionId)) return;

    this.currentWord = alignment.word;
    this.canonicalTextOffset = alignment.charStart;

    // Update sentence index
    if (this.currentDocument) {
      const sentIdx = this.currentDocument.sentences.findIndex(
        (s) => alignment.charStart >= s.charStart && alignment.charStart < s.charStart + s.charLength
      );
      if (sentIdx !== -1) {
        this.currentSentenceIndex = sentIdx;
      }
    }

    // Resolve geometry if in overlay follow mode
    if (this.followMode === 'SOURCE_OVERLAY' && this.currentAdapter) {
      try {
        const geom = await this.currentAdapter.resolveRangeGeometry(
          alignment.charStart,
          alignment.charLength
        );
        if (!this.isCurrentSession(sessionId)) return;
        this.activeGeometry = geom;
        this.emitHighlight(geom);
      } catch {
        // Degrade to Reader surface if geometry resolution fails
        if (!this.isCurrentSession(sessionId)) return;
        this.followMode = 'READER_SURFACE';
        this.activeGeometry = null;
        this.emitHighlight(null);
      }
    }

    this.emitState();
  }

  /** Natural completion: the OUTPUT drained, which is the only thing that ends a read by itself. */
  private handlePlaybackCompleted(playbackSessionId: string, sessionId: string, positionMs: number): void {
    if (!this.isCurrentSession(sessionId)) return;
    if (this.activePlaybackSession?.playbackSessionId !== playbackSessionId) return;

    this.playbackState = 'completed';
    this.lastObservedPlaybackPositionMs = positionMs;
    this.activeReadSessionId = null;
    this.pausedForAudioFocus = false;

    const finished = this.activePlaybackSession;
    this.unsubscribePlaybackCompleted?.();
    this.unsubscribePlaybackCompleted = null;
    this.activePlaybackSession = null;
    this.activeStreamSession = null;
    this.activeProduction = null;
    this.startSignal = null;

    // The read is over, so its focus is over. Only once no participant remains may the
    // authority causally restore the background media it paused on our behalf.
    void this.releaseFocus(sessionId).catch(() => {
      // A release that could not be delivered is handled by the authority's own
      // disconnect invalidation; there is nothing further to do here.
    });
    void finished?.dispose().catch(() => {
      // The session already drained; a teardown failure has nothing left to protect.
    });

    if (this.stateMachine.state === 'playing' || this.stateMachine.state === 'paused') {
      this.stateMachine.transitionTo('idle', sessionId);
      this.activeGeometry = null;
      this.emitHighlight(null);
      this.emitState();
    }
  }

  /**
   * A USER pause.
   *
   * Runs the same truthful two-layer suspension as a preemption, and then gives audio
   * focus BACK - because a user who paused is not waiting to be restored, and holding
   * focus would keep their background media suppressed indefinitely. This is the whole
   * difference from a preemption, where focus is deliberately retained.
   */
  public async pause(): Promise<void> {
    // Pausing a read the authority already suspended is the user TAKING THAT PAUSE OVER.
    // Audio is already silent, so there is nothing to suspend - but the ownership must
    // change hands, or a later restoration would put audio back that the user stopped.
    if (
      this.stateMachine.state === 'paused' &&
      this.pausedForAudioFocus &&
      this.activeReadSessionId === this.stateMachine.sessionId
    ) {
      const takenOver = this.stateMachine.sessionId;
      this.userOverrodeFocusSuspension = true;
      this.pausedForAudioFocus = false;
      await this.releaseFocus(takenOver);
      this.emitState();
      return;
    }

    if (this.stateMachine.state !== 'playing') return;

    const pausedSessionId = this.stateMachine.sessionId;
    await this.suspendPlaybackTransaction();

    if (this.readCurrentState() !== 'paused' || !this.isPausedRead(pausedSessionId)) {
      return;
    }

    // The user now owns this pause. If the authority had preempted us, it must not put
    // audio back on a later restoration command.
    if (this.pausedForAudioFocus) {
      this.userOverrodeFocusSuspension = true;
      this.pausedForAudioFocus = false;
    }

    await this.releaseFocus(pausedSessionId);

    // Only an arbitrated reader has focus state to report; emitting in standalone mode
    // would be a second identical `paused` snapshot for no change at all.
    if (this.focusCoordinator) {
      this.emitState();
    }
  }

  /**
   * The truthful two-layer suspension itself, with no opinion about focus. Both a user
   * pause and an authority-ordered preemption go through exactly this, so there is only
   * ever one pause mechanism.
   */
  private async suspendPlaybackTransaction(): Promise<void> {
    if (this.stateMachine.state !== 'playing') return;

    const sessionId = this.stateMachine.sessionId;
    const playback = this.activePlaybackSession;
    const stream = this.activeStreamSession;
    if (!playback) {
      throw new Error(
        `Cannot pause read '${sessionId}': it has no playback session, so there is no audio to suspend.`
      );
    }

    // Layer 1: quiesce upstream output FIRST. Pausing the device while the provider keeps
    // producing is what let a long pause fill the playback queue and end a valid read.
    let suspend: TtsFlowControlResult | null = null;
    if (stream) {
      suspend = await stream.suspendOutput();
      if (!this.isCurrentSession(sessionId)) return;

      if (!suspend.ok) {
        throw new Error(
          `TTS output did not suspend (${suspend.outcome}); playback was left running and ` +
            `reader state remains '${this.readCurrentState()}'.`
        );
      }

      // The gate is quiescent, so this drains what the last admitted delivery routed and cannot
      // be extended by new output.
      await this.audioPump;
      if (!this.isCurrentSession(sessionId)) return;
    }

    // Layer 2: pause the device itself.
    const result = await playback.pause();
    if (!this.isCurrentSession(sessionId)) return;

    this.playbackState = result.state;
    this.lastObservedPlaybackPositionMs = result.positionMs;

    if (!result.ok || result.state !== 'paused') {
      // Roll upstream back to running - only if this call is what suspended it. Leaving the
      // provider suspended while audio still plays would starve a read that never paused.
      if (stream && suspend?.outcome === 'suspended') {
        await stream.resumeOutput();
      }
      throw new Error(
        `Playback output did not pause (${result.reason ?? result.state}); ` +
          `TTS output was rolled back to running and reader state remains '${this.readCurrentState()}'.`
      );
    }

    this.stateMachine.transitionTo('paused', sessionId);
    this.emitState();
  }

  /**
   * A USER resume.
   *
   * Focus is reacquired BEFORE anything becomes audible again, because the pause gave it
   * back and something else may hold it now. A refusal leaves the read paused; a grant
   * that is then followed by a failed restoration is handed straight back.
   */
  public async resume(): Promise<void> {
    if (this.stateMachine.state !== 'paused') return;

    const sessionId = this.stateMachine.sessionId;
    const hadFocus = this.holdsFocusFor(sessionId);

    if (!hadFocus) {
      const grant = await this.acquireFocus(sessionId);
      if (!this.isPausedRead(sessionId)) return;

      if (!grant.granted) {
        throw new Error(
          `Cannot resume read '${sessionId}': audio focus was not granted (${grant.outcome})` +
            `${grant.detail ? `: ${grant.detail}` : ''}; the read remains paused.`
        );
      }
    }

    try {
      await this.restorePlaybackTransaction();
    } catch (err) {
      // A grant this call obtained must not outlive a restoration that failed.
      if (!hadFocus) {
        await this.releaseFocus(sessionId);
      }
      throw err;
    }

    if (this.readCurrentState() !== 'playing' && !hadFocus) {
      await this.releaseFocus(sessionId);
    }

    this.userOverrodeFocusSuspension = false;
    this.suspendedByFocusLoss = false;
  }

  /**
   * The truthful two-layer restoration itself, with no opinion about focus.
   */
  private async restorePlaybackTransaction(): Promise<void> {
    if (this.stateMachine.state !== 'paused') return;

    const sessionId = this.stateMachine.sessionId;
    const playback = this.activePlaybackSession;
    const stream = this.activeStreamSession;
    if (!playback) {
      throw new Error(
        `Cannot resume read '${sessionId}': its playback session is gone, so the cursor cannot be restored.`
      );
    }

    // Layer 1: upstream first. If the provider cannot resume, audio should stay physically
    // paused rather than play out a buffer that will never be refilled.
    let flow: TtsFlowControlResult | null = null;
    if (stream) {
      flow = await stream.resumeOutput();
      if (!this.isCurrentSession(sessionId)) return;

      if (!flow.ok) {
        throw new Error(
          `TTS output did not resume (${flow.outcome}); playback was left paused and ` +
            `reader state remains '${this.readCurrentState()}'.`
        );
      }
    }

    // Layer 2: the device.
    const result = await playback.resume();
    if (!this.isCurrentSession(sessionId)) return;

    this.playbackState = result.state;
    this.lastObservedPlaybackPositionMs = result.positionMs;

    if (!result.ok || result.state !== 'playing') {
      // Roll upstream back to suspended - only if this call is what resumed it. Whatever the
      // provider produced in the interval is bounded by the playback queue cap.
      if (stream && flow?.outcome === 'resumed') {
        await stream.suspendOutput();
      }
      throw new Error(
        `Playback output did not resume (${result.reason ?? result.state}); ` +
          `TTS output was rolled back to suspended and reader state remains '${this.readCurrentState()}'.`
      );
    }

    this.pausedForAudioFocus = false;
    this.stateMachine.transitionTo('playing', sessionId);
    this.emitState();
  }

  public async stop(): Promise<void> {
    if (this.stateMachine.state !== 'idle') {
      const sessionId = this.stateMachine.sessionId;

      // Ownership is dropped before any await, so a chunk still in flight cannot be routed into a
      // session that is being torn down.
      this.activeReadSessionId = null;
      this.startSignal?.reject(new Error(`Read '${sessionId}' was stopped before playback started.`));
      this.startSignal = null;

      if (this.activeStreamSession) {
        // Cancel wakes any producer blocked on a suspended output gate; without that, stopping a
        // paused read would strand that task forever and its audio could surface later.
        await this.activeStreamSession.cancel();
        this.activeStreamSession = null;
      }

      // Bounded by the cancellation above: the producer has been woken and must exit.
      const production = this.activeProduction;
      this.activeProduction = null;
      if (production) {
        await production.catch(() => {
          // A production task that failed on the way out has nothing left to protect.
        });
      }
      await this.audioPump.catch(() => undefined);

      await this.releasePlayback();

      // Releasing the exact participant is what lets the authority skip a dead
      // predecessor later, instead of trying to restore a read that no longer exists.
      await this.releaseFocus(sessionId);
      this.userOverrodeFocusSuspension = false;
      this.suspendedByFocusLoss = false;

      this.stateMachine.transitionTo('stopping', sessionId);
      this.activeGeometry = null;
      this.emitHighlight(null);
      this.emitState();

      this.stateMachine.transitionTo('idle', sessionId);
      this.emitState();
    }
  }

  // ---- Audio-focus seam ------------------------------------------------------------
  //
  // A narrow, ReadBridge-owned entry point for a future external audio-focus arbiter. It knows
  // nothing about any wire format, lease, or priority, and it adds no second pause mechanism: it
  // delegates to the same truthful pause()/resume() path everything else uses.

  /**
   * Suspends because the authority preempted this read.
   *
   * Focus is deliberately NOT released: the authority already owns the transition from
   * Active to Preempted, and a release here would turn a preemption into an ending -
   * the read would never be restored and the background media would come back early.
   *
   * @returns whether audio output is genuinely suspended now.
   */
  public async suspendForAudioFocusAsync(): Promise<boolean> {
    if (this.stateMachine.state === 'paused') {
      return true;
    }
    if (this.stateMachine.state !== 'playing') {
      return false;
    }

    await this.suspendPlaybackTransaction();

    // Re-read after the await: the transaction throws when the output refuses, and a
    // completion can land while the suspension is in flight, so the state before the
    // await proves nothing about it now.
    const suspended = this.readCurrentState() === 'paused';
    if (suspended) {
      this.pausedForAudioFocus = true;
    }
    return suspended;
  }

  /**
   * Restores after the authority released whatever preempted this read.
   *
   * No new focus request is made: the authority restored this participant logically, so
   * asking again would be asking for something already held. Refuses to resume a pause it
   * did not cause, so a restoration cannot override a pause the user asked for.
   *
   * @returns whether audio output is genuinely playing again.
   */
  public async resumeForAudioFocusAsync(): Promise<boolean> {
    if (this.stateMachine.state === 'playing') {
      return true;
    }
    if (this.stateMachine.state !== 'paused' || !this.pausedForAudioFocus) {
      return false;
    }

    await this.restorePlaybackTransaction();
    const playing = this.readCurrentState() === 'playing';
    if (playing) {
      this.pausedForAudioFocus = false;
    }
    return playing;
  }

  // ---- Focus authority plumbing -----------------------------------------------------

  private holdsFocusFor(sessionId: string): boolean {
    return this.focusCoordinator?.holdsFocus(sessionId) ?? this.focusHeldForSessionId === sessionId;
  }

  private isPausedRead(sessionId: string): boolean {
    return this.stateMachine.sessionId === sessionId && this.readCurrentState() === 'paused';
  }

  private async acquireFocus(sessionId: string): Promise<{
    granted: boolean;
    outcome: string;
    detail?: string;
  }> {
    if (!this.focusCoordinator) {
      // Standalone mode, chosen explicitly at construction and visible on the snapshot.
      return { granted: true, outcome: 'unarbitrated' };
    }

    const result = await this.focusCoordinator.requestSpokenOutputFocus(sessionId);
    if (result.granted) {
      this.focusHeldForSessionId = sessionId;
    }
    return result;
  }

  private async releaseFocus(sessionId: string): Promise<void> {
    if (this.focusHeldForSessionId === sessionId) {
      this.focusHeldForSessionId = null;
    }

    if (!this.focusCoordinator) {
      return;
    }

    try {
      await this.focusCoordinator.releaseSpokenOutputFocus(sessionId);
    } catch {
      // A release the authority never heard is covered by its disconnect invalidation.
    }
  }

  /**
   * Carries out one SUSPEND/RESUME from the authority, for an EXACT read.
   *
   * Everything that is not the live read fails closed. There is no fallback to the
   * current or newest read: a command for a read that has ended is unavailable, and a
   * restoration of a pause the user took over is refused so the authority can invalidate
   * that phantom participant rather than putting audio back.
   */
  private async handleFocusCommand(command: FocusCommand): Promise<FocusCommandOutcome> {
    if (command.readSessionId !== this.activeReadSessionId) {
      return 'participantUnavailable';
    }

    try {
      if (command.action === 'suspend') {
        return (await this.suspendForAudioFocusAsync()) ? 'applied' : 'rejected';
      }

      if (this.userOverrodeFocusSuspension || this.suspendedByFocusLoss) {
        return 'rejected';
      }

      return (await this.resumeForAudioFocusAsync()) ? 'applied' : 'rejected';
    } catch {
      return 'failed';
    }
  }

  /**
   * The authority became unreachable while this read may be audible.
   *
   * Falling silent is the only safe answer: continuing would mean speaking over whatever
   * the arbiter would have protected. It does not resume by itself when the connection
   * comes back - focus has to be truthfully reacquired first, which a user resume does.
   */
  private async handleFocusAuthorityLost(): Promise<void> {
    this.focusHeldForSessionId = null;

    if (this.readCurrentState() !== 'playing') {
      return;
    }

    this.suspendedByFocusLoss = true;
    try {
      await this.suspendPlaybackTransaction();
    } catch {
      // Reported through the snapshot; there is no safer action available here.
    }

    if (this.readCurrentState() === 'paused') {
      this.pausedForAudioFocus = false;
      this.stateMachine.transitionTo(
        'error',
        this.stateMachine.sessionId,
        'The audio-focus authority became unreachable; playback was suspended.'
      );
      this.emitState();
    }
  }

  public getSnapshot(): PlaybackStateSnapshot {
    return {
      sessionId: this.stateMachine.sessionId,
      state: this.stateMachine.state,
      sourceIdentity: this.currentDocument?.sourceIdentity ?? null,
      documentTitle: this.currentDocument?.title ?? null,
      totalCharacters: this.currentDocument?.fullText.length ?? 0,
      canonicalTextOffset: this.canonicalTextOffset,
      currentSentenceIndex: this.currentSentenceIndex,
      currentWord: this.currentWord,
      activeGeometry: this.activeGeometry,
      followMode: this.followMode,
      playbackSessionId: this.activePlaybackSession?.playbackSessionId ?? null,
      playbackState: this.playbackState,
      ttsOutputState: this.activeStreamSession?.outputFlowState ?? null,
      lastObservedPlaybackPositionMs: this.lastObservedPlaybackPositionMs,
      producesAudibleOutput: this.playbackSink.producesAudibleOutput,
      focusArbitrated: this.focusCoordinator !== null,
      holdsAudioFocus: this.focusHeldForSessionId !== null &&
        this.focusHeldForSessionId === this.stateMachine.sessionId,
      pausedByAudioFocus: this.pausedForAudioFocus,
      error: this.stateMachine.lastError,
    };
  }

  public onStateChange(listener: (snapshot: PlaybackStateSnapshot) => void): () => void {
    this.stateChangeListeners.push(listener);
    return () => {
      this.stateChangeListeners = this.stateChangeListeners.filter((l) => l !== listener);
    };
  }

  public onHighlight(listener: (geometry: TextRangeGeometry | null) => void): () => void {
    this.highlightListeners.push(listener);
    return () => {
      this.highlightListeners = this.highlightListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Both fences, deliberately. The state machine's id survives `stop()`, so on its own it would
   * still admit a callback from a read that has already ended.
   */
  /** Re-reads the live state. A getter would carry narrowing from before an await. */
  private readCurrentState(): ReaderLifecycleState {
    return this.stateMachine.state;
  }

  private isCurrentSession(sessionId: string): boolean {
    return this.activeReadSessionId === sessionId && this.stateMachine.sessionId === sessionId;
  }

  private async releasePlayback(): Promise<void> {
    this.unsubscribePlaybackCompleted?.();
    this.unsubscribePlaybackCompleted = null;

    const playback = this.activePlaybackSession;
    this.activePlaybackSession = null;
    this.pausedForAudioFocus = false;

    if (!playback) return;

    try {
      await playback.stop();
    } finally {
      await playback.dispose();
    }
    this.playbackState = 'stopped';
  }

  private emitState(): void {
    const snap = this.getSnapshot();
    for (const listener of this.stateChangeListeners) {
      listener(snap);
    }
  }

  private emitHighlight(geom: TextRangeGeometry | null): void {
    for (const listener of this.highlightListeners) {
      listener(geom);
    }
  }
}
