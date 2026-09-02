import {
  IAudioPlaybackSession,
  IAudioPlaybackSink,
  PlaybackSessionState,
} from './audio/playback-interface.js';
import { ReaderStateMachine } from './state-machine.js';
import { ITtsProvider, ITtsStreamSession, TtsAudioChunk, TtsWordAlignment } from './tts/provider-interface.js';
import {
  PlaybackStateSnapshot,
  ReaderDocument,
  ReaderLifecycleState,
  TextRangeGeometry,
  TextSourceAdapter,
  TextSourceCapabilities,
} from './types.js';

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

  /** Set only by `suspendForAudioFocusAsync`, so a focus release cannot undo a user's own pause. */
  private pausedForAudioFocus = false;

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
  constructor(ttsProvider: ITtsProvider, playbackSink: IAudioPlaybackSink) {
    this.ttsProvider = ttsProvider;
    this.playbackSink = playbackSink;
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
            if (this.isCurrentSession(sessionId) && !this.playbackFailure) {
              this.playbackFailure = err?.message ?? String(err);
            }
          });
      });

      // 3. Stream the text. The controller stays in `preparing` until the playback session has
      //    actually accepted audio - it must never claim `playing` because a stream object exists.
      await ttsSession.sendTextDelta(doc.fullText, true);
      await ttsSession.completeInput();
      await this.audioPump;

      if (this.playbackFailure) {
        throw new Error(this.playbackFailure);
      }
      if (!this.activePlaybackSession) {
        throw new Error(
          `TTS provider '${this.ttsProvider.providerId}' produced no audio for ` +
            `${doc.fullText.length} characters; nothing was played.`
        );
      }
    } catch (err: any) {
      await this.releasePlayback();
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

    // An empty chunk carries no audio, so it must not bring a playback session into existence:
    // a session opened by the provider's final empty marker would let a read that produced no
    // audio at all look like one that played.
    if (!this.activePlaybackSession && chunk.audioData.length === 0) return;

    if (!this.activePlaybackSession) {
      const session = await this.playbackSink.createSession(sessionId, chunk.format);
      if (!this.isCurrentSession(sessionId)) {
        // The read was abandoned while the output was opening.
        await session.dispose();
        return;
      }
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
   * Suspends real audio output first, and only reports `paused` if the output actually paused.
   * A pause that the output refused leaves the reader in `playing`, which is the truth.
   */
  public async pause(): Promise<void> {
    if (this.stateMachine.state !== 'playing') return;

    const sessionId = this.stateMachine.sessionId;
    const playback = this.activePlaybackSession;
    if (!playback) {
      throw new Error(
        `Cannot pause read '${sessionId}': it has no playback session, so there is no audio to suspend.`
      );
    }

    const result = await playback.pause();
    if (!this.isCurrentSession(sessionId)) return;

    this.playbackState = result.state;
    this.lastObservedPlaybackPositionMs = result.positionMs;

    if (!result.ok || result.state !== 'paused') {
      throw new Error(
        `Playback output did not pause (${result.reason ?? result.state}); ` +
          `reader state remains '${this.stateMachine.state}'.`
      );
    }

    this.stateMachine.transitionTo('paused', sessionId);
    this.emitState();
  }

  /**
   * Resumes THE SAME playback session. No new TTS session, no re-acquired document, no reset
   * offset, no reset session id - which is the whole point of the contract.
   */
  public async resume(): Promise<void> {
    if (this.stateMachine.state !== 'paused') return;

    const sessionId = this.stateMachine.sessionId;
    const playback = this.activePlaybackSession;
    if (!playback) {
      throw new Error(
        `Cannot resume read '${sessionId}': its playback session is gone, so the cursor cannot be restored.`
      );
    }

    const result = await playback.resume();
    if (!this.isCurrentSession(sessionId)) return;

    this.playbackState = result.state;
    this.lastObservedPlaybackPositionMs = result.positionMs;

    if (!result.ok || result.state !== 'playing') {
      throw new Error(
        `Playback output did not resume (${result.reason ?? result.state}); ` +
          `reader state remains '${this.stateMachine.state}'.`
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

      if (this.activeStreamSession) {
        await this.activeStreamSession.cancel();
        this.activeStreamSession = null;
      }

      await this.releasePlayback();

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

  /** @returns whether audio output is genuinely suspended now. */
  public async suspendForAudioFocusAsync(): Promise<boolean> {
    if (this.stateMachine.state === 'paused') {
      return true;
    }
    if (this.stateMachine.state !== 'playing') {
      return false;
    }

    await this.pause();
    // Re-read after the await: pause() throws when the output refuses, and a completion can land
    // while the pause is in flight, so the state before the await proves nothing about it now.
    const suspended = this.readCurrentState() === 'paused';
    if (suspended) {
      this.pausedForAudioFocus = true;
    }
    return suspended;
  }

  /**
   * @returns whether audio output is genuinely playing again. Refuses to resume a pause it did not
   * cause, so releasing audio focus cannot override a pause the user asked for.
   */
  public async resumeForAudioFocusAsync(): Promise<boolean> {
    if (this.stateMachine.state === 'playing') {
      return true;
    }
    if (this.stateMachine.state !== 'paused' || !this.pausedForAudioFocus) {
      return false;
    }

    await this.resume();
    return this.readCurrentState() === 'playing';
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
      lastObservedPlaybackPositionMs: this.lastObservedPlaybackPositionMs,
      producesAudibleOutput: this.playbackSink.producesAudibleOutput,
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
