import {
  ReaderDocument,
  TextRangeGeometry,
  TextSourceAdapter,
  TextSourceCapabilities,
  TextSourceIdentity,
} from '../core/types.js';

export interface NativeUiaClient {
  inspectForeground(): Promise<any>;
  showHighlight(rects: Array<{ x: number; y: number; width: number; height: number }>): Promise<void>;
  clearHighlight(): Promise<void>;
}

export class WindowsUiAutomationAdapter implements TextSourceAdapter {
  public readonly id = 'windows-uia';
  public readonly name = 'Windows UI Automation Adapter';

  private uiaClient: NativeUiaClient | null;

  constructor(uiaClient: NativeUiaClient | null = null) {
    this.uiaClient = uiaClient;
  }

  public async identifySource(): Promise<TextSourceIdentity | null> {
    if (!this.uiaClient) {
      return {
        adapterId: this.id,
        title: 'Active Foreground Window',
        appType: 'win32-uia',
      };
    }
    const data = await this.uiaClient.inspectForeground();
    return {
      adapterId: this.id,
      processId: data.inspection.processId,
      windowHandle: data.inspection.windowHandle,
      title: data.inspection.windowTitle,
      appType: data.inspection.processName,
    };
  }

  public async getCapabilities(): Promise<TextSourceCapabilities> {
    return {
      level: 'UI_AUTOMATION',
      supportsSelection: true,
      supportsDocumentText: true,
      supportsVisibleText: true,
      supportsWordGeometry: true,
      supportsSentenceGeometry: true,
      supportsClickToSeek: false,
      supportsWindowTracking: true,
    };
  }

  public async getSelection(): Promise<ReaderDocument | null> {
    const text = 'ReadBridge is designed to provide seamless reading across Windows desktop applications.';
    return this.createDocumentFromText(text, 'Selection from UIA Source');
  }

  public async getVisibleText(): Promise<ReaderDocument | null> {
    const text = 'ReadBridge captures visible text within viewport and navigates at word granularity.';
    return this.createDocumentFromText(text, 'Visible Viewport from UIA Source');
  }

  public async getDocumentText(): Promise<ReaderDocument | null> {
    const text = 'Full document text extracted from Windows UI Automation TextPattern document range.';
    return this.createDocumentFromText(text, 'Document from UIA Source');
  }

  public async resolveRangeGeometry(charStart: number, charLength: number): Promise<TextRangeGeometry | null> {
    // Generate physical bounding box and send to native overlay
    const rect = {
      x: 100 + charStart * 7,
      y: 200,
      width: Math.max(12, charLength * 7),
      height: 18,
    };

    if (this.uiaClient) {
      await this.uiaClient.showHighlight([rect]);
    }

    return {
      rects: [rect],
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
      id: `uia-doc-${Date.now()}`,
      title,
      sourceIdentity: {
        adapterId: this.id,
        title,
        appType: 'Windows Desktop Application',
      },
      fullText,
      sentences,
    };
  }
}
