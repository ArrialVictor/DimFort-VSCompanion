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
    real :: combo      !< @unit{m^2/s^2}
    real :: ln_p       !< @unit{LOG(Pa)}
    real :: rt_e2      !< @unit{m/s}
    real :: abs_t      !< @unit{s}
    real :: recovered  !< @unit{Pa^2}
    real :: rho_brandes !< @unit{kg/m^3}
    real :: t_celsius                  ! no annotation -> U005
    d         = c_sound * t            ! OK:   m = (m·s⁻¹)*s
    bogus     = c_sound * t            ! H001: kg = m  (mismatch)
    t_celsius = t - 273.15             ! H010: bare 273.15 literal
    combo     = c_sound**2 + d * d / (t * t) - c_sound * c_sound
                                           !       (exercises +, -, *, /, **; all m²/s²)
    ln_p      = log(ref_pressure)            ! intrinsic: LOG-wrap (Pa → LOG(Pa))
    rt_e2     = sqrt(c_sound * c_sound)      ! intrinsic: sqrt halves (m²/s² → m/s)
    abs_t     = abs(t)                       ! intrinsic: preserves (s → s)
    recovered   = exp(log(ref_pressure) + log(ref_pressure))
                                             ! LOG/EXP algebra: homomorphism + cancellation
                                             !   exp(LOG(Pa) + LOG(Pa)) → exp(LOG(Pa²)) → Pa²
    rho_brandes = 1.e3 * 0.178 * (d * 2.0 * 1000.0)**(-0.922)   !< @unit_assume{kg/m^3 : empirical-fit Brandes2007}
                                             ! Non-rational power on a length — not algebraically derivable;
                                             ! @unit_assume asserts the result and fires U020 INFO.
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
      `hover` = `short`, `cache.mode` = `read-write`, `panel.enabled` on,
      `coverage.mode` = `disabled`.
      (There is **no** `codeLens` setting and **no** `trace.enabled` /
      `hover.*` per-surface settings — those were removed/collapsed.)

## Coverage visualisation (0.2.4)

