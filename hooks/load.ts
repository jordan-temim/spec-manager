// Reading the repository: the modules found, openspec and git run in each, the view the
// pane draws and the state each session keeps between its hooks

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { ALL, absolute, artifactsFrom, artifactsFromFiles, moduleName, ownerOf, parseDesign, parseTasks, settle, specCounts, specName, steps, whoseTurn, whyLine } from './model'
import type { Artifact, Change, Digest, Module, Root, View } from '../types'

export const PANE = 'spec-manager'
export const TITLE = 'Spec Manager'

export const ARCHIVED_SHOWN = 3

export const SCAN_DEPTH = 5
export const SCAN_MAX_DIRS = 2000
export const DISCOVER_EVERY_MS = 60000
// The pane reads the files every 10 seconds; the minute's search runs at the first poll past it
export const POLL_MS = 10000
export const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', 'openspec'])

export const view = atom({ plugin: 'spec-manager', key: 'view' } as const, { roots: [], modules: [] } as View)

// What a session keeps between its hooks, apart from what it draws. Kept per session
// should the host ever run several in one process: each its own repository, its own
// refresh. Reset on each reload, which is fine (it only avoids useless work)
export type Session = {
  /** Each module's files as last read, by path: only a module whose files moved is read again */
  signatures: Map<string, string>
  /** Reads numbered as they start, and the newest that landed per module: a slow read
   *  ending after a later one never brings older data back */
  reads: number
  readAt: Map<string, number>
  /** The refresh under way, its replays included: a command that needs the modules awaits it */
  running?: Promise<void>
  /** A forced refresh asked while one runs is replayed after it, never dropped */
  isPending: boolean
  /** ... and so is a new look for the modules asked with it */
  isRediscoverPending: boolean
  /** Latest root read per module (full or light): a module opens at once from here */
  cache: Map<string, Root>
  found?: { base: string; inside?: string; paths: string[]; isCut: boolean; at: number }
  /** `/spec-manager` asked to start over: the refresh under way picks again what to show */
  isReset?: boolean
  /** The pane opens by itself once there is an OpenSpec module to show, and only once:
   *  a project without openspec/ gets no pane until /spec-manager or `openspec init` */
  hasOpened: boolean
  /** When the next look at the files is due, for the countdown in the footer */
  nextPollAt: number
  /** The poll and the clock, stopped before a session start arms them again */
  timers: { cancel: () => void }[]
}
export const sessions = new Map<string, Session>()
// A session ended by /clear or a resume: the process goes on under a new id, with no new
// session.start, its timers still running on this state. The next new id takes it over
export const handedOver: Session[] = []
export async function sessionOf($: EngineInterface): Promise<Session> {
  // No id to be had (a host or test that does not answer it): one shared state, as before
  const id = await $.session.id().catch(() => '')
  let one = sessions.get(id) ?? handedOver.shift()
  if (one) sessions.set(id, one)
  else {
    one = {
      signatures: new Map(),
      reads: 0,
      readAt: new Map(),
      isPending: false,
      isRediscoverPending: false,
      cache: new Map(),
      hasOpened: false,
      nextPollAt: 0,
      timers: [],
    }
    sessions.set(id, one)
  }
  return one
}

export const parentOf = (dir: string) => dir.slice(0, dir.lastIndexOf('/'))

// The repo top (nearest .git upward), else the session's own dir
export async function baseOf($: EngineInterface, cwd: string): Promise<string> {
  for (let dir = cwd; dir !== ''; dir = parentOf(dir)) {
    if (await $.fs.exists(`${dir}/.git`)) return dir
  }
  return cwd
}

/**
 * Every folder holding an openspec/ under the base, a few levels down, plus the
 * module the session sits in (nearest openspec/ upward, within the base)
 */
