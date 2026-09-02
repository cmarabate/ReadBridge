import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  FocusCommandHandler,
  FocusCommandOutcome,
  FocusGrantOutcome,
  FocusGrantResult,
  IReadAudioFocusCoordinator,
} from './audio-focus-contract.js';

/** The protocol version this client speaks. A mismatch fails closed. */
export const VMB_FOCUS_PROTOCOL_VERSION = 1;

/** ReadBridge's fixed adapter identity with the arbiter. */
export const READBRIDGE_ADAPTER_ID = 'readbridge';

const CLIENT_KIND = 'readBridge';
const MAX_FRAME_BYTES = 64 * 1024;

export interface VmbEndpointDescriptor {
  protocolVersion: number;
  pipeName: string;
  executablePath: string;
}

export interface VmbFocusClientOptions {
  /** Overrides discovery. Tests and dev runs supply this; production reads the descriptor. */
  endpoint?: VmbEndpointDescriptor;
  /** Overrides the install root used for discovery. */
  installRoot?: string;
  /** How long to wait for the arbiter to accept a connection, including a spawn. */
  connectTimeoutMs?: number;
  /** How long to wait for a reply to one request. */
  requestTimeoutMs?: number;
  /** Set false to refuse to start the arbiter (used to prove the not-installed path). */
  allowSpawn?: boolean;
}

/** Where VoiceMediaBridge installs itself. Production never depends on a dev checkout. */
export function defaultVmbInstallRoot(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'VoiceMediaBridge', 'NativeHost');
}

/** The only executable name this client will ever launch. */
const VMB_HOST_EXECUTABLE = 'VoiceMediaBridge.NativeHost.exe';

/** The shape the arbiter actually publishes. Anything else is not a pipe name. */
const PIPE_NAME_PATTERN = /^VoiceMediaBridge\.AudioFocus\.v[0-9]+\.[0-9a-f]+$/;

/**
 * Reads the machine-local discovery descriptor, and VALIDATES what it names.
 *
 * The file is user-writable, and this client both launches the executable it names and
 * builds a pipe path from the name it carries. Type-checking the fields would leave a
 * hidden-process-launch primitive and a pipe path pointing anywhere in the NPFS
 * namespace, driven by a file anything running as this user can rewrite. So the
 * executable must be the expected file inside the expected install root, and the pipe
 * name must match the shape the arbiter publishes.
 */
export function readVmbEndpointDescriptor(installRoot = defaultVmbInstallRoot()): VmbEndpointDescriptor | null {
  try {
    const raw = fs.readFileSync(path.join(installRoot, 'audio-focus-endpoint.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<VmbEndpointDescriptor>;
    if (
      typeof parsed.protocolVersion !== 'number' ||
      typeof parsed.pipeName !== 'string' ||
      typeof parsed.executablePath !== 'string'
    ) {
      return null;
    }

    if (!PIPE_NAME_PATTERN.test(parsed.pipeName)) {
      return null;
    }

    const resolvedRoot = path.resolve(installRoot);
    const resolvedExe = path.resolve(parsed.executablePath);
    const withinRoot =
      resolvedExe.toLowerCase().startsWith(`${resolvedRoot.toLowerCase()}${path.sep}`) &&
      path.basename(resolvedExe).toLowerCase() === VMB_HOST_EXECUTABLE.toLowerCase();

    if (!withinRoot) {
      return null;
    }

    return {
      protocolVersion: parsed.protocolVersion,
      pipeName: parsed.pipeName,
      executablePath: resolvedExe,
    };
  } catch {
    return null;
  }
}

/** An error a caller can act on, rather than a silent degrade to unarbitrated audio. */
export class VmbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VmbUnavailableError';
  }
}

