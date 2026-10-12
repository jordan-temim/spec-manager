import { expect, mock, test } from 'claude-code/testing'

// A session opens the pane by itself only where there is an OpenSpec module to show
const session = (on: any, dirs: Record<string, string[]>, opened: string[]) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path === '/repo/.git' }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: (dirs[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ changes: [], specs: [] }), stderr: '' } }))
  // The engine's own session start and command registry, beneath the plugin
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  return clock
}
const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

test('no pane at session start in a repository without openspec/', async ($, on) => {
  const opened: string[] = []
  const clock = session(on, { '/repo': ['.git', 'src'] }, opened)
  await start($)
  // Let the first refresh, started unawaited, run its course
  await clock.settle()
  expect(opened).toEqual([])
  // /spec-manager still opens it, to say there is nothing to show
  await $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'user' }, presentation: {} } as any)
  await clock.settle()
  expect(opened).toEqual(['spec-manager'])
})
