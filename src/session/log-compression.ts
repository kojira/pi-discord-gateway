import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, gzipSync } from 'node:zlib';
import { config } from '../config.js';
import { getAllChannels } from '../db.js';
import { logger } from '../logger.js';
import { resolveChannelSessionDir } from './path.js';

const COMPRESS_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPRESSION_INTERVAL_MS = DAY_MS;
const FIRST_RUN_DELAY_MS = 60 * 1000;

export interface SessionCompressionResult {
  compressed: number;
  bytesBefore: number;
  bytesAfter: number;
  skippedNewest: number;
  skippedOpen: number;
  skippedExisting: number;
  failed: number;
}

/** True when some process holds the file open; also true when lsof cannot answer. */
export function isFileOpenByAnyProcess(file: string): boolean {
  const result = spawnSync('/usr/sbin/lsof', ['-t', '--', file], { encoding: 'utf8' });
  if (result.error) return true;
  if (result.status === 0) return true;
  // lsof exits 1 with no output when nothing has the file open.
  return !(result.status === 1 && result.stdout.trim() === '' && result.stderr.trim() === '');
}

async function sha256AndLength(
  stream: NodeJS.ReadableStream,
): Promise<{ hash: string; length: number }> {
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    length += chunk.length;
  }
  return { hash: hash.digest('hex'), length };
}

async function gzipSessionFile(file: string): Promise<number> {
  const gzPath = `${file}.gz`;
  const tmpPath = `${gzPath}.tmp`;
  const before = statSync(file);
  try {
    await pipeline(createReadStream(file), createGzip(), createWriteStream(tmpPath));
    const original = await sha256AndLength(createReadStream(file));
    const restored = await sha256AndLength(createReadStream(tmpPath).pipe(createGunzip()));
    if (original.hash !== restored.hash || original.length !== restored.length) {
      throw new Error('gzip verification mismatch');
    }
    renameSync(tmpPath, gzPath);
    try {
      utimesSync(gzPath, before.atime, before.mtime);
      const after = statSync(file);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error('original changed during compression');
      }
    } catch (err) {
      rmSync(gzPath, { force: true });
      throw err;
    }
    rmSync(file);
    return statSync(gzPath).size;
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export async function compressOldSessionFiles(
  sessionsDir: string,
  options: {
    now?: number;
    isOpen?: (file: string) => boolean;
    /** Session dirs Pi resumes with `--continue` (one per registered channel). */
    resumedDirs?: ReadonlySet<string>;
  } = {},
): Promise<SessionCompressionResult> {
  const resumedDirs = options.resumedDirs ?? new Set<string>();
  const now = options.now ?? Date.now();
  const isOpen = options.isOpen ?? isFileOpenByAnyProcess;
  const cutoff = now - COMPRESS_AFTER_DAYS * DAY_MS;
  const result: SessionCompressionResult = {
    compressed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    skippedNewest: 0,
    skippedOpen: 0,
    skippedExisting: 0,
    failed: 0,
  };
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const files: { path: string; mtimeMs: number; size: number }[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = statSync(fullPath);
          files.push({ path: fullPath, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          continue;
        }
      }
    }
    if (files.length === 0) continue;

    // `--continue` resumes the newest file in a registered channel's session dir.
    const isChannelDir = resumedDirs.has(resolve(dir));
    const newest = isChannelDir
      ? files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
      : undefined;
    for (const file of files) {
      if (file.mtimeMs >= cutoff) continue;
      if (file === newest) {
        result.skippedNewest += 1;
        continue;
      }
      if (existsSync(`${file.path}.gz`)) {
        result.skippedExisting += 1;
        continue;
      }
      if (isOpen(file.path)) {
        result.skippedOpen += 1;
        continue;
      }
      try {
        const gzSize = await gzipSessionFile(file.path);
        result.compressed += 1;
        result.bytesBefore += file.size;
        result.bytesAfter += gzSize;
      } catch (err: any) {
        result.failed += 1;
        logger.warn({ err: err.message, path: file.path }, 'Session log compression failed');
      }
    }
  }

  return result;
}

function monthKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function lineTime(line: string): number | undefined {
  try {
    const time = JSON.parse(line)?.time;
    return typeof time === 'number' && Number.isFinite(time) ? time : undefined;
  } catch {
    return undefined;
  }
}

export interface DaemonLogSplitResult {
  archivedMonths: string[];
  bytesBefore: number;
  bytesAfter: number;
}

/** Keep only the current local month in daemon.stdout.log / daemon.stderr.log; older content goes to monthly .gz archives. */
export function splitDaemonLogsByMonth(
  dataDir: string,
  options: { now?: number } = {},
): DaemonLogSplitResult {
  const currentMonth = monthKey(options.now ?? Date.now());
  const result: DaemonLogSplitResult = { archivedMonths: [], bytesBefore: 0, bytesAfter: 0 };

  const stdoutPath = resolve(dataDir, 'daemon.stdout.log');
  if (existsSync(stdoutPath)) {
    const snapshot = readFileSync(stdoutPath, 'utf8');
    const lines = snapshot.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const byMonth = new Map<string, string[]>();
    let month = currentMonth;
    for (const line of lines) {
      const time = lineTime(line);
      if (time !== undefined) month = monthKey(time);
      const bucket = byMonth.get(month) ?? [];
      bucket.push(line);
      byMonth.set(month, bucket);
    }
    const olderMonths = [...byMonth.keys()].filter((m) => m !== currentMonth).sort();
    if (olderMonths.length > 0) {
      for (const m of olderMonths) {
        const text = `${byMonth.get(m)!.join('\n')}\n`;
        const gz = gzipSync(text);
        appendFileSync(resolve(dataDir, `daemon.stdout.${m}.log.gz`), gz);
        result.archivedMonths.push(`stdout:${m}`);
        result.bytesBefore += Buffer.byteLength(text);
        result.bytesAfter += gz.length;
      }
      const current = byMonth.get(currentMonth);
      truncateSync(stdoutPath, 0);
      if (current) appendFileSync(stdoutPath, `${current.join('\n')}\n`);
    }
  }

  const stderrPath = resolve(dataDir, 'daemon.stderr.log');
  if (existsSync(stderrPath)) {
    const st = statSync(stderrPath);
    const month = monthKey(st.mtimeMs);
    if (st.size > 0 && month < currentMonth) {
      const content = readFileSync(stderrPath);
      const gz = gzipSync(content);
      appendFileSync(resolve(dataDir, `daemon.stderr.${month}.log.gz`), gz);
      truncateSync(stderrPath, 0);
      result.archivedMonths.push(`stderr:${month}`);
      result.bytesBefore += content.length;
      result.bytesAfter += gz.length;
    }
  }

  return result;
}

async function runLogCompression(): Promise<void> {
  try {
    const resumedDirs = new Set(getAllChannels().map((c) => resolveChannelSessionDir(c.folder)));
    const sessions = await compressOldSessionFiles(config.sessionsDir, { resumedDirs });
    // The launchers write daemon.*.log next to the database.
    const daemonLogs = splitDaemonLogsByMonth(dirname(config.dbPath));
    logger.info({ sessions, daemonLogs }, 'Log compression run');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Log compression error');
  }
}

export function startLogCompression(): () => void {
  const firstRun = setTimeout(() => void runLogCompression(), FIRST_RUN_DELAY_MS);
  const timer = setInterval(() => void runLogCompression(), COMPRESSION_INTERVAL_MS);
  firstRun.unref();
  timer.unref();
  return () => {
    clearTimeout(firstRun);
    clearInterval(timer);
  };
}
