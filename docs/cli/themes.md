# Themes

The TUI supports five built-in color schemes:

| Name | Notes |
| --- | --- |
| `dark` (default) | High-contrast dark background. |
| `light` | High-contrast light background. |
| `solarized` | Classic Solarized palette. |
| `monokai` | Vibrant pastel accents. |
| `nord` | Cool blues/greys. |

## Selecting

```bash
codexrev --theme solarized
```

Or persistently, in `~/.codexrev/settings.json`:

```jsonc
{ "theme": "nord" }
```

## Custom themes

A future release will support per-user theme files. For now, the five built-in choices are exhaustive. If you need a custom palette today, edit `packages/cli/src/ui/theme.ts` and rebuild the CLI bundle (`npm run build`).
