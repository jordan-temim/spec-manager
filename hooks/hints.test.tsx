import { expect, mock, test } from 'claude-code/testing'

// What the pane says under a change, by the state of its files
const MODULE = '/repo/packages/paiement'
const CHANGE = `${MODULE}/openspec/changes/add-refunds`

// `author`: the change's first commit, as git log gives it; none, the reader's own
const fakeRepo = (on: any, tasks: string, counts: { completedTasks: number; totalTasks: number }, specs: string[], author = '') => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', `${MODULE}/openspec`].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    const names = e.path === '/repo' ? ['.git', 'packages'] : e.path === '/repo/packages' ? ['paiement'] : e.path === MODULE ? ['openspec'] : []
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_: unknown, e: { path: string }) => (e.path === `${CHANGE}/tasks.md` ? { value: tasks } : { deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '' } })
    if (cmd === 'git') return { value: { exitCode: 0, stdout: verb === 'config' ? 'me@example.org\n' : author, stderr: '' } }
    if (flag === '--specs' || flag === '--archived') return out({ specs: [], changes: [] })
    if (verb === 'status') {
      const paths = Object.fromEntries(['proposal', 'design', 'tasks'].map(n => [n, { existingOutputPaths: [`${CHANGE}/${n}.md`] }]))
      const specPaths = specs.map(name => `${CHANGE}/specs/${name}/spec.md`)
      const artifacts = specs.length === 0 ? [{ id: 'specs', status: 'skipped' }] : []
      return out({ changes: [{ changeName: 'add-refunds', artifacts, artifactPaths: { ...paths, specs: { existingOutputPaths: specPaths } } }] })
    }
    return out({ changes: [{ name: 'add-refunds', ...counts }] })
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}
// paiement opened, `check` run on its pane, the pane unmounted whatever the check found
const withPane = async ($: any, check: (ui: any) => Promise<void>) => {
  await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'user' }, presentation: {} })
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
  try {
    await check(ui)
  } finally {
    await ui.unmount()
  }
}

test('ready to archive with no spec to merge: no "will merge 0 specs" line', async ($, on) => {
  fakeRepo(on, '## 1. Docs\n\n- [x] 1.1 Write it\n', { completedTasks: 1, totalTasks: 1 }, [])
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /\/opsx:archive/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Archiving will merge/ })).toBe(undefined)
  })
})

test('ready to archive with specs: the line names them', async ($, on) => {
  fakeRepo(on, '## 1. Data\n\n- [x] 1.1 Table\n', { completedTasks: 1, totalTasks: 1 }, ['refunds'])
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /Archiving will merge 1 spec: refunds/ })).toBeDefined()
  })
})

test('ready to archive with several specs: the count is plural, the names in their order', async ($, on) => {
  fakeRepo(on, '## 1. Data\n\n- [x] 1.1 Table\n', { completedTasks: 1, totalTasks: 1 }, ['refunds', 'payouts'])
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /Archiving will merge 2 specs: refunds · payouts/ })).toBeDefined()
  })
})

test('a plan whose tasks.md has no task does not promise to move on at the first one', async ($, on) => {
  fakeRepo(on, '# Tasks\n\nTo be written.\n', { completedTasks: 0, totalTasks: 0 }, ['refunds'])
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /tasks\.md lists no task yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /first task is checked/ })).toBe(undefined)
  })
})

test('199 of 200 tasks reads 99%, not 100%', async ($, on) => {
  const tasks = '## 1. Work\n\n' + Array.from({ length: 200 }, (_, i) => `- [${i < 199 ? 'x' : ' '}] 1.${i + 1} Task`).join('\n') + '\n'
  fakeRepo(on, tasks, { completedTasks: 199, totalTasks: 200 }, ['refunds'])
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /(^|\D)99%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /100%/ })).toBe(undefined)
  })
})

test("the reader's plan to review waits on the reader, with what to type", async ($, on) => {
  fakeRepo(on, '## 1. Data\n\n- [ ] 1.1 Table\n', { completedTasks: 0, totalTasks: 1 }, ['refunds'])
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /Waiting on you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/opsx:apply/ })).toBeDefined()
  })
})

test("someone else's plan to review says whom it waits on, not what to type", async ($, on) => {
  fakeRepo(on, '## 1. Data\n\n- [ ] 1.1 Table\n', { completedTasks: 0, totalTasks: 1 }, ['refunds'], 'paul@example.org\tPaul\n')
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /Waiting on Paul/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/opsx:apply|first task is checked/ })).toBe(undefined)
  })
})

test("someone else's change ready to archive: no /opsx:archive for the reader", async ($, on) => {
  fakeRepo(on, '## 1. Data\n\n- [x] 1.1 Table\n', { completedTasks: 1, totalTasks: 1 }, ['refunds'], 'paul@example.org\tPaul\n')
  await withPane($, async ui => {
    expect(await ui.find({ type: 'Text', text: /Waiting on Paul/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/opsx:archive/ })).toBe(undefined)
  })
})
