# Manual QA — DimFort VSCode companion (display walk)

A short visual smoke walk run **before publishing a release**. It
covers only what an LSP client test can't reach: **how VS Code
renders** the server's payloads. Server-side correctness (diagnostic
codes, hover / panel / inlay / workspace / coverage / code-action /
completion payloads) is verified by the LSP integration suite at
`DimFort/tests/lsp_integration/` — this walk does **not** re-check
those.

Each step lists the **exact** visible result; anything that differs
is a regression to file. The same fixtures are reused across surfaces,
so save all six before starting. Commands below are run from the
Command Palette (`Cmd/Ctrl+Shift+P`) unless noted.

## Fixtures

Save these into a fresh workspace folder. The walks below reference
them by name + line number.

### `qa.f90` — main scene

```fortran
module qa_mod
  real, parameter :: c_sound = 340.0   !< @unit{m/s}
  real :: ref_pressure                 !< @unit{Pa}
contains
  function dynamic_pressure(v) result(q)
    real, intent(in) :: v    !< @unit{m/s}
    real             :: q    !< @unit{Pa}
    real             :: rho  !< @unit{kg/m^3}
    rho = 1.225
    q = 0.5 * rho * v * v
  end function dynamic_pressure

  subroutine checks()
    real :: t          !< @unit{s}
    real :: d          !< @unit{m}
    real :: bogus      !< @unit{kg}
    real :: combo      !< @unit{m^2/s^2}
    real :: ln_p       !< @unit{LOG(Pa)}
    real :: rt_e2      !< @unit{m/s}
    real :: abs_t      !< @unit{s}
    real :: recovered  !< @unit{Pa^2}
    real :: rho_brandes !< @unit{kg/m^3}
    real :: t_celsius                  ! no annotation -> U005
    d         = c_sound * t            ! OK
    bogus     = c_sound * t            ! H001
    t_celsius = t - 273.15             ! H010
    combo     = c_sound**2 + d * d / (t * t) - c_sound * c_sound
    ln_p      = log(ref_pressure)
    rt_e2     = sqrt(c_sound * c_sound)
    abs_t     = abs(t)
    recovered   = exp(log(ref_pressure) + log(ref_pressure))
    rho_brandes = 1.e3 * 0.178 * (d * 2.0 * 1000.0)**(-0.922)   !< @unit_assume{kg/m^3 : empirical-fit Brandes2007}
    ref_pressure = dynamic_pressure(0.5 * c_sound)
    call scale_pressure(2.0 * ref_pressure)
  end subroutine checks

  subroutine scale_pressure(p)
    real, intent(in) :: p   !< @unit{Pa}
    ref_pressure = p
  end subroutine scale_pressure
end module qa_mod
```

### `scale_qa.f90` + companion `dimfort.toml`

```fortran
module scale_qa
  real, parameter :: PA_PER_HPA = 100.   !< @unit{Pa/hPa}
  real :: play   !< @unit{Pa}
  real :: phpa   !< @unit{hPa}
  real :: t_k    !< @unit{K}
  real :: t_c    !< @unit{degC}
contains
  subroutine s()
    phpa = play
    phpa = play / PA_PER_HPA
    t_k  = t_c
    t_k  = t_c + t_c
  end subroutine s
end module scale_qa
```

```toml
[scale]
enabled = true
```

### `unparsed_qa.f90` — P001 squiggle display

```fortran
subroutine unparsed_qa(press, vel)
  implicit none
  real, intent(in)  :: press   !< @unit{Pa}
  real, intent(out) :: vel     !< @unit{m/s}
  vel = press
  vel = * / +
  vel = 0.0
  vel = vel * 2.0
end subroutine unparsed_qa
```

### `imports_qa.f90` — imports panel + cross-file navigation

```fortran
module phys_base
  real :: g0   !< @unit{m/s^2}
end module phys_base

module phys_constants
  use phys_base
  real :: play     !< @unit{Pa}
  real :: grav     !< @unit{m/s^2}
  real :: density
contains
  function gravity_at(h) result(g)
    real, intent(in) :: h   !< @unit{m}
    real             :: g   !< @unit{m/s^2}
    g = grav
  end function gravity_at
  subroutine set_play(p)
    real, intent(in) :: p   !< @unit{Pa}
    play = p
  end subroutine set_play
end module phys_constants

module solver
  use phys_constants, only: play, gravity_at, set_play, density
  real :: local_p   !< @unit{Pa}
contains
  subroutine step()
    local_p = play
    call set_play(local_p)
  end subroutine step
end module solver
```

