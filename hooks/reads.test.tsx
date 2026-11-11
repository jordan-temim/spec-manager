import { expect, mock, test } from 'claude-code/testing'

import { DISCOVER_EVERY_MS, POLL_MS } from './load'

// What a refresh reads again, and how much at once. A repository of several modules,
// each with one change; every openspec and git run is counted, by folder
const PANE = { component: 'Pane', requestId: 'spec-manager' } as const
const props = { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } as const

const fakeRepo = (on: any, names: string[]) => {
  const clock = mock.clock(on)
  mock.store(on)
  // Read at each call: a test may take a module away
  const modules = () => names.map(n => `/repo/packages/${n}`)
  // Each module's change file, its time moved by `touch`
  const mtime: Record<string, number> = {}
  const broken = new Set<string>()
  const runs: { cwd: string; argv: string[] }[] = []
  const listed: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  // The modules with an openspec run under way, at most how many at once
  const reading = new Map<string, number>()
  let maxModules = 0
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === '/repo/.git' || modules().some(m => e.path === `${m}/openspec`) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    listed.push(e.path)
    const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    if (e.path === '/repo') return { value: [dir('.git'), dir('packages')] }
    if (e.path === '/repo/packages') return { value: names.map(dir) }
    if (modules().includes(e.path)) return { value: [dir('openspec')] }
    const module = modules().find(m => e.path === `${m}/openspec`)
    if (module) return { value: [{ name: 'changes', kind: 'dir', size: 0, mtimeMs: mtime[module] ?? 0, isLink: false }] }
    return { value: [] }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    const cwd = e.init?.cwd ?? ''
    runs.push({ cwd, argv: [...e.argv] })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    const isModule = e.argv[0] === 'openspec'
    if (isModule) {
      reading.set(cwd, (reading.get(cwd) ?? 0) + 1)
      maxModules = Math.max(maxModules, reading.size)
    }
    // Each run takes a few turns, so the ones started together overlap
    for (let i = 0; i < 5; i++) await Promise.resolve()
    inFlight--
    if (isModule) {
      const left = (reading.get(cwd) ?? 1) - 1
      if (left === 0) reading.delete(cwd)
      else reading.set(cwd, left)
    }
    const [cmd, verb, flag] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? 'bad schema' : '' } })
    if (cmd === 'git') return out(verb === 'config' ? 'me@example.org\n' : 'me@example.org\tMe\n')
    if (broken.has(cwd)) return out('', 1)
    if (flag === '--specs' || flag === '--archived' || verb === 'status') return out(JSON.stringify({ changes: [], specs: [] }))
    const name = cwd.split('/').pop()
    return out(JSON.stringify({ changes: [{ name: `${name}-change`, completedTasks: 0, totalTasks: 0 }] }))
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const openspecIn = (module: string) => runs.filter(r => r.argv[0] === 'openspec' && r.cwd === `/repo/packages/${module}`).length
  const gitLogs = () => runs.filter(r => r.argv[0] === 'git' && r.argv[1] === 'log').length
  // How many times a module's openspec/ was fingerprinted: once per poll that looked at it
  const walksOf = (module: string) => listed.filter(path => path === `/repo/packages/${module}/openspec`).length
  return {
    clock,
    runs,
    listed,
    openspecIn,
    walksOf,
    gitLogs,
    touch: (module: string) => (mtime[`/repo/packages/${module}`] = (mtime[`/repo/packages/${module}`] ?? 0) + 1),
    breakModule: (module: string) => broken.add(`/repo/packages/${module}`),
    maxInFlight: () => maxInFlight,
    maxModules: () => maxModules,
  }
}
const run = ($: any, args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })
const poll = async (clock: any) => {
  await clock.advance(POLL_MS)
  await clock.settle()
}

test('a file moved in one module reads that module again, not the others', async ($, on) => {
  const repo = fakeRepo(on, ['paiement', 'catalogue', 'auth'])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  const before = { paiement: repo.openspecIn('paiement'), catalogue: repo.openspecIn('catalogue'), auth: repo.openspecIn('auth') }

  // Nothing moved: nothing read
  await poll(repo.clock)
  expect(repo.openspecIn('paiement')).toBe(before.paiement)
  expect(repo.openspecIn('catalogue')).toBe(before.catalogue)
  expect(repo.openspecIn('auth')).toBe(before.auth)

  repo.touch('catalogue')
  await poll(repo.clock)
  expect(repo.openspecIn('catalogue')).toBeGreaterThan(before.catalogue)
  expect(repo.openspecIn('paiement')).toBe(before.paiement)
  expect(repo.openspecIn('auth')).toBe(before.auth)
})

