import { closeSync, lstatSync, openSync, readSync, readdirSync, type Stats } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { formatNestedSessionTraceRecord } from '../agent/trace.js';
import { config } from '../config.js';
import { getAllChannels, getChannelWebhook } from '../db.js';
import { logger } from '../logger.js';
import { enqueueWebhookTrace } from '../discord/webhook-monitor.js';

const POLL_INTERVAL_MS = 1000;
const MAX_CHANNELS = 256;
const MAX_FILES_PER_CHANNEL = 512;
const MAX_DISCOVERY_ENTRIES = 4096;
const MAX_DIRECTORY_DEPTH = 12;
const MAX_BYTES_PER_CHANNEL_POLL = 1024 * 1024;
const MAX_BYTES_PER_FILE_POLL = 256 * 1024;
// Session records can contain large encrypted reasoning signatures even when
// the displayable assistant text is short. Keep enough room to parse and then
// discard those fields, while retaining explicit global/per-channel bounds.
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES_PER_CHANNEL = 4 * 1024 * 1024;
const MAX_PENDING_BYTES_GLOBAL = 16 * 1024 * 1024;
const BASELINE_NAME_BYTES = 8 * 1024;
const FILE_IDENTITY_PREFIX_BYTES = 128;
const MAX_BASELINE_NAME_BYTES_PER_CHANNEL = 256 * 1024;
const LOG_THROTTLE_MS = 60_000;

export interface NestedSessionSource {
  jid: string;
  root: string;
  /** Changes whenever a webhook is cleared, recreated, or replaced. */
  epoch?: string;
}

export interface NestedSessionMonitorDependencies {
  listSources(): NestedSessionSource[];
  emit(jid: string, line: string): void;
  warn?(metadata: Record<string, unknown>, message: string): void;
  now?(): number;
}

interface FileCursor {
  identity: string;
  prefix: string;
  prefixLength: number;
  offset: number;
  pending: Buffer;
  droppingOversizedLine: boolean;
  sourceName?: string;
}

interface ChannelCursor {
  root: string;
  epoch?: string;
  initialized: boolean;
  files: Map<string, FileCursor>;
  nextFileIndex: number;
}

interface DiscoveredFiles {
  paths: string[];
  truncated: boolean;
}

/**
 * Poll append-only nested Pi session transcripts for child-agent activity.
 * Top-level `<channel>/<session>.jsonl` files are deliberately excluded because
 * the active Pi RPC stream already reports those records.
 */
export class NestedSessionTraceMonitor {
  private readonly channels = new Map<string, ChannelCursor>();
  private readonly lastWarnings = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private polling = false;

