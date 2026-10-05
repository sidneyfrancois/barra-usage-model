import { expect, mock, test } from 'claude-code/testing'

import type { ContextCategory } from 'claude-code'

import {
  bar,
  barWidth,
  columnWidth,
  describeContext,
  describeModel,
  formatResetAt,
  legend,
  perRow,
  segments,
  toggle,
} from '../hooks/register'

const row = (name: string, tokens: number, color: string, kind: ContextCategory['kind']) =>
  ({ name, tokens, color, kind, isDeferred: kind === 'deferred' }) satisfies ContextCategory

const CATEGORIES = [
  row('System prompt', 4_000, 'claude', 'used'),
  row('System tools', 25_000, 'inactive', 'used'),
  row('MCP tools', 700, 'success', 'used'),
  row('Messages', 70_000, 'permission', 'used'),
  row('MCP tools (deferred)', 13_000, 'inactive', 'deferred'),
  row('Free space', 867_300, 'promptBorder', 'free'),
  row('Autocompact buffer', 33_000, 'inactive', 'buffer'),
]

test('the context bar is split by category, small ones still showing', () => {
  const parts = segments(CATEGORIES, 50)
  expect(parts.reduce((sum, p) => sum + p.cells, 0)).toBe(50)
  expect(parts.map(p => p.color ?? p.char)).toEqual([
    'claude', 'inactive', 'success', 'permission', '░', '▒',
  ])
  expect(parts.find(p => p.color === 'success')?.cells).toBe(1)
  expect(legend(CATEGORIES).map(e => e.label)).toEqual(['msgs', 'tools', 'prompt', 'mcp'])
})

test('toggling opens and closes one meter; all open is the full view', () => {
  const keys = ['five_hour', 'seven_day', 'context']
  const compact = { isCompact: true, expanded: [] }
  expect(toggle(compact, 'context', keys)).toEqual({ isCompact: true, expanded: ['context'] })
  expect(toggle({ isCompact: true, expanded: ['context'] }, 'context', keys)).toEqual(compact)
  expect(toggle({ isCompact: false, expanded: [] }, 'context', keys)).toEqual({
    isCompact: true,
    expanded: ['five_hour', 'seven_day'],
  })
  expect(toggle({ isCompact: true, expanded: ['context', 'five_hour'] }, 'seven_day', keys)).toEqual({
    isCompact: false,
    expanded: [],
  })
})

test('the model line names the effort in Portuguese once one is known', () => {
  expect(describeModel('Opus 5.5', null)).toBe('Opus 5.5')
  expect(describeModel('Opus 5.5', 'high')).toBe('Opus 5.5 · alto')
  expect(describeModel('Opus 5.5', 'xhigh')).toBe('Opus 5.5 · muito alto')
  expect(describeModel('Opus 5.5', '3')).toBe('Opus 5.5 · 3')
})

test('the bars split the row and fill in proportion', () => {
  const column = columnWidth(120, 2)
  expect(column).toBe(57)
  expect(barWidth(column)).toBe(50)
  expect(barWidth(columnWidth(40, 2))).toBe(10)
  expect(bar(50, 20)).toBe('██████████░░░░░░░░░░')
  expect(bar(120, 4)).toBe('████')
  expect(perRow(120, 3)).toBe(3)
  expect(perRow(90, 3)).toBe(2)
  expect(perRow(40, 3)).toBe(1)
  const late = Date.parse('2026-10-04T23:00:00-03:00')
  const nextDay = Date.parse('2026-10-05T03:30:00-03:00')
  expect(formatResetAt(nextDay, late)).toBe('Seg 3:30')
  expect(formatResetAt(nextDay, late, true)).toBe('Seg 3:30 (Out 5)')
})

const NOW = Date.parse('2026-10-04T12:00:00Z')
const FIVE_HOUR = '2026-10-04T14:15:00Z'

// Local 24h time, as the band draws it.
function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('the context caption reads tokens used, the window and what is left', () => {
  expect(describeContext({ window: 1_000_000, tokens: 112_000, percent: 11 })).toBe(
    '112k/1M, livre 888k (ctx)',
  )
  expect(describeContext({ window: 200_000, tokens: 1_500, percent: 1 })).toBe(
    '2k/200k, livre 199k (ctx)',
  )
})

