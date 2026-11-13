// What the OpenSpec files say: tasks.md, proposal.md, design.md and the specs read by
// their structure, a change's phase and steps, and the names of the modules. No $ here

import type { Artifact, Change, Progress, Section, Task } from '../types'

export const ALL = 'all'

// openspec itself missing (not on the PATH), as against an error openspec answered: a
// "change not found" from openspec is its own, the PATH has nothing to do with it
export const isNotInstalled = (error: string) =>
  // The spawn of openspec itself failing ("spawn openspec ENOENT"), not an ENOENT openspec
  // met reading a file; bash's "command not found"; dash's "sh: 1: openspec: not found";
  // Windows' "'openspec' is not recognized as an internal or external command"
  /\bspawn \S*openspec\S* ENOENT\b|command not found|\bopenspec: not found|not recognized as an internal/i.test(error)

export const moduleName = (base: string, path: string) =>
  path === base ? (base.split('/').pop() ?? base) : path.slice(base.length + 1)

// A single module is always shown directly, even one that appeared mid-session
// while the overview (or nothing) was selected
export const settle = (selected: string | undefined, paths: string[]) =>
  paths.length === 1 ? paths[0] : selected !== ALL && !paths.includes(selected ?? '') ? ALL : selected

// "/spec-manager paiement" picks a module by name or by the end of its path
// Names compared whatever their case: "Paiement" finds paiement
export function resolveModule(arg: string, paths: string[], base: string): string | undefined {
  const wanted = arg.trim().replace(/\/+$/, '').toLowerCase()
  if (wanted === '' || wanted === ALL) return ALL
  const partial = partialMatches(wanted, paths, base)
  return (
    paths.find(p => moduleName(base, p).toLowerCase() === wanted) ??
    paths.find(p => p.toLowerCase().endsWith(`/${wanted}`)) ??
    (partial.length === 1 ? partial[0] : undefined)
  )
}

// A fragment found in several module names picks none: the command lists them instead
export const partialMatches = (arg: string, paths: string[], base: string) => {
  const wanted = arg.trim().replace(/\/+$/, '').toLowerCase()
  return paths.filter(p => moduleName(base, p).toLowerCase().includes(wanted))
}

// Sections (`## 1. Title`) with their checkbox counts, and the unchecked tasks in order
// Windows line endings (CRLF) read as plain ones: `.` stops at a `\r`, so a line
// ending in one matched no heading and no checkbox
export const unix = (text: string) => text.replace(/\r\n?/g, '\n')

