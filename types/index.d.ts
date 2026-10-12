export type Progress = { done: number; total: number }

export type Artifact = { name: string; isDone: boolean }

/** A `## N. Title` section of tasks.md with its checkbox count */
export type Section = { num: string; title: string } & Progress

/** An unchecked task of tasks.md */
export type Task = { id: string; text: string; isUserAction: boolean }

/** planning: an artifact is missing; review: all written, no task checked yet */
export type Phase = 'planning' | 'review' | 'implementing' | 'ready'

export type ChangeSpec = { name: string; requirements: number; scenarios: number }

/** The plan in a few lines, read from the headings of the change's documents */
export type Digest = {
  why?: string
  specs: ChangeSpec[]
  decisions: string[]
  openQuestions: number
}

export type Change = {
  name: string
  tasks: Progress
  artifacts: Artifact[]
  sections: Section[]
  digest: Digest
  phase: Phase
  /** Whose move it is, from the files alone: reviews are not tracked by OpenSpec */
  turn: 'you' | 'ai'
  /** Nearest unchecked user-action task, and how many more follow it */
  yourNext?: Task
  yourLater: number
  /** What the AI can do next: a task, or a planning artifact to write */
  aiNext?: Task
  /** ISO date of the last change to the change's files */
  lastModified?: string
  /** Created by the reader (first commit on its folder, or not committed yet) */
  isMine: boolean
  /** Who created it, when someone else did */
  owner?: string
}

export type Spec = { id: string; requirements: number }

export type Root = {
  name: string
  path: string
  changes: Change[]
  specs: Spec[]
  /** Most recent archived change names, at most a few */
  archived: string[]
  archivedTotal: number
}

/** One active change as its module's card shows it */
export type ChangeLine = {
  name: string
  /** Index of the current step among the six (proposal … archive) */
  step: number
  turn: 'you' | 'ai'
  isMine: boolean
  owner?: string
}

/** A folder holding an openspec/ directory, summed up for the overview */
export type Module = {
  /** Path relative to the base (the repo top), or the base's own name */
  name: string
  path: string
  changes: number
  /** The reader's own changes, and of those whose turn it is */
  mine: number
  you: number
  ai: number
  /** Who created the other changes */
  others: string[]
  /** Its active changes, the reader's first */
  items: ChangeLine[]
  /** Most recent lastModified among its active changes */
  lastModified?: string
}

export type View = {
  /** The selected module, loaded in full: one root, or none in the overview */
  roots: Root[]
  modules: Module[]
  /** A module's path, or 'all' for the overview */
  selected?: string
  error?: string
  updatedAt?: number
  /** Ticks every minute so relative times stay fresh */
  now?: number
}

declare module 'claude-code' {
  interface PluginState {
    'spec-manager': { view: View }
  }
}
