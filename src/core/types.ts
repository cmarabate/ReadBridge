export type ReaderLifecycleState =
  | 'idle'
  | 'acquiring'
  | 'preparing'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'stopping'
  | 'error';

export type CapabilityLevel = 'SOURCE_NATIVE' | 'UI_AUTOMATION' | 'READER_FALLBACK';

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextRangeGeometry {
  rects: ScreenRect[];
  isClipped: boolean;
  text?: string;
  viewportOffset?: { x: number; y: number };
}

export interface TextSourceCapabilities {
  level: CapabilityLevel;
  supportsSelection: boolean;
  supportsDocumentText: boolean;
  supportsVisibleText: boolean;
  supportsWordGeometry: boolean;
  supportsSentenceGeometry: boolean;
  supportsClickToSeek: boolean;
  supportsWindowTracking: boolean;
}

export interface TextSourceIdentity {
  adapterId: string;
  processId?: number;
  windowHandle?: string;
  url?: string;
  title: string;
  appType: string;
}

export interface ReaderSentence {
  index: number;
  text: string;
  charStart: number;
  charLength: number;
}

export interface ReaderDocument {
  id: string;
  title: string;
  sourceIdentity: TextSourceIdentity;
  fullText: string;
  sentences: ReaderSentence[];
  initialSelectionOffset?: number;
}

export interface TextSourceAdapter {
  readonly id: string;
  readonly name: string;
  identifySource(): Promise<TextSourceIdentity | null>;
  getCapabilities(): Promise<TextSourceCapabilities>;
  getSelection(): Promise<ReaderDocument | null>;
  getVisibleText(): Promise<ReaderDocument | null>;
  getDocumentText(): Promise<ReaderDocument | null>;
  resolveRangeGeometry(charStart: number, charLength: number): Promise<TextRangeGeometry | null>;
  observeInvalidation(callback: (reason: string) => void): () => void;
}

export interface PlaybackStateSnapshot {
  sessionId: string;
  state: ReaderLifecycleState;
  sourceIdentity: TextSourceIdentity | null;
  documentTitle: string | null;
  totalCharacters: number;
  canonicalTextOffset: number;
  currentSentenceIndex: number;
  currentWord: string | null;
  activeGeometry: TextRangeGeometry | null;
  followMode: 'SOURCE_OVERLAY' | 'READER_SURFACE';
  error: string | null;
}
