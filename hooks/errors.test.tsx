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
const props = { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

// What goes wrong, by folder: `isBroken`, openspec fails there; `isMissing`, openspec is
// not installed at all; `notJson`, openspec list there prints a notice in place of JSON
type Trouble = { isBroken?: (cwd: string) => boolean; isMissing?: boolean; notJson?: (cwd: string) => boolean }
const fakeRepo = (on: any, { isBroken = () => false, isMissing = false, notJson = () => false }: Trouble) => {
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
    if (cmd === 'git') return { value: { exitCode: 0, stdout: verb === 'config' ? 'me@example.org\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (isMissing) return { deny: 'spawn openspec ENOENT' }
    if (verb === 'list' && flag === '--json' && notJson(cwd)) return { value: { exitCode: 0, stdout: 'A new version of openspec is available\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (isBroken(cwd)) return { value: { exitCode: 1, stdout: '', stderr: 'config.yaml: bad schema', isStdoutTruncated: false, isStderrTruncated: false } }
    const body = flag === '--specs' || flag === '--archived' || verb === 'status' ? { changes: [], specs: [] } : { changes: [{ name: 'pay-v2', completedTasks: 0, totalTasks: 0 }] }
    return { value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}
const run = ($: any, args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

// The pane on a surface, `check` run on it, unmounted whatever the check found
const withPane = async ($: any, surface: 'terminal' | 'desktop', check: (ui: any) => Promise<void>) => {
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface, ...PANE, props })
  try {
    await check(ui)
  } finally {
    await ui.unmount()
  }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, a module whose openspec fails shows it on its own, the others still read`, async ($, on) => {
    fakeRepo(on, { isBroken: cwd => cwd.endsWith('catalogue') })
    await run($, 'all')
    await withPane($, surface, async ui => {
      // The healthy module's card, and the failing one under its own caption
      expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /OPENSPEC FAILED/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /bad schema/ })).toBeDefined()
      expect(await ui.find({ key: 'open:/repo/packages/catalogue' })).toBeDefined()
      // Not the whole-pane error: the healthy module is still the pane's
      expect(await ui.find({ type: 'Text', text: /on the PATH|failed in every module/ })).toBe(undefined)
      // Opened, the failing module says why in place of its changes
      await ui.press({ key: 'open:/repo/packages/catalogue' })
      // The module's own view now: no overview card left, its error in place of its changes
      expect(await ui.find({ key: 'open:/repo/packages/catalogue' })).toBe(undefined)
      expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBe(undefined)
      expect(await ui.find({ type: 'Text', text: /openspec: .*bad schema/ })).toBeDefined()
      expect(await ui.find({ key: 'modules:all' })).toBeDefined()
      // Its specs and archive could not be read: no count, and no "(none)" claiming there are none
      expect(await ui.find({ type: 'Box', text: /SPECS \?/ })).toBeDefined()
      expect(await ui.find({ type: 'Box', text: /ARCHIVED \?/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\(none\)/ })).toBe(undefined)
    })
  })

  test(`on the ${surface}, when openspec fails in every module, its own error takes the pane`, async ($, on) => {
    fakeRepo(on, { isBroken: () => true })
    await run($, 'all')
    await withPane($, surface, async ui => {
      expect(await ui.find({ type: 'Text', text: /openspec: .*bad schema/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /failed in every module/ })).toBeDefined()
      // It ran: nothing to do with the PATH
      expect(await ui.find({ type: 'Text', text: /on the PATH/ })).toBe(undefined)
    })
  })

  test(`on the ${surface}, when openspec is not installed, the pane says to check the PATH`, async ($, on) => {
    fakeRepo(on, { isMissing: true })
    await run($, 'all')
    await withPane($, surface, async ui => {
      expect(await ui.find({ type: 'Text', text: /on the PATH/ })).toBeDefined()
      // Not found is not "ran and failed"
      expect(await ui.find({ type: 'Text', text: /failed in every module/ })).toBe(undefined)
    })
  })

  test(`on the ${surface}, openspec answering no JSON in every module takes the pane, without the PATH hint`, async ($, on) => {
    fakeRepo(on, { notJson: () => true })
    await run($, 'all')
    await withPane($, surface, async ui => {
      expect(await ui.find({ type: 'Text', text: /openspec: openspec list gave no JSON/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /failed in every module/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /on the PATH/ })).toBe(undefined)
    })
  })

  test(`on the ${surface}, openspec answering something other than JSON says which command, and what it said`, async ($, on) => {
    fakeRepo(on, { notJson: cwd => cwd.endsWith('catalogue') })
    await run($, 'all')
    await withPane($, surface, async ui => {
      // The text holds the whole message, whatever of it the surface has room to draw
      expect(await ui.find({ type: 'Text', text: /openspec list gave no JSON: A new version of openspec is available/ })).toBeDefined()
      // catalogue's alone: paiement still reads, and the pane is not taken by a whole error
      expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /failed in every module|on the PATH/ })).toBe(undefined)
      // ... it stands under catalogue's own caption, and catalogue's view says it
      expect(await ui.find({ type: 'Text', text: /OPENSPEC FAILED/ })).toBeDefined()
      await ui.press({ key: 'open:/repo/packages/catalogue' })
      expect(await ui.find({ type: 'Text', text: /openspec: openspec list gave no JSON/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBe(undefined)
    })
  })
}