  constructor(private readonly dependencies: NestedSessionMonitorDependencies) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.channels.clear();
    this.lastWarnings.clear();
  }

  pollOnce(): void {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const sources = this.safeSources();
      const activeJids = new Set(sources.map((source) => source.jid));
      for (const jid of this.channels.keys()) {
        if (!activeJids.has(jid)) this.channels.delete(jid);
      }

      for (const source of sources.slice(0, MAX_CHANNELS)) {
        this.pollSource(source);
        this.enforceGlobalPendingLimit();
      }
      if (sources.length > MAX_CHANNELS) {
        this.warnThrottled(
          'channel-limit',
          { channels: sources.length },
          'Nested session monitor channel limit reached',
        );
      }
    } finally {
      this.polling = false;
    }
  }

  stats(): { channels: number; files: number; pendingBytes: number } {
    const states = [...this.channels.values()];
    return {
      channels: states.length,
      files: states.reduce((count, state) => count + state.files.size, 0),
      pendingBytes: states.reduce(
        (count, state) =>
          count +
          [...state.files.values()].reduce((total, cursor) => total + cursor.pending.length, 0),
        0,
      ),
    };
  }

  private safeSources(): NestedSessionSource[] {
    try {
      const unique = new Map<string, NestedSessionSource>();
      for (const source of this.dependencies.listSources()) {
        if (!source?.jid || !source.root || unique.has(source.jid)) continue;
        unique.set(source.jid, {
          jid: source.jid,
          root: resolve(source.root),
          epoch: source.epoch,
        });
      }
      return [...unique.values()].sort((a, b) => a.jid.localeCompare(b.jid));
    } catch (error) {
      this.warnError('sources', undefined, error, 'Could not list nested session monitor sources');
      return [];
    }
  }

  private pollSource(source: NestedSessionSource): void {
    let state = this.channels.get(source.jid);
    if (!state || state.root !== source.root || state.epoch !== source.epoch) {
      state = {
        root: source.root,
        epoch: source.epoch,
        initialized: false,
        files: new Map(),
        nextFileIndex: 0,
      };
      this.channels.set(source.jid, state);
    }

    let discovered: DiscoveredFiles;
    try {
      discovered = discoverNestedJsonl(source.root);
    } catch (error) {
      this.warnError(
        `discover:${source.jid}`,
        source.jid,
        error,
        'Could not scan nested session transcripts',
      );
      return;
    }
    if (discovered.truncated) {
      this.warnThrottled(
        `file-limit:${source.jid}`,
        { jid: source.jid },
        'Nested session transcript discovery limit reached',
      );
    }

    const visible = new Set(discovered.paths);
    for (const path of state.files.keys()) {
      if (!visible.has(path)) state.files.delete(path);
    }

    if (!state.initialized) {
      this.baselineFiles(state, discovered.paths, source.jid);
      state.initialized = true;
      return;
    }

    for (const path of discovered.paths) {
      if (state.files.has(path)) continue;
      const stats = safeRegularFileStats(path);
      if (!stats) continue;
      state.files.set(path, newCursor(path, stats, 0));
    }
    this.readFiles(source.jid, state, discovered.paths);
  }

  private baselineFiles(state: ChannelCursor, paths: readonly string[], jid: string): void {
    let nameBudget = MAX_BASELINE_NAME_BYTES_PER_CHANNEL;
    for (const path of paths) {
      const stats = safeRegularFileStats(path);
      if (!stats) continue;
      const cursor = newCursor(path, stats, stats.size);
      if (nameBudget > 0) {
        const readLimit = Math.min(BASELINE_NAME_BYTES, nameBudget, stats.size);
        cursor.sourceName = readBaselineSourceName(path, readLimit);
        nameBudget -= readLimit;
      }
      state.files.set(path, cursor);
    }
    if (paths.length > MAX_FILES_PER_CHANNEL) {
      this.warnThrottled(
        `baseline-limit:${jid}`,
        { jid },
        'Nested session transcript baseline limit reached',
      );
    }
  }

  private readFiles(jid: string, state: ChannelCursor, discoveredPaths: readonly string[]): void {
    if (discoveredPaths.length === 0) return;
    const ordered = rotate(discoveredPaths, state.nextFileIndex);
    let channelBudget = MAX_BYTES_PER_CHANNEL_POLL;
    let visited = 0;

    for (const path of ordered) {
      if (channelBudget <= 0) break;
      const cursor = state.files.get(path);
      if (!cursor) continue;
      visited += 1;
      const consumed = this.readFile(
        jid,
        path,
        cursor,
        Math.min(channelBudget, MAX_BYTES_PER_FILE_POLL),
      );
      channelBudget -= consumed;
      this.enforceChannelPendingLimit(jid, state);
    }
    state.nextFileIndex = (state.nextFileIndex + Math.max(1, visited)) % discoveredPaths.length;
  }

  private readFile(jid: string, path: string, cursor: FileCursor, budget: number): number {
    const stats = safeRegularFileStats(path);
    if (!stats) return 0;
    const identity = fileIdentity(stats);
    const prefixChanged = !filePrefixMatches(path, cursor);
    if (identity !== cursor.identity || stats.size < cursor.offset || prefixChanged) {
      const replacement = newCursor(path, stats, 0);
      cursor.identity = replacement.identity;
      cursor.prefix = replacement.prefix;
      cursor.prefixLength = replacement.prefixLength;
      cursor.offset = 0;
      cursor.pending = Buffer.alloc(0);
      cursor.droppingOversizedLine = false;
      cursor.sourceName = undefined;
    }
    const available = Math.max(0, stats.size - cursor.offset);
    const bytesToRead = Math.min(available, budget);
    if (bytesToRead === 0) return 0;

    const buffer = Buffer.allocUnsafe(bytesToRead);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'r');
      const bytesRead = readSync(descriptor, buffer, 0, bytesToRead, cursor.offset);
      cursor.offset += bytesRead;
      if (cursor.prefixLength === 0 && stats.size > 0) setFilePrefix(path, stats, cursor);
      this.consume(jid, cursor, buffer.subarray(0, bytesRead));
      return bytesRead;
    } catch (error) {
      this.warnError(`read:${jid}`, jid, error, 'Could not read nested session transcript');
      return 0;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private consume(jid: string, cursor: FileCursor, chunk: Buffer): void {
    const data = cursor.pending.length > 0 ? Buffer.concat([cursor.pending, chunk]) : chunk;
    cursor.pending = Buffer.alloc(0);
    let start = 0;

    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue;
      const line = data.subarray(start, index);
      start = index + 1;
      if (cursor.droppingOversizedLine) {
        cursor.droppingOversizedLine = false;
        continue;
      }
      if (line.length > MAX_LINE_BYTES) {
        this.dependencies.emit(jid, '⚠️ child session record omitted (oversized)');
        continue;
      }
      this.consumeLine(jid, cursor, line);
    }

    const remainder = data.subarray(start);
    if (cursor.droppingOversizedLine) return;
    if (remainder.length > MAX_LINE_BYTES) {
      cursor.droppingOversizedLine = true;
      this.dependencies.emit(jid, '⚠️ child session record omitted (oversized)');
      return;
    }
    cursor.pending = Buffer.from(remainder);
  }

  private consumeLine(jid: string, cursor: FileCursor, line: Buffer): void {
    const text = line.toString('utf8').replace(/\r$/u, '');
    if (!text) return;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      return;
    }
    const formatted = formatNestedSessionTraceRecord(record, { sourceName: cursor.sourceName });
    cursor.sourceName = formatted.sourceName;
    for (const output of formatted.lines) this.dependencies.emit(jid, output);
  }

  private enforceChannelPendingLimit(jid: string, state: ChannelCursor): void {
    let total = [...state.files.values()].reduce((sum, cursor) => sum + cursor.pending.length, 0);
    if (total <= MAX_PENDING_BYTES_PER_CHANNEL) return;
    for (const cursor of [...state.files.values()].sort(
      (a, b) => b.pending.length - a.pending.length,
    )) {
      if (total <= MAX_PENDING_BYTES_PER_CHANNEL) break;
      total -= cursor.pending.length;
      this.dropPendingLine(jid, cursor);
    }
  }

  private enforceGlobalPendingLimit(): void {
    const cursors = [...this.channels.entries()].flatMap(([jid, state]) =>
      [...state.files.values()].map((cursor) => ({ jid, cursor })),
    );
    let total = cursors.reduce((sum, entry) => sum + entry.cursor.pending.length, 0);
    if (total <= MAX_PENDING_BYTES_GLOBAL) return;
    for (const { jid, cursor } of cursors.sort(
      (a, b) => b.cursor.pending.length - a.cursor.pending.length,
    )) {
      if (total <= MAX_PENDING_BYTES_GLOBAL) break;
      total -= cursor.pending.length;
      this.dropPendingLine(jid, cursor);
    }
  }

  private dropPendingLine(jid: string, cursor: FileCursor): void {
    if (cursor.pending.length === 0) return;
    cursor.pending = Buffer.alloc(0);
    cursor.droppingOversizedLine = true;
    this.dependencies.emit(jid, '⚠️ child session record omitted (buffer limit)');
  }

  private warnError(key: string, jid: string | undefined, error: unknown, message: string): void {
    const errorName =
      typeof error === 'object' && error !== null && error instanceof Error
        ? error.constructor.name.slice(0, 100)
        : typeof error;
    this.warnThrottled(key, { ...(jid ? { jid } : {}), errorName }, message);
  }

  private warnThrottled(key: string, metadata: Record<string, unknown>, message: string): void {
    const now = this.dependencies.now?.() ?? Date.now();
    const previous = this.lastWarnings.get(key) ?? 0;
    if (now - previous < LOG_THROTTLE_MS) return;
    this.lastWarnings.set(key, now);
    this.dependencies.warn?.(metadata, message);
  }
}

