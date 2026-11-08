import { expect, mock, test } from 'claude-code/testing'

// `openspec status` fails: the change's documents are read from its folder instead,
// so a plan half written still reads as planning, not as a plan to review
const MODULE = '/repo/packages/paiement'
const CHANGE = `${MODULE}/openspec/changes/add-refunds`
const DIRS: Record<string, [string, 'dir' | 'file'][]> = {
  '/repo': [['.git', 'dir'], ['packages', 'dir']],
  '/repo/packages': [['paiement', 'dir']],
  [MODULE]: [['openspec', 'dir']],
  [`${MODULE}/openspec`]: [['changes', 'dir']],
  [`${MODULE}/openspec/changes`]: [['add-refunds', 'dir']],
  [CHANGE]: [['proposal.md', 'file'], ['specs', 'dir']],
  [`${CHANGE}/specs`]: [['refunds', 'dir']],
  [`${CHANGE}/specs/refunds`]: [['spec.md', 'file']],
}
// What the listed files hold: fs.read agrees with fs.list and fs.exists
const FILES: Record<string, string> = {
  [`${CHANGE}/proposal.md`]: '# Proposal\n\n## Why\n\nRefunds are manual.\n',
  [`${CHANGE}/specs/refunds/spec.md`]: '### Requirement: Refund\n#### Scenario: Full\n',
}

// The repository above, its change folder holding `dirs` and `files`, openspec status failing
const fakeRepo = (on: any, dirs = DIRS, files = FILES, totalTasks = 0) => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  // A path exists when it is a listed folder or an entry of one, as fs.list says
  on('fs.exists', (_: unknown, e: { path: string }) => {
    const parent = e.path.slice(0, e.path.lastIndexOf('/'))
    const name = e.path.slice(e.path.lastIndexOf('/') + 1)
    return { value: e.path in dirs || (dirs[parent] ?? []).some(([entry]) => entry === name) }
  })
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (dirs[e.path] ?? []).map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_: unknown, e: { path: string }) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? 'unknown command' : '' } })
    if (cmd === 'git') return out(verb === 'config' ? 'me@example.org\n' : '')
    if (verb === 'status') return out('', 1)
    if (flag === '--specs' || flag === '--archived') return out(JSON.stringify({ specs: [], changes: [] }))
    return out(JSON.stringify({ changes: [{ name: 'add-refunds', completedTasks: 0, totalTasks }] }))
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('when openspec status fails, the steps come from the change folder', async ($, on) => {
  fakeRepo(on)
  await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'user' }, presentation: {} })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface, component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
    expect(await ui.find({ type: 'Text', text: /write design/ })).toBeDefined()
    // specs/refunds/spec.md is there: the specs step is done (the terminal draws it as text)
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /✓ specs/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /◐ design/ })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /Review the plan/ })).toBe(undefined)
    await ui.unmount()
  }
})

test('when openspec status fails, a folder holding the whole plan is a plan to review', async ($, on) => {
  const dirs = { ...DIRS, [CHANGE]: [...DIRS[CHANGE], ['design.md', 'file'], ['tasks.md', 'file']] as [string, 'dir' | 'file'][] }
  const files = {
    ...FILES,
    [`${CHANGE}/design.md`]: '## Decisions\n\n### D1. Provider API\n',
    [`${CHANGE}/tasks.md`]: '## 1. Data\n\n- [ ] 1.1 Refunds table\n- [ ] 1.2 Index\n',
  }
  fakeRepo(on, dirs, files, 2)
  await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'user' }, presentation: {} })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface, component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
    expect(await ui.find({ type: 'Text', text: /Review the plan/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /write design|write tasks/ })).toBe(undefined)
    await ui.unmount()
  }
})
