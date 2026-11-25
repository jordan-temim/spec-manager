import { expect, mock, test } from 'claude-code/testing'

// What the pane reads stays inside the repository: never through a symbolic link, never a
// path openspec answers, only the .md documents found in a change's own folder. Each test
// builds a repository of `tree` (a folder's entries, each a dir, a file or a link) and
// records every read, listing and run

const REPO = '/repo'
const MODULE = '/repo/pay'
const CHANGES = `${MODULE}/openspec/changes`
const CHANGE = `${CHANGES}/add-refunds`

type Entry = [name: string, kind: 'dir' | 'file', isLink?: boolean]
type Tree = Record<string, Entry[]>
type Run = { argv: string[]; cwd: string }

// A module with one change holding its four documents, every one of them a plain file
const plainTree = (): Tree => ({
  [REPO]: [['.git', 'dir'], ['pay', 'dir']],
  [MODULE]: [['openspec', 'dir']],
  [`${MODULE}/openspec`]: [['changes', 'dir']],
  [CHANGES]: [['add-refunds', 'dir']],
  [CHANGE]: [['proposal.md', 'file'], ['design.md', 'file'], ['tasks.md', 'file'], ['specs', 'dir']],
  [`${CHANGE}/specs`]: [['refunds', 'dir']],
  [`${CHANGE}/specs/refunds`]: [['spec.md', 'file']],
})

const DOCS: Record<string, string> = {
  [`${CHANGE}/proposal.md`]: '## Why\n\nRefunds are manual.\n',
  [`${CHANGE}/design.md`]: '### D1. Provider API\n',
  [`${CHANGE}/tasks.md`]: '## 1. Data\n\n- [x] 1.1 Table\n- [ ] 1.2 Endpoint\n',
  [`${CHANGE}/specs/refunds/spec.md`]: '### Requirement: Refund\n',
}

type Options = {
  /** `openspec list`'s changes; add-refunds by default */
  changes?: unknown[]
  /** `openspec status`'s artifactPaths for add-refunds */
  artifactPaths?: Record<string, { existingOutputPaths: string[] }>
}

const fakeRepo = (on: any, tree: Tree, options: Options = {}) => {
  const reads: string[] = []
  const lists: string[] = []
  const runs: Run[] = []
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: REPO }))
  on('fs.exists', (_: unknown, e: { path: string }) => {
    const parent = e.path.slice(0, e.path.lastIndexOf('/'))
    return { value: (tree[parent] ?? []).some(([name]) => name === e.path.slice(parent.length + 1)) }
  })
  on('fs.list', (_: unknown, e: { path: string }) => {
    lists.push(e.path)
    return { value: (tree[e.path] ?? []).map(([name, kind, isLink = false]) => ({ name, kind, size: 0, mtimeMs: 0, isLink })) }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    reads.push(e.path)
    // Whatever is asked answers: a read the pane should not make would still show
    return { value: DOCS[e.path] ?? '### Requirement: from outside\n' }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd ?? '' })
    const [cmd, verb, flag] = e.argv
    const out = (body: unknown) => ({ value: { exitCode: 0, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (flag === '--specs' || flag === '--archived') return out({ specs: [], changes: [] })
    if (verb === 'status') {
      const artifactPaths = options.artifactPaths ?? {}
      return out({ changes: [{ changeName: 'add-refunds', artifactPaths }] })
    }
    return out({ changes: options.changes ?? [{ name: 'add-refunds', completedTasks: 1, totalTasks: 2 }] })
  })
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { reads, lists, runs, clock }
}

