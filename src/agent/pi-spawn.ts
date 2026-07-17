import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';

/** Resolve npm .cmd shims on Windows so pi can be spawned without a shell. */
export function resolvePiSpawn(piBin: string, args: string[]): { bin: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { bin: piBin, args };
  }

  try {
    const shimPath = execSync(`where ${piBin}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .find((line) => line.trim().endsWith('.cmd'));

    if (shimPath) {
      const content = readFileSync(shimPath.trim(), 'utf8');
      const jsMatch = content.match(/"([^"]+\.js)"/);
      if (jsMatch) {
        const jsPath = pathResolve(dirname(shimPath.trim()), jsMatch[1]);
        if (existsSync(jsPath)) {
          return { bin: process.execPath, args: [jsPath, ...args] };
        }
      }
    }
  } catch {
    // Fall through to the configured binary.
  }

  return { bin: piBin, args };
}
