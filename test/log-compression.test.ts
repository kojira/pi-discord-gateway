import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { compressOldSessionFiles, splitDaemonLogsByMonth } from '../src/session/log-compression.js';

const tempDirs: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pidg-log-compress-'));
  tempDirs.push(dir);
  return dir;
}

function writeAged(path: string, content: string, ageDays: number, now: number): void {
  writeFileSync(path, content);
  const time = new Date(now - ageDays * DAY_MS);
  utimesSync(path, time, time);
}

describe('compressOldSessionFiles', () => {
  it('gzips old session files except the newest in its directory and open files', async () => {
    const now = Date.now();
    const sessionsDir = makeTempDir();
    const channelDir = join(sessionsDir, 'ch_123');
    const runDir = join(channelDir, 'parent', 'run-0');
    mkdirSync(runDir, { recursive: true });
    const oldFile = join(channelDir, 'a.jsonl');
    const openFile = join(channelDir, 'b.jsonl');
    const newestFile = join(channelDir, 'c.jsonl');
    // A subagent run directory holds a single finished session file.
    const runFile = join(runDir, 'session.jsonl');
    writeAged(runFile, 'run\n', 45, now);
    const oldContent = '{"type":"message","n":1}\n'.repeat(100);
    writeAged(oldFile, oldContent, 60, now);
    writeAged(openFile, 'open\n', 50, now);
    writeAged(newestFile, 'newest\n', 40, now);
    const oldMtime = statSync(oldFile).mtimeMs;

    const result = await compressOldSessionFiles(sessionsDir, {
      now,
      isOpen: (file) => file === openFile,
    });

    expect(result).toMatchObject({ compressed: 2, skippedNewest: 1, skippedOpen: 1, failed: 0 });
    expect(existsSync(runFile)).toBe(false);
    expect(gunzipSync(readFileSync(`${runFile}.gz`)).toString()).toBe('run\n');
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(`${oldFile}.gz.tmp`)).toBe(false);
    expect(gunzipSync(readFileSync(`${oldFile}.gz`)).toString()).toBe(oldContent);
    expect(Math.round(statSync(`${oldFile}.gz`).mtimeMs)).toBe(Math.round(oldMtime));
    expect(readFileSync(openFile, 'utf8')).toBe('open\n');
    expect(readFileSync(newestFile, 'utf8')).toBe('newest\n');
  });
});

describe('splitDaemonLogsByMonth', () => {
  it('moves earlier-month stdout lines into monthly gzip archives and keeps the current month', () => {
    const dataDir = makeTempDir();
    const now = new Date(2026, 2, 15).getTime();
    const jan = new Date(2026, 0, 10).getTime();
    const feb = new Date(2026, 1, 10).getTime();
    const mar = new Date(2026, 2, 1).getTime();
    const stdoutPath = join(dataDir, 'daemon.stdout.log');
    writeFileSync(
      stdoutPath,
      [
        JSON.stringify({ time: jan, msg: 'jan' }),
        'plain jan continuation',
        JSON.stringify({ time: feb, msg: 'feb' }),
        JSON.stringify({ time: mar, msg: 'mar' }),
        'plain mar continuation',
        '',
      ].join('\n'),
    );

    splitDaemonLogsByMonth(dataDir, { now });

    expect(gunzipSync(readFileSync(join(dataDir, 'daemon.stdout.2026-01.log.gz'))).toString()).toBe(
      `${JSON.stringify({ time: jan, msg: 'jan' })}\nplain jan continuation\n`,
    );
    expect(gunzipSync(readFileSync(join(dataDir, 'daemon.stdout.2026-02.log.gz'))).toString()).toBe(
      `${JSON.stringify({ time: feb, msg: 'feb' })}\n`,
    );
    expect(readFileSync(stdoutPath, 'utf8')).toBe(
      `${JSON.stringify({ time: mar, msg: 'mar' })}\nplain mar continuation\n`,
    );
  });
});
