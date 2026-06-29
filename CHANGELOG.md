# Changelog

All notable changes to the DimFort VSCode extension are documented
here. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

This extension is a thin LSP client for [DimFort](https://github.com/ArrialVictor/DimFort);
behavioural changes mostly land in the DimFort server itself. Entries
below cover client-side changes only (settings, defaults, palette
commands, packaging).

## [Unreleased]

### Added

- **Unexpected LSP-server-exit surfacing.** New
  `LanguageClient.onDidChangeState` wiring catches mid-session
  crashes (segfault, SIGKILL, Python crash mid-handler) and toasts
  via `vscode.window.showErrorMessage` naming the most common
  causes (missing `[lsp]` extra, server crash mid-handler) with a
  **"View Output"** action that opens the DimFort log channel
  one-click (also keeps the notification sticky-until-dismissed). Previously the
  server-died case was invisible — the panel went stale, new
  requests stopped resolving, the user had no signal anything was
  wrong. Per-(state-transition) deduped so a rapid-retry crash
  loop doesn't carpet the screen; the dedup memo resets once the
  server reaches `Running` again so a post-recovery crash warns
  afresh. Graceful teardowns (extension deactivate, the
  `dimfort.restartLanguageServer` command, settings rebuilds) are
  tagged via a `_expectingStop` WeakSet so they don't trip the
  toast. New module `src/server-exit.ts`. Closes the third leg of
  the 0.2.7 silent-failure audit (after server-side
  [#113](https://github.com/ArrialVictor/DimFort/pull/113) +
  [NvimCompanion#33](https://github.com/ArrialVictor/DimFort-NvimCompanion/pull/33)
  +
  [EmacsCompanion#34](https://github.com/ArrialVictor/DimFort-EmacsCompanion/pull/34)).

- **LSP-server startup-failure surfacing.** `LanguageClient.start()`
  rejections — executable not on PATH, missing `[lsp]` extra,
  immediate Python crash before the initialize handshake — now toast
  with the actionable hint instead of vanishing into the previous
  `void client.start()`. Deduped per error message so a retry loop
  on a persistent install error doesn't multi-toast.

- **Workspace-root derivation for the no-folder case.** When the user
  opens a single Fortran file (`code foo.f90`) without a folder,
  VSCompanion now walks up from the file looking for `dimfort.toml`
  and injects the result as a synthetic `workspaceFolder` on the
  LSP client. Without this, `vscode.workspace.workspaceFolders` was
  empty, the LSP sent no folder to the server, and every workspace-
  scope feature (project coverage, cross-file analysis,
  `dimfort/checkWorkspace`) silently disabled. Falls back to the
  file's containing directory when no `dimfort.toml` is found
  upstream. Matches the Nvim and Emacs companions' equivalent
  behaviour landed in 0.2.7 — `dimfort.toml`-only marker policy
  (no `.git` fallback) across all three companions.

- **Root-source provenance in the coverage status-bar tooltip.**
  When derive-root anchored the workspace, the tooltip now shows
  a `Workspace root: dimfort.toml — /path/to/dir` line above the
  coverage breakdown. Surfaces diagnostic context where users
  hover to investigate ("why is my project state weird?") without
  taking status-bar real estate that competes with Git status,
  line/col, etc. No row appears when a real folder was already
  open — nothing diagnostic to report. The Nvim and Emacs
  companions tag their panel footers (which have room); the
  status-bar tooltip is VSCompanion's equivalent diagnostic
  surface.

- **Nested-`dimfort.toml` notification.** When the upward walk for
  the workspace root encounters a second `dimfort.toml` above the
  chosen one, VSCompanion shows a one-time information message
  surfacing the drift (typically an unintended sub-project or
  configuration overlap). Per-root deduped — same root never warns
  twice in one session. Only fires for `dimfort.toml` specifically.

### Fixed

- **`workspace/executeCommand` wire-level error now surfaces.** When
  the LSP request itself fails (transport disconnected, server
  crashed mid-request) the companion now toasts the error message
  instead of silently clearing the spinner. The documented
  `started: false` server-refusal cases (already in progress / index
  not ready / no files) stay silent on the companion side — the
  server already toasts the reason via `window/showMessage` which
  VSCode renders as a popup; double-warning would be noise.
  Annotated with `audited(0.2.7)` so the intentional silence is
  documented. Same shape as
  [NvimCompanion#33](https://github.com/ArrialVictor/DimFort-NvimCompanion/pull/33)
  and
  [EmacsCompanion#34](https://github.com/ArrialVictor/DimFort-EmacsCompanion/pull/34).

## [0.2.6] — 2026-06-13

### Highlight

Side-panel rework + cross-companion command parity release. Three
threads:

1. **Multi-view panel as the production surface.** The legacy
   single-WebviewView panel is retired; each section (Cursor /
   Scope / Imports + coverage footer in the status bar) now ships
   as its own registered View in a shared View Container. Sections
   can be independently collapsed, reordered, dragged to the bottom
   panel or secondary sidebar, and hidden via VSCode's native chrome.
   `View: Reset View Locations` restores the default layout. The
   panel sections inherit per-section sort mode (line / alphabetic
   / status) and per-section unit-display mode (input / canonical /
   both) from a shared title-bar control set.

2. **Cross-companion command parity.** A canonical commands table
   shipped server-side (`docs/editor-integration/commands.md`); the
   extension now matches that table row-by-row. Two new commands:
   `DimFort: Status` (mirrors `:DimFortStatus` / `M-x dimfort-status`,
   prints state to the existing DimFort Output channel) and
   `DimFort: Open Config…` (single command that resolves the project
   `dimfort.toml` or units file, with a sub-pick for missing-file
   case offering Empty file / Reference template).

3. **Palette polish.** Title-bar icon-variant commands (the discrete
   sort-mode / unit-display-mode click targets needed to render
   the icons) used to surface in `Cmd+Shift+P` alongside the user-
   facing cycle commands; they're now hidden from the palette,
   leaving only the cycle commands the user actually invokes.

### Recommended server version

Pair this companion with DimFort **0.2.6+**. The workspace-check
wire-protocol command renamed from `dimfort.checkWorkspace` (dot)
to `dimfort/checkWorkspace` (slash) server-side; this companion now
sends the slash form. Earlier servers (0.2.5 and below) accept both
for one release as a soft-migration window, but pairing with 0.2.6+
gets you the new workspace-less / index-not-ready toasts and the
`[N/5]` workspace-check progress phase counter — neither of which is
client-side.

### Added

- **`DimFort: Status` command.** Prints the active LSP client state
  + extension configuration to the existing DimFort Output channel.
  Mirrors `:DimFortStatus` (Nvim) and `M-x dimfort-status` (Emacs).
  Useful for bug reports: ask the user to paste the channel's last
  block. Output-channel-only by design (no toast, no webview, no
  modal — those alternatives were prototyped and dropped as too
  noisy).

- **`DimFort: Open Config…` command.** Single command that opens
  the project `dimfort.toml` if present, the project units file if
  present, or — when the requested file doesn't exist — pops a
  sub-pick offering **Empty file** (create blank) or **Reference
  template** (drop in a starter template with comments). Matches
  `:DimFortOpenConfig` (Nvim) and `M-x dimfort-open-config` (Emacs)
  exactly. Reduces the "where do I edit DimFort config" friction.

- **Sort + unit-display modes on the side panel.** Both the Scope
  and Imports sections now carry a title-bar control set: sort
  mode (`line` / `alphabetic` / `status`) and unit-display mode
  (`input` / `canonical` / `both`). The unit-display icon is a
  three-step star progression (empty / half / full). Defaults:
  sort = `line`, unit-display = `canonical`. Both persist across
  sessions per workspace.

- **Cross-companion command audit fixes.** Five renames to match
  the canonical commands table — most of the table was already
  correct; the audit caught the remaining stragglers. See PR #31
  for the full diff.

- **Commands reference table in README.** Mirrors the canonical
  server-side `docs/editor-integration/commands.md` for users
  reading the extension's listing on the Marketplace.

### Changed

- **Wire-protocol command.** `dimfort.checkWorkspace` →
  `dimfort/checkWorkspace`. Cosmetic on the client (the palette
  command id `dimfort.checkWorkspace` is unchanged — that's the
  companion namespace, not the wire format). Requires DimFort
  0.2.5+ to receive (which accepts both for one release).

- **Legacy single-view panel retired.** All side-panel content
  now ships through the multi-view container. Users with custom
  layouts may need to run `View: Reset View Locations` once
  after the upgrade.

### Fixed

- **Multi-view panel: content indent under headers.** Section /
  scope rows are now visually indented under their header to
  match the legacy panel's hierarchy cue. Pre-fix the unindented
  rows read as if every row were a top-level item.

- **Coverage footer alignment.** The `Coverage` label in the
  status-bar tooltip table previously sat one display cell to the
  left of the bulleted tier labels (🟢 Verified / 🟡 Unverified /
  🔴 Violation / 🔵 Unparsed) — fixed by splitting the bullet into
  its own table column so all five labels share a baseline. Plus
  numeric columns now centre-align, nbsp padding, shorter stale
  message, and several other coverage-tooltip polish passes that
  accumulated through the cycle.

- **Palette no longer shows title-bar icon variants.** Discrete
  `.alpha` / `.status` / `.canonical` / `.both` command ids
  needed for the title-bar UI are now `when: "false"`-gated in
  `package.json` contributes.commands so they don't pollute
  `Cmd+Shift+P`. The user-facing cycle commands stay listed.

### Docs

- **Pre-release docs audit** caught: `.dimfort.toml` → `dimfort.toml`
  rename stragglers in the bug-report template HTML comment and
  four user-facing settings descriptions in `package.json`
  (`dimfort.scale.mode` enum labels + descriptions).
- **Restart-drift QA check** added to MANUAL_QA — catches per-file
  state leaks across `:DimFortRestart` boundaries that would
  otherwise only surface on the third or fourth iterative restart.

## [0.2.5] — 2026-06-09

### Recommended server version

Pair this companion with DimFort **0.2.5+**. The workspace bar
listens for the new server-fired `dimfort/workspaceCheckCompleted`
notification (introduced by DimFort 0.2.5's async workspace check
refactor). Earlier servers don't emit it; the bar would stay on
the spinner state forever after a refresh trigger.

### Added

- **Coverage stats bar (File segment)** — the side-panel footer now
  reports per-file coverage: `File: 78% (🟡 18 🔴 2)`. Replaces the
  previous diagnostic-event count line — VSCode's own status bar
  already surfaces W / E totals; the panel now carries
  coverage-specific information. Refreshes live on every
  diagnostic-change signal. Circles are coverage tiers (lines
  painted yellow / red), not W/E counts. New file `src/stats.ts`
  carries the provider; requires DimFort 0.2.4+.

- **Workspace stats segment (manual)** — the panel footer now
  carries a `Project: …` segment alongside the per-file one. Shows
  `Project: –` until the user triggers a refresh; spinner + dimmed
  `Project: computing…` while a refresh is in flight; dims again
  once files have changed since the last refresh (signalling
  that the displayed numbers may be stale). The footer is also
  visible when no Fortran file is active — `File: – · Project: <last>`
  — so workspace coverage stays visible across tab switches.
  Trigger via the palette command **DimFort: Check Whole
  Workspace**. The bar itself is a display-only surface —
  clicking it does nothing — so the refresh cost is always
  explicitly opted into. Earlier 0.2.5 iterations had an
  auto-refresh option; in-editor testing on a 2000-file
  codebase proved the manual-only model is the better UX and
  the auto-refresh machinery was removed.

- **Unified workspace refresh** — the legacy
  **DimFort: Check Whole Workspace** palette entry now routes
  through the same path as the (formerly separate) workspace
  coverage refresh: ONE invocation publishes diagnostics,
  updates per-file coverage, AND refreshes the workspace
  coverage bar. Previously the diagnostics path and the
  workspace stats path were separate commands running
  `check_files` independently, doubling the cost when the user
  wanted both. Requires DimFort 0.2.5+ for the merged
  server-side `dimfort.checkWorkspace` command.

- **Async workspace check** — the executeCommand response now arrives
  as a `{started, reason?}` ack and the workspace coverage payload
  comes via the new `dimfort/workspaceCheckCompleted` LSP
  notification. The status-bar progress + bar update remain in real
  time during the check (the previous sync handler had
  workDoneProgress events buffered until return, so the bar was
  invisible). A duplicate trigger while a check is in flight surfaces
  a popup notification instead of silently coalescing — both the
  client-side gate and the server-side gate emit one.

- **Panel tab-switch flicker fix** — empty-state posts (`no Fortran
  file active`) now wait 200 ms before landing, so VSCode's brief
  active-editor-undefined transition during tab-switch no longer
  flashes the panel. A real update during the delay cancels the
  empty post; truly-empty states still show after the delay.

- **Coverage visualisation** — per-line status decoration driven by the
  server's `dimfort/lineStatus` LSP method (requires DimFort 0.2.4+).
  Setting `dimfort.coverage.mode` (`disabled` | `gutter` | `background`)
  controls the layer; default is `disabled` (opt-in). Palette command
  **DimFort: Cycle Coverage Visualisation** cycles through the three
  modes. `gutter` and `background` are mutually-exclusive visual
  encodings of the same per-line tier (green / yellow / red / blue);
  pick the visual weight you prefer. Refresh is driven by
  `vscode.languages.onDidChangeDiagnostics` so the layer stays in
  lock-step with the squiggles — no separate debounce race against
  the server's own check pipeline. New setting
  `dimfort.coverage.debounceMs` (default 200) coalesces bursts of
  diagnostic-change events. Coverage settings are companion-only —
  flipping the mode does not restart the language server. New file
  `src/coverage.ts` carries the rendering provider; four SVG icons
  under `media/coverage-*.svg`.

## [0.2.3] — 2026-06-07

### Track DimFort 0.2.3.1's polymorphism feature + in-editor UX polish

This release tracks DimFort's polymorphism feature shipped over
0.2.3 + 0.2.3.1. Recommended pairing is **server 0.2.3.1** for the
full hover/panel rendering; the companion is forward-compatible with
0.2.3 servers too.

Server-side (read transparently — no client config added):
parametric polymorphism (`'a`, `'b`, …) in `@unit{}` annotations,
four new diagnostic codes (H020 polymorphic-call-site unification
failure, H021 type-variable-in-forbidden-position, H022
cannot-bind-tyvar-to-affine-unit (e.g. passing a `degC` actual into
a `'a` slot — type variables range over the multiplicative algebra
only), H023
dishonest-polymorphic-body), the 40-item pre-release audit fix
series, and the 37 in-source docstring-drift fixes. The eight
0.2.3.1 follow-up fixes (panel/hover marker propagation, H020
collides-trailer rendering, message multi-line reformat, clean-call
no-trailer convention, polymorphic-function return resolution, and
the `'a = ?` unbound-return form) are similarly server-side — they
just need the client to render the new fields exposed below.

Client-side (this companion):

- **`(collides with …)` row tail** on H020 polymorphic-conflict rows.
  The server's `dimfort/panelInfo` now ships a `collides` field on
  `ExpressionNode` carrying the partner-arg list (`"arg 2"` /
  `"arg 1, arg 3"`); the panel renders it as `(collides with <X>)`
  to the right of the marker, alongside the existing `(expected …)`
  and `(assumed: …)` row tails. Forward-compatible: 0.2.3 servers
  omit the field and the trailer doesn't render.
- **Muted trailing `?`** on the new `'a = ?` unbound-polymorphic-return
  form. Mirrors the bare-`?` / bare-`-` muting already applied to
  pure absence-glyphs; the bound prefix stays full-weight, only the
  unknown `?` is dimmed. The suffix check is tight enough not to
  false-positive — concrete units never end in `= ?`.
- **Polymorphism QA annex** in MANUAL_QA.md (Cases A–G + interactive
  H021 / H022 probes) — pins every behaviour the 0.2.3.1 server-
  side fixes deliver.

### Recommended server version

`dimfort >= 0.2.3.1` for the full polish. Earlier 0.2.3 servers
work — the `collides` field stays absent and the panel renders the
binding form without the trailer, the rest is unchanged.

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
