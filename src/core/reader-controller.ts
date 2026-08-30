import { ReaderStateMachine } from './state-machine.js';
import { ITtsProvider, ITtsStreamSession, TtsWordAlignment } from './tts/provider-interface.js';
import {
  PlaybackStateSnapshot,
  ReaderDocument,
  ReaderLifecycleState,
  TextRangeGeometry,
  TextSourceAdapter,
  TextSourceCapabilities,
} from './types.js';

export class ReaderController {
  private readonly stateMachine = new ReaderStateMachine();
  private readonly ttsProvider: ITtsProvider;
  private currentAdapter: TextSourceAdapter | null = null;
  private currentCapabilities: TextSourceCapabilities | null = null;
  private currentDocument: ReaderDocument | null = null;
  private activeStreamSession: ITtsStreamSession | null = null;

  private canonicalTextOffset: number = 0;
  private currentSentenceIndex: number = 0;
  private currentWord: string | null = null;
  private activeGeometry: TextRangeGeometry | null = null;
  private followMode: 'SOURCE_OVERLAY' | 'READER_SURFACE' = 'SOURCE_OVERLAY';

  private stateChangeListeners: Array<(snapshot: PlaybackStateSnapshot) => void> = [];
  private highlightListeners: Array<(geometry: TextRangeGeometry | null) => void> = [];

  constructor(ttsProvider: ITtsProvider) {
    this.ttsProvider = ttsProvider;
  }

  public get state(): ReaderLifecycleState {
    return this.stateMachine.state;
  }

  public get sessionId(): string {
    return this.stateMachine.sessionId;
  }

  public async startRead(adapter: TextSourceAdapter): Promise<void> {
    const sessionId = `read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.stateMachine.startSession(sessionId);
    this.currentAdapter = adapter;
    this.canonicalTextOffset = 0;
    this.currentSentenceIndex = 0;
    this.currentWord = null;
    this.activeGeometry = null;
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
        if (this.stateMachine.sessionId !== sessionId) return;
        await this.handleWordAlignment(alignment, sessionId);
      });

      ttsSession.onAudioChunk((chunk) => {
        if (this.stateMachine.sessionId !== sessionId) return;
        if (chunk.isFinal) {
          this.handlePlaybackComplete(sessionId);
        }
      });

      // 3. Start Streaming Text & Transition to Playing
      this.stateMachine.transitionTo('playing', sessionId);
      this.emitState();

      await ttsSession.sendTextDelta(doc.fullText, true);
      await ttsSession.completeInput();
    } catch (err: any) {
      this.stateMachine.transitionTo('error', sessionId, err.message);
      this.emitState();
      throw err;
    }
  }

  private async handleWordAlignment(alignment: TtsWordAlignment, sessionId: string): Promise<void> {
    if (this.stateMachine.sessionId !== sessionId) return;

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
        this.activeGeometry = geom;
        this.emitHighlight(geom);
      } catch {
        // Degrade to Reader surface if geometry resolution fails
        this.followMode = 'READER_SURFACE';
        this.activeGeometry = null;
        this.emitHighlight(null);
      }
    }

    this.emitState();
  }

  private handlePlaybackComplete(sessionId: string): void {
    if (this.stateMachine.sessionId !== sessionId) return;
    if (this.stateMachine.state === 'playing') {
      this.stateMachine.transitionTo('idle', sessionId);
      this.activeGeometry = null;
      this.emitHighlight(null);
      this.emitState();
    }
  }

  public async pause(): Promise<void> {
    if (this.stateMachine.state === 'playing') {
      this.stateMachine.transitionTo('paused', this.stateMachine.sessionId);
      this.emitState();
    }
  }

  public async resume(): Promise<void> {
    if (this.stateMachine.state === 'paused') {
      this.stateMachine.transitionTo('playing', this.stateMachine.sessionId);
      this.emitState();
    }
  }

  public async stop(): Promise<void> {
    if (this.stateMachine.state !== 'idle') {
      const sessionId = this.stateMachine.sessionId;
      if (this.activeStreamSession) {
        await this.activeStreamSession.cancel();
        this.activeStreamSession = null;
      }

      this.stateMachine.transitionTo('stopping', sessionId);
      this.activeGeometry = null;
      this.emitHighlight(null);
      this.emitState();

      this.stateMachine.transitionTo('idle', sessionId);
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