export async function discover($: EngineInterface): Promise<{ base: string; inside?: string; paths: string[]; isCut: boolean }> {
  const cwd = await $.session.cwd()
  const base = await baseOf($, cwd)
  let inside: string | undefined
  for (let dir = cwd; dir.length >= base.length && dir !== ''; dir = parentOf(dir)) {
    if (await $.fs.exists(`${dir}/openspec`)) {
      inside = dir
      break
    }
  }
  // Level by level: a level's folders take what is left of the budget in folder order
  // before any is listed, so where a large repository is cut never depends on which
  // listing answers first. A few listed at a time; each folder keeps its place in a
  // one-by-one walk (its indexes from the top), and the modules come out in that order
  type Folder = { dir: string; place: number[] }
  const modules: Folder[] = []
  let level: Folder[] = [{ dir: base, place: [] }]
  let visited = 0
  let isCut = false
  for (let depth = SCAN_DEPTH; level.length > 0; depth--) {
    const room = SCAN_MAX_DIRS - visited
    if (level.length > room) {
      isCut = true
      level = level.slice(0, room)
    }
    visited += level.length
    const listings = await pool(level, AT_ONCE, folder => $.fs.list(folder.dir).catch(() => []))
    const next: Folder[] = []
    level.forEach((folder, i) => {
      const entries = listings[i] ?? []
      if (entries.some(e => e.kind === 'dir' && e.name === 'openspec')) modules.push(folder)
      entries
        .filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name))
        .forEach((entry, j) => next.push({ dir: `${folder.dir}/${entry.name}`, place: [...folder.place, j] }))
    })
    level = depth > 0 ? next : []
  }
  const byPlace = (a: Folder, b: Folder) => {
    for (let i = 0; i < Math.min(a.place.length, b.place.length); i++) if (a.place[i] !== b.place[i]) return a.place[i]! - b.place[i]!
    return a.place.length - b.place.length
  }
  const paths = modules.sort(byPlace).map(folder => folder.dir)
  if (inside && !paths.includes(inside)) paths.unshift(inside)
  return { base, inside, paths, isCut }
}

// Which module to show: the one the session sits in, else the last one picked in
// this repo, else the overview; a single module is shown directly
export async function initialSelection($: EngineInterface, base: string, inside: string | undefined, paths: string[]) {
  if (paths.length <= 1) return paths[0] ?? ALL
  if (inside) return inside
  const remembered = await $.store.get(`selected:${base}`)
  return typeof remembered === 'string' && (remembered === ALL || paths.includes(remembered)) ? remembered : ALL
}

export async function select($: EngineInterface, s: Session, wanted: string): Promise<string> {
  const { found } = s
  const selected = found ? (settle(wanted, found.paths) ?? wanted) : wanted
  if (found) await $.store.set(`selected:${found.base}`, selected)
  // Draw at once from what is already read, then fill in that one module only
  const cached = s.cache.get(selected)
  await update($, view, old => ({ ...old, selected, roots: cached ? [cached] : [] }))
  if (selected !== ALL) void loadSelected($, s, selected)
  return selected
}

// A module read afresh, kept only if no later read of it landed first
export async function readKept($: EngineInterface, s: Session, path: string, full: boolean) {
  const n = ++s.reads
  // A failing openspec comes back as the module's own error, shown in its view
  const root = await readRoot($, path, full)
  if (n < (s.readAt.get(path) ?? 0)) return undefined
  s.readAt.set(path, n)
  s.cache.set(path, root)
  return root
}

export async function loadSelected($: EngineInterface, s: Session, path: string) {
  try {
    const root = await readKept($, s, path, true)
    if (root) await update($, view, old => (old.selected === path ? { ...old, roots: [root] } : old))
  } catch {
    // The session went away mid-read: nothing left to draw
  }
}

// Cheap fingerprint of the openspec/ trees, so openspec only runs when something moved
// Four levels: down to a change's specs/<capability>/spec.md, whose edit in place
// moves no folder's time. The archive is not opened: archived changes no longer move,
// and one archived or taken out moves the archive folder's own time
export async function signature($: EngineInterface, root: string): Promise<string> {
  const parts: string[] = []
  const walk = async (dir: string, depth: number) => {
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      parts.push(`${dir}/${entry.name}:${entry.mtimeMs}`)
      const isArchive = entry.name === 'archive' && dir.endsWith('/openspec/changes')
      if (entry.kind === 'dir' && depth > 0 && !isArchive) await walk(`${dir}/${entry.name}`, depth - 1)
    }
  }
  await walk(`${root}/openspec`, 4)
  return parts.join('|')
}

// Each openspec command is written out in full, so what the pane runs reads from the source
export type Run = { exitCode: number; stdout: string; stderr: string }
export const parsed = async (run: Promise<Run>, command: string): Promise<any> => {
  const { exitCode, stdout, stderr } = await run
  if (exitCode !== 0) throw new Error(stderr.trim() || `${command} failed`)
  try {
    return JSON.parse(stdout)
  } catch {
    // A warning or an update notice in place of JSON, or an openspec without --json
    throw new Error(`${command} gave no JSON: ${stdout.trim().slice(0, 80) || '(nothing)'}`)
  }
}
export function openspecList($: EngineInterface, cwd: string) {
  return parsed($.process.run(['openspec', 'list', '--json'], { cwd }), 'openspec list')
}
export function openspecStatus($: EngineInterface, cwd: string) {
  return parsed($.process.run(['openspec', 'status', '--all', '--json'], { cwd }), 'openspec status')
}
export function openspecSpecs($: EngineInterface, cwd: string) {
  return parsed($.process.run(['openspec', 'list', '--specs', '--sort', 'name', '--json'], { cwd }), 'openspec list --specs')
}
export function openspecArchived($: EngineInterface, cwd: string) {
  return parsed($.process.run(['openspec', 'list', '--archived', '--json'], { cwd }), 'openspec list --archived')
}

