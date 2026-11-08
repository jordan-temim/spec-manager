import { expect, mock, test } from 'claude-code/testing'

// openspec failing in one module shows on that module only; the others still read.
// Only when it fails everywhere does its error take the whole pane
const DIRS: Record<string, string[]> = {
  '/repo': ['.git', 'packages'],
  '/repo/packages': ['paiement', 'catalogue'],
  '/repo/packages/paiement': ['openspec'],
  '/repo/packages/catalogue': ['openspec'],
}
const PANE = { component: 'Pane', requestId: 'spec-manager' } as const
const props = { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } as const

// `missing`: openspec is not installed at all, its runs refused as a missing binary is
const fakeRepo = (on: any, isBroken: (cwd: string) => boolean, missing = false) => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: ['/repo/.git', '/repo/packages/paiement/openspec', '/repo/packages/catalogue/openspec'].includes(e.path),
  }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (DIRS[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    const [cmd, verb, flag] = e.argv
    const cwd = e.init?.cwd ?? ''
    if (cmd === 'git') return { value: { exitCode: 0, stdout: verb === 'config' ? 'me@example.org\n' : '', stderr: '' } }
    if (missing) return { deny: 'spawn openspec ENOENT' }
    if (isBroken(cwd)) return { value: { exitCode: 1, stdout: '', stderr: 'config.yaml: bad schema' } }
    const body = flag === '--specs' || flag === '--archived' || verb === 'status' ? { changes: [], specs: [] } : { changes: [{ name: 'pay-v2', completedTasks: 0, totalTasks: 0 }] }
    return { value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}
const run = ($: any, args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, a module whose openspec fails shows it on its own, the others still read`, async ($, on) => {
    fakeRepo(on, cwd => cwd.endsWith('catalogue'))
    await run($, 'all')
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface, ...PANE, props })
    // The healthy module's card, and the failing one under its own caption
    expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /OPENSPEC FAILED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /bad schema/ })).toBeDefined()
    expect(await ui.find({ key: 'open:/repo/packages/catalogue' })).toBeDefined()
    // Not the whole-pane error: the healthy module is still the pane's
    expect(await ui.find({ type: 'Text', text: /on the PATH|failed in every module/ })).toBe(undefined)
    // Opened, the failing module says why in place of its changes
    await ui.press({ key: 'open:/repo/packages/catalogue' })
    expect(await ui.find({ type: 'Text', text: /openspec: .*bad schema/ })).toBeDefined()
    expect(await ui.find({ key: 'modules:all' })).toBeDefined()
    await ui.unmount()
  })
}

test('when openspec fails in every module, its own error takes the pane', async ($, on) => {
  fakeRepo(on, () => true)
  await run($, 'all')
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', ...PANE, props })
  expect(await ui.find({ type: 'Text', text: /openspec: .*bad schema/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /failed in every module/ })).toBeDefined()
  // It ran: nothing to do with the PATH
  expect(await ui.find({ type: 'Text', text: /on the PATH/ })).toBe(undefined)
  await ui.unmount()
})

test('when openspec is not installed, the pane says to check the PATH', async ($, on) => {
  fakeRepo(on, () => false, true)
  await run($, 'all')
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', ...PANE, props })
  expect(await ui.find({ type: 'Text', text: /on the PATH/ })).toBeDefined()
  await ui.unmount()
})
