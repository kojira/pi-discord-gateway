import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type Dir,
  type Stats,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { formatNestedSessionTraceRecord } from '../agent/trace.js';
import { config } from '../config.js';
import { getAllChannels, getChannelWebhook } from '../db.js';
import { logger } from '../logger.js';
import { enqueueWebhookTraceForEpoch, webhookEpoch } from '../discord/webhook-monitor.js';

const POLL_INTERVAL_MS = 1000;
const MAX_CHANNELS = 256;
const MAX_FILES_PER_CHANNEL = 512;
const MAX_DISCOVERY_ENTRIES_PER_POLL = 4096;
const MAX_DISCOVERY_DIRECTORIES = 4096;
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
const CONTINUITY_BYTES = 128;
const MAX_BASELINE_NAME_BYTES_PER_CHANNEL = 256 * 1024;
const LOG_THROTTLE_MS = 60_000;

export interface NestedSessionSource {
  jid: string;
  root: string;
  /** Canonical containment boundary. Defaults to the source root in tests. */
  boundary?: string;
  /** Changes whenever a webhook is cleared, recreated, or replaced. */
  epoch?: string;
}

export interface NestedSessionMonitorDependencies {
  listSources(): NestedSessionSource[];
  emit(source: NestedSessionSource, line: string): void;
  warn?(metadata: Record<string, unknown>, message: string): void;
  now?(): number;
  /** Deterministic security-test seam; production never supplies it. */
  beforeFileOpen?(path: string): void;
  /** Deterministic security-test seam; production never supplies it. */
  beforeDirectoryOpen?(path: string): void;
}

interface NormalizedSource extends NestedSessionSource {
  root: string;
  boundary: string;
}

interface FileCursor {
  identity: string;
  offset: number;
  continuity: Buffer;
  pending: Buffer;
  droppingOversizedLine: boolean;
  sourceName?: string;
}

interface DirectoryWork {
  relativePath: string;
  depth: number;
}

interface OpenDirectoryWork extends DirectoryWork {
  dir: Dir;
}

interface DiscoveryCursor {
  queue: DirectoryWork[];
  queued: Set<string>;
  current?: OpenDirectoryWork;
}

interface ChannelCursor {
  source: NormalizedSource;
  rootIdentity?: string;
  initialized: boolean;
  files: Map<string, FileCursor>;
  nextFileIndex: number;
  baselineNameBudget: number;
  discovery: DiscoveryCursor;
}

interface OpenedFile {
  kind: 'opened';
  descriptor: number;
  stats: Stats;
}

type OpenFileResult = OpenedFile | { kind: 'missing' | 'unavailable' };

