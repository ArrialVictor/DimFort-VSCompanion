# Contributing to the DimFort VSCode companion

Thanks for considering a contribution. This extension is a **thin LSP client**
for [DimFort](https://github.com/ArrialVictor/DimFort) — behavioural changes
(diagnostics, annotation parsing, unit algebra, …) usually belong in the server
repo. The contribution surface here is the editor-side experience: the side
panel, hover, commands/settings, status line, packaging.

## Reporting issues

Open an issue using the **Bug report** template. The version block (DimFort
server + VSCode + companion + OS) and the **DimFort LSP** output channel trace
are the most useful things to include — most bugs are routed to the server
repo on the basis of that trace.

## Development setup

```bash
git clone https://github.com/ArrialVictor/DimFort-VSCompanion.git
cd DimFort-VSCompanion
npm install
```

Open the folder in VSCode and press **F5** to launch the Extension Development
Host with the local extension loaded. Point its `dimfort.executable` setting at
your local DimFort server (e.g. the `.venv/bin/dimfort` of a checkout) to test
against unreleased server changes.

## Type-checking + packaging

```bash
npm run compile                # tsc --noEmit (no JS output, just type-check)
npx vsce package               # build a .vsix you can `code --install-extension` from
```

The extension is a single TypeScript file (`src/extension.ts`) plus the panel
webview (`src/panel.ts`). There are no unit tests in this repo. Behavioural QA
is split:

- **Server-side wire behaviour** (diagnostic codes, hover / panel / inlay /
  workspace / coverage / code-action / completion payloads) is verified by the
  DimFort LSP integration test suite at `tests/lsp_integration/` in the server
  repo. Changes that don't affect rendering can rely on that suite alone.
- **Display behaviour** (squiggle / Problems-panel rendering, hover popup, side
  panel multi-view shell, title-bar action icons, status-bar Coverage item,
  Output channel `DimFort: Status`, Settings UI integration, code-action
  lightbulb) is covered by `MANUAL_QA.md`, run before each release.

### Test-only state hooks

Some extension state isn't reachable via VS Code's public API — the
WebviewViewProvider panel content, `TextEditor.setDecorations` state.
For the internal QA harness to inspect these, the extension exposes
two commands **only when the `DIMFORT_TEST_HOOKS=1` environment
variable is set at extension-host launch time**:

- `dimfort._test.getPanelState` — returns the coordinator's latest
  broadcast (`{ kind: "data" | "empty", payload?, reason?, at,
  sortMode, unitDisplay }`).
- `dimfort._test.getCoverageState(uri)` — returns the current
  coverage mode plus the last painted per-tier line numbers for the
  given editor URI.

Without the env var, the commands are not registered — end users
never see them. They're not listed in `package.json contributes.commands`
either, so they don't appear in the Command Palette regardless.

## Style + scope

- Keep the extension thin. Server requests use the existing `vscode-languageclient`
  abstractions; webview rendering uses theme-aware CSS variables
  (`--vscode-foreground` / `--vscode-editor-…`) so the panel follows the colour
  scheme.
- Match the surface of the Nvim and Emacs companions where it makes sense — the
  three are intentionally feature-parallel. Cross-companion design notes live
  in the DimFort server repo's `docs/design/shipped/panel-info.md`.

## Publishing

Dual registry (see the server repo's release docs):

- **VS Marketplace**: `vsce publish` under the `arrialvictor` publisher.
- **Open VSX**: the `.vsix` is repackaged under publisher `dimfort` (the
  `arrialvictor` name was already taken there) and published via `ovsx publish`.