interface PendingRequest {
  resolve: (message: Record<string, any>) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ReadBridge's client for the shared VoiceMediaBridge audio-focus arbiter.
 *
 * A transport and nothing else. It holds no priority, no lease and no notion of
 * background media; it asks the one authority whether this exact read may be audible,
 * and carries the authority's SUSPEND/RESUME commands to the controller.
 *
 * Participant identity is the exact `ReaderController` read session id, so a stopped or
 * replaced read is a different participant and a command naming the old one fails closed.
 */
export class VoiceMediaBridgeFocusClient implements IReadAudioFocusCoordinator {
  public readonly coordinatorId = 'voicemediabridge-arbiter';
  public readonly arbitrates = true;

  private readonly options: Required<Omit<VmbFocusClientOptions, 'endpoint' | 'installRoot'>> & {
    endpoint?: VmbEndpointDescriptor;
    installRoot: string;
  };

  private socket: net.Socket | null = null;
  private buffer = '';
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly held = new Set<string>();
  private commandHandler: FocusCommandHandler | null = null;
  private connectionLostListeners: Array<() => void> = [];
  private disposed = false;
  private connecting: Promise<void> | null = null;

  constructor(options: VmbFocusClientOptions = {}) {
    this.options = {
      endpoint: options.endpoint,
      installRoot: options.installRoot ?? defaultVmbInstallRoot(),
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      allowSpawn: options.allowSpawn ?? true,
    };
  }

  public get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  public holdsFocus(readSessionId: string): boolean {
    return this.held.has(readSessionId);
  }

  public onCommand(handler: FocusCommandHandler): () => void {
    this.commandHandler = handler;
    return () => {
      if (this.commandHandler === handler) {
        this.commandHandler = null;
      }
    };
  }

  public onConnectionLost(listener: () => void): () => void {
    this.connectionLostListeners.push(listener);
    return () => {
      this.connectionLostListeners = this.connectionLostListeners.filter((l) => l !== listener);
    };
  }

  public async requestSpokenOutputFocus(readSessionId: string): Promise<FocusGrantResult> {
    try {
      await this.ensureConnected();
    } catch (err: any) {
      // An unreachable authority is a refusal. Nothing may become audible on the
      // strength of a missing answer.
      return { outcome: 'unavailable', granted: false, detail: err?.message ?? String(err) };
    }

    const reply = await this.send({
      t: 'focusRequest',
      class: 'SpokenOutput',
      adapterId: READBRIDGE_ADAPTER_ID,
      participantId: readSessionId,
    });

    if (reply === null && this.isConnected) {
      // The arbiter may have granted this after the deadline passed. Assuming a refusal
      // would strand that lease: nothing would ever release it, the user's background
      // media would stay paused and the arbiter would never reach idle. Compensate.
      await this.send({
        t: 'focusRelease',
        class: 'SpokenOutput',
        adapterId: READBRIDGE_ADAPTER_ID,
        participantId: readSessionId,
      });

      return {
        outcome: 'unavailable',
        granted: false,
        detail: 'The audio-focus arbiter did not answer in time; any grant was released.',
      };
    }

    const outcome = mapGrantOutcome(reply?.outcome);
    const granted = outcome === 'granted' || outcome === 'alreadyHeld';

    // Only while still connected. `handleDisconnect` clears this set and can run between
    // the await above and here; recording a hold afterwards would report focus held by an
    // authority that is already gone, and a later resume would skip reacquiring it.
    if (granted && this.isConnected) {
      this.held.add(readSessionId);
    } else {
      this.held.delete(readSessionId);
    }

    return { outcome, granted, detail: typeof reply?.reason === 'string' ? reply.reason : undefined };
  }