/**
 * Poll append-only nested Pi session transcripts for child-agent activity.
 * Top-level `<channel>/<session>.jsonl` files are deliberately excluded because
 * the active Pi RPC stream already reports those records.
 *
 * Resource policy is admission-bounded: at most MAX_CHANNELS active webhook
 * routes and MAX_FILES_PER_CHANNEL child transcripts retain cursors. Existing
 * admissions are stable until the route/file disappears, so overload cannot
 * cause replay. Directory iteration is incremental and bounded per poll.
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
    for (const state of this.channels.values()) disposeChannel(state);
    this.channels.clear();
    this.lastWarnings.clear();
  }

  pollOnce(): void {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const sources = this.safeSources();
      const activeJids = new Set(sources.map((source) => source.jid));
      for (const [jid, state] of this.channels) {
        if (!activeJids.has(jid)) {
          disposeChannel(state);
          this.channels.delete(jid);
        }
      }

      // Preserve admitted states and admit new routes only while capacity is
      // available. This is intentionally stable rather than lexical paging:
      // paging without cursor state would replay or leak disabled-period data.
      for (const source of sources) {
        const current = this.channels.get(source.jid);
        if (current) {
          if (!sameSource(current.source, source)) this.resetChannel(current, source);
          continue;
        }
        if (this.channels.size >= MAX_CHANNELS) continue;
        this.channels.set(source.jid, newChannelCursor(source));
      }
      if (sources.length > MAX_CHANNELS) {
        this.warnThrottled(
          'channel-limit',
          { channels: sources.length, admitted: this.channels.size },
          'Nested session monitor active-route admission limit reached',
        );
      }

      for (const [jid, state] of this.channels) {
        this.pollSource(jid, state);
        this.enforceGlobalPendingLimit();
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

  private safeSources(): NormalizedSource[] {
    try {
      const unique = new Map<string, NormalizedSource>();
      for (const source of this.dependencies.listSources()) {
        if (!source?.jid || !source.root || unique.has(source.jid)) continue;
        const root = resolve(source.root);
        const boundary = resolve(source.boundary ?? source.root);
        if (!isWithinOrEqual(boundary, root)) {
          this.warnThrottled(
            `source-boundary:${source.jid}`,
            { jid: source.jid },
            'Nested session source is outside its configured boundary',
          );
          continue;
        }
        unique.set(source.jid, { ...source, root, boundary });
      }
      return [...unique.values()].sort((a, b) => a.jid.localeCompare(b.jid));
    } catch (error) {
      this.warnError('sources', undefined, error, 'Could not list nested session monitor sources');
      return [];
    }
  }

  private resetChannel(state: ChannelCursor, source: NormalizedSource): void {
    disposeChannel(state);
    state.source = source;
    state.rootIdentity = undefined;
    state.initialized = false;
    state.files = new Map();
    state.nextFileIndex = 0;
    state.baselineNameBudget = MAX_BASELINE_NAME_BYTES_PER_CHANNEL;
    state.discovery = newDiscoveryCursor();
  }

  private pollSource(jid: string, state: ChannelCursor): void {
    const root = validateRoot(state.source);
    if (!root) {
      // A missing root is a complete empty baseline. If it appears later, its
      // newly created child files are read from byte zero.
      if (!pathExists(state.source.root)) state.initialized = true;
      return;
    }
    const rootIdentity = fileIdentity(root.stats);
    if (state.rootIdentity && state.rootIdentity !== rootIdentity) {
      this.resetChannel(state, state.source);
    }
    state.rootIdentity = rootIdentity;

    const cycleComplete = this.advanceDiscovery(jid, state, root.canonicalPath);
    if (!state.initialized) {
      if (cycleComplete) state.initialized = true;
      return;
    }
    this.readFiles(jid, state, root.canonicalPath);
  }

  private advanceDiscovery(jid: string, state: ChannelCursor, canonicalRoot: string): boolean {
    let entries = 0;
    let completedCycle = false;

    while (entries < MAX_DISCOVERY_ENTRIES_PER_POLL) {
      if (!state.discovery.current) {
        const work = state.discovery.queue.shift();
        if (!work) {
          completedCycle = true;
          state.discovery = newDiscoveryCursor();
          break;
        }
        state.discovery.queued.delete(work.relativePath);
        const dir = this.openVerifiedDirectory(state.source, canonicalRoot, work.relativePath);
        if (!dir) continue;
        state.discovery.current = { ...work, dir };
      }

      const current = state.discovery.current;
      let entry;
      try {
        entry = current.dir.readSync();
      } catch (error) {
        this.warnError(`discover:${jid}`, jid, error, 'Could not scan nested session transcripts');
        closeDirectory(current.dir);
        state.discovery.current = undefined;
        continue;
      }
      if (!entry) {
        closeDirectory(current.dir);
        state.discovery.current = undefined;
        continue;
      }
      entries += 1;
      if (entry.isSymbolicLink()) continue;

      const relativePath = join(current.relativePath, entry.name);
      if (entry.isDirectory() && current.depth < MAX_DIRECTORY_DEPTH) {
        if (
          state.discovery.queue.length < MAX_DISCOVERY_DIRECTORIES &&
          !state.discovery.queued.has(relativePath)
        ) {
          state.discovery.queue.push({ relativePath, depth: current.depth + 1 });
          state.discovery.queued.add(relativePath);
        } else if (state.discovery.queue.length >= MAX_DISCOVERY_DIRECTORIES) {
          this.warnThrottled(
            `directory-limit:${jid}`,
            { jid },
            'Nested session transcript directory admission limit reached',
          );
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (dirname(relativePath) === '.') continue;
      if (state.files.has(relativePath)) continue;
      if (state.files.size >= MAX_FILES_PER_CHANNEL) {
        this.warnThrottled(
          `file-limit:${jid}`,
          { jid },
          'Nested session transcript cursor admission limit reached',
        );
        continue;
      }
      this.admitFile(state, canonicalRoot, relativePath);
    }
    return completedCycle;
  }

  private admitFile(state: ChannelCursor, canonicalRoot: string, relativePath: string): void {
    const opened = this.openVerifiedFile(state.source, canonicalRoot, relativePath);
    if (opened.kind !== 'opened') return;
    try {
      const offset = state.initialized ? 0 : opened.stats.size;
      const cursor = newCursor(opened.descriptor, opened.stats, offset);
      if (!state.initialized && state.baselineNameBudget > 0) {
        const readLimit = Math.min(
          BASELINE_NAME_BYTES,
          state.baselineNameBudget,
          opened.stats.size,
        );
        cursor.sourceName = readBaselineSourceName(opened.descriptor, readLimit);
        state.baselineNameBudget -= readLimit;
      }
      state.files.set(relativePath, cursor);
    } finally {
      closeSync(opened.descriptor);
    }
  }

  private readFiles(jid: string, state: ChannelCursor, canonicalRoot: string): void {
    const paths = [...state.files.keys()];
    if (paths.length === 0) return;
    const ordered = rotate(paths, state.nextFileIndex);
    let channelBudget = MAX_BYTES_PER_CHANNEL_POLL;
    let visited = 0;

    for (const relativePath of ordered) {
      if (channelBudget <= 0) break;
      const cursor = state.files.get(relativePath);
      if (!cursor) continue;
      visited += 1;
      const result = this.readFile(
        state.source,
        canonicalRoot,
        relativePath,
        cursor,
        Math.min(channelBudget, MAX_BYTES_PER_FILE_POLL),
      );
      if (result.missing) state.files.delete(relativePath);
      channelBudget -= result.bytes;
      this.enforceChannelPendingLimit(jid, state);
    }
    const divisor = Math.max(1, paths.length);
    state.nextFileIndex = (state.nextFileIndex + Math.max(1, visited)) % divisor;
  }

  private readFile(
    source: NormalizedSource,
    canonicalRoot: string,
    relativePath: string,
    cursor: FileCursor,
    budget: number,
  ): { bytes: number; missing: boolean } {
    const opened = this.openVerifiedFile(source, canonicalRoot, relativePath);
    if (opened.kind !== 'opened') {
      return { bytes: 0, missing: opened.kind === 'missing' };
    }
    try {
      const identity = fileIdentity(opened.stats);
      const continuityMatches = fileContinuityMatches(opened.descriptor, cursor);
      if (identity !== cursor.identity || opened.stats.size < cursor.offset || !continuityMatches) {
        resetCursor(opened.descriptor, opened.stats, cursor);
      }
      const available = Math.max(0, opened.stats.size - cursor.offset);
      const bytesToRead = Math.min(available, budget);
      if (bytesToRead === 0) return { bytes: 0, missing: false };

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(opened.descriptor, buffer, 0, bytesToRead, cursor.offset);
      cursor.offset += bytesRead;
      setContinuity(opened.descriptor, cursor);
      this.consume(source, cursor, buffer.subarray(0, bytesRead));
      return { bytes: bytesRead, missing: false };
    } catch (error) {
      this.warnError(
        `read:${source.jid}`,
        source.jid,
        error,
        'Could not read nested session transcript',
      );
      return { bytes: 0, missing: false };
    } finally {
      closeSync(opened.descriptor);
    }
  }

  private consume(source: NormalizedSource, cursor: FileCursor, chunk: Buffer): void {
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
        this.dependencies.emit(source, '⚠️ child session record omitted (oversized)');
        continue;
      }
      this.consumeLine(source, cursor, line);
    }

    const remainder = data.subarray(start);
    if (cursor.droppingOversizedLine) return;
    if (remainder.length > MAX_LINE_BYTES) {
      cursor.droppingOversizedLine = true;
      this.dependencies.emit(source, '⚠️ child session record omitted (oversized)');
      return;
    }
    cursor.pending = Buffer.from(remainder);
  }

  private consumeLine(source: NormalizedSource, cursor: FileCursor, line: Buffer): void {
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
    for (const output of formatted.lines) this.dependencies.emit(source, output);
  }

  private openVerifiedDirectory(
    source: NormalizedSource,
    canonicalRoot: string,
    relativePath: string,
  ): Dir | undefined {
    const candidate = resolve(canonicalRoot, relativePath);
    if (!isWithinOrEqual(canonicalRoot, candidate)) return undefined;
    const before = verifiedCanonicalStats(source, canonicalRoot, candidate, true);
    if (!before) return undefined;
    this.dependencies.beforeDirectoryOpen?.(candidate);
    let dir: Dir | undefined;
    try {
      dir = opendirSync(candidate);
      const after = verifiedCanonicalStats(source, canonicalRoot, candidate, true);
      if (!after || fileIdentity(after.stats) !== fileIdentity(before.stats)) {
        closeDirectory(dir);
        return undefined;
      }
      return dir;
    } catch {
      if (dir) closeDirectory(dir);
      return undefined;
    }
  }

  private openVerifiedFile(
    source: NormalizedSource,
    canonicalRoot: string,
    relativePath: string,
  ): OpenFileResult {
    const candidate = resolve(canonicalRoot, relativePath);
    if (!isSafeRelativePath(canonicalRoot, candidate)) return { kind: 'unavailable' };
    const before = verifiedCanonicalStats(source, canonicalRoot, candidate, false);
    if (!before) return pathIsMissing(candidate) ? { kind: 'missing' } : { kind: 'unavailable' };
    this.dependencies.beforeFileOpen?.(candidate);

    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || fileIdentity(stats) !== fileIdentity(before.stats)) {
        closeSync(descriptor);
        return { kind: 'unavailable' };
      }
      // Revalidate the pathname after opening. The read is bound to this file
      // descriptor, while a swapped parent/final path fails identity or
      // canonical containment before any bytes are consumed.
      const after = verifiedCanonicalStats(source, canonicalRoot, candidate, false);
      if (!after || fileIdentity(after.stats) !== fileIdentity(stats)) {
        closeSync(descriptor);
        return { kind: 'unavailable' };
      }
      return { kind: 'opened', descriptor, stats };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      return isMissingPathError(error) ? { kind: 'missing' } : { kind: 'unavailable' };
    }
  }

  private enforceChannelPendingLimit(jid: string, state: ChannelCursor): void {
    let total = [...state.files.values()].reduce((sum, cursor) => sum + cursor.pending.length, 0);
    if (total <= MAX_PENDING_BYTES_PER_CHANNEL) return;
    for (const cursor of [...state.files.values()].sort(
      (a, b) => b.pending.length - a.pending.length,
    )) {
      if (total <= MAX_PENDING_BYTES_PER_CHANNEL) break;
      total -= cursor.pending.length;
      this.dropPendingLine(state.source, cursor);
    }
  }

  private enforceGlobalPendingLimit(): void {
    const cursors = [...this.channels.values()].flatMap((state) =>
      [...state.files.values()].map((cursor) => ({ source: state.source, cursor })),
    );
    let total = cursors.reduce((sum, entry) => sum + entry.cursor.pending.length, 0);
    if (total <= MAX_PENDING_BYTES_GLOBAL) return;
    for (const { source, cursor } of cursors.sort(
      (a, b) => b.cursor.pending.length - a.cursor.pending.length,
    )) {
      if (total <= MAX_PENDING_BYTES_GLOBAL) break;
      total -= cursor.pending.length;
      this.dropPendingLine(source, cursor);
    }
  }

  private dropPendingLine(source: NormalizedSource, cursor: FileCursor): void {
    if (cursor.pending.length === 0) return;
    cursor.pending = Buffer.alloc(0);
    cursor.droppingOversizedLine = true;
    this.dependencies.emit(source, '⚠️ child session record omitted (buffer limit)');
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

function newChannelCursor(source: NormalizedSource): ChannelCursor {
  return {
    source,
    initialized: false,
    files: new Map(),
    nextFileIndex: 0,
    baselineNameBudget: MAX_BASELINE_NAME_BYTES_PER_CHANNEL,
    discovery: newDiscoveryCursor(),
  };
}

function newDiscoveryCursor(): DiscoveryCursor {
  return { queue: [{ relativePath: '', depth: 0 }], queued: new Set(['']) };
}

function disposeChannel(state: ChannelCursor): void {
  if (state.discovery.current) closeDirectory(state.discovery.current.dir);
  state.discovery.current = undefined;
  state.discovery.queue = [];
  state.discovery.queued.clear();
  state.files.clear();
}

function closeDirectory(dir: Dir): void {
  try {
    dir.closeSync();
  } catch {
    // Already closed or invalidated during a concurrent filesystem change.
  }
}

function sameSource(left: NormalizedSource, right: NormalizedSource): boolean {
  return left.root === right.root && left.boundary === right.boundary && left.epoch === right.epoch;
}

function validateRoot(
  source: NormalizedSource,
): { canonicalPath: string; stats: Stats } | undefined {
  const boundary = canonicalDirectory(source.boundary);
  if (!boundary) return undefined;
  if (!hasNoSymlinkComponents(source.boundary, source.root)) return undefined;
  try {
    const canonicalPath = realpathSync.native(source.root);
    const stats = lstatSync(source.root);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      !isWithinOrEqual(boundary, canonicalPath)
    ) {
      return undefined;
    }
    return { canonicalPath, stats };
  } catch {
    return undefined;
  }
}

function verifiedCanonicalStats(
  source: NormalizedSource,
  canonicalRoot: string,
  candidate: string,
  directory: boolean,
): { canonicalPath: string; stats: Stats } | undefined {
  if (!hasNoSymlinkComponents(canonicalRoot, candidate)) return undefined;
  try {
    const canonicalPath = realpathSync.native(candidate);
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) return undefined;
    if (directory ? !stats.isDirectory() : !stats.isFile()) return undefined;
    const boundary = canonicalDirectory(source.boundary);
    if (
      !boundary ||
      !isWithinOrEqual(boundary, canonicalPath) ||
      !isWithinOrEqual(canonicalRoot, canonicalPath)
    ) {
      return undefined;
    }
    return { canonicalPath, stats };
  } catch {
    return undefined;
  }
}

function canonicalDirectory(path: string): string | undefined {
  try {
    const canonical = realpathSync.native(path);
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Reject a symlink in every existing component below the trusted boundary. */
function hasNoSymlinkComponents(boundary: string, candidate: string): boolean {
  if (!isWithinOrEqual(boundary, candidate)) return false;
  const suffix = relative(boundary, candidate);
  let current = boundary;
  for (const component of suffix.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      return isMissingPathError(error);
    }
  }
  return true;
}