export async function filesOf($: EngineInterface, changeRoot: string) {
  const names = (await $.fs.list(changeRoot).catch(() => [])).map(entry => entry.name)
  const specDirs = names.includes('specs')
    ? (await $.fs.list(`${changeRoot}/specs`).catch(() => [])).filter(entry => entry.kind === 'dir').map(entry => entry.name)
    : []
  return {
    artifacts: artifactsFromFiles(names, specDirs),
    specPaths: specDirs.map(dir => `${changeRoot}/specs/${dir}/spec.md`),
  }
}

export async function loadDigest($: EngineInterface, changeRoot: string, specPaths: string[]) {
  const readFile = (file: string) => $.fs.read(file).catch(() => '')
  const [proposal, design, ...specs] = await Promise.all([
    readFile(`${changeRoot}/proposal.md`),
    readFile(`${changeRoot}/design.md`),
    ...specPaths.map(readFile),
  ])
  return {
    why: whyLine(proposal),
    specs: specPaths.map((file, i) => ({
      name: specName(file),
      file,
      ...specCounts(specs[i] ?? ''),
    })),
    ...parseDesign(design),
    // Where each line of the digest comes from: the pane links its label there
    files: {
      ...(proposal.trim() ? { proposal: `${changeRoot}/proposal.md` } : {}),
      ...(design.trim() ? { design: `${changeRoot}/design.md` } : {}),
    },
  }
}

// The reader's git email, per repository; empty outside git or when unset. Only an
// email is kept: an empty answer is asked again, so one set later is picked up
export const emails = new Map<string, Promise<string>>()
export function myEmail($: EngineInterface, cwd: string) {
  if (!emails.has(cwd)) {
    const email = $.process
      .run(['git', 'config', 'user.email'], { cwd })
      .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''))
      .catch(() => '')
    emails.set(cwd, email)
    void email.then(found => {
      if (found === '') emails.delete(cwd)
    })
  }
  return emails.get(cwd)!
}

// A change folder's first commit, once it has one: who made it never changes, so git is
// asked once per change. A folder not committed yet is asked again at its next read
export const firstCommits = new Map<string, string>()
export async function ownership($: EngineInterface, cwd: string, dir: string) {
  const me = await myEmail($, cwd)
  if (me === '') return { isMine: true }
  let first = firstCommits.get(dir)
  if (first === undefined) {
    const log = await $.process
      .run(['git', 'log', '--reverse', '--format=%ae%x09%an', '--', dir], { cwd })
      .catch(() => undefined)
    if (!log || log.exitCode !== 0) return { isMine: true }
    first = log.stdout.split('\n').find(line => line.trim() !== '') ?? ''
    if (first !== '') firstCommits.set(dir, first)
  }
  return ownerOf(first, me)
}

