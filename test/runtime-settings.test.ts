import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeSettingsReconciler,
  type RuntimeSettings,
  type SettingsRpcResponse,
} from '../src/agent/runtime-settings.js';

const initial: RuntimeSettings = {
  model: 'test/a',
  thinking: 'off',
  processIdentity: 'same-process',
};
const state = {
  capabilities: { guardedSettings: 1 },
  settingsRevision: 0,
  model: { provider: 'test', id: 'a' },
  thinkingLevel: 'off',
};

function setup() {
  let desired = { ...initial };
  let current = true;
  const send = vi
    .fn<(command: Record<string, unknown>) => Promise<SettingsRpcResponse>>()
    .mockResolvedValue({ success: true, data: state });
  const reconciler = new RuntimeSettingsReconciler(
    initial,
    () => desired,
    send,
    () => current,
  );
  return {
    reconciler,
    send,
    change: (next: Partial<RuntimeSettings>) => {
      desired = { ...desired, ...next };
    },
    close: () => {
      current = false;
    },
  };
}

describe('guarded runtime settings admission', () => {
  it('preserves legacy unchanged behavior, blocks changed settings, then allows reversion', async () => {
    const f = setup();
    f.send.mockResolvedValue({ success: true, data: { capabilities: { guardedSteer: 1 } } });
    expect(await f.reconciler.reconcile()).toEqual({ ready: true });
    f.change({ model: 'test/b' });
    expect(await f.reconciler.reconcile()).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Pi update required'),
    });
    expect(f.send.mock.calls.every(([c]) => c.type === 'get_state')).toBe(true);
    f.change({ model: 'test/a' });
    expect(await f.reconciler.reconcile()).toEqual({ ready: true });
  });

  it.each([-1, 1.5, undefined, Number.NaN])(
    'rejects invalid runtime revision %s without mutating',
    async (settingsRevision) => {
      const f = setup();
      f.change({ model: 'test/b' });
      f.send.mockResolvedValue({ success: true, data: { ...state, settingsRevision } });
      expect(await f.reconciler.reconcile()).toMatchObject({ ready: false });
      expect(f.send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['busy', 'revision_changed'])(
    'keeps desired state pending on definite %s refusal',
    async (reason) => {
      const f = setup();
      f.change({ model: 'test/b', thinking: 'high' });
      f.send
        .mockResolvedValueOnce({ success: true, data: state })
        .mockResolvedValueOnce({ success: true, data: { applied: false, reason } });
      expect(await f.reconciler.reconcile()).toMatchObject({
        ready: false,
        reason: expect.stringContaining(reason),
      });
      expect(f.send).toHaveBeenLastCalledWith({
        type: 'set_runtime_settings',
        provider: 'test',
        modelId: 'b',
        thinkingLevel: 'high',
        expectedRevision: 0,
      });
      expect(f.reconciler.matchesDesired()).toBe(false);
    },
  );

  it.each([
    {
      applied: true,
      settingsRevision: 1,
      model: { provider: 'test', id: 'a' },
      thinkingLevel: 'high',
    },
    {
      applied: true,
      settingsRevision: 1,
      model: { provider: 'test', id: 'b' },
      thinkingLevel: 'low',
    },
    { applied: true, model: { provider: 'test', id: 'b' }, thinkingLevel: 'high' },
    { applied: false, reason: 'unknown' },
  ])(
    'does not mistake an invalid or clamped ACK for desired effective settings: %j',
    async (data) => {
      const f = setup();
      f.change({ model: 'test/b', thinking: 'high' });
      f.send
        .mockResolvedValueOnce({ success: true, data: state })
        .mockResolvedValueOnce({ success: true, data });
      expect(await f.reconciler.reconcile()).toMatchObject({ ready: false });
      expect(f.reconciler.matchesDesired()).toBe(false);
    },
  );

  it('shares the in-flight transaction and observes transport uncertainty without retirement or prompt replay', async () => {
    const f = setup();
    f.change({ model: 'test/b' });
    let reject!: (error: Error) => void;
    f.send.mockResolvedValueOnce({ success: true, data: state }).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const first = f.reconciler.reconcile();
    expect(f.reconciler.reconcile()).toBe(first);
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    reject(new Error('command timed out'));
    expect(await first).toMatchObject({
      ready: false,
      reason: expect.stringContaining('timed out'),
    });
    expect(f.send.mock.calls.map(([c]) => c.type)).toEqual(['get_state', 'set_runtime_settings']);
    f.change({ model: undefined });
    expect(await f.reconciler.reconcile()).toMatchObject({
      ready: false,
      reason: expect.stringContaining('Implicit Pi defaults'),
    });
  });

  it('rejects a late acknowledgement from a closed connection', async () => {
    const f = setup();
    f.change({ model: 'test/b' });
    f.send
      .mockResolvedValueOnce({ success: true, data: state })
      .mockImplementationOnce(async () => {
        f.close();
        return {
          success: true,
          data: {
            applied: true,
            settingsRevision: 1,
            model: { provider: 'test', id: 'b' },
            thinkingLevel: 'off',
          },
        };
      });
    expect(await f.reconciler.reconcile()).toMatchObject({
      ready: false,
      reason: expect.stringContaining('connection closed'),
    });
  });

  it('preserves an independent legacy state error', async () => {
    const f = setup();
    f.send.mockResolvedValue({ success: false, error: 'session unavailable' });
    expect(await f.reconciler.reconcile()).toEqual({ ready: false, reason: 'session unavailable' });
  });
});