### `delim_qa.f90` + companion `dimfort.toml` — delimiter display

```fortran
subroutine delim_demo
  implicit none
  real :: ws   ! @unit{m/s}
  real :: pa   ! atmospheric pressure [Pa] at the surface
  ! mass loading [kg]
  real :: kg
  real :: a, b, c   ! [m]
  real :: g   !< wind speed [m/s] @unit{kg}
  real :: t   !< @unit_assume{K: legacy fit}
  ws = 1.0   !< @unit{m/s}
  real :: diff   !< @unit{m2/s}
end subroutine
```

```toml
[parser]
unit_comment_delimiters = [
  { open = "@unit{", close = "}" },
  { open = "[",      close = "]" },
]
```

### `poly_qa.f90` — polymorphic `'a` display

```fortran
module poly_qa
contains
  subroutine avg_two(x, y, mean)
    real, intent(in)  :: x     !< @unit{'a}
    real, intent(in)  :: y     !< @unit{'a}
    real, intent(out) :: mean  !< @unit{'a}
    real :: half  !< @unit{1}
    half = 0.5
    mean = half * (x + y)
  end subroutine avg_two

  subroutine caller_clean(a_in, b_in, out_mean)
    real, intent(in)  :: a_in      !< @unit{m}
    real, intent(in)  :: b_in      !< @unit{m}
    real, intent(out) :: out_mean  !< @unit{m}
    call avg_two(a_in, b_in, out_mean)
  end subroutine caller_clean
end module poly_qa
```

## Setup

Open `qa.f90` in VS Code with the DimFort extension installed; the
extension activates on the Fortran language and the LSP attaches.
Give the first workspace check a moment to finish, then walk the
surfaces below.

---

## Surface 1 — Diagnostic rendering (squiggles + Problems panel)

VS Code renders LSP diagnostics as inline squiggles and lists them
in the Problems panel (`Cmd/Ctrl+Shift+M`). Confirm the three
severities are visibly distinct on the qa fixtures:

- [ ] **Error** — on `qa.f90:25` (`bogus = c_sound * t`): **red
      squiggle** under the assignment text + entry in the Problems
      panel with red icon.
- [ ] **Warning** — on `qa.f90:23` (`real :: t_celsius`):
      **orange/yellow squiggle** under the name + Problems entry
      with warning icon.
- [ ] **Info (P001)** — on `unparsed_qa.f90:6` (`vel = * / +`):
      **faint blue squiggle** + Problems entry with info icon.
      Visibly distinct from the red `H001` on the line above.
- [ ] **Info (U020)** — on `qa.f90:35` (the `@unit_assume` line):
      surfaces only as the panel Diagnostics 🔵 row + a Problems
      entry with info icon; no inline squiggle (informational
      acknowledgement, not a problem).
- [ ] **P001 squiggle localised** — the blue underline on
      `unparsed_qa.f90` covers exactly lines 6 and 7 (the bad line
      and the swallowed `vel = 0.0`). Line 8 (`vel = vel * 2.0`)
      is **not** blue.

## Surface 2 — Hover display

Hover defaults to **`short`**. Mouse over a symbol or use
`Cmd/Ctrl+K Cmd/Ctrl+I` to pin the hover popup.

- [ ] **Single-symbol hover** — hover on `c_sound` (`qa.f90:2`):
      the popup shows the single row `c_sound : m·s⁻¹` (the unit
      rendered with **middle dot** `·` and **superscript minus**
      `⁻¹`, not ASCII `m/s`).
- [ ] **Tree rendering** — hover on the product `c_sound * t`
      (`qa.f90:24`). The popup renders the tree with **box-drawing
      connectors** (`├──`, `└──`), **column-aligned** unit and
      marker columns, and **emoji glyphs** (🟢 / 🟡 / 🔴 / 🔵) in the
      rightmost column:

      ```
      🟢 DimFort
      c_sound * t  :  m       🟢
      ├── c_sound  :  m·s⁻¹   🟢
      └── t        :  s       🟢
      ```

      Subsequent steps assume the same alignment pattern.