// At most this many modules read at once, and as many changes within each: a monorepo's
// modules, each running openspec and git per change, would otherwise start hundreds of
// processes in one go
export const AT_ONCE = 4
export async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await work(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// `full` false: just enough to know each change's turn, for a module seen in the overview
export async function loadRoot($: EngineInterface, path: string, full = true): Promise<Root> {
  const [list, status, specs, archived] = await Promise.all([
    openspecList($, path),
    openspecStatus($, path).catch(() => ({ changes: [] })),
    full ? openspecSpecs($, path).catch(() => ({ specs: [] })) : { specs: [] },
    full ? openspecArchived($, path).catch(() => ({ changes: [] })) : { changes: [] },
  ])
  const artifactsOf = new Map<string, Artifact[]>()
  const specPathsOf = new Map<string, string[]>()
  for (const one of status.changes ?? []) {
    const artifacts = artifactsFrom(one)
    // Nothing usable for this change: its documents are read from its folder instead
    if (artifacts.length > 0) artifactsOf.set(one.changeName, artifacts)
    // Only what status gives: without it, the change's specs/ folders are read instead
    const specFiles = one.artifactPaths?.specs?.existingOutputPaths
    if (Array.isArray(specFiles) && specFiles.length > 0) specPathsOf.set(one.changeName, specFiles.map((file: string) => absolute(path, file)))
  }
  // A change gone from the list (archived) frees its folder's name: who made it is
  // forgotten, so a change made again under that name is asked of git anew
  const names = new Set((list.changes ?? []).map((one: any) => `${path}/openspec/changes/${one.name}`))
  for (const dir of firstCommits.keys()) {
    if (dir.startsWith(`${path}/openspec/changes/`) && !names.has(dir)) firstCommits.delete(dir)
  }
  const changes: Change[] = await pool(list.changes ?? [], AT_ONCE, async (one: any) => {
    const changeRoot = `${path}/openspec/changes/${one.name}`
    // A failed `openspec status` read as no documents put every change in review
    const files = artifactsOf.has(one.name) && specPathsOf.has(one.name) ? undefined : await filesOf($, changeRoot)
    const artifacts = artifactsOf.get(one.name) ?? files?.artifacts ?? []
    const specPaths = specPathsOf.get(one.name) ?? files?.specPaths ?? []
    const [markdown, digest, owned] = await Promise.all([
      $.fs.read(`${changeRoot}/tasks.md`).catch(() => ''),
      full ? loadDigest($, changeRoot, specPaths) : ({ specs: [], decisions: [], openQuestions: [] } as Digest),
      ownership($, path, changeRoot),
    ])
    const { sections, open } = parseTasks(markdown)
    const tasks = { done: one.completedTasks ?? 0, total: one.totalTasks ?? 0 }
    return {
      name: one.name,
      tasks,
      artifacts,
      sections,
      digest: full && markdown.trim() ? { ...digest, files: { ...digest.files, tasks: `${changeRoot}/tasks.md` } } : digest,
      lastModified: one.lastModified,
      ...owned,
      ...whoseTurn(artifacts, tasks, open),
    }
  })
  // The reader's own changes first
  changes.sort((a, b) => Number(b.isMine) - Number(a.isMine))
  const archivedNames: string[] = (archived.changes ?? []).map((one: any) => one.name)
  return {
    path,
    changes,
    specs: (specs.specs ?? []).map((one: any) => ({ id: one.id, requirements: one.requirementCount ?? 0 })),
    archived: archivedNames.slice(0, ARCHIVED_SHOWN),
    archivedTotal: archivedNames.length,
    ...(full ? {} : { isLight: true }),
  }
}

export const summarize = (base: string, root: Root): Module => ({
  name: moduleName(base, root.path),
  path: root.path,
  changes: root.changes.length,
  mine: root.changes.filter(c => c.isMine).length,
  you: root.changes.filter(c => c.isMine && c.turn === 'you').length,
  ai: root.changes.filter(c => c.isMine && c.turn === 'ai').length,
  others: [...new Set(root.changes.filter(c => !c.isMine).map(c => c.owner ?? '?'))],
  items: root.changes.map(c => {
    const stepper = steps(c)
    return {
      name: c.name,
      step: stepper.findIndex(s => s.state === 'current'),
      steps: stepper.length,
      turn: c.turn,
      isMine: c.isMine,
      owner: c.owner,
    }
  }),
  lastModified: root.changes.map(c => c.lastModified ?? '').sort().pop() || undefined,
  ...(root.error ? { error: root.error } : {}),
})

// A module whose openspec fails is shown failing on its own card or view: the others
// still read. Only when every module fails does the error take the whole pane
export function readRoot($: EngineInterface, path: string, full = true): Promise<Root> {
  return loadRoot($, path, full).catch(err => ({
    path,
    changes: [],
    specs: [],
    archived: [],
    archivedTotal: 0,
    error: err instanceof Error ? err.message : String(err),
  }))
}

export function refresh($: EngineInterface, s: Session, force = false, rediscover = false): Promise<void> {
  if (s.running) {
    if (force) {
      s.isPending = true
      s.isRediscoverPending ||= rediscover
    }
    return s.running
  }
  const run = async () => {
    try {
      await refreshOnce($, s, force, rediscover)
      while (s.isPending) {
        const again = s.isRediscoverPending
        s.isPending = false
        s.isRediscoverPending = false
        await refreshOnce($, s, true, again)
      }
    } finally {
      // In the very turn the last check found nothing pending: a forced refresh asked from
      // here on starts anew rather than waiting on this one, finished, and being dropped
      if (s.running === current) s.running = undefined
    }
  }
  const current = run()
  s.running = current
  return current
}

export async function refreshOnce($: EngineInterface, s: Session, force: boolean, rediscover: boolean) {
  try {
    const now = await $.clock.now()
    // Its own copy: `/spec-manager` may reset `found` while this one awaits
    let current = s.found
    // Walking the tree is the costly part: redo it once a minute, or when asked
    if (rediscover || !current || now - current.at > DISCOVER_EVERY_MS) {
      const isFirst = !current
      current = { ...(await discover($)), at: now }
      s.found = current
      // A reset asked while this walk ran picks again too (the walk's isFirst predates it)
      const isReset = s.isReset === true
      s.isReset = false
      if (!s.hasOpened && current.paths.length > 0) {
        s.hasOpened = true
        // Refused (no surface to seat it): it opens by itself again at the next find
        void $.ui.open({ id: PANE, title: TITLE }).catch(() => {
          s.hasOpened = false
        })
      }
      if (isFirst || isReset || (await read($, view)).selected === undefined) {
        const selected = await initialSelection($, current.base, current.inside, current.paths)
        await update($, view, old => ({ ...old, selected }))
      }
    }
    const { base, paths } = current
    const wanted = (await read($, view)).selected
    const selected = settle(wanted, paths)
    // Read again only what may have moved: a module whose files did, one that failed, the
    // selected one while only its light read is at hand; all of them when forced
    const sigs = await pool(paths, AT_ONCE, p => signature($, p))
    const stale = paths.filter((p, i) => {
      const cached = s.cache.get(p)
      return force || !cached || cached.error !== undefined || sigs[i] !== s.signatures.get(p) || (p === selected && cached.isLight)
    })
    // A module gone since the last read (its openspec/ removed) moves no other module's
    // files: its going is a change of its own, and what was kept of it goes with it
    // Every module kept a trace of, signed or not (an error wipes the signatures alone)
    const gone = [...new Set([...s.signatures.keys(), ...s.cache.keys()])].filter(p => !paths.includes(p))
    for (const p of gone) {
      s.signatures.delete(p)
      s.cache.delete(p)
      s.readAt.delete(p)
    }
    paths.forEach((p, i) => s.signatures.set(p, sigs[i]!))
    // Nothing moved, and the module shown still among them (else it settles below)
    if (stale.length === 0 && gone.length === 0 && selected === wanted) {
      // Say when it was last checked, and that this look went through
      await update($, view, old => ({ ...old, updatedAt: now, now, error: undefined }))
      return
    }
    // Every module is read light for the overview; the selected one in full
    await pool(stale, AT_ONCE, p => readKept($, s, p, p === selected))
    const all = paths.map(p => s.cache.get(p)).filter((root): root is Root => root !== undefined)
    const failed = all.filter(root => root.error)
    if (failed.length > 0 && failed.length === all.length) throw new Error(failed[0]!.error)
    const modules = all.map(root => summarize(base, root))
    const roots = all.filter(root => root.path === selected)
    // A module picked while this read keeps its pick: select() and loadSelected own its roots
    let shown = selected
    await update($, view, old => {
      shown = old.selected
      return old.selected === wanted
        ? { ...old, roots, modules, selected, updatedAt: now, now, error: undefined }
        : { ...old, modules, updatedAt: now, now, error: undefined }
    })
    // That pick's full read may have lost to this one's light read of the same module, newer
    // but without digest, specs or archive: the module shown is read in full again
    if (shown && shown !== ALL && s.cache.get(shown)?.isLight) void loadSelected($, s, shown)
  } catch (err) {
    s.signatures.clear()
    const message = err instanceof Error ? err.message : String(err)
    await update($, view, old => ({ ...old, error: message }))
  }
}

// The clock the countdown and the "last activity" times read: each move redraws the pane,
// so only while it is shown (on a host that cannot say, always)
export async function moveClock($: EngineInterface) {
  const panes = await $.ui.panes().catch(() => undefined)
  if (panes && !panes.some(pane => pane.id === PANE && pane.isShown)) return
  const now = await $.clock.now()
  await update($, view, old => ({ ...old, now }))
}

// What the last refresh failed on, if it did
export async function lastError($: EngineInterface) {
  return (await read($, view)).error
}

// An openspec/ in the session's folder or at the repository top, where `openspec init` is run
export async function openspecAppeared($: EngineInterface, base: string) {
  const cwd = await $.session.cwd()
  for (const dir of new Set([cwd, base])) {
    if (await $.fs.exists(`${dir}/openspec`)) return true
  }
  return false
}
