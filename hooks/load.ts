// Reading the repository: the modules found, openspec run in each, the view the
// pane draws and the state each session keeps between its hooks

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { ALL, artifactsFrom, artifactsFromFiles, isDocOf, isPlainName, moduleName, parseDesign, parseTasks, settle, specCounts, specName, steps, whoseTurn, whyLine } from './model'
import type { Artifact, Change, Digest, Module, Root, View } from '../types'

export const PANE = 'spec-manager'
export const TITLE = 'Spec Manager'

export const ARCHIVED_SHOWN = 3

export const SCAN_DEPTH = 5
export const SCAN_MAX_DIRS = 2000
export const DISCOVER_EVERY_MS = 300000
// The pane reads the files every 30 seconds; the search for modules, every 5 minutes, runs
// at the first poll past it
export const POLL_MS = 30000
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
  /** /spec-manager was run in this session: the pane never opens, and nothing in the
   *  repository is read or run, before it */
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

// A folder's openspec/, there as a folder of its own, not a symbolic link: told by the
// folder's listing, which names the link without following it
export async function hasOwnOpenspec($: EngineInterface, dir: string): Promise<boolean> {
  const entries = await $.fs.list(dir).catch(() => [])
  return entries.some(entry => entry.name === 'openspec' && entry.kind === 'dir' && !entry.isLink)
}

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
    // Only an openspec/ that is the folder's own: one that is a symbolic link makes no
    // module, here as in the walk below, and is never listed. The way up goes on past it,
    // to the module the session sits in further up
    if ((await $.fs.exists(`${dir}/openspec`)) && (await hasOwnOpenspec($, dir))) {
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
      // A symbolic link is not followed, nor an openspec/ that is one: the walk stays in
      // the repository's own folders
      if (entries.some(e => e.kind === 'dir' && e.name === 'openspec' && !e.isLink)) modules.push(folder)
      entries
        .filter(entry => entry.kind === 'dir' && !entry.isLink && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name))
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
  // An openspec/ that is a symbolic link is never walked: its listing would be the
  // folder it points to, outside the repository
  if (!(await hasOwnOpenspec($, root))) return 'not its own openspec/'
  const parts: string[] = []
  const walk = async (dir: string, depth: number) => {
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      parts.push(`${dir}/${entry.name}:${entry.mtimeMs}`)
      const isArchive = entry.name === 'archive' && dir.endsWith('/openspec/changes')
      // A symbolic link counts by its own time, never walked into
      if (entry.kind === 'dir' && !entry.isLink && depth > 0 && !isArchive) await walk(`${dir}/${entry.name}`, depth - 1)
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
// openspec run with its telemetry (and its update check, which reads the same signals)
// off: the pane runs it by itself, every poll a file moved, and sends nothing out through
// it. Added to the environment the engine gives, which keeps the PATH
export const OPENSPEC_ENV = { OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1' } as const
// A command that hangs is stopped: an openspec stuck on a module would hold the refresh,
// and /spec-manager waiting on it, for as long as it ran. The module then shows the error
export const OPENSPEC_TIMEOUT_MS = 15000
export function openspecList($: EngineInterface, cwd: string) {
  return parsed($.process.run(['openspec', 'list', '--json'], { cwd, env: OPENSPEC_ENV, timeoutMs: OPENSPEC_TIMEOUT_MS }), 'openspec list')
}
export function openspecStatus($: EngineInterface, cwd: string) {
  return parsed($.process.run(['openspec', 'status', '--all', '--json'], { cwd, env: OPENSPEC_ENV, timeoutMs: OPENSPEC_TIMEOUT_MS }), 'openspec status')
}
export function openspecSpecs($: EngineInterface, cwd: string) {
  return parsed($.process.run(['openspec', 'list', '--specs', '--sort', 'name', '--json'], { cwd, env: OPENSPEC_ENV, timeoutMs: OPENSPEC_TIMEOUT_MS }), 'openspec list --specs')
}
export function openspecArchived($: EngineInterface, cwd: string) {
  return parsed($.process.run(['openspec', 'list', '--archived', '--json'], { cwd, env: OPENSPEC_ENV, timeoutMs: OPENSPEC_TIMEOUT_MS }), 'openspec list --archived')
}

// The documents of a change the pane reads, by name in its folder
export const DOCS = ['proposal.md', 'design.md', 'tasks.md']

// A change's documents, found in its own folder: plain .md files, never a symbolic link
// (to a file or a folder), so a read never leaves the repository. They are the only files
// read: openspec's own paths (status's existingOutputPaths) say whether a document is
// written, never where to read
export async function filesOf($: EngineInterface, changeRoot: string) {
  const isPlainFile = (entry: { kind: string; isLink?: boolean }) => entry.kind === 'file' && !entry.isLink
  const isPlainDir = (entry: { kind: string; isLink?: boolean }) => entry.kind === 'dir' && !entry.isLink
  const entries = await $.fs.list(changeRoot).catch(() => [])
  const names = entries.filter(isPlainFile).map(entry => entry.name)
  const specDirs = entries.some(entry => entry.name === 'specs' && isPlainDir(entry))
    ? (await $.fs.list(`${changeRoot}/specs`).catch(() => [])).filter(isPlainDir).map(entry => entry.name)
    : []
  // Each capability's spec.md, only where it is a plain file of its own folder
  const specPaths = (
    await Promise.all(
      specDirs.map(async dir => {
        const inner = await $.fs.list(`${changeRoot}/specs/${dir}`).catch(() => [])
        return inner.some(entry => entry.name === 'spec.md' && isPlainFile(entry)) ? `${changeRoot}/specs/${dir}/spec.md` : undefined
      }),
    )
  ).filter((file): file is string => file !== undefined)
  const docs = DOCS.filter(name => names.includes(name)).map(name => `${changeRoot}/${name}`)
  return {
    artifacts: artifactsFromFiles(names, specDirs),
    specPaths,
    readable: new Set([...docs, ...specPaths].filter(file => isDocOf(file, changeRoot))),
  }
}

export async function loadDigest($: EngineInterface, changeRoot: string, specPaths: string[], readable: Set<string>) {
  // Only a document filesOf found, whatever path is asked
  const readFile = (file: string) => (readable.has(file) ? $.fs.read(file).catch(() => '') : Promise.resolve(''))
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

// At most this many modules read at once, and as many changes within each: a monorepo's
// modules, each running openspec and reading files per change, would otherwise start hundreds of
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
  // openspec/ and openspec/changes/ must be the module's own folders: one that is a
  // symbolic link could lead anywhere, so nothing of the module is run or read
  const isLinkIn = async (dir: string, name: string) => (await $.fs.list(dir).catch(() => [])).some(entry => entry.name === name && entry.isLink)
  if (await isLinkIn(path, 'openspec')) throw new Error('openspec/ is a symbolic link: Spec Manager does not follow it')
  if (await isLinkIn(`${path}/openspec`, 'changes')) throw new Error('openspec/changes/ is a symbolic link: Spec Manager does not follow it')
  // A change folder that is a symbolic link is listed from openspec's answer alone: none
  // of its documents is read
  const linked = new Set(
    (await $.fs.list(`${path}/openspec/changes`).catch(() => [])).filter(entry => entry.isLink).map(entry => entry.name),
  )
  const [list, status, specs, archived] = await Promise.all([
    openspecList($, path),
    openspecStatus($, path).catch(() => ({ changes: [] })),
    full ? openspecSpecs($, path).catch(() => ({ specs: [] })) : { specs: [] },
    full ? openspecArchived($, path).catch(() => ({ changes: [] })) : { changes: [] },
  ])
  const artifactsOf = new Map<string, Artifact[]>()
  for (const one of status.changes ?? []) {
    const artifacts = artifactsFrom(one)
    // Nothing usable for this change: its documents are read from its folder instead
    if (artifacts.length > 0) artifactsOf.set(one.changeName, artifacts)
  }
  // A change is one folder of openspec/changes/: a name that is a path (a `/`, a `..`)
  // is not one, and is left out
  const listed = (Array.isArray(list.changes) ? list.changes : []).filter((one: any) => isPlainName(one?.name))
  const changes: Change[] = await pool(listed, AT_ONCE, async (one: any) => {
    const changeRoot = `${path}/openspec/changes/${one.name}`
    // The documents read come from the change's folder alone; a failed `openspec status`
    // read as no documents put every change in review, so the folder says what is written
    const none = { artifacts: [] as Artifact[], specPaths: [] as string[], readable: new Set<string>() }
    const files = linked.has(one.name) ? none : await filesOf($, changeRoot)
    const artifacts = artifactsOf.get(one.name) ?? files.artifacts
    const { specPaths, readable } = files
    // A light read's digest, empty: typed rather than asserted, so a field Digest comes to
    // require is missed here at validation, not when the pane draws it
    const light: Digest = { specs: [], decisions: [], openQuestions: [] }
    const tasksFile = `${changeRoot}/tasks.md`
    const [markdown, digest] = await Promise.all([
      readable.has(tasksFile) ? $.fs.read(tasksFile).catch(() => '') : '',
      full ? loadDigest($, changeRoot, specPaths, readable) : light,
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
      ...whoseTurn(artifacts, tasks, open),
    }
  })
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
  you: root.changes.filter(c => c.turn === 'you').length,
  ai: root.changes.filter(c => c.turn === 'ai').length,
  items: root.changes.map(c => {
    const stepper = steps(c)
    return {
      name: c.name,
      step: stepper.findIndex(s => s.state === 'current'),
      steps: stepper.length,
      turn: c.turn,
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
    // Walking the tree is the costly part: redo it every 5 minutes, or when asked
    if (rediscover || !current || now - current.at > DISCOVER_EVERY_MS) {
      const isFirst = !current
      current = { ...(await discover($)), at: now }
      s.found = current
      // A reset asked while this walk ran picks again too (the walk's isFirst predates it)
      const isReset = s.isReset === true
      s.isReset = false
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

// An openspec/ in the session's folder or at the repository top, where `openspec init` is run.
// Only one of the folder's own, as discover finds it: a symbolic link answering here would
// have the whole tree walked again at every poll, for a module that never comes
export async function openspecAppeared($: EngineInterface, base: string) {
  const cwd = await $.session.cwd()
  for (const dir of new Set([cwd, base])) {
    if ((await $.fs.exists(`${dir}/openspec`)) && (await hasOwnOpenspec($, dir))) return true
  }
  return false
}
