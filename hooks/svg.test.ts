import { describe, expect, test } from 'claude-code/testing'

import { BAR_H, BAR_W, DOT, DOT_GAP, MUTED, TEAL, TODO_FILL, TODO_STROKE, VIOLET, barSvg, dotsSvg, dotsWidth, stepperSvg } from './svg'

describe('card dots', () => {
  const dots = (svg: string) => (svg.match(/<rect /g) ?? []).length

  test('one dot per step, whatever the schema gives', () => {
    expect(dots(dotsSvg(4, 6, VIOLET))).toBe(6)
    expect(dots(dotsSvg(1, 3, VIOLET))).toBe(3)
    // The current one filled with the actor's colour, at its place
    // Done before it in grey, to come after it outlined, neither in the actor's colour
    const [, done, current, upcoming] = dotsSvg(1, 3, VIOLET).split('<rect ')
    expect(current).toContain(`fill="${VIOLET}"`)
    expect(done).toContain(`fill="${MUTED}"`)
    expect(upcoming).toContain('fill="none"')
    expect(upcoming).toContain(`stroke="${TODO_STROKE}"`)
    expect(done + upcoming).not.toContain(VIOLET)
  })

  test('a current step outside the dots colours none of them', () => {
    // Past the last: all done, grey; before the first: all to come, outlined
    for (const svg of [dotsSvg(6, 6, VIOLET), dotsSvg(-1, 3, VIOLET)]) expect(svg).not.toContain(VIOLET)
    for (const dot of dotsSvg(6, 6, VIOLET).split('<rect ').slice(1)) expect(dot).toContain(`fill="${MUTED}"`)
    for (const dot of dotsSvg(-1, 3, VIOLET).split('<rect ').slice(1)) {
      expect(dot).toContain('fill="none"')
      expect(dot).toContain(`stroke="${TODO_STROKE}"`)
    }
    expect(dots(dotsSvg(6, 6, VIOLET))).toBe(6)
    expect(dots(dotsSvg(-1, 3, VIOLET))).toBe(3)
  })

  test('the dots take their width from their number, never below zero', () => {
    expect(dotsWidth(6)).toBe(6 * DOT + 5 * DOT_GAP)
    expect(dotsWidth(0)).toBe(0)
    expect(dotsWidth(-1)).toBe(0)
  })
})

describe('bar', () => {
  test('its filled part stays within the bar, whatever the counts', () => {
    const filled = (svg: string) => svg.match(new RegExp(`<rect width="([-\\d.]+)" height="${BAR_H}" fill="${TEAL}"`))?.[1]
    expect(filled(barSvg({ done: -2, total: 4 }))).toBe('0.0')
    expect(filled(barSvg({ done: 9, total: 4 }))).toBe(BAR_W.toFixed(1))
    expect(filled(barSvg({ done: 2, total: 4 }))).toBe((BAR_W / 2).toFixed(1))
    // No task at all, or a total left out: an empty bar, never Infinity or NaN
    expect(filled(barSvg({ done: 0, total: 0 }))).toBe('0.0')
    expect(filled(barSvg({ done: 2, total: 0 }))).toBe('0.0')
    expect(filled(barSvg({ done: 2, total: Number.NaN }))).toBe('0.0')
    // A count openspec left out: an empty bar, never width="NaN"
    expect(filled(barSvg({ done: Number.NaN, total: 4 }))).toBe('0.0')
    expect(filled(barSvg({ done: undefined as unknown as number, total: 4 }))).toBe('0.0')
  })
})

describe('stepper', () => {
  test("only the current step takes the actor's colour; done ones grey, upcoming ones outlined", () => {
    const steps = [
      { name: 'proposal', state: 'done' as const },
      { name: 'apply', state: 'current' as const },
      { name: 'archive', state: 'todo' as const },
    ]
    const tabs = stepperSvg(steps, VIOLET).split('<polygon ').slice(1)
    // The current step's clip path is a polygon too, in the defs before the tabs
    const [done, current, upcoming] = tabs.filter(tab => tab.includes(' fill='))
    expect(done).toContain(`fill="${MUTED}"`)
    expect(current).toContain(`fill="${VIOLET}"`)
    expect(upcoming).toContain(`fill="${TODO_FILL}"`)
    expect(upcoming).toContain(`stroke="${TODO_STROKE}"`)
    expect(done + upcoming).not.toContain(VIOLET)
  })

  test('with no current step, or none at all, a plain SVG with no actor colour', () => {
    const done = stepperSvg([{ name: 'proposal', state: 'done' }, { name: 'archive', state: 'done' }], VIOLET)
    const upcoming = stepperSvg([{ name: 'apply', state: 'todo' }, { name: 'archive', state: 'todo' }], VIOLET)
    const empty = stepperSvg([], VIOLET)
    for (const svg of [done, upcoming, empty, dotsSvg(0, 0, VIOLET)]) {
      expect(svg.startsWith('<svg ')).toBe(true)
      expect(svg.endsWith('</svg>')).toBe(true)
      expect(svg).not.toContain(VIOLET)
      // No shine without a current step, so nothing points at a clip path that is not there
      expect(svg).not.toContain('url(#cur')
    }
  })

  test('a step name is written into the SVG as text, not markup', () => {
    const svg = stepperSvg([{ name: 'a<b & c', state: 'current' }, { name: 'archive', state: 'todo' }], VIOLET)
    expect(svg).toContain('a&lt;b &amp; c')
    expect(svg).not.toContain('a<b')
  })
})
