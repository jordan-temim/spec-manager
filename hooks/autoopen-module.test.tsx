import { expect, mock, test } from 'claude-code/testing'

// A session opens the pane, and reads the repository, only once /spec-manager is run
const session = (on: any, dirs: Record<string, string[]>, opened: string[], listed: string[] = []) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === '/repo/.git' }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    listed.push(e.path)
    return { value: (dirs[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ changes: [], specs: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  // The engine's own session start and command registry, beneath the plugin
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  return clock
}
const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

test('a session start opens no pane and reads nothing, even where there is an OpenSpec module', async ($, on) => {
  const opened: string[] = []
  const listed: string[] = []
  const clock = session(on, { '/repo': ['.git', 'openspec'] }, opened, listed)
  await start($)
  await clock.settle()
  // Long after the start, still nothing: no pane, no folder listed
  await clock.advance(10 * 60000)
  await clock.settle()
  expect(opened).toEqual([])
  expect(listed).toEqual([])
  // /spec-manager opens it, and only then is the repository looked at
  await $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.settle()
  expect(opened).toEqual(['spec-manager'])
  expect(listed).toContain('/repo')
})
