import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NestedSessionTraceMonitor,
  type NestedSessionSource,
} from '../src/session/nested-session-monitor.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'piscord-nested-session-'));
  roots.push(root);
  return root;
}

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function appendRecord(path: string, record: unknown): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function assistant(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      provider: 'openai-codex',
      model: 'gpt-test',
      ...extra,
    },
  };
}

function harness(root: string): {
  monitor: NestedSessionTraceMonitor;
  lines: string[];
  sources: NestedSessionSource[];
  warn: ReturnType<typeof vi.fn>;
} {
  const lines: string[] = [];
  const sources = [{ jid: 'dc:source', root }];
  const warn = vi.fn();
  const monitor = new NestedSessionTraceMonitor({
    listSources: () => sources,
    emit: (_source, line) => lines.push(line),
    warn,
  });
  return { monitor, lines, sources, warn };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('nested session trace monitoring', () => {
  it('baselines existing child history, ignores top-level JSONL, and forwards only later child turns', () => {
    const root = temporaryRoot();
    const topLevel = join(root, 'parent.jsonl');
    const child = join(root, 'parent', 'run-id', 'run-0', 'session.jsonl');
    writeJsonl(topLevel, [assistant('top-level history')]);
    writeJsonl(child, [
      { type: 'session_info', name: 'subagent-reviewer-run-1' },
      assistant('child history'),
    ]);
    const { monitor, lines } = harness(root);

    monitor.pollOnce();
    expect(lines).toEqual([]);

    appendRecord(topLevel, assistant('top-level live duplicate'));
    appendRecord(child, assistant('child live output'));
    monitor.pollOnce();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('child[subagent-reviewer-run-1]');
    expect(lines[0]).toContain('child live output');
    expect(lines.join('\n')).not.toContain('top-level');
    expect(lines.join('\n')).not.toContain('child history');
  });

  it('captures a child created after monitoring starts even when the channel session root was initially absent', () => {
    const parent = temporaryRoot();
    const root = join(parent, 'not-created-yet');
    const { monitor, lines } = harness(root);
    monitor.pollOnce();

    const child = join(root, 'parent', 'fast-child', 'session.jsonl');
    writeJsonl(child, [
      { type: 'session_info', name: 'fast-child' },
      assistant('created and completed between polls'),
    ]);
    monitor.pollOnce();

    expect(lines).toEqual([
      '🧩 child fast-child started',
      expect.stringContaining('created and completed between polls'),
    ]);
  });

  it('reads a fast-completing newly discovered child from byte zero and omits sensitive tool payloads', () => {
    const root = temporaryRoot();
    const { monitor, lines } = harness(root);
    monitor.pollOnce();

    const child = join(root, 'parent', 'forks', 'child.jsonl');
    writeJsonl(child, [
      { type: 'session_info', name: 'subagent-worker' },
      { type: 'message', message: { role: 'user', content: 'implement safely' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          model: 'gpt-test',
          thinkingSignature: `encrypted-signature-secret-${'z'.repeat(300 * 1024)}`,
          content: [
            { type: 'thinking', thinking: 'checking the result' },
            { type: 'text', text: 'completed child output' },
            {
              type: 'toolCall',
              name: 'bash',
              arguments: { authorization: 'Bearer raw-tool-secret' },
            },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'bash',
          content: [{ type: 'text', text: 'raw-result-secret' }],
          details: { token: 'details-secret' },
          isError: false,
        },
      },
    ]);
    monitor.pollOnce();
    monitor.pollOnce();

    expect(lines).toEqual(
      expect.arrayContaining([
        '🧩 child subagent-worker started',
        expect.stringContaining('👤 child[subagent-worker] user: implement safely'),
        expect.stringContaining('💭 checking the result\ncompleted child output'),
        '🛠️ child[subagent-worker] tool bash',
        '🔧 child[subagent-worker] tool-end bash ok',
      ]),
    );
    const output = lines.join('\n');
    expect(output).not.toContain('raw-tool-secret');
    expect(output).not.toContain('raw-result-secret');
    expect(output).not.toContain('details-secret');
    expect(output).not.toContain('encrypted-signature-secret');
  });

  it('buffers partial JSON lines and ignores malformed records', () => {
    const root = temporaryRoot();
    const { monitor, lines } = harness(root);
    monitor.pollOnce();
    const child = join(root, 'parent', 'child', 'session.jsonl');
    mkdirSync(dirname(child), { recursive: true });
    writeFileSync(
      child,
      `${JSON.stringify({ type: 'session_info', name: 'partial-child' })}\nnot-json\n`,
    );
    const record = JSON.stringify(assistant('joined across polls'));
    appendFileSync(child, record.slice(0, 25));

    monitor.pollOnce();
    expect(lines).toEqual(['🧩 child partial-child started']);
    appendFileSync(child, `${record.slice(25)}\n`);
    monitor.pollOnce();

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('joined across polls');
  });

  it('keeps observing child output after the parent RPC would have settled', () => {
    const root = temporaryRoot();
    const { monitor, lines } = harness(root);
    monitor.pollOnce();

    const child = join(root, 'settled-parent', 'async-run', 'run-0', 'session.jsonl');
    writeJsonl(child, [{ type: 'session_info', name: 'async-reviewer' }]);
    monitor.pollOnce();
    lines.length = 0;

    appendRecord(child, assistant('late asynchronous final answer'));
    monitor.pollOnce();
    expect(lines).toEqual([expect.stringContaining('late asynchronous final answer')]);
  });

  it('stops immediately on clear and baselines disabled-period history on re-enable', () => {
    const root = temporaryRoot();
    const { monitor, lines, sources } = harness(root);
    monitor.pollOnce();
    const child = join(root, 'parent', 'forks', 'child.jsonl');
    writeJsonl(child, [{ type: 'session_info', name: 'toggle-child' }, assistant('before clear')]);
    monitor.pollOnce();
    expect(lines.join('\n')).toContain('before clear');

    sources.splice(0);
    monitor.pollOnce();
    appendRecord(child, assistant('while disabled'));
    monitor.pollOnce();

    sources.push({ jid: 'dc:source', root });
    monitor.pollOnce();
    expect(lines.join('\n')).not.toContain('while disabled');
    appendRecord(child, assistant('after re-enable'));
    monitor.pollOnce();
    expect(lines.join('\n')).toContain('after re-enable');
  });

  it('baselines when a webhook is cleared and re-enabled between polling intervals', () => {
    const root = temporaryRoot();
    const { monitor, lines, sources } = harness(root);
    sources[0].epoch = 'webhook-one:token-one';
    monitor.pollOnce();
    const child = join(root, 'parent', 'child', 'session.jsonl');
    writeJsonl(child, [{ type: 'session_info', name: 'epoch-child' }, assistant('first epoch')]);
    monitor.pollOnce();

    // The monitor cannot observe the transient absent row, so the changed
    // durable webhook route is the re-enable boundary.
    appendRecord(child, assistant('between webhook epochs'));
    sources[0].epoch = 'webhook-two:token-two';
    monitor.pollOnce();
    appendRecord(child, assistant('second epoch'));
    monitor.pollOnce();

    expect(lines.join('\n')).toContain('first epoch');
    expect(lines.join('\n')).not.toContain('between webhook epochs');
    expect(lines.join('\n')).toContain('second epoch');
  });

  it('handles truncation, replacement, and deletion without replaying unrelated files', () => {
    const root = temporaryRoot();
    const { monitor, lines } = harness(root);
    monitor.pollOnce();
    const child = join(root, 'parent', 'child', 'session.jsonl');
    writeJsonl(child, [{ type: 'session_info', name: 'rotating-child' }, assistant('first')]);
    monitor.pollOnce();

    truncateSync(child, 0);
    writeJsonl(child, [
      { type: 'session_info', name: 'truncated-child' },
      assistant('after truncate'),
    ]);
    monitor.pollOnce();
    rmSync(child);
    monitor.pollOnce();
    writeJsonl(child, [
      { type: 'session_info', name: 'replacement-child' },
      assistant('after replace'),
    ]);
    monitor.pollOnce();

    expect(lines.join('\n')).toContain('first');
    expect(lines.join('\n')).toContain('after truncate');
    expect(lines.join('\n')).toContain('after replace');
  });

  it('detects same-inode truncate-and-rewrite with an unchanged prefix and larger final size', () => {
    const root = temporaryRoot();
    const { monitor, lines } = harness(root);
    monitor.pollOnce();
    const child = join(root, 'parent', 'child', 'session.jsonl');
    const header = { type: 'session_info', name: `same-prefix-${'h'.repeat(200)}` };
    writeJsonl(child, [header, assistant('original')]);
    monitor.pollOnce();
    lines.length = 0;

    // Keep the first 128+ bytes identical and rewrite the same inode to a size
    // greater than the previous offset. Prefix-only checks miss this case.
    truncateSync(child, 0);
    writeJsonl(child, [
      header,
      assistant('rewritten-before-old-offset'),
      assistant('x'.repeat(800)),
    ]);
    monitor.pollOnce();

    const output = lines.join('\n');
    expect(output).toContain('rewritten-before-old-offset');
    expect(output).toContain('x'.repeat(100));
    expect(output).not.toContain('original');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects intermediate directory symlinks outside the configured boundary',
    () => {
      const boundary = temporaryRoot();
      const outside = temporaryRoot();
      const outsideChannel = join(outside, 'channel');
      const outsideChild = join(outsideChannel, 'parent', 'child', 'session.jsonl');
      writeJsonl(outsideChild, [assistant('ancestor symlink escape')]);
      symlinkSync(outside, join(boundary, 'alias'));

      const lines: string[] = [];
      const monitor = new NestedSessionTraceMonitor({
        listSources: () => [
          { jid: 'dc:source', root: join(boundary, 'alias', 'channel'), boundary },
        ],
        emit: (_source, line) => lines.push(line),
      });
      monitor.pollOnce();
      monitor.pollOnce();

      expect(lines.join('\n')).not.toContain('ancestor symlink escape');
      expect(monitor.stats().files).toBe(0);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects file and directory swaps between validation and open',
    () => {
      const boundary = temporaryRoot();
      const root = join(boundary, 'channel');
      const outside = temporaryRoot();
      const childDirectory = join(root, 'parent', 'child');
      const child = join(childDirectory, 'session.jsonl');
      const outsideFile = join(outside, 'outside.jsonl');
      writeJsonl(child, [assistant('safe history')]);
      writeJsonl(outsideFile, [assistant('file swap escape')]);

      let swapFile = false;
      let swappedFile = false;
      const lines: string[] = [];
      const monitor = new NestedSessionTraceMonitor({
        listSources: () => [{ jid: 'dc:source', root, boundary }],
        emit: (_source, line) => lines.push(line),
        beforeFileOpen: (path) => {
          if (!swapFile || swappedFile || path !== child) return;
          swappedFile = true;
          rmSync(child);
          symlinkSync(outsideFile, child);
        },
      });
      monitor.pollOnce();
      swapFile = true;
      appendRecord(child, assistant('safe append before swap'));
      monitor.pollOnce();
      expect(lines.join('\n')).not.toContain('file swap escape');

      // Exercise the same validation/open seam for an ancestor directory.
      rmSync(join(root, 'parent'), { recursive: true, force: true });
      writeJsonl(child, [assistant('new safe history')]);
      const outsideDirectory = join(outside, 'external-child');
      writeJsonl(join(outsideDirectory, 'session.jsonl'), [assistant('directory swap escape')]);
      let swappedDirectory = false;
      const directoryMonitor = new NestedSessionTraceMonitor({
        listSources: () => [{ jid: 'dc:directory', root, boundary }],
        emit: (_source, line) => lines.push(line),
        beforeDirectoryOpen: (path) => {
          if (swappedDirectory || path !== childDirectory) return;
          swappedDirectory = true;
          renameSync(childDirectory, `${childDirectory}-old`);
          symlinkSync(outsideDirectory, childDirectory);
        },
      });
      directoryMonitor.pollOnce();
      directoryMonitor.pollOnce();
      expect(lines.join('\n')).not.toContain('directory swap escape');
    },
  );

  it('enforces stable channel and file cursor admission bounds without replay', () => {
    const parent = temporaryRoot();
    const sources = Array.from({ length: 257 }, (_, index) => ({
      jid: `dc:${String(index).padStart(3, '0')}`,
      root: join(parent, `channel-${index}`),
      boundary: parent,
      epoch: `epoch-${index}`,
    }));
    const lines: string[] = [];
    const monitor = new NestedSessionTraceMonitor({
      listSources: () => sources,
      emit: (_source, line) => lines.push(line),
    });
    monitor.pollOnce();
    expect(monitor.stats().channels).toBe(256);

    // Removing one admitted route creates exactly one admission slot.
    sources.shift();
    monitor.pollOnce();
    expect(monitor.stats().channels).toBe(256);
    const newlyAdmittedRoot = sources.at(-1)!.root;
    const child = join(newlyAdmittedRoot, 'parent', 'child', 'session.jsonl');
    writeJsonl(child, [assistant('newly admitted live output')]);
    monitor.pollOnce();
    expect(lines.join('\n')).toContain('newly admitted live output');

    monitor.stop();
    const boundedRoot = sources[0].root;
    for (let index = 0; index < 513; index += 1) {
      writeJsonl(join(boundedRoot, 'parent', String(index), 'session.jsonl'), [
        assistant('history'),
      ]);
    }
    const fileMonitor = new NestedSessionTraceMonitor({
      listSources: () => [{ jid: 'dc:files', root: boundedRoot, boundary: parent }],
      emit: (_source, line) => lines.push(line),
    });
    for (let index = 0; index < 3; index += 1) fileMonitor.pollOnce();
    expect(fileMonitor.stats().files).toBe(512);
  });

  it('continues incremental directory discovery beyond one bounded poll', () => {
    const root = temporaryRoot();
    const { monitor, lines } = harness(root);
    monitor.pollOnce();
    const directory = join(root, 'parent');
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 4200; index += 1) {
      writeFileSync(join(directory, `junk-${String(index).padStart(5, '0')}`), 'x');
    }
    const child = join(directory, 'zzzz-child.jsonl');
    writeJsonl(child, [assistant('found after bounded discovery continuation')]);

    for (let index = 0; index < 4; index += 1) monitor.pollOnce();
    expect(lines.join('\n')).toContain('found after bounded discovery continuation');
  });

  it('carries the snapshotted webhook epoch with every emitted record', () => {
    const root = temporaryRoot();
    const sources: NestedSessionSource[] = [{ jid: 'dc:source', root, epoch: 'old-epoch' }];
    const emitted: Array<{ epoch: string | undefined; line: string }> = [];
    const monitor = new NestedSessionTraceMonitor({
      listSources: () => sources,
      emit: (source, line) => {
        emitted.push({ epoch: source.epoch, line });
        sources[0] = { ...sources[0], epoch: 'new-epoch' };
      },
    });
    monitor.pollOnce();
    const child = join(root, 'parent', 'child', 'session.jsonl');
    writeJsonl(child, [assistant('old epoch output')]);
    monitor.pollOnce();

    expect(emitted).toEqual([
      { epoch: 'old-epoch', line: expect.stringContaining('old epoch output') },
    ]);
  });

  it('bounds oversized lines, ignores symlinks, and releases cursor memory on shutdown', () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const { monitor, lines } = harness(root);
    monitor.start();
    const child = join(root, 'parent', 'child', 'session.jsonl');
    mkdirSync(dirname(child), { recursive: true });
    writeFileSync(
      child,
      `${'x'.repeat(2 * 1024 * 1024 + 1)}\n${JSON.stringify(assistant('after oversized'))}\n`,
    );
    const outsideFile = join(outside, 'secret.jsonl');
    writeJsonl(outsideFile, [assistant('symlink escape')]);
    if (process.platform !== 'win32')
      symlinkSync(outsideFile, join(dirname(child), 'escape.jsonl'));

    for (let index = 0; index < 10; index += 1) monitor.pollOnce();
    expect(lines.filter((line) => line.includes('oversized'))).toHaveLength(2);
    expect(lines.join('\n')).toContain('after oversized');
    expect(lines.join('\n')).not.toContain('symlink escape');
    expect(monitor.stats().pendingBytes).toBeLessThanOrEqual(4 * 1024 * 1024);

    monitor.stop();
    appendRecord(child, assistant('after shutdown'));
    monitor.pollOnce();
    expect(lines.join('\n')).not.toContain('after shutdown');
    expect(monitor.stats()).toEqual({ channels: 0, files: 0, pendingBytes: 0 });
  });
});
