import { expect, mock, test } from 'claude-code/testing'

// Modules 5 and 6 levels below the repository top: the first is found, the second is too deep
const DIRS: Record<string, string[]> = {
  '/repo': ['.git', 'services'],
  '/repo/services': ['billing', 'a'],
  '/repo/services/billing': ['openspec'],
  '/repo/services/a': ['b'],
  '/repo/services/a/b': ['c'],
  '/repo/services/a/b/c': ['level5', 'd'],
  '/repo/services/a/b/c/level5': ['openspec'],
  '/repo/services/a/b/c/d': ['level6'],
  '/repo/services/a/b/c/d/level6': ['openspec'],
}

const fakeRepo = (on: any) => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === '/repo/.git' }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (DIRS[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'git' ? '' : JSON.stringify({ changes: [], specs: [] }), stderr: '' },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('finds modules up to 5 levels below the repository top, not deeper', async ($, on) => {
  fakeRepo(on)
  const run = (args: string) =>
    $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })
  expect((await run('level5')).text).toContain('services/a/b/c/level5')
  expect((await run('level6')).text).toContain('No OpenSpec module matches')
})
