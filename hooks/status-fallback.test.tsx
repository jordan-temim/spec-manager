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
// `status`: what openspec status answers, when a test wants it to answer; failing otherwise
const fakeRepo = (on: any, dirs = DIRS, files = FILES, totalTasks = 0, status?: unknown) => {
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
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? 'unknown command' : '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (verb === 'status') return status === undefined ? out('', 1) : out(JSON.stringify(status))
    if (flag === '--specs' || flag === '--archived') return out(JSON.stringify({ specs: [], changes: [] }))
    return out(JSON.stringify({ changes: [{ name: 'add-refunds', completedTasks: 0, totalTasks }] }))
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

// The change folder holding the whole plan: its design and its tasks beside the proposal
const PLAN_DIRS = { ...DIRS, [CHANGE]: [...DIRS[CHANGE]!, ['design.md', 'file'], ['tasks.md', 'file']] as [string, 'dir' | 'file'][] }
// ... and what those two hold: a decision, two tasks not started
const PLAN_FILES = {
  ...FILES,
  [`${CHANGE}/design.md`]: '## Decisions\n\n### D1. Provider API\n',
  [`${CHANGE}/tasks.md`]: '## 1. Data\n\n- [ ] 1.1 Refunds table\n- [ ] 1.2 Index\n',
}
// What openspec status says of a change whose every document is done, `specs` its specs' paths
// (left out of artifactPaths when undefined)
const allDone = (specs?: string[]) => ({
  changes: [
    {
      changeName: 'add-refunds',
      artifacts: ['proposal', 'specs', 'design', 'tasks'].map(id => ({ id, status: 'done' })),
      artifactPaths: {
        ...Object.fromEntries(['proposal', 'design', 'tasks'].map(n => [n, { existingOutputPaths: [`${CHANGE}/${n}.md`] }])),
        ...(specs ? { specs: { existingOutputPaths: specs } } : {}),
      },
    },
  ],
})
// paiement opened, `check` run on its pane on a surface, unmounted whatever the check found
const withPane = async ($: any, surface: 'terminal' | 'desktop', check: (ui: any) => Promise<void>) => {
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface, component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  try {
    await check(ui)
  } finally {
    await ui.unmount()
  }
}
const open = ($: any) => $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

test('when openspec status fails, the steps come from the change folder', async ($, on) => {
  fakeRepo(on)
  await open($)
  for (const surface of ['terminal', 'desktop'] as const) {
    await withPane($, surface, async ui => {
      expect(await ui.find({ type: 'Text', text: /write design/ })).toBeDefined()
      // specs/refunds/spec.md is there: the specs step is done (the terminal draws it as text)
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Text', text: /✓ specs/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /◐ design/ })).toBeDefined()
      }
      expect(await ui.find({ type: 'Text', text: /Review the plan/ })).toBe(undefined)
    })
  }
})

test('when openspec status fails, a folder holding the whole plan is a plan to review', async ($, on) => {
  fakeRepo(on, PLAN_DIRS, PLAN_FILES, 2)
  await open($)
  for (const surface of ['terminal', 'desktop'] as const) {
    await withPane($, surface, async ui => {
      expect(await ui.find({ type: 'Text', text: /Review the plan/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /write design|write tasks/ })).toBe(undefined)
    })
  }
})

test('openspec status naming no spec paths: the plan digest reads them from the change folder', async ($, on) => {
  fakeRepo(on, PLAN_DIRS, PLAN_FILES, 2, allDone())
  await open($)
  await withPane($, 'desktop', async ui => {
    // A plan to review, its digest naming the spec found in specs/refunds/spec.md
    expect(await ui.find({ type: 'Text', text: /Review the plan/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /refunds/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 req · 1 scen/ })).toBeDefined()
  })
})

test('openspec status giving an empty list of spec paths: the change folder is read all the same', async ($, on) => {
  fakeRepo(on, PLAN_DIRS, PLAN_FILES, 2, allDone([]))
  await open($)
  await withPane($, 'desktop', async ui => {
    expect(await ui.find({ type: 'Text', text: /1 req · 1 scen/ })).toBeDefined()
  })
})
