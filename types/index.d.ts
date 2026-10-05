export type Tick = number

// An effort level as the model request names it: low ... max, or a number.
export type Effort = string

// Which meters show: all in the band, or the compact summary with the ones
// opened from it.
export type View = { isCompact: boolean; expanded: string[] }

declare module 'claude-code' {
  interface PluginState {
    'barra-usage-model': { tick: Tick; view: View; effort: Effort | null }
  }
}
