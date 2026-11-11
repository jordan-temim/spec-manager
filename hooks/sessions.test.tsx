import { expect, mock, test } from 'claude-code/testing'

// Sessions in one process: each in its own repository keeps its own modules and pane, and
// one that goes on after /clear keeps its state
const REPOS: Record<string, string> = { a: '/repo-a', b: '/repo-b' }
const MODULES: Record<string, string> = { '/repo-a': 'paiement', '/repo-b': 'catalogue' }
// Each module has one change of its own, named after it: what a pane shows tells whose it is.
// Only from the module's own folder: openspec run anywhere else lists nothing
const CHANGES: Record<string, string> = {
  '/repo-a/packages/paiement': 'paiement-change',
  '/repo-b/packages/catalogue': 'catalogue-change',
}

// The two repositories, the session's id and folder asked of `session` at each call, and
// each pane opening recorded under the id it came from
const fakeRepos = (on: any, session: () => { id: string; cwd: string }) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.id', () => ({ value: session().id }))
  on('session.cwd', () => ({ value: session().cwd }))
  const isDir = (path: string) =>
    Object.values(REPOS).some(repo => path === `${repo}/.git` || path === `${repo}/packages/${MODULES[repo]}/openspec`)
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: isDir(e.path) }))
  // Each repository's folders: its top, its packages/, its one module
  const tree: Record<string, string[]> = Object.fromEntries(
    Object.values(REPOS).flatMap(repo => [
      [repo, ['.git', 'packages']],
      [`${repo}/packages`, [MODULES[repo]]],
      [`${repo}/packages/${MODULES[repo]}`, ['openspec']],
    ]),
  )
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (tree[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    const [cmd, verb, flag] = e.argv
    const change = CHANGES[e.init?.cwd ?? '']
    // `openspec list --json` lists the module's change; specs, archive, status nothing
    const body = change && verb === 'list' && flag === '--json'
      ? { changes: [{ name: change, completedTasks: 0, totalTasks: 0 }] }
      : { changes: [], specs: [] }
    const stdout = cmd === 'git' ? (verb === 'config' ? 'me@example.org\n' : '') : JSON.stringify(body)
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  const opened: string[] = []
  on('ui.open', () => {
    opened.push(session().id)
    return { value: { isPlaced: true } }
  })
  return { clock, opened }
}
const run = async ($: any, args: string) =>
  (await $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })).text
// The first text of the pane matching `text`, drawn as the session now asking sees it
const drawn = async ($: any, text: RegExp) => {
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
  try {
    return (await ui.find({ type: 'Text', text }))?.text
  } finally {
    await ui.unmount()
  }
}

test('two sessions in one process keep their own modules', async ($, on) => {
  // The session the next call comes from
  let current = 'a'
  const { clock, opened } = fakeRepos(on, () => ({ id: current, cwd: REPOS[current] }))

  await $.session.start({ cwd: REPOS.a, surface: 'desktop', isInteractive: true })
  await clock.settle()
  current = 'b'
  await $.session.start({ cwd: REPOS.b, surface: 'desktop', isInteractive: true })
  await clock.settle()

  // Each pane opened by itself in its own session. ui.open carries only the pane's id
  // and title, the same for both: what each shows is checked on the drawing below
  expect(opened).toEqual(['a', 'b'])
  // b's pane shows b's module, none of a's
  expect(await drawn($, /catalogue-change/)).toBeDefined()
  expect(await drawn($, /paiement-change/)).toBe(undefined)
  // Each command finds its own repository's module, not the other's
  expect(await run($, 'catalogue')).toBe('Showing packages/catalogue.')
  expect(await run($, 'paiement')).toContain('No OpenSpec module matches')
  current = 'a'
  expect(await run($, 'paiement')).toBe('Showing packages/paiement.')
  // ... and a's does not know b's module either
  expect(await run($, 'catalogue')).toContain('No OpenSpec module matches')
  expect(await drawn($, /paiement-change/)).toBeDefined()
  expect(await drawn($, /catalogue-change/)).toBe(undefined)
})

// /clear ends the session and the process goes on under a new id, with no new
// session.start: the pane keeps its state and its timers across it
test('after /clear, the pane goes on with its state and its countdown', async ($, on) => {
  let id = 'before-clear'
  const { clock, opened } = fakeRepos(on, () => ({ id, cwd: REPOS.a }))
  const countdown = async () => (await drawn($, /refresh in/))?.match(/refresh in \d+s/)?.[0]

  await $.session.start({ cwd: REPOS.a, surface: 'desktop', isInteractive: true })
  await clock.settle()
  await clock.advance(3000)
  await clock.settle()
  expect(await countdown()).toBe('refresh in 7s')

  // /clear: the session ends, the process goes on under another id
  await $.session.end({ reason: 'clear', sessionId: 'before-clear', resume: { id: 'before-clear' } })
  id = 'after-clear'
  await clock.advance(2000)
  await clock.settle()
  expect(await countdown()).toBe('refresh in 5s')
  // The pane opened once, at the start: /clear does not open it again
  expect(opened).toEqual(['before-clear'])
  // Past the poll, which now runs under the new id: the countdown starts over, and the
  // pane still shows the module's change, read again by that poll
  await clock.advance(6000)
  await clock.settle()
  expect(await countdown()).toBe('refresh in 9s')
  expect(await drawn($, /paiement-change/)).toBeDefined()
  // The command still knows the modules found before
  expect(await run($, 'paiement')).toBe('Showing packages/paiement.')
})

// One session ends while another goes on in the same process: what goes with the first
// leaves the second's modules, pane and poll as they were
test('a session that ends leaves the other one as it was', async ($, on) => {
  let current = 'a'
  const { clock } = fakeRepos(on, () => ({ id: current, cwd: REPOS[current] }))
  const countdown = async () => (await drawn($, /refresh in/))?.match(/refresh in \d+s/)?.[0]

  await $.session.start({ cwd: REPOS.a, surface: 'desktop', isInteractive: true })
  await clock.settle()
  current = 'b'
  await $.session.start({ cwd: REPOS.b, surface: 'desktop', isInteractive: true })
  await clock.settle()
  // a exits
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'a', resume: { id: 'a' } })
  await clock.advance(3000)
  await clock.settle()
  // b goes on: its module, its countdown, its command
  expect(await drawn($, /catalogue-change/)).toBeDefined()
  expect(await countdown()).toBe('refresh in 7s')
  expect(await run($, 'catalogue')).toBe('Showing packages/catalogue.')
})
