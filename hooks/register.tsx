import { atom, read, update } from 'claude-code'
import type {
  ContextCategory,
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { Effort, View } from '../types'

// Bumped on each measurement and every minute, so the countdown redraws.
const tick = atom({ plugin: 'barra-usage-model', key: 'tick' } as const, 0)
// The one-line summary at the right of the prompt footer is always there, each
// item opening or closing its own meter in the band. Full: every meter open.
// Compact: only the ones in `expanded`; opening the last one returns to full.
// Every session starts compact, every meter closed.
const FULL: View = { isCompact: false, expanded: [] }
const COMPACT: View = { isCompact: true, expanded: [] }
const view = atom({ plugin: 'barra-usage-model', key: 'view' } as const, COMPACT)
// The effort the main loop's last model request asked for; null before one.
const effort = atom({ plugin: 'barra-usage-model', key: 'effort' } as const, null)

const EFFORT_NAMES: Record<string, string> = {
  low: 'baixo',
  medium: 'médio',
  high: 'alto',
  xhigh: 'muito alto',
  max: 'máximo',
}

// The model as /model shows it, then its effort when one is known.
export function describeModel(model: string, level: Effort | null): string {
  if (level === null) return model
  return `${model} · ${EFFORT_NAMES[level] ?? level}`
}

// Each meter's own colour in the compact summary.
const COMPACT_COLORS: Record<string, string> = {
  five_hour: 'green',
  seven_day: 'yellow',
  context: 'blue',
}

const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'gasto',
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'agora'
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function colorFor(percent: number): string {
  if (percent >= 90) return 'red'
  if (percent >= 70) return 'yellow'
  return 'green'
}

const MIN_BAR_WIDTH = 10
// The narrowest a meter's column gets before the meters wrap onto another
// row: room for the weekly caption, 'Ter 0:00 (Out 5), em 3d 4h (7d)'.
const MIN_COLUMN_WIDTH = 34
// The │ between meters and its two margins.
const SEPARATOR_WIDTH = 5
// ' 100.0%' after the bar, the widest a percent gets short of an overrun.
const PERCENT_WIDTH = 7
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

export function bar(percent: number, width: number): string {
  const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// Splits the row evenly between the meters; one cell is left spare at the edge.
export function columnWidth(columns: number, count: number): number {
  return Math.floor((columns - 1 - SEPARATOR_WIDTH * (count - 1)) / count)
}

// How many meters share a row: as many as keep each column wide enough.
export function perRow(columns: number, count: number): number {
  let n = count
  while (n > 1 && columnWidth(columns, n) < MIN_COLUMN_WIDTH) n -= 1
  return Math.max(n, 1)
}

export function barWidth(column: number): number {
  return Math.max(MIN_BAR_WIDTH, column - PERCENT_WIDTH)
}

// 24h local time; the weekday is added when the reset is not today, and the
// date too when `withDate` (the weekly window).
export function formatResetAt(resetsAt: number, now: number, withDate = false): string {
  const at = new Date(resetsAt)
  const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`
  return at.toDateString() === new Date(now).toDateString()
    ? time
    : `${WEEKDAYS[at.getDay()]} ${time}${withDate ? ` (${MONTHS[at.getMonth()]} ${at.getDate()})` : ''}`
}

export function describeReset(limit: SessionRateLimit, now: number): string {
  const label = `(${LABELS[limit.kind] ?? limit.kind})`
  if (!limit.resetsAt) return label
  const resetsAt = Date.parse(limit.resetsAt)
  return `${formatResetAt(resetsAt, now, limit.kind !== 'five_hour')}, em ${formatRemaining(resetsAt - now)} ${label}`
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

// Tokens in the window, of its size, and what is left.
export function describeContext(context: SessionContextUsage): string {
  const tokens = context.tokens ?? 0
  const left = Math.max(context.window - tokens, 0)
  return `${formatTokens(tokens)}/${formatTokens(context.window)}, livre ${formatTokens(left)} (ctx)`
}

// One run of cells in a bar, drawn in a theme colour or dim when free.
type Segment = { color?: string; cells: number; char: string }
type LegendEntry = { color: string; label: string }

type Meter = {
  key: string
  // What the compact summary puts before the percent: 5h, 7d, or nothing.
  label: string
  percent: number
  caption: string
  // The context window's categories, when the engine broke it down.
  categories?: ContextCategory[]
}

const SHORT_NAMES: Record<string, string> = {
  Messages: 'msgs',
  'System tools': 'tools',
  'MCP tools': 'mcp',
  Skills: 'skills',
  'System prompt': 'prompt',
  'Memory files': 'memória',
  'Custom agents': 'agents',
}

// Splits `width` cells between the categories by their tokens, as /context's
// grid does: each used category gets at least one cell so a small one still
// shows, taken from the free space; the compaction buffer sits at the end.
export function segments(categories: ContextCategory[], width: number): Segment[] {
  const shown = categories.filter(c => c.kind !== 'deferred' && c.tokens > 0)
  const total = shown.reduce((sum, c) => sum + c.tokens, 0)
  if (total === 0) return [{ cells: width, char: '░' }]

  const exact = shown.map(c => (c.tokens / total) * width)
  const cells = exact.map(Math.floor)
  let spare = width - cells.reduce((sum, n) => sum + n, 0)
  const byRemainder = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest)
  for (const { i } of byRemainder) {
    if (spare === 0) break
    cells[i] = (cells[i] ?? 0) + 1
    spare -= 1
  }
  const free = shown.findIndex(c => c.kind === 'free')
  shown.forEach((c, i) => {
    if (c.kind === 'used' && cells[i] === 0 && free >= 0 && (cells[free] ?? 0) > 0) {
      cells[i] = 1
      cells[free] = (cells[free] ?? 0) - 1
    }
  })

  const order = (c: ContextCategory) => (c.kind === 'used' ? 0 : c.kind === 'free' ? 1 : 2)
  return shown
    .map((c, i) => ({ c, cells: cells[i] ?? 0 }))
    .sort((a, b) => order(a.c) - order(b.c))
    .filter(({ cells }) => cells > 0)
    .map(({ c, cells }) =>
      c.kind === 'used'
        ? { color: c.color, cells, char: '█' }
        : c.kind === 'buffer'
          ? { cells, char: '▒' }
          : { cells, char: '░' },
    )
}

// The used categories, largest first, so a narrow column drops the smallest.
export function legend(categories: ContextCategory[]): LegendEntry[] {
  return categories
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map(c => ({ color: c.color, label: SHORT_NAMES[c.name] ?? c.name.toLowerCase() }))
}

export function meters(
  rateLimits: SessionRateLimit[],
  context: SessionContextUsage,
  now: number,
): Meter[] {
  const limits: Meter[] = rateLimits.map(limit => ({
    key: limit.kind,
    label: LABELS[limit.kind] ?? limit.kind,
    percent: limit.percentUsed,
    caption: describeReset(limit, now),
  }))
  if (context.percent === undefined) return limits
  return [
    ...limits,
    {
      key: 'context',
      label: '',
      percent: context.percent,
      caption: describeContext(context),
      categories: context.breakdown?.categories,
    },
  ]
}

function compactLabel(meter: Meter): string {
  return meter.label ? `${meter.label} ${meter.percent}%` : `${meter.percent}%`
}

async function setView($: EngineInterface, next: View): Promise<void> {
  await update($, view, () => next)
}

export function isOpen(current: View, key: string): boolean {
  return !current.isCompact || current.expanded.includes(key)
}

// Opens or closes one meter; all of them open is the full view.
export function toggle(current: View, key: string, keys: string[]): View {
  const open = keys.filter(k => isOpen(current, k))
  const expanded = open.includes(key) ? open.filter(k => k !== key) : [...open, key]
  return keys.every(k => expanded.includes(k)) ? FULL : { isCompact: true, expanded }
}

async function load($: EngineInterface): Promise<Meter[]> {
  const { rateLimits, context } = await $.session.usage({ breakdown: 'summary' })
  return meters(rateLimits, context, await $.clock.now())
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(60_000, () => {
      void update($, tick, n => n + 1)
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') || e.changed.includes('context')) {
      await update($, tick, n => n + 1)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const level = e.effort === undefined ? null : String(e.effort)
      if (level !== (await read($, effort))) await update($, effort, () => level)
    }
    return yield* next(e)
  })

  // The summary, at the right of the footer under the prompt, and the model
  // and effort beneath it, both starting at the first dot; the engine's own
  // mode labels stay in front of them. An item whose meter is open in the band
  // has a filled dot and full-strength text; a closed one a hollow dot, dim.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    await read($, tick)
    const current = await read($, view)

    const all = await load($)
    if (all.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const keys = all.map(m => m.key)
    const model = describeModel(await $.session.model(), await read($, effort))

    return (
      <Box paddingRight={1}>
        {e.props.modes.length > 0 ? (
          <Text dimColor>{`${e.props.modes.join(' & ')}  ·  `}</Text>
        ) : null}
        <Box flexDirection="column">
          <Box>
            {all.map((meter, i) => (
              <Box key={meter.key} marginLeft={i > 0 ? 2 : 0}>
                <Text color={COMPACT_COLORS[meter.key] ?? 'gray'}>
                  {isOpen(current, meter.key) ? '● ' : '○ '}
                </Text>
                <Button
                  key={`compact-${meter.key}`}
                  label={compactLabel(meter)}
                  plain
                  dimColor={!isOpen(current, meter.key)}
                  onPress={() => setView($, toggle(current, meter.key, keys))}
                />
              </Box>
            ))}
          </Box>
          <Text dimColor>{model}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, tick)
    if (e.props.hasSurvey) return next(e)

    const current = await read($, view)
    const all = (await load($)).filter(m => isOpen(current, m.key))
    if (all.length === 0) return next(e)

    const columns = e.props.bodyColumns
    const n = perRow(columns, all.length)
    const rows: Meter[][] = []
    for (let i = 0; i < all.length; i += n) rows.push(all.slice(i, i + n))
    const column = columnWidth(columns, n)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = barWidth(column)

    const drawBar = (meter: Meter) =>
      meter.categories ? (
        segments(meter.categories, width).map((segment, i) =>
          segment.color ? (
            <Text key={`s${i}`} color={segment.color}>
              {segment.char.repeat(segment.cells)}
            </Text>
          ) : (
            <Text key={`s${i}`} dimColor>
              {segment.char.repeat(segment.cells)}
            </Text>
          ),
        )
      ) : (
        <Text color={colorFor(meter.percent)}>{bar(meter.percent, width)}</Text>
      )

    // Meters sit side by side while they fit, wrapping onto more rows when the
    // terminal is narrow; each is a column: the bar on top, its caption beneath.
    // The compactar button sits above them at the right, a blank line between.
    return (
      <Box flexDirection="column">
        <Box justifyContent="flex-end">
          <Button
            key="compact"
            label="[compactar]"
            plain
            onPress={() => setView($, COMPACT)}
          />
        </Box>
        {rows.map((row, r) => {
          // The separators run the height of the row's tallest meter.
          const height = row.some(m => m.categories) ? 3 : 2
          return (
            <Box key={`row-${r}`} marginTop={1}>
              {row.map((meter, i) => (
                <Box key={meter.key}>
                  {i > 0 ? (
                    <Box flexDirection="column" marginLeft={2} marginRight={2}>
                      {Array.from({ length: height }, (_, k) => (
                        <Text key={`b${k}`} dimColor>
                          │
                        </Text>
                      ))}
                    </Box>
                  ) : null}
                  <Box flexDirection="column" width={column}>
                    <Text>
                      {drawBar(meter)}
                      {` ${meter.percent}%`}
                    </Text>
                    <Text dimColor>{meter.caption}</Text>
                    {meter.categories ? (
                      <Text wrap="truncate-end">
                        {legend(meter.categories).map((entry, k) => (
                          <Text key={entry.label}>
                            {k > 0 ? ' ' : ''}
                            <Text color={entry.color}>■</Text>
                            <Text dimColor>{` ${entry.label}`}</Text>
                          </Text>
                        ))}
                      </Text>
                    ) : null}
                  </Box>
                </Box>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