- [ ] **Cycle hover mode** — **DimFort: Cycle Hover Verbosity**
      cycles `short → detailed → disabled → short`; each tick
      updates the status bar to `DimFort: hover <mode>` and
      **restarts the server** (visible as a "Language server
      restarted" line in the DimFort Language Server Output
      channel). Hover content changes shape on the next mouse-over;
      disabled silences hover entirely.
- [ ] **Pure-signature hover** — in `detailed`, hover on the
      function-def header `dynamic_pressure` (`qa.f90:5`). Popup
      collapses to a single signature line, no per-arg row table.
- [ ] **`(expected …)` trailer style** — in `detailed`, hover on
      the `=` of `qa.f90:25` (`bogus = c_sound * t`). The RHS row's
      trailer `(expected kg)` renders distinctly (dimmed / italic)
      from the row's primary text; the row's marker is 🟡 not 🟢.
- [ ] **`@unit_assume` 🔵 overlay** — in `detailed`, hover on
      `qa.f90:35` (`rho_brandes`). The 🔵 glyph sits on the **RHS
      row only**, not the assignment header. Trailer reads
      `(assumed: empirical-fit Brandes2007)` in the same trailer
      style as `(expected …)`.

## Surface 3 — Side panel: multi-view shell

The panel lives in a shared ViewContainer under the **`[m²]`
activity-bar icon** (left dock). It contains three independent
WebviewViews:

- **Cursor** — bundles Expression / Diagnostics / Interactions / Actions
- **Scope**
- **Imports**

### Activity bar + view layout

- [ ] **Activity-bar icon** — the `[m²]` ruler-of-units glyph is
      visible in the left activity bar; clicking it reveals the
      **Units** ViewContainer.
- [ ] **Three views visible** — clicking the icon shows **Cursor**,
      **Scope**, and **Imports** as separate panel sections, each
      with its own collapse arrow + uppercase title bar. **No**
      single "DimFort" panel anymore (the 0.2.6 multi-view shell
      replaced the legacy single WebviewView).
- [ ] **Drag / dock / hide per view** — drag the **Imports** view
      header to the secondary side bar (or the bottom panel); it
      docks independently. Right-click any view header → **Hide
      View** removes that view only; others remain. Toggle it back
      from **View → Open View…** (search `DimFort: Imports`).
- [ ] **Reset layout** — **View: Reset View Locations** returns
      all three views to the activity-bar dock in default order.

### Per-view toggle commands

Three palette commands flip the corresponding setting
(`dimfort.show.{cursor,scope,imports}`, default `true`):

- [ ] **DimFort: Toggle Cursor View** — flips
      `dimfort.show.cursor`; the Cursor view disappears
      (when-clause re-evaluates) and the status bar reads
      `DimFort: cursor view hidden`. Run again to show. Persists
      across reloads natively via VS Code Settings.
- [ ] **DimFort: Toggle Scope View** — same shape for Scope.
- [ ] **DimFort: Toggle Imports View** — same for Imports.

## Surface 4 — Side panel: content rendering

Open `qa.f90`, ensure all three views visible.

### Section indent + alignment (PR #30 regression check)

- [ ] **Cursor view** — uppercase headers (**EXPRESSION**,
      **DIAGNOSTICS**, **INTERACTIONS**, **ACTIONS**) flush left;
      content rows (Expression tree, diagnostic rows, Interactions'
      Declaration / Write / Read groups, Actions buttons) indented
      **~1.2 em** under each header.
- [ ] **Scope view** — with cursor in `scale_pressure`'s body, the
      `Subroutine: scale_pressure` header is **vertically aligned**
      with the `scale_pressure(...)` row that appears under
      `Module: qa_mod` above it (both at 1.2 em). The regression PR
      #30 fixed: an earlier rev put the nested header at 12 px —
      visibly left of the sibling row above.
- [ ] **Imports view** — each `from <module>` header flush left;
      the table of imported symbols indented ~1.2 em under it.

### Tree column alignment

