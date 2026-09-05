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
import {
  formatNestedSessionTraceRecord,
  MAX_NESTED_TRACE_LINES_PER_RECORD,
} from '../agent/trace.js';
import { config } from '../config.js';
import { getMonitoredChannelRoutes } from '../db.js';
import { logger } from '../logger.js';
import { enqueueWebhookTraceForEpoch, webhookEpoch } from '../discord/webhook-monitor.js';

const POLL_INTERVAL_MS = 1000;
const MAX_CHANNELS = 256;
const MAX_FILES_PER_CHANNEL = 512;
const MAX_CHANNELS_VISITED_PER_POLL = 16;
const MAX_DISCOVERY_ENTRIES_PER_POLL = 4096;
const MAX_DISCOVERY_ENTRIES_PER_CHANNEL_POLL = 512;
const MAX_DIRECTORY_OPENS_PER_POLL = 512;
const MAX_DIRECTORY_OPENS_PER_CHANNEL_POLL = 64;
const MAX_FILE_OPENS_PER_POLL = 1024;
const MAX_FILE_ADMISSIONS_PER_CHANNEL_POLL = 128;
const MAX_FILE_READS_PER_CHANNEL_POLL = 128;
const MAX_DISCOVERY_DIRECTORIES = 4096;
const MAX_DIRECTORY_DEPTH = 12;
const MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
const MAX_BYTES_PER_CHANNEL_POLL = 1024 * 1024;
const MAX_BYTES_PER_FILE_POLL = 256 * 1024;
const MAX_LINES_PER_POLL = 2048;
const MAX_LINES_PER_CHANNEL_POLL = 256;
const MAX_EMITTED_LINES_PER_POLL = 512;
const MAX_EMITTED_LINES_PER_CHANNEL_POLL = 64;
const MAX_FORMATTED_LINES_PER_RECORD = MAX_NESTED_TRACE_LINES_PER_RECORD;
// Session records can contain large encrypted reasoning signatures even when
// the displayable assistant text is short. Keep enough room to parse and then
// discard those fields, while retaining explicit global/per-channel bounds.
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES_PER_CHANNEL = 4 * 1024 * 1024;
const MAX_PENDING_BYTES_GLOBAL = 16 * 1024 * 1024;
const CONTINUITY_BYTES = 128;
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
  /** Deterministic security-test seams; production never supplies them. */
  beforeRootOpen?(path: string): void;
  beforeFileOpen?(path: string): void;
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
  /** Whether records without timestamps are known to belong to this activation. */
  baselineComplete: boolean;
  /** Filter pre-activation timestamps only until the file's initial EOF. */
  initialScan: boolean;
  activationCutoffMs: number;
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
  activatedAtMs: number;
  rootIdentity?: string;
  rootMissingAtActivation: boolean;
  initialDiscoveryComplete: boolean;
  files: Map<string, FileCursor>;
  unavailableFiles: Set<string>;
  nextFileIndex: number;
  discovery: DiscoveryCursor;
}

interface PollBudget {
  channels: number;
  discoveryEntries: number;
  directoryOpens: number;
  fileOpens: number;
  bytes: number;
  lines: number;
  emittedLines: number;
  channelLines: number;
  channelEmittedLines: number;
}

export interface NestedSessionPollUsage {
  channels: number;
  discoveryEntries: number;
  directoryOpens: number;
  fileOpens: number;
  bytes: number;
  lines: number;
  emittedLines: number;
}

interface OpenedFile {
  kind: 'opened';
  descriptor: number;
  stats: Stats;
}

interface OpenedDirectory {
  kind: 'opened';
  dir: Dir;
}

