// Spec Manager: a pane showing the OpenSpec changes of the repository, read from its files
// alone. The hooks: the session's start and end, the /spec-manager command, the pane

import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { ALL, moduleName, partialMatches, resolveModule } from './model'
import { PANE, POLL_MS, TITLE, handedOver, lastError, moveClock, openspecAppeared, refresh, select, sessionOf, sessions } from './load'
import type { Session } from './load'
import { renderPane } from './pane'
import type { HelpTab } from '../types'

// The same state as pane.tsx's: the state scan reads the atoms a file writes in its own consts
const help = atom({ plugin: 'spec-manager', key: 'help' } as const, '' as '' | HelpTab)

// The polling, armed once per session: a session asked again replaces its timers instead
// of adding to them. `first` false when the caller runs the first refresh itself
async function arm($: EngineInterface, s: Session, first = true) {
  if (first) void refresh($, s, true).catch(() => undefined)
  s.nextPollAt = (await $.clock.now()) + POLL_MS
  for (const timer of s.timers) timer.cancel()
  s.timers = [
    // The pane reads files only: it looks again every 30 seconds. While it has no module,
    // it looks only where `openspec init` is run, so one shows up without walking a large
    // repository's tree each time (the whole tree is walked again every 5 minutes)
    $.clock.every(POLL_MS, () => {
      void (async () => refresh($, s, false, s.found?.paths.length === 0 && (await openspecAppeared($, s.found.base))))().catch(
        () => undefined,
      )
      void $.clock
        .now()
        .then(now => {
          s.nextPollAt = now + POLL_MS
        })
        .catch(() => undefined)
    }),
    // Every second, move the clock the countdown and the "last activity" times read
    $.clock.every(1000, () => {
      void moveClock($).catch(() => undefined)
    }),
  ]
}

export const register: Register = on => {
  // A session that ends hands its state to the one that goes on in this process
  // (/clear, a resume), or lets it go (an exit): nothing piles up
  on('session.end', async ($, e, next) => {
    const one = sessions.get(e.sessionId)
    sessions.delete(e.sessionId)
    if (one && (e.reason === 'clear' || e.reason === 'resume')) handedOver.push(one)
    // Let go: its poll and clock stop with it
    else for (const timer of one?.timers ?? []) timer.cancel()
    return next(e)
  })

  // Whatever fails here, next(e) is called: the engine would skip a failing hook anyway,
  // this keeps it from being one
  // A session start only offers the command: nothing is listed, read or run in the
  // repository until /spec-manager asks for it. A start that comes again in this process
  // (an enable, a worker respawn) after /spec-manager was run picks the polling up again
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'spec-manager', description: 'Show the Spec Manager pane (OpenSpec changes)' })
      const s = await sessionOf($)
      if (s.hasOpened) await arm($, s)
    } catch {
      // No pane for this session, nothing else held up
    }
    return next(e)
  })

  // /spec-manager            opens the pane
  // /spec-manager <module>   shows that module (its folder name or the end of its path)
  // /spec-manager all        shows every module
  on('command.run', { command: 'spec-manager' }, async ($, e) => {
    const s = await sessionOf($)
    s.hasOpened = true
    await $.ui.open({ id: PANE, title: TITLE })
    // The first /spec-manager of the session starts the polling; a later one finds it armed
    if (s.timers.length === 0) await arm($, s, false)
    // The pane's own page, whatever was asked: a help page left open would hide the module
    // the command opens, or the overview it brings back
    await update($, help, () => '')
    if (e.args.trim() === '') {
      // Start over: look for the modules again and pick what to show as at session start
      s.found = undefined
      s.isReset = true
      void refresh($, s, true).catch(() => undefined)
      return { text: 'Spec Manager pane opened.' }
    }
    // No modules yet: wait for the look under way, or start one (never a second beside it)
    // A look that fails says so through lastError below, not by failing the command
    if (!s.found) await (s.running ?? refresh($, s, true, true)).catch(() => undefined)
    let target = s.found && resolveModule(e.args, s.found.paths, s.found.base)
    // Not among the modules found: one may have come since (`openspec init`), look again
    // once. A look under way is waited for first; if the module is still unknown after it
    // (that look may not have searched the tree), a new search, never one beside another.
    // Not forced: only a module new or moved is read, a typo costs the walk alone
    const isUnknown = () => s.found !== undefined && !target && partialMatches(e.args, s.found.paths, s.found.base).length === 0
    while (isUnknown() && s.running) {
      await s.running.catch(() => undefined)
      target = s.found && resolveModule(e.args, s.found.paths, s.found.base)
    }
    if (isUnknown()) {
      await refresh($, s, false, true).catch(() => undefined)
      target = s.found && resolveModule(e.args, s.found.paths, s.found.base)
    }
    const { found } = s
    // No module list at all: the search itself failed, say why rather than "no match"
    if (!found) {
      const error = await lastError($)
      return { text: error ? `openspec: ${error}` : `No OpenSpec module matches "${e.args.trim()}".` }
    }
    // A repository with no module: nothing to pick, whatever was asked ("all" included)
    if (found.paths.length === 0) return { text: 'No OpenSpec module in this repository (no openspec/ folder).' }
    if (!target) {
      const name = (p: string) => moduleName(found.base, p)
      const several = partialMatches(e.args, found.paths, found.base)
      if (several.length > 1) return { text: `Several modules match "${e.args.trim()}": ${several.map(name).join(', ')}` }
      const names = found.paths.map(name).join(', ')
      return { text: `No OpenSpec module matches "${e.args.trim()}".${names ? ` Modules: ${names}` : ''}` }
    }
    // What is shown: "all" with a single module shows that module
    const shown = await select($, s, target)
    return { text: shown === ALL ? 'Showing every OpenSpec module.' : `Showing ${moduleName(found.base, shown)}.` }
  })

  // PANE written out: the validator reads a matcher from this file's own literals
  on('ui.render', { component: 'Pane', requestId: 'spec-manager' }, ($, e) => renderPane($, e))
}