- [ ] **Expression tree** — in Cursor view, with cursor on
      `qa.f90:25` (`bogus = c_sound * t`), the tree renders with
      identifier / unit / marker columns aligned across rows
      regardless of identifier length. CSS handles alignment (no
      ASCII padding).

### Markers

- [ ] **Tier glyphs** — in `qa.f90:checks`, with cursor in line 25,
      `t_celsius` row shows 🟡 (unannotated); after introducing a
      `@unit{??}` somewhere in scope, that variable's row flips to
      🔴 (annotated but unparseable).

### Footer / sections layout

- [ ] **Section order** — within the Cursor view, sections render
      in order: Expression → Diagnostics → Interactions → Actions.
      Each section is **always present**, showing `(none)` when
      nothing applies (so they don't pop in and out as cursor
      moves).

## Surface 5 — Side panel: title-bar action icons

Each view's title bar carries mode-aware action icons.

### Sort icon (shared `dimfort.panel.sortMode`)

- [ ] **Sort icon visible** — Scope and Imports each show a sort
      icon in their title bar. The icon **reflects the current
      mode** (mode-aware: one of by-line / alphabetic / by-status).
- [ ] **Cycle on click** — clicking the sort icon on **either**
      view cycles the mode (by-line → alphabetic → by-status →
      by-line). Status bar reports the new mode. Both views
      re-sort **synchronously** — they share the same setting.
      Verify: cycle from Scope; the Imports rows also reorder.
- [ ] **Persistence** — pick a non-default mode (e.g. alphabetic);
      reload the window (`Developer: Reload Window`). Both views
      come back in alphabetic order; the icons reflect that.

### Unit-display icon (shared `dimfort.panel.unitDisplayMode`)

- [ ] **Star icon mode-aware** — Scope and Imports each show a
      star icon: **empty / half / full** for the three modes
      (canonical / input / both). Default is `canonical`
      (star-empty).
- [ ] **Cycle on click** — clicking either star icon cycles
      `canonical → input → both → canonical`. Column layout
      changes accordingly:
      - **canonical** (default): one unit column, base-SI form
        (`m·s⁻¹`). Star-empty icon.
      - **input**: one column, annotation as written (`m/s`).
        Thinnest layout. Star-half icon.
      - **both**: two columns, `input ⟶ canonical`. Widest
        layout. Star-full icon.
- [ ] **Synchronous on both views** — cycle from Imports; Scope
      also re-renders to the new mode.
- [ ] **Persistence** — same as sort: choice survives reload.

### Section folding

- [ ] **Collapsible headers** — each section's `▾ HEADER` arrow
      toggles fold; collapsed/expanded state **persists** as the
      cursor moves and across panel hide/show.

### Per-view search box

- [ ] **Scope search** — type `Pa` in the Scope view's search box:
      only variables whose name/unit contains `Pa` remain (e.g.
      `ref_pressure`, `q`); scopes with no match disappear. Clear
      the box → all return. The query **survives moving the
      cursor** (the box keeps its text). Typing a nonsense string
      shows `(no variables match …)`.
- [ ] **Imports search (independent)** — type `gravity` in the
      Imports view's search box: only `gravity_at(m)` remains.
      Scope filter does **not** affect Imports (and vice versa).

## Surface 6 — Side panel: cursor-follow + tab-switch behaviour

- [ ] **Cursor-follow debounce** — move cursor rapidly between
      `qa.f90:10` (function body) and `qa.f90:25` (subroutine
      body). The panel re-renders with the appropriate scope
      (~200 ms debounce).
- [ ] **In-panel click navigation** — clicking a diagnostic row in
      the Cursor view jumps the editor to that line. Clicking a
      scope-var row (or its blue line number) jumps to that
      variable's declaration. Clicking an interaction-site row
      jumps to that site (another file when cross-file).
- [ ] **No flicker on tab switch** — switch rapidly between
      Fortran files. The side panel does **not** flash to "no
      Fortran file active" between switches — the empty message
      is delayed 200 ms to absorb VS Code's tab-switch transition.

## Surface 7 — Workspace check + `[N/5]` progress

Best verified on a real-world ~2400-file Fortran codebase (the
small `qa.f90` sample completes too fast to read every phase).

