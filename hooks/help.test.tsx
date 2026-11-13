import { expect, mock, test } from 'claude-code/testing'

import { POLL_MS } from './load'

// The help page: opened from "? Help" beside the logo, three tabs, and back to the pane

// A repository at /repo holding these modules (the repo top itself by default), none with
// a change
const fakeRepo = (on: any, modules = ['/repo']) => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', ...modules.map(m => `${m}/openspec`)].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    // A folder's entries: the next step down to each module, a module's openspec/
    const below = modules.filter(m => m.startsWith(`${e.path}/`)).map(m => m.slice(e.path.length + 1).split('/')[0]!)
    const names = [...(e.path === '/repo' ? ['.git'] : []), ...new Set(below), ...(modules.includes(e.path) ? ['openspec'] : [])]
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ changes: [], specs: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}
// /spec-manager with these arguments, and the pane as a surface draws it
const run = ($: any, args = '') => $.command.run({ command: 'spec-manager', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
const mountPane = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'spec-manager', surface, component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, "? Help" opens the help page, its tabs switch, Back returns`, async ($, on) => {
    fakeRepo(on)
    await run($)
    const ui = await mountPane($, surface)
    const shown = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
    try {
      expect(await shown(/^CHANGES$/)).toBe(true)
      expect(await shown(/How spec manager works/)).toBe(false)

      await ui.press({ key: 'help:open' })
      // The cycle first: every /opsx step, the optional ones said so, the pane itself gone
      expect(await shown(/How spec manager works/)).toBe(true)
      for (const command of ['propose', 'apply', 'archive']) expect(await shown(new RegExp(`^/opsx:${command}$`))).toBe(true)
      for (const command of ['explore', 'update', 'sync']) expect(await shown(new RegExp(`^/opsx:${command} · optional$`))).toBe(true)
      expect(await shown(/^CHANGES$/)).toBe(false)

      await ui.press({ key: 'help-tab:marks' })
      expect(await shown(/^A task to do: the AI builds them all$/)).toBe(true)
      expect(await shown(/task for you/i)).toBe(false)
      expect(await shown(/^\/opsx:propose$/)).toBe(false)
      // The ↗ is the desktop's alone, as the links it explains
      expect(await shown(/in the Files tab/)).toBe(surface === 'desktop')

      await ui.press({ key: 'help-tab:commands' })
      expect(await shown(/^\/spec-manager <module>$/)).toBe(true)
      // The interval it states is the poll's own, not a number written beside it
      expect(await shown(new RegExp(`every ${POLL_MS / 1000} s,`))).toBe(true)

      await ui.press({ key: 'help:back' })
      expect(await shown(/^CHANGES$/)).toBe(true)
      expect(await shown(/How spec manager works/)).toBe(false)
    } finally {
      await ui.unmount()
    }
  })
}

test('each step of the cycle is numbered in the colour of who takes it', async ($, on) => {
  fakeRepo(on)
  await run($)
  const ui = await mountPane($, 'terminal')
  try {
    await ui.press({ key: 'help:open' })
    const colorOf = async (n: number) => ((await ui.find({ type: 'Text', text: new RegExp(`^${n}\\.$`) })) as any)?.props?.color
    const AI = '#d97757'
    const YOU = '#378ADD'
    // explore, review and archive are yours; propose, update, apply and sync the AI's
    const colors = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(colorOf))
    expect(colors).toEqual([YOU, AI, YOU, AI, AI, AI, YOU])
    expect(await colorOf(8)).toBe(undefined)
  } finally {
    await ui.unmount()
  }
})

test('/spec-manager closes the help page: the module or overview it asks for shows', async ($, on) => {
  fakeRepo(on, ['/repo/packages/paiement', '/repo/packages/catalogue'])
  await run($, 'all')
  const ui = await mountPane($, 'desktop')
  const shown = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
  try {
    // A module, the other, the overview, each after another view, so a command that kept the
    // last one fails; with no argument, the view last chosen comes back, a module's or the
    // overview, as the command does at session start
    const steps = [['paiement', 'paiement'], ['', 'paiement'], ['catalogue', 'catalogue'], ['all', ''], ['', '']] as const
    for (const [args, module] of steps) {
      await ui.press({ key: 'help:open' })
      expect(await shown(/How spec manager works/)).toBe(true)
      await run($, args)
      expect(await shown(/How spec manager works/)).toBe(false)
      // A module's own view names it (by its path from the repo top) among the others; the
      // overview lists them all
      for (const name of ['paiement', 'catalogue']) expect(await shown(new RegExp(`^packages/${name}$`))).toBe(!module || module === name)
      expect(await shown(/^ · 1 other module$/)).toBe(module !== '')
      expect(await shown(/MODULES/)).toBe(module === '')
      expect((await ui.find({ key: 'modules:all' })) !== undefined).toBe(module !== '')
    }
  } finally {
    await ui.unmount()
  }
})

test("a step's number stands beside its words, not above them", async ($, on) => {
  fakeRepo(on)
  await run($)
  const ui = await mountPane($, 'terminal')
  try {
    await ui.press({ key: 'help:open' })
    // The card's row holds the number and the words as two children of its own: grouped in
    // one column, the number would sit above the title
    const step = await ui.find({ key: 'help-step:0' })
    expect(step?.props.flexDirection).toBe('row')
    expect(step?.children.map((child: { type?: string }) => child.type)).toEqual(['Text', 'Box'])
  } finally {
    await ui.unmount()
  }
})
