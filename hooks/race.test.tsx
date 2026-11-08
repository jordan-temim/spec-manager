import { expect, mock, test } from 'claude-code/testing'

// /spec-manager <module> typed while the session's first look for modules is still
// walking the tree: the command waits for it instead of finding nothing
const MODULE = '/repo/packages/paiement'
let release: () => void = () => undefined
const walked = new Promise<void>(resolve => (release = resolve))

const fakeRepo = (on: any) => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', `${MODULE}/openspec`].includes(e.path) }))
  on('fs.list', async (_: unknown, e: { path: string }) => {
    // The walk below the repository top holds until the test lets it go
    if (e.path === '/repo/packages') await walked
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
}

test('/spec-manager <module> during the first look for modules waits for it', async ($, on) => {
  fakeRepo(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const answer = $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'user' }, presentation: {} })
  release()
  expect((await answer).text).toBe('Showing packages/paiement.')
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
  await run('')
  await isReached
  isArmed = false
  await run('catalogue')
  release()
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
  expect(await ui.find({ key: 'modules:all' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /variants/ })).toBeDefined()
  await ui.unmount()
})
