# DimFort — VSCode extension

![preview](https://raw.githubusercontent.com/ArrialVictor/DimFort-VSCompanion/main/social_preview.png)

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/arrialvictor.dimfort-vscode?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=arrialvictor.dimfort-vscode)
[![Open VSX](https://img.shields.io/open-vsx/v/dimfort/dimfort-vscode?label=Open%20VSX)](https://open-vsx.org/extension/dimfort/dimfort-vscode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/ArrialVictor/DimFort-VSCompanion/blob/main/LICENSE)

VSCode client for [DimFort](https://github.com/ArrialVictor/DimFort) —
the dimensional-homogeneity checker for Fortran. Thin Language Server
Protocol client: spawns `dimfort lsp` and forwards your Fortran
sources to it; the server publishes diagnostics back, and VSCode
renders them as squiggles and entries in the Problems panel.

## Install

### 1. Install DimFort itself

The extension needs the `dimfort` binary on PATH. Install with
[pipx](https://pipx.pypa.io/) (recommended on Homebrew Python /
modern Linux distros where PEP 668 blocks `pip install`):

```bash
pipx install 'dimfort[lsp]'
dimfort --version
```

### 2. Install the extension

**VSCode** — from the Extensions panel, search "DimFort" and click
Install. Or from the command palette (`Cmd/Ctrl+P`):

```
ext install arrialvictor.dimfort-vscode
```

**VSCodium / Cursor / Theia / code-server** — from the Open VSX
gallery. Most of these clients have Open VSX as the default gallery;
search "DimFort" in the Extensions panel:

```
ext install dimfort.dimfort-vscode
```

**From `.vsix` (any client)** — for offline / air-gapped installs or
when a marketplace isn't reachable:

```bash
curl -L -o dimfort-vscode.vsix \
  https://github.com/ArrialVictor/DimFort-VSCompanion/releases/latest/download/dimfort-vscode.vsix
code --install-extension dimfort-vscode.vsix
```

Open any `.f90` file — DimFort lights up. Settings → search
`dimfort` to see toggle commands.

## Configuration

Settings (under **DimFort** in the Settings UI):

- `dimfort.executable` — path to the `dimfort` binary. Default is
  just `dimfort` (must be on `$PATH`). Override if the binary lives
  in a virtualenv: `/path/to/.venv/bin/dimfort`.
- `dimfort.trace.server` — set to `verbose` to see every LSP message
  in **Output → DimFort**. Useful for debugging.
- `dimfort.inlayHints.enabled`, `dimfort.completion.enabled`,
  `dimfort.codeActions.enabled`, `dimfort.gotoDefinition.enabled`,
  `dimfort.codeLens.enabled` — per-feature toggles. The palette also
  exposes them as `DimFort: Toggle …` commands.
- `dimfort.maxWorksetSize` — cap on the number of files in a single
  check pipeline (default 40). Restart the language server after
  changing.
- `dimfort.externalModules` — extra module names treated as
  external (no `U007` diagnostic when they're missing from the
  workspace). Extends the built-in allowlist.

## Develop locally

If you want to contribute or run from source rather than the
marketplace build:

```bash
git clone https://github.com/ArrialVictor/DimFort-VSCompanion.git
cd DimFort-VSCompanion
npm install
npm run compile
```

Then open the folder in VSCode and press <kbd>F5</kbd> — a second
window launches with your local build of the extension.

### Packaging a `.vsix`

Requires **Node ≥ 20.18** (older Node breaks `@vscode/vsce`'s
`undici` transitive dependency). On macOS:

```bash
brew install node@20
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
```

Then:

```bash
npm install --save-dev @vscode/vsce
npm run compile
npx vsce package --allow-missing-repository
```

You'll get a `dimfort-vscode-<version>.vsix`. Install with
`code --install-extension dimfort-vscode-<version>.vsix`.

## License

[MIT](https://github.com/ArrialVictor/DimFort-VSCompanion/blob/main/LICENSE).