- [ ] **All five phases visible** — run **DimFort: Check
      Workspace** on the large workspace. The progress status bar
      (bottom-left) walks through:

      ```
      [1/5] loading <i>/<N> <file>
      [2/5] indexing modules <i>/<N> <file>
      [3/5] checking <i>/<N> <file>
      [4/5] published <N>/<N>
      [5/5] projecting coverage…
      ```

- [ ] **`[5/5]` persistence** — the `[5/5] projecting coverage…`
      message stays visible for the ~5 s post-publish projection
      window. If the bar disappears at `[4/5] published` and never
      shows `[5/5]`, that's the regression PR #81 fixed.
- [ ] **Duplicate trigger** — invoke the command twice in quick
      succession. Second invocation surfaces an info popup
      `DimFort: workspace check already in progress` instead of
      spawning a second worker.

## Surface 8 — Status-bar Coverage footer

Coverage lives as a native VS Code status-bar item on the right
(replaces the in-panel footer that existed pre-0.2.6).

- [ ] **Item visible** — bottom-right status bar shows a
      `Coverage: <pct>%` item (or `Coverage: —` when no Fortran
      file is active).
- [ ] **Hover tooltip** — hovering the item opens a tooltip with
      a **File / Project** table (columns: Coverage, Verified,
      Unverified, Violation). Project row shows `–` (italic, dim)
      until **DimFort: Check Workspace** runs.
- [ ] **Refresh workspace coverage** — run the command. Project
      row populates; tooltip updates async (lands on
      `dimfort/workspaceCheckCompleted`, not on command return).
- [ ] **Project goes dim when stale** — edit any buffer after a
      workspace check. Project row dims (warning codicon + italic)
      to signal the snapshot is stale. Re-run the command to
      refresh.
- [ ] **No flicker on tab switch** — switch rapidly between
      Fortran files. The status-bar item does **not** flash to `—`
      between switches (same 200 ms debounce as the panel).

## Surface 9 — Status bar messages + info popups

- [ ] **Cycle commands echo new mode** — each of the following
      reports the new mode in the status bar on every tick:
      - **DimFort: Cycle Hover Verbosity** → `DimFort: hover <mode>`
      - **DimFort: Cycle Scale Checking** → `DimFort: scale checking <mode>`
      - **DimFort: Cycle Content-Hash Cache** → `DimFort: cache <off|read-only|read-write>`
      - **DimFort: Cycle Coverage Visualisation** → `DimFort: coverage <gutter|background|disabled>`
- [ ] **Duplicate workspace trigger** — info popup
      `DimFort: workspace check already in progress` (Surface 7
      cross-check).
- [ ] **Open Config status messages** — file-creation echoes
      `DimFort: created <path>` etc. (Surface 14 cross-check).

## Surface 10 — `DimFort: Status` Output channel

- [ ] **Output channel reveal** — run **DimFort: Status**. The
      bottom panel reveals the **DimFort** Output channel (same one
      the LSP client logs into), scrolled to a freshly-appended
      block titled `[HH:MM:SS] DimFort status`. **Editor focus
      stays in the source file** — the reveal uses
      `preserveFocus = true`.
- [ ] **17-row snapshot** — the block has all 17 rows: executable,
      inlay hints, completion, code actions, go-to-definition,
      hover, cache mode, cache dir, scale checking, coverage
      layer, panel enabled, show.cursor, show.scope, show.imports,
      sort mode, unit display, language client. Each row reflects
      the **current runtime value** — toggle any setting and
      re-run; the new block updates.
- [ ] **Audit trail across invocations** — invoke the command a
      second time. The channel preserves the prior block and
      appends a new one beneath, each with its own timestamp.
- [ ] **Easy copy-paste** — `Cmd/Ctrl+A` then `Cmd/Ctrl+C` in the
      channel pastes the multi-line block cleanly into a support
      discussion / bug report.
- [ ] **Language-client state** — invoke once with server running
      (block reads `Running`). Run **DimFort: Restart Language
      Server**, immediately invoke `DimFort: Status` — the new
      block reads `Starting`. After a few seconds, re-run — reads
      `Running`.

## Surface 11 — Inlay hints display

