import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Artifact, Change, Module, Progress, Root, Section, Task, View } from '../types'

const PANE = 'spec-manager'
const TITLE = 'Spec Manager'
const POLL_MS = 10000
const ARCHIVED_SHOWN = 3
const ALL = 'all'
const SCAN_DEPTH = 5
const SCAN_MAX_DIRS = 2000
const DISCOVER_EVERY_MS = 60000
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', 'openspec'])

const view = atom({ plugin: 'spec-manager', key: 'view' } as const, { roots: [], modules: [] } as View)

// Module state: reset on each reload, which is fine (it only avoids useless work)
let lastSignature = ''
let isRunning = false
// A forced refresh asked while one runs is replayed after it, never dropped
let isPending = false
// Latest root read per module (full or light): a module opens at once from here
const cache = new Map<string, Root>()
let found: { base: string; inside?: string; paths: string[]; at: number } | undefined
// The pane opens by itself once there is an OpenSpec module to show, and only once:
// a project without openspec/ gets no pane until /spec-manager or `openspec init`
let hasOpened = false

const parentOf = (dir: string) => dir.slice(0, dir.lastIndexOf('/'))

// The repo top (nearest .git upward), else the session's own dir
async function baseOf($: EngineInterface, cwd: string): Promise<string> {
  for (let dir = cwd; dir !== ''; dir = parentOf(dir)) {
    if (await $.fs.exists(`${dir}/.git`)) return dir
  }
  return cwd
}

/**
 * Every folder holding an openspec/ under the base, a few levels down, plus the
 * module the session sits in (nearest openspec/ upward, within the base)
 */
async function discover($: EngineInterface): Promise<{ base: string; inside?: string; paths: string[] }> {
  const cwd = await $.session.cwd()
  const base = await baseOf($, cwd)
  let inside: string | undefined
  for (let dir = cwd; dir.length >= base.length && dir !== ''; dir = parentOf(dir)) {
    if (await $.fs.exists(`${dir}/openspec`)) {
      inside = dir
      break
    }
  }
  const paths: string[] = []
  let visited = 0
  const walk = async (dir: string, depth: number) => {
    if (visited++ > SCAN_MAX_DIRS) return
    const entries = await $.fs.list(dir).catch(() => [])
    if (entries.some(e => e.kind === 'dir' && e.name === 'openspec')) paths.push(dir)
    if (depth === 0) return
    for (const entry of entries) {
      if (entry.kind !== 'dir' || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
      await walk(`${dir}/${entry.name}`, depth - 1)
    }
  }
  await walk(base, SCAN_DEPTH)
  if (inside && !paths.includes(inside)) paths.unshift(inside)
  return { base, inside, paths }
}

export const moduleName = (base: string, path: string) =>
  path === base ? (base.split('/').pop() ?? base) : path.slice(base.length + 1)

// Which module to show: the one the session sits in, else the last one picked in
// this repo, else the overview; a single module is shown directly
async function initialSelection($: EngineInterface, base: string, inside: string | undefined, paths: string[]) {
  if (paths.length <= 1) return paths[0] ?? ALL
  if (inside) return inside
  const remembered = await $.store.get(`selected:${base}`)
  return typeof remembered === 'string' && (remembered === ALL || paths.includes(remembered)) ? remembered : ALL
}

// A single module is always shown directly, even one that appeared mid-session
// while the overview (or nothing) was selected
export const settle = (selected: string | undefined, paths: string[]) =>
  paths.length === 1 ? paths[0] : selected !== ALL && !paths.includes(selected ?? '') ? ALL : selected

async function select($: EngineInterface, wanted: string) {
  const selected = found ? (settle(wanted, found.paths) ?? wanted) : wanted
  if (found) await $.store.set(`selected:${found.base}`, selected)
  // Draw at once from what is already read, then fill in that one module only
  const cached = cache.get(selected)
  await update($, view, old => ({ ...old, selected, roots: cached ? [cached] : [] }))
  if (selected !== ALL) void loadSelected($, selected)
}

async function loadSelected($: EngineInterface, path: string) {
  try {
    const root = await loadRoot($, path)
    cache.set(path, root)
    await update($, view, old => (old.selected === path ? { ...old, roots: [root] } : old))
  } catch {
    // The next refresh will say what went wrong
  }
}

// "/spec-manager paiement" picks a module by name or by the end of its path
export function resolveModule(arg: string, paths: string[], base: string): string | undefined {
  const wanted = arg.trim().replace(/\/+$/, '')
  if (wanted === '' || wanted === ALL) return ALL
  return (
    paths.find(p => moduleName(base, p) === wanted) ??
    paths.find(p => p.endsWith(`/${wanted}`)) ??
    paths.find(p => moduleName(base, p).includes(wanted))
  )
}

// Cheap fingerprint of the openspec/ trees, so openspec only runs when something moved
async function signature($: EngineInterface, roots: string[]): Promise<string> {
  const parts: string[] = []
  const walk = async (dir: string, depth: number) => {
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      parts.push(`${dir}/${entry.name}:${entry.mtimeMs}`)
      if (entry.kind === 'dir' && depth > 0) await walk(`${dir}/${entry.name}`, depth - 1)
    }
  }
  for (const root of roots) await walk(`${root}/openspec`, 3)
  return parts.join('|')
}

// Each openspec command is written out in full, so what the pane runs reads from the source
type Run = { exitCode: number; stdout: string; stderr: string }
const parsed = async (run: Promise<Run>, command: string): Promise<any> => {
  const { exitCode, stdout, stderr } = await run
  if (exitCode !== 0) throw new Error(stderr.trim() || `${command} failed`)
  return JSON.parse(stdout)
}
const openspecList = ($: EngineInterface, cwd: string) =>
  parsed($.process.run(['openspec', 'list', '--json'], { cwd }), 'openspec list')
