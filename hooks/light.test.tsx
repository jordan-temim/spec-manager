import { expect, mock, test } from 'claude-code/testing'

// A module opened from the overview is drawn at once from the overview's light read:
// until its full read lands, SPECS and ARCHIVED say "…", never "(none)"
const DIRS: Record<string, string[]> = {
  '/repo': ['.git', 'packages'],
  '/repo/packages': ['paiement', 'catalogue'],
  '/repo/packages/paiement': ['openspec'],
  '/repo/packages/catalogue': ['openspec'],
}

test('a module opened from the overview shows its specs and archives as loading until they are read', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: ['/repo/.git', '/repo/packages/paiement/openspec', '/repo/packages/catalogue/openspec'].includes(e.path),
  }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (DIRS[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  // The full read's specs and archives hold until the test lets them go
  let release: () => void = () => undefined
  const released = new Promise<void>(resolve => (release = resolve))
  on('process.run', async (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb, flag] = e.argv
    const out = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '' } })
    if (cmd === 'git') return { value: { exitCode: 0, stdout: verb === 'config' ? 'me@example.org\n' : '', stderr: '' } }
    if (flag === '--specs') {
      await released
      return out({ specs: [{ id: 'refunds', requirementCount: 3 }] })
    }
    if (flag === '--archived') {
      await released
      return out({ changes: [{ name: 'add-invoices' }, { name: 'add-payouts' }] })
    }
    if (verb === 'status') return out({ changes: [] })
    return out({ changes: [{ name: 'pay-v2', completedTasks: 0, totalTasks: 0 }] })
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const run = (args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'user' }, presentation: {} })
  const pane = () =>
    $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })

  await run('all')
  await clock.settle()
  await run('paiement')
  let ui = await pane()
  expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', text: /SPECS …/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', text: /ARCHIVED …/ })).toBeDefined()
  // Anywhere in the pane, whatever element would draw it
  expect(await ui.find({ type: 'Box', text: /\(none\)/ })).toBe(undefined)
  await ui.unmount()

  release()
  await clock.settle()
  ui = await pane()
  expect(await ui.find({ type: 'Box', text: /SPECS 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', text: /ARCHIVED 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', text: /…/ })).toBe(undefined)
  // The list itself, once opened (SPECS starts closed)
  await ui.press({ key: 'block:specs' })
  expect(await ui.find({ type: 'Text', text: /refunds/ })).toBeDefined()
  await ui.unmount()
})
