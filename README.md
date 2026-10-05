# barra-usage-model

A Claude Code mod that shows your usage at a glance:

- **Above the prompt:** usage bars for the 5-hour window, the weekly window and the context window. Each bar shows its percentage and when it resets. The context bar is split by category, the same way `/context` splits it.
- **Below the prompt:** a compact summary of the same meters, plus the current model and effort level.

Click an item in the summary to open or close its bar. When every bar is closed, you get the compact view. Opening them all again returns to the full view. The mod remembers your choice between sessions.

Labels are in Portuguese (pt-BR).

## Install

Clone the repo, then point Claude Code at it as a plugin:

```sh
git clone https://github.com/sidneyfrancois/barra-usage-model.git
claude --plugin-dir ./barra-usage-model
```

## Layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/plugin.json` | Plugin manifest |
| `hooks/register.tsx` | The mod: the meters, the band and the summary |
| `types/index.d.ts` | The plugin's state types |
| `tests/` | Unit tests for formatting and layout |

`.claude-plugin/types/` holds the type definitions that Claude Code generates. It is not committed.

## License

[MIT](LICENSE)