const openspecStatus = ($: EngineInterface, cwd: string) =>
  parsed($.process.run(['openspec', 'status', '--all', '--json'], { cwd }), 'openspec status')
const openspecSpecs = ($: EngineInterface, cwd: string) =>
  parsed($.process.run(['openspec', 'list', '--specs', '--sort', 'name', '--json'], { cwd }), 'openspec list --specs')
const openspecArchived = ($: EngineInterface, cwd: string) =>
  parsed($.process.run(['openspec', 'list', '--archived', '--json'], { cwd }), 'openspec list --archived')

const USER_ACTION = /^\*\((?:action utilisateur|user action)[^)]*\)\*\s*/i

// Sections (`## 1. Title`) with their checkbox counts, and the unchecked tasks in order
export function parseTasks(markdown: string): { sections: Section[]; open: Task[] } {
  const sections: Section[] = []
  const open: Task[] = []
  let section: Section | undefined
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^##\s+(\d+)\.\s+(.+)$/)
    if (heading) {
      section = { num: heading[1], title: heading[2].trim(), done: 0, total: 0 }
      sections.push(section)
      continue
    }
    const box = line.match(/^\s*- \[([ xX])\]\s+(.+)$/)
    if (!box) continue
    const isDone = box[1] !== ' '
    if (section) {
      section.total++
      if (isDone) section.done++
    }
    if (isDone) continue
    const [, id = '', rest = box[2]] = box[2].match(/^(\d+(?:\.\d+)*)\s+(.+)$/) ?? []
    const isUserAction = USER_ACTION.test(rest)
    const text = rest.replace(USER_ACTION, '').replace(/[`*]/g, '').trim()
    open.push({ id, text, isUserAction })
  }
  return { sections: sections.filter(s => s.total > 0), open }
}

// Phase and whose move it is, inferred from artifacts and checkboxes
export function whoseTurn(
  artifacts: Artifact[],
  tasks: Progress,
  open: Task[],
): Pick<Change, 'phase' | 'turn' | 'yourNext' | 'yourLater' | 'aiNext'> {
  const missing = artifacts.find(a => !a.isDone)
  if (missing) {
    return { phase: 'planning', turn: 'ai', yourLater: 0, aiNext: { id: '', text: `write ${missing.name}`, isUserAction: false } }
  }
  if (tasks.total > 0 && tasks.done === tasks.total) {
    return { phase: 'ready', turn: 'you', yourLater: 0 }
  }
  // /opsx:propose writes the four documents in one go, then stops: the plan waits for review
  if (tasks.done === 0) {
    return { phase: 'review', turn: 'you', yourLater: 0 }
  }
  const yours = open.filter(t => t.isUserAction)
  return {
    phase: 'implementing',
    turn: open[0]?.isUserAction ? 'you' : 'ai',
    yourNext: yours[0],
    yourLater: Math.max(0, yours.length - 1),
    aiNext: open.find(t => !t.isUserAction),
  }
}

// First sentence of the proposal's `## Why`
export function whyLine(proposal: string): string | undefined {
  const after = proposal.split(/^## Why\s*$/m)[1]
  const line = after?.split('\n').find(l => l.trim() !== '' && !l.startsWith('#'))
  if (!line) return undefined
  return line.trim().split(/(?<=[.!?])\s/)[0]?.replace(/[`*]/g, '')
}

// Decision titles (`### D1. Title`) and the bullets under `## Open Questions` of design.md
export function parseDesign(design: string): { decisions: string[]; openQuestions: string[] } {
  const decisions = [...design.matchAll(/^### (D\d+)\.\s+(.+)$/gm)].map(m => `${m[1]} ${m[2].replace(/[`*]/g, '').trim()}`)
  const section = design.split(/^## Open Questions\s*$/m)[1]?.split(/^## /m)[0] ?? ''
  const openQuestions = [...section.matchAll(/^\s*(?:[-*]|\d+\.)\s+(.+)$/gm)].map(m => m[1].replace(/[`*]/g, '').trim())
  return { decisions, openQuestions }
}

export function specCounts(spec: string): { requirements: number; scenarios: number } {
  return {
    requirements: (spec.match(/^### Requirement:/gm) ?? []).length,
    scenarios: (spec.match(/^#### Scenario:/gm) ?? []).length,
  }
}

async function loadDigest($: EngineInterface, changeRoot: string, specPaths: string[]) {
  const read = (file: string) => $.fs.read(file).catch(() => '')
  const [proposal, design, ...specs] = await Promise.all([
    read(`${changeRoot}/proposal.md`),
    read(`${changeRoot}/design.md`),
    ...specPaths.map(read),
  ])
  return {
    why: whyLine(proposal),
    specs: specPaths.map((file, i) => ({
      name: file.slice(`${changeRoot}/specs/`.length).replace(/\/spec\.md$/, ''),
      ...specCounts(specs[i] ?? ''),
    })),
    ...parseDesign(design),
  }
}

// Whose change it is: the author of the oldest commit on its folder (`git log
// --reverse --format=%ae%x09%an`). No commit yet means it was made here: the reader's
export function ownerOf(log: string, me: string): { isMine: boolean; owner?: string } {
  const first = log.split('\n').find(line => line.trim() !== '')
  if (!first || me === '') return { isMine: true }
  const [email = '', name = ''] = first.split('\t')
  if (email.trim().toLowerCase() === me.toLowerCase()) return { isMine: true }
  return { isMine: false, owner: name.trim() || email.trim() }
}

// The reader's git email, per repository; empty outside git or when unset
const emails = new Map<string, Promise<string>>()
const myEmail = ($: EngineInterface, cwd: string) => {
  if (!emails.has(cwd)) {
    emails.set(
      cwd,
      $.process
        .run(['git', 'config', 'user.email'], { cwd })
        .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''))
        .catch(() => ''),
    )
  }
  return emails.get(cwd)!
}

async function ownership($: EngineInterface, cwd: string, dir: string) {
  const me = await myEmail($, cwd)
  if (me === '') return { isMine: true }
  const log = await $.process
    .run(['git', 'log', '--reverse', '--format=%ae%x09%an', '--', dir], { cwd })
    .catch(() => undefined)
  if (!log || log.exitCode !== 0) return { isMine: true }
  return ownerOf(log.stdout, me)
}

// `full` false: just enough to know each change's turn, for a module seen in the overview
async function loadRoot($: EngineInterface, path: string, full = true): Promise<Root> {
  const [list, status, specs, archived] = await Promise.all([
    openspecList($, path),
    openspecStatus($, path).catch(() => ({ changes: [] })),
    full ? openspecSpecs($, path).catch(() => ({ specs: [] })) : { specs: [] },
    full ? openspecArchived($, path).catch(() => ({ changes: [] })) : { changes: [] },
  ])
  const artifactsOf = new Map<string, Artifact[]>()
  const specPathsOf = new Map<string, string[]>()
  for (const one of status.changes ?? []) {
    const paths = Object.entries(one.artifactPaths ?? {}) as [string, { existingOutputPaths?: string[] }][]
    artifactsOf.set(
      one.changeName,
      paths.map(([name, p]) => ({ name, isDone: (p.existingOutputPaths ?? []).length > 0 })),
    )
    specPathsOf.set(one.changeName, one.artifactPaths?.specs?.existingOutputPaths ?? [])
  }
  const changes: Change[] = await Promise.all(
    (list.changes ?? []).map(async (one: any) => {
      const changeRoot = `${path}/openspec/changes/${one.name}`
      const [markdown, digest, owned] = await Promise.all([
        $.fs.read(`${changeRoot}/tasks.md`).catch(() => ''),
        full
          ? loadDigest($, changeRoot, specPathsOf.get(one.name) ?? [])
          : { specs: [], decisions: [], openQuestions: [] },
        ownership($, path, changeRoot),
      ])
      const { sections, open } = parseTasks(markdown)
      const artifacts = artifactsOf.get(one.name) ?? []
      const tasks = { done: one.completedTasks ?? 0, total: one.totalTasks ?? 0 }
      return {
        name: one.name,
        tasks,
        artifacts,
        sections,
        digest,
        lastModified: one.lastModified,
        ...owned,
        ...whoseTurn(artifacts, tasks, open),
      }
    }),
  )
  // The reader's own changes first
  changes.sort((a, b) => Number(b.isMine) - Number(a.isMine))
  const archivedNames: string[] = (archived.changes ?? []).map((one: any) => one.name)
  return {
    name: path.split('/').pop() ?? path,
    path,
    changes,
    specs: (specs.specs ?? []).map((one: any) => ({ id: one.id, requirements: one.requirementCount ?? 0 })),
    archived: archivedNames.slice(0, ARCHIVED_SHOWN),
    archivedTotal: archivedNames.length,
  }
}

const summarize = (base: string, root: Root): Module => ({
  name: moduleName(base, root.path),
  path: root.path,
  changes: root.changes.length,
  mine: root.changes.filter(c => c.isMine).length,
  you: root.changes.filter(c => c.isMine && c.turn === 'you').length,
  ai: root.changes.filter(c => c.isMine && c.turn === 'ai').length,
  others: [...new Set(root.changes.filter(c => !c.isMine).map(c => c.owner ?? '?'))],
  items: root.changes.map(c => ({
    name: c.name,
    step: steps(c).findIndex(s => s.state === 'current'),
    turn: c.turn,
    isMine: c.isMine,
    owner: c.owner,
  })),
  lastModified: root.changes.map(c => c.lastModified ?? '').sort().pop() || undefined,
})

async function refresh($: EngineInterface, force = false, rediscover = false) {
  if (isRunning) {
    if (force) isPending = true
    return
  }
  isRunning = true
  try {
    const now = await $.clock.now()
    // Walking the tree is the costly part: redo it once a minute, or when asked
    if (rediscover || !found || now - found.at > DISCOVER_EVERY_MS) {
      const isFirst = !found
      found = { ...(await discover($)), at: now }
      if (!hasOpened && found.paths.length > 0) {
        hasOpened = true
        void $.ui.open({ id: PANE, title: TITLE })
      }
      if (isFirst || (await read($, view)).selected === undefined) {
        const selected = await initialSelection($, found.base, found.inside, found.paths)
        await update($, view, old => ({ ...old, selected }))
      }
    }
    const { base, paths } = found
    const sig = await signature($, paths)
    if (!force && sig === lastSignature) {
      // Nothing moved: say when it was last checked
      await update($, view, old => ({ ...old, updatedAt: now, now }))
      return
    }
    lastSignature = sig
    const selected = settle((await read($, view)).selected, paths)
    // Every module is read light for the overview; the selected one in full
    const light = await Promise.all(paths.map(p => (p === selected ? loadRoot($, p) : loadRoot($, p, false))))
    for (const root of light) cache.set(root.path, root)
    const modules = light.map(root => summarize(base, root))
    const roots = light.filter(root => root.path === selected)
    await update($, view, old => ({ ...old, roots, modules, selected, updatedAt: now, now, error: undefined }))
  } catch (err) {
    lastSignature = ''
    const message = err instanceof Error ? err.message : String(err)
    await update($, view, old => ({ ...old, error: message }))
  } finally {
    isRunning = false
    if (isPending) {
      isPending = false
      void refresh($, true)
    }
  }
}

const BAR_W = 60
const BAR_H = 6
// Palette "Terre": terracotta and sage for the two actors, slate blue (cctide's) for
// progress. Mid tones, readable on both the light and the dark theme.
const CLAY = '#d97757' // the AI: Claude's terracotta
const SAGE = '#6b9b74' // you
const SLATE = '#4f82c9' // progress: filled bars
const MUTED = '#8f8d86' // done steps, labels of upcoming steps: only the current step is coloured
const TRACK = 'rgba(128,128,128,0.35)'
const turnColor = (turn: 'you' | 'ai') => (turn === 'you' ? SAGE : CLAY)

// The stepper in six dots, for a module's card: done grey, current in the actor's
// colour, upcoming outlined
const DOT = 8
const DOT_GAP = 3
const DOTS_W = 6 * (DOT + DOT_GAP) - DOT_GAP
export const dotsSvg = (current: number, currentFill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${DOTS_W}" height="${DOT}" viewBox="0 0 ${DOTS_W} ${DOT}">` +
  [0, 1, 2, 3, 4, 5]
    .map(i => {
      const x = i * (DOT + DOT_GAP)
      if (i < current) return `<rect x="${x}" width="${DOT}" height="${DOT}" rx="2" fill="${MUTED}"/>`
      if (i === current) return `<rect x="${x}" width="${DOT}" height="${DOT}" rx="2" fill="${currentFill}"/>`
      return `<rect x="${x + 0.5}" y="0.5" width="${DOT - 1}" height="${DOT - 1}" rx="2" fill="none" stroke="${TODO_STROKE}"/>`
    })
    .join('') +
  `</svg>`
// The wordmark: a fixed SVG, larger and heavier than text can be. Words in the
// palette's neutral grey (an image cannot follow the theme), braces in the actors'
// colours
const BRAND_W = 172
const BRAND_H = 28
const BRAND_MONO = "'JetBrains Mono','Fira Code','DejaVu Sans Mono',monospace"
const BRAND_SANS = "system-ui,-apple-system,'Segoe UI','Inter','Noto Sans','DejaVu Sans',sans-serif"
const brandSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${BRAND_W}" height="${BRAND_H}" viewBox="0 0 ${BRAND_W} ${BRAND_H}">` +
  `<text x="0" y="21" font-family="${BRAND_MONO}" font-size="24" font-weight="700" fill="${CLAY}">{</text>` +
  `<text x="16" y="20" font-family="${BRAND_SANS}" font-size="18" font-weight="800" letter-spacing="-0.3" fill="${MUTED}">spec</text>` +
  `<text x="58" y="21" font-family="${BRAND_MONO}" font-size="24" font-weight="700" fill="${SAGE}">}</text>` +
  `<text x="78" y="20" font-family="${BRAND_SANS}" font-size="18" font-weight="800" letter-spacing="-0.3" fill="${MUTED}">manager</text></svg>`
// The actor colours are the reader's: someone else's change stays grey
const actorColor = (change: Change) => (change.isMine ? turnColor(change.turn) : MUTED)

// Drawn in real pixels: the desktop pane's font gives text cells no fixed width
const barSvg = ({ done, total }: Progress) => {
  const fill = total > 0 ? (done / total) * BAR_W : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${BAR_H}" viewBox="0 0 ${BAR_W} ${BAR_H}">` +
    `<clipPath id="r"><rect width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${BAR_W}" height="${BAR_H}" fill="${TRACK}"/>` +
    `<rect width="${fill.toFixed(1)}" height="${BAR_H}" fill="${SLATE}"/></g></svg>`
  )
}

const clock = (ms: number) => {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// "updated at 20:35:37 · refresh in 2s"
const footer = (updatedAt: number, now: number | undefined) => {
  const left = now === undefined ? undefined : Math.max(0, Math.ceil((nextPollAt - now) / 1000))
  return `updated at ${clock(updatedAt)}${left === undefined ? '' : ` · refresh in ${left}s`}`
}

const ago = (iso: string, now: number) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / (60 * 24))}d ago`
}

// A hairline the width of the pane: stretched by the slot, one pixel high
const RULE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1" viewBox="0 0 2000 1" preserveAspectRatio="none">` +
  `<rect width="2000" height="1" fill="${TRACK}"/></svg>`

type StepState = 'done' | 'current' | 'todo'

// The whole cycle in OpenSpec's own words: the four documents, then apply and archive
export function steps(change: Change): { name: string; state: StepState }[] {
  const raw = [
    ...change.artifacts.map(a => ({ name: a.name, isDone: a.isDone })),
    { name: 'apply', isDone: change.phase === 'ready' },
    { name: 'archive', isDone: false },
  ]
  const current = raw.findIndex(s => !s.isDone)
  return raw.map((s, i) => ({ name: s.name, state: s.isDone ? 'done' : i === current ? 'current' : 'todo' }))
}

const TAB_W = 70
const TAB_H = 22
const TAB_TIP = 8
// The current step takes the colour of whoever holds it
const TAB_STYLE: Record<StepState, { fill: string; text: string; weight: number }> = {
  done: { fill: MUTED, text: '#ffffff', weight: 600 },
  current: { fill: CLAY, text: '#ffffff', weight: 700 },
  todo: { fill: 'rgba(128,128,128,0.22)', text: MUTED, weight: 600 },
}

const TODO_STROKE = '#6e6c66'

const SHINE_W = 28
const SHINE_S = 6

// Chevron tabs, each notched into the one before it. The current tab carries a light
// band sweeping left to right (CSS, off under reduced motion), drawn under the label
const stepperWidth = (count: number) => count * (TAB_W + 2) + TAB_TIP

const stepperSvg = (list: { name: string; state: StepState }[], currentFill: string) => {
  const width = stepperWidth(list.length)
  let shine = ''
  const tabs = list.map((step, i) => {
    const x = i * (TAB_W + 2)
    const { text, weight } = TAB_STYLE[step.state]
    const fill = step.state === 'current' ? currentFill : TAB_STYLE[step.state].fill
    const notch = i === 0 ? `${x},${TAB_H / 2}` : `${x + TAB_TIP},${TAB_H / 2}`
    // Upcoming tabs are pale: a dark grey outline keeps them visible on a white pane.
    // Inset by half the stroke so the outline is not clipped at the edges
    const inset = step.state === 'todo' ? 0.5 : 0
    const points = [
      `${x},${inset}`,
      `${x + TAB_W},${inset}`,
      `${x + TAB_W + TAB_TIP - inset},${TAB_H / 2}`,
      `${x + TAB_W},${TAB_H - inset}`,
      `${x},${TAB_H - inset}`,
      notch,
    ]
    const outline = step.state === 'todo' ? ` stroke="${TODO_STROKE}" stroke-width="1"` : ''
    const label = `${step.state === 'done' ? '✓ ' : ''}${step.name}`
    if (step.state === 'current') {
      const from = x - SHINE_W
      const to = x + TAB_W + TAB_TIP
      shine =
        // Names keyed by position: keyframes are global to a document holding several steppers
        `<style>@keyframes sweep${i}{0%{transform:translateX(${from}px)}70%,100%{transform:translateX(${to}px)}}` +
        `.shine${i}{animation:sweep${i} ${SHINE_S}s ease-in-out infinite}` +
        `@media (prefers-reduced-motion: reduce){.shine${i}{display:none}}</style>` +
        `<clipPath id="cur${i}"><polygon points="${points.join(' ')}"/></clipPath>`
    }
    const band =
      step.state === 'current'
        ? `<g clip-path="url(#cur${i})"><rect class="shine${i}" width="${SHINE_W}" height="${TAB_H}" fill="url(#glow)"/></g>`
        : ''
    return (
      `<polygon points="${points.join(' ')}" fill="${fill}"${outline}/>` +
      band +
      `<text x="${x + (TAB_W + TAB_TIP) / 2 + (i === 0 ? -2 : 2)}" y="${TAB_H / 2}" fill="${text}" font-weight="${weight}" ` +
      `font-size="12" font-family="system-ui, sans-serif" text-anchor="middle" dominant-baseline="central">${label}</text>`
    )
  })
  const glow =
    `<linearGradient id="glow" x1="0" x2="1" y1="0" y2="0">` +
    `<stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.45"/>` +
    `<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${TAB_H}" viewBox="0 0 ${width} ${TAB_H}">` +
    `<defs>${glow}${shine}</defs>${tabs.join('')}</svg>`
  )
}

const PHASE_LABEL = {
  planning: 'Planning',
  review: 'Plan to review',
  implementing: 'Implementing',
  ready: 'Ready to archive',
} as const
// When the next look at the files is due, for the countdown in the footer
let nextPollAt = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spec-manager', description: 'Show the Spec Manager pane (OpenSpec changes)' })
    void refresh($, true)
    nextPollAt = (await $.clock.now()) + POLL_MS
    // The pane reads files only: it looks again every 10 seconds (and searches for new
    // modules at once while it has none, so an `openspec init` shows up quickly)
    $.clock.every(POLL_MS, () => {
      void refresh($, false, found?.paths.length === 0)
      void $.clock.now().then(now => {
        nextPollAt = now + POLL_MS
      })
    })
    // Every second, move the clock the countdown and the "last activity" times read
    $.clock.every(1000, () => {
      void $.clock.now().then(now => update($, view, old => ({ ...old, now })))
    })

    return next(e)
  })

  // /spec-manager            opens the pane
  // /spec-manager <module>   shows that module (its folder name or the end of its path)
  // /spec-manager all        shows every module
  on('command.run', { command: 'spec-manager' }, async ($, e) => {
    hasOpened = true
    await $.ui.open({ id: PANE, title: TITLE })
    if (e.args.trim() === '') {
      // Start over: look for the modules again and pick what to show as at session start
      found = undefined
      void refresh($, true)
      return { text: 'Spec Manager pane opened.' }
    }
    if (!found) await refresh($, true, true)
    const target = found && resolveModule(e.args, found.paths, found.base)
    if (!found || !target) {
      const names = found ? found.paths.map(p => moduleName(found!.base, p)).join(', ') : ''
      return { text: `No OpenSpec module matches "${e.args.trim()}".${names ? ` Modules: ${names}` : ''}` }
    }
    await select($, target)
    return { text: target === ALL ? 'Showing every OpenSpec module.' : `Showing ${moduleName(found.base, target)}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The terminal draws text: there the counts stand in for the bars, symbols for the
    // stepper. Asked by surface, since newer terminals carry an Svg that draws nothing
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    // A terminal row is far taller than a pixel: there the frames and cards drop the
    // blank rows that only give the desktop some air
    const air = (rows: number) => (Svg ? rows : rows - 1)
    // On the terminal, which has no SVG, the wordmark is bold text
    const brand = (
      <Box marginBottom={1} flexDirection="row" justifyContent="flex-end">
        {Svg ? (
          <Svg source={brandSvg()} alt="Spec Manager" width={BRAND_W} height={BRAND_H} />
        ) : (
          <Text bold>
            <Text color={CLAY}>{'{'}</Text>
            <Text>spec</Text>
            <Text color={SAGE}>{'}'}</Text>
            <Text> manager</Text>
          </Text>
        )}
      </Box>
    )
    const { roots, modules, selected, error, updatedAt, now } = await read($, view)

    if (error) {
      return (
        <Box flexDirection="column">
          <Text color="error">openspec: {error}</Text>
          <Text dimColor>Check that `openspec` is on the PATH (~/.local/bin/openspec).</Text>
        </Box>
      )
    }
    if (updatedAt === undefined) return <Text dimColor>Loading…</Text>
    if (modules.length === 0) return <Text dimColor>No openspec/ folder in this repository.</Text>

    const changes = roots.flatMap(root => root.changes)
    const specs = roots.flatMap(root => root.specs)
    const archived = roots.flatMap(root => root.archived)
    const archivedTotal = roots.reduce((sum, root) => sum + root.archivedTotal, 0)

    const bar = (p: Progress) =>
      Svg && (
        <Box flexShrink={0} marginLeft={1}>
          <Svg source={barSvg(p)} alt={`${p.done} of ${p.total}`} width={BAR_W} height={BAR_H} />
        </Box>
      )

    // Accent-colored caps so the three blocks stand apart from their content
    const heading = (label: string, count: number, badge?: any) => (
      <Box flexDirection="row" marginBottom={1}>
        <Text bold>{label}</Text>
        <Box flexGrow={1}>
          <Text dimColor> {count}</Text>
        </Box>
        {badge}
      </Box>
    )
    // The same tag on each change and, counted, on the CHANGES heading
    const turnTag = (turn: 'you' | 'ai', count?: number) => (
      <Text bold inverse color={turnColor(turn)}>
        {turn === 'you' ? ' YOU' : ' AI'}
        {count === undefined ? ' ' : ` ${count} `}
      </Text>
    )
    // Someone else's change: their name in a grey tag, in place of YOU / AI
    const ownerTag = (owner?: string) => (
      <Text bold inverse color={MUTED}>
        {` ${owner ?? '?'} `}
      </Text>
    )
    const tagOf = (change: Change) => (change.isMine ? turnTag(change.turn) : ownerTag(change.owner))
    // Only the reader's own changes count towards YOU / AI
    const turnSummary = (list: Change[]) => {
      const mine = list.filter(c => c.isMine)
      const yours = mine.filter(c => c.turn === 'you').length
      return turnCounts(yours, mine.length - yours)
    }
    // The count first, then the usual tag ("1 [YOU]  2 [AI]"): a count inside the tag
    // read like a name or a score
    const turnCounts = (yours: number, ais: number) => {
      return (
        <Box flexDirection="row" flexShrink={0}>
          {yours > 0 && <Text>{yours} </Text>}
          {yours > 0 && turnTag('you')}
          {yours > 0 && ais > 0 && <Text>{'  '}</Text>}
          {ais > 0 && <Text>{ais} </Text>}
          {ais > 0 && turnTag('ai')}
        </Box>
      )
    }

    const stepper = (change: Change) => {
      const list = steps(change)
      return (
        <Box paddingLeft={2} marginTop={air(2)} marginBottom={1}>
          {Svg ? (
            <Svg source={stepperSvg(list, actorColor(change))} alt={PHASE_LABEL[change.phase]} width={stepperWidth(list.length)} height={TAB_H} isInteractive />
          ) : (
            <Text>
              {list.map((s, i) => (
                <Text bold={s.state === 'current'} color={s.state === 'current' ? actorColor(change) : undefined} dimColor={s.state === 'todo'}>
                  {i > 0 ? ' › ' : ''}
                  {s.state === 'done' ? '✓' : s.state === 'current' ? '◐' : '○'} {s.name}
                </Text>
              ))}
            </Text>
          )}
        </Box>
      )
    }
    const none = <Text dimColor italic>  (none)</Text>
    const rule = (
      <Box marginY={1}>
        {Svg ? (
          <Svg source={RULE_SVG} alt="separator" height={1} />
        ) : (
          // As wide as the frame's inside (the pane less its border and padding): the
          // terminal's own width overran the pane and wrapped onto a second line
          <Text dimColor>{'─'.repeat(Math.max(10, e.props.bodyColumns - 4))}</Text>
        )}
      </Box>
    )

    // A label column, then its content
    const field = (label: string, content: any, color?: string) => (
      <Box flexDirection="row" paddingLeft={2}>
        <Box width={11} flexShrink={0}>
          <Text bold dimColor={!color} color={color}>{label}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>{content}</Box>
      </Box>
    )

    // One task per line: the id in its own fixed box, the text truncated beside it
    // minWidth 0 on shrinking boxes: a flex item otherwise keeps its content's width,
    // and a long task line ran past the frame instead of ending in "…"
    const taskRow = (task: Task, color: string) => (
      <Box flexDirection="row" paddingLeft={2}>
        <Box flexShrink={0}>
          <Text color={color}>{task.id ? `${task.id} ` : ''}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {/* No mark here: user-action tasks only ever show under "Waiting on you", which carries one */}
          <Text wrap="truncate-end">{task.text}</Text>
        </Box>
      </Box>
    )

    const waitingOn = (change: Change, content: any, later = 0) => (
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Box flexDirection="row">
          <Text bold color={change.isMine ? SAGE : MUTED}>
            ● Waiting on {change.isMine ? 'you' : (change.owner ?? 'its author')}
          </Text>
          {later > 0 && <Text dimColor> (+{later} later)</Text>}
        </Box>
        {content}
      </Box>
    )
    const hint = (text: string) => (
      <Box paddingLeft={2}>
        <Text>{text}</Text>
      </Box>
    )

    const sectionBars = (change: Change) => (
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {change.sections.map(s => {
          const isComplete = s.done === s.total
          return (
            <Box flexDirection="row" alignItems="center">
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text dimColor={isComplete} wrap="truncate-end">{s.num} {s.title}</Text>
              </Box>
              {bar(s)}
              <Box width={5} flexShrink={0} justifyContent="flex-end">
                <Text dimColor={isComplete}>
                  {isComplete ? '✓' : `${s.done}/${s.total}`}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )

    // The plan in a few lines, for the review between /opsx:propose and /opsx:apply
    const planDigest = (change: Change) => {
      const { why, specs, decisions, openQuestions } = change.digest
      return (
        <Box flexDirection="column" marginTop={1} rowGap={1}>
          {why && field('Why', <Text>{why}</Text>)}
          {field(
            'Specs',
            <Box flexDirection="column">
              {specs.length === 0 && <Text dimColor>none</Text>}
              {specs.map(s => (
                <Box flexDirection="row">
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text wrap="truncate-end">{s.name}</Text>
                  </Box>
                  <Text dimColor> {s.requirements} req · {s.scenarios} scen</Text>
                </Box>
              ))}
            </Box>,
          )}
          {decisions.length > 0 &&
            field(
              `Decisions`,
              <Box flexDirection="column">
                {decisions.map(d => (
                  <Text wrap="truncate-end">{d}</Text>
                ))}
              </Box>,
            )}
          {/* The questions themselves, in your colour: they wait on you before /opsx:apply */}
          {openQuestions.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              <Text bold color={SAGE}>
                ⚠ {openQuestions.length} open question{openQuestions.length === 1 ? '' : 's'} to settle
              </Text>
              {openQuestions.map(q => (
                <Box flexDirection="row" paddingLeft={2}>
                  <Box flexShrink={0}>
                    <Text color={SAGE}>? </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text>{q}</Text>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
          {field(
            'Tasks',
            <Text>
              {change.sections.length} sections · {change.tasks.total} tasks
            </Text>,
          )}
        </Box>
      )
    }

    const changeBlock = (change: Change) => (
      <Box flexDirection="column" paddingLeft={1}>
        <Box flexDirection="row" alignItems="center">
          <Box flexShrink={0} marginRight={1}>
            {tagOf(change)}
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">{change.name}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
            <Text dimColor wrap="truncate-end">
              {change.lastModified && now !== undefined ? ago(change.lastModified, now) : ''}
            </Text>
          </Box>
          {bar(change.tasks)}
          <Text>
            {' '}{change.tasks.done}/{change.tasks.total}
          </Text>
          <Text dimColor>
            {' '}{change.tasks.total > 0 ? Math.round((change.tasks.done / change.tasks.total) * 100) : 0}%
          </Text>
        </Box>
        {stepper(change)}

        {change.phase === 'review' && (
          <>
            {planDigest(change)}
            {waitingOn(change, hint('Review the plan, then /opsx:apply'))}
          </>
        )}

        {change.phase === 'implementing' && (
          <>
            {sectionBars(change)}
            {change.yourNext &&
              waitingOn(change, taskRow(change.yourNext, change.isMine ? SAGE : MUTED), change.yourLater)}
          </>
        )}

        {change.phase === 'ready' &&
          waitingOn(
            change,
            <>
              {hint(
                `Archiving will merge ${change.digest.specs.length} spec${change.digest.specs.length === 1 ? '' : 's'}: ` +
                  change.digest.specs.map(s => s.name).join(' · '),
              )}
              {hint('/opsx:archive')}
            </>,
          )}

        {change.aiNext && (
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            <Text bold color={change.isMine ? CLAY : MUTED}>▶ AI next</Text>
            {taskRow(change.aiNext, change.isMine ? CLAY : MUTED)}
          </Box>
        )}
      </Box>
    )

    // Each block sits in its own thin rounded frame, its heading at the top. A fixed
    // mid grey: the theme's dimmed border all but vanished on the dark theme
    const frame = (content: any) => (
      <Box flexDirection="column" borderStyle="round" borderColor={MUTED} paddingX={1} paddingY={air(1)} marginBottom={1} overflow="hidden">
        {content}
      </Box>
    )

    // Several modules and none picked: the reader's modules first, the ones waiting on
    // them on top; then the other people's, greyed, named after who created them
    if (selected === ALL && modules.length > 1) {
      const rank = (m: Module) => (m.you > 0 ? 0 : m.ai > 0 ? 1 : 2)
      const byActivity = (a: Module, b: Module) => (b.lastModified ?? '').localeCompare(a.lastModified ?? '')
      const mine = modules.filter(m => m.mine > 0).sort((a, b) => rank(a) - rank(b) || byActivity(a, b))
      const others = modules.filter(m => m.mine === 0 && m.changes > 0).sort(byActivity)
      const idle = modules.filter(m => m.changes === 0)
      const yours = modules.reduce((n, m) => n + m.you, 0)
      const ais = modules.reduce((n, m) => n + m.ai, 0)
      const caption = (label: string) => (
        <Box marginTop={1}>
          <Text dimColor bold>
            {label}
          </Text>
        </Box>
      )
      // One card per module, one line per change: name | dots | tag. The two right
      // columns have fixed widths, so the dots line up whatever the tag says
      const TAG_COLUMN = 12
      const changeLine = (line: Module['items'][number]) => (
        <Box flexDirection="row" alignItems="center" paddingLeft={2}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor={!line.isMine} wrap="truncate-end">
              {line.name}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            {Svg ? (
              <Svg
                source={dotsSvg(line.step, line.isMine ? turnColor(line.turn) : MUTED)}
                alt={`step ${line.step + 1} of 6`}
                width={DOTS_W}
                height={DOT}
              />
            ) : (
              // The six steps: done, current in the actor's colour, to come
              <Text>
                <Text dimColor>{'●'.repeat(Math.max(0, line.step))}</Text>
                <Text bold color={line.isMine ? turnColor(line.turn) : MUTED}>◉</Text>
                <Text dimColor>{'○'.repeat(Math.max(0, 5 - line.step))}</Text>
              </Text>
            )}
          </Box>
          <Box flexShrink={0} width={TAG_COLUMN} marginLeft={1} overflow="hidden">
            {line.isMine ? (
              turnTag(line.turn)
            ) : (
              <Text dimColor wrap="truncate-end">
                {line.owner ?? '?'}
              </Text>
            )}
          </Box>
        </Box>
      )
      // The card lights its frame under the pointer, and carries a real button: a
      // plain label alone gave no sign it could be clicked
      const card = (m: Module, isOthers = false) => (
        <Box
          key={`card:${m.path}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={MUTED}
          borderDimColor={isOthers}
          hover={{ borderColor: SLATE, borderDimColor: false }}
          paddingX={1}
          marginTop={air(1)}
          overflow="hidden"
        >
          <Box flexDirection="row" alignItems="center">
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {/* Plain text: on the desktop a plain Button took two clicks; Open is the action */}
              <Text bold dimColor={isOthers} wrap="truncate-end">
                {m.name}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text dimColor>{m.lastModified && now !== undefined ? ago(m.lastModified, now) : ''}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Button key={`open:${m.path}`} label="Open ›" variant="secondary" onPress={() => select($, m.path)} />
            </Box>
          </Box>
          {m.items.map(changeLine)}
        </Box>
      )
      // A module with nothing in progress needs no card: one line, still a way in
      const row = (m: Module) => (
        <Box flexDirection="row" alignItems="center" marginTop={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              {m.name}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Button key={`open:${m.path}`} label="Open ›" variant="secondary" onPress={() => select($, m.path)} />
          </Box>
        </Box>
      )
      return (
        <Box flexDirection="column">
          {brand}
          {frame(
            <>
              {heading('MODULES', modules.length, (yours > 0 || ais > 0) && turnCounts(yours, ais))}
              {mine.length > 0 && caption('MINE')}
              {mine.map(m => card(m))}
              {others.length > 0 && caption('OTHERS')}
              {others.map(m => card(m, true))}
              {idle.length > 0 && caption('NO ACTIVE CHANGE')}
              {idle.map(row)}
            </>,
          )}
          <Text dimColor>{'/spec-manager <module> also opens one'} · {footer(updatedAt, now)}</Text>
        </Box>
      )
    }

    // In one module of several: where we are, and the way back to the overview
    const current = modules.find(m => m.path === selected)
    const nav =
      modules.length > 1 && current ? (
        <Box flexDirection="row" alignItems="center" marginBottom={1}>
          <Button key="modules:all" label="‹ All modules" variant="secondary" onPress={() => select($, ALL)} />
          <Box flexShrink={1} minWidth={0} marginLeft={2}>
            <Text wrap="truncate-end">
              <Text bold>{current.name}</Text>
              <Text dimColor> · {modules.length - 1} other module{modules.length === 2 ? '' : 's'}</Text>
            </Text>
          </Box>
        </Box>
      ) : null

    if (roots.length === 0) {
      return (
        <Box flexDirection="column">
          {brand}
          {nav}
          <Text dimColor>Loading {current?.name ?? 'module'}…</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {brand}
        {nav}
        {frame(
          <>
            {heading('CHANGES', changes.length, changes.length > 0 && turnSummary(changes))}
            {changes.length === 0 && none}
            {changes.map((change, i) => (
              <>
                {i > 0 && rule}
                {changeBlock(change)}
              </>
            ))}
          </>,
        )}

        {frame(
          <>
            {heading('SPECS', specs.length)}
            {specs.length === 0 && none}
            {specs.map(spec => (
              <Box flexDirection="row" paddingLeft={1}>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate-end">
                    <Text dimColor>▪ </Text>{spec.id}
                  </Text>
                </Box>
                <Text dimColor> {spec.requirements} req</Text>
              </Box>
            ))}
          </>,
        )}

        {frame(
          <>
            {heading('ARCHIVED', archivedTotal)}
            {archivedTotal === 0 && none}
            {archived.map(name => (
              <Box paddingLeft={1}>
                <Text dimColor wrap="truncate-end">✓ {name}</Text>
              </Box>
            ))}
            {archivedTotal > archived.length && (
              <Box paddingLeft={1}>
                <Text dimColor italic>+ {archivedTotal - archived.length} more</Text>
              </Box>
            )}
          </>,
        )}

        <Text dimColor>{footer(updatedAt, now)}</Text>
      </Box>
    )
  })
}
