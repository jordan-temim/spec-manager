import { expect, mock, test } from 'claude-code/testing'

// Spec Manager reads OpenSpec files and git, and nothing of the conversation. This
// test runs a whole session against a fake repository, records every call the plugin
// makes outside itself, and fails on anything beyond that.

const REPO = '/repo'
const MODULE = '/repo/packages/paiement'
const CHANGE = `${MODULE}/openspec/changes/add-refunds`

const DIRS: Record<string, [string, 'dir' | 'file'][]> = {
  '/repo': [['.git', 'dir'], ['packages', 'dir']],
  '/repo/packages': [['paiement', 'dir']],
  [MODULE]: [['openspec', 'dir'], ['src', 'dir']],
}
const EXISTING = new Set(['/repo/.git', `${MODULE}/openspec`])
const FILES: Record<string, string> = {
  [`${CHANGE}/proposal.md`]: '# Proposal\n\n## Why\n\nRefunds are manual. They take two days.\n',
  [`${CHANGE}/design.md`]: '## Decisions\n\n### D1. Provider API\n\n## Open Questions\n\n- Keep the order open?\n',
  [`${CHANGE}/tasks.md`]: '## 1. Data\n\n- [x] 1.1 Table\n- [ ] 1.2 *(user action)* Add the key\n',
  [`${CHANGE}/specs/refunds/spec.md`]: '### Requirement: Refund\n#### Scenario: Full\n',
}
const ARTIFACTS = {
  proposal: { existingOutputPaths: [`${CHANGE}/proposal.md`] },
  specs: { existingOutputPaths: [`${CHANGE}/specs/refunds/spec.md`] },
  design: { existingOutputPaths: [`${CHANGE}/design.md`] },
  tasks: { existingOutputPaths: [`${CHANGE}/tasks.md`] },
}

type Seen = { reads: string[]; lists: string[]; exists: string[]; runs: string[][]; conversation: string[] }

const session = (on: any): { seen: Seen; clock: ReturnType<typeof mock.clock> } => {
  const seen: Seen = { reads: [], lists: [], exists: [], runs: [], conversation: [] }
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
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    seen.runs.push([...e.argv])
    const [cmd, verb, flag] = e.argv
    const json = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '' } })
    if (cmd === 'git') return { value: { exitCode: 0, stdout: verb === 'config' ? 'me@example.org\n' : 'me@example.org\tMe\n', stderr: '' } }
    if (verb === 'status') return json({ changes: [{ changeName: 'add-refunds', artifactPaths: ARTIFACTS }] })
    if (flag === '--specs') return json({ specs: [] })
    if (flag === '--archived') return json({ changes: [] })
    return json({ changes: [{ name: 'add-refunds', completedTasks: 1, totalTasks: 2, lastModified: '2026-10-15T10:00:00Z' }] })
  })
  on('command.register', () => ({ value: undefined }))
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
const props = { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock' } as const

test('a whole session reads OpenSpec files and git only, and nothing of the conversation', async ($, on) => {
  const { seen, clock } = session(on)
  await $.session.start({ cwd: REPO, surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'user' }, presentation: {} })
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

  // Commands: openspec in read-only listing mode, and two read-only git queries
  expect(seen.runs.length > 0).toBe(true)
  for (const argv of seen.runs) {
    const [cmd, verb] = argv
    if (cmd === 'openspec') {
      expect(['list', 'status'].includes(verb ?? '')).toBe(true)
      expect(argv.includes('--json')).toBe(true)
    } else {
      expect(cmd).toBe('git')
      const isEmail = verb === 'config' && argv[2] === 'user.email' && argv.length === 3
      const isAuthor = verb === 'log' && /\/openspec\/changes\/[^/]+$/.test(argv[argv.length - 1] ?? '')
      expect(isEmail || isAuthor).toBe(true)
    }
  }
})
