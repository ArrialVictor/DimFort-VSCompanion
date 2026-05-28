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
webview (`src/panel.ts`). There are no unit tests yet; the source of truth for
behavioural QA is `MANUAL_QA.md`.

## Style + scope

- Keep the extension thin. Server requests use the existing `vscode-languageclient`
  abstractions; webview rendering uses theme-aware CSS variables
  (`--vscode-foreground` / `--vscode-editor-…`) so the panel follows the colour
  scheme.
- Match the surface of the Nvim and Emacs companions where it makes sense — the
  three are intentionally feature-parallel. Cross-companion design notes live
  in the DimFort server repo's `docs/design/panel-info.md`.

## Publishing

Dual registry (see the server repo's release docs):

- **VS Marketplace**: `vsce publish` under the `arrialvictor` publisher.
- **Open VSX**: the `.vsix` is repackaged under publisher `dimfort` (the
  `arrialvictor` name was already taken there) and published via `ovsx publish`.
