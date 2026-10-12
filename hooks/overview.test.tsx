import { expect, mock, test } from 'claude-code/testing'

// A repository with two OpenSpec modules, two levels down
const DIRS: Record<string, [string, 'dir' | 'file'][]> = {
  '/repo': [['.git', 'dir'], ['packages', 'dir'], ['README.md', 'file']],
  '/repo/packages': [['paiement', 'dir'], ['catalogue', 'dir']],
  '/repo/packages/paiement': [['openspec', 'dir'], ['src', 'dir']],
  '/repo/packages/catalogue': [['openspec', 'dir']],
}
const EXISTING = new Set(['/repo/.git', '/repo/packages/paiement/openspec', '/repo/packages/catalogue/openspec'])

const OPENSPEC: Record<string, Record<string, unknown>> = {
  '/repo/packages/paiement': {
    list: {
      changes: [
        { name: 'pay-v2', completedTasks: 1, totalTasks: 3, lastModified: '2026-10-10T10:00:00Z' },
        { name: 'pay-later', completedTasks: 0, totalTasks: 0, lastModified: '2026-10-09T10:00:00Z' },
      ],
    },
    status: {
      changes: [
        {
          changeName: 'pay-v2',
          artifactPaths: Object.fromEntries(
            ['proposal', 'specs', 'design', 'tasks'].map(name => [name, { existingOutputPaths: [`${name}.md`] }]),
          ),
        },
      ],
    },
  },
  '/repo/packages/catalogue': {
    list: { changes: [{ name: 'variants', completedTasks: 0, totalTasks: 0, lastModified: '2026-10-09T10:00:00Z' }] },
    status: { changes: [{ changeName: 'variants', artifactPaths: { proposal: { existingOutputPaths: ['p.md'] } } }] },
  },
}

// git: the reader is me@example.org; Paul created the catalogue change
const git = (argv: readonly string[]) => {
  if (argv[1] === 'config') return 'me@example.org\n'
  const dir = argv[argv.length - 1] ?? ''
  return dir.includes('catalogue') ? 'paul@example.org\tPaul\n' : 'me@example.org\tMe\n'
}

const fakeRepo = (on: any) => {
  mock.clock(on)
  mock.store(on)
  // A hook beneath the plugins answers a call on $ with { value } (or refuses it with { deny })
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: EXISTING.has(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (DIRS[e.path] ?? []).map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: git(e.argv), stderr: '' } }
    const [, verb, flag] = e.argv
    const answers = OPENSPEC[e.init?.cwd ?? ''] ?? {}
    const body = flag === '--specs' ? { specs: [] } : flag === '--archived' ? { changes: [] } : answers[verb ?? '']
    return { value: { exitCode: 0, stdout: JSON.stringify(body ?? { changes: [] }), stderr: '' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

const runCommand = ($: any, args: string) =>
  $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })

const PANE = { component: 'Pane', requestId: 'spec-manager' } as const
const props = { title: 'OpenSpec', isFocused: false, bodyColumns: 60, placement: 'dock' } as const

test('at the repo top, the overview lists both modules and a press opens one', async ($, on) => {
  fakeRepo(on)
  await runCommand($, 'all')
  for (const surface of ['terminal', 'desktop'] as const) {
    await runCommand($, 'all')
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface, ...PANE, props })
    expect(await ui.find({ type: 'Text', text: /MODULES/ })).toBeDefined()
    expect(await ui.find({ key: 'open:/repo/packages/paiement' })).toBeDefined()
    expect(await ui.find({ key: 'open:/repo/packages/catalogue' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /MINE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /OTHERS/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Paul/ })).toBeDefined()
    await ui.press({ key: 'open:/repo/packages/paiement' })
    expect(await ui.find({ type: 'Text', text: /1 other module/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
    await ui.press({ key: 'modules:all' })
    expect(await ui.find({ type: 'Text', text: /MODULES/ })).toBeDefined()
    // The card's Open button opens it in one press too
    await ui.press({ key: 'open:/repo/packages/catalogue' })
    expect(await ui.find({ type: 'Text', text: /variants/ })).toBeDefined()
    expect(await ui.find({ key: 'modules:all' })).toBeDefined()
    await ui.press({ key: 'modules:all' })
    await ui.unmount()
  }
})

test('/spec-manager <module> opens that module', async ($, on) => {
  fakeRepo(on)
  const answer = await runCommand($, 'catalogue')
  expect(answer.text).toBe('Showing packages/catalogue.')
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', ...PANE, props })
  // Paul's change: his name in place of YOU / AI, and nothing waiting on the reader
  expect(await ui.find({ type: 'Text', text: /Paul/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Waiting on you/ })).toBe(undefined)
  await ui.unmount()
})

test('the terminal draws the stepper as text', async ($, on) => {
  fakeRepo(on)
  await runCommand($, 'paiement')
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'terminal', ...PANE, props })
  expect(await ui.find({ type: 'Text', text: /✓ proposal/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◐ apply/ })).toBeDefined()
})

test('on the terminal, the rule between changes fits the frame', async ($, on) => {
  fakeRepo(on)
  await runCommand($, 'paiement')
  // A terminal far wider than the pane, as with a docked pane
  const viewport = { columns: 200, rows: 50, isFullscreen: true }
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'terminal', ...PANE, props, viewport } as any)
  const rule = await ui.find({ type: 'Text', text: /^─+$/ })
  expect(rule).toBeDefined()
  expect(JSON.stringify(rule).match(/─+/)![0].length).toBeLessThanOrEqual(props.bodyColumns - 4)
})
