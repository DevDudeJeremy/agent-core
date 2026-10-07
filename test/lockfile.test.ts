import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

interface LockEntry {
  peer?: boolean;
  resolved?: string;
  integrity?: string;
  hasInstallScript?: boolean;
}

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

const pkg = readJson('package.json') as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const lock = readJson('package-lock.json') as {
  packages: Record<string, LockEntry & { version?: string }>;
};
const names = Object.keys(lock.packages)
  .filter(Boolean)
  .map((key) => key.replace(/^node_modules\//, ''));

// vitest needs vite, vite needs rolldown and lightningcss, and those two ship one native
// binary per platform as optional packages.
const isBundler = (name: string): boolean =>
  ['vite', 'rolldown', 'lightningcss'].includes(name) ||
  name.startsWith('@rolldown/binding-') ||
  name.startsWith('lightningcss-');

// vitest 5 lists vite as a required peer. While vite was in the lockfile only as that peer,
// `npm install` on npm 11.5.2 rewrote the lockfile without any of the native binaries and
// vitest could not start (npm/cli#4828). The fix is that vite is a direct devDependency.
describe('the lockfile survives a plain npm install (SPEC §9.18)', () => {
  it('vite is a direct devDependency, and none of the bundler is recorded as peer-only', () => {
    expect(pkg.devDependencies).toHaveProperty('vite');
    const bundler = names.filter(isBundler);
    expect(bundler).toContain('vite');
    expect(bundler.filter((name) => lock.packages[`node_modules/${name}`]!.peer)).toEqual([]);
  });

  it('nothing at all is recorded as peer-only', () => {
    // The pgvector build for the test database lists the database itself as a peer, the
    // same shape that caught vite. Both are declared directly.
    expect(pkg.devDependencies).toHaveProperty('@electric-sql/pglite');
    expect(pkg.devDependencies).toHaveProperty('@electric-sql/pglite-pgvector');
    expect(names.filter((name) => lock.packages[`node_modules/${name}`]!.peer)).toEqual([]);
  });

  it('lists the native binaries for macOS, Linux and Windows', () => {
    for (const os of ['darwin', 'linux', 'win32']) {
      expect(names.filter((n) => n.startsWith(`@rolldown/binding-${os}-`))).not.toEqual([]);
      expect(names.filter((n) => n.startsWith(`lightningcss-${os}-`))).not.toEqual([]);
    }
  });
});

// "Installing needs the npm registry and nothing else." Two things could make that false: a
// package fetched from somewhere else, and a script run at install that goes somewhere else.
describe('installing needs the npm registry and nothing else (SPEC §9.25)', () => {
  it('every package comes from registry.npmjs.org, with an integrity hash', () => {
    expect(names.length).toBeGreaterThan(100);
    const elsewhere = names.filter((name) => {
      const entry = lock.packages[`node_modules/${name}`]!;
      return !entry.resolved?.startsWith('https://registry.npmjs.org/') || !entry.integrity;
    });
    expect(elsewhere).toEqual([]);
  });

  it('only the two reviewed packages are flagged as running a script at install', () => {
    // esbuild's script checks the platform binary npm already fetched. fsevents is flagged
    // by the registry but ships prebuilt and runs nothing. SPEC §13 has the detail. A third
    // name here means a new script to read before this list is changed.
    expect(names.filter((name) => lock.packages[`node_modules/${name}`]!.hasInstallScript)).toEqual(
      ['esbuild', 'fsevents'],
    );
  });
});

// src/stores/supabase.ts builds its client with `db: { retry: false, timeout }`. supabase-js
// accepts unknown options without a word, so on a release that lacks them the store would
// quietly go back to retrying for seven seconds with no deadline.
describe('the declared supabase-js range has the options the store sets (SPEC §9.31)', () => {
  it('starts at 2.112.0 or later, the first release with both db.retry and db.timeout', () => {
    const range = pkg.dependencies['@supabase/supabase-js']!;
    const floor = /^\^2\.(\d+)\.(\d+)$/.exec(range);
    expect(floor, `unexpected range ${range}`).not.toBeNull();
    expect(Number(floor![1])).toBeGreaterThanOrEqual(112);
    // And what is locked is what the suite was run against.
    expect(lock.packages['node_modules/@supabase/supabase-js']!.version).toBe('2.117.3');
  });
});