test('a failing module is read again at each poll, alone', async ($, on) => {
  const repo = fakeRepo(on, ['paiement', 'catalogue'])
  repo.breakModule('catalogue')
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  const paiement = repo.openspecIn('paiement')
  // Each poll reads it again, not just the first one
  for (let i = 0; i < 3; i++) {
    const catalogue = repo.openspecIn('catalogue')
    await poll(repo.clock)
    expect(repo.openspecIn('catalogue')).toBeGreaterThan(catalogue)
  }
  expect(repo.openspecIn('paiement')).toBe(paiement)
})

test('a large repository reads a few modules at a time', async ($, on) => {
  const names = Array.from({ length: 12 }, (_, i) => `m${i}`)
  const repo = fakeRepo(on, names)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  // 12 modules: unbounded, all twelve read at once. Four at a time, and several of them
  expect(repo.openspecIn('m11')).toBeGreaterThan(0)
  expect(repo.maxModules()).toBeGreaterThan(1)
  expect(repo.maxModules()).toBeLessThanOrEqual(4)
})

test("a change's author is asked of git once, not at every read", async ($, on) => {
  const repo = fakeRepo(on, ['paiement'])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  expect(repo.gitLogs()).toBe(1)
  // A forced read, then a moved file: each reads the change again, neither asks its author
  const atStart = repo.openspecIn('paiement')
  await run($, '')
  await repo.clock.settle()
  const afterForced = repo.openspecIn('paiement')
  expect(afterForced).toBeGreaterThan(atStart)
  repo.touch('paiement')
  await poll(repo.clock)
  expect(repo.openspecIn('paiement')).toBeGreaterThan(afterForced)
  expect(repo.gitLogs()).toBe(1)
})

test('a session start that comes again replaces the poll, it does not add one', async ($, on) => {
  const repo = fakeRepo(on, ['paiement'])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  // One poll: the module's folder fingerprinted once, not once per start
  const walks = () => repo.walksOf('paiement')
  const before = walks()
  await poll(repo.clock)
  expect(walks() - before).toBe(1)
})

test('a module taken away leaves the pane at the next search, nothing else moving', async ($, on) => {
  const names = ['paiement', 'catalogue', 'auth']
  const repo = fakeRepo(on, names)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  const overview = async () => {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', ...PANE, props })
    const text = (await ui.find({ type: 'Box', text: /MODULES/ }))?.text ?? ''
    await ui.unmount()
    return text
  }
  expect(await overview()).toContain('packages/auth')
  // auth's openspec/ removed; the other two untouched. The search past the minute sees it
  const read = { paiement: repo.openspecIn('paiement'), catalogue: repo.openspecIn('catalogue') }
  names.splice(names.indexOf('auth'), 1)
  await repo.clock.advance(DISCOVER_EVERY_MS + POLL_MS)
  await repo.clock.settle()
  const after = await overview()
  expect(after).toContain('MODULES 2')
  expect(after).not.toContain('packages/auth')
  // Nothing else moving, nothing else read
  expect(repo.openspecIn('paiement')).toBe(read.paiement)
  expect(repo.openspecIn('catalogue')).toBe(read.catalogue)

  // Every module gone: the pane says there is none left, not the last ones it saw
  names.splice(0, names.length)
  await repo.clock.advance(DISCOVER_EVERY_MS + POLL_MS)
  await repo.clock.settle()
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', ...PANE, props })
  expect(await ui.find({ type: 'Text', text: /No openspec\/ folder/ })).toBeDefined()
  await ui.unmount()
})

test('a session that exits stops its poll', async ($, on) => {
  const repo = fakeRepo(on, ['paiement'])
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  const polls = () => repo.walksOf('paiement')
  await poll(repo.clock)
  const before = polls()
  expect(before).toBeGreaterThan(0)
  // The person leaves: nothing hands the state over, nothing polls on
  await $.session.end({ reason: 'prompt_input_exit', sessionId: '', resume: { id: '' } })
  await poll(repo.clock)
  await poll(repo.clock)
  expect(polls()).toBe(before)
})