type OpenFileResult = OpenedFile | { kind: 'missing' } | { kind: 'unavailable' };
type OpenDirectoryResult = OpenedDirectory | { kind: 'missing' } | { kind: 'unavailable' };

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
  private nextChannelIndex = 0;
  private lastUsage: NestedSessionPollUsage = emptyPollUsage();

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
        this.channels.set(source.jid, newChannelCursor(source, this.now()));
      }
      if (sources.length > MAX_CHANNELS) {
        this.warnThrottled(
          'channel-limit',
          { channels: sources.length, admitted: this.channels.size },
          'Nested session monitor active-route admission limit reached',
        );
      }

      const budget = newPollBudget();
      const admitted = [...this.channels.entries()];
      const ordered = rotate(admitted, this.nextChannelIndex);
      let visited = 0;
      for (const [jid, state] of ordered) {
        if (budget.channels <= 0) break;
        budget.channels -= 1;
        budget.channelLines = MAX_LINES_PER_CHANNEL_POLL;
        budget.channelEmittedLines = MAX_EMITTED_LINES_PER_CHANNEL_POLL;
        visited += 1;
        this.pollSource(jid, state, budget);
        this.enforceGlobalPendingLimit();
      }
      if (admitted.length > 0) {
        this.nextChannelIndex = (this.nextChannelIndex + Math.max(1, visited)) % admitted.length;
      } else {
        this.nextChannelIndex = 0;
      }
      this.lastUsage = pollUsage(budget);
    } finally {
      this.polling = false;
    }
  }

  lastPollUsage(): NestedSessionPollUsage {
    return { ...this.lastUsage };
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
    state.activatedAtMs = this.now();
    state.rootIdentity = undefined;
    state.rootMissingAtActivation = pathIsMissing(source.root);
    state.initialDiscoveryComplete = false;
    state.files = new Map();
    state.unavailableFiles = new Set();
    state.nextFileIndex = 0;
    state.discovery = newDiscoveryCursor();
  }

  private pollSource(jid: string, state: ChannelCursor, budget: PollBudget): void {
    try {
      this.dependencies.beforeRootOpen?.(state.source.root);
    } catch (error) {
      this.warnError(`root:${jid}`, jid, error, 'Could not inspect nested session root');
      return;
    }
    const root = validateRoot(state.source);
    if (!root) return;
    const rootIdentity = fileIdentity(root.stats);
    if (state.rootIdentity && state.rootIdentity !== rootIdentity) {
      this.resetChannel(state, state.source);
    }
    state.rootIdentity = rootIdentity;
    if (!state.initialDiscoveryComplete && state.rootMissingAtActivation) {
      // ENOENT/ENOTDIR at activation proves the complete root appeared later,
      // so every transcript in its first successful scan is live.
      state.initialDiscoveryComplete = true;
    }

    this.advanceDiscovery(jid, state, root.canonicalPath, budget);
    this.readFiles(jid, state, root.canonicalPath, budget);
  }

  private advanceDiscovery(
    jid: string,
    state: ChannelCursor,
    canonicalRoot: string,
    budget: PollBudget,
  ): void {
    let channelEntries = MAX_DISCOVERY_ENTRIES_PER_CHANNEL_POLL;
    let channelDirectories = MAX_DIRECTORY_OPENS_PER_CHANNEL_POLL;
    let channelFiles = MAX_FILE_ADMISSIONS_PER_CHANNEL_POLL;

    for (const relativePath of [...state.unavailableFiles]) {
      if (budget.fileOpens <= 0 || channelFiles <= 0) break;
      budget.fileOpens -= 1;
      channelFiles -= 1;
      const admitted = this.admitFile(state, canonicalRoot, relativePath);
      if (admitted !== 'unavailable') state.unavailableFiles.delete(relativePath);
    }

    while (budget.discoveryEntries > 0 && channelEntries > 0) {
      if (!state.discovery.current) {
        const work = state.discovery.queue.shift();
        if (!work) {
          if (state.unavailableFiles.size === 0) state.initialDiscoveryComplete = true;
          state.discovery = newDiscoveryCursor();
          break;
        }
        state.discovery.queued.delete(work.relativePath);
        if (budget.directoryOpens <= 0 || channelDirectories <= 0) {
          state.discovery.queue.unshift(work);
          state.discovery.queued.add(work.relativePath);
          break;
        }
        budget.directoryOpens -= 1;
        channelDirectories -= 1;
        const opened = this.openVerifiedDirectory(state.source, canonicalRoot, work.relativePath);
        if (opened.kind === 'missing') continue;
        if (opened.kind === 'unavailable') {
          // Transient failures remain queued. Moving the failed directory to
          // the tail lets other admitted work progress without declaring a
          // false empty baseline.
          state.discovery.queue.push(work);
          state.discovery.queued.add(work.relativePath);
          break;
        }
        state.discovery.current = { ...work, dir: opened.dir };
      }

      const current = state.discovery.current;
      let entry;
      try {
        entry = current.dir.readSync();
      } catch (error) {
        this.warnError(`discover:${jid}`, jid, error, 'Could not scan nested session transcripts');
        closeDirectory(current.dir);
        state.discovery.current = undefined;
        state.discovery.queue.unshift({
          relativePath: current.relativePath,
          depth: current.depth,
        });
        state.discovery.queued.add(current.relativePath);
        break;
      }
      if (!entry) {
        closeDirectory(current.dir);
        state.discovery.current = undefined;
        continue;
      }
      budget.discoveryEntries -= 1;
      channelEntries -= 1;
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
      if (state.files.size + state.unavailableFiles.size >= MAX_FILES_PER_CHANNEL) {
        this.warnThrottled(
          `file-limit:${jid}`,
          { jid },
          'Nested session transcript cursor admission limit reached',
        );
        continue;
      }
      if (budget.fileOpens <= 0 || channelFiles <= 0) break;
      budget.fileOpens -= 1;
      channelFiles -= 1;
      const admitted = this.admitFile(state, canonicalRoot, relativePath);
      if (admitted === 'unavailable') state.unavailableFiles.add(relativePath);
    }
  }

  private admitFile(
    state: ChannelCursor,
    canonicalRoot: string,
    relativePath: string,
  ): OpenFileResult['kind'] {
    const opened = this.openVerifiedFile(state.source, canonicalRoot, relativePath);
    if (opened.kind !== 'opened') return opened.kind;
    try {
      const createdAfterActivation =
        state.initialDiscoveryComplete ||
        (opened.stats.birthtimeMs > 0 && opened.stats.birthtimeMs > state.activatedAtMs + 1);
      // Old files are read incrementally from zero and filtered by record time.
      // This captures appends made while a long initial scan is still running;
      // using discovery-time EOF as a baseline would lose them.
      const cursor = newCursor(
        opened.descriptor,
        opened.stats,
        0,
        state.activatedAtMs,
        createdAfterActivation,
      );
      state.files.set(relativePath, cursor);
    } finally {
      closeSync(opened.descriptor);
    }
    return 'opened';
  }

  private readFiles(
    jid: string,
    state: ChannelCursor,
    canonicalRoot: string,
    budget: PollBudget,
  ): void {
    const paths = [...state.files.keys()];
    if (paths.length === 0) return;
    const ordered = rotate(paths, state.nextFileIndex);
    let channelBytes = MAX_BYTES_PER_CHANNEL_POLL;
    let channelFileReads = MAX_FILE_READS_PER_CHANNEL_POLL;
    let visited = 0;

    for (const relativePath of ordered) {
      if (
        channelBytes <= 0 ||
        budget.bytes <= 0 ||
        budget.lines <= 0 ||
        budget.channelLines <= 0 ||
        budget.emittedLines < MAX_FORMATTED_LINES_PER_RECORD ||
        budget.channelEmittedLines < MAX_FORMATTED_LINES_PER_RECORD ||
        budget.fileOpens <= 0 ||
        channelFileReads <= 0
      )
        break;
      const cursor = state.files.get(relativePath);
      if (!cursor) continue;
      visited += 1;
      budget.fileOpens -= 1;
      channelFileReads -= 1;
      const result = this.readFile(
        state.source,
        canonicalRoot,
        relativePath,
        cursor,
        Math.min(channelBytes, budget.bytes, MAX_BYTES_PER_FILE_POLL),
        budget,
      );
      if (result.missing) state.files.delete(relativePath);
      channelBytes -= result.bytes;
      budget.bytes -= result.bytes;
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
    byteBudget: number,
    budget: PollBudget,
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

      // Parse complete lines retained when the previous poll exhausted its
      // global line/emit budget before reading more bytes.
      if (cursor.pending.length > 0) this.consume(source, cursor, Buffer.alloc(0), budget);
      if (
        budget.lines <= 0 ||
        budget.channelLines <= 0 ||
        budget.emittedLines < MAX_FORMATTED_LINES_PER_RECORD ||
        budget.channelEmittedLines < MAX_FORMATTED_LINES_PER_RECORD ||
        cursor.pending.includes(0x0a)
      ) {
        return { bytes: 0, missing: false };
      }

      const available = Math.max(0, opened.stats.size - cursor.offset);
      const bytesToRead = Math.min(available, byteBudget);
      if (bytesToRead === 0) {
        if (cursor.pending.length === 0 && cursor.offset >= opened.stats.size) {
          finishBaseline(cursor);
        }
        return { bytes: 0, missing: false };
      }

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(opened.descriptor, buffer, 0, bytesToRead, cursor.offset);
      cursor.offset += bytesRead;
      setContinuity(opened.descriptor, cursor);
      this.consume(source, cursor, buffer.subarray(0, bytesRead), budget);
      if (cursor.pending.length === 0 && cursor.offset >= opened.stats.size) {
        finishBaseline(cursor);
      }
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

  private consume(
    source: NormalizedSource,
    cursor: FileCursor,
    chunk: Buffer,
    budget: PollBudget,
  ): void {
    const data = cursor.pending.length > 0 ? Buffer.concat([cursor.pending, chunk]) : chunk;
    cursor.pending = Buffer.alloc(0);
    let start = 0;

    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue;
      if (
        budget.lines <= 0 ||
        budget.channelLines <= 0 ||
        budget.emittedLines < MAX_FORMATTED_LINES_PER_RECORD ||
        budget.channelEmittedLines < MAX_FORMATTED_LINES_PER_RECORD
      ) {
        cursor.pending = Buffer.from(data.subarray(start));
        return;
      }
      const line = data.subarray(start, index);
      start = index + 1;
      budget.lines -= 1;
      budget.channelLines -= 1;
      if (cursor.droppingOversizedLine) {
        cursor.droppingOversizedLine = false;
        continue;
      }
      if (line.length > MAX_LINE_BYTES) {
        this.emitBounded(source, '⚠️ child session record omitted (oversized)', budget);
        continue;
      }
      this.consumeLine(source, cursor, line, budget);
    }

    const remainder = data.subarray(start);
    if (cursor.droppingOversizedLine) return;
    if (remainder.length > MAX_LINE_BYTES) {
      cursor.droppingOversizedLine = true;
      this.emitBounded(source, '⚠️ child session record omitted (oversized)', budget);
      return;
    }
    cursor.pending = Buffer.from(remainder);
  }

  private consumeLine(
    source: NormalizedSource,
    cursor: FileCursor,
    line: Buffer,
    budget: PollBudget,
  ): void {
    const text = line.toString('utf8').replace(/\r$/u, '');
    if (!text) return;
    let record: any;
    try {
      record = JSON.parse(text);
    } catch {
      return;
    }
    const formatted = formatNestedSessionTraceRecord(record, { sourceName: cursor.sourceName });
    cursor.sourceName = formatted.sourceName;
    if (!shouldEmitRecord(cursor, record)) return;
    for (const output of formatted.lines.slice(0, MAX_FORMATTED_LINES_PER_RECORD)) {
      this.emitBounded(source, output, budget);
    }
  }

  private emitBounded(source: NormalizedSource, line: string, budget: PollBudget): void {
    if (budget.emittedLines <= 0 || budget.channelEmittedLines <= 0) return;
    budget.emittedLines -= 1;
    budget.channelEmittedLines -= 1;
    this.dependencies.emit(source, line);
  }

  private openVerifiedDirectory(
    source: NormalizedSource,
    canonicalRoot: string,
    relativePath: string,
  ): OpenDirectoryResult {
    const candidate = resolve(canonicalRoot, relativePath);
    if (!isWithinOrEqual(canonicalRoot, candidate)) return { kind: 'unavailable' };
    const before = verifiedCanonicalStats(source, canonicalRoot, candidate, true);
    if (!before) {
      return pathIsMissing(candidate) ? { kind: 'missing' } : { kind: 'unavailable' };
    }
    let dir: Dir | undefined;
    try {
      this.dependencies.beforeDirectoryOpen?.(candidate);
      dir = opendirSync(candidate);
      const after = verifiedCanonicalStats(source, canonicalRoot, candidate, true);
      if (!after || fileIdentity(after.stats) !== fileIdentity(before.stats)) {
        closeDirectory(dir);
        return pathIsMissing(candidate) ? { kind: 'missing' } : { kind: 'unavailable' };
      }
      return { kind: 'opened', dir };
    } catch (error) {
      if (dir) closeDirectory(dir);
      return isMissingPathError(error) ? { kind: 'missing' } : { kind: 'unavailable' };
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

    let descriptor: number | undefined;
    try {
      this.dependencies.beforeFileOpen?.(candidate);
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
    this.warnThrottled(
      `buffer-limit:${source.jid}`,
      { jid: source.jid },
      'Nested session record omitted after monitor buffer limit',
    );
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private warnError(key: string, jid: string | undefined, error: unknown, message: string): void {
    const errorName =
      typeof error === 'object' && error !== null && error instanceof Error
        ? error.constructor.name.slice(0, 100)
        : typeof error;
    this.warnThrottled(key, { ...(jid ? { jid } : {}), errorName }, message);
  }

  private warnThrottled(key: string, metadata: Record<string, unknown>, message: string): void {
    const now = this.now();
    const previous = this.lastWarnings.get(key) ?? 0;
    if (now - previous < LOG_THROTTLE_MS) return;
    this.lastWarnings.set(key, now);
    this.dependencies.warn?.(metadata, message);
  }
}

function emptyPollUsage(): NestedSessionPollUsage {
  return {
    channels: 0,
    discoveryEntries: 0,
    directoryOpens: 0,
    fileOpens: 0,
    bytes: 0,
    lines: 0,
    emittedLines: 0,
  };
}

function pollUsage(remaining: PollBudget): NestedSessionPollUsage {
  return {
    channels: MAX_CHANNELS_VISITED_PER_POLL - remaining.channels,
    discoveryEntries: MAX_DISCOVERY_ENTRIES_PER_POLL - remaining.discoveryEntries,
    directoryOpens: MAX_DIRECTORY_OPENS_PER_POLL - remaining.directoryOpens,
    fileOpens: MAX_FILE_OPENS_PER_POLL - remaining.fileOpens,
    bytes: MAX_BYTES_PER_POLL - remaining.bytes,
    lines: MAX_LINES_PER_POLL - remaining.lines,
    emittedLines: MAX_EMITTED_LINES_PER_POLL - remaining.emittedLines,
  };
}

function newPollBudget(): PollBudget {
  return {
    channels: MAX_CHANNELS_VISITED_PER_POLL,
    discoveryEntries: MAX_DISCOVERY_ENTRIES_PER_POLL,
    directoryOpens: MAX_DIRECTORY_OPENS_PER_POLL,
    fileOpens: MAX_FILE_OPENS_PER_POLL,
    bytes: MAX_BYTES_PER_POLL,
    lines: MAX_LINES_PER_POLL,
    emittedLines: MAX_EMITTED_LINES_PER_POLL,
    channelLines: MAX_LINES_PER_CHANNEL_POLL,
    channelEmittedLines: MAX_EMITTED_LINES_PER_CHANNEL_POLL,
  };
}

function newChannelCursor(source: NormalizedSource, activatedAtMs: number): ChannelCursor {
  return {
    source,
    activatedAtMs,
    rootMissingAtActivation: pathIsMissing(source.root),
    initialDiscoveryComplete: false,
    files: new Map(),
    unavailableFiles: new Set(),
    nextFileIndex: 0,
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
  state.unavailableFiles.clear();
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

function pathIsMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return isMissingPathError(error);
  }
}

function newCursor(
  descriptor: number,
  stats: Stats,
  offset: number,
  activationCutoffMs: number,
  baselineComplete: boolean,
): FileCursor {
  const cursor: FileCursor = {
    identity: fileIdentity(stats),
    offset,
    continuity: Buffer.alloc(0),
    pending: Buffer.alloc(0),
    droppingOversizedLine: false,
    baselineComplete,
    initialScan: true,
    activationCutoffMs,
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
  // Match tail -F behavior after a detected truncation or replacement: all
  // content in the rewritten file is live, regardless of its record timestamps.
  cursor.baselineComplete = true;
  cursor.initialScan = false;
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

function finishBaseline(cursor: FileCursor): void {
  cursor.baselineComplete = true;
  cursor.initialScan = false;
}

function shouldEmitRecord(cursor: FileCursor, record: any): boolean {
  // Byte offsets establish exactly-once ordering after the initial scan.
  // During a delayed initial read, suppress only timestamps known to predate
  // the activation boundary; timestamps may legitimately repeat or go back.
  if (!cursor.initialScan) return true;
  const timestamp = recordTimestampMs(record);
  if (timestamp === undefined) return cursor.baselineComplete;
  return timestamp > cursor.activationCutoffMs;
}

function recordTimestampMs(record: any): number | undefined {
  const raw = record?.timestamp ?? record?.ts ?? record?.message?.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || !raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  // Fetch one extra row to make admission overflow observable without ever
  // materializing all inactive channels or issuing per-channel webhook reads.
  return getMonitoredChannelRoutes(MAX_CHANNELS + 1).flatMap((route) => {
    const root = resolve(sessionsRoot, route.folder);
    return isWithinOrEqual(sessionsRoot, root)
      ? [
          {
            jid: route.channel_jid,
            root,
            boundary: sessionsRoot,
            // Keep credentials out of logs, but include the complete route in
            // the in-memory epoch so clear+re-enable between polls baselines.
            epoch: webhookEpoch(route),
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