- [ ] **Toggle visibility** — **DimFort: Toggle Inlay Hints** →
      `[m·s⁻¹]`-style ghost text appears after variable use sites
      (qa.f90 makes this easy to scan). Toggle again → ghost text
      disappears.
- [ ] **Polymorphic vars full-weight** — open `poly_qa.f90`, toggle
      on, cursor in `avg_two`'s body. Ghost text on `x`, `y`,
      `mean` reads `['a]` at the same visual weight as a concrete
      `[m]`-style ghost (no muting — polymorphism is a real
      annotation, not unknown).
- [ ] **Concrete vars** — in `caller_clean`, the ghost text on
      `a_in`, `b_in` reads `[m]`. Same visual weight as the
      polymorphic case.

## Surface 12 — Code actions UI

`Cmd/Ctrl+.` (Quick Fix lightbulb) with the cursor on the relevant
fixture line.

- [ ] **Add `@unit{}`** — cursor on `t_celsius` (`qa.f90:23`).
      Lightbulb surfaces **"add `@unit{}`"**. Applying:
      1. Inserts `!< @unit{}` and **leaves the cursor between the
         braces** (VS Code's snippet engine expands the `$0`
         tab-stop natively).
      2. **The unit-name completion list pops up automatically** —
         no manual `Ctrl+Space`.
- [ ] **Extract literal** — cursor on `273.15` (`qa.f90:26`).
      Lightbulb surfaces **"extract literal to PARAMETER"**.
      Applying prompts via input-box for a name, then inserts a
      typed `real, parameter` declaration and replaces the
      literal.
- [ ] **U002 preferred fix** — cursor on `@unit{m2/s}`
      (`delim_qa.f90:18`). Lightbulb surfaces **"DimFort: Replace
      with 'm^2/s'"** as the **preferred** action (marked with VS
      Code's preferred-fix indicator). Applying edits
      `m2/s` → `m^2/s` and clears the squiggle.
- [ ] **In-panel Actions buttons** — in the Cursor view's Actions
      section, the same actions appear as clickable buttons.
      Cursor on `t_celsius` → an **Add `@unit{}`** button;
      clicking applies the same edit as the lightbulb. On
      `273.15` → an **Extract literal to PARAMETER** button.

## Surface 13 — Navigation & completion

- [ ] **F12 Go to Definition** — `F12` on a `c_sound` use lands
      the cursor on `qa.f90:2` (the declaration line).
- [ ] **Cross-file panel jump** — open `imports_qa.f90`, panel
      visible, cursor in `step`. In the Imports view, clicking
      `play` jumps to its declaration (same file). Drop the
      `, only: …` filter on `solver`'s `use phys_constants` to
      expose the transitive `g0` row; clicking it **jumps
      cross-file** to `phys_base`'s declaration line.
- [ ] **Completion popup in `@unit{`** — type a new `!< @unit{`.
      VS Code's completion popup opens showing unit names.

## Surface 14 — `DimFort: Open Config…` command

These checks need a **fresh workspace folder** with no
`dimfort.toml` and no `units.toml`. `File → Open Folder…` an empty
directory before each subsection.

### `dimfort.toml`

- [ ] **Empty cold-create** — run **DimFort: Open Config…**, pick
      `Project configuration file (dimfort.toml)`. A QuickPick
      sub-pick shows `Empty file` and
      `Reference template (all sections commented out)`. Pick
      `Empty file`. New `dimfort.toml` appears at the workspace
      root, opens, contains just the minimal header. Status bar:
      `DimFort: created dimfort.toml`.
- [ ] **Reference cold-create** — same, pick
      `Reference template …`. File has all section headers
      (`[units]` / `[parser]` / `[diagnostics]` / `[scale]` /
      `[project]`) with `# `-prefixed lines.
- [ ] **Warm-open** — run again, pick `Project configuration file
      …`. Opens existing file with **no sub-pick** and **no
      modification**. No status-bar message.

### `units.toml`

- [ ] **Empty cold-create** — pick `Project units file
      (units.toml)`. Sub-pick shows `Empty file` and
      `Reference template …`. Pick `Empty file`. New `units.toml`
      opens with empty-template stub. A new `dimfort.toml`
      auto-created alongside with `[units]\nfile = "units.toml"`.
      Status bar: `DimFort: created units.toml + wired into
      dimfort.toml`.