export function parseTasks(markdown: string): { sections: Section[]; open: Task[] } {
  const sections: Section[] = []
  const open: Task[] = []
  let section: Section | undefined
  for (const line of unix(markdown).split('\n')) {
    const heading = line.match(/^##\s+(\d+)\.\s+(.+)$/)
    if (heading) {
      section = { num: heading[1]!, title: heading[2]!.trim(), done: 0, total: 0, tasks: [] }
      sections.push(section)
      continue
    }
    // Any other `## ` heading (Notes, Verification) ends the numbered section: its boxes
    // count in no section's bar
    if (/^##\s/.test(line)) {
      section = undefined
      continue
    }
    const box = line.match(/^\s*[-*] \[([ xX])\]\s+(.+)$/)
    if (!box) continue
    const isDone = box[1] !== ' '
    // `1.2 Do it`, `1.2. Do it` or `3. Do it`: the id without its closing dot. A bare number
    // is the task's own words ("3 retries at most"), and so is a decimal that is not one of
    // its section's ids ("2.5 seconds at most" under section 1)
    const [, found = '', after = box[2]!] = box[2]!.match(/^(\d+(?:\.\d+)+|\d+(?=\.))\.?\s+(.+)$/) ?? []
    const isId = found !== '' && (!found.includes('.') || !section || found.startsWith(`${section.num}.`))
    const id = isId ? found : ''
    const rest = isId ? after : box[2]!
    const text = rest.replace(/[`*]/g, '').trim()
    if (section) {
      section.total++
      if (isDone) section.done++
      section.tasks.push({ id, text, isDone })
    }
    if (!isDone) open.push({ id, text })
  }
  return { sections: sections.filter(s => s.total > 0), open }
}

// Phase and whose move it is, inferred from artifacts and checkboxes
// A change's planning documents from `openspec status`: its own verdict per document
// when it gives one (a document a change skips, as with `skip_specs: true`, is
// "skipped" and counts as done), else whether the document's files exist
export function artifactsFrom(one: any): Artifact[] {
  const verdict = new Map<string, string>(
    (Array.isArray(one.artifacts) ? one.artifacts : []).map((a: any) => [a.id, a.status]),
  )
  const paths = new Map(Object.entries(one.artifactPaths ?? {}) as [string, { existingOutputPaths?: string[] }][])
  // Every document either source names, in the order of the verdicts when there are some
  // (openspec lists them in the schema's order), so a partial artifactPaths keeps the cycle
  // in order; a status with verdicts but no paths still lists them
  const names = [...new Set([...verdict.keys(), ...paths.keys()])]
  return names.map(name => {
    const status = verdict.get(name)
    if (status === 'skipped') return { name, isDone: true, isSkipped: true }
    if (status === 'done') return { name, isDone: true }
    return { name, isDone: (paths.get(name)?.existingOutputPaths ?? []).length > 0 }
  })
}

// Without a word from `openspec status` (it failed, or does not know the change yet):
// the spec-driven documents, each done when its file is in the change's folder
export function artifactsFromFiles(names: string[], specDirs: string[]): Artifact[] {
  return [
    { name: 'proposal', isDone: names.includes('proposal.md') },
    { name: 'specs', isDone: specDirs.length > 0 },
    { name: 'design', isDone: names.includes('design.md') },
    { name: 'tasks', isDone: names.includes('tasks.md') },
  ]
}

export function whoseTurn(
  artifacts: Artifact[],
  tasks: Progress,
  open: Task[],
): Pick<Change, 'phase' | 'turn' | 'aiNext'> {
  const missing = artifacts.find(a => !a.isDone)
  if (missing) {
    return { phase: 'planning', turn: 'ai', aiNext: { id: '', text: `write ${missing.name}` } }
  }
  if (tasks.total > 0 && tasks.done === tasks.total) {
    return { phase: 'ready', turn: 'you' }
  }
  // /opsx:propose writes the four documents in one go, then stops: the plan waits for review
  if (tasks.done === 0) {
    return { phase: 'review', turn: 'you' }
  }
  // OpenSpec says nothing of who does a task: while tasks are checked, the AI builds
  return { phase: 'implementing', turn: 'ai', aiNext: open[0] }
}

// First sentence of the proposal's `## Why`
export function whyLine(proposal: string): string | undefined {
  // Up to the next section only: an empty Why is no Why, not the first bullet of What Changes
  // Headings read whatever their case: `## why` is the Why
  const after = unix(proposal).split(/^## Why\s*$/im)[1]?.split(/^#{1,2} /m)[0]
  // The template's <!-- prompt --> comments are not the Why
  const line = after?.replace(/<!--[\s\S]*?-->/g, '').split('\n').find(l => l.trim() !== '' && !l.startsWith('#'))
  if (!line) return undefined
  // A Why opening on a bullet or a quote: the sentence without its mark
  const text = line.replace(/^\s*(?:[-*>]|\d+\.)\s+/, '').trim()
  // A sentence ends where the next one starts with a capital: "e.g. by card" goes on
  return text.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý])/)[0]?.replace(/[`*]/g, '')
}

// Decision titles (`### D1. Title`) and the bullets under `## Open Questions` of design.md
export function parseDesign(markdown: string): { decisions: string[]; openQuestions: string[] } {
  const design = unix(markdown)
  const decisions = [...design.matchAll(/^### (D\d+)\.\s+(.+)$/gm)].map(m => `${m[1]} ${m[2]!.replace(/[`*]/g, '').trim()}`)
  const section = design.split(/^## Open Questions\s*$/im)[1]?.split(/^## /m)[0] ?? ''
  // Within one line: a lone `-` or `1.` takes nothing from the line below
  const bullets = [...section.matchAll(/^([ \t]*)(?:[-*]|\d+\.)[ \t]+(.+)$/gm)]
  // The questions are the outermost bullets: those under one ("- Stripe", "- Adyen" under
  // "- Which provider?") are its options, not questions of their own
  const outer = Math.min(...bullets.map(m => m[1]!.length))
  const openQuestions = bullets
    .filter(m => m[1]!.length === outer)
    .map(m => m[2]!.replace(/[`*]/g, '').trim())
    .filter(q => !NO_QUESTION.test(q))
  return { decisions, openQuestions }
}
// "- None", "- Aucune pour l'instant", "- N/A", "- —": a bullet that only says there is
// no question. Anything more is one, question mark or not ("None of the providers retry,
// decide the fallback")
export const NO_QUESTION =
  /^(?:(?:none|n\/a|nothing|aucune?|néant|rien|no (?:open )?questions?|pas de questions?(?: ouvertes?)?)(?:\s+(?:yet|so far|for now|at this time|pour l'instant|pour le moment|à ce stade))?[.!]?|[-–—]+)$/i

export function specCounts(markdown: string): { requirements: number; scenarios: number } {
  // A delta spec's `## REMOVED Requirements` names the ones it takes away: not counted
  const spec = unix(markdown).replace(/^## REMOVED Requirements\s*$[\s\S]*?(?=^## |(?![\s\S]))/im, '')
  return {
    requirements: (spec.match(/^### Requirement:/gm) ?? []).length,
    scenarios: (spec.match(/^#### Scenario:/gm) ?? []).length,
  }
}

// A change's spec by its file: the folders between its last `/specs/` and `/spec.md`.
// From the end of the path, so a path openspec resolved through a symlink (macOS's
// /private/var) or wrote relative still names its capability
export const specName = (file: string) => {
  const path = `/${file.replace(/\\/g, '/')}`
  const at = path.lastIndexOf('/specs/')
  // No specs/ folder in the path at all: the folder spec.md sits in
  if (at < 0) return path.replace(/\/spec\.md$/, '').split('/').pop() ?? ''
  return path.slice(at + '/specs/'.length).replace(/\/spec\.md$/, '')
}

// openspec's paths, made absolute against the module folder it ran in. A Windows path
// (C:\\… or C:/…) is absolute too, read with forward slashes
export const absolute = (dir: string, file: string) => {
  const path = file.replace(/\\/g, '/')
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path) ? path : `${dir}/${path.replace(/^\.\//, '')}`
}

// A file's link: a file:// URL of its absolute path, a Windows one (C:/…) given its
// third slash; what a URL reads as its own (#, ?, %) is escaped
export const fileUrl = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  return `file://${slashed.startsWith('/') ? '' : '/'}${encodeURI(slashed).replace(/[?#]/g, c => encodeURIComponent(c))}`
}

// Markdown's own marks in words, escaped: a spec named add_user_auth stays as written
export const mdText = (text: string) => text.replace(/[\\[\]*_`<>#]/g, c => `\\${c}`)
// A Markdown link's target, its parentheses and spaces encoded: a path with a ( stays
// one link
export const mdHref = (url: string) => url.replace(/[()\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)

// Whose change it is: the author of the oldest commit on its folder (`git log
// --reverse --format=%ae%x09%an`). No commit yet means it was made here: the reader's
export function ownerOf(log: string, me: string): { isMine: boolean; owner?: string } {
  const first = log.split('\n').find(line => line.trim() !== '')
  // Emails compared as git writes them for people: spaces and case aside
  const mine = me.trim().toLowerCase()
  if (!first || mine === '') return { isMine: true }
  const [email = '', name = ''] = first.split('\t')
  if (email.trim().toLowerCase() === mine) return { isMine: true }
  return { isMine: false, owner: name.trim() || email.trim() }
}

export type StepState = 'done' | 'current' | 'todo'

// The whole cycle in OpenSpec's own words: the four documents, then apply and archive
export function steps(change: Change): { name: string; state: StepState; isSkipped?: boolean }[] {
  const raw: { name: string; isDone: boolean; isSkipped?: boolean }[] = [
    ...change.artifacts.map(a => ({ name: a.name, isDone: a.isDone, isSkipped: a.isSkipped })),
    { name: 'apply', isDone: change.phase === 'ready' },
    { name: 'archive', isDone: false },
  ]
  const current = raw.findIndex(s => !s.isDone)
  return raw.map((s, i) => ({
    name: s.name,
    state: s.isDone ? 'done' : i === current ? 'current' : 'todo',
    ...(s.isSkipped ? { isSkipped: true } : {}),
  }))
}
