import { expect, mock, test } from 'claude-code/testing'

// /spec-manager <module> typed while the session's first look for modules is still
// walking the tree: the command waits for it instead of finding nothing
const MODULE = '/repo/packages/paiement'

// Waits for a point the plugin should reach, at most a second: a regression that never
// gets there fails the test, naming the point, instead of hanging it
const reach = async (point: Promise<void>, what: string) => {
  const isThere = await Promise.race([point.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000))])
  expect(`${what}: ${isThere ? 'reached' : 'never reached'}`).toBe(`${what}: reached`)
}
// The walk below the repository top holds until `release`; `isHeld` resolves once it does
const fakeRepo = (on: any) => {
  let release: () => void = () => undefined
  const walked = new Promise<void>(resolve => (release = resolve))
  let held: () => void = () => undefined
  const isHeld = new Promise<void>(resolve => (held = resolve))
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', `${MODULE}/openspec`].includes(e.path) }))
  on('fs.list', async (_: unknown, e: { path: string }) => {
    if (e.path === '/repo/packages') {
      held()
      await walked
    }
    const names = e.path === '/repo' ? ['.git', 'packages'] : e.path === '/repo/packages' ? ['paiement'] : e.path === MODULE ? ['openspec'] : []
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb] = e.argv
    const stdout = cmd === 'git' ? (verb === 'config' ? 'me@example.org\n' : '') : JSON.stringify({ changes: [], specs: [] })
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { release, isHeld }
}

test('/spec-manager <module> during the first look for modules waits for it', async ($, on) => {
  const { release, isHeld } = fakeRepo(on)
  // Not awaited before the release either: a session start that waited for its first
  // look would make the test fail on isHeld below, not hang
  const started = $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  // The session's first look is under way, held in the middle of its walk
  await reach(isHeld, 'the first walk held')
  let isAnswered = false
  const answer = $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'user' }, presentation: {} })
  void answer.then(() => (isAnswered = true))
  // Time for a command that would not wait to answer
  for (let i = 0; i < 5000 && !isAnswered; i++) await Promise.resolve()
  expect(isAnswered).toBe(false)
  release()
  expect((await answer).text).toBe('Showing packages/paiement.')
  await started
})

// A module picked while a refresh is reading the modules stays picked
test('a module picked during a refresh is not undone when the refresh ends', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const dirs: Record<string, string[]> = {
    '/repo': ['.git', 'packages'],
    '/repo/packages': ['paiement', 'catalogue'],
    '/repo/packages/paiement': ['openspec'],
    '/repo/packages/catalogue': ['openspec'],
  }
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: ['/repo/.git', '/repo/packages/paiement/openspec', '/repo/packages/catalogue/openspec'].includes(e.path),
  }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (dirs[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  // Once armed, openspec in paiement holds until the test lets it go
  let isArmed = false
  let reached: () => void = () => undefined
  const isReached = new Promise<void>(resolve => (reached = resolve))
  let release: () => void = () => undefined
  const released = new Promise<void>(resolve => (release = resolve))
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    const [cmd, verb, flag] = e.argv
    if (cmd === 'git') return { value: { exitCode: 0, stdout: verb === 'config' ? 'me@example.org\n' : '', stderr: '' } }
    const cwd = e.init?.cwd ?? ''
    if (isArmed && cwd.endsWith('paiement')) {
      reached()
      await released
    }
    const name = cwd.endsWith('catalogue') ? 'variants' : 'pay-v2'
    const body = flag === '--specs' || flag === '--archived' ? { specs: [], changes: [] } : verb === 'status' ? { changes: [] } : { changes: [{ name, completedTasks: 0, totalTasks: 0 }] }
    return { value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '' } }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const run = (args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })

  await run('all')
  await clock.settle()
  // A fresh look for the modules, held while it reads paiement
  isArmed = true
  // Not awaited before the release: were the command to wait for the refresh, the
  // test would fail on its answer instead of hanging
  const reset = run('')
  await reach(isReached, 'the refresh reading paiement')
  isArmed = false
  // The pick, not awaited either: it must land while the refresh is still held, and
  // the test says so rather than hanging should the command ever wait for it
  let isPicked = false
  const pick = run('catalogue').then(answer => {
    isPicked = true
    return answer
  })
  for (let i = 0; i < 5000 && !isPicked; i++) await Promise.resolve()
  expect(isPicked).toBe(true)
  release()
  await pick
  await reset
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
  // A module's view (the overview has no "‹ All modules"), and that module catalogue:
  // its name in the header, its change shown, paiement's not
  expect(await ui.find({ key: 'modules:all' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^packages\/catalogue · 1 other module$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /variants/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBe(undefined)
  await ui.unmount()
})

// A slow read of a module that ends after a newer one does not bring its older data back
test('a slow read ending after a newer one leaves the newer data shown', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const dirs: Record<string, string[]> = {
    '/repo': ['.git', 'packages'],
    '/repo/packages': ['paiement', 'catalogue'],
    '/repo/packages/paiement': ['openspec'],
    '/repo/packages/catalogue': ['openspec'],
  }
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: ['/repo/.git', '/repo/packages/paiement/openspec', '/repo/packages/catalogue/openspec'].includes(e.path),
  }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (dirs[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  // paiement's change is renamed between the two reads; once armed, the next listing
  // there answers with the name it was asked under, but only when the test lets it go
  let change = 'old-change'
  let isArmed = false
  let reached: () => void = () => undefined
  const isReached = new Promise<void>(resolve => (reached = resolve))
  let release: () => void = () => undefined
  const released = new Promise<void>(resolve => (release = resolve))
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    const [cmd, verb, flag] = e.argv
    const out = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '' } })
    if (cmd === 'git') return { value: { exitCode: 0, stdout: verb === 'config' ? 'me@example.org\n' : '', stderr: '' } }
    if (flag === '--specs' || flag === '--archived' || verb === 'status') return out({ changes: [], specs: [] })
    const cwd = e.init?.cwd ?? ''
    if (!cwd.endsWith('paiement')) return out({ changes: [{ name: 'variants', completedTasks: 0, totalTasks: 0 }] })
    const name = change
    if (isArmed) {
      isArmed = false
      reached()
      await released
    }
    return out({ changes: [{ name, completedTasks: 0, totalTasks: 0 }] })
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const run = (args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })

  await run('all')
  await clock.settle()
  // Opening paiement starts its full read, held with the old name
  isArmed = true
  await run('paiement')
  await reach(isReached, "paiement's full read")
  // Meanwhile the change is renamed and a fresh refresh reads it, to its end
  change = 'new-change'
  await run('')
  await clock.settle()
  // The held read ends last
  release()
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', ...{ component: 'Pane', requestId: 'spec-manager' } as const, props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
  expect(await ui.find({ type: 'Text', text: /new-change/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /old-change/ })).toBe(undefined)
  await ui.unmount()
})
