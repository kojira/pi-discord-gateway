/**
 * Gateway side of a resident Pi (see docs/design/resident-pi.md).
 *
 * `ResidentPiProcess` presents the socket to a detached pi-host with the same
 * surface invoke.ts uses on a stdio child (stdin/stdout/stderr/kill/close), so the
 * RPC handling is shared. `lastSeq` is the last Pi line delivered to stdout
 * listeners; listeners consume each line synchronously.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { resolveChannelSessionDir } from '../session/path.js';
import type { PiHostLaunch } from './pi-host.js';
import type { RuntimeSettings } from './runtime-settings.js';

const RECORD_FILE = 'pi-host.json';
const SOCKET_PATH_LIMIT = 103;
const CONNECT_TIMEOUT_MS = 10_000;

/** Persisted per channel while its resident Pi runs. */
export interface ResidentPiRecord {
  socketPath: string;
  hostPid: number;
  piBin: string;
  launchedSettings: RuntimeSettings;
  supervisorTempRoot: string;
  startedAt: string;
  /** Resume state written by the attached Gateway; absent until the first checkpoint. */
  snapshot?: ResidentSnapshot;
}

export interface ResidentSnapshot {
  lastSeq: number;
  connection: Record<string, unknown>;
  /** Present while a Gateway request (queue row) is in flight on this Pi. */
  request?: { queue: unknown };
  steering: Array<{ message: string; rowids: number[] }>;
}

export function residentRecordPath(channelFolder: string): string {
  return join(resolveChannelSessionDir(channelFolder), RECORD_FILE);
}

export function readResidentRecord(channelFolder: string): ResidentPiRecord | undefined {
  try {
    return JSON.parse(readFileSync(residentRecordPath(channelFolder), 'utf8')) as ResidentPiRecord;
  } catch {
    return undefined;
  }
}

export function writeResidentRecord(channelFolder: string, record: ResidentPiRecord): void {
  const file = residentRecordPath(channelFolder);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  renameSync(temp, file);
}

export function removeResidentRecord(channelFolder: string, hostPid?: number): void {
  const record = readResidentRecord(channelFolder);
  if (hostPid !== undefined && record && record.hostPid !== hostPid) return;
  rmSync(residentRecordPath(channelFolder), { force: true });
}

/** A record is resumable only while its host runs and its socket exists. */
export function isResidentAlive(record: ResidentPiRecord): boolean {
  try {
    process.kill(record.hostPid, 0);
  } catch {
    return false;
  }
  try {
    return statSync(record.socketPath).isSocket();
  } catch {
    return false;
  }
}

function residentSocketPath(sessionDir: string): string {
  const hash = createHash('sha256').update(sessionDir).digest('hex').slice(0, 16);
  const preferred = join(config.sessionsDir, '.pi-hosts', `${hash}.sock`);
  if (Buffer.byteLength(preferred) <= SOCKET_PATH_LIMIT) {
    mkdirSync(dirname(preferred), { recursive: true, mode: 0o700 });
    return preferred;
  }
  return join(tmpdir(), `piscord-${hash}.sock`);
}

/** Built Gateway runs dist/agent/pi-host.js; source runs (tests) load the .ts through tsx. */
function hostCommand(): string[] {
  const js = fileURLToPath(new URL('./pi-host.js', import.meta.url));
  if (existsSync(js)) return [js];
  const ts = fileURLToPath(new URL('./pi-host.ts', import.meta.url));
  const tsx = createRequire(import.meta.url).resolve('tsx');
  return ['--import', tsx, ts];
}

/** Start a detached pi-host for a new resident Pi. */
export function startResidentPi(options: {
  channelFolder: string;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  piBin: string;
  launchedSettings: RuntimeSettings;
  supervisorTempRoot: string;
}): ResidentPiProcess {
  const socketPath = residentSocketPath(resolveChannelSessionDir(options.channelFolder));
  const launch: PiHostLaunch = {
    socketPath,
    bin: options.bin,
    args: options.args,
    cwd: options.cwd,
  };
  rmSync(socketPath, { force: true });
  const host = spawn(process.execPath, [...hostCommand(), JSON.stringify(launch)], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: 'ignore',
  });
  host.unref?.();
  const record: ResidentPiRecord = {
    socketPath,
    hostPid: host.pid ?? 0,
    piBin: options.piBin,
    launchedSettings: options.launchedSettings,
    supervisorTempRoot: options.supervisorTempRoot,
    startedAt: new Date().toISOString(),
  };
  const proc = new ResidentPiProcess(options.channelFolder, record, 0);
  host.on('error', (error) => proc.failConnection(error));
  if (host.pid) writeResidentRecord(options.channelFolder, record);
  return proc;
}

