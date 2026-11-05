import { expect, mock, test } from 'claude-code/testing'

// One module, one change half-way through: section 1 done, 2 under way, 3 not started
const MODULE = '/repo/packages/paiement'
const CHANGE = `${MODULE}/openspec/changes/add-refunds`
const TASKS = `## 1. Data

- [x] 1.1 Refunds table

## 2. Provider

- [x] 2.1 Call the refund API
- [ ] 2.2 *(user action)* Add the provider key
- [ ] 2.3 Retry on timeout

## 3. Screens

- [ ] 3.1 Refund button
`

const fakeRepo = (on: any) => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', `${MODULE}/openspec`].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (e.path === '/repo' ? ['.git', 'packages'] : e.path === '/repo/packages' ? ['paiement'] : e.path === MODULE ? ['openspec'] : [])
      .map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_: unknown, e: { path: string }) => (e.path === `${CHANGE}/tasks.md` ? { value: TASKS } : { deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (cmd === 'git') return out(verb === 'config' ? 'me@example.org\n' : 'me@example.org\tMe\n')
    const paths = Object.fromEntries(['proposal', 'specs', 'design', 'tasks'].map(n => [n, { existingOutputPaths: [`${n}.md`] }]))
    if (verb === 'status') return out(JSON.stringify({ changes: [{ changeName: 'add-refunds', artifactPaths: paths }] }))
    if (flag === '--specs') return out(JSON.stringify({ specs: [] }))
    if (flag === '--archived') return out(JSON.stringify({ changes: [] }))
    return out(JSON.stringify({ changes: [{ name: 'add-refunds', completedTasks: 2, totalTasks: 5, lastModified: '2026-10-15T10:00:00Z' }] }))
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

const PANE = { component: 'Pane', requestId: 'spec-manager' } as const
const props = { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, the current section shows its tasks and a press opens or closes any section`, async ($, on) => {
    fakeRepo(on)
    await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'user' }, presentation: {} })
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface, ...PANE, props })
    const shown = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined

    // The section under way is open, done and upcoming ones closed
    expect(await shown(/Call the refund API/)).toBe(true)
    expect(await shown(/Retry on timeout/)).toBe(true)
    expect(await shown(/Refunds table/)).toBe(false)
    expect(await shown(/Refund button/)).toBe(false)

    await ui.press({ key: 'section:add-refunds:3' })
    expect(await shown(/Refund button/)).toBe(true)
    await ui.press({ key: 'section:add-refunds:1' })
    expect(await shown(/Refunds table/)).toBe(true)
    await ui.press({ key: 'section:add-refunds:2' })
    expect(await shown(/Call the refund API/)).toBe(false)
    await ui.press({ key: 'section:add-refunds:3' })
    expect(await shown(/Refund button/)).toBe(false)
    await ui.unmount()
  })
}
