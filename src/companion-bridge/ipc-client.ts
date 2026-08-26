import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

export interface IpcResponse {
  id: string;
  result?: any;
  error?: string;
}

export class NativeCompanionClient {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private requestCounter = 0;

  constructor(private companionExecutablePath?: string) {
    if (!companionExecutablePath) {
      this.companionExecutablePath = path.resolve(
        __dirname,
        '../../native/ReadBridge.Companion/bin/Debug/net10.0-windows/ReadBridge.Companion.exe'
      );
    }
  }

  public async start(): Promise<void> {
    if (this.process) return;

    this.process = spawn(this.companionExecutablePath!, ['ipc'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });

    const rl = readline.createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const resp: IpcResponse = JSON.parse(line);
        if (resp.id && this.pendingRequests.has(resp.id)) {
          const { resolve, reject } = this.pendingRequests.get(resp.id)!;
          this.pendingRequests.delete(resp.id);
          if (resp.error) {
            reject(new Error(resp.error));
          } else {
            resolve(resp.result);
          }
        }
      } catch {
        // Non-JSON output ignored
      }
    });

    this.process.on('exit', () => {
      this.process = null;
      for (const { reject } of this.pendingRequests.values()) {
        reject(new Error('Companion process exited unexpectedly.'));
      }
      this.pendingRequests.clear();
    });
  }

  public async call(method: string, params: any = {}): Promise<any> {
    if (!this.process || !this.process.stdin) {
      await this.start();
    }

    const id = `req-${++this.requestCounter}`;
    const payload = JSON.stringify({ id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.process!.stdin!.write(payload);
    });
  }

  public async inspectForeground(): Promise<any> {
    return this.call('inspectForeground');
  }

  public async showHighlight(wordRects: Array<{ x: number; y: number; width: number; height: number }>): Promise<void> {
    return this.call('showHighlight', { wordRects });
  }

  public async clearHighlight(): Promise<void> {
    return this.call('clearHighlight');
  }

  public async ping(): Promise<string> {
    return this.call('ping');
  }

  public stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
