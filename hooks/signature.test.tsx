import { expect, mock, test } from 'claude-code/testing'

import { POLL_MS } from './load'

// A change's spec edited in place moves no folder's time: the pane sees it anyway
const MODULE = '/repo/packages/paiement'
const CHANGE = `${MODULE}/openspec/changes/add-refunds`
const SPEC = `${CHANGE}/specs/refunds/spec.md`

test('a spec edited in place shows its new counts at the next poll', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  // The tree, each entry with its modification time; spec.md's moves below
  const mtime: Record<string, number> = { [SPEC]: 1 }
  const files: Record<string, string> = { [SPEC]: '### Requirement: Full refund\n#### Scenario: Paid order\n' }
  const DIRS: Record<string, [string, 'dir' | 'file'][]> = {
    '/repo': [['.git', 'dir'], ['packages', 'dir']],
    '/repo/packages': [['paiement', 'dir']],
    [MODULE]: [['openspec', 'dir']],
    [`${MODULE}/openspec`]: [['changes', 'dir']],
    [`${MODULE}/openspec/changes`]: [['add-refunds', 'dir'], ['archive', 'dir']],
    [CHANGE]: [['tasks.md', 'file'], ['specs', 'dir']],
    [`${CHANGE}/specs`]: [['refunds', 'dir']],
    [`${CHANGE}/specs/refunds`]: [['spec.md', 'file']],
    // An archived change with its documents, a walk into the archive would list them
    [`${MODULE}/openspec/changes/archive`]: [['2026-01-10-add-invoices', 'dir']],
    [`${MODULE}/openspec/changes/archive/2026-01-10-add-invoices`]: [['tasks.md', 'file'], ['specs', 'dir']],
    [`${MODULE}/openspec/changes/archive/2026-01-10-add-invoices/specs`]: [['invoices', 'dir']],
  }
  const listed: string[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', `${MODULE}/openspec`].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    listed.push(e.path)
    return {
      value: (DIRS[e.path] ?? []).map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: mtime[`${e.path}/${name}`] ?? 0, isLink: false })),
    }
  })
  on('fs.read', (_: unknown, e: { path: string }) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (flag === '--specs' || flag === '--archived') return out({ specs: [], changes: [] })
    if (verb === 'status') {
      const paths = Object.fromEntries(['proposal', 'design', 'tasks'].map(n => [n, { existingOutputPaths: [`${n}.md`] }]))
      return out({ changes: [{ changeName: 'add-refunds', artifactPaths: { ...paths, specs: { existingOutputPaths: [SPEC] } } }] })
    }
    // A plan to review: its digest lists the spec with its counts
    return out({ changes: [{ name: 'add-refunds', completedTasks: 0, totalTasks: 3 }] })
  })
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const counts = async () => {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    const text = (await ui.find({ type: 'Text', text: /req ·/ }))?.text
    await ui.unmount()
    return text
  }

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  // Nothing is read before /spec-manager: the command starts the pane and its polling
  await $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.settle()
  expect(await counts()).toContain('1 req · 1 scen')

  // Edited in place: a requirement more, the folders' times unchanged
  files[SPEC] += '### Requirement: Partial refund\n#### Scenario: Two items\n#### Scenario: One item\n'
  mtime[SPEC] = 2
  await clock.advance(POLL_MS)
  await clock.settle()
  expect(await counts()).toContain('2 req · 3 scen')

  // The archive folder is never opened, nor anything in it: a change archived or taken
  // out moves the archive folder's own time, listed with openspec/changes/
  expect(listed.some(path => path.startsWith(`${MODULE}/openspec/changes/archive`))).toBe(false)
  expect(listed.includes(`${MODULE}/openspec/changes`)).toBe(true)
})
