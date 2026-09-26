import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autocompleteModels,
  isModelCatalogStale,
  listAvailableModels,
  listSelectableModels,
  parsePiModelList,
} from '../src/agent/model-catalog.js';
import { config } from '../src/config.js';

const { spawnSyncMock, execFileMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
  execFile: execFileMock,
}));

const defaultCliOutput = `provider  model  context  max-out  thinking  images
other    gamma  128K     16K      yes       no
test     alpha  128K     16K      no        no
test     beta   128K     16K      yes       no
`;

function mockPiCatalog(enabledModels?: string[], cliOutput = defaultCliOutput): void {
  execFileMock.mockImplementation((_bin, _args, _options, callback) =>
    callback(null, cliOutput, ''),
  );
  vi.spyOn(SettingsManager, 'create').mockReturnValue(SettingsManager.inMemory({ enabledModels }));
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
  execFileMock.mockReset();
});

describe('listSelectableModels', () => {
  it('returns every available model when enabledModels is not configured', async () => {
    mockPiCatalog();

    const result = await listSelectableModels({ forceRefresh: true, cwd: '/tmp/project' });

    expect(result.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha', 'test/beta']);
    expect(SettingsManager.create).toHaveBeenCalledWith('/tmp/project');
  });

  it('uses pi enabledModels semantics and preserves configured order', async () => {
    mockPiCatalog(['other/gamma', 'test/alpha']);

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['other/gamma', 'test/alpha']);
  });

  it('supports the same glob patterns as pi scoped models', async () => {
    mockPiCatalog(['test/*']);

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/alpha', 'test/beta']);
  });

  it('uses the configured pi binary as the authoritative model source', async () => {
    mockPiCatalog(
      ['test/delta'],
      `${defaultCliOutput}test     delta  256K     32K      yes       yes\n`,
    );

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result.map((model) => model.ref)).toEqual(['test/delta']);
  });

  it('returns an empty catalog when pi --list-models fails', async () => {
    mockPiCatalog(['test/beta']);
    execFileMock.mockImplementation((_bin, _args, _options, callback) =>
      callback(new Error('failed'), '', 'failed'),
    );

    const result = await listSelectableModels({ forceRefresh: true, cwd: '/tmp/cold-cli-failure' });

    expect(result).toEqual([]);
  });

  it('keeps a successful empty pi catalog empty instead of falling back', async () => {
    mockPiCatalog(undefined, 'provider  model  context  max-out  thinking  images\n');

    const result = await listSelectableModels({ forceRefresh: true });

    expect(result).toEqual([]);
  });

  it('returns an empty catalog when pi --list-models errors out', async () => {
    mockPiCatalog(['test/beta']);
    execFileMock.mockImplementation((_bin, _args, _options, callback) =>
      callback(new Error('execFile pi ETIMEDOUT'), '', ''),
    );

    const result = await listSelectableModels({ forceRefresh: true, cwd: '/tmp/cold-cli-error' });

    expect(result).toEqual([]);
  });

  it('bounds the pi --list-models subprocess with a timeout', async () => {
    mockPiCatalog();

    await listSelectableModels({ forceRefresh: true });

    expect(execFileMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('passes PI_EXTRA_FLAGS to model discovery like the agent invocation', async () => {
    mockPiCatalog();
    const mutableConfig = config as { piExtraFlags: string };
    const previousFlags = mutableConfig.piExtraFlags;
    mutableConfig.piExtraFlags = '-e ./provider.ts --approve';

    try {
      await listSelectableModels({ forceRefresh: true });
    } finally {
      mutableConfig.piExtraFlags = previousFlags;
    }

    expect(execFileMock).toHaveBeenCalledWith(
      expect.anything(),
      ['--list-models', '-e', './provider.ts', '--approve'],
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe('autocompleteModels', () => {
  it("keeps new model generations visible in Discord's 25-choice empty query", async () => {
    const rows = [
      ...Array.from(
        { length: 26 },
        (_, index) => `anthropic claude-${String(index + 1).padStart(2, '0')} 200K 32K yes yes`,
      ),
      'openai-codex gpt-6-luna 272K 128K yes yes',
      'openai-codex gpt-6-sol 272K 128K yes yes',
    ].join('\n');
    mockPiCatalog(undefined, `provider model context max-out thinking images\n${rows}\n`);

    const result = await autocompleteModels('', 25, {
      forceRefresh: true,
      cwd: '/tmp/autocomplete',
    });

    expect(result.map((model) => model.ref)).toContain('openai-codex/gpt-6-luna');
    expect(result.map((model) => model.ref)).toContain('openai-codex/gpt-6-sol');
  });
});

describe('non-blocking live discovery', () => {
  it('keeps the event loop available while a CLI lookup is pending', async () => {
    mockPiCatalog();
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      setTimeout(() => callback(null, defaultCliOutput, ''), 80);
    });
    const pending = listSelectableModels({ forceRefresh: true, cwd: '/tmp/slow-live-catalog' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect((await pending).length).toBe(3);
  });

  it('uses a fresh warmed catalog without spawning another CLI process', async () => {
    mockPiCatalog();
    const cwd = '/tmp/warm-model-selection';
    await listSelectableModels({ forceRefresh: true, cwd });
    execFileMock.mockClear();
    expect((await listSelectableModels({ cwd })).length).toBe(3);
    expect(listAvailableModels({ cwd }).length).toBe(3);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('coalesces refreshes and preserves a valid catalog on lookup failure', async () => {
    mockPiCatalog();
    const cwd = '/tmp/refresh-coalescing';
    expect((await listSelectableModels({ forceRefresh: true, cwd })).length).toBe(3);
    execFileMock.mockClear();
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      setTimeout(() => callback(new Error('timeout'), '', ''), 30);
    });
    const first = listSelectableModels({ forceRefresh: true, cwd });
    const second = listSelectableModels({ forceRefresh: true, cwd });
    expect((await Promise.all([first, second])).map((models) => models.length)).toEqual([3, 3]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(listAvailableModels({ cwd }).length).toBe(3);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('serves stale autocomplete choices immediately and refreshes once in the background', async () => {
    vi.useFakeTimers();
    try {
      mockPiCatalog();
      const cwd = '/tmp/autocomplete-stale-refresh';
      await listSelectableModels({ forceRefresh: true, cwd });
      execFileMock.mockClear();
      let finishRefresh: (() => void) | undefined;
      execFileMock.mockImplementation((_bin, _args, _options, callback) => {
        finishRefresh = () =>
          callback(null, `${defaultCliOutput}test delta 256K 32K yes yes\n`, '');
      });
      vi.advanceTimersByTime(31_000);

      const first = await autocompleteModels('delta', 25, { allowStale: true, cwd });
      const second = await autocompleteModels('delta', 25, { allowStale: true, cwd });
      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(finishRefresh).toBeDefined();

      finishRefresh!();
      await Promise.resolve();
      await Promise.resolve();
      expect(
        (await autocompleteModels('delta', 25, { allowStale: true, cwd })).map((m) => m.ref),
      ).toEqual(['test/delta']);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isModelCatalogStale', () => {
  it('treats never-loaded catalogs as stale', () => {
    expect(isModelCatalogStale('/tmp/never-loaded')).toBe(true);
  });

  it('reports stale once the cache TTL elapses', async () => {
    vi.useFakeTimers();
    try {
      mockPiCatalog();
      await listSelectableModels({ forceRefresh: true, cwd: '/tmp/stale-check' });

      expect(isModelCatalogStale('/tmp/stale-check')).toBe(false);

      vi.advanceTimersByTime(31_000);
      expect(isModelCatalogStale('/tmp/stale-check')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parsePiModelList', () => {
  it('parses pi --list-models table output', () => {
    expect(parsePiModelList(defaultCliOutput)).toEqual([
      expect.objectContaining({ ref: 'other/gamma', reasoning: true }),
      expect.objectContaining({ ref: 'test/alpha', reasoning: false }),
      expect.objectContaining({ ref: 'test/beta', reasoning: true }),
    ]);
  });

  it('skips banner output written before the table header', () => {
    const output = `Loaded extension ./provider.ts\nwarning: model cache rebuilt\n${defaultCliOutput}`;

    expect(parsePiModelList(output)).toEqual([
      expect.objectContaining({ ref: 'other/gamma', reasoning: true }),
      expect.objectContaining({ ref: 'test/alpha', reasoning: false }),
      expect.objectContaining({ ref: 'test/beta', reasoning: true }),
    ]);
  });

  it('returns an empty catalog when no table header is present', () => {
    expect(parsePiModelList('no models available\n')).toEqual([]);
  });
});
