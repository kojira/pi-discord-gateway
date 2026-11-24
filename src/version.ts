import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Short build label from an install path. Deploy artifacts are named
 * `<component>-<commit12>-<key>`, so `.../pi-71236a4c0116-…` gives `pi-71236a4c0116`.
 */
export function buildLabelFromPath(path: string, component: 'pi' | 'gateway'): string {
  const matches = [...path.matchAll(new RegExp(`${component}-([0-9a-f]{12})-`, 'g'))];
  const commit = matches.at(-1)?.[1];
  return commit ? `${component}-${commit}` : basename(path);
}

/** This Gateway's build label, falling back to the package version outside deploy artifacts. */
export function gatewayVersionLabel(): string {
  const here = fileURLToPath(import.meta.url);
  const label = buildLabelFromPath(here, 'gateway');
  if (label.startsWith('gateway-')) return label;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return `piscord ${pkg.version ?? 'unknown'}`;
  } catch {
    return 'unknown';
  }
}
