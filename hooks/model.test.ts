import { describe, expect, test } from 'claude-code/testing'

import { absolute, artifactsFrom, artifactsFromFiles, fileUrl, isNotInstalled, mdHref, mdText, moduleName, ownerOf, parseDesign, parseTasks, partialMatches, resolveModule, settle, specCounts, specName, steps, whoseTurn, whyLine } from './model'
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

// A plan nobody started: its counts and open tasks agree, as parseTasks gives them
const UNTOUCHED = parseTasks('## 1. Work\n\n- [ ] 1.1 One\n- [ ] 1.2 Two\n- [ ] 1.3 Three\n')
const UNTOUCHED_COUNT = {
  done: UNTOUCHED.sections.reduce((n, s) => n + s.done, 0),
  total: UNTOUCHED.sections.reduce((n, s) => n + s.total, 0),
}

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

  test('a task id may end with a dot', () => {
    const { open } = parseTasks('## 1. Data\n\n- [ ] 1.1. Create the table\n- [ ] 3. Add the index\n')
    expect(open.map(t => [t.id, t.text])).toEqual([['1.1', 'Create the table'], ['3', 'Add the index']])
  })

  test("a decimal that is not one of its section's ids is the task's words", () => {
    const { open } = parseTasks('## 1. Webhook\n\n- [ ] 1.1 Retry\n- [ ] 2.5 seconds at most between tries\n')
    expect(open.map(t => [t.id, t.text])).toEqual([['1.1', 'Retry'], ['', '2.5 seconds at most between tries']])
  })

  test('a bare number opening a task is its words, not an id', () => {
    const { open } = parseTasks('## 1. Webhook\n\n- [ ] 3 retries at most on the webhook\n')
    expect(open).toEqual([{ id: '', text: '3 retries at most on the webhook', isUserAction: false }])
  })

  test('a numbered section with no task is left out', () => {
    const { sections } = parseTasks('## 1. Data\n\n- [x] 1.1 Table\n\n## 2. Later\n\nTo be split.\n\n## 3. Screens\n\n- [ ] 3.1 Button\n')
    expect(sections.map(s => s.num)).toEqual(['1', '3'])
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

  test('a plan written with no task in its tasks.md waits for review, not ready', () => {
    const turn = whoseTurn(ALL_WRITTEN, { done: 0, total: 0 }, [])
    expect(turn.phase).toBe('review')
    expect(turn.turn).toBe('you')
  })

  test('a fresh plan waits for review', () => {
    const turn = whoseTurn(ALL_WRITTEN, UNTOUCHED_COUNT, UNTOUCHED.open)
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

  test('several user actions open: the first is next, the others counted later', () => {
    const open = [
      { id: '3.1', text: 'Add the key', isUserAction: true },
      { id: '3.2', text: 'Retry', isUserAction: false },
      { id: '3.3', text: 'Check the screen', isUserAction: true },
    ]
    const turn = whoseTurn(ALL_WRITTEN, { done: 2, total: 5 }, open)
    expect(turn.yourNext?.id).toBe('3.1')
    expect(turn.yourLater).toBe(1)
  })

  test('only user actions left: your turn, nothing for the AI', () => {
    const open = [{ id: '4.1', text: 'Try it on the phone', isUserAction: true }]
    const turn = whoseTurn(ALL_WRITTEN, { done: 3, total: 4 }, open)
    expect(turn.turn).toBe('you')
    expect(turn.aiNext).toBe(undefined)
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

  test('an abbreviation does not end the Why\'s first sentence', () => {
    expect(whyLine('## Why\n\nPayments, e.g. by card, fail at night. Nobody notices.\n')).toBe('Payments, e.g. by card, fail at night.')
    expect(whyLine('## Why\n\nLes paiements, p. ex. par carte, échouent. Personne ne le voit.\n')).toBe('Les paiements, p. ex. par carte, échouent.')
  })

  test('a Why opening on a bullet or a quote reads without its mark', () => {
    expect(whyLine('## Why\n\n- Refunds are manual. They take days.\n')).toBe('Refunds are manual.')
    expect(whyLine('## Why\n\n> Refunds are manual.\n')).toBe('Refunds are manual.')
    expect(whyLine('## Why\n\n1. Refunds are manual.\n')).toBe('Refunds are manual.')
  })

  test('an empty Why gives no line, not the next section\'s', () => {
    expect(whyLine('# Proposal\n\n## Why\n\n## What Changes\n\n- Add refunds\n')).toBe(undefined)
  })

  test("the template's comment under Why is not the Why", () => {
    expect(whyLine('## Why\n\n<!-- Explain the motivation for this change. -->\n\nRefunds are manual.\n')).toBe('Refunds are manual.')
    expect(whyLine('## Why\n\n<!-- Explain\nthe motivation -->\n\n## What Changes\n')).toBe(undefined)
  })

  test('a proposal with no Why gives no line, not another section\'s', () => {
    expect(whyLine('# Proposal\n\n## What Changes\n\n- Add refunds\n')).toBe(undefined)
  })

  test('reads decisions and the open questions', () => {
    const design = '## Decisions\n\n### D1. Layout\n\n### D2. Data\n\n## Open Questions\n\n- One?\n- Two?\n'
    expect(parseDesign(design)).toEqual({ decisions: ['D1 Layout', 'D2 Data'], openQuestions: ['One?', 'Two?'] })
  })

  test('a bullet that only says there is no question is not one; anything more is, mark or not', () => {
    const questions = (bullet: string) => parseDesign(`## Open Questions\n\n- ${bullet}\n`).openQuestions
    // One object, so a failure names the bullet that was taken for a question
    const bullets = [
      'None', 'None.', 'N/A', 'Aucune', "Aucune pour l'instant.", 'Aucune pour le moment.', 'Nothing yet', '—',
      'No open questions', 'No questions yet.', 'Pas de question', 'Pas de questions ouvertes.',
    ]
    expect(Object.fromEntries(bullets.map(b => [b, questions(b)]))).toEqual(Object.fromEntries(bullets.map(b => [b, []])))
    expect(questions('None of the refunds partial?')).toEqual(['None of the refunds partial?'])
    expect(questions('None of the providers support retries, decide the fallback')).toHaveLength(1)
    expect(questions("Rien n'empêche deux écritures concurrentes : faut-il verrouiller")).toHaveLength(1)
  })

  test("a question's sub-bullets are its options, not questions", () => {
    const design = '## Open Questions\n\n- Which provider?\n  - Stripe\n  - Adyen\n- Keep the order open?\n'
    expect(parseDesign(design).openQuestions).toEqual(['Which provider?', 'Keep the order open?'])
    // Indented all alike, they are all questions
    expect(parseDesign('## Open Questions\n\n  - One?\n  - Two?\n').openQuestions).toEqual(['One?', 'Two?'])
  })

  test('a lone bullet or number takes nothing from the next line', () => {
    expect(parseDesign('## Open Questions\n\n-\nA paragraph.\n1.\nAnother.\n').openQuestions).toEqual([])
  })

  test('Why and Open Questions are found whatever the case of their heading', () => {
    expect(whyLine('## why\n\nRefunds are manual.\n')).toBe('Refunds are manual.')
    expect(parseDesign('## Open questions\n\n- Keep the order open?\n').openQuestions).toEqual(['Keep the order open?'])
  })

  test('counts requirements and scenarios', () => {
    const spec = '### Requirement: A\n#### Scenario: a1\n#### Scenario: a2\n### Requirement: B\n#### Scenario: b1\n'
    expect(specCounts(spec)).toEqual({ requirements: 2, scenarios: 3 })
  })

  test("a delta spec's removed requirements are not counted", () => {
    const delta = [
      '## ADDED Requirements', '### Requirement: Partial refund', '#### Scenario: Two items',
      '## REMOVED Requirements', '### Requirement: Manual refund', '**Reason**: automated',
      '## MODIFIED Requirements', '### Requirement: Refund', '#### Scenario: Full',
    ].join('\n')
    expect(specCounts(delta)).toEqual({ requirements: 2, scenarios: 2 })
    // Removed last, up to the end of the file
    expect(specCounts('## ADDED Requirements\n### Requirement: A\n## REMOVED Requirements\n### Requirement: B\n')).toEqual({ requirements: 1, scenarios: 0 })
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

  test('while planning, the missing document is current, the written ones stay done, apply and archive to come', () => {
    const artifacts = ALL_WRITTEN.map(a => (a.name === 'design' ? { ...a, isDone: false } : a))
    const change = { artifacts, phase: 'planning' } as Change
    expect(steps(change).map(s => `${s.name}:${s.state}`)).toEqual([
      'proposal:done',
      'specs:done',
      'design:current',
      'tasks:done',
      'apply:todo',
      'archive:todo',
    ])
  })

  test('ready to archive: apply done, archive current', () => {
    const change = { artifacts: ALL_WRITTEN, phase: 'ready' } as Change
    expect(steps(change).map(s => `${s.name}:${s.state}`)).toEqual([
      'proposal:done',
      'specs:done',
      'design:done',
      'tasks:done',
      'apply:done',
      'archive:current',
    ])
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

  test('an exact name wins over one it starts, a fragment of several picks none', () => {
    const several = ['/repo/packages/pay-later', '/repo/packages/pay', '/repo/apps/payments']
    // "pay" is a module's whole name, and the start of the two others'
    expect(resolveModule('pay', several, base)).toBe('/repo/packages/pay')
    // A fragment in several names opens none: the command lists them instead
    expect(resolveModule('ay', several, base)).toBe(undefined)
    expect(partialMatches('ay', several, base)).toEqual(several)
    // In one name only, it opens that one
    expect(resolveModule('ment', several, base)).toBe('/repo/apps/payments')
  })

  test('a name is found whatever its case', () => {
    expect(resolveModule('Paiement', paths, base)).toBe('/repo/packages/paiement')
    expect(resolveModule('PACKAGES/catalogue', paths, base)).toBe('/repo/packages/catalogue')
    expect(partialMatches('PAIE', paths, base)).toEqual(['/repo/packages/paiement'])
  })

  test('a module named "all" is picked by its path, the bare word being the overview\'s', () => {
    const withAll = ['/repo/packages/all', '/repo/packages/paiement']
    expect(resolveModule('all', withAll, base)).toBe('all')
    expect(resolveModule('packages/all', withAll, base)).toBe('/repo/packages/all')
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

  test("the reader's email is compared trimmed and whatever its case", () => {
    expect(ownerOf('Me@Example.org\tMe\n', ' me@example.org\n').isMine).toBe(true)
    expect(ownerOf('paul@example.org\tPaul\n', '   ').isMine).toBe(true)
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
    expect(whoseTurn(artifacts, UNTOUCHED_COUNT, UNTOUCHED.open).phase).toBe('review')
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
    expect(whoseTurn(artifacts, UNTOUCHED_COUNT, UNTOUCHED.open).phase).toBe('review')
  })

  test('without a verdict from openspec, a document is done when its files exist', () => {
    const { artifacts: _, ...older } = status
    expect(artifactsFrom(older).find(a => a.name === 'specs')?.isDone).toBe(false)
    // ... and the documents whose files are there are done, none of them skipped
    expect(artifactsFrom(older).filter(a => a.isDone).map(a => a.name)).toEqual(['proposal', 'design', 'tasks'])
    expect(artifactsFrom(older).some(a => a.isSkipped)).toBe(false)
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

  test('Windows paths are absolute, and name their capability', () => {
    expect(absolute('C:/repo/pay', 'C:\\repo\\pay\\openspec\\changes\\a\\specs\\refunds\\spec.md')).toBe(
      'C:/repo/pay/openspec/changes/a/specs/refunds/spec.md',
    )
    expect(specName('C:\\repo\\pay\\openspec\\changes\\a\\specs\\refunds\\spec.md')).toBe('refunds')
  })

  test('a path with no specs/ folder is named by the folder its spec.md sits in', () => {
    expect(specName('refunds/spec.md')).toBe('refunds')
    expect(specName('specs/refunds/spec.md')).toBe('refunds')
  })

  test('a relative path is read from the module folder', () => {
    expect(absolute('/repo/pay', 'openspec/changes/a/specs/x/spec.md')).toBe('/repo/pay/openspec/changes/a/specs/x/spec.md')
    expect(absolute('/repo/pay', './openspec/changes/a/specs/x/spec.md')).toBe('/repo/pay/openspec/changes/a/specs/x/spec.md')
    expect(absolute('/repo/pay', '/elsewhere/spec.md')).toBe('/elsewhere/spec.md')
  })
})

describe('tasks.md headings', () => {
  test('an unnumbered ## heading ends the numbered section before it', () => {
    const { sections, open } = parseTasks('## 1. Data\n\n- [x] 1.1 Table\n\n## Verification\n\n- [ ] Run it by hand\n\n## 2. Screens\n\n- [ ] 2.1 Button\n')
    expect(sections.map(s => [s.num, s.done, s.total])).toEqual([['1', 1, 1], ['2', 0, 1]])
    // Still a task to do, in no section
    expect(open.map(t => t.text)).toEqual(['Run it by hand', 'Button'])
  })
})

describe('openspec status without paths', () => {
  test('verdicts alone still list the documents', () => {
    const artifacts = artifactsFrom({ artifacts: [{ id: 'proposal', status: 'done' }, { id: 'design', status: 'ready' }] })
    expect(artifacts).toEqual([{ name: 'proposal', isDone: true }, { name: 'design', isDone: false }])
    expect(whoseTurn(artifacts, { done: 0, total: 0 }, []).phase).toBe('planning')
  })

  test('paths for some documents only: the verdicts keep the cycle in order', () => {
    const one = {
      artifacts: ['proposal', 'specs', 'design', 'tasks'].map(id => ({ id, status: id === 'design' ? 'ready' : 'done' })),
      artifactPaths: { proposal: { existingOutputPaths: ['proposal.md'] }, tasks: { existingOutputPaths: ['tasks.md'] } },
    }
    expect(artifactsFrom(one).map(a => a.name)).toEqual(['proposal', 'specs', 'design', 'tasks'])
    expect(whoseTurn(artifactsFrom(one), { done: 0, total: 0 }, []).aiNext?.text).toBe('write design')
  })

  test('neither paths nor verdicts: nothing, so the change folder is read instead', () => {
    expect(artifactsFrom({ changeName: 'x' })).toEqual([])
  })
})

describe('openspec missing or failing', () => {
  test('only a missing program is a PATH matter', () => {
    expect(isNotInstalled('spawn openspec ENOENT')).toBe(true)
    expect(isNotInstalled('spawn /home/me/.local/bin/openspec ENOENT')).toBe(true)
    // openspec ran and met a missing file: its own answer
    expect(isNotInstalled("ENOENT: no such file or directory, open 'openspec/config.yaml'")).toBe(false)
    expect(isNotInstalled('bash: openspec: command not found')).toBe(true)
    expect(isNotInstalled('sh: 1: openspec: not found')).toBe(true)
    expect(isNotInstalled("'openspec' is not recognized as an internal or external command")).toBe(true)
    // openspec's own answers, however they are worded
    expect(isNotInstalled('Change "add-refunds" not found')).toBe(false)
    expect(isNotInstalled('config.yaml not found in openspec/')).toBe(false)
  })
})

describe('file links', () => {
  test('an absolute path, as a file:// URL', () => {
    expect(fileUrl('/repo/openspec/changes/add-refunds/design.md')).toBe('file:///repo/openspec/changes/add-refunds/design.md')
  })
  test('spaces, accents, # and ? escaped; a Windows path gets its third slash', () => {
    expect(fileUrl('/repo/mes docs/écran#1?.md')).toBe('file:///repo/mes%20docs/%C3%A9cran%231%3F.md')
    expect(fileUrl('C:\\repo\\design.md')).toBe('file:///C:/repo/design.md')
  })
})

describe('markdown links', () => {
  test("a name's brackets and stars escaped, a target's parentheses and spaces encoded", () => {
    expect(mdText('a]b*c')).toBe('a\\]b\\*c')
    expect(mdHref('file:///repo/a(1) b.md')).toBe('file:///repo/a%281%29%20b.md')
  })
})
