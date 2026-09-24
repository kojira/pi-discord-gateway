#!/usr/bin/env node
// Standalone PR check; requires only Node >=20 and a full Git history.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fail = (message) => {
  throw new Error(message);
};

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trimEnd();

const commit = (sha, label) => {
  if (
    !/^[0-9a-f]{40,64}$/.test(sha ?? '') ||
    git('rev-parse', '--verify', `${sha}^{commit}`) !== sha
  ) {
    fail(`${label}: expected a fetched full commit SHA`);
  }
  return sha;
};

const field = (body, name) => {
  const matches = [...body.matchAll(new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`, 'gm'))];
  if (matches.length !== 1 || !matches[0][1]) fail(`PR evidence: exactly one ${name} is required`);
  return matches[0][1];
};

const phaseTrailers = (sha) =>
  execFileSync('git', ['interpret-trailers', '--parse'], {
    input: git('show', '-s', '--format=%B', sha),
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => /^Design-Phase\s*:/i.test(line));

const reference = (value, name) => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.includes('.') ||
      url.pathname === '/' ||
      /\s/.test(value)
    ) {
      fail(`${name}: expected one direct HTTPS reference`);
    }
  } catch {
    fail(`${name}: expected one direct HTTPS reference`);
  }
};

export function check({ base, head, body }) {
  commit(base, 'base');
  commit(head, 'head');
  const designPath = field(body, 'Design-Path');
  if (
    !designPath ||
    designPath.startsWith('/') ||
    !/^[A-Za-z0-9_./-]+$/.test(designPath) ||
    designPath.split('/').some((part) => !part || part === '.' || part === '..') ||
    !designPath.endsWith('.md')
  ) {
    fail('design path: expected a repository-relative Markdown path');
  }
  const id = field(body, 'Design-ID');
  if (!/^D-[0-9]{6}$/.test(id)) fail('Design-ID: expected D-000001 format');
  const design = commit(field(body, 'Design-Commit'), 'Design-Commit');
  const implementation = commit(
    field(body, 'First-Implementation-Commit'),
    'First-Implementation-Commit',
  );
  reference(field(body, 'Instruction-Log'), 'Instruction-Log');
  reference(field(body, 'Owner-Approval'), 'Owner-Approval');

  const content = git('show', `${design}:${designPath}`);
  if (!new RegExp(`(^|[^A-Za-z0-9-])${id}($|[^A-Za-z0-9-])`).test(content)) {
    fail(`Design-Commit: ${designPath} does not contain ${id}`);
  }
  if (
    !git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', design, '--', designPath)
  ) {
    fail(`Design-Commit: ${designPath} was not written by that commit`);
  }
  if (design === implementation || !gitIsAncestor(design, implementation)) {
    fail('Design-Commit must be a strict ancestor of First-Implementation-Commit');
  }

  const commits = git('rev-list', '--reverse', `${base}..${head}`).split('\n').filter(Boolean);
  if (!commits.length) fail('base..head: no implementation commits');
  let previous = base;
  let firstMarker;
  for (const sha of commits) {
    if (git('rev-list', '--parents', '-n', '1', sha) !== `${sha} ${previous}`) {
      fail(`base..head: non-linear or incomplete history at ${sha}`);
    }
    previous = sha;
    const trailers = phaseTrailers(sha);
    if (trailers.length) {
      if (trailers.length !== 1 || trailers[0] !== 'Design-Phase: IMPLEMENT' || firstMarker) {
        fail(
          `Design-Phase: expected exactly one IMPLEMENT marker, found invalid/duplicate marker at ${sha}`,
        );
      }
      firstMarker = sha;
    }
    if (
      firstMarker &&
      git('diff-tree', '--no-commit-id', '--name-only', '-r', sha, '--', designPath)
    ) {
      fail(
        `Design document changed at/after IMPLEMENT marker: ${designPath} in ${sha}; return to design in a separate PR`,
      );
    }
  }
  if (!firstMarker || firstMarker !== implementation) {
    fail('First-Implementation-Commit: missing or mismatched first IMPLEMENT marker in PR');
  }
  if (
    !git(
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      implementation,
      '--',
      `:(exclude)${designPath}`,
    )
  ) {
    fail('First-Implementation-Commit: must change a file other than the design document');
  }
  return `${id}: design precedes IMPLEMENT; ${designPath} unchanged since marker`;
}

function gitIsAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [eventFile] = process.argv.slice(2);
    if (!eventFile || process.argv.length !== 3)
      fail('usage: node scripts/check-design-id.mjs <github-event.json>');
    const pr = JSON.parse(readFileSync(eventFile, 'utf8')).pull_request;
    if (!pr) fail('expected a pull_request event');
    const base = pr.base.sha;
    const head = pr.head.sha;
    commit(base, 'base');
    commit(head, 'head');
    const commits = git('rev-list', '--reverse', `${base}..${head}`).split('\n').filter(Boolean);
    const files = commits.flatMap((sha) =>
      git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).split('\n').filter(Boolean),
    );
    const hasMarker = commits.some((sha) => phaseTrailers(sha).length > 0);
    if (
      commits.length &&
      files.length &&
      files.every((path) => path.startsWith('docs/design/') && path.endsWith('.md')) &&
      !hasMarker
    ) {
      console.log(
        'Design-only PR: implementation gate not applicable (not an implementation pass)',
      );
    } else {
      console.log(check({ base, head, body: pr.body ?? '' }));
    }
  } catch (error) {
    console.error(`Design ID check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
