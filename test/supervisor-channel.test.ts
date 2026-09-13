import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  startSupervisorWatcher,
  writeSupervisorReply,
  type SupervisorRequest,
} from '../src/agent/supervisor-channel.js';

let tempRoot: string;
let previousTempRoot: string | undefined;

beforeEach(async () => {
  previousTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
  tempRoot = await mkdtemp(join(tmpdir(), 'pidg-supervisor-test-'));
  process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
});

afterEach(async () => {
  if (previousTempRoot === undefined) {
    delete process.env.PI_SUBAGENTS_TEMP_ROOT;
  } else {
    process.env.PI_SUBAGENTS_TEMP_ROOT = previousTempRoot;
  }
  await rm(tempRoot, { recursive: true, force: true });
});

describe('supervisor channel watcher', () => {
  test('detects pending pi-subagents supervisor requests and writes replies', async () => {
    const channelDir = join(tempRoot, 'supervisor-channels', 'run-worker-0');
    mkdirSync(join(channelDir, 'requests'), { recursive: true });
    mkdirSync(join(channelDir, 'replies'), { recursive: true });

    const requestFile = join(channelDir, 'requests', 'req-1.json');
    writeFileSync(
      requestFile,
      JSON.stringify({
        type: 'subagent.supervisor.request',
        id: 'req-1',
        createdAt: Date.now(),
        reason: 'need_decision',
        message: 'Which path should I take?',
        expectsReply: true,
        runId: 'run',
        agent: 'worker',
        childIndex: 0,
      }),
    );

    const request = await new Promise<SupervisorRequest>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('watcher did not detect request')), 3000);
      const watcher = startSupervisorWatcher({
        onRequest: (detected) => {
          clearTimeout(timeout);
          watcher.stop();
          resolve(detected);
        },
      });
    });

    expect(request.id).toBe('req-1');
    expect(request.replyFile).toBe(join(channelDir, 'replies', 'req-1.json'));

    await writeSupervisorReply(request, 'Proceed best-effort.');

    const reply = JSON.parse(readFileSync(request.replyFile, 'utf8'));
    expect(reply).toMatchObject({
      type: 'subagent.supervisor.reply',
      requestId: 'req-1',
      message: 'Proceed best-effort.',
    });
  });

  test('restricts supervisor requests to the configured invocation temp root', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'pidg-supervisor-other-'));
    try {
      writeRequest(otherRoot, 'foreign-req', 'foreign-run');
      const scopedChannelDir = writeRequest(tempRoot, 'scoped-req', 'scoped-run');

      const request = await new Promise<SupervisorRequest>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('watcher did not detect scoped request')), 3000);
        const watcher = startSupervisorWatcher({
          tempRoot,
          onRequest: (detected) => {
            clearTimeout(timeout);
            watcher.stop();
            resolve(detected);
          },
        });
      });

      expect(request.id).toBe('scoped-req');
      expect(request.runId).toBe('scoped-run');
      expect(request.replyFile).toBe(join(scopedChannelDir, 'replies', 'scoped-req.json'));
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});

function writeRequest(root: string, id: string, runId: string): string {
  const channelDir = join(root, 'supervisor-channels', `${runId}-worker-0`);
  mkdirSync(join(channelDir, 'requests'), { recursive: true });
  mkdirSync(join(channelDir, 'replies'), { recursive: true });
  writeFileSync(
    join(channelDir, 'requests', `${id}.json`),
    JSON.stringify({
      type: 'subagent.supervisor.request',
      id,
      createdAt: Date.now(),
      reason: 'need_decision',
      message: 'Which path should I take?',
      expectsReply: true,
      runId,
      agent: 'worker',
      childIndex: 0,
    }),
  );
  return channelDir;
}
