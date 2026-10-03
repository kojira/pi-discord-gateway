import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// A deliberately explicit gate: never count an unconfigured/skipped CLI fixture as GREEN.
const cli = process.env.PI_TERMINAL_TEST_CLI;
if (!cli || !existsSync(cli)) {
  console.error('PI_TERMINAL_TEST_CLI must name the built guarded-steering Pi candidate CLI.');
  process.exit(1);
}
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    'test/rpc-terminal-steer.integration.test.ts',
    'test/rpc-persistent.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, PI_TERMINAL_TEST_CLI: resolve(cli), PI_RPC_TEST_CLI: resolve(cli) },
  },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
