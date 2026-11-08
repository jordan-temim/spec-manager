import { expect, mock, test } from 'claude-code/testing'

// `openspec status` fails: the change's documents are read from its folder instead,
// so a plan half written still reads as planning, not as a plan to review
const MODULE = '/repo/packages/paiement'
const CHANGE = `${MODULE}/openspec/changes/add-refunds`
const DIRS: Record<string, [string, 'dir' | 'file'][]> = {
  '/repo': [['.git', 'dir'], ['packages', 'dir']],
  '/repo/packages': [['paiement', 'dir']],
  [MODULE]: [['openspec', 'dir']],
  [CHANGE]: [['proposal.md', 'file'], ['specs', 'dir']],
  [`${CHANGE}/specs`]: [['refunds', 'dir']],
}

test('when openspec status fails, the steps come from the change folder', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  // A path exists when it is a listed folder or an entry of one, as fs.list says
  on('fs.exists', (_: unknown, e: { path: string }) => {
    const parent = e.path.slice(0, e.path.lastIndexOf('/'))
    const name = e.path.slice(e.path.lastIndexOf('/') + 1)
    return { value: e.path in DIRS || (DIRS[parent] ?? []).some(([entry]) => entry === name) }
  })
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (DIRS[e.path] ?? []).map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? 'unknown command' : '' } })
    if (cmd === 'git') return out(verb === 'config' ? 'me@example.org\n' : '')
    if (verb === 'status') return out('', 1)
    if (flag === '--specs' || flag === '--archived') return out(JSON.stringify({ specs: [], changes: [] }))
    return out(JSON.stringify({ changes: [{ name: 'add-refunds', completedTasks: 0, totalTasks: 0 }] }))
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'user' }, presentation: {} })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface, component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
    expect(await ui.find({ type: 'Text', text: /write design/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Review the plan/ })).toBe(undefined)
    await ui.unmount()
  }
})
