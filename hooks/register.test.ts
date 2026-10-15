import { describe, expect, test } from 'claude-code/testing'

import { moduleName, ownerOf, parseDesign, parseTasks, resolveModule, settle, specCounts, steps, whoseTurn, whyLine } from './register'
import type { Artifact, Change } from '../types'

const TASKS = `# Tasks

## 1. Setup

- [x] 1.1 Create the skeleton
- [x] 1.2 Add \`.gitignore\`

## 2. Fetch

- [ ] 2.1 *(action utilisateur : clé dans \`.env\`)* Run the capture
- [ ] 2.2 Parse the response

## Workflow follow-up

- Archive once done.
`

const ALL_WRITTEN: Artifact[] = ['proposal', 'specs', 'design', 'tasks'].map(name => ({ name, isDone: true }))

describe('tasks.md', () => {
  test('counts checkboxes per numbered section and skips sections without any', async () => {
    const { sections } = parseTasks(TASKS)
    expect(sections).toEqual([
      { num: '1', title: 'Setup', done: 2, total: 2 },
      { num: '2', title: 'Fetch', done: 0, total: 2 },
    ])
  })

  test('lists open tasks in order and flags user actions', async () => {
    const { open } = parseTasks(TASKS)
    expect(open).toEqual([
      { id: '2.1', text: 'Run the capture', isUserAction: true },
      { id: '2.2', text: 'Parse the response', isUserAction: false },
    ])
  })
})

describe('whose turn', () => {
  test('a missing artifact is for the AI to write', async () => {
    const artifacts = [{ name: 'proposal', isDone: true }, { name: 'specs', isDone: false }]
    const turn = whoseTurn(artifacts, { done: 0, total: 0 }, [])
    expect(turn.phase).toBe('planning')
    expect(turn.turn).toBe('ai')
    expect(turn.aiNext?.text).toBe('write specs')
  })

  test('a fresh plan waits for review', async () => {
    const turn = whoseTurn(ALL_WRITTEN, { done: 0, total: 4 }, [])
    expect(turn.phase).toBe('review')
    expect(turn.turn).toBe('you')
  })

  test('a user action first in line is your turn', async () => {
    const { open } = parseTasks(TASKS)
    const turn = whoseTurn(ALL_WRITTEN, { done: 2, total: 4 }, open)
    expect(turn.phase).toBe('implementing')
    expect(turn.turn).toBe('you')
    expect(turn.yourNext?.id).toBe('2.1')
    expect(turn.aiNext?.id).toBe('2.2')
  })

  test('all tasks checked is ready to archive', async () => {
    const turn = whoseTurn(ALL_WRITTEN, { done: 4, total: 4 }, [])
    expect(turn.phase).toBe('ready')
    expect(turn.turn).toBe('you')
  })
})

describe('plan digest', () => {
  test('reads the first sentence of Why', async () => {
    expect(whyLine('# Proposal\n\n## Why\n\nFirst `point`. Second point.\n\n## What Changes\n')).toBe('First point.')
  })

  test('reads decisions and the open questions', async () => {
    const design = '## Decisions\n\n### D1. Layout\n\n### D2. Data\n\n## Open Questions\n\n- One?\n- Two?\n'
    expect(parseDesign(design)).toEqual({ decisions: ['D1 Layout', 'D2 Data'], openQuestions: ['One?', 'Two?'] })
  })

  test('counts requirements and scenarios', async () => {
    const spec = '### Requirement: A\n#### Scenario: a1\n#### Scenario: a2\n### Requirement: B\n#### Scenario: b1\n'
    expect(specCounts(spec)).toEqual({ requirements: 2, scenarios: 3 })
  })
})

describe('stepper', () => {
  test('marks the first unfinished step as current', async () => {
    const change = { artifacts: ALL_WRITTEN, phase: 'implementing' } as Change
    expect(steps(change).map(s => `${s.name}:${s.state}`)).toEqual([
      'proposal:done',
      'specs:done',
      'design:done',
      'tasks:done',
      'apply:current',
      'archive:todo',
    ])
  })
})

describe('modules', () => {
  const base = '/repo'
  const paths = ['/repo', '/repo/packages/paiement', '/repo/packages/catalogue', '/repo/apps/web']

  test('names a module by its path under the repo, the repo itself by its folder', async () => {
    expect(moduleName(base, '/repo/packages/paiement')).toBe('packages/paiement')
    expect(moduleName(base, '/repo')).toBe('repo')
  })

  test('/spec-manager <arg> finds a module by full name, last folder or part of it', async () => {
    expect(resolveModule('packages/paiement', paths, base)).toBe('/repo/packages/paiement')
    expect(resolveModule('catalogue', paths, base)).toBe('/repo/packages/catalogue')
    expect(resolveModule('web/', paths, base)).toBe('/repo/apps/web')
    expect(resolveModule('paie', paths, base)).toBe('/repo/packages/paiement')
  })

  test('"all" or nothing means the overview, an unknown name nothing', async () => {
    expect(resolveModule('all', paths, base)).toBe('all')
    expect(resolveModule('  ', paths, base)).toBe('all')
    expect(resolveModule('billing', paths, base)).toBe(undefined)
  })
})

describe('ownership', () => {
  test('a change is mine when I made its first commit, or when nobody committed it yet', async () => {
    expect(ownerOf('me@example.org\tMe\nmarie@example.org\tMarie\n', 'Me@Example.org')).toEqual({ isMine: true })
    expect(ownerOf('', 'me@example.org')).toEqual({ isMine: true })
  })

  test("someone else's first commit makes it theirs, named after them", async () => {
    expect(ownerOf('marie@example.org\tMarie\nme@example.org\tMe\n', 'me@example.org')).toEqual({
      isMine: false,
      owner: 'Marie',
    })
  })

  test('without a git identity, every change is mine', async () => {
    expect(ownerOf('marie@example.org\tMarie\n', '')).toEqual({ isMine: true })
  })
})

describe('selection', () => {
  test('a single module is shown directly, even one that appeared after the overview was picked', async () => {
    expect(settle('all', ['/repo'])).toBe('/repo')
    expect(settle(undefined, ['/repo'])).toBe('/repo')
    expect(settle('/gone', ['/repo'])).toBe('/repo')
  })

  test('with several modules, keeps a known pick and falls back to the overview', async () => {
    const paths = ['/repo/a', '/repo/b']
    expect(settle('/repo/b', paths)).toBe('/repo/b')
    expect(settle('all', paths)).toBe('all')
    expect(settle('/gone', paths)).toBe('all')
  })
})
