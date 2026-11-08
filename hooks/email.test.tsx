import { expect, mock, test } from 'claude-code/testing'

// No git email at first: every change reads as the reader's. Once the email is set,
// the next refresh asks again and tells the reader's changes from Paul's
const DIRS: Record<string, string[]> = {
  '/repo': ['.git', 'packages'],
  '/repo/packages': ['paiement'],
  '/repo/packages/paiement': ['openspec'],
}

test('a git email set after the first look is picked up', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let email = ''
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', '/repo/packages/paiement/openspec'].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (DIRS[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } })
    if (cmd === 'git' && verb === 'config') return email ? out(`${email}\n`) : out('', 1)
    if (cmd === 'git') return out('paul@example.org\tPaul\n')
    if (flag === '--specs' || flag === '--archived' || verb === 'status') return out(JSON.stringify({ changes: [], specs: [] }))
    return out(JSON.stringify({ changes: [{ name: 'pay-v2', completedTasks: 0, totalTasks: 0 }] }))
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const run = (args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })
  const mount = () =>
    $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
  const shows = async (text: RegExp) => {
    const ui = await mount()
    const found = (await ui.find({ type: 'Text', text })) !== undefined
    await ui.unmount()
    return found
  }

  await run('paiement')
  await clock.settle()
  // The change is drawn, tagged as the reader's (the AI's tag, which only the reader's
  // own changes carry), and nobody else's name
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ AI $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Paul/ })).toBe(undefined)
  await ui.unmount()

  email = 'me@example.org'
  await run('')
  await clock.settle()
  expect(await shows(/Paul/)).toBe(true)
})