  public async releaseSpokenOutputFocus(readSessionId: string): Promise<void> {
    if (!this.held.has(readSessionId) && !this.isConnected) {
      return;
    }

    this.held.delete(readSessionId);
    if (!this.isConnected) {
      return;
    }

    await this.send({
      t: 'focusRelease',
      class: 'SpokenOutput',
      adapterId: READBRIDGE_ADAPTER_ID,
      participantId: readSessionId,
    });
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.commandHandler = null;
    this.connectionLostListeners = [];
    this.failPending();
    this.held.clear();

    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => socket.end(() => resolve()));
      socket.destroy();
    }
  }

  // ---- transport -------------------------------------------------------------

  private async ensureConnected(): Promise<void> {
    if (this.disposed) {
      throw new VmbUnavailableError('The audio-focus client has been disposed.');
    }
    if (this.isConnected) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const endpoint = this.options.endpoint ?? readVmbEndpointDescriptor(this.options.installRoot);
    if (!endpoint) {
      throw new VmbUnavailableError(
        `VoiceMediaBridge is not installed: no audio-focus endpoint descriptor under ${this.options.installRoot}. ` +
          'Install VoiceMediaBridge (tools/Install-NativeHost.ps1) before using integrated playback.'
      );
    }

    if (endpoint.protocolVersion !== VMB_FOCUS_PROTOCOL_VERSION) {
      throw new VmbUnavailableError(
        `VoiceMediaBridge speaks audio-focus protocol v${endpoint.protocolVersion}, ` +
          `but this ReadBridge speaks v${VMB_FOCUS_PROTOCOL_VERSION}. Update both to matching versions.`
      );
    }

    if (!PIPE_NAME_PATTERN.test(endpoint.pipeName)) {
      throw new VmbUnavailableError(
        `Refusing to open '${endpoint.pipeName}': it is not a VoiceMediaBridge audio-focus pipe name.`
      );
    }

    const pipePath = `\\\\.\\pipe\\${endpoint.pipeName}`;
    const deadline = Date.now() + this.options.connectTimeoutMs;
    let attempts = 0;
    let lastError = 'the arbiter did not accept a connection';

    while (Date.now() < deadline) {
      attempts++;
      try {
        const socket = await connectPipe(pipePath);
        this.attach(socket);

        const handshake = await this.handshake();
        if (handshake === 'accepted') {
          return;
        }

        // Only an explicit refusal is permanent. A socket that closed mid-handshake is an
        // arbiter shutting down as we arrived - a lifecycle race the retry loop below is
        // there to absorb, and treating it as a refusal would turn a transient into a
        // permanent "VoiceMediaBridge unavailable".
        if (handshake === 'refused') {
          throw new VmbUnavailableError('The audio-focus arbiter refused this client.');
        }

        throw new Error('the arbiter closed the connection during the handshake');
      } catch (err: any) {
        if (err instanceof VmbUnavailableError) {
          throw err;
        }

        lastError = err?.message ?? String(err);

        // Re-attempted, not once-only. An arbiter that is shutting down still holds its
        // single-instance handle for a moment, so a spawn in that window exits without
        // listening - and a one-shot spawn would already be spent, leaving nobody serving.
        // Spaced out so the retry does not become a spawn storm.
        if (attempts % 4 === 1 && this.options.allowSpawn && fs.existsSync(endpoint.executablePath)) {
          spawnArbiter(endpoint.executablePath);
        }

        await delay(100);
      }
    }

    throw new VmbUnavailableError(
      `Could not reach the VoiceMediaBridge audio-focus arbiter on ${endpoint.pipeName}: ${lastError}.`
    );
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    this.buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => this.consume(chunk));
    // Keyed on THIS socket: a previous connection's late close must not tear down the one
    // that replaced it.
    socket.on('error', () => this.handleDisconnect(socket));
    socket.on('close', () => this.handleDisconnect(socket));
  }

  private async handshake(): Promise<'accepted' | 'refused' | 'lost'> {
    const reply = await this.send({
      t: 'hello',
      protocolVersion: VMB_FOCUS_PROTOCOL_VERSION,
      clientKind: CLIENT_KIND,
      clientInstanceId: `readbridge-${process.pid}`,
    });

    if (reply?.ok === true) {
      return 'accepted';
    }

    // A reply that names a reason is a decision; anything else is a lost connection.
    return reply && typeof reply.reason === 'string' && reply.t === 'helloResult' ? 'refused' : 'lost';
  }

  private consume(chunk: string): void {
    this.buffer += chunk;

    if (this.buffer.length > MAX_FRAME_BYTES) {
      // An endless frame is a denial of service, not a parse error.
      this.buffer = '';
      this.socket?.destroy();
      return;
    }

    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');

      if (!line) continue;

      let message: Record<string, any>;
      try {
        message = JSON.parse(line);
      } catch {
        // Unparseable input must never execute anything.
        continue;
      }

      if (message.t === 'actuate') {
        // Handled off the read path so a slow suspension cannot stall a reply that a
        // concurrent focus request is waiting for.
        void this.handleActuate(message);
        continue;
      }

      const id = typeof message.id === 'string' ? message.id : null;
      if (id && this.pending.has(id)) {
        const entry = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    }
  }

  private async handleActuate(command: Record<string, any>): Promise<void> {
    let outcome: FocusCommandOutcome = 'failed';

    try {
      const action = command.action === 'SUSPEND' ? 'suspend' : command.action === 'RESUME' ? 'resume' : null;
      const readSessionId = typeof command.participantId === 'string' ? command.participantId : null;
      const adapterId = typeof command.adapterId === 'string' ? command.adapterId : null;

      if (!action || !readSessionId || adapterId !== READBRIDGE_ADAPTER_ID) {
        outcome = 'failed';
      } else if (!this.commandHandler) {
        outcome = 'participantUnavailable';
      } else {
        outcome = await this.commandHandler({ action, readSessionId });
      }
    } catch {
      outcome = 'failed';
    }

    this.write({
      t: 'actuateAck',
      commandId: command.commandId,
      outcome: toWireOutcome(outcome),
    });
  }

  private send(message: Record<string, any>): Promise<Record<string, any> | null> {
    if (!this.isConnected) {
      return Promise.resolve(null);
    }

    const id = `rb-${++this.nextRequestId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.options.requestTimeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, timer });
      if (!this.write({ ...message, id })) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  private write(message: Record<string, any>): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return false;
    }

    try {
      socket.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private handleDisconnect(socket?: net.Socket): void {
    if (!this.socket || (socket !== undefined && socket !== this.socket)) {
      return;
    }

    this.socket = null;
    this.buffer = '';
    this.failPending();
    this.held.clear();

    if (this.disposed) {
      return;
    }

    for (const listener of [...this.connectionLostListeners]) {
      try {
        listener();
      } catch {
        // A failing listener must not stop the others being told.
      }
    }
  }

  private failPending(): void {
    for (const [, entry] of [...this.pending]) {
      clearTimeout(entry.timer);
      entry.resolve({ t: 'error', reason: 'ArbiterDisconnected' });
    }
    this.pending.clear();
  }
}

function mapGrantOutcome(raw: unknown): FocusGrantOutcome {
  switch (raw) {
    case 'Granted':
    case 'GrantedByPreemption':
      return 'granted';
    case 'AlreadyHeld':
      return 'alreadyHeld';
    case 'BlockedByHigherFocus':
      return 'blockedByHigherFocus';
    case 'ClassConflict':
      return 'classConflict';
    default:
      // Includes SuspendFailed, Unsupported, a missing reply and anything unrecognised.
      // None of them is a grant.
      return 'unavailable';
  }
}

function toWireOutcome(outcome: FocusCommandOutcome): string {
  switch (outcome) {
    case 'applied':
      return 'Applied';
    case 'participantUnavailable':
      return 'ParticipantUnavailable';
    case 'rejected':
      return 'Rejected';
    default:
      return 'Failed';
  }
}

function connectPipe(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    const onError = (err: Error): void => {
      socket.removeAllListeners();
      socket.destroy();
      reject(err);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

/**
 * Starts the arbiter without a console window and without inheriting this process's
 * lifetime. Ordinary user-level process start: no service, no scheduled task, no
 * elevation, no autostart entry.
 */
function spawnArbiter(executablePath: string): void {
  try {
    const child = spawn(executablePath, ['--arbiter'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      cwd: path.dirname(executablePath),
    });
    child.unref();
  } catch {
    // The connect loop reports the failure; a spawn that did not take is not fatal on
    // its own, because another client may already have started one.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
