// The pane: the overview of the modules, or one module with its changes, specs and archive

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { ALL, fileUrl, isNotInstalled, mdHref, mdText, settle, steps } from './model'
import { SCAN_MAX_DIRS, refresh, select, sessionOf } from './load'
import { BAR_H, BAR_W, BLUE, BRAND_H, BRAND_W, CLAY, DOT, GREEN, MUTED, NUMBER_D, RULE_SVG, TAB_H, WASH, actorColor, barSvg, brandSvg, dotsSvg, dotsWidth, numberSvg, stepperSvg, stepperWidth, turnColor } from './svg'
import type { Change, HelpTab, Module, Progress, Task, Turn, View } from '../types'

// The same state as load.ts's: the state scan reads the atoms a file writes in its own consts
const view = atom({ plugin: 'spec-manager', key: 'view' } as const, { roots: [], modules: [] } as View)
// Sections the reader opened or closed; any other one is open only while it is the current one
const expanded = atom({ plugin: 'spec-manager', key: 'expanded' } as const, {} as Record<string, boolean>)
// The help page's tab while it is open; '' while the pane shows the modules
const help = atom({ plugin: 'spec-manager', key: 'help' } as const, '' as '' | HelpTab)

// The help page, as in live-review: the OpenSpec cycle, each step numbered in the colour
// of who takes it; what each mark of the pane means; the commands
const HELP_TABS: readonly (readonly [HelpTab, string])[] = [
  ['cycle', 'The cycle'],
  ['marks', 'Marks'],
  ['commands', 'Commands'],
]
const HELP_CYCLE: readonly (readonly [Turn, string, string])[] = [
  ['ai', '/opsx:propose', 'The AI writes the proposal, the specs, the design and the tasks.'],
  ['you', 'You review the plan', 'Open questions first, then /opsx:apply.'],
  ['ai', 'The AI builds', 'It checks the tasks off; the green bar moves.'],
  ['you', 'Your actions on the way', 'A ● task (a key, an account) waits on you.'],
  ['you', '/opsx:archive', "Every task checked: you close the change, its specs join the module's."],
]
const HELP_COMMANDS: readonly (readonly [string, string])[] = [
  ['/spec-manager', 'Opens the pane, or brings it back'],
  ['/spec-manager <module>', 'Opens one module, by its name or the end of its path'],
  ['/spec-manager all', 'Back to every module'],
]