- [ ] **Reference cold-create** — pick `Reference template
      (bundled defaults, all commented out)`. File has `[base]` /
      `[prefixes]` / `[derived]` with `# `-prefixed lines.
- [ ] **Auto-wire appends to existing toml** — pre-create
      `dimfort.toml` with only `[diagnostics]\nH001 = "off"\n`
      (no `[units]`). Run command, pick units file. The existing
      `dimfort.toml` is **appended with**
      `[units]\nfile = "units.toml"`; original sections preserved.
- [ ] **Existing `[units]` declines** — pre-create `dimfort.toml`
      with `[units]\nother_key = "value"\n`. Run command, pick
      units file. Info toast: `DimFort: created units.toml. Your
      dimfort.toml already has a [units] section — add 'file =
      "units.toml"' under it to enable the new file.`. The
      `dimfort.toml` is **not** modified.
- [ ] **Warm-open** — re-run, pick units file with the file
      already present. Opens existing file with no sub-pick.

## Surface 15 — Cache cycle + clear

- [ ] **Cycle cache mode (3-state)** — run **DimFort: Cycle
      Content-Hash Cache (Off / Read-only / Read-write)**
      repeatedly. Status bar reports each tick:
      `DimFort: cache off → DimFort: cache read-only →
       DimFort: cache read-write → wrap`. The
      `dimfort.cache.mode` setting in Settings UI exposes all
      three values directly.
- [ ] **Clear cache** — run **DimFort: Clear Content-Hash Cache**.
      Status bar confirms; server restarts; diagnostics
      repopulate.

## Surface 16 — Coverage visualization

- [ ] **Three-mode cycle** — **DimFort: Cycle Coverage
      Visualisation** cycles `gutter → background → disabled`.
      Status bar reports each tick (Surface 9 cross-check). Visual
      states:
      - **gutter**: red / yellow / green dots in the editor gutter
        on in-scope lines (VS Code does not paint diagnostic
        icons in the gutter by default, so coverage dots coexist
        with inline squiggles without competition).
        Out-of-scope lines (module / contains / blank / comment)
        carry **no** gutter decoration.
      - **background**: low-alpha tint on each in-scope line in
        the matching tier colour; gutter dots **gone**. The two
        modes are **mutually exclusive**.
      - **disabled**: all coverage decorations clear.
- [ ] **No LSP restart on mode flip** — open Output panel
      (`Cmd/Ctrl+Shift+U`) → DimFort Language Server channel.
      Cycle the coverage mode 2–3 times. Confirm **no**
      `language server restarted` / connection-restart lines
      appear during the cycles. (Contrast with **DimFort: Cycle
      Hover Verbosity**, which **does** restart — the
      restart-or-not difference is the verification.)
- [ ] **Live unsaved-buffer updates** — with `gutter` mode on,
      edit a file (introduce an H001 or remove an annotation).
      **Do not save.** After ~400 ms (server debounce), gutter
      dots refresh in place to reflect the new diagnostics.
- [ ] **Multi-editor paint** — `Cmd/Ctrl+\` to split the editor;
      open two Fortran files side by side. With coverage on,
      both panes paint independently — the layer handles every
      visible editor, not just the active one.
- [ ] **Persistence across reload** — set mode to `background`,
      run **Developer: Reload Window**. After reload, the
      coverage decoration repaints at `background` automatically
      (setting persists; provider re-attaches to the freshly
      launched LSP).
- [ ] **Settings UI enum picker** — Settings (`Cmd/Ctrl+,`),
      search `dimfort coverage`. The enum picker shows three
      labelled options (`Disabled`, `Gutter`, `Background`) with
      readable description text.

## Surface 17 — Settings UI defaults

- [ ] **Defaults reflect runtime** — Settings (`Cmd/Ctrl+,`),
      search `dimfort`. Confirm the defaults read:
      - `inlayHints.enabled`: off
      - `completion.enabled`: on
      - `codeActions.enabled`: on
      - `gotoDefinition.enabled`: on
      - `hover`: `short`
      - `cache.mode`: `read-write`
      - `panel.enabled`: on
      - `coverage.mode`: `disabled`
      - `panel.sortMode`: `line`
      - `panel.unitDisplayMode`: `canonical`
      - `show.cursor` / `show.scope` / `show.imports`: all on
- [ ] **No removed settings present** — there is **no**
      `codeLens` setting and **no** `trace.enabled` / `hover.*`
      per-surface settings (removed / collapsed pre-0.2.6).

## Surface 18 — Polymorphic `'a` rendering

