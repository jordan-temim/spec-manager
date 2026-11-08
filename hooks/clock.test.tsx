import { expect, mock, test } from 'claude-code/testing'

// The countdown moves every second while the pane is shown, and not while it is hidden:
// each move redraws the whole pane
test('the clock moves only while the pane is shown', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let isShown = false
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', '/repo/openspec'].includes(e.path) }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (e.path === '/repo' ? ['.git', 'openspec'] : []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ changes: [], specs: [] }), stderr: '' } }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'spec-manager', title: 'Spec Manager', isShown, isFocused: false, isPlaced: true }] }))
  const countdown = async () => {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } })
    const text = (await ui.find({ type: 'Text', text: /refresh in/ }))?.text
    await ui.unmount()
    return text?.match(/refresh in \d+s/)?.[0]
  }

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const atStart = await countdown()
  expect(atStart).toBe('refresh in 10s')

  // Hidden: three seconds pass, nothing is redrawn
  await clock.advance(3000)
  await clock.settle()
  expect(await countdown()).toBe(atStart)

  // Shown: the next second moves it
  isShown = true
  await clock.advance(1000)
  await clock.settle()
  expect(await countdown()).toBe('refresh in 6s')
})
