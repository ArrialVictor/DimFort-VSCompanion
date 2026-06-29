#!/usr/bin/env python3
"""Silent-failure regression gate (TypeScript).

Mirrors the DimFort server-side gate, adapted to TypeScript:

  1. **Hard bans** (always fail) — empty ``catch`` blocks in
     ``src/**/*.ts``. Empty bodies swallow errors without any signal;
     classify the failure (silent-OK with an ``audited(0.2.X)``
     comment, log it, or surface a notification).

  2. **Annotation requirement on new additions** (diff-aware) —
     ``catch`` blocks introduced in a PR must carry an
     ``audited(0.2.X)`` annotation within ±5 lines. Existing
     un-annotated occurrences are not flagged.

Companion of ``DimFort/scripts/silent_failure_gate.py``. See
``docs/silent-failure-audit.md`` for the audit baseline this guards.

Exit codes
----------
0  Gate passes.
1  One or more findings; details printed to stderr.

Usage
-----
::

    python scripts/silent-failure-gate.py
    BASE_REF=origin/main python scripts/silent-failure-gate.py
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCAN_DIR = ROOT / "src"
ANNOTATION = re.compile(r"audited\(0\.2\.\d+\)")
WINDOW = 5  # lines of context to search for the annotation


# Hard-banned shape: empty catch body. Matched against the full file
# text to handle multi-line cases.
EMPTY_CATCH = re.compile(
    r"\}\s*catch\s*(\([^)]*\))?\s*\{\s*\}",
)


# Diff-aware: any new `catch (...)` must carry the annotation nearby.
NEW_CATCH = re.compile(r"\}\s*catch\b")


def hard_ban_findings() -> list[tuple[Path, int, str, str]]:
    out: list[tuple[Path, int, str, str]] = []
    for path in SCAN_DIR.rglob("*.ts"):
        text = path.read_text(encoding="utf-8")
        for m in EMPTY_CATCH.finditer(text):
            lineno = text.count("\n", 0, m.start()) + 1
            snippet = m.group(0).replace("\n", " ").strip()
            out.append(
                (
                    path,
                    lineno,
                    "empty `catch` block — annotate `audited(0.2.X)` "
                    "with rationale or add real handling",
                    snippet,
                )
            )
    return out


def annotation_findings_in_diff(base_ref: str) -> list[tuple[Path, int, str, str]]:
    """Find new `catch` block openings that lack a nearby annotation."""
    cmd = [
        "git",
        "diff",
        "--unified=0",
        "--no-color",
        f"{base_ref}...HEAD",
        "--",
        "src/**/*.ts",
    ]
    try:
        diff = subprocess.check_output(cmd, cwd=ROOT, text=True)
    except subprocess.CalledProcessError as exc:
        print(f"silent-failure-gate: git diff failed ({exc})", file=sys.stderr)
        sys.exit(2)

    findings: list[tuple[Path, int, str, str]] = []
    current_path: Path | None = None
    current_line = 0
    for raw in diff.splitlines():
        if raw.startswith("+++ b/"):
            current_path = ROOT / raw[6:]
        elif raw.startswith("@@"):
            m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", raw)
            if m:
                current_line = int(m.group(1)) - 1
        elif raw.startswith("+") and not raw.startswith("+++"):
            current_line += 1
            line = raw[1:]
            if NEW_CATCH.search(line):
                if current_path is None or not current_path.exists():
                    continue
                text = current_path.read_text(encoding="utf-8")
                lines = text.splitlines()
                lo = max(0, current_line - 1 - WINDOW)
                hi = min(len(lines), current_line + WINDOW)
                window = "\n".join(lines[lo:hi])
                if not ANNOTATION.search(window):
                    findings.append(
                        (
                            current_path,
                            current_line,
                            "new `catch` block without `audited(0.2.X)` "
                            "annotation within ±5 lines",
                            line.strip(),
                        )
                    )
        elif raw.startswith(" "):
            current_line += 1

    return findings


def main() -> int:
    failures = hard_ban_findings()
    base_ref = os.environ.get("BASE_REF")
    if base_ref:
        failures.extend(annotation_findings_in_diff(base_ref))

    if not failures:
        print("silent-failure-gate: OK")
        return 0

    print(
        "silent-failure-gate: FAILED — the following patterns regress the "
        "0.2.7 silent-failure audit:",
        file=sys.stderr,
    )
    for path, lineno, desc, content in failures:
        rel = path.relative_to(ROOT)
        truncated = content if len(content) <= 100 else content[:97] + "..."
        print(f"  {rel}:{lineno}  [{desc}]", file=sys.stderr)
        print(f"    {truncated}", file=sys.stderr)
    print(
        "\nFix: classify each finding (silent-OK with rationale, or "
        "surface the failure with showErrorMessage / log / etc.), then "
        "add `audited(0.2.X): <classification> — <reason>` in the catch "
        "block. See docs/silent-failure-audit.md for the audit baseline "
        "and resolution templates.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
