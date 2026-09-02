import { TtsOutputGate } from '../src/core/tts/output-gate';
import { CartesiaTtsProvider } from '../src/core/tts/providers/cartesia-provider';
import { ElevenLabsTtsProvider } from '../src/core/tts/providers/elevenlabs-provider';
import { OpenAiTtsProvider } from '../src/core/tts/providers/openai-provider';
import { ITtsProvider, TtsAudioChunk, TtsWordAlignment } from '../src/core/tts/provider-interface';
import { PacedTtsProvider, PacedTtsStreamSession, settleAsyncWork } from './helpers/paced-tts';

const TEXT = 'ReadBridge suspends its own output while playback is paused';

function startPacedSession(options: { chunkCount: number; chunkMs?: number; initialGrants?: number }) {
  const provider = new PacedTtsProvider({
    chunkCount: options.chunkCount,
    chunkMs: options.chunkMs ?? 500,
    initialGrants: options.initialGrants,
  });
  const chunks: TtsAudioChunk[] = [];
  const alignments: TtsWordAlignment[] = [];

  const started = provider.createStreamSession({ voiceId: 'test' }).then(async (session) => {
    session.onAudioChunk((chunk) => chunks.push(chunk));
    session.onWordAlignment((alignment) => alignments.push(alignment));
    // Production runs unawaited on purpose: a suspended producer blocks, and awaiting it here
    // would mean the test could never observe the block.
    const production = (async () => {
      await session.sendTextDelta(TEXT, true);
      await session.completeInput();
    })();
    production.catch(() => undefined);
    return { session: session as PacedTtsStreamSession, production };
  });

  return { provider, chunks, alignments, started };
}

describe('TTS output flow control', () => {
  test('1 & 2. a running stream emits ordered audio chunks and ordered alignments', async () => {
    const { session } = await (await startPacedSession({ chunkCount: 4 })).started;
    await settleAsyncWork();

    expect(session.deliveredChunkIndices).toEqual([0, 1, 2, 3]);
    expect(session.deliveredAlignmentIndices).toEqual([0, 1, 2, 3]);
    expect(session.outputFlowState).toBe('running');
  });

  test('3, 4 & 5. suspendOutput reaches quiescence: no audio and no alignment follows it', async () => {
    const harness = startPacedSession({ chunkCount: 200 });
    const { session } = await harness.started;
    await settleAsyncWork(2);

    const suspend = await session.suspendOutput();
    expect(suspend).toMatchObject({ ok: true, outcome: 'suspended', state: 'suspended' });

    const chunksAtQuiescence = harness.chunks.length;
    const alignmentsAtQuiescence = harness.alignments.length;
    const deliveredAtQuiescence = suspend.deliveredCount;
    expect(chunksAtQuiescence).toBeGreaterThan(0);

    // Give the producer every chance to run. It delivered nothing, because it is parked at the
    // gate rather than merely idle.
    await settleAsyncWork(40);

    expect(harness.chunks).toHaveLength(chunksAtQuiescence);
    expect(harness.alignments).toHaveLength(alignmentsAtQuiescence);
    expect(session.deliveredCount).toBe(deliveredAtQuiescence);
  });

  test('6 & 11. repeated suspend and repeated resume are deterministic and named', async () => {
    const { session } = await (await startPacedSession({ chunkCount: 200 })).started;
    await settleAsyncWork(2);

    expect(await session.suspendOutput()).toMatchObject({ ok: true, outcome: 'suspended' });
    expect(await session.suspendOutput()).toMatchObject({ ok: true, outcome: 'alreadySuspended' });
    expect(await session.suspendOutput()).toMatchObject({ ok: true, outcome: 'alreadySuspended' });
    expect(session.outputFlowState).toBe('suspended');

    expect(await session.resumeOutput()).toMatchObject({ ok: true, outcome: 'resumed' });
    expect(await session.resumeOutput()).toMatchObject({ ok: true, outcome: 'alreadyRunning' });
    expect(session.outputFlowState).toBe('running');

    await session.cancel();
  });

  test('7, 8, 9 & 10. resume continues at the exact next item - no duplicate, no skip', async () => {
    // Five granted items is alignment 0, chunk 0, alignment 1, chunk 1, alignment 2 - so the
    // suspension lands BETWEEN an alignment and its own audio, the hardest boundary to resume at.
    const harness = startPacedSession({ chunkCount: 12, initialGrants: 5 });
    const { session } = await harness.started;
    await settleAsyncWork(10);

    await session.suspendOutput();
    const chunksBefore = [...session.deliveredChunkIndices];
    const alignmentsBefore = [...session.deliveredAlignmentIndices];
    expect(chunksBefore).toEqual([0, 1]);
    expect(alignmentsBefore).toEqual([0, 1, 2]);

    session.grantProduction(1000);
    await settleAsyncWork(20);
    expect(session.deliveredChunkIndices).toEqual(chunksBefore);
    expect(session.deliveredAlignmentIndices).toEqual(alignmentsBefore);

    await session.resumeOutput();
    await settleAsyncWork(60);

    // Exactly the full ordered sequence, once each.
    expect(session.deliveredChunkIndices).toEqual([...Array(12).keys()]);
    expect(session.deliveredAlignmentIndices).toEqual([...Array(12).keys()]);
    expect(session.deliveredChunkIndices.slice(0, chunksBefore.length)).toEqual(chunksBefore);
    expect(session.deliveredAlignmentIndices.slice(0, alignmentsBefore.length)).toEqual(alignmentsBefore);
    expect(new Set(session.deliveredChunkIndices).size).toBe(12);
  });

  test('12 & 13. cancel while suspended unblocks the producer and the session cannot be revived', async () => {
    const harness = startPacedSession({ chunkCount: 500 });
    const { session, production } = await harness.started;
    await settleAsyncWork(2);

    await session.suspendOutput();
    const delivered = session.deliveredCount;

    // The producer is blocked on the gate. Cancelling must wake it, not strand it: awaiting the
    // production task here would hang forever if it did not.
    await session.cancel();
    await expect(production).resolves.toBeUndefined();

    expect(session.outputFlowState).toBe('terminal');
    expect(await session.resumeOutput()).toMatchObject({ ok: true, outcome: 'terminal', state: 'terminal' });
    expect(await session.suspendOutput()).toMatchObject({ ok: true, outcome: 'terminal' });

    await settleAsyncWork(20);
    expect(session.deliveredCount).toBe(delivered);
    expect(session.outputFlowState).toBe('terminal');
  });

  test('a suspendOutput awaiting quiescence is released by cancellation rather than hanging', async () => {
    const gate = new TtsOutputGate();
    // Claim a delivery slot and never end it, so quiescence can only come from termination.
    expect(await gate.beginDelivery()).toBe(true);
    expect(gate.isQuiescent).toBe(false);

    const suspending = gate.suspend();
    gate.terminate();

    await expect(suspending).resolves.toMatchObject({ state: 'terminal' });
  });

  test('14. the session id is unchanged across suspend and resume', async () => {
    const { session } = await (await startPacedSession({ chunkCount: 200 })).started;
    await settleAsyncWork(2);

    const id = session.sessionId;
    await session.suspendOutput();
    expect(session.sessionId).toBe(id);
    await session.resumeOutput();
    expect(session.sessionId).toBe(id);
    await session.cancel();
  });

  test('a producer that is granted output it cannot deliver stays blocked at the gate', async () => {
    // initialGrants is 3: one alignment, one chunk, one more alignment.
    const harness = startPacedSession({ chunkCount: 100, initialGrants: 3 });
    const { session } = await harness.started;
    await settleAsyncWork(6);

    expect(session.deliveredCount).toBe(3);

    await session.suspendOutput();
    const delivered = session.deliveredCount;

    // Grant far more production than the gate will admit.
    session.grantProduction(400);
    await settleAsyncWork(40);

    expect(session.deliveredCount).toBe(delivered);
    expect(harness.chunks).toHaveLength(1);

    await session.resumeOutput();
    await settleAsyncWork(60);
    expect(session.deliveredCount).toBeGreaterThan(delivered);
    await session.cancel();
  });
});