class ResidentStdin extends EventEmitter {
  writable = true;
  destroyed = false;
  constructor(private readonly owner: ResidentPiProcess) {
    super();
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (!this.writable) {
      callback?.(new Error('Pi RPC stdin is closed'));
      return false;
    }
    this.owner.send(data, callback);
    return true;
  }
  end(data?: string): void {
    if (!this.writable) return;
    if (data) this.owner.send(data);
    this.writable = false;
    this.owner.send('{"host":"end-stdin"}\n');
  }
}

export class ResidentPiProcess extends EventEmitter {
  readonly stdin = new ResidentStdin(this);
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  lastSeq: number;
  piPid?: number;
  /** The host reported Pi's exit (as opposed to a lost connection). */
  piExited = false;
  private socket?: Socket;
  private outbox: Array<{ data: string; callback?: (error?: Error | null) => void }> = [];
  private input = '';
  private closed = false;
  private detached = false;
  private paused = false;
  private held: string[] = [];

  constructor(
    readonly channelFolder: string,
    readonly record: ResidentPiRecord,
    lastSeq: number,
  ) {
    super();
    this.lastSeq = lastSeq;
    this.connect(Date.now() + CONNECT_TIMEOUT_MS);
  }

  get hostPid(): number {
    return this.record.hostPid;
  }

  private connect(deadline: number): void {
    if (this.closed || this.detached) return;
    const socket = connect(this.record.socketPath);
    socket.once('connect', () => {
      this.socket = socket;
      socket.write(`${JSON.stringify({ host: 'attach', after: this.lastSeq })}\n`);
      for (const item of this.outbox.splice(0)) socket.write(item.data, item.callback);
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (this.socket !== socket && ['ENOENT', 'ECONNREFUSED'].includes(error.code || '')) {
        socket.destroy();
        if (Date.now() < deadline && this.hostRunning()) {
          setTimeout(() => this.connect(deadline), 50);
        } else this.failConnection(new Error(`Could not connect to resident Pi: ${error.message}`));
      }
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      // Paused for a hand-over: the next Gateway reattaches; this one must not clean up.
      if (!this.detached && !this.paused) this.emitClose(null);
    });
  }

  private hostRunning(): boolean {
    try {
      process.kill(this.record.hostPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  failConnection(error: Error): void {
    if (this.closed) return;
    this.emit('error', error);
    this.emitClose(null);
  }

  send(data: string, callback?: (error?: Error | null) => void): void {
    if (this.closed || this.detached) {
      callback?.(new Error('Pi RPC stdin is closed'));
      return;
    }
    if (this.socket) this.socket.write(data, callback);
    else this.outbox.push({ data, callback });
  }

  private receive(text: string): void {
    this.input += text;
    let newline = this.input.indexOf('\n');
    while (newline !== -1) {
      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      newline = this.input.indexOf('\n');
      if (this.paused) this.held.push(line);
      else this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const space = line.indexOf(' ');
    const seq = Number(line.slice(0, space));
    const payload = line.slice(space + 1);
    if (seq === 0) {
      const message = JSON.parse(payload) as {
        host: string;
        piPid?: number;
        code?: number | null;
        stderr?: string;
      };
      if (message.host === 'attached') this.piPid = message.piPid ?? undefined;
      if (message.host === 'exit') {
        this.piExited = true;
        if (message.stderr) this.stderr.emit('data', Buffer.from(message.stderr));
        this.stdout.emit('end');
        // The socket stays open until ackExit(): the host keeps the tail until then.
        this.emitClose(message.code ?? null, true);
      }
      return;
    }
    // Replayed lines at or below the restored position were already processed.
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    this.stdout.emit('data', Buffer.from(`${payload}\n`));
  }

  private emitClose(code: number | null, keepSocket = false): void {
    if (this.closed) return;
    this.closed = true;
    this.stdin.writable = false;
    if (!keepSocket) this.socket?.destroy();
    this.emit('close', code);
  }

  /** Pi's exit is fully handled (deliveries drained, request settled): let the host exit. */
  ackExit(): void {
    if (this.piExited && this.socket && !this.detached) {
      this.socket.end(`${JSON.stringify({ host: 'exit-ack' })}\n`);
    }
  }

  /** Allow the host to drop buffered lines up to the persisted position. */
  ack(seq: number): void {
    if (this.socket && !this.closed && !this.detached) {
      this.socket.write(`${JSON.stringify({ host: 'ack', seq })}\n`);
    }
  }

  /** Stop consuming lines; they stay buffered in the host for the next Gateway. */
  pause(): void {
    this.paused = true;
  }

  detach(): void {
    this.detached = true;
    this.stdin.writable = false;
    this.socket?.end();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.closed) return false;
    if (this.socket) {
      this.socket.write(`${JSON.stringify({ host: 'signal', signal })}\n`);
      return true;
    }
    if (this.piPid) {
      try {
        process.kill(this.piPid, signal);
        return true;
      } catch (error: any) {
        logger.debug({ err: error.message }, 'Resident Pi signal failed');
      }
    }
    return false;
  }
}
