import { expect, mock, test } from 'claude-code/testing'

// The help page: opened from "? Help" beside the logo, three tabs, and back to the pane
const fakeRepo = (on: any) => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', '/repo/openspec'].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (e.path === '/repo' ? ['.git', 'openspec'] : []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ changes: [], specs: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on the ${surface}, "? Help" opens the help page, its tabs switch, Back returns`, async ($, on) => {
    fakeRepo(on)
    await $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface, component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    const shown = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
    try {
      expect(await shown(/^CHANGES$/)).toBe(true)
      expect(await shown(/How spec manager works/)).toBe(false)

      await ui.press({ key: 'help:open' })
      // The cycle first: five steps, the pane itself gone
      expect(await shown(/How spec manager works/)).toBe(true)
      expect(await shown(/^\/opsx:propose$/)).toBe(true)
      expect(await shown(/^\/opsx:archive$/)).toBe(true)
      expect(await shown(/^CHANGES$/)).toBe(false)

      await ui.press({ key: 'help-tab:marks' })
      expect(await shown(/^A task for the AI$/)).toBe(true)
      expect(await shown(/^\/opsx:propose$/)).toBe(false)
      // The ↗ is the desktop's alone, as the links it explains
      expect(await shown(/in the Files tab/)).toBe(surface === 'desktop')

      await ui.press({ key: 'help-tab:commands' })
      expect(await shown(/^\/spec-manager <module>$/)).toBe(true)

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
  await $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'terminal', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  try {
    await ui.press({ key: 'help:open' })
    const colorOf = async (n: number) => ((await ui.find({ type: 'Text', text: new RegExp(`^${n}\\.$`) })) as any)?.props?.color
    // propose and build are the AI's; review, your actions and archive yours
    expect([await colorOf(1), await colorOf(2), await colorOf(3), await colorOf(4), await colorOf(5)]).toEqual(['#d97757', '#378ADD', '#d97757', '#378ADD', '#378ADD'])
  } finally {
    await ui.unmount()
  }
})
