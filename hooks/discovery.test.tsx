import { expect, mock, test } from 'claude-code/testing'

import { DISCOVER_EVERY_MS, POLL_MS } from './load'

// How the search for modules goes: a few folders listed at a time, and an auto-open the
// host refused. (A search cut short is tested on its own, in discover.test.ts)

// A repository of `tree` (a folder's sub-folders by path), a module in /repo/a; every
// listing counted, with how many run at once when `isSlow` lets them overlap. `open`
// answers each opening of the pane
type Options = { isSlow?: boolean; open?: () => unknown }
const bigRepo = (on: any, tree: (path: string) => string[], { isSlow = false, open = () => ({ value: { isPlaced: true } }) }: Options = {}) => {
  const clock = mock.clock(on)
  mock.store(on)
  const seen = { listings: 0, inFlight: 0, maxInFlight: 0, opened: 0 }
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', '/repo/a/openspec'].includes(e.path) }))
  on('fs.list', async (_: unknown, e: { path: string }) => {
    seen.listings++
    seen.inFlight++
    seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight)
    if (isSlow) await Promise.resolve()
    seen.inFlight--
    const names = e.path === '/repo' ? ['.git', 'a', 'big'] : e.path === '/repo/a' ? ['openspec'] : tree(e.path)
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'git' ? '' : JSON.stringify({ changes: [], specs: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => {
    seen.opened++
    return open()
  })
  return { clock, seen }
}

test('the search lists a few folders at a time, however deep the tree', async ($, on) => {
  // Two levels of ten: a limit per level would let ten times ten run at once
  const ten = Array.from({ length: 10 }, (_, i) => `d${i}`)
  const { clock, seen } = bigRepo(on, path => (/^\/repo\/big(\/d\d+)?$/.test(path) ? ten : []), { isSlow: true })
  await $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.settle()
  expect(seen.listings).toBeGreaterThan(100)
  // Several at once, never more than four
  expect(seen.maxInFlight).toBeGreaterThan(1)
  expect(seen.maxInFlight).toBeLessThanOrEqual(4)
})

test('a pane the host refused to open opens by itself at the next search', async ($, on) => {
  // The first open is refused, the next ones go through
  let asked = 0
  const { clock, seen } = bigRepo(on, () => [], {
    open: () => (++asked === 1 ? { deny: 'no surface yet' } : { value: { isPlaced: true } }),
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(seen.opened).toBe(1)
  // The search again, once the modules found are due for it
  await clock.advance(DISCOVER_EVERY_MS + POLL_MS)
  await clock.settle()
  expect(seen.opened).toBe(2)
  // Open now: the searches after it leave it be
  await clock.advance(DISCOVER_EVERY_MS + POLL_MS)
  await clock.settle()
  expect(seen.opened).toBe(2)
})
