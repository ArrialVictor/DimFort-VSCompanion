# Changelog

All notable changes to the DimFort VSCode extension are documented
here. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

This extension is a thin LSP client for [DimFort](https://github.com/ArrialVictor/DimFort);
behavioural changes mostly land in the DimFort server itself. Entries
below cover client-side changes only (settings, defaults, palette
commands, packaging).

## [0.2.2] — 2026-06-03

### Passthrough: DimFort 0.2.2's configurable comment delimiters

This release tracks DimFort 0.2.2. The extension itself is
unchanged — the new `[parser]` keys
(`unit_comment_delimiters` / `unit_assume_comment_delimiters` /
`unit_affine_comment_delimiters`) are read by the server from
`.dimfort.toml`, no client config is added. The companion needs
this version bump only to gate against pre-0.2.2 servers in the
PyPI-pinned install path.

The new U021 / U023 / U002-suggested-rewrite diagnostics render
through the existing diagnostic surface; the U002 "Replace with
`<X>`" quick-fix is a `WorkspaceEdit`-based code action (no
command delegation) so it works identically here and in every
other LSP client.

### Min server version

`dimfort >= 0.2.2` in the pinned install path. Earlier servers
still run as a fallback (the marketplace install does the version
pin best-effort; pre-pin servers don't expose the new toml keys
but the rest of the extension still functions).

## [0.2.1] — 2026-05-30

### Polish: render `assumed` marker (🔵) + `(assumed: <reason>)` tail on the RHS row

Tracks the new server-side `ExpressionNode.marker = "assumed"` value
and `ExpressionNode.assumed: string | null` field. When the server
flags a row as accepted via `@unit_assume{<unit> : <reason>}`, the
panel paints 🔵 and appends `(assumed: <reason>)` to the row tail
(same column as `(expected …)`; both can coexist).

The overlay lives on the **RHS row** of the assignment — the
directive's syntactic subject — not on the assignment row itself.
The companion needs no code changes for this routing (the server
sets `marker`/`assumed` on the RHS child of the assignment
payload); this entry tracks the wire-format expectation.

🔵 is a per-row overlay, NOT a severity tier — it doesn't
propagate up. The assignment row stays `marker: "ok"` (🟢) when
the homogeneity check passes; H001 still fires (🔴) if the
declared LHS unit conflicts with the asserted RHS unit. See
DimFort design/markers.md §4.6.

### Polish: dim `?` and `-` glyphs across every panel section

Absence-of-information glyphs (`?` for unknown, `-` for
structural-no-unit) now render with the muted theme colour in
**every** panel section that shows units — Scope, Imports,
Expression tree, and Interactions. Three glyphs, three meanings,
consistent visual treatment everywhere. Real units pop; the
absence glyphs read as auxiliary information they are.

The Expression tree previously rendered as `textContent` on a
single `<div>`; switched to `innerHTML` so the `<span class="muted">`
wrappers take effect (alignment is preserved by the existing
`white-space: pre` rule on `.tree`).

### Change: scope / import unannotated vars render `?`, not `(none)`

Aligns with the server-side glyph unification (see DimFort
design/markers.md §4.5): `(none)` is now reserved for empty
(sub-)section headers only (`Scope: (none)`, `Imports: (none)`).
Individual unannotated variables in the Scope and Imports sections
read `?` — the same glyph used inside the Expression tree for
unknown units. Imported subroutines (no return by design) read `-`
instead of `?` to distinguish "no unit by structure" from "we
don't know yet".

### Change: panel tree drops rule IDs; renders `(expected …)` on call-arg mismatches

Tracks the server's wire-format rename `ExpressionNode.ruleId` →
`ExpressionNode.expected`. The Expression section no longer trails
rule-ID tags like `(R4.2)` on every node — debug noise that wasn't
helpful for the target audience. In their place, when a call
argument's resolved unit dimensionally differs from the callee's
formal, the row now ends with `(expected <formal>)` so the reader
sees what the call-site demanded without reading the diagnostic
text. Mismatched argument rows paint 🟡 (the new 🟡-on-`expected`
override, server-side; see DimFort design/markers.md §4.4), so a
row with `(expected …)` will never read `marker: "ok"`.

### Polish: scope/imports `unitNormalized` column + uniform scale-mode display

The Scope-var and Imports rows render the `unitNormalized` field as
a second cell next to the source unit when they differ (e.g. `Pa`
beside `kg·m⁻¹·s⁻²`). Server-side gating means the multiplicative
factor appears only when scale mode is on (`hPa  100×kg·m⁻¹·s⁻²` vs
`hPa  kg·m⁻¹·s⁻²`) — the panel just renders whatever the server
emits, so the same rule lands across every surface (Expression tree
unit columns, hovers, normalized columns).

### Polish: module procedures show up in the Scope panel

For module/program scopes, the panel now lists the module's defined
functions / subroutines as `name(args)` rows alongside variables,
mirroring how the Imports section formats imported procedures.
Zero renderer changes — the server emits these as pre-formatted
rows in `ScopeVar` shape; the existing renderer treats them as
ordinary scope entries.

### Change: Interactions label `"Undetermined read"` → `"Undetermined"`

The panel's Interactions section header for the `uses` kind now
reads `Undetermined` (was `Undetermined read`). Matches the rename
on the server side; the underlying `kind` value is unchanged so
existing payloads still route correctly.

### Add: link to the canonical `demos/tour.f90` in the README

The README's intro now points at `demos/tour.f90` in the DimFort
repo — a short, self-contained moist-thermodynamics file that
exercises six high-impact diagnostics on a single page. Going
forward, README screenshots will be taken from this file so they
stay reproducible.

### Docs: project rule — no validation-workspace name in tracked files

Internal hygiene: explicit references to the specific Fortran
codebase used as the validation target have been replaced with
neutral phrasing across `CHANGELOG.md`, `README.md`, and
`package.json`. No behavioural change; documented here for
contributors who may notice the rephrasings in the diff.

## [0.2.0] — 2026-05-28

### Added

- **Imports panel section** — variables **and procedures** a `use` clause
  brings into the cursor's scope (usable there but not declared in an
  enclosing scope, so the Scope tables don't cover them). Grouped by
  source module under a `from <module>` header, each row shows the
  imported name + its unit (a function shows its arguments' and return
  units; callables read as `name(argunits)`, e.g. `force(kg)`) and navigates **cross-file** to where it (and its
  `@unit{}`) is declared. Scoped like Fortran visibility — module-level
  `use` shows for any cursor in the module, routine-level only in that
  routine; a local declaration shadows the import. The section has its
  own name/unit/module filter box. Driven by the server's new
  `panelInfo.imports` field.
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
  files. A benchmark workspace measured ~33 s cold → ~20 s warm. Settings UI exposes
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
