# Manual QA — DimFort VSCode companion

A precise visual smoke test to run **before publishing a release**. It
checks the parts only a human can see in the editor; the server's
verdicts are unit-tested upstream, so this deliberately does *not*
re-verify them. The Emacs and Neovim companions carry the same
checklist with their own commands — running all three confirms the
companions stay in parity.

Every step lists the **exact** expected result. Anything that differs
is a regression to file.

## Scene

Save this as `qa.f90` and open it. It is self-contained (one module,
no cross-file `use`) and fires exactly one of each interesting
diagnostic.

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
    real :: t_celsius                  ! no annotation -> U005
    d         = c_sound * t            ! OK:   m = (m/s)*s
    bogus     = c_sound * t            ! H001: kg = m  (mismatch)
    t_celsius = t - 273.15             ! H010: bare 273.15 literal
    ref_pressure = dynamic_pressure(0.5 * c_sound)
    call scale_pressure(2.0 * ref_pressure)        ! subroutine call
  end subroutine checks

  subroutine scale_pressure(p)
    real, intent(in) :: p   !< @unit{Pa}
    ref_pressure = p
  end subroutine scale_pressure
end module qa_mod
```

Open it; the extension activates on the Fortran language and the LSP
attaches. Give the first workspace check a moment, then walk the
sections below. Commands below are run from the Command Palette
(`Cmd/Ctrl+Shift+P`) unless noted.

## Defaults (fresh config)

- [ ] No `[unit]` inlay ghost text anywhere — `dimfort.inlayHints.enabled`
      is `false` by default.
- [ ] The side panel **is shown automatically** on activation (open by
      default; toggle from the activity-bar icon).
- [ ] In Settings (search "dimfort"), confirm the defaults:
      `inlayHints.enabled` off, `completion.enabled` on,
      `codeActions.enabled` on, `gotoDefinition.enabled` on,
      `hover` = `short`, `cache.mode` = `read-write`, `panel.enabled` on.
      (There is **no** `codeLens` setting and **no** `trace.enabled` /
      `hover.*` per-surface settings — those were removed/collapsed.)

## Diagnostics

Errors are red squiggles, warnings are orange/yellow squiggles; all also
list in the **Problems** panel (`Cmd/Ctrl+Shift+M`). On a fresh open,
confirm exactly:

- [ ] **Line 17** — `t_celsius` (no annotation) → **U005 warning**.
- [ ] **Line 19** — `bogus = c_sound * t` → **H001 error** `kg ≠ m`.
- [ ] **Line 20** — `t_celsius = t - 273.15` → **H010 warning** on the
      `273.15` literal (suggests extracting it to a named PARAMETER).
- [ ] Lines 18 and 21 are **clean** — no diagnostic.

**Interactive — U002 (unparseable annotation):** change line 14's
`!< @unit{s}` to `!< @unit{??}` and save. Confirm **two** diagnostics on
line 14, then undo (`Cmd/Ctrl+Z`):

- [ ] A **U002 error** squiggle under the `@unit{??}` token itself (not
      the start of the line).
- [ ] A **U005 warning** on `t` — an unparseable annotation makes `t`
      count as unannotated. (In the panel, `t` flips to 🔴.)

## Hover

Hover defaults to **`short`** in VSCode (a one-line unit surface
alongside the open side panel). Mouse over the symbol (or
`Cmd/Ctrl+K Cmd/Ctrl+I`).

- [ ] **Short (default)** — on **`c_sound`** → `c_sound : m/s`; on the
      product `c_sound * t` (line 18) → the single line `c_sound * t : m`.
- [ ] **Detailed** — run **DimFort: Cycle Hover Verbosity** once
      (`short → detailed`). The same product hover now breaks down across
      lines (each operand with its unit), and the call `dynamic_pressure`
      (line 21) gains a sub-tree under its computed argument
      `0.5 * c_sound` (`0.5 : 1`, `c_sound : m/s`) — the difference from
      Short, which shows only the `v : m/s ◂ 0.5 * c_sound : m/s` pairing.
- [ ] **Subroutine call** — still in `detailed`, hover the call name
      `scale_pressure` (line 22): same formal-vs-actual layout as a
      function call, **but no return unit in the header** (subroutines
      don't return) — `p : Pa ◂ 2.0 * ref_pressure : Pa` with the argument
      sub-tree beneath.
- [ ] **Disabled** — cycle once more (`detailed → disabled`); hovering a
      symbol shows nothing. Cycle once more to return to `short`.

## Inlay hints

- [ ] **DimFort: Toggle Inlay Hints** → `[m/s]`-style ghost text appears
      after variable uses; run it again → it disappears.

## Code actions

Click the lightbulb (`Cmd/Ctrl+.`) with the cursor on the relevant line.

- [ ] On `t_celsius` (line 17) → **"add `@unit{}`"**. Applying inserts
      `!< @unit{}`, leaves the cursor **between the braces** (VSCode
      expands the `$0` snippet tab-stop natively), and the **unit-name
      completion list pops up automatically** (no manual Ctrl+Space).
- [ ] On the `273.15` (line 20) → **"extract literal to PARAMETER"**.
      Applying prompts for a name, then inserts a typed `real, parameter`
      declaration and replaces the `273.15`.

## Navigation & completion

- [ ] `F12` (Go to Definition) on a `c_sound` use → jumps to its
      declaration on line 2.
- [ ] Type a new `!< @unit{` → the completion popup offers unit names.

## Side panel

The panel is **shown by default** on activation (`dimfort.panel.enabled`,
on by default). Toggle it from the **`[m²]` activity-bar icon** (left
dock) or via **DimFort: Show Side Panel**. It follows the cursor
(≈200 ms debounce). It renders as a styled webview — the content below
shows the data; column alignment is done in the webview, not ASCII.

- [ ] **Activity-bar icon** — the `[m²]` ruler-of-units glyph is visible
      in the left activity bar; clicking it reveals the **Units** panel.

- [ ] **Assignment with a mismatch** — cursor on the **`=`** in line 19
      (`bogus = c_sound * t`). The Expression section shows the whole
      assignment marked 🔴 (`kg ≠ m`), with the operand tree beneath:
      `bogus : kg` 🟢, `c_sound * t : m` 🟢 (R4.2) → `c_sound : m/s` 🟢,
      `t : s` 🟢.

- [ ] **Multiplication chain** — cursor on the **`=`** in line 10
      (`q = 0.5 * rho * v * v`). The Expression section shows the nested
      product, each level tagged `(R4.2)`, all 🟢, resolving to
      `kg/(m×s²)`.

- [ ] **Function call with arguments** — cursor on the call name
      `dynamic_pressure` in line 21. Expression shows
      `dynamic_pressure(0.5 * c_sound) : kg/(m×s²)` 🟢, with the computed
      argument `0.5 * c_sound : m/s` 🟢 (R4.2) as a child, breaking down
      into `0.5 : 1` 🟢 and `c_sound : m/s` 🟢.

- [ ] **Subroutine call** — cursor on the call name `scale_pressure` in
      line 22. A subroutine has no return unit, so the root
      `call scale_pressure(2.0 * ref_pressure)` carries none (🟡), but the
      computed argument `2.0 * ref_pressure : kg/(m×s²)` 🟢 (R4.2) still
      expands beneath it into `2.0 : 1` 🟢 and `ref_pressure : kg/(m×s²)` 🟢.

- [ ] **Stacked scopes** — with the cursor in line 10, the Scope section
      stacks `Module: qa_mod` (c_sound, ref_pressure) over
      `Function: dynamic_pressure` (v, q, rho), indented by nesting, every
      variable 🟢.

- [ ] **Scope filter** — type `v` in the Scope section's search box: only
      variables whose name/unit contains `v` remain (e.g. `v`), scopes with
      no match disappear. Type a unit like `Pa`: rows with that unit show.
      Clear the box → all variables return. The query survives moving the
      cursor (the box keeps its text). Typing a nonsense string shows
      "(no variables match …)".

- [ ] **Markers** — in `checks` (cursor in line 19), `t_celsius` shows 🟡
      (unannotated); a `@unit{??}` in scope shows 🔴. Markers are
      **diagnostic-driven** (see `DimFort/docs/design/markers.md`): a
      circle reflects the squiggle that owns the node, so the panel and
      Problems never disagree. Only the consistency family
      (`H001`–`H004`, `S001`, `S002`) colours a circle — an `H010`
      implicit-cast (e.g. line 20's `273.15`) keeps its squiggle but the
      circle stays 🟢. Relational comparisons aren't an emission site, so
      they show 🟡, not a red.

- [ ] **Normalized-unit column** — a scope-var row shows the input unit
      **and** its base-SI normalized form when they differ. With the
      scale scene below, `phpa` reads `hPa` ⟶ `100×kg/(m×s²)`; base-SI
      vars (e.g. `play : Pa`) show only the one form.

- [ ] **Section order + folding** — sections are `EXPRESSION →
      DIAGNOSTICS → INTERACTIONS → ACTIONS → SCOPE → IMPORTS`, each a
      collapsible `▾ HEADER` (uppercase). Click a header to collapse; the
      collapsed/expanded state **persists** as you move the cursor (and
      across panel hide/show).

- [ ] **Diagnostics section** — cursor on line 19 (`bogus = c_sound * t`):
      a **Diagnostics** section shows `🔴 H001: ...` (the message for the
      cursor line). On a clean line (e.g. 18) the section shows `(none)`.
      (Using the `scale_qa.f90` scene below with `[scale] enabled`, the
      cursor on `t_k = t_c` shows `🟡 S002: …` here too.)

- [ ] **Interactions section** — cursor on a `c_sound` use (line 18). The
      **Interactions** section shows the symbol `c_sound`, then the
      **Declaration** group (line 2) and **Read** group (its use sites),
      each row a `file:line` + unit with the source snippet beneath.
      Because `c_sound` is read as `m/s` at lines 18/21 but as `kg/s` at
      line 19 (`bogus` is `kg`), a **🔴 X001** conflict row sits at the
      top. On a symbol with no cross-site uses the section shows `(none)`.

- [ ] **Click to navigate** — clicking a **diagnostic** row jumps the
      editor to that line; clicking a **scope-var** row (or its blue line
      number) jumps to that variable's **declaration**; clicking an
      **interaction-site** row jumps to that site (another file when the
      use is cross-file).

- [ ] **Actions** — cursor on `t_celsius` (line 17, unannotated): an
      **Actions** section shows an `Add @unit{}` button; clicking it
      applies the same edit as the lightbulb (inserts `!< @unit{}`). On
      the `273.15` literal (line 20): an `Extract literal to PARAMETER`
      button. The section is **absent** when no action applies at the cursor.

- [ ] **Imports section** — needs the `imports_qa.f90` scene below. With
      the cursor inside `solver`'s `step` routine, the **Imports** section
      lists `play` (from `use phys_constants`) under a `use phys_constants`
      header, with its unit `kg/(m×s²)` and a 🟢 marker. Clicking the row
      **jumps cross-file** to `play`'s declaration in `phys_constants`.
      A name not imported (or shadowed by a local declaration) does not
      appear. On a routine that imports nothing, the section shows `(none)`.

- [ ] **Footer** — a flat `File: 🔴 N  🟡 M` bar is pinned to the
      **bottom** of the panel (whole-file counts), even when the content
      above is short.

- [ ] **Cursor-follow** — move between line 10 (function) and line 19
      (subroutine); the Scope section switches between `Function:
      dynamic_pressure` and `Subroutine: checks`.

## Scale layer (S001 / S002) — opt-in

Scale checking is **off by default**; dimension-only must stay
byte-identical. Turn it on with a workspace `.dimfort.toml`:

```toml
[scale]
enabled = true
```

Save this `scale_qa.f90` in that folder:

```fortran
module scale_qa
  real :: play   !< @unit{Pa}
  real :: phpa   !< @unit{hPa}
  real :: t_k    !< @unit{K}
  real :: t_c    !< @unit{degC}
contains
  subroutine s()
    phpa = play        ! S001: hPa vs Pa (×100 multiplicative scale)
    t_k  = t_c         ! S002: K vs degC (affine offset, missing +273.15)
    t_k  = t_c + t_c   ! S002: adding two absolute temperatures
  end subroutine s
end module scale_qa
```

- [ ] **Off by default** — with **no** `.dimfort.toml` (or `enabled =
      false`), the file is **completely clean** — no S001/S002.
- [ ] **On** — with `[scale] enabled = true`, **yellow** squiggles:
      `phpa = play` → **S001**, `t_k = t_c` and `t_k = t_c + t_c` →
      **S002**. The panel/hover **circles match** (🟡 on those lines).
- [ ] **Severity override** — add `[diagnostics]` with `S002 = "error"`,
      save (no manual restart — see below); the S002 squiggles **and**
      circles go **red**.
- [ ] **Typed conversion silences it** — `phpa = play / PA_PER_HPA` with
      `real, parameter :: PA_PER_HPA = 100. !< @unit{Pa/hPa}` is clean.
- [ ] **Editor toggle** (no `.dimfort.toml` needed) — set
      `dimfort.scale.mode` to `on` (or run **DimFort: Cycle Scale
      Checking** until the status bar shows `scale checking on`): the
      S001/S002 squiggles appear. Set it back to `auto` → scale follows the
      toml again (clean when no toml). `off` forces it off even if the toml
      enables it.

## Unparsed regions (P001)

`P001` marks lines tree-sitter couldn't parse — DimFort makes no unit
guarantee there. It's an **info** diagnostic, so it renders as a faint
**blue** squiggle, distinct from real (red) violations. Save this
`unparsed_qa.f90` and open it:

```fortran
subroutine unparsed_qa(press, vel)
  implicit none
  real, intent(in)  :: press   !< @unit{Pa}
  real, intent(out) :: vel     !< @unit{m/s}
  vel = press        ! H001 (red): m/s vs Pa
  vel = * / +        ! P001 (blue): unparseable line
  vel = 0.0          ! a valid trailing statement (see note)
end subroutine unparsed_qa
```

> The trailing `vel = 0.0` matters: if an unparseable line is the **last**
> statement before `end`, tree-sitter can't find the routine boundary and wraps
> the **whole** routine in an error region — which empties the Scope panel. A
> valid statement after the bad line keeps the routine parseable. (Tracked as a
> known panel-robustness gap.)

- [ ] **Blue squiggle** — `vel = * / +` gets a **blue (info)** underline;
      hovering it / the Problems panel shows **`P001` … "could not parse
      this region — DimFort makes no unit guarantee here"** at *Information*
      severity. With the cursor on that line, the panel's **Diagnostics**
      section lists the P001 with a **🔵** glyph (matching 🔴 error / 🟡 warning).
- [ ] **Distinct from a real error** — `vel = press` carries a **red**
      `H001` on the line above, so blue (FYI) and red (violation) are
      visibly different.
- [ ] **Localized, not the whole routine** — only the `vel = * / +` line is
      underlined; the rest of the subroutine is not blue.
- [ ] **Doesn't mask real checks** — the `H001` still fires; P001 only marks
      what it *couldn't* read, it doesn't suppress checking elsewhere.
- [ ] **Suppressible** — add a workspace `.dimfort.toml` with
      `[diagnostics]` `P001 = "off"`, save; the blue squiggle disappears
      (no manual restart), the red `H001` stays.

## Imports section

Save this `imports_qa.f90` (one file, two modules — the second `use`s the
first) and open it:

```fortran
module phys_constants
  real :: play   !< @unit{Pa}
  real :: grav   !< @unit{m/s^2}
end module phys_constants

module solver
  use phys_constants, only: play
  real :: local_p   !< @unit{Pa}
contains
  subroutine step()
    local_p = play
  end subroutine step
end module solver
```

- [ ] **Lists the import** — cursor on `local_p = play` (inside `step`):
      the **Imports** section shows a `use phys_constants` header with one
      row, `play` → `Pa` ⟶ `kg/(m×s²)`, marked 🟢.
- [ ] **Cross-file navigation** — clicking the `play` row moves the editor
      to `play`'s declaration in `phys_constants` (line 2). (Here it's the
      same file; in a real project it opens the defining module's file.)
- [ ] **Scoped + shadowed** — `grav` is **not** listed (the `only:` list
      excludes it). If you add `real :: play !< @unit{Pa}` as a local in
      `step`, `play` drops from Imports (the local shadows it, and it shows
      under Scope instead).
- [ ] **Empty case** — cursor in `phys_constants` (which imports nothing):
      the Imports section shows `(none)`.

## Config reload & cache

- [ ] **`.dimfort.toml` auto-reload** — edit the toml (e.g. flip
      `[scale] enabled` or change a `[diagnostics]` severity) and save;
      diagnostics update **without** running *DimFort: Restart* manually.
- [ ] **Clear cache** — run **DimFort: Clear Content-Hash Cache**; the
      status bar confirms and the server restarts (diagnostics repopulate).
