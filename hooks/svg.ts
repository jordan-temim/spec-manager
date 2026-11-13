// The palette and what the desktop draws as SVG: bars, step dots, the stepper, the wordmark

import type { StepState } from './model'
import type { Change, Progress, Turn } from '../types'

export const BAR_W = 60
export const BAR_H = 6
// Palette, shared with live-review: terracotta for the AI (Claude's colour), blue for you
// (as Claude's own design system splits them), meadow green for the spec: here the tasks
// checked off against it, in live-review a drift from it. A warm and a cool actor told
// apart at a glance, and a third hue far from both; mid tones, readable on both the light
// and the dark theme
export const CLAY = '#d97757' // the AI: Claude's terracotta
export const BLUE = '#378ADD' // you
export const GREEN = '#5fa83a' // the spec: progress bars, a card's frame under the pointer, "spec" in the logo
export const THREAD = '#b4b2a9' // the wordmark's thread between its steps
export const MUTED = '#8f8d86' // done steps, labels of upcoming steps: only the current step is coloured
export const WASH = '#88878010' // a light see-through grey behind frames and cards, on the desktop
export const TRACK = 'rgba(128,128,128,0.35)'
// Upcoming steps: a pale fill, and a dark grey outline that keeps them visible on a white pane
export const TODO_FILL = 'rgba(128,128,128,0.22)'
export const TODO_STROKE = '#6e6c66'
export const turnColor = (turn: Turn) => (turn === 'you' ? BLUE : CLAY)

// The stepper in dots, for a module's card, one per step (six with the spec-driven
// documents): done grey, current in the actor's colour, upcoming outlined
export const DOT = 8
export const DOT_GAP = 3
export const dotsWidth = (total: number) => Math.max(0, total * (DOT + DOT_GAP) - DOT_GAP)
export const dotsSvg = (current: number, total: number, currentFill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${dotsWidth(total)}" height="${DOT}" viewBox="0 0 ${dotsWidth(total)} ${DOT}">` +
  Array.from({ length: total }, (_, i) => i)
    .map(i => {
      const x = i * (DOT + DOT_GAP)
      if (i < current) return `<rect x="${x}" width="${DOT}" height="${DOT}" rx="2" fill="${MUTED}"/>`
      if (i === current) return `<rect x="${x}" width="${DOT}" height="${DOT}" rx="2" fill="${currentFill}"/>`
      return `<rect x="${x + 0.5}" y="0.5" width="${DOT - 1}" height="${DOT - 1}" rx="2" fill="none" stroke="${TODO_STROKE}"/>`
    })
    .join('') +
  `</svg>`
// The wordmark: a fixed SVG, larger and heavier than text can be (an image cannot follow
// the theme, so its colours read on both). A change's life told in the pane's colours:
// a step done in grey, one the AI took in terracotta, the open one waiting on you in
// blue; then "spec" in the spec's green and "manager" in the neutral grey
export const BRAND_W = 176
export const BRAND_H = 28
export const BRAND_SANS = "system-ui,-apple-system,'Segoe UI','Inter','Noto Sans','DejaVu Sans',sans-serif"
export const brandSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${BRAND_W}" height="${BRAND_H}" viewBox="0 0 ${BRAND_W} ${BRAND_H}">` +
  // The thread stops at the open step's edge; the words in one text, spaced by the font
  `<line x1="5" y1="14" x2="31" y2="14" stroke="${THREAD}" stroke-width="2"/>` +
  `<circle cx="5" cy="14" r="4" fill="${MUTED}"/><circle cx="21" cy="14" r="4" fill="${CLAY}"/>` +
  `<circle cx="37" cy="14" r="5" fill="none" stroke="${BLUE}" stroke-width="2.4"/>` +
  `<text x="50" y="20" font-family="${BRAND_SANS}" font-size="18" letter-spacing="-0.3">` +
  `<tspan font-weight="800" fill="${GREEN}">spec</tspan><tspan dx="5" font-weight="500" fill="${MUTED}">manager</tspan></text></svg>`
// A step's number on the help page, white in a round of the colour of who takes it
export const NUMBER_D = 20
export const numberSvg = (n: number, fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${NUMBER_D}" height="${NUMBER_D}" viewBox="0 0 ${NUMBER_D} ${NUMBER_D}">` +
  `<circle cx="10" cy="10" r="10" fill="${fill}"/>` +
  `<text x="10" y="14" text-anchor="middle" font-family="${BRAND_SANS}" font-size="12" font-weight="700" fill="#ffffff">${n}</text></svg>`

// The actor colours are the reader's: someone else's change stays grey
export const actorColor = (change: Change) => (change.isMine ? turnColor(change.turn) : MUTED)

// Drawn in real pixels: the desktop pane's font gives text cells no fixed width
export const barSvg = ({ done, total }: Progress) => {
  // Within the bar, whatever counts openspec gives
  const ratio = done / total
  const fill = Number.isFinite(ratio) ? Math.min(BAR_W, Math.max(0, ratio * BAR_W)) : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${BAR_H}" viewBox="0 0 ${BAR_W} ${BAR_H}">` +
    `<clipPath id="r"><rect width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${BAR_W}" height="${BAR_H}" fill="${TRACK}"/>` +
    `<rect width="${fill.toFixed(1)}" height="${BAR_H}" fill="${GREEN}"/></g></svg>`
  )
}

// A hairline the width of the pane: stretched by the slot, one pixel high
export const RULE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1" viewBox="0 0 2000 1" preserveAspectRatio="none">` +
  `<rect width="2000" height="1" fill="${TRACK}"/></svg>`

// Text written into an SVG: &, < and > would break the picture
export const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const TAB_W = 70
export const TAB_H = 22
export const TAB_TIP = 8
// The current step has no fill of its own: it takes the colour of whoever holds it
export const TAB_STYLE: Record<StepState, { fill?: string; text: string; weight: number }> = {
  done: { fill: MUTED, text: '#ffffff', weight: 600 },
  current: { text: '#ffffff', weight: 700 },
  todo: { fill: TODO_FILL, text: MUTED, weight: 600 },
}

export const SHINE_W = 28
export const SHINE_S = 6

// Chevron tabs, each notched into the one before it. The current tab carries a light
// band sweeping left to right (CSS, off under reduced motion), drawn under the label
export const stepperWidth = (count: number) => count * (TAB_W + 2) + TAB_TIP

export const stepperSvg = (list: { name: string; state: StepState; isSkipped?: boolean }[], currentFill: string) => {
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
    // The first tab's left edge is the picture's: inset too, or half its outline is cut
    const left = i === 0 ? x + inset : x
    const points = [
      `${left},${inset}`,
      `${x + TAB_W},${inset}`,
      `${x + TAB_W + TAB_TIP - inset},${TAB_H / 2}`,
      `${x + TAB_W},${TAB_H - inset}`,
      `${left},${TAB_H - inset}`,
      i === 0 ? `${left},${TAB_H / 2}` : notch,
    ]
    const outline = step.state === 'todo' ? ` stroke="${TODO_STROKE}" stroke-width="1"` : ''
    // A skipped document reads "– specs": passed, without a file
    const label = `${step.state === 'done' ? (step.isSkipped ? '– ' : '✓ ') : ''}${xml(step.name)}`
    if (step.state === 'current') {
      const from = x - SHINE_W
      const to = x + TAB_W + TAB_TIP
      shine +=
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
