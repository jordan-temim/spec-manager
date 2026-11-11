import { expect, mock, test } from 'claude-code/testing'

// Who made a change, from git: the reader's email, and each change folder's first commit.
// One module, paiement; what git and openspec answer is the test's to set as it goes
const DIRS: Record<string, string[]> = {
  '/repo': ['.git', 'packages'],
  '/repo/packages': ['paiement'],
  '/repo/packages/paiement': ['openspec'],
}

type Git = { email: string; author: string; listed: string[]; archived: string[] }
const repo = (on: any, git: Git) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', '/repo/packages/paiement/openspec'].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (DIRS[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } })
    if (cmd === 'git' && verb === 'config') return git.email ? out(`${git.email}\n`) : out('', 1)
    if (cmd === 'git') return out(git.author)
    const changes = (names: string[]) => out(JSON.stringify({ changes: names.map(name => ({ name, completedTasks: 0, totalTasks: 0 })) }))
    if (flag === '--archived') return changes(git.archived)
    if (flag === '--specs' || verb === 'status') return out(JSON.stringify({ changes: [], specs: [] }))
    return changes(git.listed)
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return clock
}
const run = ($: any, args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })
// The pane, `check` run on it, unmounted whatever the check found
const withPane = async ($: any, check: (ui: any) => Promise<void>) => {
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
  try {
    await check(ui)
  } finally {
    await ui.unmount()
  }
}

// No git email at first: every change reads as the reader's. Once the email is set,
// the next refresh asks again and tells the reader's changes from Paul's
test('a git email set after the first look is picked up', async ($, on) => {
  const git: Git = { email: '', author: 'paul@example.org\tPaul\n', listed: ['pay-v2'], archived: [] }
  const clock = repo(on, git)

  await run($, 'paiement')
  await clock.settle()
  // The change is drawn, tagged as the reader's (the AI's tag, which only the reader's
  // own changes carry), and nobody else's name
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ AI $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Paul/ })).toBe(undefined)
  })

  git.email = 'me@example.org'
  await run($, '')
  await clock.settle()
  // Paul's now, in one drawing: his name, and the reader's AI tag gone
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Paul/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ AI $/ })).toBe(undefined)
  })
})

// A change archived frees its name: one made again under it is asked of git anew, not
// taken for its namesake's
test("a change made again under an archived one's name gets its own author", async ($, on) => {
  const git: Git = { email: 'me@example.org', author: 'paul@example.org\tPaul\n', listed: ['add-refunds'], archived: [] }
  const clock = repo(on, git)

  await run($, 'paiement')
  await clock.settle()
  await withPane($, async ui => expect(await ui.find({ type: 'Text', text: /Paul/ })).toBeDefined())
  // Paul's change archived: out of the active list, into the archive
  git.listed = []
  git.archived = ['2026-11-08-add-refunds']
  await run($, '')
  await clock.settle()
  // The reader makes a change of the same name
  git.listed = ['add-refunds']
  git.author = 'me@example.org\tMe\n'
  await run($, '')
  await clock.settle()
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /add-refunds/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Paul/ })).toBe(undefined)
    // git asked again: the reader's own, with the AI's tag only the reader's changes carry
    expect(await ui.find({ type: 'Text', text: /^ AI $/ })).toBeDefined()
  })
})
