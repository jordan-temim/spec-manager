import { describe, expect, test } from 'claude-code/testing'

import { absolute, ago, artifactsFrom, artifactsFromFiles, dotsSvg, moduleName, ownerOf, parseDesign, parseTasks, resolveModule, settle, specCounts, specName, steps, whoseTurn, whyLine } from './register'
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
  test('counts and lists the tasks of each numbered section, skipping sections without any', () => {
    const { sections } = parseTasks(TASKS)
    expect(sections).toEqual([
      {
        num: '1', title: 'Setup', done: 2, total: 2,
        tasks: [
          { id: '1.1', text: 'Create the skeleton', isUserAction: false, isDone: true },
          { id: '1.2', text: 'Add .gitignore', isUserAction: false, isDone: true },
        ],
      },
      {
        num: '2', title: 'Fetch', done: 0, total: 2,
        tasks: [
          { id: '2.1', text: 'Run the capture', isUserAction: true, isDone: false },
          { id: '2.2', text: 'Parse the response', isUserAction: false, isDone: false },
        ],
      },
    ])
  })

  test('lists open tasks in order and flags user actions', () => {
    const { open } = parseTasks(TASKS)
    expect(open).toEqual([
      { id: '2.1', text: 'Run the capture', isUserAction: true },
      { id: '2.2', text: 'Parse the response', isUserAction: false },
    ])
  })
})

describe('whose turn', () => {
  test('a missing artifact is for the AI to write', () => {
    const artifacts = [{ name: 'proposal', isDone: true }, { name: 'specs', isDone: false }]
    const turn = whoseTurn(artifacts, { done: 0, total: 0 }, [])
    expect(turn.phase).toBe('planning')
    expect(turn.turn).toBe('ai')
    expect(turn.aiNext?.text).toBe('write specs')
  })

  test('a fresh plan waits for review', () => {
    const turn = whoseTurn(ALL_WRITTEN, { done: 0, total: 4 }, [])
    expect(turn.phase).toBe('review')
    expect(turn.turn).toBe('you')
  })

  test('a user action first in line is your turn', () => {
    const { open } = parseTasks(TASKS)
    const turn = whoseTurn(ALL_WRITTEN, { done: 2, total: 4 }, open)
    expect(turn.phase).toBe('implementing')
    expect(turn.turn).toBe('you')
    expect(turn.yourNext?.id).toBe('2.1')
    expect(turn.aiNext?.id).toBe('2.2')
  })

  test('a task of the AI first in line is its turn, a user action later still waits on you', () => {
    const open = [
      { id: '2.2', text: 'Parse the response', isUserAction: false },
      { id: '2.3', text: 'Add the key', isUserAction: true },
      { id: '2.4', text: 'Retry', isUserAction: false },
    ]
    const turn = whoseTurn(ALL_WRITTEN, { done: 2, total: 5 }, open)
    expect(turn.phase).toBe('implementing')
    expect(turn.turn).toBe('ai')
    expect(turn.aiNext?.id).toBe('2.2')
    expect(turn.yourNext?.id).toBe('2.3')
    expect(turn.yourLater).toBe(0)
  })

  test('all tasks checked is ready to archive', () => {
    const turn = whoseTurn(ALL_WRITTEN, { done: 4, total: 4 }, [])
    expect(turn.phase).toBe('ready')
    expect(turn.turn).toBe('you')
  })
})

describe('plan digest', () => {
  test('reads the first sentence of Why', () => {
    expect(whyLine('# Proposal\n\n## Why\n\nFirst `point`. Second point.\n\n## What Changes\n')).toBe('First point.')
  })

  test('an empty Why gives no line, not the next section\'s', () => {
    expect(whyLine('# Proposal\n\n## Why\n\n## What Changes\n\n- Add refunds\n')).toBe(undefined)
  })

  test('reads decisions and the open questions', () => {
    const design = '## Decisions\n\n### D1. Layout\n\n### D2. Data\n\n## Open Questions\n\n- One?\n- Two?\n'
    expect(parseDesign(design)).toEqual({ decisions: ['D1 Layout', 'D2 Data'], openQuestions: ['One?', 'Two?'] })
  })

  test('a bullet saying there is no question is not one', () => {
    for (const bullet of ['None', 'None.', 'N/A', 'Aucune', "Aucune pour l'instant.", 'Nothing yet', '—']) {
      expect(parseDesign(`## Open Questions\n\n- ${bullet}\n`).openQuestions).toEqual([])
    }
    expect(parseDesign('## Open Questions\n\n- None of the refunds partial?\n').openQuestions).toEqual(['None of the refunds partial?'])
  })

  test('counts requirements and scenarios', () => {
    const spec = '### Requirement: A\n#### Scenario: a1\n#### Scenario: a2\n### Requirement: B\n#### Scenario: b1\n'
    expect(specCounts(spec)).toEqual({ requirements: 2, scenarios: 3 })
  })
})