export const clock = (ms: number) => {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

// "updated at 20:35:37 · refresh in 2s"
export const footer = (nextPollAt: number, updatedAt: number, now: number | undefined, isCut = false) => {
  const left = now === undefined ? undefined : Math.max(0, Math.ceil((nextPollAt - now) / 1000))
  // A repository too large to search whole: modules further down may be missing
  const cut = isCut ? ` · search stopped after ${SCAN_MAX_DIRS} folders` : ''
  return `updated at ${clock(updatedAt)}${left === undefined ? '' : ` · refresh in ${left}s`}${cut}`
}

// "5m ago"; nothing for a date openspec wrote in a form that does not parse
export const ago = (iso: string, now: number) => {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / (60 * 24))}d ago`
}

export const PHASE_LABEL = {
  planning: 'Planning',
  review: 'Plan to review',
  implementing: 'Implementing',
  ready: 'Ready to archive',
} as const

// The pane, drawn from the view and the session: the overview of the modules, or one
// module with its changes, specs and archive
export async function renderPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  // Groups are written as column Boxes rather than `<>…</>`: a fragment builds the very
  // same Box, but its children are typed narrower (no `cond && …`, no mapped list)
  // The terminal draws text: there the counts stand in for the bars, symbols for the
  // stepper. Asked by surface, since newer terminals carry an Svg that draws nothing
  const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
  // A document's link, on the desktop alone: its Link draws a file link as plain text, but
  // its Markdown, the renderer of Claude's own replies, opens one in the Files tab. The
  // terminal has none to offer: a Link there opened nothing and wrote out the whole URL
  const Markdown = e.surface !== 'terminal' && 'Markdown' in elements ? elements.Markdown : undefined
  // A terminal row is far taller than a pixel: there the frames and cards drop the
  // blank rows that only give the desktop some air
  const air = (rows: number) => (Svg ? rows : rows - 1)
  // On the terminal, which has no SVG, the wordmark is text: the three steps, then the words
  const logo = (
    <Box flexDirection="row" justifyContent="flex-end" flexGrow={1}>
      {Svg ? (
        <Svg source={brandSvg()} alt="Spec Manager" width={BRAND_W} height={BRAND_H} />
      ) : (
        <Text>
          <Text color={MUTED}>●</Text>
          <Text dimColor>─</Text>
          <Text color={CLAY}>●</Text>
          <Text dimColor>─</Text>
          <Text color={BLUE}>○ </Text>
          <Text bold color={GREEN}>spec</Text>
          <Text> manager</Text>
        </Text>
      )}
    </Box>
  )
  // The way to the help page on the left, the logo on the right
  const brand = (
    <Box marginBottom={1} flexDirection="row" alignItems="center">
      <Button key="help:open" label="? Help" variant="secondary" onPress={() => update($, help, () => 'cycle')} />
      {logo}
    </Box>
  )
  // What the two tags mean: the kind of the next step, not who is acting right now
  const legend = (
    <Text dimColor>
      <Text bold color={CLAY}>AI</Text> builds · <Text bold color={BLUE}>YOU</Text> act
    </Text>
  )
  const { roots, modules, selected, error, updatedAt, now } = await read($, view)
  const opened = await read($, expanded)
  const helpTab = await read($, help)
  const session = await sessionOf($)
  // SPECS and ARCHIVED start closed, heading and count only: a long list took the pane
  const areSpecsOpen = opened['block:specs'] ?? false
  const isArchiveOpen = opened['block:archived'] ?? false

  // The help page in place of the pane's own: a way back, the tabs, the open tab's body
  if (helpTab) {
    const card = (key: string, content: any) => (
      <Box key={key} flexDirection="row" columnGap={1} borderStyle={Svg ? 'round' : undefined} borderColor={MUTED} backgroundColor={Svg ? WASH : undefined} paddingX={Svg ? 1 : 0}>
        {content}
      </Box>
    )
    const tag = (text: string, color: string) => (
      <Text bold inverse color={color}>
        {` ${text} `}
      </Text>
    )
    // A mark as the pane draws it, then what it means
    const mark = (key: string, drawn: any, meaning: string) => (
      <Box key={`help-mark:${key}`} flexDirection="row" columnGap={1}>
        <Box width={7} flexShrink={0}>
          {drawn}
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Text dimColor>{meaning}</Text>
        </Box>
      </Box>
    )
    const body = {
      cycle: (
        <Box flexDirection="column" gap={air(1)}>
          {HELP_CYCLE.map(([turn, title, text], i) =>
            card(
              `help-step:${i}`,
              <>
                {Svg ? (
                  <Svg source={numberSvg(i + 1, turnColor(turn))} alt={`${i + 1}`} width={NUMBER_D} height={NUMBER_D} />
                ) : (
                  <Text bold color={turnColor(turn)}>
                    {i + 1}.
                  </Text>
                )}
                <Box flexDirection="column" flexShrink={1} minWidth={0}>
                  <Text bold>{title}</Text>
                  <Text dimColor>{text}</Text>
                </Box>
              </>,
            ),
          )}
        </Box>
      ),
      marks: (
        <Box flexDirection="column" gap={air(1)}>
          <Box flexDirection="column">
            {mark('you', tag('YOU', BLUE), 'Your move, on a change of yours')}
            {mark('ai', tag('AI', CLAY), "The AI's move")}
            {mark('owner', tag('ana', MUTED), "Someone else's change, in grey: whose it is")}
          </Box>
          <Box flexDirection="column">
            {mark('user-task', <Text color={BLUE}>●</Text>, 'A task for you to do (a key, an account)')}
            {mark('ai-task', <Text color={CLAY}>◦</Text>, 'A task for the AI')}
            {mark('done', <Text color={MUTED}>✓</Text>, 'Done')}
            {mark(
              'bar',
              Svg ? <Svg source={barSvg({ done: 2, total: 3 })} alt="2 of 3" width={BAR_W} height={BAR_H} /> : <Text dimColor>2/3</Text>,
              'Tasks checked, against the spec',
            )}
            {Markdown && mark('link', <Text>↗</Text>, 'Opens the document the line was read from, in the Files tab')}
          </Box>
        </Box>
      ),
      commands: (
        <Box flexDirection="column" gap={air(1)}>
          <Box flexDirection="column">
            {HELP_COMMANDS.map(([command, text]) => (
              <Box key={`help-command:${command}`} flexDirection="row" columnGap={1}>
                <Box width={23} flexShrink={0}>
                  <Text bold>{command}</Text>
                </Box>
                <Box flexShrink={1} minWidth={0}>
                  <Text dimColor>{text}</Text>
                </Box>
              </Box>
            ))}
          </Box>
          <Text dimColor>It reads the openspec/ folders every 10 s, never the conversation.</Text>
        </Box>
      ),
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Button key="help:back" label="← Back" variant="secondary" onPress={() => update($, help, () => '')} />
          {/* In plain text: terracotta is the AI's, blue yours */}
          <Text bold>How spec manager works</Text>
          {logo}
        </Box>
        {/* The tabs: the one open at full strength, the others dimmed */}
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {HELP_TABS.map(([name, label]) => (
            <Button key={`help-tab:${name}`} label={label} plain dimColor={name !== helpTab} onPress={() => update($, help, () => name)} />
          ))}
        </Box>
        {body[helpTab]}
      </Box>
    )
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="error">openspec: {error}</Text>
        {/* Not found is a PATH matter; anything else is openspec's own answer, said above */}
        {isNotInstalled(error) ? (
          <Text dimColor>Check that `openspec` is on the PATH (~/.local/bin/openspec).</Text>
        ) : (
          <Text dimColor>openspec ran but failed in every module.</Text>
        )}
      </Box>
    )
  }
  if (updatedAt === undefined) return <Text dimColor>Loading…</Text>
  if (modules.length === 0) return <Text dimColor>No openspec/ folder in this repository.</Text>

  const changes = roots.flatMap(root => root.changes)
  const specs = roots.flatMap(root => root.specs)
  const archived = roots.flatMap(root => root.archived)
  const archivedTotal = roots.reduce((sum, root) => sum + root.archivedTotal, 0)
  // A module just opened from the overview's light read: what only the full read
  // brings (digest, specs, archives) says it is coming, never "none" or 0
  const isLight = roots.some(root => root.isLight)
  const moduleError = roots.find(root => root.error)?.error

  const bar = (p: Progress) =>
    Svg && (
      <Box flexShrink={0} marginLeft={1}>
        <Svg source={barSvg(p)} alt={`${p.done} of ${p.total}`} width={BAR_W} height={BAR_H} />
      </Box>
    )

  // Accent-colored caps so the three blocks stand apart from their content
  const heading = (label: string, count: number | string, badge?: any, isClosed = false) => (
    <Box flexDirection="row" alignItems="center" marginBottom={isClosed ? 0 : 1}>
      <Text bold>{label}</Text>
      <Box flexGrow={1}>
        <Text dimColor> {count}</Text>
      </Box>
      {badge}
    </Box>
  )
  // The same tag on each change and, counted, on the CHANGES heading
  const turnTag = (turn: Turn, count?: number) => (
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
                {s.state === 'done' ? (s.isSkipped ? '–' : '✓') : s.state === 'current' ? '◐' : '○'} {s.name}
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

  // A document to open from the pane: the words as the pane draws them, then a ↗ that
  // opens it. The link alone takes Markdown's colour, the app's own dark link blue, which
  // read heavy on a whole label. Opening it is the reader's move
  // One Markdown for the words and their ↗, set straight in its column: a Markdown in a
  // row of boxes beside a Text stood apart from it and widened the card past the pane
  const docLink = (file: string | undefined, text: string, isBold = false) =>
    Markdown && file ? (
      <Markdown text={`${isBold ? `**${mdText(text)}**` : mdText(text)} [↗](${mdHref(fileUrl(file))})`} dimColor={isBold} />
    ) : (
      <Text bold={isBold} dimColor={isBold} wrap="truncate-end">
        {text}
      </Text>
    )

  // A label column, then its content; a label read from a document links to it
  const field = (label: string, content: any, color?: string, file?: string) => (
    <Box flexDirection="row" paddingLeft={2}>
      <Box width={11} flexShrink={0}>
        {file && !color ? docLink(file, label, true) : <Text bold dimColor={!color} color={color}>{label}</Text>}
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
        <Text bold color={change.isMine ? BLUE : MUTED}>
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

  // The chevron alone, no frame: dim at rest, full under the pointer. A press keeps
  // the block open or closed for the rest of the session
  // The press flips what the state holds at that moment, not what was drawn: two presses
  // before a redraw close what the first opened
  const chevron = (key: string, id: string, isOpen: boolean, isOpenByDefault: boolean) => (
    <Box flexShrink={0} marginLeft={1}>
      <Button
        key={key}
        label={isOpen ? '⌄' : '›'}
        plain
        dimColor
        onPress={() => update($, expanded, old => ({ ...old, [id]: !(old[id] ?? isOpenByDefault) }))}
      />
    </Box>
  )

  // Each section opens on its tasks: the current one by itself, the others on a press.
  // ✓ done, ◦ to do, ● a user action
  const sectionBars = (change: Change) => {
    const current = change.sections.find(s => s.done < s.total)?.num
    return (
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {change.sections.map(s => {
          const isComplete = s.done === s.total
          // The module's path too: two modules may each have a change of the same name
          const id = `${selected}:${change.name}:${s.num}`
          const isOpen = opened[id] ?? s.num === current
          return (
            <Box flexDirection="column">
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
                {chevron(`section:${id}`, id, isOpen, s.num === current)}
              </Box>
              {isOpen &&
                s.tasks.map(t => (
                  <Box flexDirection="row" paddingLeft={2}>
                    <Box flexShrink={0}>
                      <Text color={t.isDone || !change.isMine ? MUTED : t.isUserAction ? BLUE : CLAY}>
                        {t.isDone ? '✓' : t.isUserAction ? '●' : '◦'}{' '}
                        {t.id ? `${t.id} ` : ''}
                      </Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text dimColor={t.isDone} wrap="truncate-end">{t.text}</Text>
                    </Box>
                  </Box>
                ))}
            </Box>
          )
        })}
      </Box>
    )
  }

  // The plan in a few lines, for the review between /opsx:propose and /opsx:apply
  const planDigest = (change: Change) => {
    const { why, specs, decisions, openQuestions, files = {} } = change.digest
    return (
      <Box flexDirection="column" marginTop={1} rowGap={1}>
        {why && field('Why', <Text>{why}</Text>, undefined, files.proposal)}
        {field(
          'Specs',
          <Box flexDirection="column">
            {specs.length === 0 && <Text dimColor>none</Text>}
            {specs.map(s => (
              <Box flexDirection="row">
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  {docLink(s.file, s.name)}
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
            undefined,
            files.design,
          )}
        {/* The questions themselves, in your colour: they wait on you before /opsx:apply.
            On someone else's plan they wait on its author: grey, as the rest of it */}
        {openQuestions.length > 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            <Text bold color={change.isMine ? BLUE : MUTED}>
              ⚠ {openQuestions.length} open question{openQuestions.length === 1 ? '' : 's'} to settle
            </Text>
            {openQuestions.map(q => (
              <Box flexDirection="row" paddingLeft={2}>
                <Box flexShrink={0}>
                  <Text color={change.isMine ? BLUE : MUTED}>? </Text>
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
          undefined,
          files.tasks,
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
          {' '}{/* Down: 100% only once every task is checked */}
            {change.tasks.total > 0 ? Math.floor((change.tasks.done / change.tasks.total) * 100) : 0}%
        </Text>
      </Box>
      {stepper(change)}

      {change.phase === 'review' && (
        <Box flexDirection="column">
          {!isLight && planDigest(change)}
          {/* /opsx:apply writes no file until a task is checked: say so, for a long first task */}
          {/* What to type is the author's: someone else's plan says only whom it waits on */}
          {waitingOn(
            change,
            change.isMine ? (
              <Box flexDirection="column">
                {hint('Review the plan, then /opsx:apply')}
                {hint(
                  change.tasks.total === 0
                    ? 'tasks.md lists no task yet: nothing to apply until it does.'
                    : 'Already applying? This moves on once the first task is checked.',
                )}
              </Box>
            ) : undefined,
          )}
        </Box>
      )}

      {change.phase === 'implementing' && (
        <Box flexDirection="column">
          {sectionBars(change)}
          {change.yourNext &&
            waitingOn(change, taskRow(change.yourNext, change.isMine ? BLUE : MUTED), change.yourLater)}
        </Box>
      )}

      {change.phase === 'ready' &&
        waitingOn(
          change,
          <Box flexDirection="column">
            {!isLight &&
              change.digest.specs.length > 0 &&
              hint(
                `Archiving will merge ${change.digest.specs.length} spec${change.digest.specs.length === 1 ? '' : 's'}: ` +
                  change.digest.specs.map(s => s.name).join(' · '),
              )}
            {change.isMine && hint('/opsx:archive')}
          </Box>,
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
  // mid grey: the theme's dimmed border all but vanished on the dark theme. On the
  // desktop a light wash fills it, unless cards inside carry their own
  const frame = (content: any, isWashed = true) => (
    <Box flexDirection="column" borderStyle="round" borderColor={MUTED} backgroundColor={Svg && isWashed ? WASH : undefined} paddingX={1} paddingY={air(1)} marginBottom={1} overflow="hidden">
      {content}
    </Box>
  )

  // Several modules and none picked: the reader's modules first, the ones waiting on
  // them on top; then the other people's, greyed, named after who created them
  if (selected === ALL && modules.length > 1) {
    const rank = (m: Module) => (m.you > 0 ? 0 : m.ai > 0 ? 1 : 2)
    // Latest activity first, by the dates themselves; one that does not parse goes last
    const activity = (m: Module) => {
      const at = Date.parse(m.lastModified ?? '')
      return Number.isFinite(at) ? at : -Infinity
    }
    const byActivity = (a: Module, b: Module) => activity(b) - activity(a) || 0
    const mine = modules.filter(m => m.mine > 0).sort((a, b) => rank(a) - rank(b) || byActivity(a, b))
    const others = modules.filter(m => m.mine === 0 && m.changes > 0).sort(byActivity)
    const idle = modules.filter(m => m.changes === 0 && !m.error)
    const failing = modules.filter(m => m.error)
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
              source={dotsSvg(line.step, line.steps, line.isMine ? turnColor(line.turn) : MUTED)}
              alt={`step ${line.step + 1} of ${line.steps}`}
              width={dotsWidth(line.steps)}
              height={DOT}
            />
          ) : (
            // One per step: done, current in the actor's colour, to come
            <Text>
              <Text dimColor>{'●'.repeat(Math.max(0, line.step))}</Text>
              <Text bold color={line.isMine ? turnColor(line.turn) : MUTED}>◉</Text>
              <Text dimColor>{'○'.repeat(Math.max(0, line.steps - 1 - line.step))}</Text>
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
        backgroundColor={Svg ? WASH : undefined}
        hover={{ borderColor: GREEN, borderDimColor: false }}
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
            <Button key={`open:${m.path}`} label="Open ›" variant="secondary" onPress={() => select($, session, m.path)} />
          </Box>
        </Box>
        {m.items.map(changeLine)}
      </Box>
    )
    // A module with nothing in progress needs no card: one line, still a way in
    const row = (m: Module) => (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" alignItems="center">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">
              {m.name}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Button key={`open:${m.path}`} label="Open ›" variant="secondary" onPress={() => select($, session, m.path)} />
          </Box>
        </Box>
        {m.error && (
          <Box paddingLeft={2} minWidth={0}>
            <Text color="error" wrap="truncate-end">openspec: {m.error}</Text>
          </Box>
        )}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {brand}
        {frame(
          <Box flexDirection="column">
            {heading('MODULES', modules.length, (yours > 0 || ais > 0) && turnCounts(yours, ais))}
            {mine.length > 0 && caption('MINE')}
            {mine.map(m => card(m))}
            {others.length > 0 && caption('OTHERS')}
            {others.map(m => card(m, true))}
            {idle.length > 0 && caption('NO ACTIVE CHANGE')}
            {idle.map(row)}
            {failing.length > 0 && caption('OPENSPEC FAILED')}
            {failing.map(row)}
          </Box>,
          false,
        )}
        {legend}
        <Text dimColor>{'/spec-manager <module> also opens one'} · {footer(session.nextPollAt, updatedAt, now, session.found?.isCut)}</Text>
      </Box>
    )
  }

  // In one module of several: where we are, and the way back to the overview. Back
  // there even from a module not (or no longer) among those listed: never a dead end
  const current = modules.find(m => m.path === selected)
  const otherCount = current ? modules.length - 1 : modules.length
  const nav =
    modules.length > 1 ? (
      <Box flexDirection="row" alignItems="center" marginBottom={1}>
        <Button key="modules:all" label="‹ All modules" variant="secondary" onPress={() => select($, session, ALL)} />
        <Box flexShrink={1} minWidth={0} marginLeft={2}>
          <Text wrap="truncate-end">
            <Text bold>{current?.name ?? selected?.split('/').pop() ?? 'module'}</Text>
            <Text dimColor> · {otherCount} other module{otherCount === 1 ? '' : 's'}</Text>
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
        <Box flexDirection="column">
          {heading('CHANGES', changes.length, changes.length > 0 && turnSummary(changes))}
          {moduleError && <Text color="error">openspec: {moduleError}</Text>}
          {changes.length === 0 && !moduleError && none}
          {changes.map((change, i) => (
            <Box flexDirection="column">
              {i > 0 && rule}
              {changeBlock(change)}
            </Box>
          ))}
        </Box>,
      )}

      {frame(
        <Box flexDirection="column">
          {/* Not read (yet, or at all when openspec failed): no count, no "(none)" */}
          {isLight || moduleError
            ? heading('SPECS', isLight ? '…' : '?', undefined, true)
            : heading('SPECS', specs.length, specs.length > 0 && chevron('block:specs', 'block:specs', areSpecsOpen, false), specs.length > 0 && !areSpecsOpen)}
          {!isLight && !moduleError && specs.length === 0 && none}
          {areSpecsOpen && specs.map(spec => (
            <Box flexDirection="row" paddingLeft={1}>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text wrap="truncate-end">
                  <Text dimColor>▪ </Text>{spec.id}
                </Text>
              </Box>
              <Text dimColor> {spec.requirements} req</Text>
            </Box>
          ))}
        </Box>,
      )}

      {frame(
        <Box flexDirection="column">
          {isLight || moduleError
            ? heading('ARCHIVED', isLight ? '…' : '?', undefined, true)
            : heading('ARCHIVED', archivedTotal, archivedTotal > 0 && chevron('block:archived', 'block:archived', isArchiveOpen, false), archivedTotal > 0 && !isArchiveOpen)}
          {!isLight && !moduleError && archivedTotal === 0 && none}
          {isArchiveOpen && archived.map(name => (
            <Box paddingLeft={1}>
              <Text dimColor wrap="truncate-end">✓ {name}</Text>
            </Box>
          ))}
          {isArchiveOpen && archivedTotal > archived.length && (
            <Box paddingLeft={1}>
              <Text dimColor italic>+ {archivedTotal - archived.length} more</Text>
            </Box>
          )}
        </Box>,
      )}

      {legend}
      <Text dimColor>{footer(session.nextPollAt, updatedAt, now, session.found?.isCut)}</Text>
    </Box>
  )
}
