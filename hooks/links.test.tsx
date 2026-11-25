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
  /** The session's folder; the repository top by default */
  cwd?: string
}

const fakeRepo = (on: any, tree: Tree, options: Options = {}) => {
  const reads: string[] = []
  const lists: string[] = []
  const runs: Run[] = []
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: options.cwd ?? REPO }))
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
    const [, verb, flag] = e.argv
    const out = (body: unknown) => ({ value: { exitCode: 0, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (flag === '--specs' || flag === '--archived') return out({ specs: [], changes: [] })
    if (verb === 'status') {
      const artifactPaths = options.artifactPaths ?? {}
      return out({ changes: [{ changeName: 'add-refunds', artifactPaths }] })
    }
    // add-refunds is pay's change alone: any other module lists none, so a view tells
    // which module it shows
    if (e.init?.cwd !== MODULE) return out({ changes: [] })
    return out({ changes: options.changes ?? [{ name: 'add-refunds', completedTasks: 1, totalTasks: 2 }] })
  })
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { reads, lists, runs, clock }
}

// The session starts in `cwd` (the repository top by default), as session.cwd answers
const open = async ($: any, clock: any, args = '', cwd = REPO) => {
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
  const answer = await $.command.run({ command: 'spec-manager', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.settle()
  return answer
}

const pane = async ($: any) => {
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  try {
    // The whole pane, or its one line when it has nothing but a message to show
    return (await ui.find({ type: 'Box' }))?.text ?? (await ui.find({ type: 'Text' }))?.text ?? ''
  } finally {
    await ui.unmount()
  }
}

test('the documents found plain in the change folder are read, nothing else', async ($, on) => {
  const { reads, clock } = fakeRepo(on, plainTree())
  await open($, clock)
  expect([...new Set(reads)].sort()).toEqual(Object.keys(DOCS).sort())
})

test('a document readable but not found in the change folder is not read', async ($, on) => {
  const tree = plainTree()
  // design.md and the spec answer a read (DOCS holds them), but the folder lists neither:
  // only what the listing shows is read, whatever openspec status says is there
  tree[CHANGE] = [['proposal.md', 'file'], ['tasks.md', 'file'], ['specs', 'dir']]
  tree[`${CHANGE}/specs/refunds`] = []
  const { reads, clock } = fakeRepo(on, tree, {
    artifactPaths: {
      design: { existingOutputPaths: [`${CHANGE}/design.md`] },
      specs: { existingOutputPaths: [`${CHANGE}/specs/refunds/spec.md`] },
    },
  })
  await open($, clock)
  expect(reads).not.toContain(`${CHANGE}/design.md`)
  expect(reads).not.toContain(`${CHANGE}/specs/refunds/spec.md`)
  expect(reads).toContain(`${CHANGE}/tasks.md`)
  // The change drawn, nothing of design.md in it: no Decisions line
  const drawn = await pane($)
  expect(drawn).toContain('add-refunds')
  expect(drawn).not.toContain('D1')
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

test('a session opened in a module whose openspec/ is a symbolic link lists nothing behind it', async ($, on) => {
  const tree = plainTree()
  // /repo/pay/openspec points outside the repository (to a home folder, say); the session
  // sits in /repo/pay, where it is found by its name before any walk
  tree[MODULE] = [['openspec', 'dir', true]]
  tree[`${MODULE}/openspec`] = [['changes', 'dir'], ['Documents', 'dir']]
  tree[`${MODULE}/openspec/Documents`] = [['secret', 'dir']]
  const { reads, lists, runs, clock } = fakeRepo(on, tree, { cwd: MODULE })
  await open($, clock, '', MODULE)
  // A few polls: each would fingerprint the module's openspec/ again
  await clock.advance(3 * 30000)
  await clock.settle()
  expect(lists.filter(path => path === `${MODULE}/openspec` || path.startsWith(`${MODULE}/openspec/`))).toEqual([])
  expect(reads).toEqual([])
  expect(runs.filter(run => run.argv[0] === 'openspec')).toEqual([])
  // It did look: the session's folder was listed, and found to hold no module of its own
  expect(lists).toContain(MODULE)
  expect(await pane($)).toContain('No openspec/ folder')
})

test('a linked openspec/ on the way up does not hide the module the session sits in', async ($, on) => {
  const tree = plainTree()
  // The session sits in /repo/pay/web, whose openspec/ is a link; /repo/pay above it is a
  // module of its own, and so is /repo/shop beside it
  tree[REPO] = [['.git', 'dir'], ['pay', 'dir'], ['shop', 'dir']]
  tree[MODULE] = [['openspec', 'dir'], ['web', 'dir']]
  tree[`${MODULE}/web`] = [['openspec', 'dir', true]]
  tree['/repo/shop'] = [['openspec', 'dir']]
  const { lists, clock } = fakeRepo(on, tree, { cwd: `${MODULE}/web` })
  await open($, clock, '', `${MODULE}/web`)
  // Two modules, the session in pay: pay's own view, its way back to the overview and its
  // change; not the overview (no MODULES heading, no shop listed with no active change)
  const drawn = await pane($)
  expect(drawn).toContain('‹ All modules')
  expect(drawn).toContain('1 other module')
  expect(drawn).toContain('add-refunds')
  expect(drawn).not.toContain('MODULES')
  expect(drawn).not.toContain('NO ACTIVE CHANGE')
  expect(drawn).not.toContain('shop')
  expect(lists.filter(path => path.startsWith(`${MODULE}/web/openspec`))).toEqual([])
})

test('an openspec/ that is a symbolic link does not have the tree walked again at every poll', async ($, on) => {
  const tree = plainTree()
  // The repository top's openspec/ is a link, and the repository has no module of its own
  tree[REPO] = [['.git', 'dir'], ['src', 'dir'], ['openspec', 'dir', true]]
  tree['/repo/src'] = [['app', 'dir']]
  const { lists, runs, clock } = fakeRepo(on, tree)
  await open($, clock)
  const walks = () => lists.filter(path => path === '/repo/src').length
  const first = walks()
  // The first look did walk the tree
  expect(first).toBeGreaterThan(0)
  // Three polls, well before the search's own 5 minutes: none walks the tree again
  for (let i = 0; i < 3; i++) await clock.advance(30000)
  await clock.settle()
  expect(walks()).toBe(first)
  expect(runs.filter(run => run.argv[0] === 'openspec')).toEqual([])
  expect(await pane($)).toContain('No openspec/ folder')
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
  // Nothing but openspec runs, only in the module, and no command names a change: no
  // argument is one of those names, nor an option's value set to one (--change=..)
  const names_ = [...names.filter(n => n !== ''), 'add-refunds']
  // Every name is looked for anywhere in an argument (`--change:add-refunds`, a path made
  // of it), but `.`: a dot is in many a fair argument, so it counts only as a whole part,
  // split at anything but a name's own characters
  const isName = (arg: string) =>
    names_.some(name => (name === '.' ? arg.split(/[^A-Za-z0-9_.-]+/).includes(name) : arg.includes(name)))
  for (const run of runs) {
    expect([run.argv[0], run.cwd]).toEqual(['openspec', MODULE])
    expect(run.argv.filter(isName)).toEqual([])
  }
  expect(await pane($)).toContain('add-refunds')
})
