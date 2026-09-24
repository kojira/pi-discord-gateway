import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const checker = resolve('scripts/check-design-id.mjs');
const repositories: string[] = [];
const designPath = 'docs/design/feature.md';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'design-id-'));
  repositories.push(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.org');
  writeFileSync(join(cwd, 'README.md'), 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  mkdirSync(join(cwd, 'docs/design'), { recursive: true });
  writeFileSync(join(cwd, designPath), '# D-000001 feature\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'design');
  const design = git(cwd, 'rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'feature.txt'), 'implementation\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'implement', '-m', 'Design-Phase: IMPLEMENT');
  const implementation = git(cwd, 'rev-parse', 'HEAD');
  return { cwd, base, design, implementation };
}

function evidence(design: string, implementation: string) {
  return `Design-ID: D-000001\nDesign-Path: ${designPath}\nDesign-Commit: ${design}\nFirst-Implementation-Commit: ${implementation}\nInstruction-Log: https://github.com/example/repo/issues/1#issuecomment-1\nOwner-Approval: https://discord.com/channels/1/2/3`;
}

function run(cwd: string, base: string, head: string, body: string) {
  const eventFile = join(cwd, 'event.json');
  writeFileSync(
    eventFile,
    JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head }, body } }),
  );
  return spawnSync(process.execPath, [checker, eventFile], { cwd, encoding: 'utf8' });
}

afterEach(() => {
  for (const cwd of repositories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('check-design-id PR gate', () => {
  it('accepts a valid linear implementation PR', () => {
    const { cwd, base, design, implementation } = fixture();
    const result = run(cwd, base, implementation, evidence(design, implementation));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('design precedes IMPLEMENT');
  });

  it('rejects a missing design ID', () => {
    const { cwd, base, design, implementation } = fixture();
    const result = run(
      cwd,
      base,
      implementation,
      evidence(design, implementation).replace('Design-ID: D-000001\n', ''),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Design-ID');
  });

  it('rejects a nonancestor design commit', () => {
    const { cwd, base, design, implementation } = fixture();
    git(cwd, 'checkout', '-q', base);
    mkdirSync(join(cwd, 'docs/design'), { recursive: true });
    writeFileSync(join(cwd, designPath), '# D-000001 alternate\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'unrelated design');
    const siblingDesign = git(cwd, 'rev-parse', 'HEAD');
    const result = run(cwd, base, implementation, evidence(siblingDesign, implementation));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('strict ancestor');
    expect(siblingDesign).not.toBe(design);
  });

  it('rejects design edits after the implementation marker', () => {
    const { cwd, base, design, implementation } = fixture();
    writeFileSync(join(cwd, designPath), '# D-000001 changed\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'late design edit');
    const result = run(cwd, base, git(cwd, 'rev-parse', 'HEAD'), evidence(design, implementation));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Design document changed at/after IMPLEMENT marker');
  });

  it('rejects a duplicate implementation trailer', () => {
    const { cwd, base, design } = fixture();
    git(
      cwd,
      'commit',
      '--amend',
      '--no-edit',
      '-m',
      'implement',
      '-m',
      'Design-Phase: IMPLEMENT\nDesign-Phase: IMPLEMENT',
    );
    const implementation = git(cwd, 'rev-parse', 'HEAD');
    const result = run(cwd, base, implementation, evidence(design, implementation));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid/duplicate marker');
  });

  it('rejects a non-linear PR history', () => {
    const { cwd, base, design, implementation } = fixture();
    git(cwd, 'checkout', '-q', '-b', 'side', design);
    writeFileSync(join(cwd, 'side.txt'), 'side\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'side');
    git(cwd, 'checkout', '-q', implementation);
    git(cwd, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side');
    const result = run(cwd, base, git(cwd, 'rev-parse', 'HEAD'), evidence(design, implementation));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-linear or incomplete history');
  });

  it('reports a design-only PR without calling it an implementation pass', () => {
    const { cwd, base, design } = fixture();
    const result = run(cwd, base, design, '');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Design-only PR: implementation gate not applicable');
  });
});
