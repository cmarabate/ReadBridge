import { NativeCompanionClient } from '../src/companion-bridge/ipc-client';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<number | null> {
  const step = 100;
  for (let waited = step; waited <= timeoutMs; waited += step) {
    await sleep(step);
    if (!isAlive(pid)) return waited;
  }
  return null;
}

const exePath = path.resolve(
  __dirname,
  '../native/ReadBridge.Companion/bin/Debug/net10.0-windows/ReadBridge.Companion.exe'
);

// These are live process-lifecycle tests: they need the Windows companion binary, which lives
// under a gitignored bin/ directory. On a clean checkout, a non-Windows runner, or before
// `dotnet build`, skip rather than fail - `yarn test:ci` must stay green on a fresh clone.
const canRunCompanion = process.platform === 'win32' && fs.existsSync(exePath);
const describeCompanion = canRunCompanion ? describe : describe.skip;

if (!canRunCompanion) {
  console.warn(
    `[lifecycle] skipping companion lifecycle tests: platform=${process.platform}, ` +
      `exePresent=${fs.existsSync(exePath)} (run \`yarn verify:build\` on Windows to enable)`
  );
}

describeCompanion('Companion Lifecycle & IPC Protocol', () => {
  test('companion executable exists', () => {
    expect(fs.existsSync(exePath)).toBe(true);
  });

  test('companion launches, responds to ping over stdio JSON-RPC, and terminates cleanly', async () => {
    const client = new NativeCompanionClient(exePath);
    await client.start();
    expect(client.isRunning).toBe(true);
    expect(client.processId).toBeDefined();
    const childPid = client.processId!;

    const pong = await client.ping();
    expect(pong).toBe('pong');

    client.stop();
    expect(client.isRunning).toBe(false);

    // stop() only nulls the handle; assert the OS actually reclaimed the process.
    expect(await waitForExit(childPid, 5000)).not.toBeNull();
  });

  // Regression guard for the --parent-pid watchdog. The companion's stdin is deliberately held
  // open by THIS jest process while a separate throwaway process plays the role of the parent,
  // so stdin EOF cannot mask a broken watchdog: only the watchdog can end the companion here.
  test('companion self-terminates when its --parent-pid host dies, even with stdin still open', async () => {
    const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    host.unref();
    const hostPid = host.pid!;
    expect(hostPid).toBeDefined();

    const companion = spawn(exePath, ['ipc', '--parent-pid', String(hostPid)], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const companionPid = companion.pid!;

    try {
      // Confirm the companion is live and serving IPC before we touch the host.
      const pong = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('companion did not answer ping')), 15000);
        let buffer = '';
        companion.stdout!.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          if (buffer.includes('pong')) {
            clearTimeout(timer);
            resolve('pong');
          }
        });
        companion.stdin!.write(JSON.stringify({ id: 'ping-1', method: 'ping', params: {} }) + '\n');
      });
      expect(pong).toBe('pong');
      expect(isAlive(companionPid)).toBe(true);

      process.kill(hostPid);
      expect(await waitForExit(hostPid, 5000)).not.toBeNull();

      // stdin is still open on our side, so a surviving companion here is a genuine orphan.
      expect(companion.stdin!.destroyed).toBe(false);
      expect(await waitForExit(companionPid, 10000)).not.toBeNull();
    } finally {
      for (const pid of [companionPid, hostPid]) {
        if (isAlive(pid)) {
          spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
        }
      }
      companion.stdin!.end();
    }
  }, 45000);
});
