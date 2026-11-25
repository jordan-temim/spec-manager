import { expect, mock, test } from 'claude-code/testing'

import { POLL_MS } from './load'

// The runner's real timers, which the engine's types leave out (their lib is es2023 alone)
declare function setTimeout(callback: (...args: unknown[]) => void, ms: number): number
declare function clearTimeout(timer: number | undefined): void

// What /spec-manager <module> answers: an ambiguous fragment, a module made since the last
// look, "all" with a single module
// `beforeList` lets a test hold a listing where it wants
const fakeRepo = (on: any, modules: string[], beforeList: (path: string) => Promise<void> | void = () => undefined) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({
    value: e.path === '/repo/.git' || modules.some(m => e.path === `/repo/packages/${m}/openspec`),
  }))
  on('fs.list', async (_: unknown, e: { path: string }) => {
    await beforeList(e.path)
    const names =
      e.path === '/repo' ? ['.git', 'packages'] : e.path === '/repo/packages' ? [...modules] : modules.some(m => e.path === `/repo/packages/${m}`) ? ['openspec'] : []
    return { value: names.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const stdout = JSON.stringify({ changes: [], specs: [] })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'spec-manager' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return clock
}

// Waits for a point the plugin should reach, at most a second, its timer cleared after
const reach = async (point: Promise<void>, what: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const isThere = await Promise.race([point.then(() => true), new Promise<boolean>(resolve => (timer = setTimeout(() => resolve(false), 1000)))])
    expect(`${what}: ${isThere ? 'reached' : 'never reached'}`).toBe(`${what}: reached`)
  } finally {
    clearTimeout(timer)
  }
}
// What the pane shows, each told by what only it draws: 'overview' (its MODULES frame),
// a module by the name in its header, 'the only module' (a module's view with no header,
// as a repository of one module draws it). Anything else fails the test. (Every
// /spec-manager opens the pane, whatever it picks: what it shows is what changes)
const shownModule = async ($: any) => {
  const ui = await $.ui.mount({ plugin: 'spec-manager', surface: 'desktop', component: 'Pane', requestId: 'spec-manager', props: { title: 'Spec Manager', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  try {
    if (await ui.find({ type: 'Text', text: /^MODULES$/ })) return 'overview'
    const header = (await ui.find({ type: 'Text', text: /^packages\/\S+ · \d+ other modules?$/ }))?.text
    if (header) return header.split(' · ')[0]
    if (await ui.find({ type: 'Text', text: /^CHANGES$/ })) return 'the only module'
    throw new Error('the pane shows neither the overview nor a module')
  } finally {
    await ui.unmount()
  }
}
const run = async ($: any, args: string) =>
  (await $.command.run({ command: 'spec-manager', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text

test('a fragment in several module names opens none and lists them', async ($, on) => {
  const clock = fakeRepo(on, ['payments', 'payroll', 'catalogue'])
  await run($, 'all')
  await clock.settle()
  expect(await run($, 'pay')).toBe('Several modules match "pay": packages/payments, packages/payroll')
  // Still the overview: no candidate opened
  expect(await shownModule($)).toBe('overview')
  expect(await run($, 'roll')).toBe('Showing packages/payroll.')
  expect(await shownModule($)).toBe('packages/payroll')
})

test('a module made since the last look is found by name at once', async ($, on) => {
  const modules = ['paiement', 'catalogue']
  const clock = fakeRepo(on, modules)
  expect(await run($, 'paiement')).toBe('Showing packages/paiement.')
  // `openspec init` in a new folder half a minute on: the modules found are not due for
  // another search yet, the command looks again for this name
  modules.push('auth')
  await clock.advance(30000)
  expect(await run($, 'auth')).toBe('Showing packages/auth.')
})

test('a name in no module says so, and lists the modules there are', async ($, on) => {
  const clock = fakeRepo(on, ['paiement', 'catalogue'])
  expect(await run($, 'catalogue')).toBe('Showing packages/catalogue.')
  await clock.settle()
  expect(await run($, 'billing')).toBe('No OpenSpec module matches "billing". Modules: packages/paiement, packages/catalogue')
  // The module open before stays open
  expect(await shownModule($)).toBe('packages/catalogue')
})

test('"all" with several modules shows the overview', async ($, on) => {
  fakeRepo(on, ['paiement', 'catalogue'])
  expect(await run($, 'paiement')).toBe('Showing packages/paiement.')
  expect(await run($, 'all')).toBe('Showing every OpenSpec module.')
  expect(await shownModule($)).toBe('overview')
})

test('"all" with a single module says it shows that module', async ($, on) => {
  fakeRepo(on, ['paiement'])
  expect(await run($, 'all')).toBe('Showing packages/paiement.')
  expect(await shownModule($)).toBe('the only module')
})

test('when the search itself fails, the command says why rather than "no match"', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.cwd', () => ({ deny: 'no working directory' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const answer = await run($, 'paiement')
  expect(answer).toContain('no working directory')
  expect(answer).not.toContain('No OpenSpec module matches')
})

// /spec-manager auth while the 10-second poll is reading: that poll does not search the
// tree, so the command waits for it, then searches itself, and finds the module made since
test('a module made while a poll is under way is still found by name', async ($, on) => {
  const modules = ['paiement', 'catalogue']
  // Once armed, the poll's look at paiement's files holds until the test lets it go
  let isArmed = false
  let held: () => void = () => undefined
  const isHeld = new Promise<void>(resolve => (held = resolve))
  let release: () => void = () => undefined
  const released = new Promise<void>(resolve => (release = resolve))
  const clock = fakeRepo(on, modules, async path => {
    if (isArmed && path === '/repo/packages/paiement/openspec') {
      isArmed = false
      held()
      await released
    }
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  // Nothing is read before /spec-manager: the command starts the pane and its polling
  await $.command.run({ command: 'spec-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.settle()
  // auth made, and the next poll caught mid-read
  modules.push('auth')
  isArmed = true
  const polling = clock.advance(POLL_MS)
  // The held poll is let go whatever happens, so a failure here reads as itself
  let answer: Promise<unknown> = Promise.resolve()
  try {
    await reach(isHeld, 'the poll held mid-read')
    let isAnswered = false
    answer = run($, 'auth').then(text => {
      isAnswered = true
      return text
    })
    // While the poll is held, the command waits for it: no answer, real time given
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(isAnswered).toBe(false)
  } finally {
    release()
  }
  // Both awaited together: a command that failed reads as this test's failure
  const [, text] = await Promise.all([polling, answer])
  expect(text).toBe('Showing packages/auth.')
})

test('a name that is a module\'s whole name opens it, even inside another\'s', async ($, on) => {
  fakeRepo(on, ['pay', 'payments'])
  expect(await run($, 'pay')).toBe('Showing packages/pay.')
})

test('with no module in the repository, any name or "all" says there is none', async ($, on) => {
  fakeRepo(on, [])
  expect(await run($, 'paiement')).toBe('No OpenSpec module in this repository (no openspec/ folder).')
  expect(await run($, 'all')).toBe('No OpenSpec module in this repository (no openspec/ folder).')
})
