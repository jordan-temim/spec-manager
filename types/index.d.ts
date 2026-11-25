export type Progress = { done: number; total: number }

/** A planning document; a skipped one (`skip_specs: true`) counts as done */
export type Artifact = { name: string; isDone: boolean; isSkipped?: boolean }

/** A task of tasks.md; where checked or not matters, the field holding it says so */
export type Task = { id: string; text: string }

/** A `## N. Title` section of tasks.md with its checkbox count and every task in it */
export type Section = { num: string; title: string; tasks: (Task & { isDone: boolean })[] } & Progress

/** The help page's tabs: the OpenSpec cycle, the pane's marks, the commands */
export type HelpTab = 'cycle' | 'marks' | 'commands'

/** Whose move it is: you (review, archive) or the AI */
export type Turn = 'you' | 'ai'

/** planning: an artifact is missing; review: all written, no task checked yet */
export type Phase = 'planning' | 'review' | 'implementing' | 'ready'

/** `file`: its spec.md, absolute, to open from the pane */
export type ChangeSpec = { name: string; file: string; requirements: number; scenarios: number }

/** The plan in a few lines, read from the headings of the change's documents */
export type Digest = {
  why?: string
  specs: ChangeSpec[]
  decisions: string[]
  /** The bullets under `## Open Questions` in design.md */
  openQuestions: string[]
  /** Each document the digest read, absolute, when it has something in it */
  files?: { proposal?: string; design?: string; tasks?: string }
}

export type Change = {
  name: string
  tasks: Progress
  artifacts: Artifact[]
  sections: Section[]
  digest: Digest
  phase: Phase
  /** Whose move it is, from the files alone: reviews are not tracked by OpenSpec */
  turn: Turn
  /** What the AI does next: the nearest unchecked task, or, while planning, the document
   *  to write (`write <name>`, no id) */
  aiNext?: Task
  /** ISO date of the last change to the change's files */
  lastModified?: string
}

export type Spec = { id: string; requirements: number }

export type Root = {
  path: string
  changes: Change[]
  specs: Spec[]
  /** Most recent archived change names, at most a few */
  archived: string[]
  archivedTotal: number
  /** Read for the overview only: no plan digest, specs or archives yet */
  isLight?: boolean
  /** openspec failed in this module: nothing else of it could be read */
  error?: string
}

/** One active change as its module's card shows it */
export type ChangeLine = {
  name: string
  /** Index of the current step, and how many steps there are: six with the spec-driven
   *  documents (proposal … archive), another count with another schema */
  step: number
  steps: number
  turn: Turn
}

/** A folder holding an openspec/ directory, summed up for the overview */
export type Module = {
  /** Path relative to the base (the repo top), or the base's own name */
  name: string
  path: string
  changes: number
  /** Its changes whose next step is yours, and the AI's */
  you: number
  ai: number
  /** Its active changes */
  items: ChangeLine[]
  /** Most recent lastModified among its active changes */
  lastModified?: string
  /** openspec failed in this module */
  error?: string
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
    'spec-manager': {
      view: View
      /** Blocks opened or closed by a press: task sections by `change:num`, `block:specs`, `block:archived` */
      expanded: Record<string, boolean>
      /** The help page's tab while it is open; '' when the pane shows the modules */
      help: '' | HelpTab
    }
  }
}