const open = async ($: any, clock: any, args = '') => {
  await $.session.start({ cwd: REPO, surface: 'desktop', isInteractive: true })
  const answer = await $.command.run({ command: 'spec-manager', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.settle()
  return answer
}

const pane = async ($: any) => {
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  try {
    return (await ui.find({ type: 'Box' }))?.text ?? ''
  } finally {
    await ui.unmount()
  }
}

test('the documents found plain in the change folder are read, nothing else', async ($, on) => {
  const { reads, clock } = fakeRepo(on, plainTree())
  await open($, clock)
  expect([...new Set(reads)].sort()).toEqual(Object.keys(DOCS).sort())
})

test('a document that is a symbolic link is never read, whatever it points to', async ($, on) => {
  const tree = plainTree()
  // tasks.md and the spec point elsewhere (~/.ssh/id_rsa, say): left out, the others read
  tree[CHANGE] = [['proposal.md', 'file'], ['design.md', 'file'], ['tasks.md', 'file', true], ['specs', 'dir']]
  tree[`${CHANGE}/specs/refunds`] = [['spec.md', 'file', true]]
  const { reads, clock } = fakeRepo(on, tree)
  await open($, clock)
  expect(reads).not.toContain(`${CHANGE}/tasks.md`)
  expect(reads).not.toContain(`${CHANGE}/specs/refunds/spec.md`)
  expect(reads).toContain(`${CHANGE}/proposal.md`)
})

test('a specs/ folder that is a symbolic link is not gone into', async ($, on) => {
  const tree = plainTree()
  tree[CHANGE] = [['tasks.md', 'file'], ['specs', 'dir', true]]
  const { reads, lists, clock } = fakeRepo(on, tree)
  await open($, clock)
  expect(reads.filter(path => path.includes('/specs/'))).toEqual([])
  expect(lists).not.toContain(`${CHANGE}/specs`)
})

test('a capability folder that is a symbolic link is not gone into', async ($, on) => {
  const tree = plainTree()
  tree[`${CHANGE}/specs`] = [['refunds', 'dir', true]]
  const { reads, lists, clock } = fakeRepo(on, tree)
  await open($, clock)
  expect(reads.filter(path => path.includes('/specs/'))).toEqual([])
  expect(lists).not.toContain(`${CHANGE}/specs/refunds`)
})

test('a change folder that is a symbolic link is listed from openspec alone, nothing in it read', async ($, on) => {
  const tree = plainTree()
  tree[CHANGES] = [['add-refunds', 'dir', true]]
  const { reads, lists, clock } = fakeRepo(on, tree)
  await open($, clock)
  expect(reads).toEqual([])
  expect(lists).not.toContain(CHANGE)
  // Still shown: openspec lists it
  expect(await pane($)).toContain('add-refunds')
})

test('an openspec/changes/ that is a symbolic link: nothing of the module run or read', async ($, on) => {
  const tree = plainTree()
  tree[`${MODULE}/openspec`] = [['changes', 'dir', true]]
  const { reads, runs, clock } = fakeRepo(on, tree)
  await open($, clock)
  expect(reads).toEqual([])
  expect(runs.filter(run => run.cwd === MODULE)).toEqual([])
  expect(await pane($)).toContain('symbolic link')
})

test('an openspec/ that is a symbolic link makes no module: nothing run there', async ($, on) => {
  const tree = plainTree()
  tree[MODULE] = [['openspec', 'dir', true]]
  const { reads, runs, clock } = fakeRepo(on, tree)
  await open($, clock)
  expect(reads).toEqual([])
  expect(runs.filter(run => run.argv[0] === 'openspec')).toEqual([])
})

test('the search for modules does not follow a folder that is a symbolic link', async ($, on) => {
  const tree = plainTree()
  // /repo/elsewhere points outside the repository, an openspec/ behind it
  tree[REPO] = [['.git', 'dir'], ['pay', 'dir'], ['elsewhere', 'dir', true]]
  tree['/repo/elsewhere'] = [['openspec', 'dir']]
  const { lists, runs, clock } = fakeRepo(on, tree)
  await open($, clock)
  expect(lists).not.toContain('/repo/elsewhere')
  expect(runs.filter(run => run.cwd === '/repo/elsewhere')).toEqual([])
})

test('the fingerprint of the files does not walk into a symbolic link', async ($, on) => {
  const tree = plainTree()
  tree[`${MODULE}/openspec`] = [['changes', 'dir'], ['shared', 'dir', true]]
  tree[`${MODULE}/openspec/shared`] = [['deep', 'dir']]
  const { lists, clock } = fakeRepo(on, tree)
  await open($, clock)
  await clock.advance(30000)
  await clock.settle()
  expect(lists).not.toContain(`${MODULE}/openspec/shared`)
})

test("the paths openspec answers are never read: outside the repository, not .md, or with ..", async ($, on) => {
  const elsewhere = ['/etc/passwd', '/Users/me/.ssh/id_rsa.md', `${CHANGE}/specs/refunds/spec.txt`, `${CHANGE}/../../../secrets/spec.md`, 'openspec/changes/add-refunds/../../x/spec.md']
  const { reads, clock } = fakeRepo(on, plainTree(), {
    artifactPaths: {
      proposal: { existingOutputPaths: ['/etc/hosts'] },
      specs: { existingOutputPaths: elsewhere },
      design: { existingOutputPaths: [`${CHANGE}/design.md`] },
      tasks: { existingOutputPaths: [`${CHANGE}/tasks.md`] },
    },
  })
  await open($, clock)
  for (const path of [...elsewhere, '/etc/hosts']) expect(reads).not.toContain(path)
  // What is read is the change's own documents, found in its folder
  for (const path of reads) expect(path.startsWith(`${CHANGE}/`) && path.endsWith('.md')).toBe(true)
  expect(reads).toContain(`${CHANGE}/specs/refunds/spec.md`)
})

test('a change name that is a path is left out: nothing read or listed in it', async ($, on) => {
  const names = ['../../../etc', 'a/b', '..', '.', '', 'x\\y']
  const { reads, lists, runs, clock } = fakeRepo(on, plainTree(), {
    changes: [...names.map(name => ({ name, completedTasks: 0, totalTasks: 1 })), { name: 42 }, { name: 'add-refunds', completedTasks: 1, totalTasks: 2 }],
  })
  await open($, clock)
  const outside = (path: string) => !path.startsWith(`${CHANGES}/add-refunds`) && path.startsWith(`${CHANGES}/`)
  expect(reads.filter(outside)).toEqual([])
  expect(lists.filter(outside)).toEqual([])
  // Nothing but openspec runs, and only in the module
  for (const run of runs) expect([run.argv[0], run.cwd]).toEqual(['openspec', MODULE])
  expect(await pane($)).toContain('add-refunds')
})
