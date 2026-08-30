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

  public get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  public get processId(): number | undefined {
    return this.process?.pid;
  }

  public async start(): Promise<void> {
    if (this.process) return;

    const args = ['ipc', '--parent-pid', String(process.pid)];

    this.process = spawn(this.companionExecutablePath!, args, {
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

    // A spawn failure (e.g. the companion was never built) emits 'error', not 'exit'. Without a
    // listener that is an unhandled EventEmitter error, which takes down the host process; and
    // any in-flight request would otherwise never settle.
    this.process.on('error', (err) => {
      this.process = null;
      this.rejectPending(new Error(`Companion process failed to start: ${err.message}`));
    });

    // The 'error' handler above covers spawn failure only - it does NOT cover stream errors on
    // the stdio pipes. If the companion dies between our last liveness check and a write, the
    // write raises EPIPE on stdin asynchronously; with no listener that is an unhandled
    // EventEmitter error, which takes down the host - the exact failure the spawn handler exists
    // to prevent, one layer down.
    const onStreamError = (err: Error): void => {
      this.rejectPending(new Error(`Companion IPC stream failed: ${err.message}`));
    };
    this.process.stdin?.on('error', onStreamError);
    this.process.stdout?.on('error', onStreamError);

    this.process.on('exit', () => {
      this.process = null;
      this.rejectPending(new Error('Companion process exited unexpectedly.'));
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

  private rejectPending(err: Error): void {
    for (const { reject } of this.pendingRequests.values()) {
      reject(err);
    }
    this.pendingRequests.clear();
  }

  public stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
