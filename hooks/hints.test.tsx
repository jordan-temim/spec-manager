import { expect, mock, test } from 'claude-code/testing'

// What the pane says under a change, by the state of its files
const MODULE = '/repo/packages/paiement'
const CHANGE = `${MODULE}/openspec/changes/add-refunds`

// `author`: the change's first commit, as git log gives it; none, the reader's own
// `design`: the change's design.md, none when empty
const fakeRepo = (on: any, tasks: string, counts: { completedTasks: number; totalTasks: number }, specs: string[], author = '', design = '') => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', `${MODULE}/openspec`].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    const names = e.path === '/repo' ? ['.git', 'packages'] : e.path === '/repo/packages' ? ['paiement'] : e.path === MODULE ? ['openspec'] : []
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_: unknown, e: { path: string }) =>
    e.path === `${CHANGE}/tasks.md` ? { value: tasks } : e.path === `${CHANGE}/design.md` && design ? { value: design } : { deny: 'ENOENT' },
  )
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'git') return { value: { exitCode: 0, stdout: verb === 'config' ? 'me@example.org\n' : author, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
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

// A plan under review with one open question in its design
const QUESTION = '## Open Questions\n\n- Keep the order open?\n'
const REVIEW = ['## 1. Data\n\n- [ ] 1.1 Table\n', { completedTasks: 0, totalTasks: 1 }, ['refunds']] as const

for (const [whose, author, color] of [
  ['your own plan', '', '#378ADD'],
  ["someone else's plan", 'ana@example.org\tAna\n', '#8f8d86'],
] as const) {
  test(`open questions on ${whose}: in ${color === '#378ADD' ? 'your blue' : 'grey'}`, async ($, on) => {
    fakeRepo(on, REVIEW[0], REVIEW[1], [...REVIEW[2]], author, QUESTION)
    await withPane($, async ui => {
      const colorOf = async (text: RegExp) => ((await ui.find({ type: 'Text', text })) as any)?.props?.color
      expect(await colorOf(/^⚠ 1 open question to settle$/)).toBe(color)
      expect(await colorOf(/^\? $/)).toBe(color)
    })
  })
}

// Each line of the plan opens the document it was read from by a ↗ beside it (a document
// with nothing in it gives none), on the desktop; the terminal, which opened nothing and
// wrote the whole URL out, shows the labels alone
for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, the plan's labels ${surface === 'desktop' ? 'open their documents' : 'stay plain'}`, async ($, on) => {
    fakeRepo(on, REVIEW[0], REVIEW[1], [...REVIEW[2]], '', '## Decisions\n\n### D1. Provider API\n')
    await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface, component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    try {
      // The markdown a label is drawn with: its words, then the ↗ alone a link to its file
      const markdownOf = async (words: string) => ((await ui.find({ type: 'Markdown', text: new RegExp(`^(\\*\\*)?${words}\\b`) })) as any)?.props
      expect(await ui.find({ type: 'Link' })).toBe(undefined)
      if (surface === 'desktop') {
        expect((await markdownOf('Decisions'))?.text).toBe(`**Decisions** [↗](file://${CHANGE}/design.md)`)
        expect((await markdownOf('Tasks'))?.text).toBe(`**Tasks** [↗](file://${CHANGE}/tasks.md)`)
        expect((await markdownOf('refunds'))?.text).toBe(`refunds [↗](file://${CHANGE}/specs/refunds/spec.md)`)
        // Labels dim as the others, a spec's name in plain text
        expect((await markdownOf('Decisions'))?.dimColor).toBe(true)
        expect((await markdownOf('refunds'))?.dimColor).toBe(false)
        // No proposal.md here: no Why line, so no link to it
        expect(await ui.find({ type: 'Markdown', text: /proposal\.md/ })).toBe(undefined)
      } else {
        expect(await ui.find({ type: 'Markdown' })).toBe(undefined)
        expect(await ui.find({ type: 'Text', text: /↗|file:/ })).toBe(undefined)
        expect(await ui.find({ type: 'Text', text: /^Decisions$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^refunds$/ })).toBeDefined()
      }
    } finally {
      await ui.unmount()
    }
  })
}
