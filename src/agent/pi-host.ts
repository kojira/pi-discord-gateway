/**
 * pi-host: keeps one `pi --mode rpc` alive independently of the Gateway process.
 *
 * Started detached (own session) by the Gateway. It owns Pi's stdio pipes and
 * exposes them on a Unix socket. Every Pi stdout line gets a sequence number and
 * stays buffered until the attached Gateway acknowledges it, so a Gateway restart
 * loses nothing: the next Gateway attaches with the last sequence it processed.
 * After Pi exits the host keeps its tail until a Gateway acknowledges the exit.
 * See docs/design/resident-pi.md for the protocol.
 */
import { spawn } from 'node:child_process';
import { chmodSync, rmSync, statSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

export interface PiHostLaunch {
  socketPath: string;
  bin: string;
  args: string[];
  cwd: string;
}

/** Milliseconds a finished Pi waits for a Gateway to collect its remaining output. */
const EXIT_COLLECT_TIMEOUT_MS = 60 * 60_000;
const MAX_STDERR_CHARS = 64 * 1024;

export function runPiHost(launch: PiHostLaunch): void {
  const buffered: Array<{ seq: number; line: string }> = [];
  let seq = 0;
  let client: Socket | undefined;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let stderr = '';
  // SIGTERM to the host: end Pi and exit without waiting for a Gateway to collect output.
  let terminating = false;

  const pi = spawn(launch.bin, launch.args, {
    cwd: launch.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  pi.stdin.on('error', () => {});

  // A later host for the same channel may already listen on this path; leave its socket.
  let socketIno: number | undefined;
  const cleanupAndExit = () => {
    try {
      if (statSync(launch.socketPath).ino === socketIno) rmSync(launch.socketPath, { force: true });
    } catch {
      // Already gone.
    }
    process.exit(0);
  };

  const exitMessage = () =>
    `0 ${JSON.stringify({ host: 'exit', code: exited?.code ?? null, signal: exited?.signal ?? null, stderr })}\n`;

  // The attached Gateway sends exit-ack once it has handled everything; until then
  // a Gateway hand-over can still collect the tail and the exit.
  const finishWithClient = (socket: Socket) => {
    if (terminating) socket.end(exitMessage(), cleanupAndExit);
    else socket.write(exitMessage());
  };

  let pending: Buffer[] = [];
  pi.stdout.on('data', (chunk: Buffer) => {
    let start = 0;
    let newline = chunk.indexOf(0x0a, start);
    while (newline !== -1) {
      pending.push(chunk.subarray(start, newline));
      const line = Buffer.concat(pending).toString('utf8');
      pending = [];
      const entry = { seq: ++seq, line };
      buffered.push(entry);
      client?.write(`${entry.seq} ${entry.line}\n`);
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  });
  pi.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8');
  });

  pi.on('error', (error) => {
    stderr += `\n${error.message}`;
    exited = { code: null, signal: null };
    if (client) finishWithClient(client);
  });
  pi.on('close', (code, signal) => {
    if (pending.length > 0) {
      const entry = { seq: ++seq, line: Buffer.concat(pending).toString('utf8') };
      pending = [];
      buffered.push(entry);
      client?.write(`${entry.seq} ${entry.line}\n`);
    }
    exited = { code, signal };
    if (client) finishWithClient(client);
    else if (terminating) cleanupAndExit();
    else setTimeout(cleanupAndExit, EXIT_COLLECT_TIMEOUT_MS).unref();
  });

  const server = createServer((socket) => {
    let input = '';
    let attached = false;
    socket.on('error', () => {});
    socket.on('close', () => {
      if (client !== socket) return;
      client = undefined;
      if (exited) setTimeout(cleanupAndExit, EXIT_COLLECT_TIMEOUT_MS).unref();
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      input += chunk;
      let newline = input.indexOf('\n');
      while (newline !== -1) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        newline = input.indexOf('\n');
        let control: { host?: string; after?: number; seq?: number; signal?: string } | undefined;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.host === 'string') control = parsed;
        } catch {
          // Not a host command: forwarded to Pi as is.
        }
        if (!attached) {
          if (control?.host !== 'attach') {
            socket.destroy();
            return;
          }
          attached = true;
          if (client && client !== socket) client.destroy();
          client = socket;
          const after = typeof control.after === 'number' ? control.after : 0;
          dropThrough(after);
          socket.write(
            `0 ${JSON.stringify({ host: 'attached', hostPid: process.pid, piPid: pi.pid ?? null })}\n`,
          );
          for (const entry of buffered) socket.write(`${entry.seq} ${entry.line}\n`);
          if (exited) finishWithClient(socket);
          continue;
        }
        if (client !== socket) continue;
        if (control?.host === 'ack' && typeof control.seq === 'number') dropThrough(control.seq);
        else if (control?.host === 'exit-ack') {
          if (exited) socket.end(cleanupAndExit);
        } else if (control?.host === 'end-stdin') pi.stdin.end();
        else if (control?.host === 'signal') {
          if (exited === undefined) pi.kill((control.signal as NodeJS.Signals) || 'SIGTERM');
        } else if (pi.stdin.writable) pi.stdin.write(`${line}\n`);
      }
    });
  });

  const dropThrough = (acknowledged: number) => {
    while (buffered.length > 0 && buffered[0].seq <= acknowledged) buffered.shift();
  };

  rmSync(launch.socketPath, { force: true });
  server.listen(launch.socketPath, () => {
    chmodSync(launch.socketPath, 0o600);
    socketIno = statSync(launch.socketPath).ino;
  });
  process.on('SIGHUP', () => {});
  process.on('SIGTERM', () => {
    terminating = true;
    if (exited === undefined) pi.kill('SIGTERM');
    else cleanupAndExit();
  });
}

if (process.argv[2] && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPiHost(JSON.parse(process.argv[2]) as PiHostLaunch);
}
