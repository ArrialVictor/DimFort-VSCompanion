# Changelog

All notable changes to the DimFort VSCode extension are documented
here. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

This extension is a thin LSP client for [DimFort](https://github.com/ArrialVictor/DimFort);
behavioural changes mostly land in the DimFort server itself. Entries
below cover client-side changes only (settings, defaults, palette
commands, packaging).

## [Unreleased]

### Added

- **Imports panel section** — variables a `use` clause brings into the
  cursor's scope (usable there but not declared in an enclosing scope, so
  the Scope tables don't cover them). Grouped by source module, each row
  shows the imported name + its unit and navigates **cross-file** to where
  the variable (and its `@unit{}`) is declared. Scoped like Fortran
  visibility — module-level `use` shows for any cursor in the module,
  routine-level only in that routine; a local declaration shadows the
  import. Driven by the server's new `panelInfo.imports` field.
- **Scope filter** — a search box at the top of the panel's **Scope** section
  filters the listed variables by name or unit (case-insensitive). Purely
  client-side (no server round-trip); the query persists across cursor-move
  re-renders. Handy in long routines with many declarations.
- **Scale-checking toggle** — a new `dimfort.scale.mode` setting
  (`auto` / `on` / `off`, default `auto`) and a **DimFort: Cycle Scale
  Checking** command. `auto` defers to the project's `.dimfort.toml`
  `[scale] enabled`; `on`/`off` force the magnitude layer (S001/S002) for
  the editor session, overriding the toml — so scale can be flipped without
  editing a config file.
- **Unit completion auto-pops after "Add @unit{}"** — the quick-fix snippet
  leaves the cursor between the braces and now triggers the suggestion list
  immediately (`editor.action.triggerSuggest`), so unit names appear without
  a manual Ctrl+Space.

### Changed

- Panel **Diagnostics** glyph for info/hint severities is now **🔵** (was ℹ️),
  so the severity family is one coloured-circle vocabulary: 🔴 error / 🟡
  warning / 🔵 info (e.g. the new `P001` "unparsed region" marker).

- **Interactions panel section** (driven by the server's `dimfort/interactions`
  request): for the symbol under the cursor, every site that reads or writes it
  across the workset — grouped **Declaration / Write / Read / Undetermined
  read**, each with the unit it implies — plus the `X001` conflicting-claims
  finding. Rows navigate cross-file.
- **Diagnostics and Actions panel sections** alongside Expression and Scope; all
  sections are now always present (placeholder when empty).

### Changed

- **Side panel now open by default** (`dimfort.panel.enabled` defaults to
  `true`) — unified with the Nvim/Emacs companions for a consistent out-of-box
  surface.
- **Hover settings collapsed into one `dimfort.hover`** enum
  (`disabled` / `short` / `detailed`, default `short`), replacing
  `dimfort.trace.enabled` and the three `dimfort.hover.*` per-surface
  settings. `DimFort: Cycle Hover Verbosity` replaces the trace toggle.
  The side panel is unaffected — always detailed, governed only by
  whether it is open.

## [0.1.5] — 2026-05-22

### Changed

- **Activity-bar icon** — a purpose-built `[m²]` glyph
  (`media/dimfort-activity.png`): square brackets — the "dimension of"
  operator — framing a base unit, echoing the logo's `[m·s⁻²]`. Masks
  and tints cleanly in light and dark themes, replacing the washed-out
  full-colour logo.
- **Scope panel** — a third marker, 🔴, for a variable whose `@unit{}`
  annotation is present but fails to parse, distinct from 🟢 (valid)
  and 🟡 (no annotation).
- **Code lens removed** — the feature carried no real value; the
  `dimfort.codeLens.enabled` setting and the `DimFort: Toggle Code Lens`
  command are gone.
- **`dimfort.panel.enabled` now defaults to `false`** — the side panel
  no longer opens automatically on activation; open it from the
  activity-bar icon when you want it. Set the option to `true` to
  restore auto-reveal.

## [0.1.4] — 2026-05-22

### Added

- **Side panel** — a webview view in a new DimFort activity-bar
  container, fed by the `dimfort/panelInfo` LSP request and following
  the cursor (debounced). Two sections:
  - **Expression** — the unit-algebra tree for the expression under the
    cursor, units and 🟢/🟡/🔴 markers aligned in columns.
  - **Scope** — the declarations of every enclosing scope (subroutine /
    function / module / program), stacked outermost-first and indented
    by nesting, each variable marked 🟢 (annotated) / 🟡 (unannotated).
  - `dimfort.panel.enabled` (default `true`) reveals it on activation;
    `dimfort.panel.debounceMs` tunes the cursor-follow refresh.
  - `DimFort: Show Side Panel` command focuses it.

### Changed

- **Default UX stance** matches the other companions: inlay hints
  default **off** (redundant beside the panel/hover), detailed hover
  (`dimfort.trace.enabled`) defaults **on**, and the content-hash
  cache (`dimfort.cache.mode`) defaults to **read-write**.

## [0.1.3] — 2026-05-22

### Added

- **`dimfort.cache.mode` setting** — content-hash cache mode for
  the workspace check: `off` (default), `read-only`, or
  `read-write`. With `read-write`, every file's check phase is
  cached; warm re-runs replay cached diagnostics for unchanged
  files. LMDZ-scale: ~33 s cold → ~20 s warm. Settings UI exposes
  it under **DimFort: Cache: Mode**. Full invalidation triggers
  documented at
  [DimFort/docs/usage.md#content-hash-cache](https://github.com/ArrialVictor/DimFort/blob/main/docs/usage.md#content-hash-cache).
- **`dimfort.cache.dir` setting** — optional override for the
  cache directory. Empty (default) means `.dimfort-cache/` under
  the first workspace folder.
- **`DimFort: Toggle Content-Hash Cache` command** — palette
  command that flips `cache.mode` between `off` and `read-write`
  and rebuilds the language client.

- **Per-surface hover settings** (`dimfort.hover.functionCalls`,
  `dimfort.hover.subroutineCalls`, `dimfort.hover.expressions`)
  — three independent `Short` / `Detailed` toggles. Call hovers
  render a formal-vs-actual pairing per arg with `🟢 / 🟡 / 🔴`
  markers; expression hovers render either a one-line homogeneity
  check (Short) or the full unit-algebra tree (Detailed). The
  legacy `dimfort.trace.enabled` still works as a master upgrade
  switch from Short → Detailed.
- **Live settings reload** — any change under the `dimfort.*`
  namespace rebuilds the language client transparently. No
  manual "Restart Language Server" needed.

- **`dimfort.trace.enabled` setting** (default `false`) — turn on
  the LSP server's full-unit-trace hover mode. Hovering inside an
  assignment renders an ASCII tree of the RHS with per-node units
  and unit-algebra rule IDs (`R3.1`, `R5.6`, …). Header carries a
  status marker (`🟢 / 🔴 / 🟡 DimFort`). Available as the
  `DimFort: Toggle Full Unit Trace in Hover` palette command.
- **`dimfort.extractToParameter` command** — handles the H010
  D1.5 (implicit literal cast) quick-fix. Prompts via
  `showInputBox` for the parameter name, validates against the
  Fortran identifier grammar, then applies a two-edit refactor
  (insert typed `REAL, PARAMETER :: <name> = <literal> !<
  @unit{<unit>}` declaration at the end of the enclosing
  routine's decl block, plus replace the literal at the use site).

### Fixed

- **`codeLensEnabled` default mismatch.** The setting was declared
  with default `false` in `package.json` but defaulted to `true`
  in `extension.ts` if absent. Harmless in practice (VSCode
  always returns the declared default), but the two are now
  aligned at `false`.

### Tooling

- **Per-push CI**: `tsc` typecheck on every push to `main` and
  every PR. The tag-gated `build.yml` still packages the `.vsix`
  on releases.

## [0.1.1] — 2026-05-19

First **Visual Studio Marketplace** publish. The 0.1.0 release on
GitHub was packaged under publisher `dimfort` (a placeholder before
the actual marketplace publisher was registered). Re-packaged
under publisher `arrialvictor` — the extension is now
`arrialvictor.dimfort-vscode` on the marketplace.

Install path simplifies to:

```
ext install arrialvictor.dimfort-vscode
```

or, from the VSCode Extensions panel, search "DimFort".

No code changes; pure packaging fix. The `.vsix` for direct
install is still attached to this GitHub release for users on
non-marketplace clients (Cursor without OpenVSX, etc.).

## [0.1.0] — 2026-05-19

First public release. Install as `.vsix` from this release's
assets:

```bash
curl -L -o dimfort-vscode.vsix \
  https://github.com/ArrialVictor/DimFort-VSCompanion/releases/download/v0.1.0/dimfort-vscode.vsix
code --install-extension dimfort-vscode.vsix
```

Requires DimFort itself installed and the `dimfort` command on
PATH (`pipx install 'dimfort[lsp]'`).

### 2026-05-19

- **Drop inlay-hint truncation in Fortran scopes**. VSCode truncates
  inlay labels at 43 characters by default, so units like
  `kg × m² / (s³ × K)` ended in `…`. The extension now overrides
  `editor.inlayHints.maximumLength = 0` via `contributes.configurationDefaults`
  for the `[fortran]`, `[FortranFreeForm]`, and `[fortran-modern]`
  scopes. Users who set their own value still win.

### 2026-05-18

- **Rebuild language client on toggle.** Each per-feature toggle
  command (inlay hints, completion, code actions, go-to-definition,
  code lens) now stops and re-creates the `LanguageClient` so the
  updated setting reaches `initializationOptions`. Without this, the
  setting flipped in VSCode but the server kept the value it had at
  start-up.

### 2026-05-17

- **Branding**: ship `icon.png`, `icon_alt.png`, and `social_preview.png`
  generated by `scripts/make_logo.py`. Icons are 256×256; the social
  preview is 1280×640 to match GitHub's recommended dimensions.
- **Palette commands**: drop the redundant `DimFort:` prefix from
  visible titles (the `category` field already adds it).
- **Drop `dimfort.backend` setting**: the backend split (LFortran AST
  vs ASR) has been retired upstream in DimFort; the setting is no
  longer meaningful.

### Earlier

Initial release of the VSCode client. Wraps `dimfort lsp` over stdio.
Forwards Fortran sources for diagnostics; surfaces hover, inlay hints,
go-to-definition, code lens, code actions, and completion. Provides
per-feature toggle commands and a "Check Whole Workspace" palette
command. Bundles a Doxygen-aware Fortran TextMate grammar via the
`fortran` language definition.
