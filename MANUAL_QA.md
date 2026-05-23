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
    ref_pressure = dynamic_pressure(c_sound)
  end subroutine checks
end module qa_mod
```

Open it; the extension activates on the Fortran language and the LSP
attaches. Give the first workspace check a moment, then walk the
sections below. Commands below are run from the Command Palette
(`Cmd/Ctrl+Shift+P`) unless noted.

## Defaults (fresh config)

- [ ] No `[unit]` inlay ghost text anywhere — `dimfort.inlayHints.enabled`
      is `false` by default.
- [ ] No panel is shown until you open it (see below) — VSCode opens it
      from the activity-bar icon, not automatically.
- [ ] In Settings (search "dimfort"), confirm the defaults:
      `inlayHints.enabled` off, `completion.enabled` on,
      `codeActions.enabled` on, `gotoDefinition.enabled` on,
      `hover` = `short`, `cache.mode` = `read-write`.
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

Hover defaults to **`short`** in VSCode (the panel is closed by default,
so the hover is the unit surface). Mouse over the symbol (or
`Cmd/Ctrl+K Cmd/Ctrl+I`).

- [ ] **Short (default)** — on **`c_sound`** → `c_sound : m/s`; on the
      product `c_sound * t` (line 18) → the single line `c_sound * t : m`.
- [ ] **Detailed** — run **DimFort: Cycle Hover Verbosity** once
      (`short → detailed`). The same product hover now breaks down across
      lines (each operand with its unit), and the call `dynamic_pressure`
      (line 21) shows the formal-vs-actual pairing (`v : m/s ◂ c_sound : m/s`).
- [ ] **Disabled** — cycle once more (`detailed → disabled`); hovering a
      symbol shows nothing. Cycle once more to return to `short`.

## Inlay hints

- [ ] **DimFort: Toggle Inlay Hints** → `[m/s]`-style ghost text appears
      after variable uses; run it again → it disappears.

## Code actions

Click the lightbulb (`Cmd/Ctrl+.`) with the cursor on the relevant line.

- [ ] On `t_celsius` (line 17) → **"add `@unit{}`"**. Applying inserts
      `!< @unit{}` and leaves the cursor **between the braces** (VSCode
      expands the `$0` snippet tab-stop natively).
- [ ] On the `273.15` (line 20) → **"extract literal to PARAMETER"**.
      Applying prompts for a name, then inserts a typed `real, parameter`
      declaration and replaces the `273.15`.

## Navigation & completion

- [ ] `F12` (Go to Definition) on a `c_sound` use → jumps to its
      declaration on line 2.
- [ ] Type a new `!< @unit{` → the completion popup offers unit names.

## Side panel

The panel is **closed by default**. Open it from the **`[m²]` activity-bar
icon** (left dock) or via **DimFort: Show Side Panel**. It follows the
cursor (≈200 ms debounce). It renders as a styled webview — the content
below shows the data; column alignment is done in the webview, not ASCII.

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
      `dynamic_pressure(c_sound) : kg/(m×s²)` 🟢 with the argument
      `c_sound : m/s` 🟢 as a child.

- [ ] **Stacked scopes** — with the cursor in line 10, the Scope section
      stacks `Module: qa_mod` (c_sound, ref_pressure) over
      `Function: dynamic_pressure` (v, q, rho), indented by nesting, every
      variable 🟢.

- [ ] **Markers** — in `checks` (cursor in line 19), `t_celsius` shows 🟡
      (unannotated); a `@unit{??}` in scope shows 🔴.

- [ ] **Cursor-follow** — move between line 10 (function) and line 19
      (subroutine); the Scope section switches between `Function:
      dynamic_pressure` and `Subroutine: checks`.
