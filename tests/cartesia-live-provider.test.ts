import { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  CartesiaLiveStreamSession,
  CartesiaLiveTtsProvider,
} from '../src/core/tts/providers/cartesia-live-provider';
import { TtsAudioChunk, TtsWordAlignment } from '../src/core/tts/provider-interface';
import { settleAsyncWork } from './helpers/paced-tts';

const SAMPLE_RATE = 24000;
const TEXT = 'ReadBridge speaks with Cartesia';

/**
 * A local stand-in for Cartesia that speaks the documented wire shape.
 *
 * Deliberately a REAL WebSocket server driven by the real `ws` client, not a stubbed
 * socket: the property under test is that a pushing server cannot outrun a suspended
 * reader, and that only holds if the socket is genuinely being read.
 */
class FakeCartesiaServer {
  private readonly server: WebSocketServer;
  private socket: WebSocket | null = null;

  /** Every frame the client sent, parsed. */
  public readonly received: Array<Record<string, any>> = [];
  /** The HTTP request that opened the connection, so auth placement can be asserted. */
  public requestUrl = '';
  public requestHeaders: Record<string, any> = {};

  private constructor(server: WebSocketServer) {
    this.server = server;
    server.on('connection', (socket, request) => {
      this.socket = socket;
      this.requestUrl = request.url ?? '';
      this.requestHeaders = request.headers as Record<string, any>;
      socket.on('message', (data) => {
        try {
          this.received.push(JSON.parse(data.toString()));
        } catch {
          // A frame this fake cannot parse is not the thing under test.
        }
      });
    });
  }

