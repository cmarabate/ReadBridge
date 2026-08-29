import { NativeCompanionClient } from '../src/companion-bridge/ipc-client';
import * as path from 'path';
import * as fs from 'fs';

describe('Companion Lifecycle & IPC Protocol', () => {
  const exePath = path.resolve(
    __dirname,
    '../native/ReadBridge.Companion/bin/Debug/net10.0-windows/ReadBridge.Companion.exe'
  );

  test('companion executable exists', () => {
    expect(fs.existsSync(exePath)).toBe(true);
  });

  test('companion launches, responds to ping over stdio JSON-RPC, and terminates cleanly', async () => {
    const client = new NativeCompanionClient(exePath);
    await client.start();
    expect(client.isRunning).toBe(true);
    expect(client.processId).toBeDefined();

    const pong = await client.ping();
    expect(pong).toBe('pong');

    client.stop();
    expect(client.isRunning).toBe(false);
  });
});
