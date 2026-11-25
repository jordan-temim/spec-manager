import { expect, mock, test } from 'claude-code/testing'

import { DISCOVER_EVERY_MS, POLL_MS } from './load'

// The runner's real timers, which the engine's types leave out (their lib is es2023 alone)
declare function setTimeout(callback: (...args: unknown[]) => void, ms: number): number
declare function clearTimeout(timer: number | undefined): void

// /spec-manager <module> typed while the session's first look for modules is still
// walking the tree: the command waits for it instead of finding nothing
const MODULE = '/repo/packages/paiement'

// A promise and what settles it: a point the plugin reaches, or a hold the test lets go
const deferred = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>(settle => (resolve = settle))
  return { promise, resolve }
}

// Waits for a point the plugin should reach, at most a second: a regression that never
// gets there fails the test, naming the point, instead of hanging it
const reach = async (point: Promise<void>, what: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const isThere = await Promise.race([point.then(() => true), new Promise<boolean>(resolve => (timer = setTimeout(() => resolve(false), 1000)))])
    expect(`${what}: ${isThere ? 'reached' : 'never reached'}`).toBe(`${what}: reached`)
  } finally {
    clearTimeout(timer)
  }
}
// The first walk below the repository top holds until `release`; `isHeld` resolves once
// it does. Every listing of that folder is counted: a second walk would show
const fakeRepo = (on: any) => {
  const { promise: walked, resolve: release } = deferred()
  const { promise: isHeld, resolve: held } = deferred()
  const walks = { count: 0 }
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: ['/repo/.git', `${MODULE}/openspec`].includes(e.path) }))
  on('fs.list', async (_: unknown, e: { path: string }) => {
    if (e.path === '/repo/packages' && ++walks.count === 1) {
      held()
      await walked
    }
    const names = e.path === '/repo' ? ['.git', 'packages'] : e.path === '/repo/packages' ? ['paiement'] : e.path === MODULE ? ['openspec'] : []
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const [cmd, verb] = e.argv
    const stdout = JSON.stringify({ changes: [], specs: [] })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { release, isHeld, walks }
}

test('/spec-manager <module> during the first look for modules waits for it', async ($, on) => {
  const { release, isHeld, walks } = fakeRepo(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  // The first /spec-manager starts the first look. Not awaited before the release either:
  // a command that waited for its first look would make the test fail on isHeld below,
  // not hang
  const started = $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  let answer: Promise<{ text?: string }> = Promise.resolve({})
  try {
    // The session's first look is under way, held in the middle of its walk
    await reach(isHeld, 'the first walk held')
    let isAnswered = false
    answer = $.command.run({ command: 'spec-manager', args: 'paiement', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    void answer.then(() => (isAnswered = true))
    // Real time for a command that would not wait to answer, its own walk included (which,
    // only the first being held, would go through)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(isAnswered).toBe(false)
    // ... and no walk of its own beside the one under way
    expect(walks.count).toBe(1)
  } finally {
    // The held walk let go whatever happened above
    release()
  }
  expect((await answer).text).toBe('Showing packages/paiement.')
  await started
})


// The three tests below: two modules, paiement and catalogue, each with one change named
// by `changeIn` (read when openspec is asked). A test stops a listing or an openspec run
// where it wants with `beforeList` and `beforeOpenspec`
type TwoModules = {
  cwd?: string
  changeIn?: (dir: string) => string
  beforeList?: (path: string) => Promise<void> | void
  beforeOpenspec?: (dir: string) => Promise<void> | void
}
const twoModules = ($: any, on: any, options: TwoModules = {}) => {
  const { cwd = '/repo', changeIn = (dir: string) => (dir.endsWith('catalogue') ? 'variants' : 'pay-v2') } = options
  const clock = mock.clock(on)
  mock.store(on)
  const dirs: Record<string, string[]> = {
    '/repo': ['.git', 'packages'],
    '/repo/packages': ['paiement', 'catalogue'],
    '/repo/packages/paiement': ['openspec'],
    '/repo/packages/catalogue': ['openspec'],
  }
  on('session.cwd', () => ({ value: cwd }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: ['/repo/.git', '/repo/packages/paiement/openspec', '/repo/packages/catalogue/openspec'].includes(e.path),
  }))
  on('fs.list', async (_: unknown, e: { path: string }) => {
    await options.beforeList?.(e.path)
    return { value: (dirs[e.path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', async (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    const [cmd, verb, flag] = e.argv
    const out = (body: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (flag === '--specs' || flag === '--archived' || verb === 'status') return out({ changes: [], specs: [] })
    const dir = e.init?.cwd ?? ''
    const name = changeIn(dir)
    await options.beforeOpenspec?.(dir)
    return out({ changes: [{ name, completedTasks: 0, totalTasks: 0 }] })
  })
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const run = (args: string) => $.command.run({ command: 'spec-manager', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const mount = () =>
    $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  return { clock, run, mount }
}

// A module picked while a refresh is reading the modules stays picked
test('a module picked during a refresh is not undone when the refresh ends', async ($, on) => {
  // Once armed, openspec in paiement holds until the test lets it go
  let isArmed = false
  const { promise: isReached, resolve: reached } = deferred()
  const { promise: released, resolve: release } = deferred()
  const { clock, run, mount } = twoModules($, on, {
    beforeOpenspec: async dir => {
      if (isArmed && dir.endsWith('paiement')) {
        reached()
        await released
      }
    },
  })

  await run('all')
  await clock.settle()
  // A fresh look for the modules, held while it reads paiement
  isArmed = true
  // Not awaited before the release: were the command to wait for the refresh, the
  // test would fail on its answer instead of hanging
  const reset = run('')
  let pick: Promise<unknown> = Promise.resolve()
  try {
    await reach(isReached, 'the refresh reading paiement')
    isArmed = false
    // The pick, not awaited either: it must land while the refresh is still held, and
    // the test says so rather than hanging should the command ever wait for it
    pick = run('catalogue')
    await reach(pick.then(() => undefined), 'the pick answered while the refresh was held')
  } finally {
    release()
  }
  await pick
  await reset
  await clock.settle()

  const ui = await mount()
  // A module's view (the overview has no "‹ All modules"), and that module catalogue:
  // its name in the header, its change shown, paiement's not
  expect(await ui.find({ key: 'modules:all' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^packages\/catalogue · 1 other module$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /variants/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBe(undefined)
  await ui.unmount()
})

// A slow read of a module that ends after a newer one does not bring its older data back
test('a slow read ending after a newer one leaves the newer data shown', async ($, on) => {
  // paiement's change is renamed between the two reads; once armed, the next openspec run
  // there answers with the name it was asked under, but only when the test lets it go
  let change = 'old-change'
  let isArmed = false
  const { promise: isReached, resolve: reached } = deferred()
  const { promise: released, resolve: release } = deferred()
  const { clock, run, mount } = twoModules($, on, {
    changeIn: dir => (dir.endsWith('catalogue') ? 'variants' : change),
    beforeOpenspec: async dir => {
      if (isArmed && dir.endsWith('paiement')) {
        isArmed = false
        reached()
        await released
      }
    },
  })

  await run('all')
  await clock.settle()
  // Opening paiement starts its full read, held with the old name
  isArmed = true
  try {
    // Not awaited before the hold is seen: a command waiting for that read would fail the
    // test on the reach below, not hang it
    const open = run('paiement')
    await reach(isReached, "paiement's full read")
    await reach(open.then(() => undefined), 'the command answered while the read was held')
    // Meanwhile the change is renamed and a fresh refresh reads it, to its end
    change = 'new-change'
    // Not awaited as such: a refresh that waited for the held read would fail the reach
    await reach(run('').then(() => undefined), 'the fresh refresh answered')
    await clock.settle()
  } finally {
    // The held read ends last, whatever happened above
    release()
  }
  await clock.settle()

  const ui = await mount()
  try {
    expect(await ui.find({ type: 'Text', text: /new-change/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /old-change/ })).toBe(undefined)
  } finally {
    await ui.unmount()
  }
})

// /spec-manager without an argument starts over, as at session start, even while a search
// for modules is under way
test('a reset asked during a search picks again what to show',
  // Five minutes of the clock's one-second ticks take real time: more than the default
  // 5 seconds on a busy machine
  { timeoutMs: 20000 },
  async ($, on) => {
  // The pane not shown: the one-second ticks redraw nothing, so five minutes of them stay quick
  on('ui.panes', () => ({ value: [] }))
  // The session sits in paiement: what it shows at start, and again after a reset
  let isArmed = false
  const { promise: isHeld, resolve: held } = deferred()
  const { promise: released, resolve: release } = deferred()
  const { clock, run, mount } = twoModules($, on, {
    cwd: '/repo/packages/paiement',
    beforeList: async path => {
      if (isArmed && path === '/repo/packages') {
        isArmed = false
        held()
        await released
      }
    },
  })

  await $.session.start({ cwd: '/repo/packages/paiement', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await run('catalogue')
  await clock.settle()
  // Up to the search's due time first, awaited: its 300 one-second ticks would otherwise
  // run within the real-time wait of the reach below
  await clock.advance(DISCOVER_EVERY_MS)
  await clock.settle()
  // The next poll's search, held mid-walk; the reset comes meanwhile
  isArmed = true
  // Neither the clock nor the reset awaited while the search is held: were either to wait
  // for it, the reaches fail the test instead of hanging it
  const advanced = clock.advance(POLL_MS)
  try {
    await reach(isHeld, 'the search held')
    await reach(run('').then(() => undefined), 'the reset answered')
  } finally {
    release()
  }
  await advanced
  await clock.settle()

  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /variants/ })).toBe(undefined)
  await ui.unmount()
})

// A module opened while a refresh that began on the overview reads it light: that light
// read, newer, lands before the module's full read, which is then set aside. The module
// shown is read in full again, so its specs and archive do not stay "…"
test('a module opened during an overview refresh ends up read in full', async ($, on) => {
  let isListArmed = false
  let isRunArmed = false
  const { promise: listHeld, resolve: listHolds } = deferred()
  const { promise: listGo, resolve: letList } = deferred()
  const { promise: fullHeld, resolve: fullHolds } = deferred()
  const { promise: fullGo, resolve: letFull } = deferred()
  const { clock, run, mount } = twoModules($, on, {
    // The refresh's fingerprint of paiement holds, so the user opens it meanwhile
    beforeList: async path => {
      if (isListArmed && path === '/repo/packages/paiement/openspec') {
        isListArmed = false
        listHolds()
        await listGo
      }
    },
    // ... and the full read that opening starts holds too, to land last
    beforeOpenspec: async dir => {
      if (isRunArmed && dir.endsWith('paiement')) {
        isRunArmed = false
        fullHolds()
        await fullGo
      }
    },
  })

  await run('all')
  await clock.settle()
  try {
    // A refresh from the overview, held in its fingerprint
    isListArmed = true
    await run('')
    await reach(listHeld, "the refresh's fingerprint held")
    // paiement opened: its full read starts, and holds
    isRunArmed = true
    const open = run('paiement')
    await reach(fullHeld, "paiement's full read held")
    await reach(open.then(() => undefined), 'the command answered')
    // The refresh goes on and reads paiement light, to its end
    letList()
    await clock.settle()
  } finally {
    letList()
    letFull()
  }
  await clock.settle()

  const ui = await mount()
  try {
    expect(await ui.find({ type: 'Text', text: /pay-v2/ })).toBeDefined()
    // Read in full: SPECS and ARCHIVED count, they do not wait with "…"
    expect(await ui.find({ type: 'Box', text: /SPECS …/ })).toBe(undefined)
    expect(await ui.find({ type: 'Box', text: /SPECS 0/ })).toBeDefined()
  } finally {
    await ui.unmount()
  }
})

// The module shown dropped from those listed (gone between two looks): while `isOn`, the
// view as read says so; with `isOnce`, only until the plugin's next write keeps it so
const goneModule = (on: any, isOnce = false) => {
  on('state.get', async (_: unknown, e: any, next: (e: unknown) => any) => {
    const r = await next(e)
    if (!gone.isOn || e.key !== 'view' || !r?.value?.value) return r
    return { ...r, value: { ...r.value, value: { ...r.value.value, selected: '/repo/packages/gone', roots: [] } } }
  })
  // What the first write after the view went missing kept: the module it was on
  const gone = { isOn: false, kept: undefined as string | undefined }
  on('state.set', (_: unknown, e: { key: string; value?: { selected?: string } }, next: (e: unknown) => unknown) => {
    if (isOnce && gone.isOn && e.key === 'view') {
      gone.kept = e.value?.selected
      gone.isOn = false
    }
    return next(e)
  })
  return gone
}

test('a module shown but no longer listed keeps the way back to the overview', async ($, on) => {
  // Gone until the press writes the view: the press itself starts from the gone module
  const gone = goneModule(on, true)
  const { clock, run, mount } = twoModules($, on)
  await run('catalogue')
  await clock.settle()
  gone.isOn = true
  const ui = await mount()
  try {
    expect(await ui.find({ type: 'Text', text: /^gone · 2 other modules$/ })).toBeDefined()
    expect(gone.isOn).toBe(true)
    await ui.press({ key: 'modules:all' })
    expect(await ui.find({ type: 'Text', text: /^MODULES$/ })).toBeDefined()
  } finally {
    await ui.unmount()
  }
})

test('a poll where nothing moved takes the pane off a module no longer listed', async ($, on) => {
  const gone = goneModule(on, true)
  const { clock, run, mount } = twoModules($, on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await run('catalogue')
  await clock.settle()
  // Kept as shown on a module no longer listed, by the next write of the view
  gone.isOn = true
  await clock.advance(POLL_MS)
  await clock.settle()
  expect(gone.isOn).toBe(false)
  // ... and that write did keep it on the gone module, for the next poll to correct
  expect(gone.kept).toBe('/repo/packages/gone')
  // The poll after finds the files as they were: it settles on the overview all the same
  await clock.advance(POLL_MS)
  await clock.settle()
  const ui = await mount()
  try {
    expect(await ui.find({ type: 'Text', text: /^MODULES$/ })).toBeDefined()
    expect(await ui.find({ key: 'modules:all' })).toBe(undefined)
  } finally {
    await ui.unmount()
  }
})