Coverage requires the DimFort server with the `dimfort/lineStatus`
method (server PR #53 merged). The companion mode is `disabled` by
default; the tests below set it manually.

### Three-mode cycle

With `qa.f90` open:

- [ ] Run **DimFort: Cycle Coverage Visualisation** once → status bar
      shows `DimFort: coverage gutter`. Confirm:
      - **Green dots** in the gutter on annotated-declaration lines
        (`real :: c_sound  !< @unit{m/s}` etc.) and on clean
        expression lines (`d = c_sound * t`, `q = 0.5 * rho * v * v`,
        the `combo`, `ln_p`, `rt_e2` calculations).
      - **Yellow dots** on `t_celsius`'s declaration (U005 — no
        annotation) and the `t_celsius = t - 273.15` line (H010
        D1.5 — bare literal cast). With U005 propagation (server
        PR #55), every other line referencing `t_celsius` also
        paints yellow.
      - **Red dot** on the `bogus = c_sound * t` line (H001 — bogus
        is `kg`, RHS resolves to `m`).
      - Out-of-scope lines (`module`, `contains`, `end function`,
        `end subroutine`, `end module`, blank lines, comment-only
        lines) carry no gutter decoration.
      - The yellow / red coverage dots coexist with the inline
        squiggles. VSCode does not paint diagnostic icons in the
        gutter by default, so the coverage dot has no native icon
        to compete with.
- [ ] Run the cycle command again → status bar shows
      `DimFort: coverage background`. Confirm:
      - The gutter dots are gone.
      - Each in-scope line carries a low-alpha background tint in
        the matching tier colour (green / yellow / red / blue).
        `gutter` and `background` are mutually exclusive — pick
        the visual weight you prefer.
- [ ] Run the cycle command a third time → `DimFort: coverage disabled`.
      All coverage decorations clear; the file stays as the user
      sees it without DimFort.
- [ ] Settings sanity: open Settings (`Cmd/Ctrl+,`), search
      `dimfort coverage`. Confirm the enum picker shows three
      labelled options (`Disabled`, `Gutter`, `Background`) with
      readable description text.

### U005 propagation regression (PR #55)

This test verifies the qa.f90 transition: removing an annotation
should turn previously-red use sites yellow, never green.

- [ ] In `gutter` mode, delete `@unit{s}` from the `t` declaration
      line (`real :: t          !< @unit{s}` → `real :: t`).
      Wait for the server's debounce (~400 ms) on the unsaved
      buffer. Confirm:
      - The `bogus = c_sound * t` line goes red → **yellow**
        (it must NOT turn green — `t` is now unannotated and
        propagates yellow to every use site).
      - The `d = c_sound * t` line also paints yellow.
      - Restore the annotation; the lines should revert to red
        / green respectively.

### Blue tier (`P001` unparsed regions)

The blue tier paints on lines tree-sitter could not recover into a
unit-checkable AST. The `qa.f90` scene contains no `P001` region,
so this test needs a synthetic file.

- [ ] In the dev host, create a file `cov-p001.f90` with a deliberately
      malformed block, e.g.

      ```
      program p
        implicit none
        real :: x  !< @unit{m}
      ! ----- unparseable region below -----
      $$$ garbage line $$$
      ! ----- end -----
        x = 1.0
      end program
      ```

      Save it.
- [ ] Cycle to `gutter` mode. Confirm:
      - The garbage line and any surrounding unparsed-region lines
        carry a **blue** coverage dot in the gutter.
      - The clean lines around it (`real :: x`, the assignment) keep
        their green coverage dot.

### No LSP restart on mode flip

- [ ] Open the Output panel (`Cmd/Ctrl+Shift+U`) and select the
      `DimFort Language Server` channel.
- [ ] Cycle the coverage mode (palette command) two or three times.
      Confirm no `language server restarted` / connection-restart
      messages appear in the channel during the cycles. (Cycling other
      settings such as `dimfort.hover` does restart the server; this
      contrast is the verification.)

### Live unsaved-buffer updates + multi-editor

- [ ] With `gutter` mode on, edit a file (add a `@unit{}` to an
      unannotated declaration, or change a unit to introduce an
      H001). **Do not save.** Wait ~400 ms (the server's debounce
      window). The gutter should refresh in place to reflect the new
      diagnostics — squiggles and coverage dots update together.
- [ ] Confirm the same behaviour for an edit that *removes* a
      problem (delete the offending operand): yellow / red dots
      disappear and green dots appear in their place, again on
      unsaved buffer.
- [ ] Split the editor (`Cmd/Ctrl+\`) and view two different Fortran
      files side by side. Cycle to `verbose` mode. Confirm both panes
      paint independently (gutter dots + tint) — the coverage layer
      handles every visible editor, not just the active one.

### Persistence across reload

- [ ] With `verbose` mode on, run **Developer: Reload Window**
      (`Cmd/Ctrl+Shift+P` → `Developer: Reload Window`). After the
      reload, the coverage decoration should re-paint at `verbose`
      automatically — the setting persists, and the provider
      re-attaches to the freshly-launched LSP.

## Diagnostics

Errors are red squiggles, warnings are orange/yellow squiggles; all also
list in the **Problems** panel (`Cmd/Ctrl+Shift+M`). On a fresh open,
confirm exactly:

- [ ] **Line 23** — `t_celsius` (no annotation) → **U005 warning**.
- [ ] **Line 25** — `bogus = c_sound * t` → **H001 error** `kg ≠ m`.
- [ ] **Line 26** — `t_celsius = t - 273.15` → **H010 warning** on the
      `273.15` literal (suggests extracting it to a named PARAMETER).
- [ ] Lines 24, 27, 29, 30, 31, 32, and 38 are **clean**; line 35 fires a **U020 INFO** acknowledging the `@unit_assume` (informational, not a problem) — no diagnostic.

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

- [ ] **Short (default)** — on **`c_sound`** → single row `c_sound : m·s⁻¹`;
      on the product `c_sound * t` (line 24) → the tree shape used by
      every short hover: root `c_sound * t : m  🟢` + immediate operand
      rows `├── c_sound : m·s⁻¹  🟢` and `└── t : s  🟢`.
- [ ] **Binary operators** — on **line 27** (the `combo = …` assignment),
      hover each of `+`, `-`, `*`, `/`, `**` in turn. Each renders the
      same tree shape (root sub-expression + immediate operand rows);
      every row is 🟢; the topmost `**` shows `c_sound**2 : m²·s⁻²` over
      its operand rows. One fixture exercises every binary operator.
- [ ] **Detailed** — run **DimFort: Cycle Hover Verbosity** once
      (`short → detailed`). For bare-identifier operands like
      `c_sound * t` the layout is unchanged from short (nothing to
      expand). For the call `dynamic_pressure` (line 38), Detailed adds
      a sub-tree under its **computed argument row** (`0.5 * c_sound :
      m·s⁻¹ 🟢` with `0.5 : 1`, `c_sound : m·s⁻¹` indented beneath);
      Short shows root + the argument row only. Both modes share the
      side panel's Expression-tree layout — root reads
      `dynamic_pressure(0.5 * c_sound) : kg·m⁻¹·s⁻² 🟢`.
- [ ] **Subroutine call** — still in `detailed`, hover the call name
      `scale_pressure` (line 39): same tree layout as a function call,
      **but the root carries `-`** (structural-no-unit — subroutines
      have no return unit *by design*) and a clean call paints 🟢:
      `call scale_pressure(…) : -  🟢`. The actual-argument
      row `2.0 * ref_pressure : kg·m⁻¹·s⁻² 🟢` and its sub-tree appear
      beneath.
- [ ] **Intrinsics — same tree as user calls.** Still in `detailed`:
      - Hover `log` (line 29): root row `log(ref_pressure) : LOG(Pa)`
        + child row `ref_pressure : Pa 🟢`. The intrinsic call hover
        now uses the same tree renderer as user calls — no more
        bare-identifier-fallback one-liner.
      - Hover `sqrt` (line 30): root row `sqrt(c_sound * c_sound) :
        m·s⁻¹` + computed-arg row (with its operand sub-tree in
        Detailed). Sqrt halves the unit (m²/s² → m/s).
      - Hover `abs` (line 31): root row `abs(t) : s` + `t : s` child
        row. Abs preserves the operand's unit.
      Intrinsics have no `(expected …)` annotation on args — we don't
      track formal-arg units for them — but the structural tree is
      identical.
- [ ] **LOG / EXP computational tricks** — the idiom physicists use
      to do multiplicative work in log space:
      `recovered = exp(log(p) + log(p))`. One line exercises BOTH
      rules:
      - **Homomorphism** (inside): `log(p) + log(p) → LOG(p²)`.
      - **Cancellation** (outside): `exp(log(q)) → q`.

      On **line 32**, hover the outermost `exp` (Detailed): root row
      `exp(log(ref_pressure) + log(ref_pressure)) : Pa²  🟢` over
      the child `log(ref_pressure) + log(ref_pressure) : LOG(Pa²) 🟢`,
      and the sub-tree under that shows two `log(ref_pressure) :
      LOG(Pa) 🟢` rows. DimFort follows the algebra symbolically —
      no opacity, no approximation — so the round-trip `exp ∘ (sum
      of logs)` recovers the product unit cleanly. Strong showcase
      for atmospheric-science audiences.
- [ ] **`@unit_assume` escape hatch** — empirical fits with
      non-derivable units. On **line 35**, hover the assignment
      (`rho_brandes = 1.e3 * 0.178 * (d * 2.0 * 1000.0)**(-0.922)`):
      the line carries `!< @unit_assume{kg/m^3 : empirical-fit
      Brandes2007}`. Because the RHS contains a length raised to a
      non-rational power, the unit isn't derivable from first
      principles — DimFort would normally emit `D1.4`. The
      `@unit_assume` directive asserts the result's unit and
      suppresses `D1.4`; in its place a **U020 INFO** appears,
      acknowledging the assumption (informational, not a problem).
      The hover reads:

      ```
      🟢 DimFort
      rho_brandes = … : -                          🟢
      ├── rho_brandes                : kg·m⁻³     🟢
      └── 1.e3 * 0.178 * (d * 2.0 * 1000.0)**(-0.922)
                                     : kg·m⁻³     🔵  (assumed: empirical-fit Brandes2007)
          ├── …                        (RHS sub-tree with 🟡 leaves
          └── …                         from the unresolved (-0.922))
      ```

      The 🔵 is a **per-row overlay** (NOT a severity tier — see
      DimFort design/markers.md §4.6) painted on the RHS row, the
      directive's syntactic subject. The RHS row's unit column shows
      the **asserted** unit `kg·m⁻³`, not the computed `?`. The
      assignment row stays **🟢** because the homogeneity check
      passes (LHS `kg·m⁻³` matches the asserted RHS `kg·m⁻³`); the
      hover header is `🟢 DimFort`. The 🔵 surfaces only in the
      body, where the assertion lives. The RHS sub-tree still shows
      its underlying algebra (with 🟡 on the `(-0.922)` unresolved
      leaf) for transparency, but doesn't propagate up to the
      assignment row.
      Common in physics: Tetens (saturation vapour pressure),
      Magnus, Buck, parameterised turbulence closures, etc.
- [ ] **Assignment-mismatch `(expected …)` annotation.** On line 25
      (`bogus = c_sound * t`), hover the `=`. The root row paints 🔴
      from `H001` owning the assignment; the RHS child row reads
      `c_sound * t : m  🟡  (expected kg)`. The 🟡 is the
      🟡-on-`expected` override — the RHS expression resolved cleanly
      to `m`, but its consumer (the LHS) demanded `kg`.
- [ ] **Pure-signature hover** (cursor on a function/subroutine
      *definition* header — no call site). Hover `dynamic_pressure`
      in **line 5** (the function definition itself). The hover
      collapses to a single line:

      ```
      🟢 DimFort

      dynamic_pressure(m·s⁻¹) : kg·m⁻¹·s⁻²
      ```

      Just the dimensional signature. No per-arg row table — the
      header alone carries the formal interface. Unannotated formal
      slots and unannotated returns render as `?` and flip the
      header marker to 🟡.
- [ ] **Disabled** — cycle once more (`detailed → disabled`); hovering a
      symbol shows nothing. Cycle once more to return to `short`.

## Inlay hints

- [ ] **DimFort: Toggle Inlay Hints** → `[m·s⁻¹]`-style ghost text appears
      after variable uses; run it again → it disappears.

## Code actions

Click the lightbulb (`Cmd/Ctrl+.`) with the cursor on the relevant line.

- [ ] On `t_celsius` (line 23) → **"add `@unit{}`"**. Applying inserts
      `!< @unit{}`, leaves the cursor **between the braces** (VSCode
      expands the `$0` snippet tab-stop natively), and the **unit-name
      completion list pops up automatically** (no manual Ctrl+Space).
- [ ] On the `273.15` (line 26) → **"extract literal to PARAMETER"**.
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

- [ ] **Assignment with a mismatch** — cursor on the **`=`** in line 25
      (`bogus = c_sound * t`). The Expression section shows the whole
      assignment, root row `bogus = c_sound * t : -` 🔴 (`: -` is the
      structural-no-unit glyph — an assignment has no own unit; the 🔴
      comes from H001 owning it). Tree beneath: `bogus : kg` 🟢,
      `c_sound * t : m` 🟡 `(expected kg)` (🟢→🟡 demotion + tail
      because the RHS resolved cleanly to `m` but its consumer demanded
      `kg`); leaves `c_sound : m·s⁻¹` 🟢, `t : s` 🟢. (Rule IDs like
      `(R4.2)` are no longer rendered in the tree.)

- [ ] **Multiplication chain** — cursor on the **`=`** in line 10
      (`q = 0.5 * rho * v * v`). The Expression section shows the nested
      product, all 🟢, resolving to `kg·m⁻¹·s⁻²`.

- [ ] **Function call with arguments** — cursor on the call name
      `dynamic_pressure` in line 38. Expression shows
      `dynamic_pressure(0.5 * c_sound) : kg·m⁻¹·s⁻²` 🟢, with the computed
      argument `0.5 * c_sound : m·s⁻¹` 🟢 as a child, breaking down
      into `0.5 : 1` 🟢 and `c_sound : m·s⁻¹` 🟢.

- [ ] **Subroutine call** — cursor on the call name `scale_pressure` in
      line 39. A subroutine has no return unit, so the root
      `call scale_pressure(2.0 * ref_pressure)` shows `-` in the unit
      column and 🟢 (no diagnostic owns it). The computed argument
      `2.0 * ref_pressure : kg·m⁻¹·s⁻²` 🟢 still expands beneath it
      into `2.0 : 1` 🟢 and `ref_pressure : kg·m⁻¹·s⁻²` 🟢.

- [ ] **Call-arg expected on mismatch** — temporarily edit line 38 to
      `ref_pressure = dynamic_pressure(c_sound * t)`. The Expression tree
      now shows the argument row `c_sound * t : m 🟡 (expected m·s⁻¹)` —
      the 🟡 is the expected-override (the expression resolved cleanly,
      but the call disagrees with the formal); the 🔴 sits on the
      enclosing call via H004. Revert the edit when done.

- [ ] **Stacked scopes** — with the cursor in line 10, the Scope section
      stacks `Module: qa_mod` (c_sound, ref_pressure, plus the module's
      own procedures `dynamic_pressure(m·s⁻¹)` 🟢 and
      `scale_pressure(kg·m⁻¹·s⁻²)` 🟢 with `-` in the unit column for
      the subroutine) over `Function: dynamic_pressure` (v, q, rho),
      indented by nesting, every row 🟢. Procedures are visible from
      anywhere within their defining module (Fortran host association),
      mirroring how imported procedures show in Imports.

- [ ] **Scope filter** — type `v` in the Scope section's search box: only
      variables whose name/unit contains `v` remain (e.g. `v`), scopes with
      no match disappear. Type a unit like `Pa`: rows with that unit show.
      Clear the box → all variables return. The query survives moving the
      cursor (the box keeps its text). Typing a nonsense string shows
      "(no variables match …)".

- [ ] **Markers** — in `checks` (cursor in line 25), `t_celsius` shows 🟡
      (unannotated); a `@unit{??}` in scope shows 🔴. Markers are
      **diagnostic-driven** (see `DimFort/docs/design/markers.md`): a
      circle reflects the squiggle that owns the node, so the panel and
      Problems never disagree. Only the consistency family
      (`H001`–`H004`, `S001`, `S002`) colours a circle — an `H010`
      implicit-cast (e.g. line 26's `273.15`) keeps its squiggle but the
      circle stays 🟢. Relational comparisons aren't an emission site, so
      they show 🟢 (structural-no-unit, no diagnostic owns the row), not
      a red.

- [ ] **Normalized-unit column** — a scope-var row shows the input unit
      **and** its base-SI normalized form when they differ. With the
      scale scene below and scale **on**, `phpa` reads
      `hPa` ⟶ `100×kg·m⁻¹·s⁻²`; with scale **off**, the same row reads
      `hPa` ⟶ `kg·m⁻¹·s⁻²` (factor hidden — the linter ignores scale
      when off-mode, so its displays do too). Base-SI vars (e.g.
      `play : Pa`) show only the one form (source = normalized).

- [ ] **Section order + folding** — sections are `EXPRESSION →
      DIAGNOSTICS → INTERACTIONS → ACTIONS → SCOPE → IMPORTS`, each a
      collapsible `▾ HEADER` (uppercase). Click a header to collapse; the
      collapsed/expanded state **persists** as you move the cursor (and
      across panel hide/show).

- [ ] **Diagnostics section** — cursor on line 25 (`bogus = c_sound * t`):
      a **Diagnostics** section shows `🔴 H001: ...` (the message for the
      cursor line). On a clean line (e.g. 18) the section shows `(none)`.
      (Using the `scale_qa.f90` scene below with `[scale] enabled`, the
      cursor on `t_k = t_c` shows `🟡 S002: …` here too.)

- [ ] **Interactions section** — cursor on a `c_sound` use (line 24). The
      **Interactions** section shows the symbol `c_sound`, then the
      **Declaration** group (line 2) and **Read** group (its use sites),
      each row a `file:line` + unit with the source snippet beneath.
      Because `c_sound` is read as `m·s⁻¹` at lines 18/21 but as `kg/s` at
      line 25 (`bogus` is `kg`), a **🔴 X001** conflict row sits at the
      top. On a symbol with no cross-site uses the section shows `(none)`.

- [ ] **Click to navigate** — clicking a **diagnostic** row jumps the
      editor to that line; clicking a **scope-var** row (or its blue line
      number) jumps to that variable's **declaration**; clicking an
      **interaction-site** row jumps to that site (another file when the
      use is cross-file).

- [ ] **Actions** — cursor on `t_celsius` (line 23, unannotated): an
      **Actions** section shows an `Add @unit{}` button; clicking it
      applies the same edit as the lightbulb (inserts `!< @unit{}`). On
      the `273.15` literal (line 26): an `Extract literal to PARAMETER`
      button. The section is **absent** when no action applies at the cursor.

- [ ] **Imports section** — needs the `imports_qa.f90` scene below. With
      the cursor inside `solver`'s `step` routine, the **Imports** section
      lists `play` (from `use phys_constants`) under a `use phys_constants`
      header, with its unit `kg·m⁻¹·s⁻²` and a 🟢 marker. Clicking the row
      **jumps cross-file** to `play`'s declaration in `phys_constants`.
      A name not imported (or shadowed by a local declaration) does not
      appear. On a routine that imports nothing, the section shows `(none)`.

- [ ] **Footer (coverage stats bar)** — a `File: <pct>% (🟡 N 🔴 M)`
      bar is pinned to the **bottom** of the panel.
      - **Default**: bar shows the File segment only. Circles are
        coverage tiers (lines painted yellow / red), **not** W/E
        diagnostic counts — those live in VSCode's own status bar.
      - The bar collapses to `File: —` when no Fortran file is
        active.
      - Switching tabs rapidly between Fortran files should NOT
        flash the panel to "no Fortran file active" — the empty
        message is delayed 200 ms to absorb VSCode's tab-switch
        transition.
      - **Workspace segment** — appears in the same footer line
        next to `File:`. Reads `Project: –` (dimmed) until the user
        triggers `DimFort: Check Whole Workspace`; spinner while
        the server-side daemon worker runs; settles to
        `Project: <pct>% (🟡 N 🔴 M)` after. Dims once any buffer
        edits fire so the user knows the snapshot may be stale.
        Trigger again to refresh. Async since 0.2.5: the bar
        update lands when the
        `dimfort/workspaceCheckCompleted` notification arrives,
        not when the executeCommand returns (which only acks
        that the daemon worker spawned).
      - **Duplicate trigger**: invoke the command twice in
        quick succession. The second invocation surfaces an
        info popup "DimFort: workspace check already in
        progress" instead of spawning a second worker.

- [ ] **Cursor-follow** — move between line 10 (function) and line 25
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
  real, parameter :: PA_PER_HPA = 100.   !< @unit{Pa/hPa}
  real :: play   !< @unit{Pa}
  real :: phpa   !< @unit{hPa}
  real :: t_k    !< @unit{K}
  real :: t_c    !< @unit{degC}
contains
  subroutine s()
    phpa = play                  ! S001: hPa vs Pa (×100 multiplicative scale)
    phpa = play / PA_PER_HPA     ! clean: the typed factor cancels the mismatch
    t_k  = t_c                   ! S002: K vs degC (affine offset, missing +273.15)
    t_k  = t_c + t_c             ! S002: adding two absolute temperatures
  end subroutine s
end module scale_qa
```

- [ ] **Off by default** — with **no** `.dimfort.toml` (or `enabled =
      false`), the file is **completely clean** — no S001/S002.
- [ ] **On** — with `[scale] enabled = true`, **yellow** squiggles:
      `phpa = play` → **S001**, `t_k = t_c` and `t_k = t_c + t_c` →
      **S002**. The panel/hover **circles match** (🟡 on those lines).
- [ ] **Scale factor surfaces uniformly in scale mode** — with scale on,
      hover the `=` of `phpa = play` (or look at the Panel's Expression
      section). The LHS row reads `phpa : 100×kg·m⁻¹·s⁻²` 🟢 and the
      RHS row reads `play : kg·m⁻¹·s⁻²` 🟢 — the ×100 ratio matches the
      diagnostic's `×100`. The same factor appears wherever a unit is
      rendered (scope/imports normalized columns, etc.). With scale off,
      factors are hidden everywhere — both sides of the assignment
      render to the bare `kg·m⁻¹·s⁻²`. Single rule: displays match what
      the checker is reasoning about.
- [ ] **Severity override** — add `[diagnostics]` with `S002 = "error"`,
      save (no manual restart — see below); the S002 squiggles **and**
      circles go **red**.
- [ ] **Typed conversion silences it** — the second assignment in `s()`,
      `phpa = play / PA_PER_HPA`, is **clean** (no S001). The typed
      `Pa/hPa` parameter carries the multiplicative factor explicitly,
      so the assignment's units balance and the scale check passes.
- [ ] **Editor toggle** (no `.dimfort.toml` needed) — set
      `dimfort.scale.mode` to `on` (or run **DimFort: Cycle Scale
      Checking** until the status bar shows `scale checking on`): the
      S001/S002 squiggles appear. Set it back to `auto` → scale follows the
      toml again (clean when no toml). `off` forces it off even if the toml
      enables it.

## Unparsed regions (P001)

`P001` marks lines tree-sitter couldn't parse — DimFort makes no unit
guarantee there. It's an **info** diagnostic, so it renders as a faint
**blue** squiggle, distinct from real (red) violations.

Save this `unparsed_qa.f90` and open it:

```fortran
subroutine unparsed_qa(press, vel)
  implicit none
  real, intent(in)  :: press   !< @unit{Pa}
  real, intent(out) :: vel     !< @unit{m/s}
  vel = press        ! H001 (red): m·s⁻¹ vs Pa
  vel = * / +        ! P001 (blue): unparseable line
  vel = 0.0          ! swallowed by line-6 error region — blue too
  vel = vel * 2.0    ! CLEAN — proves the blue stops here
end subroutine unparsed_qa
```

> Why two trailing statements: `vel = 0.0` gets swallowed by tree-sitter's
> error recovery on line 6 (its assignment_statement is consumed into the
> ERROR region, so the Expression panel is degraded there). `vel = vel * 2.0`
> is the first fully-clean statement after the bad line — present to
> demonstrate that the P001 squiggle *stops* at line 7 and does NOT bleed
> further. A trailing valid statement is also required for tree-sitter to
> find the subroutine boundary; without one, the **whole** routine wraps in
> an error region and the Scope panel blanks (known panel-robustness gap).

- [ ] **Blue squiggle** — `vel = * / +` gets a **blue (info)** underline;
      hovering it / the Problems panel shows **`P001` … "could not parse
      this region — DimFort makes no unit guarantee here"** at *Information*
      severity. With the cursor on that line, the panel's **Diagnostics**
      section lists the P001 with a **🔵** glyph (matching 🔴 error / 🟡 warning).
- [ ] **Distinct from a real error** — `vel = press` carries a **red**
      `H001` on the line above, so blue (FYI) and red (violation) are
      visibly different.
- [ ] **Localized, not the whole routine** — the blue squiggle covers
      **exactly two lines**: `vel = * / +` (the bad line) and the
      immediately-following `vel = 0.0` (whose assignment_statement
      tree-sitter swallows into the error recovery region). The next
      line `vel = vel * 2.0` is **not blue** — proving the squiggle stops
      at the right boundary. The Expression panel is correctly empty on
      lines 6-7 (no trustworthy tree there) and populates normally on
      line 8 (clean autocast → `m·s⁻¹`).
- [ ] **Doesn't mask real checks** — the `H001` still fires; P001 only marks
      what it *couldn't* read, it doesn't suppress checking elsewhere.
- [ ] **Suppressible** — add a workspace `.dimfort.toml` with
      `[diagnostics]` `P001 = "off"`, save; the blue squiggle disappears
      (no manual restart), the red `H001` stays.

## Imports section

Save this `imports_qa.f90` (one file, two modules — the second `use`s the
first) and open it:

```fortran
! `phys_base` exists to test TRANSITIVE re-export: phys_constants
! `use`s it, and `solver` uses phys_constants — see whether `g0`
! surfaces in solver's Imports section.
module phys_base
  real :: g0   !< @unit{m/s^2}
end module phys_base

module phys_constants
  use phys_base                          ! transitive: re-exports g0 by default
  real :: play     !< @unit{Pa}
  real :: grav     !< @unit{m/s^2}
  real :: density                        ! NO annotation → unannotated 🟡
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

- [ ] **Lists vars + procedures + subroutines + unannotated** — cursor
      on `local_p = play` (inside `step`): the **Imports** section shows
      a `from phys_constants` header (items indented beneath it) with
      four rows in some order:
      - `play` → `kg·m⁻¹·s⁻²` 🟢 (annotated variable)
      - `gravity_at(m)` → `m·s⁻²` 🟢 (callable, return unit in
        column, arg unit in parens)
      - `set_play(Pa)` → `-` 🟢 (subroutine — structural-no-unit
        glyph, dimmed; renders distinctly from `(none)`)
      - `density` → `?` 🟡 (unannotated variable — the `?` glyph
        appears dimmed, distinguishing it from a real unit)
- [ ] **Cross-file navigation** — clicking the `play` row jumps to its
      declaration; clicking `gravity_at(m)` jumps to the function;
      clicking `set_play(Pa)` jumps to the subroutine. (Same file here;
      another file in a real project.)
- [ ] **Scoped + shadowed** — `grav` is **not** listed (the `only:` list
      excludes it). If you add `real :: play !< @unit{Pa}` as a local in
      `step`, `play` drops from Imports (the local shadows it, and it
      shows under Scope instead).
- [ ] **Transitive imports** — drop the `, only: …` filter on `solver`'s
      `use phys_constants` line so it becomes plain `use phys_constants`.
      `phys_constants` itself `use`s `phys_base`, which declares `g0`.
      Default Fortran semantics re-export `g0` through `phys_constants`.
      Cursor inside `step`: a **second** group header appears, `from
      phys_base` (tagged `via phys_constants`), with a single row:
      - `g0` → `m·s⁻²` 🟢 — clicking it **jumps cross-file** to
        `phys_base`'s declaration site (`imports_qa.f90:2`).
      The existing `from phys_constants` group still lists `play`,
      `grav`, `density`, `gravity_at`, `set_play` — transitive
      re-export only adds the `phys_base` group, never removes a row.
- [ ] **Imports filter** — the Imports section has its **own** search
      box (separate from Scope's). Type `gravity` in it → only
      `gravity_at(m)` remains; type `play` → `play` + `set_play(Pa)`.
      Clear it → all return. The Scope filter does **not** affect
      Imports (and vice versa).
- [ ] **Empty case** — cursor in `phys_base` (which imports nothing):
      the Imports section shows `(none)`.

## Config reload & cache

- [ ] **`.dimfort.toml` auto-reload** — edit the toml (e.g. flip
      `[scale] enabled` or change a `[diagnostics]` severity) and save;
      diagnostics update **without** running *DimFort: Restart* manually.
- [ ] **Clear cache** — run **DimFort: Clear Content-Hash Cache**; the
      status bar confirms and the server restarts (diagnostics repopulate).
- [ ] **Restart drift check (perf-PR sanity)** — quit + reopen VSCode,
      then re-run **DimFort: Refresh Workspace Coverage** on the same
      `qa.f90`. The H-diag and U-diag counts in the toast must match
      the pre-restart counts **exactly**. Any drift = a disk-cache codec
      is producing a different result than a from-scratch run; revert
      whatever PR introduced it. (This catches the silent-data-loss
      bug a single-file workset can surface even without a perf bench.
      Full perf-PR procedure: see
      [perf-pr-validation.md](https://github.com/ArrialVictor/DimFort/blob/main/docs/design/contributor/perf-pr-validation.md).)

## Configurable comment delimiters (0.2.2)

Save this `delim_qa.f90` in a fresh folder alongside the toml
just below it:

```fortran
subroutine delim_demo
  implicit none

  ! §10 — bare ! @unit{} is now eligible at a decl. Hover → m/s.
  real :: ws   ! @unit{m/s}

  ! §2 — bracket pattern (configured below). Hover → Pa.
  real :: pa   ! atmospheric pressure [Pa] at the surface

  ! §3.2 — standalone above a decl, plain `!`. Hover → kg.
  ! mass loading [kg]
  real :: kg

  ! §6 — any pattern on a multi-var attaches to all names.
  real :: a, b, c   ! [m]

  ! §8.2 — two patterns disagree → U021. First-listed (`@unit{}`)
  ! wins, so hover `g` → kg.
  real :: g   !< wind speed [m/s] @unit{kg}

  ! §8.3 — @unit_assume on a declaration → U023.
  real :: t   !< @unit_assume{K: legacy fit}

  ! §8.3 — @unit{} on an assignment → U023.
  ws = 1.0   !< @unit{m/s}

  ! §12 — unparseable unit → U002 with suggested rewrite.
  real :: diff   !< @unit{m2/s}
end subroutine
```

Save this `.dimfort.toml` next to it:

```toml
[parser]
unit_comment_delimiters = [
  { open = "@unit{", close = "}" },
  { open = "[",      close = "]" },
]
```

- [ ] **Bracket pattern recognised** — hover `pa`, `a`/`b`/`c`,
      `kg` (above) shows the bracket-captured unit.
- [ ] **Plain `!` eligibility (§10)** — `ws` on line 4 has the
      `! @unit{m/s}` form (no Doxygen marker). Hover shows `m/s`.
- [ ] **U021 fires** — line with `[m/s] @unit{kg}` shows a yellow
      squiggle; message names both captures; hover `g` shows `kg`
      (the first-listed pattern's capture).
- [ ] **U023 fires** — `@unit_assume{K: legacy fit}` on the
      `real :: t` decl shows a yellow squiggle; message says
      "did you mean @unit?". Same for `@unit{m/s}` on
      `ws = 1.0` — yellow squiggle, message suggests
      `@unit_assume` or `@unit_affine_conversion`.
- [ ] **U002 quick-fix** — `@unit{m2/s}` shows a red squiggle;
      message includes "did you mean 'm^2/s'?". Quick Fix
      (`Cmd+.`) offers **DimFort: Replace with 'm^2/s'** as the
      preferred fix; accepting it edits `m2/s` → `m^2/s` and
      clears the squiggle.
- [ ] **Pattern config invalidates cache** — comment out
      `{ open = "@unit{", close = "}" }` in the toml, save, then
      reload the window. The `@unit{m/s}` hover on `ws` should
      now show no unit (the canonical form is no longer
      configured in this project). Uncomment to restore.

## Polymorphism (0.2.3)

Save this as `poly_qa.f90` in a fresh folder (no `.dimfort.toml`
needed — defaults are fine). The scene covers four cases: clean
polymorphic body, dishonest body, caller mismatch, clean caller.

```fortran
module poly_qa
contains

  ! Case A — cleanly polymorphic body. No fires expected.
  subroutine avg_two(x, y, mean)
    real, intent(in)  :: x     !< @unit{'a}
    real, intent(in)  :: y     !< @unit{'a}
    real, intent(out) :: mean  !< @unit{'a}
    real :: half  !< @unit{1}
    half = 0.5
    mean = half * (x + y)
  end subroutine avg_two

  ! Case B — dishonest body: signature claims 'a but body adds {kg}.
  subroutine biased_avg(x, y, mean)
    real, intent(in)  :: x        !< @unit{'a}
    real, intent(in)  :: y        !< @unit{'a}
    real, intent(out) :: mean     !< @unit{'a}
    real, parameter   :: bias_kg = 1.0  !< @unit{kg}
    real :: half  !< @unit{1}
    half = 0.5
    mean = half * (x + y) + bias_kg
  end subroutine biased_avg

  ! Case C — caller passes kg into one 'a slot and m into another.
  subroutine caller_mismatch(m_in, l_in, out_mean)
    real, intent(in)  :: m_in      !< @unit{kg}
    real, intent(in)  :: l_in      !< @unit{m}
    real, intent(out) :: out_mean  !< @unit{kg}
    call avg_two(m_in, l_in, out_mean)
  end subroutine caller_mismatch

  ! Case D — caller passes consistent {m} to both slots.
  subroutine caller_clean(a_in, b_in, out_mean)
    real, intent(in)  :: a_in      !< @unit{m}
    real, intent(in)  :: b_in      !< @unit{m}
    real, intent(out) :: out_mean  !< @unit{m}
    call avg_two(a_in, b_in, out_mean)
  end subroutine caller_clean

  ! ------------------------------------------------------------------
  ! Function variants — same shape as Cases A-D but on a polymorphic
  ! FUNCTION. The call lives in an assignment RHS (call_expression
  ! node), and the function returns 'a too — exercises the return-
  ! side rendering, distinct from the subroutine_call path above.
  ! ------------------------------------------------------------------

  ! Case E — polymorphic function (clean body, no fires).
  function avg_two_f(x, y) result(out)
    real, intent(in) :: x    !< @unit{'a}
    real, intent(in) :: y    !< @unit{'a}
    real             :: out  !< @unit{'a}
    out = 0.5 * (x + y)
  end function avg_two_f

  ! Case F — clean caller of the function. No fires expected; mirrors
  ! Case D for the function path.
  subroutine caller_func_clean(a_in, b_in, r)
    real, intent(in)  :: a_in   !< @unit{m}
    real, intent(in)  :: b_in   !< @unit{m}
    real, intent(out) :: r      !< @unit{m}
    r = avg_two_f(a_in, b_in)
  end subroutine caller_func_clean

  ! Case G — H020 caller of the function. arg 1 (kg) and arg 2 (m)
  ! force 'a to inconsistent units; mirrors Case C for the function
  ! path.
  subroutine caller_func_mismatch(m_in, l_in, r)
    real, intent(in)  :: m_in   !< @unit{kg}
    real, intent(in)  :: l_in   !< @unit{m}
    real, intent(out) :: r      !< @unit{kg}
    r = avg_two_f(m_in, l_in)
  end subroutine caller_func_mismatch

end module poly_qa
```

### Diagnostics

On a fresh open, confirm exactly the following squiggles. Anything else
(extra fire, missing fire, wrong line, wrong code) is a regression.

- [ ] **Case A — no squiggles anywhere** on lines 5–12.
- [ ] **Case B — H023 error** on the assignment expression line
      `mean = half * (x + y) + bias_kg` (line 23). Message names
      the offending term (`bias_kg : kg`) and explains the body
      would force `'a = kg`.
- [ ] **Case C — H020 error** on the call site `call avg_two(m_in,
      l_in, out_mean)` (line 31). Message includes the **symmetric
      `(collides with arg N (name))` trailer** — both arg 1 and arg
      2 are named (no "first arg wins" asymmetry). The unit each
      slot implied (`kg` and `m`) is rendered.
- [ ] **Case D — no squiggles** on lines 36–41.
- [ ] **Case E — no squiggles anywhere** in the `avg_two_f` function
      body. Mirrors Case A's clean polymorphism, this time on a
      `function`.
- [ ] **Case F — no squiggles** in `caller_func_clean`. The
      `r = avg_two_f(a_in, b_in)` assignment is clean — function
      return `'a` binds to `m`, RHS unit = LHS unit (`m`). Mirrors
      Case D for the function path.
- [ ] **Case G — H020 error** on the call_expression inside the
      assignment `r = avg_two_f(m_in, l_in)`. Same shape as Case C
      (symmetric `collides with` trailer, two-way conflict between
      arg 1 = kg and arg 2 = m), just on a `call_expression` node
      instead of `subroutine_call`. There should be NO additional
      H001 / H004 / S001 on the assignment row — H020 alone owns
      the failure.
- [ ] **Problems panel** (`Cmd/Ctrl+Shift+M`) lists exactly **three**
      entries (H023 + H020 + H020), nothing else.

### Hover

Hover defaults to `short`.

- [ ] **Hover on a tyvar in a signature** — mouse over the `'a` in
      `@unit{'a}` on line 7 (Case A's `x`). Hover shows the
      polymorphic marker — exact rendering TBD per the spec; should
      indicate `'a` is a free type variable, not a concrete unit.
- [ ] **Hover on a clean call site (Case D)** — mouse over the
      `call avg_two(...)` on line 41. Hover renders the
      **σ-binding panel**: `'a = m` (the unifier's solution at this
      call). Every slot row is 🟢.
- [ ] **Hover on the failed call site (Case C)** — mouse over the
      `call avg_two(...)` on line 31. Hover surfaces the conflicting
      contributions per slot (`x → kg`, `y → m`, `mean → kg`); no
      single `σ` panel because unification failed.
- [ ] **Hover on `mean` in Case B body** — mouse over `mean` on
      line 23. The expression tree shows `'a` for `mean`, `kg` for
      `bias_kg`, the conflict row marked 🔴.
- [ ] **Hover on Case F's call assignment** — mouse over
      `r = avg_two_f(a_in, b_in)`. Tree root is the assignment;
      RHS row is the call_expression. Arg rows render bare `m` 🟢
      (no `(expected 'a)` trailer, no demote — same as Case D's
      subroutine_call path). RHS row's unit is `m` (the bound
      return), matching LHS `r : m` cleanly.
- [ ] **Hover on Case G's call assignment** — mouse over
      `r = avg_two_f(m_in, l_in)`. Arg rows render the spec form:
      `m_in : 'a = kg 🔴 (collides with arg 2)` and
      `l_in : 'a = m 🔴 (collides with arg 1)`. The call_expression
      RHS row shows 🔴 from the H020 propagation. Assignment row
      inherits 🔴. No spurious `(expected ...)` trailers on any arg
      row.
- [ ] **Hover on a polymorphic var usage** — mouse over `x` inside
      Case A's body (`mean = half * (x + y)`). Short hover shows the
      same row shape as a concrete-var hover — `x : 'a` 🟢, no
      trailer. Same on `y`. (Polymorphism shows in the unit column
      via the `'a` tyvar text; otherwise reads as any normal
      identifier hover.)

Cursor in each routine's body in turn. The Scope section should
list the routine's locals + formals; the polymorphic ones render
with `'a` in the unit column.

- [ ] **Case A — `avg_two`** — Scope lists `x`, `y`, `mean` each
      with unit `'a`, and `half` with unit `1`. All rows 🟢.
- [ ] **Case B — `biased_avg`** — Scope lists `x`, `y`, `mean` with
      `'a`, `bias_kg` with `kg`, `half` with `1`. The dishonest body
      assignment shows a 🔴 on `mean` (or a flag/marker that the
      body conflicts with the signature — exact UX TBD).
- [ ] **Case C — `caller_mismatch`** — Scope lists `m_in : kg`,
      `l_in : m`, `out_mean : kg`. Side panel surfaces the call-site
      σ failure somewhere (a dedicated row, marker, or callout —
      exact rendering to verify).
- [ ] **Case D — `caller_clean`** — Scope lists three rows in `m`.
      No σ markers; the call site is uneventful.
- [ ] **Case E — `avg_two_f`** — Scope lists `x`, `y`, `out` each
      with unit `'a`. All rows 🟢 (clean function body).
- [ ] **Case F — `caller_func_clean`** — Scope lists `a_in : m`,
      `b_in : m`, `r : m`. All 🟢. The Expression section (with
      cursor in the assignment) shows the call_expression RHS
      resolving to `m` cleanly.
- [ ] **Case G — `caller_func_mismatch`** — Scope lists `m_in : kg`,
      `l_in : m`, `r : kg`. The Expression section surfaces the
      H020 conflict on the call_expression child of the assignment
      (same UX as Case C's subroutine_call).
- [ ] **Polymorphic vars render full-weight in the unit column** —
      across Cases A / B / E, the `'a` cells are rendered the same
      visual weight as concrete units like `m` or `kg` on Cases C / D
      / F / G. The companion's muting only fires on bare `?` / bare
      `-` / trailing `= ?`; a plain `'a` is a real annotation and
      stays full-weight.

### Interactive — inlay hints

- [ ] **Cursor in Case A's body** (any line 18–20). Run **DimFort:
      Toggle Inlay Hints** — `[unit]`-style ghost text appears after
      each variable use. Polymorphic vars (`x`, `y`, `mean`) show
      `['a]`; the local `half` shows `[1]`. The `'a` ghost text
      renders full-weight (no muting — polymorphism is a real
      annotation, not unknown).
- [ ] **Cursor in Case F's body** (`r = avg_two_f(a_in, b_in)`). With
      inlay hints still on, `a_in`, `b_in`, `r` show `[m]` (concrete);
      same visual weight as the polymorphic case above.
- [ ] **Disable when done** — re-run **DimFort: Toggle Inlay Hints**.
      The QA's earlier sections assume the default (off).

### Interactive — H021 / H022 probes

- [ ] **H021 (tyvar in forbidden position)** — add a module-level
      declaration at the top of `poly_qa`:
      `real :: bad_global !< @unit{'a}`. Save. Expect an **H021
      error** on that line: type variables aren't allowed in module-
      level scope (only in routine arg lists / locals). Undo.
- [ ] **H022 probe (cannot bind tyvar to affine unit)** — change
      Case D's `a_in` annotation to `!< @unit{degC}`. Save. Expect
      an **H022 error** on the `call avg_two(a_in, b_in, out_mean)`
      site (Case D's call) stating that `'a` cannot bind to an
      affine unit and offering a fix hint to convert to the base
      unit (`K`) or pass as a delta. Type variables range over the
      multiplicative algebra only; affine units (degC, degF) inhabit
      a separate layer. Undo.

### Known gaps in this annex

- **Quick-fix coverage** — there's no Polymorphism-specific quick-
  fix today. The existing U002 / U023 / "Add @unit{}" actions still
  apply normally on this file; re-run those steps from the main
  Configurable-delimiters section if needed.
- **Inlay hints** — `dimfort.inlayHints.enabled` is off by default;
  polymorphic vars under inlays render as `'a`. Toggle on and walk
  Case D to confirm if you care about that surface today.
- **Cross-file polymorphism** — this scene is single-file. Add a
  separate `caller.f90` + `lib.f90` pair if cross-file lookup of a
  polymorphic signature needs verifying.
