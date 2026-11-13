import { expect, test } from 'claude-code/testing'

import { SCAN_MAX_DIRS, discover } from './load'
import { footer } from './pane'

// The search for modules on its own, against a plain stand-in for the three calls it
// makes, built from one tree (a folder's sub-folders by path) as the engine would answer:
// a path exists when it is a folder of the tree, or an entry of one. `delay` holds each
// listing for so many turns, so listings answer in another order than they were asked
const repo = (tree: Record<string, string[]>, delay: (path: string) => number = () => 0) => {
  const seen = { listings: 0 }
  const $ = {
    session: { cwd: async () => '/repo' },
    fs: {
      exists: async (path: string) => {
        const parent = path.slice(0, path.lastIndexOf('/'))
        return path in tree || (tree[parent] ?? []).includes(path.slice(parent.length + 1))
      },
      list: async (path: string) => {
        seen.listings++
        for (let i = 0; i < delay(path); i++) await Promise.resolve()
        return (tree[path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
      },
    },
  }
  return { $: $ as any, seen }
}

// A module first, then far more folders than the search walks, whatever that limit is
const LARGE: Record<string, string[]> = {
  '/repo': ['.git', 'a', 'big'],
  '/repo/a': ['openspec'],
  '/repo/big': Array.from({ length: SCAN_MAX_DIRS + 100 }, (_, i) => `d${i}`),
}

test('a repository too large to search whole is cut short, and the footer says so', async () => {
  const { $, seen } = repo(LARGE)
  const found = await discover($)
  expect(found.paths).toEqual(['/repo/a'])
  expect(found.isCut).toBe(true)
  // So many folders listed, and no more
  expect(seen.listings).toBe(SCAN_MAX_DIRS)
  expect(footer(0, 0, 0, found.isCut)).toContain(`search stopped after ${SCAN_MAX_DIRS} folders`)
  expect(footer(0, 0, 0, false)).not.toContain('search stopped')
})

test('where a large repository is cut does not depend on which listing answers first', async () => {
  // Modules spread past the limit, in sub-folders whose listings answer in any order
  const big: string[] = []
  const tree: Record<string, string[]> = { '/repo': ['.git', 'big'], '/repo/big': big }
  for (let i = 0; i < 60; i++) {
    big.push(`g${i}`)
    tree[`/repo/big/g${i}`] = Array.from({ length: 40 }, (_, j) => (j === 0 ? 'openspec' : `d${j}`))
  }
  const quick = await discover(repo(tree).$)
  const scrambled = await discover(repo(tree, path => (path.length * 7) % 13).$)
  const reversed = await discover(repo(tree, path => 100 - (path.length % 100)).$)
  expect(quick.isCut).toBe(true)
  expect(scrambled.paths).toEqual(quick.paths)
  expect(reversed.paths).toEqual(quick.paths)
})

test('a repository within the limit is searched whole, every module found in folder order', async () => {
  const { $, seen } = repo({
    '/repo': ['.git', 'apps', 'packages'],
    '/repo/apps': ['web'],
    '/repo/apps/web': ['openspec', 'src'],
    '/repo/packages': ['paiement', 'catalogue'],
    '/repo/packages/paiement': ['openspec'],
    '/repo/packages/catalogue': ['openspec'],
  })
  const found = await discover($)
  expect(found.isCut).toBe(false)
  expect(found.paths).toEqual(['/repo/apps/web', '/repo/packages/paiement', '/repo/packages/catalogue'])
  // Each folder once: the top, apps, web, web/src, packages and its two modules (never
  // .git, never into an openspec/)
  expect(seen.listings).toBe(7)
})
