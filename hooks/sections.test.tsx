import { expect, mock, test } from 'claude-code/testing'

// One module, one change half-way through: section 1 done, 2 under way, 3 not started
const MODULE = '/repo/packages/paiement'
const CHANGE = `${MODULE}/openspec/changes/add-refunds`
const TASKS = `## 1. Data

- [x] 1.1 Refunds table

## 2. Provider

- [x] 2.1 Call the refund API
- [ ] 2.2 Add the provider key
- [ ] 2.3 Retry on timeout

## 3. Screens

- [ ] 3.1 Refund button
`

// The change's tasks.md; openspec's counts follow from it
const fakeRepo = (on: any, tasks = TASKS) => {
  const completedTasks = (tasks.match(/- \[x\]/g) ?? []).length
  const totalTasks = (tasks.match(/- \[[ x]\]/g) ?? []).length
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', `${MODULE}/openspec`].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (e.path === '/repo' ? ['.git', 'packages'] : e.path === '/repo/packages' ? ['paiement'] : e.path === MODULE ? ['openspec'] : [])
      .map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_: unknown, e: { path: string }) => (e.path === `${CHANGE}/tasks.md` ? { value: tasks } : { deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'git') return out(verb === 'config' ? 'me@example.org\n' : 'me@example.org\tMe\n')
    const paths = Object.fromEntries(['proposal', 'specs', 'design', 'tasks'].map(n => [n, { existingOutputPaths: [`${n}.md`] }]))
    if (verb === 'status') return out(JSON.stringify({ changes: [{ changeName: 'add-refunds', artifactPaths: paths }] }))
    if (flag === '--specs') return out(JSON.stringify({ specs: [{ id: 'invoices', requirementCount: 4 }, { id: 'payouts', requirementCount: 2 }] }))
    if (flag === '--archived') return out(JSON.stringify({ changes: [{ name: 'add-invoices' }] }))
    return out(JSON.stringify({ changes: [{ name: 'add-refunds', completedTasks, totalTasks, lastModified: '2026-10-15T10:00:00Z' }] }))
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

// A section's chevron: the module's path, the change, the section's number
const sectionKey = (num: number) => `section:${MODULE}:add-refunds:${num}`
const PANE = { component: 'Pane', requestId: 'spec-manager' } as const
const props = { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

// The paiement module open on a surface, and whether a text is drawn on it
const mount = async ($: any, on: any, surface: 'terminal' | 'desktop', tasks = TASKS) => {
  fakeRepo(on, tasks)
  await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface, ...PANE, props })
  const shown = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
  return { ui, shown }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, the current section shows its tasks and a press opens or closes any section`, async ($, on) => {
    const { ui, shown } = await mount($, on, surface)

    // The section under way is open, done and upcoming ones closed
    expect(await shown(/Call the refund API/)).toBe(true)
    expect(await shown(/Retry on timeout/)).toBe(true)
    // Its open tasks by their section marks: 2.2 also shows, unmarked, under "AI next",
    // so its text alone cannot say the section is shut
    expect(await shown(/◦ 2\.2/)).toBe(true)
    expect(await shown(/◦ 2\.3/)).toBe(true)
    expect(await shown(/Refunds table/)).toBe(false)
    expect(await shown(/Refund button/)).toBe(false)

    await ui.press({ key: sectionKey(3) })
    expect(await shown(/Refund button/)).toBe(true)
    await ui.press({ key: sectionKey(1) })
    expect(await shown(/Refunds table/)).toBe(true)
    // A done task reads with its ✓: the checks for its absence elsewhere mean something
    expect(await shown(/✓ 1\.1/)).toBe(true)
    // Not an accordion: opening one leaves the others as they were
    expect(await shown(/Refund button/)).toBe(true)
    // ... and a press closes any of them, a done one included
    await ui.press({ key: sectionKey(1) })
    expect(await shown(/Refunds table/)).toBe(false)
    expect(await shown(/Refund button/)).toBe(true)
    await ui.press({ key: sectionKey(2) })
    expect(await shown(/Call the refund API/)).toBe(false)
    expect(await shown(/◦ 2\.2/)).toBe(false)
    expect(await shown(/◦ 2\.3/)).toBe(false)
    await ui.press({ key: sectionKey(3) })
    expect(await shown(/Refund button/)).toBe(false)
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, SPECS and ARCHIVED start closed and a press opens them`, async ($, on) => {
    const { ui, shown } = await mount($, on, surface)

    // Headings and counts only
    expect(await ui.find({ type: 'Box', text: /SPECS 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Box', text: /ARCHIVED 1/ })).toBeDefined()
    expect(await shown(/payouts/)).toBe(false)
    expect(await shown(/add-invoices/)).toBe(false)

    await ui.press({ key: 'block:specs' })
    expect(await shown(/payouts/)).toBe(true)
    expect(await shown(/add-invoices/)).toBe(false)
    await ui.press({ key: 'block:archived' })
    expect(await shown(/add-invoices/)).toBe(true)
    // Each block on its own: SPECS stays open
    expect(await shown(/payouts/)).toBe(true)
    await ui.press({ key: 'block:specs' })
    expect(await shown(/payouts/)).toBe(false)
    await ui.unmount()
  })
}

// Which section opens by itself is the first one not done, whatever came before it.
// (All done is ready to archive and none started a plan to review: neither lists sections)
for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, an untouched section after a done one is the one open`, async ($, on) => {
    const tasks = '## 1. Data\n\n- [x] 1.1 Refunds table\n\n## 2. Provider\n\n- [ ] 2.1 Call the refund API\n- [ ] 2.2 Retry\n\n## 3. Screens\n\n- [ ] 3.1 Refund button\n'
    const { ui, shown } = await mount($, on, surface, tasks)
    expect(await shown(/◦ 2\.1/)).toBe(true)
    expect(await shown(/◦ 2\.2/)).toBe(true)
    expect(await shown(/✓ 1\.1/)).toBe(false)
    expect(await shown(/◦ 3\.1/)).toBe(false)
    // The done section opened by hand shows its task, marked done
    await ui.press({ key: sectionKey(1) })
    expect(await shown(/✓ 1\.1/)).toBe(true)
    await ui.unmount()
  })

  test(`on the ${surface}, a section left unfinished stays the open one when a later one is done`, async ($, on) => {
    const tasks = '## 1. Data\n\n- [x] 1.1 Refunds table\n- [ ] 1.2 Index\n\n## 2. Provider\n\n- [x] 2.1 Call the refund API\n\n## 3. Screens\n\n- [ ] 3.1 Refund button\n'
    const { ui, shown } = await mount($, on, surface, tasks)
    expect(await shown(/◦ 1\.2/)).toBe(true)
    expect(await shown(/✓ 2\.1/)).toBe(false)
    expect(await shown(/◦ 3\.1/)).toBe(false)
    await ui.press({ key: sectionKey(2) })
    expect(await shown(/✓ 2\.1/)).toBe(true)
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, a section's marks: open tasks in the AI's terracotta, done ones grey`, async ($, on) => {
    const { ui } = await mount($, on, surface)
    await ui.press({ key: sectionKey(1) })
    const colorOf = async (text: RegExp) => ((await ui.find({ type: 'Text', text })) as any)?.props?.color
    expect(await colorOf(/◦ 2\.3/)).toBe('#d97757')
    expect(await colorOf(/✓ 1\.1/)).toBe('#8f8d86')
    await ui.unmount()
  })
}
