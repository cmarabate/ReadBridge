import {
  ReaderDocument,
  TextRangeGeometry,
  TextSourceAdapter,
  TextSourceCapabilities,
  TextSourceIdentity,
} from '../core/types.js';

export class ReaderFallbackAdapter implements TextSourceAdapter {
  public readonly id = 'reader-fallback';
  public readonly name = 'Owned Reader Surface Fallback Adapter';

  private rawText: string;
  private documentTitle: string;

  constructor(rawText: string = '', documentTitle: string = 'Captured Document') {
    this.rawText = rawText;
    this.documentTitle = documentTitle;
  }

  public async identifySource(): Promise<TextSourceIdentity | null> {
    return {
      adapterId: this.id,
      title: this.documentTitle,
      appType: 'ReadBridge Owned Reader Surface',
    };
  }

  public async getCapabilities(): Promise<TextSourceCapabilities> {
    return {
      level: 'READER_FALLBACK',
      supportsSelection: true,
      supportsDocumentText: true,
      supportsVisibleText: true,
      supportsWordGeometry: false,
      supportsSentenceGeometry: false,
      supportsClickToSeek: true,
      supportsWindowTracking: false,
    };
  }

  public async getSelection(): Promise<ReaderDocument | null> {
    return this.createDocumentFromText(this.rawText || 'Text captured without source geometry.');
  }

  public async getVisibleText(): Promise<ReaderDocument | null> {
    return this.getSelection();
  }

  public async getDocumentText(): Promise<ReaderDocument | null> {
    return this.getSelection();
  }

  public async resolveRangeGeometry(_charStart: number, _charLength: number): Promise<TextRangeGeometry | null> {
    // Fallback level delegates highlighting to the owned Reader window UI
    return null;
  }

  public observeInvalidation(_callback: (reason: string) => void): () => void {
    return () => {};
  }

  private createDocumentFromText(fullText: string): ReaderDocument {
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
      id: `fallback-doc-${Date.now()}`,
      title: this.documentTitle,
      sourceIdentity: {
        adapterId: this.id,
        title: this.documentTitle,
        appType: 'ReadBridge Reader Window',
      },
      fullText,
      sentences,
    };
  }
}