test('shows each window with its percent and time to reset', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: {
    startedAt: NOW,
    context: {
      window: 1_000_000,
      tokens: 112_000,
      percent: 11,
      breakdown: { categories: CATEGORIES } as never,
    },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: FIVE_HOUR },
      { kind: 'seven_day', percentUsed: 91.5, resetsAt: '2026-10-07T16:00:00Z' },
    ],
  } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'barra-usage-model',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, bodyColumns: 135 } as never,
      viewport: { columns: 140, rows: 40 },
    })
    expect(await ui.find({ type: 'Text', text: /^█+░+ 42%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^█+░+▒+ 11%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^■ msgs ■ tools/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '112k/1M, livre 888k (ctx)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `${hhmm(FIVE_HOUR)}, em 2h 15m (5h)` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^█+░+ 91\.5%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^(Dom|Seg|Ter|Qua|Qui|Sex|Sáb) \d{1,2}:\d\d \(Out 7\), em 3d 4h \(7d\)$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('draws nothing of its own without rate-limit readings', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine band')
  })
  on('session.usage', () => ({ value: {
    startedAt: NOW,
    context: { window: 200_000 },
    rateLimits: [],
  } }))

  const ui = await $.ui.mount({
    plugin: 'barra-usage-model',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false } as never,
  })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /, em / })).toBeUndefined()
  await ui.unmount()
})

test('a compact item opens its meter, the rest stay folded until opened', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine')
  })
  on('session.usage', () => ({ value: {
    startedAt: NOW,
    context: { window: 1_000_000, tokens: 112_000, percent: 11 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: FIVE_HOUR },
      { kind: 'seven_day', percentUsed: 91.5, resetsAt: '2026-10-07T16:00:00Z' },
    ],
  } }))
  on('session.model', () => ({ value: 'Opus 5.5' }))
  const band = () =>
    $.ui.mount({
      plugin: 'barra-usage-model',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, bodyColumns: 135 } as never,
      viewport: { columns: 140, rows: 40 },
    })
  const footer = () =>
    $.ui.mount({
      plugin: 'barra-usage-model',
      surface: 'terminal',
      component: 'SessionMode',
      props: { modes: ['focus'] },
    })
  const shown = async () => {
    const ui = await band()
    const found = {
      fiveHour: (await ui.find({ type: 'Text', text: /^█+░+ 42%$/ })) !== undefined,
      sevenDay: (await ui.find({ type: 'Text', text: /^█+░+ 91\.5%$/ })) !== undefined,
      context: (await ui.find({ type: 'Text', text: /^█+░+ 11%$/ })) !== undefined,
    }
    await ui.unmount()
    return found
  }
  const pressInFooter = async (key: string) => {
    const ui = await footer()
    await ui.press({ key })
    await ui.unmount()
  }

  // Compact to start: the band is the engine's own, the summary under the prompt.
  let ui = await band()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()

  ui = await footer()
  expect(await ui.find({ type: 'Text', text: /^focus/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  for (const label of ['5h 42%', '7d 91.5%', '11%']) {
    expect(await ui.find({ type: 'Button', label })).toBeDefined()
  }
  await ui.unmount()

  await pressInFooter('compact-five_hour')
  expect(await shown()).toEqual({ fiveHour: true, sevenDay: false, context: false })
  // The open one is the highlighted button; the others stay dim.
  ui = await footer()
  expect(await ui.find({ type: 'Button', label: '5h 42%' })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: '7d 91.5%' })).toBeDefined()
  await ui.unmount()

  await pressInFooter('compact-seven_day')
  expect(await shown()).toEqual({ fiveHour: true, sevenDay: true, context: false })

  // Pressed again, an open one closes.
  await pressInFooter('compact-five_hour')
  expect(await shown()).toEqual({ fiveHour: false, sevenDay: true, context: false })

  // The last two open make the full view; the summary stays.
  await pressInFooter('compact-five_hour')
  await pressInFooter('compact-context')
  expect(await shown()).toEqual({ fiveHour: true, sevenDay: true, context: true })
  ui = await footer()
  expect(await ui.find({ type: 'Button', label: '5h 42%' })).toBeDefined()
  await ui.unmount()

  // From the full view, a press closes that one meter.
  await pressInFooter('compact-context')
  expect(await shown()).toEqual({ fiveHour: true, sevenDay: true, context: false })

  // compactar closes every meter at once.
  await pressInFooter('compact-context')
  ui = await band()
  expect(await ui.find({ type: 'Button', label: '[compactar]' })).toBeDefined()
  await ui.press({ key: 'compact' })
  await ui.unmount()
  expect(await shown()).toEqual({ fiveHour: false, sevenDay: false, context: false })
})
