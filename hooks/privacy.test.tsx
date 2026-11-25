import { expect, mock, test } from 'claude-code/testing'

// Spec Manager reads OpenSpec files, runs openspec alone (never git), and nothing of the conversation. This
// test runs a whole session against a fake repository, records every call the plugin
// makes outside itself, and fails on anything beyond that.

const REPO = '/repo'
const MODULE = '/repo/packages/paiement'
const CHANGE = `${MODULE}/openspec/changes/add-refunds`

const DIRS: Record<string, [string, 'dir' | 'file'][]> = {
  '/repo': [['.git', 'dir'], ['packages', 'dir']],
  '/repo/packages': [['paiement', 'dir']],
  [MODULE]: [['openspec', 'dir'], ['src', 'dir']],
  [CHANGE]: [['proposal.md', 'file'], ['design.md', 'file'], ['tasks.md', 'file'], ['specs', 'dir']],
  [`${CHANGE}/specs`]: [['refunds', 'dir']],
  [`${CHANGE}/specs/refunds`]: [['spec.md', 'file']],
}
const EXISTING = new Set(['/repo/.git', `${MODULE}/openspec`])
const FILES: Record<string, string> = {
  [`${CHANGE}/proposal.md`]: '# Proposal\n\n## Why\n\nRefunds are manual. They take two days.\n',
  [`${CHANGE}/design.md`]: '## Decisions\n\n### D1. Provider API\n\n## Open Questions\n\n- Keep the order open?\n',
  [`${CHANGE}/tasks.md`]: '## 1. Data\n\n- [x] 1.1 Table\n- [ ] 1.2 Add the key\n',
  [`${CHANGE}/specs/refunds/spec.md`]: '### Requirement: Refund\n#### Scenario: Full\n',
}
const ARTIFACTS = {
  proposal: { existingOutputPaths: [`${CHANGE}/proposal.md`] },
  specs: { existingOutputPaths: [`${CHANGE}/specs/refunds/spec.md`] },
  design: { existingOutputPaths: [`${CHANGE}/design.md`] },
  tasks: { existingOutputPaths: [`${CHANGE}/tasks.md`] },
}

type Init = { env?: Record<string, string>; timeoutMs?: number }
type Seen = { reads: string[]; lists: string[]; exists: string[]; runs: string[][]; inits: (Init | undefined)[]; conversation: string[] }

const session = (on: any): { seen: Seen; clock: ReturnType<typeof mock.clock> } => {
  const seen: Seen = { reads: [], lists: [], exists: [], runs: [], inits: [], conversation: [] }
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: REPO }))
  on('fs.exists', (_: unknown, e: { path: string }) => {
    seen.exists.push(e.path)
    return { value: EXISTING.has(e.path) }
  })
  on('fs.list', (_: unknown, e: { path: string }) => {
    seen.lists.push(e.path)
    return { value: (DIRS[e.path] ?? []).map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    seen.reads.push(e.path)
    return e.path in FILES ? { value: FILES[e.path] } : { deny: 'ENOENT' }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: Init }) => {
    seen.runs.push([...e.argv])
    seen.inits.push(e.init)
    const [cmd, verb, flag] = e.argv
    const json = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (verb === 'status') return json({ changes: [{ changeName: 'add-refunds', artifactPaths: ARTIFACTS }] })
    if (flag === '--specs') return json({ specs: [] })
    if (flag === '--archived') return json({ changes: [] })
    return json({ changes: [{ name: 'add-refunds', completedTasks: 1, totalTasks: 2, lastModified: '2026-10-15T10:00:00Z' }] })
  })
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // The ways a plugin could reach the conversation, or send anything out: each is
  // recorded and refused, and the test fails if the plugin asks for any of them
  for (const event of ['session.messages', 'model.complete', 'model.fork', 'agent.spawn', 'http.fetch']) {
    on(event, () => {
      seen.conversation.push(event)
      return { deny: 'not for Spec Manager' }
    })
  }
  return { seen, clock }
}

const PANE = { component: 'Pane', requestId: 'spec-manager' } as const
const props = { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

test('a whole session reads OpenSpec files and runs openspec only, and nothing of the conversation', async ($, on) => {
  const { seen, clock } = session(on)
  await $.session.start({ cwd: REPO, surface: 'desktop', isInteractive: true })
  await clock.settle()
  // Before /spec-manager, nothing of the repository: no folder listed, no file read,
  // no openspec or git run, however long the session waits
  await clock.advance(10 * 60000)
  await clock.settle()
  expect(seen).toEqual({ reads: [], lists: [], exists: [], runs: [], inits: [], conversation: [] })
  await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'spec-manager', surface, ...PANE, props })
    expect(await ui.find({ type: 'Text', text: /add-refunds/ })).toBeDefined()
    await ui.unmount()
  }
  // A few polls, the countdown ticking in between
  await clock.advance(35000)
  await clock.settle()

  // Nothing of the conversation, nothing sent out
  expect(seen.conversation).toEqual([])

  // Files read: the change's own OpenSpec documents, nothing else
  const doc = /^\/repo\/.+\/openspec\/changes\/[^/]+\/(proposal\.md|design\.md|tasks\.md|specs\/.+\/spec\.md)$/
  expect(seen.reads.length > 0).toBe(true)
  for (const path of seen.reads) expect(doc.test(path)).toBe(true)

  // Folders listed: inside the repository only, names and times, no file contents
  for (const path of seen.lists) expect(path === REPO || path.startsWith(`${REPO}/`)).toBe(true)

  // Paths tested: only whether a folder is a repository top or holds openspec/
  for (const path of seen.exists) expect(/\/(\.git|openspec)$/.test(path)).toBe(true)

  // Commands: openspec in read-only listing mode, nothing else (git included)
  expect(seen.runs.length > 0).toBe(true)
  seen.runs.forEach((argv, i) => {
    const [cmd, verb] = argv
    expect(cmd).toBe('openspec')
    expect(['list', 'status'].includes(verb ?? '')).toBe(true)
    expect(argv.includes('--json')).toBe(true)
    // Stopped if it hangs, after at most 15 seconds
    // A positive number: 0 or less would set no limit in many process APIs
    const timeout = seen.inits[i]?.timeoutMs
    expect(typeof timeout === 'number' && timeout > 0 && timeout <= 15000).toBe(true)
    // Its telemetry off: nothing sent out through it
    expect(seen.inits[i]?.env?.OPENSPEC_TELEMETRY).toBe('0')
    expect(seen.inits[i]?.env?.DO_NOT_TRACK).toBe('1')
  })
})
