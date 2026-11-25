import { expect, mock, test } from 'claude-code/testing'

import { DISCOVER_EVERY_MS, POLL_MS } from './load'

// The pane opens, and the repository is read, only once /spec-manager is run; from then
// on the polls find an openspec/ made later.
// `dirs` is read at each call, so a test can add an openspec/ mid-session; every
// listing is recorded in `listed`
// `cwd` answers the session's folder, `{ deny }` when a test needs it unreadable
type Cwd = () => { value: string } | { deny: string }
const session = (on: any, dirs: Record<string, string[]>, opened: string[], listed: string[] = [], cwd: Cwd = () => ({ value: '/repo' })) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', cwd)
  on('fs.exists', (_: unknown, e: { path: string }) => {
    const parent = e.path.slice(0, e.path.lastIndexOf('/'))
    return { value: e.path === '/repo/.git' || (dirs[parent] ?? []).includes(e.path.slice(parent.length + 1)) }
  })
  on('fs.list', (_: unknown, e: { path: string }) => {
    listed.push(e.path)
    return { value: (dirs[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ changes: [], specs: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  // The engine's own session start and command registry, beneath the plugin
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // The pane not shown: the clock's one-second ticks redraw nothing, and five minutes of
  // them stay quick
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  return clock
}
const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
const open = ($: any) => $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

test('no pane and no look at session start in a repository without openspec/', async ($, on) => {
  const opened: string[] = []
  const listed: string[] = []
  const clock = session(on, { '/repo': ['.git', 'src'] }, opened, listed)
  await start($)
  await clock.settle()
  expect(listed).toEqual([])
  expect(opened).toEqual([])
  // /spec-manager opens it, to say there is nothing to show
  await open($)
  await clock.settle()
  expect(listed).toContain('/repo')
  expect(opened).toEqual(['spec-manager'])
})

test('without openspec/, the tree is not walked at every poll, and an openspec init still shows up', async ($, on) => {
  const opened: string[] = []
  const listed: string[] = []
  const dirs: Record<string, string[]> = { '/repo': ['.git', 'src'], '/repo/src': ['a', 'b'] }
  const clock = session(on, dirs, opened, listed)
  await start($)
  await open($)
  await clock.settle()
  const walked = listed.filter(path => path === '/repo/src').length
  // The first look did walk the tree: the counts below compare with a walk that happened
  expect(walked).toBeGreaterThan(0)

  // Three polls, then the one that finds openspec/, all before the next search: no new
  // walk of the tree in between (the test leans on the search coming after four polls)
  expect(DISCOVER_EVERY_MS).toBeGreaterThan(4 * POLL_MS)
  for (let i = 0; i < 3; i++) await clock.advance(POLL_MS)
  await clock.settle()
  expect(listed.filter(path => path === '/repo/src').length).toBe(walked)
  expect(listed).not.toContain('/repo/openspec')

  // `openspec init` at the repository top: the next poll finds it and reads it
  dirs['/repo'] = [...dirs['/repo']!, 'openspec']
  await clock.advance(POLL_MS)
  await clock.settle()
  expect(listed).toContain('/repo/openspec')
  expect(opened).toEqual(['spec-manager'])
})

test('an openspec/ made deeper in the tree shows up at the 5 minutes\' walk',
  // Five minutes of the clock's one-second ticks take real time: more than the default
  // 5 seconds on a busy machine
  { timeoutMs: 20000 },
  async ($, on) => {
  const opened: string[] = []
  const listed: string[] = []
  const dirs: Record<string, string[]> = { '/repo': ['.git', 'src'], '/repo/src': ['a'], '/repo/src/a': [] }
  const clock = session(on, dirs, opened, listed)
  await start($)
  await open($)
  await clock.settle()
  // `openspec init` in /repo/src/a: not where each poll looks, the 5 minutes' walk finds it
  dirs['/repo/src/a'] = ['openspec']
  await clock.advance(POLL_MS)
  await clock.settle()
  expect(listed).not.toContain('/repo/src/a/openspec')
  const walked = listed.filter(path => path === '/repo/src').length
  await clock.advance(DISCOVER_EVERY_MS)
  await clock.settle()
  expect(listed.filter(path => path === '/repo/src').length).toBeGreaterThan(walked)
  expect(listed).toContain('/repo/src/a/openspec')
})

test('an error that has passed leaves the pane, even with no module to read', async ($, on) => {
  // The first look fails (the session's folder cannot be read), the next ones go through,
  // in a repository with no module: nothing is read, nothing moves
  let isReadable = false
  const clock = session(on, { '/repo': ['.git', 'src'] }, [], [], () => (isReadable ? { value: '/repo' } : { deny: 'folder not readable' }))
  const pane = async () => {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    try {
      return (await ui.find({ type: 'Box' }))?.text ?? (await ui.find({ type: 'Text' }))?.text ?? ''
    } finally {
      await ui.unmount()
    }
  }
  await start($)
  await open($)
  await clock.settle()
  expect(await pane()).toContain('folder not readable')
  // The folder readable again: the next poll, with nobody asking, finds no module and the
  // error goes
  isReadable = true
  await clock.advance(POLL_MS)
  await clock.settle()
  const after = await pane()
  expect(after).not.toContain('folder not readable')
  expect(after).toContain('No openspec/ folder')
})
