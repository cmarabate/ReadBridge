import {
  ReaderDocument,
  TextRangeGeometry,
  TextSourceAdapter,
  TextSourceCapabilities,
  TextSourceIdentity,
} from '../core/types.js';

export interface BrowserDomBridgeMessage {
  type: 'DOM_EXTRACT' | 'DOM_SELECTION' | 'RANGE_GEOMETRY' | 'SEEK_REQUEST';
  url: string;
  title: string;
  fullText?: string;
  selectionText?: string;
  charStart?: number;
  charLength?: number;
  geometry?: TextRangeGeometry;
}

export class BrowserDomAdapter implements TextSourceAdapter {
  public readonly id = 'browser-dom';
  public readonly name = 'Browser DOM Extension Adapter';

  private url: string;
  private title: string;

  constructor(url: string = 'https://example.com/article', title: string = 'Article in Browser') {
    this.url = url;
    this.title = title;
  }

  public async identifySource(): Promise<TextSourceIdentity | null> {
    return {
      adapterId: this.id,
      url: this.url,
      title: this.title,
      appType: 'Browser DOM (Extension)',
    };
  }

  public async getCapabilities(): Promise<TextSourceCapabilities> {
    return {
      level: 'SOURCE_NATIVE',
      supportsSelection: true,
      supportsDocumentText: true,
      supportsVisibleText: true,
      supportsWordGeometry: true,
      supportsSentenceGeometry: true,
      supportsClickToSeek: true,
      supportsWindowTracking: true,
    };
  }

  public async getSelection(): Promise<ReaderDocument | null> {
    return this.createDocumentFromText(
      'Selected paragraph in web browser via DOM Range API.',
      'Web Selection'
    );
  }

  public async getVisibleText(): Promise<ReaderDocument | null> {
    return this.createDocumentFromText(
      'Visible content extracted via DOM TreeWalker and IntersectionObserver.',
      'Visible Article'
    );
  }

  public async getDocumentText(): Promise<ReaderDocument | null> {
    return this.createDocumentFromText(
      'ReadBridge connects to web browsers via high-fidelity DOM Range inspection.',
      this.title
    );
  }

  public async resolveRangeGeometry(charStart: number, charLength: number): Promise<TextRangeGeometry | null> {
    return {
      rects: [
        {
          x: 250 + charStart * 8,
          y: 320,
          width: Math.max(16, charLength * 8),
          height: 22,
        },
      ],
      isClipped: false,
    };
  }

  public observeInvalidation(_callback: (reason: string) => void): () => void {
    return () => {};
  }

  private createDocumentFromText(fullText: string, title: string): ReaderDocument {
    const sentences = fullText
      .split(/(?<=[.?!])\s+/)
      .filter(Boolean)
      .map((text, index) => {
        const charStart = fullText.indexOf(text);
        return {
          index,
          text,
          charStart,
          charLength: text.length,
        };
      });

    return {
      id: `dom-doc-${Date.now()}`,
      title,
      sourceIdentity: {
        adapterId: this.id,
        url: this.url,
        title,
        appType: 'Browser DOM',
      },
      fullText,
      sentences,
    };
  }
}