function discoverNestedJsonl(root: string): DiscoveredFiles {
  const rootPath = resolve(root);
  let rootStats: Stats;
  try {
    rootStats = lstatSync(rootPath);
  } catch (error) {
    if (isMissingPathError(error)) return { paths: [], truncated: false };
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
    return { paths: [], truncated: false };

  const paths: string[] = [];
  const directories: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
  let entriesSeen = 0;
  let truncated = false;

  while (directories.length > 0 && paths.length < MAX_FILES_PER_CHANNEL) {
    const current = directories.shift()!;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      entriesSeen += 1;
      if (entriesSeen > MAX_DISCOVERY_ENTRIES) {
        truncated = true;
        break;
      }
      const candidate = resolve(current.path, entry.name);
      if (!isWithin(rootPath, candidate) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && current.depth < MAX_DIRECTORY_DEPTH) {
        directories.push({ path: candidate, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      // A top-level session JSONL has no directory component relative to the
      // channel root and is already represented by Pi RPC events.
      if (dirname(relative(rootPath, candidate)) === '.') continue;
      paths.push(candidate);
      if (paths.length >= MAX_FILES_PER_CHANNEL) {
        truncated = true;
        break;
      }
    }
    if (entriesSeen > MAX_DISCOVERY_ENTRIES) break;
  }
  return { paths: paths.sort(), truncated };
}

function safeRegularFileStats(path: string): Stats | undefined {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink() ? stats : undefined;
  } catch {
    return undefined;
  }
}

function newCursor(path: string, stats: Stats, offset: number): FileCursor {
  const cursor: FileCursor = {
    identity: fileIdentity(stats),
    prefix: '',
    prefixLength: 0,
    offset,
    pending: Buffer.alloc(0),
    droppingOversizedLine: false,
  };
  setFilePrefix(path, stats, cursor);
  return cursor;
}

function setFilePrefix(path: string, stats: Stats, cursor: FileCursor): void {
  const length = Math.min(stats.size, FILE_IDENTITY_PREFIX_BYTES);
  try {
    cursor.prefixLength = length;
    cursor.prefix = length > 0 ? readFileSlice(path, length).toString('base64') : '';
  } catch {
    cursor.prefixLength = 0;
    cursor.prefix = '';
  }
}

function filePrefixMatches(path: string, cursor: FileCursor): boolean {
  if (cursor.prefixLength === 0) return true;
  try {
    return readFileSlice(path, cursor.prefixLength).toString('base64') === cursor.prefix;
  } catch {
    return false;
  }
}

function readFileSlice(path: string, bytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fileIdentity(stats: Stats): string {
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function readBaselineSourceName(path: string, bytes: number): string | undefined {
  if (bytes <= 0) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    for (const line of buffer.subarray(0, read).toString('utf8').split(/\r?\n/u)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as { type?: unknown; name?: unknown };
        if (record.type === 'session_info' && typeof record.name === 'string') {
          return formatNestedSessionTraceRecord(record).sourceName;
        }
      } catch {
        // A partial baseline line is expected when the bounded read ends.
      }
    }
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return undefined;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function isWithin(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

function rotate<T>(values: readonly T[], start: number): T[] {
  if (values.length === 0) return [];
  const index = start % values.length;
  return [...values.slice(index), ...values.slice(0, index)];
}

function defaultSources(): NestedSessionSource[] {
  return getAllChannels().flatMap((channel) => {
    const webhook = getChannelWebhook(channel.jid);
    if (!webhook) return [];
    const sessionsRoot = resolve(config.sessionsDir);
    const root = resolve(sessionsRoot, channel.folder);
    return isWithin(sessionsRoot, root)
      ? [
          {
            jid: channel.jid,
            root,
            // Keep credentials out of logs, but include the complete route in
            // the in-memory epoch so clear+re-enable between polls baselines.
            epoch: [webhook.destination_channel_id, webhook.webhook_id, webhook.webhook_token].join(
              ':',
            ),
          },
        ]
      : [];
  });
}

let defaultMonitor: NestedSessionTraceMonitor | undefined;

export function startNestedSessionMonitor(): void {
  if (defaultMonitor) return;
  defaultMonitor = new NestedSessionTraceMonitor({
    listSources: defaultSources,
    emit: enqueueWebhookTrace,
    warn: (metadata, message) => logger.warn(metadata, message),
  });
  defaultMonitor.start();
}

export function stopNestedSessionMonitor(): Promise<void> {
  defaultMonitor?.stop();
  defaultMonitor = undefined;
  return Promise.resolve();
}