function isSafeRelativePath(root: string, candidate: string): boolean {
  return candidate !== root && isWithinOrEqual(root, candidate);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function pathIsMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return isMissingPathError(error);
  }
}

function newCursor(descriptor: number, stats: Stats, offset: number): FileCursor {
  const cursor: FileCursor = {
    identity: fileIdentity(stats),
    offset,
    continuity: Buffer.alloc(0),
    pending: Buffer.alloc(0),
    droppingOversizedLine: false,
  };
  setContinuity(descriptor, cursor);
  return cursor;
}

function resetCursor(descriptor: number, stats: Stats, cursor: FileCursor): void {
  cursor.identity = fileIdentity(stats);
  cursor.offset = 0;
  cursor.continuity = Buffer.alloc(0);
  cursor.pending = Buffer.alloc(0);
  cursor.droppingOversizedLine = false;
  cursor.sourceName = undefined;
  setContinuity(descriptor, cursor);
}

function setContinuity(descriptor: number, cursor: FileCursor): void {
  const length = Math.min(cursor.offset, CONTINUITY_BYTES);
  if (length === 0) {
    cursor.continuity = Buffer.alloc(0);
    return;
  }
  const marker = Buffer.allocUnsafe(length);
  const bytesRead = readSync(descriptor, marker, 0, length, cursor.offset - length);
  cursor.continuity = Buffer.from(marker.subarray(0, bytesRead));
}

