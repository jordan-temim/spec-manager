import { expect, mock, test } from 'claude-code/testing'

import { DISCOVER_EVERY_MS, POLL_MS } from './load'

// Nothing runs at session start: /spec-manager starts the pane and its polling, which
// looks at the files every 30 seconds and searches the tree for modules every 5 minutes

const MODULE = '/repo/pay'

const fakeRepo = (on: any) => {
  const lists: string[] = []
  const runs: string[][] = []
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', `${MODULE}/openspec`].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    lists.push(e.path)
    const names = e.path === '/repo' ? ['.git', 'pay'] : e.path === MODULE ? ['openspec'] : []
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify({ changes: [], specs: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // A look at the module's files: its openspec/ listed. A search of the tree: /repo listed
  const looks = () => lists.filter(path => path === `${MODULE}/openspec`).length
  const searches = () => lists.filter(path => path === '/repo').length
  return { lists, runs, clock, looks, searches }
}

test('the files every 30 seconds, the tree every 5 minutes', () => {
  expect(POLL_MS).toBe(30000)
  expect(DISCOVER_EVERY_MS).toBe(300000)
})

test('a session start runs nothing, lists nothing, until /spec-manager', async ($, on) => {
  const { lists, runs, clock } = fakeRepo(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(DISCOVER_EVERY_MS + POLL_MS)
  await clock.settle()
  expect(lists).toEqual([])
  expect(runs).toEqual([])
})

test('after /spec-manager, a look every 30 seconds and a search every 5 minutes',
  // Five minutes of the clock's one-second ticks take real time: more than the default
  // 5 seconds on a busy machine
  { timeoutMs: 20000 },
  async ($, on) => {
  const { clock, looks, searches } = fakeRepo(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.settle()
  const first = { looks: looks(), searches: searches() }
  expect(first.searches).toBe(1)

  // Just before the poll: nothing looked at again
  await clock.advance(POLL_MS - 1000)
  await clock.settle()
  expect(looks()).toBe(first.looks)
  // The poll: one look, no search
  await clock.advance(1000)
  await clock.settle()
  expect(looks()).toBe(first.looks + 1)
  expect(searches()).toBe(1)

  // Up to 5 minutes: a look at each poll, still no new search
  await clock.advance(DISCOVER_EVERY_MS - POLL_MS)
  await clock.settle()
  expect(looks()).toBe(first.looks + DISCOVER_EVERY_MS / POLL_MS)
  expect(searches()).toBe(1)
  // The first poll past 5 minutes searches the tree again
  await clock.advance(POLL_MS)
  await clock.settle()
  expect(searches()).toBe(2)
})

test('a second /spec-manager does not add a poll beside the first', async ($, on) => {
  const { clock, looks } = fakeRepo(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const run = () => $.command.run({ command: 'spec-manager', args: 'pay', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await run()
  await clock.settle()
  await run()
  await clock.settle()
  const before = looks()
  await clock.advance(POLL_MS)
  await clock.settle()
  expect(looks() - before).toBe(1)
})