  public static async start(): Promise<FakeCartesiaServer> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    return new FakeCartesiaServer(server);
  }

  public get url(): string {
    const address = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}`;
  }

  public async waitForConnection(): Promise<void> {
    for (let i = 0; i < 200 && !this.socket; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!this.socket) throw new Error('the client never connected');
  }

  public send(payload: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(payload));
  }

  /** One `chunk` carrying `durationMs` of silence, base64 as documented. */
  public sendChunk(contextId: string, durationMs: number): void {
    const bytes = Buffer.alloc(Math.round((SAMPLE_RATE * durationMs) / 1000) * 2);
    this.send({ type: 'chunk', context_id: contextId, data: bytes.toString('base64'), done: false });
  }

  public sendTimestamps(contextId: string, words: string[], startSeconds: number[], endSeconds: number[]): void {
    this.send({
      type: 'timestamps',
      context_id: contextId,
      word_timestamps: { words, start: startSeconds, end: endSeconds },
    });
  }

  public sendDone(contextId: string): void {
    this.send({ type: 'done', context_id: contextId, done: true });
  }

  public async close(): Promise<void> {
    this.socket?.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

interface Harness {
  server: FakeCartesiaServer;
  session: CartesiaLiveStreamSession;
  chunks: TtsAudioChunk[];
  alignments: TtsWordAlignment[];
  contextId: string;
  production: Promise<void>;
}

async function start(apiKey = 'test-key-not-a-real-secret'): Promise<Harness> {
  const server = await FakeCartesiaServer.start();
  const provider = new CartesiaLiveTtsProvider({ apiKey, baseUrl: server.url, sampleRate: SAMPLE_RATE });
  const session = (await provider.createStreamSession({ voiceId: 'voice-1' })) as CartesiaLiveStreamSession;

  const chunks: TtsAudioChunk[] = [];
  const alignments: TtsWordAlignment[] = [];
  session.onAudioChunk((c) => chunks.push(c));
  session.onWordAlignment((a) => alignments.push(a));

  // Unawaited: a suspended session blocks its producer, and awaiting here would mean the
  // test could never observe the block.
  const production = (async () => {
    await session.sendTextDelta(TEXT, false);
  })();
  production.catch(() => undefined);

  await server.waitForConnection();
  await settleAsyncWork(4);

  return { server, session, chunks, alignments, contextId: session.sessionId, production };
}

describe('Cartesia live client: protocol', () => {
  test('the key travels in a header and never in the URL; only the version is a query parameter', async () => {
    const h = await start('super-secret-key');
    try {
      expect(h.server.requestUrl).toContain('cartesia_version=');
      expect(h.server.requestUrl).not.toContain('super-secret-key');
      expect(h.server.requestUrl).not.toContain('api_key');
      expect(h.server.requestUrl).not.toContain('access_token');
      expect(h.server.requestHeaders['x-api-key']).toBe('super-secret-key');
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('a missing key is refused at construction rather than sent as an empty credential', () => {
    expect(() => new CartesiaLiveTtsProvider({ apiKey: '' })).toThrow(/requires an API key/i);
    expect(() => new CartesiaLiveTtsProvider({ apiKey: '   ' })).toThrow(/never be hardcoded/i);
  });

  test('the request carries the documented fields, including the exact context id', async () => {
    const h = await start();
    try {
      const request = h.server.received[0];
      expect(request.model_id).toBe('sonic-3.6');
      expect(request.transcript).toBe(TEXT);
      expect(request.voice).toEqual({ mode: 'id', id: 'voice-1' });
      expect(request.output_format).toEqual({ container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE });
      expect(request.context_id).toBe(h.contextId);
      expect(request.continue).toBe(true);
      expect(request.add_timestamps).toBe(true);
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('base64 chunks become PCM of the right length, and `done` ends the stream', async () => {
    const h = await start();
    try {
      h.server.sendChunk(h.contextId, 300);
      await settleAsyncWork(6);

      expect(h.chunks).toHaveLength(1);
      expect(h.chunks[0].audioData.length).toBe((SAMPLE_RATE * 300) / 1000 * 2);
      expect(h.chunks[0].durationMs).toBeCloseTo(300, 0);
      expect(h.chunks[0].isFinal).toBe(false);
      expect(h.chunks[0].format).toEqual({ sampleRate: SAMPLE_RATE, channels: 1, bitDepth: 16 });

      h.server.sendDone(h.contextId);
      await settleAsyncWork(6);

      expect(h.chunks[h.chunks.length - 1].isFinal).toBe(true);
      expect(h.chunks[h.chunks.length - 1].audioData.length).toBe(0);
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('word timestamps in seconds become alignments with character offsets into the sent text', async () => {
    const h = await start();
    try {
      h.server.sendTimestamps(h.contextId, ['ReadBridge', 'speaks'], [0, 0.45], [0.42, 0.91]);
      await settleAsyncWork(6);

      expect(h.alignments).toHaveLength(2);
      expect(h.alignments[0]).toEqual({
        word: 'ReadBridge',
        charStart: 0,
        charLength: 'ReadBridge'.length,
        audioStartMs: 0,
        audioEndMs: 420,
      });
      // Cartesia gives no character offsets, so they are mapped back onto the transcript.
      expect(h.alignments[1].charStart).toBe(TEXT.indexOf('speaks'));
      expect(h.alignments[1].audioStartMs).toBe(450);
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('a message for a different context is ignored', async () => {
    const h = await start();
    try {
      h.server.sendChunk('some-other-context', 200);
      h.server.sendTimestamps('some-other-context', ['ghost'], [0], [1]);
      await settleAsyncWork(8);

      expect(h.chunks).toHaveLength(0);
      expect(h.alignments).toHaveLength(0);
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('unparseable input is never interpreted as audio', async () => {
    const h = await start();
    try {
      h.server.send({ type: 'chunk', context_id: h.contextId, data: 12345 });
      await settleAsyncWork(6);
      expect(h.chunks).toHaveLength(0);
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });
});

describe('Cartesia live client: the RB-AF1 flow-control contract', () => {
  test('suspendOutput reaches quiescence even while the server keeps pushing', async () => {
    const h = await start();
    try {
      h.server.sendChunk(h.contextId, 300);
      await settleAsyncWork(6);
      expect(h.chunks).toHaveLength(1);

      const suspend = await h.session.suspendOutput();
      expect(suspend).toMatchObject({ ok: true, outcome: 'suspended', state: 'suspended' });

      const deliveredAtSuspend = h.chunks.length;
      const alignmentsAtSuspend = h.alignments.length;

      // Cartesia pushes: the server keeps sending regardless. Nothing may be DELIVERED.
      for (let i = 0; i < 20; i++) {
        h.server.sendChunk(h.contextId, 300);
        h.server.sendTimestamps(h.contextId, [`w${i}`], [i], [i + 1]);
      }
      await settleAsyncWork(30);

      expect(h.chunks).toHaveLength(deliveredAtSuspend);
      expect(h.alignments).toHaveLength(alignmentsAtSuspend);

      // But the socket WAS read - the frames are buffered, not stalled on the wire.
      // Refusing to read would apply TCP backpressure and eventually kill the connection.
      expect(h.session.bufferedDeliveryCount).toBeGreaterThan(0);
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('resumeOutput delivers the buffered queue in order, with no duplicate and no skip', async () => {
    const h = await start();
    try {
      await h.session.suspendOutput();

      const expected = 12;
      for (let i = 0; i < expected; i++) {
        h.server.sendTimestamps(h.contextId, [`word${i}`], [i], [i + 1]);
      }
      await settleAsyncWork(20);
      expect(h.alignments).toHaveLength(0);

      await h.session.resumeOutput();
      await settleAsyncWork(30);

      expect(h.alignments).toHaveLength(expected);
      expect(h.alignments.map((a) => a.audioStartMs)).toEqual(
        Array.from({ length: expected }, (_, i) => i * 1000)
      );
      expect(new Set(h.alignments.map((a) => a.word)).size).toBe(expected);
      expect(h.session.bufferedDeliveryCount).toBe(0);
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('a suspended session stops FEEDING the server, which is what bounds generation', async () => {
    const h = await start();
    try {
      const framesBefore = h.server.received.length;
      await h.session.suspendOutput();

      // The producer is parked before it can send, so the server is never asked to
      // generate audio nobody is going to accept.
      const blocked = h.session.sendTextDelta(' and keeps going', true);
      await settleAsyncWork(20);
      expect(h.server.received).toHaveLength(framesBefore);

      await h.session.resumeOutput();
      await blocked;
      await settleAsyncWork(6);

      expect(h.server.received.length).toBeGreaterThan(framesBefore);
      expect(h.server.received[h.server.received.length - 1].transcript).toBe(' and keeps going');
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('repeated suspend and resume are deterministic and named', async () => {
    const h = await start();
    try {
      expect(await h.session.suspendOutput()).toMatchObject({ outcome: 'suspended' });
      expect(await h.session.suspendOutput()).toMatchObject({ outcome: 'alreadySuspended' });
      expect(await h.session.resumeOutput()).toMatchObject({ outcome: 'resumed' });
      expect(await h.session.resumeOutput()).toMatchObject({ outcome: 'alreadyRunning' });
      expect(h.session.outputFlowState).toBe('running');
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('cancel tells the server to stop generating, wakes a blocked producer, and is terminal', async () => {
    const h = await start();
    try {
      await h.session.suspendOutput();

      // Blocked on the gate: awaiting this would hang forever if cancel did not wake it.
      const blocked = h.session.sendTextDelta(' more text', true);
      await settleAsyncWork(6);

      await h.session.cancel();
      await expect(blocked).resolves.toBeUndefined();

      expect(h.session.outputFlowState).toBe('terminal');
      expect(await h.session.resumeOutput()).toMatchObject({ ok: true, outcome: 'terminal' });

      // The far side is told to stop, so a cancelled read does not keep costing money.
      await settleAsyncWork(6);
      const cancelFrame = h.server.received.find((m) => m.cancel === true);
      expect(cancelFrame).toBeDefined();
      expect(cancelFrame!.context_id).toBe(h.contextId);
    } finally {
      await h.server.close();
    }
  });

  test('the session id is unchanged across suspend and resume', async () => {
    const h = await start();
    try {
      const id = h.session.sessionId;
      await h.session.suspendOutput();
      expect(h.session.sessionId).toBe(id);
      await h.session.resumeOutput();
      expect(h.session.sessionId).toBe(id);
    } finally {
      await h.session.cancel();
      await h.server.close();
    }
  });

  test('a socket that closes before `done` ends the read rather than hanging', async () => {
    const h = await start();
    try {
      h.server.sendChunk(h.contextId, 200);
      await settleAsyncWork(6);

      await h.server.close();
      await settleAsyncWork(20);

      expect(h.chunks[h.chunks.length - 1].isFinal).toBe(true);
    } finally {
      await h.session.cancel();
    }
  });
});