function fileContinuityMatches(descriptor: number, cursor: FileCursor): boolean {
  if (cursor.continuity.length === 0) return true;
  if (cursor.offset < cursor.continuity.length) return false;
  const current = Buffer.allocUnsafe(cursor.continuity.length);
  const bytesRead = readSync(
    descriptor,
    current,
    0,
    current.length,
    cursor.offset - current.length,
  );
  return bytesRead === current.length && current.equals(cursor.continuity);
}

function fileIdentity(stats: Stats): string {
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function readBaselineSourceName(descriptor: number, bytes: number): string | undefined {
  if (bytes <= 0) return undefined;
  try {
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

function isWithinOrEqual(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

function rotate<T>(values: readonly T[], start: number): T[] {
  if (values.length === 0) return [];
  const index = start % values.length;
  return [...values.slice(index), ...values.slice(0, index)];
}

function defaultSources(): NestedSessionSource[] {
  const sessionsRoot = resolve(config.sessionsDir);
  return getAllChannels().flatMap((channel) => {
    const webhook = getChannelWebhook(channel.jid);
    if (!webhook) return [];
    const root = resolve(sessionsRoot, channel.folder);
    return isWithinOrEqual(sessionsRoot, root)
      ? [
          {
            jid: channel.jid,
            root,
            boundary: sessionsRoot,
            // Keep credentials out of logs, but include the complete route in
            // the in-memory epoch so clear+re-enable between polls baselines.
            epoch: webhookEpoch(webhook),
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
    emit: (source, line) => enqueueWebhookTraceForEpoch(source.jid, source.epoch, line),
    warn: (metadata, message) => logger.warn(metadata, message),
  });
  defaultMonitor.start();
}

export function stopNestedSessionMonitor(): Promise<void> {
  defaultMonitor?.stop();
  defaultMonitor = undefined;
  return Promise.resolve();
}