// ---------------------------------------------------------------------------------------
// The shipped simulators are the providers ReadBridge actually ships today. They must honour the
// same generic contract - the seam is provider-neutral, not test-only.
// ---------------------------------------------------------------------------------------

describe('Shipped TTS simulators honour the flow-control contract', () => {
  const cases: Array<[string, () => ITtsProvider, boolean]> = [
    ['Cartesia simulator', () => new CartesiaTtsProvider(), true],
    ['ElevenLabs simulator', () => new ElevenLabsTtsProvider(), true],
    ['OpenAI simulator', () => new OpenAiTtsProvider(), false],
  ];

  test.each(cases)('%s starts running and reports its flow state', async (_name, make) => {
    const session = await make().createStreamSession({ voiceId: 'test' });
    expect(session.outputFlowState).toBe('running');
    await session.cancel();
    expect(session.outputFlowState).toBe('terminal');
  });

  test.each(cases)(
    '%s delivers nothing after suspendOutput resolves, and finishes after resume',
    async (_name, make, hasAlignments) => {
      const session = await make().createStreamSession({ voiceId: 'test' });
      const chunks: TtsAudioChunk[] = [];
      const alignments: TtsWordAlignment[] = [];
      session.onAudioChunk((c) => chunks.push(c));
      session.onWordAlignment((a) => alignments.push(a));

      const suspended = await session.suspendOutput();
      expect(suspended).toMatchObject({ ok: true, outcome: 'suspended' });

      const production = (async () => {
        await session.sendTextDelta(TEXT, true);
        await session.completeInput();
      })();
      production.catch(() => undefined);

      // Suspended before a single item was produced: nothing may be delivered at all.
      await settleAsyncWork(30);
      expect(chunks).toHaveLength(0);
      expect(alignments).toHaveLength(0);
      expect(session.outputFlowState).toBe('suspended');

      expect(await session.resumeOutput()).toMatchObject({ ok: true, outcome: 'resumed' });
      await production;

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1].isFinal).toBe(true);
      if (hasAlignments) {
        expect(alignments.length).toBeGreaterThan(0);
      }
    }
  );

  test.each(cases)('%s wakes its blocked producer when cancelled while suspended', async (_name, make) => {
    const session = await make().createStreamSession({ voiceId: 'test' });
    await session.suspendOutput();

    const production = (async () => {
      await session.sendTextDelta(TEXT, true);
      await session.completeInput();
    })();
    production.catch(() => undefined);
    await settleAsyncWork(4);

    await session.cancel();
    await expect(production).resolves.toBeUndefined();
    expect(session.outputFlowState).toBe('terminal');
  });
});
