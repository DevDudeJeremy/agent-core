import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

interface LockEntry {
  peer?: boolean;
}

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

const pkg = readJson('package.json') as { devDependencies: Record<string, string> };
const lock = readJson('package-lock.json') as { packages: Record<string, LockEntry> };
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

  it('lists the native binaries for macOS, Linux and Windows', () => {
    for (const os of ['darwin', 'linux', 'win32']) {
      expect(names.filter((n) => n.startsWith(`@rolldown/binding-${os}-`))).not.toEqual([]);
      expect(names.filter((n) => n.startsWith(`lightningcss-${os}-`))).not.toEqual([]);
    }
  });
});
