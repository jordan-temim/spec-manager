import { expect, mock, test } from 'claude-code/testing'

// What a refresh reads again, and how much at once. A repository of several modules,
// each with one change; every openspec and git run is counted, by folder
const PANE = { component: 'Pane', requestId: 'spec-manager' } as const
const props = { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } as const

const fakeRepo = (on: any, names: string[]) => {
  const clock = mock.clock(on)
  mock.store(on)
  const modules = names.map(n => `/repo/packages/${n}`)
  // Each module's change file, its time moved by `touch`
  const mtime: Record<string, number> = {}
  const broken = new Set<string>()
  const runs: { cwd: string; argv: string[] }[] = []
  let inFlight = 0
  let maxInFlight = 0
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === '/repo/.git' || modules.some(m => e.path === `${m}/openspec`) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    if (e.path === '/repo') return { value: [dir('.git'), dir('packages')] }
    if (e.path === '/repo/packages') return { value: names.map(dir) }
    if (modules.includes(e.path)) return { value: [dir('openspec')] }
    const module = modules.find(m => e.path === `${m}/openspec`)
    if (module) return { value: [{ name: 'changes', kind: 'dir', size: 0, mtimeMs: mtime[module] ?? 0, isLink: false }] }
    return { value: [] }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    const cwd = e.init?.cwd ?? ''
    runs.push({ cwd, argv: [...e.argv] })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    // Each run takes a few turns, so the ones started together overlap
    for (let i = 0; i < 5; i++) await Promise.resolve()
    inFlight--
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
  return {
    clock,
    runs,
    openspecIn,
    gitLogs,
    touch: (module: string) => (mtime[`/repo/packages/${module}`] = (mtime[`/repo/packages/${module}`] ?? 0) + 1),
    breakModule: (module: string) => broken.add(`/repo/packages/${module}`),
    maxInFlight: () => maxInFlight,
  }
}
const run = ($: any, args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })
const poll = async (clock: any) => {
  await clock.advance(10000)
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
  const catalogue = repo.openspecIn('catalogue')
  await poll(repo.clock)
  await poll(repo.clock)
  expect(repo.openspecIn('catalogue')).toBeGreaterThan(catalogue)
  expect(repo.openspecIn('paiement')).toBe(paiement)
})

test('a large repository reads a few modules at a time', async ($, on) => {
  const names = Array.from({ length: 12 }, (_, i) => `m${i}`)
  const repo = fakeRepo(on, names)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  // 12 modules, each with its openspec list and status: 24 at once unbounded. Four
  // modules at a time, each with its two openspec runs and a git query, stay well under
  expect(repo.openspecIn('m11')).toBeGreaterThan(0)
  expect(repo.maxInFlight()).toBeLessThanOrEqual(12)
})

test("a change's author is asked of git once, not at every read", async ($, on) => {
  const repo = fakeRepo(on, ['paiement'])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await repo.clock.settle()
  expect(repo.gitLogs()).toBe(1)
  // Forced reads, and a moved file: the change is read again, its author is not
  await run($, '')
  await repo.clock.settle()
  repo.touch('paiement')
  await poll(repo.clock)
  expect(repo.openspecIn('paiement')).toBeGreaterThan(2)
  expect(repo.gitLogs()).toBe(1)
})
