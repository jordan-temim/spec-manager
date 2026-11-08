import { expect, mock, test } from 'claude-code/testing'

// Two sessions in one process, each in its own repository: each finds its own modules
// and opens its own pane, nothing of one leaks into the other
const REPOS: Record<string, string> = { a: '/repo-a', b: '/repo-b' }
const MODULES: Record<string, string> = { '/repo-a': 'paiement', '/repo-b': 'catalogue' }

test('two sessions in one process keep their own modules', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  // The session the next call comes from
  let current = 'a'
  on('session.id', () => ({ value: current }))
  on('session.cwd', () => ({ value: REPOS[current] }))
  const isDir = (path: string) =>
    Object.values(REPOS).some(repo => path === `${repo}/.git` || path === `${repo}/packages/${MODULES[repo]}/openspec`)
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: isDir(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    const repo = Object.values(REPOS).find(r => e.path === r || e.path.startsWith(`${r}/`)) ?? ''
    const names =
      e.path === repo ? ['.git', 'packages'] : e.path === `${repo}/packages` ? [MODULES[repo]] : e.path === `${repo}/packages/${MODULES[repo]}` ? ['openspec'] : []
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  // Each module has one change of its own, named after it: what a pane shows tells whose it is
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    const [cmd, verb, flag] = e.argv
    const change = (e.init?.cwd ?? '').endsWith('catalogue') ? 'catalogue-change' : 'paiement-change'
    const body = verb === 'list' && !flag?.startsWith('--s') && flag !== '--archived'
      ? { changes: [{ name: change, completedTasks: 0, totalTasks: 0 }] }
      : { changes: [], specs: [] }
    const stdout = cmd === 'git' ? (verb === 'config' ? 'me@example.org\n' : '') : JSON.stringify(body)
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  const opened: string[] = []
  on('ui.open', () => {
    opened.push(current)
    return { value: { isPlaced: true } }
  })
  const run = (args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })

  await $.session.start({ cwd: REPOS.a, surface: 'desktop', isInteractive: true })
  await clock.settle()
  current = 'b'
  await $.session.start({ cwd: REPOS.b, surface: 'desktop', isInteractive: true })
  await clock.settle()

  // Each pane opened by itself in its own session. ui.open carries only the pane's id
  // and title, the same for both: what each shows is checked on the drawing below
  expect(opened).toEqual(['a', 'b'])
  const shows = async (text: RegExp) => {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
    const found = (await ui.find({ type: 'Text', text })) !== undefined
    await ui.unmount()
    return found
  }
  // b's pane shows b's module, none of a's
  expect(await shows(/catalogue-change/)).toBe(true)
  expect(await shows(/paiement-change/)).toBe(false)
  // Each command finds its own repository's module, not the other's
  expect((await run('catalogue')).text).toBe('Showing packages/catalogue.')
  expect((await run('paiement')).text).toContain('No OpenSpec module matches')
  current = 'a'
  expect((await run('paiement')).text).toBe('Showing packages/paiement.')
  expect(await shows(/paiement-change/)).toBe(true)
  expect(await shows(/catalogue-change/)).toBe(false)
})
