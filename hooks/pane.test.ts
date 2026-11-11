import { describe, expect, test } from 'claude-code/testing'

import { ago } from './pane'

describe('last activity', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const before = (ms: number) => new Date(now - ms).toISOString()
  const MIN = 60000

  test('says how long ago, in the largest whole unit', () => {
    expect(ago(before(5 * MIN), now)).toBe('5m ago')
    expect(ago(before(3 * 60 * MIN), now)).toBe('3h ago')
    expect(ago(before(2 * 24 * 60 * MIN), now)).toBe('2d ago')
  })

  test('at the edges between units', () => {
    expect(ago(before(30000), now)).toBe('just now')
    expect(ago(before(59000), now)).toBe('just now')
    expect(ago(before(MIN), now)).toBe('1m ago')
    expect(ago(before(59 * MIN), now)).toBe('59m ago')
    expect(ago(before(60 * MIN), now)).toBe('1h ago')
    expect(ago(before(23 * 60 * MIN), now)).toBe('23h ago')
    expect(ago(before(24 * 60 * MIN), now)).toBe('1d ago')
  })

  test('between two units, the whole one below: never rounded up', () => {
    expect(ago(before(119000), now)).toBe('1m ago')
    expect(ago(before(90 * MIN), now)).toBe('1h ago')
    expect(ago(before(47 * 60 * MIN), now)).toBe('1d ago')
  })

  test('a date ahead of the clock is just now, never a negative time', () => {
    expect(ago(before(-3 * MIN), now)).toBe('just now')
  })

  test('nothing for a date that does not parse', () => {
    expect(ago('not a date', now)).toBe('')
    expect(ago('', now)).toBe('')
  })
})
