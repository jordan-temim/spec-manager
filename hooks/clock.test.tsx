import { expect, mock, test } from 'claude-code/testing'

import { POLL_MS } from './load'

// The countdown moves every second while the pane is shown, and not while it is hidden:
// each move is a write of the state the pane reads, so a redraw of the whole pane. Those
// writes are counted, and a freshly drawn pane shows where the clock stands
test('the clock moves only while the pane is shown', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let isShown = false
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', '/repo/openspec'].includes(e.path) }))
  // The poll's fingerprint lists /repo/openspec: each listing of it is a poll
  let polls = 0
  on('fs.list', (_: unknown, e: { path: string }) => {
    if (e.path === '/repo/openspec') polls++
    return { value: (e.path === '/repo' ? ['.git', 'openspec'] : []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ changes: [], specs: [] }), stderr: '' } }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Every write of the pane's state, seen on its way to the kit's own store
  let writes = 0
  on('state.set', (_: unknown, e: unknown, next: (e: unknown) => unknown) => {
    writes++
    return next(e)
  })
  on('ui.panes', () => ({ value: [{ id: 'spec-manager', title: 'Spec Manager', isShown, isFocused: false, isPlaced: true }] }))
  const footer = async () => {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
    const text = (await ui.find({ type: 'Text', text: /refresh in/ }))?.text ?? ''
    await ui.unmount()
    return text
  }
  const countdown = async () => (await footer()).match(/refresh in \d+s/)?.[0]
  // "refresh in Ns" for a poll so many seconds ahead
  const left = (seconds: number) => `refresh in ${seconds}s`
  const POLL_S = POLL_MS / 1000
  // The steps below wait 3, 1, then 2 seconds before the first poll: it must come after them
  expect(POLL_S).toBeGreaterThan(6)
  const updated = async () => (await footer()).match(/updated at [\d:]+/)?.[0]

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const atStart = await countdown()
  expect(atStart).toBe(left(POLL_S))

  // Hidden: three seconds pass, nothing written, so nothing redrawn
  const writesBefore = writes
  await clock.advance(3000)
  await clock.settle()
  expect(writes).toBe(writesBefore)
  expect(await countdown()).toBe(atStart)

  // Shown: the next second writes it, and moves it
  isShown = true
  await clock.advance(1000)
  await clock.settle()
  expect(writes).toBeGreaterThan(writesBefore)
  expect(await countdown()).toBe(left(POLL_S - 4))

  // Hidden again: nothing written, the clock stops where it was
  isShown = false
  const writesShown = writes
  await clock.advance(2000)
  await clock.settle()
  expect(writes).toBe(writesShown)
  expect(await countdown()).toBe(left(POLL_S - 4))

  // Hidden past a poll (t = 6 s now, the next at one poll from the start): no read a moment
  // before it, one right at it, the pane hidden or not
  const before = { polls, updated: await updated() }
  await clock.advance(POLL_MS - 6000 - 1)
  await clock.settle()
  expect(polls).toBe(before.polls)
  await clock.advance(1)
  await clock.settle()
  expect(polls).toBe(before.polls + 1)
  expect(await updated()).not.toBe(before.updated)
  // Shown again: a second on, the countdown is the time left to the next poll, one more on
  isShown = true
  await clock.advance(1000)
  await clock.settle()
  expect(await countdown()).toBe(left(POLL_S - 1))
})
