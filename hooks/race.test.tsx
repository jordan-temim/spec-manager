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