describe('stepper', () => {
  test('marks the first unfinished step as current', () => {
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

describe('card dots', () => {
  test('one dot per step, whatever the schema gives', () => {
    const dots = (svg: string) => (svg.match(/<rect /g) ?? []).length
    expect(dots(dotsSvg(4, 6, '#d97757'))).toBe(6)
    expect(dots(dotsSvg(1, 3, '#d97757'))).toBe(3)
    // The current one filled with the actor's colour, at its place
    expect(dotsSvg(1, 3, '#d97757').split('<rect ')[2]).toContain('fill="#d97757"')
  })
})

describe('modules', () => {
  const base = '/repo'
  const paths = ['/repo', '/repo/packages/paiement', '/repo/packages/catalogue', '/repo/apps/web']

  test('names a module by its path under the repo, the repo itself by its folder', () => {
    expect(moduleName(base, '/repo/packages/paiement')).toBe('packages/paiement')
    expect(moduleName(base, '/repo')).toBe('repo')
  })

  test('/spec-manager <arg> finds a module by full name, last folder or part of it', () => {
    expect(resolveModule('packages/paiement', paths, base)).toBe('/repo/packages/paiement')
    expect(resolveModule('catalogue', paths, base)).toBe('/repo/packages/catalogue')
    expect(resolveModule('web/', paths, base)).toBe('/repo/apps/web')
    expect(resolveModule('paie', paths, base)).toBe('/repo/packages/paiement')
  })

  test('an exact name wins over one it starts, a fragment of several takes the first listed', () => {
    const several = ['/repo/packages/pay-later', '/repo/packages/pay', '/repo/apps/payments']
    // "pay" is a module's whole name, and the start of the two others'
    expect(resolveModule('pay', several, base)).toBe('/repo/packages/pay')
    // A fragment in several names: the first in the list, as /spec-manager shows them
    expect(resolveModule('ay', several, base)).toBe('/repo/packages/pay-later')
    expect(resolveModule('ment', several, base)).toBe('/repo/apps/payments')
  })

  test('"all" or nothing means the overview, an unknown name nothing', () => {
    expect(resolveModule('all', paths, base)).toBe('all')
    expect(resolveModule('  ', paths, base)).toBe('all')
    expect(resolveModule('billing', paths, base)).toBe(undefined)
  })
})

describe('ownership', () => {
  test('a change is mine when I made its first commit, or when nobody committed it yet', () => {
    expect(ownerOf('me@example.org\tMe\nmarie@example.org\tMarie\n', 'Me@Example.org')).toEqual({ isMine: true })
    expect(ownerOf('', 'me@example.org')).toEqual({ isMine: true })
  })

  test("someone else's first commit makes it theirs, named after them", () => {
    expect(ownerOf('marie@example.org\tMarie\nme@example.org\tMe\n', 'me@example.org')).toEqual({
      isMine: false,
      owner: 'Marie',
    })
  })

  test('without a git identity, every change is mine', () => {
    expect(ownerOf('marie@example.org\tMarie\n', '')).toEqual({ isMine: true })
  })
})

describe('selection', () => {
  test('a single module is shown directly, even one that appeared after the overview was picked', () => {
    expect(settle('all', ['/repo'])).toBe('/repo')
    expect(settle(undefined, ['/repo'])).toBe('/repo')
    expect(settle('/gone', ['/repo'])).toBe('/repo')
  })

  test('with several modules, keeps a known pick and falls back to the overview', () => {
    const paths = ['/repo/a', '/repo/b']
    expect(settle('/repo/b', paths)).toBe('/repo/b')
    expect(settle('all', paths)).toBe('all')
    expect(settle('/gone', paths)).toBe('all')
  })
})

describe('skipped documents', () => {
  // openspec status for a change with skip_specs: true in its .openspec.yaml
  const status = {
    artifactPaths: {
      proposal: { existingOutputPaths: ['proposal.md'] },
      specs: { existingOutputPaths: [] },
      design: { existingOutputPaths: ['design.md'] },
      tasks: { existingOutputPaths: ['tasks.md'] },
    },
    artifacts: [
      { id: 'proposal', status: 'done' },
      { id: 'specs', status: 'skipped' },
      { id: 'design', status: 'done' },
      { id: 'tasks', status: 'done' },
    ],
  }

  test('a skipped document counts as done, so the plan is complete', () => {
    const artifacts = artifactsFrom(status)
    expect(artifacts.find(a => a.name === 'specs')).toEqual({ name: 'specs', isDone: true, isSkipped: true })
    expect(whoseTurn(artifacts, { done: 0, total: 14 }, []).phase).toBe('review')
    // On the stepper: done, marked skipped, and the current step is past it
    const stepper = steps({ artifacts, phase: 'review' } as Change)
    expect(stepper.find(s => s.name === 'specs')).toEqual({ name: 'specs', state: 'done', isSkipped: true })
    expect(stepper.find(s => s.state === 'current')?.name).toBe('apply')
  })

  test('without openspec status, the documents are read from the change folder', () => {
    const artifacts = artifactsFromFiles(['proposal.md', 'specs', '.openspec.yaml'], ['refunds'])
    expect(artifacts.map(a => [a.name, a.isDone])).toEqual([['proposal', true], ['specs', true], ['design', false], ['tasks', false]])
    const turn = whoseTurn(artifacts, { done: 0, total: 0 }, [])
    expect(turn.phase).toBe('planning')
    expect(turn.aiNext?.text).toBe('write design')
  })

  test('without openspec status, a folder holding every document is a plan to review', () => {
    const artifacts = artifactsFromFiles(['proposal.md', 'design.md', 'tasks.md', 'specs'], ['refunds'])
    expect(artifacts.every(a => a.isDone)).toBe(true)
    expect(whoseTurn(artifacts, { done: 0, total: 3 }, []).phase).toBe('review')
  })

  test('without a verdict from openspec, a document is done when its files exist', () => {
    const { artifacts: _, ...older } = status
    expect(artifactsFrom(older).find(a => a.name === 'specs')?.isDone).toBe(false)
  })
})

describe('tasks.md variants', () => {
  test('an upper-case X, a star bullet and an indented task all count', () => {
    const { sections, open } = parseTasks('## 1. Mixed\n\n- [X] 1.1 Upper\n* [x] 1.2 Star\n  - [ ] 1.3 Indented\n')
    expect(sections[0]).toMatchObject({ done: 2, total: 3 })
    expect(open.map(t => t.id)).toEqual(['1.3'])
  })
})

describe('Windows line endings', () => {
  const crlf = (text: string) => text.replace(/\n/g, '\r\n')

  test('tasks.md in CRLF reads as in LF', () => {
    expect(parseTasks(crlf(TASKS))).toEqual(parseTasks(TASKS))
    expect(parseTasks(crlf(TASKS)).sections.length).toBe(2)
  })

  test('proposal, design and spec in CRLF read as in LF', () => {
    expect(whyLine(crlf('## Why\n\nFirst point. Second.\n\n## What Changes\n'))).toBe('First point.')
    expect(parseDesign(crlf('### D1. Layout\n\n## Open Questions\n\n- One?\n'))).toEqual({ decisions: ['D1 Layout'], openQuestions: ['One?'] })
    expect(specCounts(crlf('### Requirement: A\n#### Scenario: B\n'))).toEqual({ requirements: 1, scenarios: 1 })
  })
})

describe('spec paths from openspec', () => {
  test('a spec is named from the end of its path, wherever the path starts', () => {
    expect(specName('/repo/pay/openspec/changes/add-refunds/specs/refunds/spec.md')).toBe('refunds')
    // Resolved through a symlink: not under the folder the pane knows
    expect(specName('/private/var/repo/pay/openspec/changes/add-refunds/specs/refunds/spec.md')).toBe('refunds')
    expect(specName('openspec/changes/add-refunds/specs/billing/refunds/spec.md')).toBe('billing/refunds')
  })

  test('a relative path is read from the module folder', () => {
    expect(absolute('/repo/pay', 'openspec/changes/a/specs/x/spec.md')).toBe('/repo/pay/openspec/changes/a/specs/x/spec.md')
    expect(absolute('/repo/pay', './openspec/changes/a/specs/x/spec.md')).toBe('/repo/pay/openspec/changes/a/specs/x/spec.md')
    expect(absolute('/repo/pay', '/elsewhere/spec.md')).toBe('/elsewhere/spec.md')
  })
})

describe('last activity', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  test('says how long ago, and nothing for a date that does not parse', () => {
    expect(ago('2026-11-08T11:55:00Z', now)).toBe('5m ago')
    expect(ago('2026-11-06T12:00:00Z', now)).toBe('2d ago')
    expect(ago('not a date', now)).toBe('')
    expect(ago('', now)).toBe('')
  })
})
