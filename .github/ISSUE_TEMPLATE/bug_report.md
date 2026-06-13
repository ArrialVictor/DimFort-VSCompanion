---
name: Bug report
about: A wrong unit verdict, a crash, a panel/hover glitch, or unexpected behaviour
title: ""
labels: bug
---

<!-- The VSCode companion is a thin LSP client; many bugs are actually in
     the DimFort server. The version block below helps route the report. -->

**DimFort server version**: <!-- `dimfort --version` -->
**VSCode companion version**: <!-- Extensions view → DimFort → version -->
**VSCode version**: <!-- Code → About / Code → Help → About -->
**OS**: <!-- macOS 14 / Ubuntu 24.04 / Windows 11 / … -->

**What happened**
<!-- What you saw versus what you expected — a wrong diagnostic, a hover
     popup that's wrong/missing, a panel section glitch, a crash. -->

**Minimal reproducer**
<!-- The smallest Fortran snippet (with the relevant @unit annotations)
     that shows it. A few lines is ideal. -->

```fortran

```

**LSP trace** (very helpful)
<!-- View → Output → choose "DimFort LSP" (or "DimFort") in the dropdown.
     Paste the last ~30–50 lines around the failure. -->

```

```

**Additional context**
<!-- Did this work in a previous version? Project layout / dimfort.toml
     contents if relevant. -->