(Open `poly_qa.f90`.)

- [ ] **Scope rows** — cursor in `avg_two`'s body. Scope view
      lists `x`, `y`, `mean` each with unit cell `'a` and `half`
      with `1`. The `'a` cells render at **full weight** (no
      muting) — same visual weight as concrete units like `m` in
      `caller_clean`'s Scope (also cursor inside it to compare).
- [ ] **Inlay full weight** — covered under Surface 11
      (cross-check that polymorphic ghost text matches concrete
      ghost-text weight).
- [ ] **Muting scope** — confirm the companion's muting fires only
      on bare `?` / bare `-` / trailing `= ?`. A plain `'a` is
      **never** dimmed.

## Surface 19 — Delimiter-config display

(Open `delim_qa.f90` with the companion `dimfort.toml` saved next
to it.)

- [ ] **Bracket-pattern hover** — hover on `pa`, `a`/`b`/`c`, or
      `kg` shows the bracket-captured unit in the hover popup (the
      toml configures `[…]` as a unit delimiter pattern alongside
      `@unit{…}`).
- [ ] **Plain `!` eligibility** — hover on `ws` (line 4) shows
      `m/s`; the `! @unit{m/s}` form has no Doxygen marker but
      still surfaces the unit.
- [ ] **U002 quick-fix** — Quick Fix (`Cmd/Ctrl+.`) on the
      `@unit{m2/s}` line surfaces **DimFort: Replace with
      'm^2/s'** as the **preferred** action; applying clears the
      squiggle. (Same UX as Surface 12's U002 step — verified
      here against the delimiter scene.)
- [ ] **Cache invalidation on pattern change** — comment out
      `{ open = "@unit{", close = "}" }` in the toml, save, then
      **Developer: Reload Window**. Hover on `ws` should now
      show no unit (canonical form no longer configured).
      Uncomment to restore.

## Surface 20 — Scale-mode display

(Open `scale_qa.f90` in a folder with the companion
`dimfort.toml` enabling `[scale]`.)

- [ ] **Squiggles + panel circles match in scale mode** — with
      `[scale] enabled = true`, `phpa = play` and `t_k = t_c`
      both carry yellow squiggles; the corresponding panel rows
      (cursor on those lines) show 🟡 circles. (Diagnostic codes
      and message text are tested by the LSP suite — this step
      verifies the visual coupling between editor squiggle and
      panel marker.)
- [ ] **Scale factor surfaces uniformly** — with scale on, hover
      the `=` of `phpa = play`. The Expression tree's LHS row
      reads `phpa : 100×kg·m⁻¹·s⁻²` 🟢 and the RHS row reads
      `play : kg·m⁻¹·s⁻²` 🟢. The same `×100` factor appears
      wherever a unit is rendered in scale mode.
- [ ] **Editor toggle status-bar message** — **DimFort: Cycle
      Scale Checking** cycles `auto → on → off → auto`; status
      bar reads `DimFort: scale checking <mode>` on each tick.

---

Notes on out-of-scope checks: every step that asked for a specific
diagnostic code / line / message / payload shape in the previous
manual-QA shape has been removed in favour of the LSP integration
suite, which now exercises:

- diagnostics firing on the qa fixture
  (`tests/lsp_integration/test_diagnostics.py`)
- hover payload structure (`test_hover.py`)
- inlay & panel payload (`test_inlay_and_panel.py`)
- workspace check + `workspaceCheckCompleted` notification
  (`test_workspace.py`)
- coverage `lineStatus` tier classifications + U005 propagation
  (`test_coverage.py`)
- code-action data + completion candidates
  (`test_actions_completion.py`)
- lifecycle / `initialize` / cancellation (`test_lifecycle.py`)

If a regression suggests the wire payload changed shape, **start
there**; if everything in this walk passes but the suite fails,
suspect a server-side change.
