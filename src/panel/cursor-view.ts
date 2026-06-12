/**
 * Cursor view — the "what's here" surface.
 *
 * Bundles four cursor-pinned sections together because they all move
 * as one when the editor cursor moves and feel like one thing to the
 * user:
 *
 * - **Expression** — the AST-shaped tree of the expression at the cursor
 *   with per-node units + markers (ok / warn / error).
 * - **Diagnostics** — the dimfort diagnostics on the cursor's line.
 * - **Interactions** — cross-file uses / writes / reads of the
 *   identifier under the cursor, grouped by kind, plus conflicts.
 * - **Actions** — code actions DimFort offers at the cursor, as
 *   clickable buttons that route back to ``coordinator.applyAction``.
 *
 * Splitting these into their own views would have multiplied the
 * Chromium-frame cost for sections that always update together, with
 * no UX win.
 */
import { SectionView } from "./section-view";


export class CursorView extends SectionView {
  public static readonly viewType = "dimfort.cursor";

  protected onCustomMessage(msg: unknown): void {
    const m = msg as { command?: string; index?: number };
    if (m?.command === "action" && typeof m.index === "number") {
      this.actionHandler(m.index);
    }
  }

  /** Set by the coordinator wire-up so the Actions button can call back. */
  public actionHandler: (index: number) => void = () => { /* set later */ };

  protected sectionScript(): string {
    return /* js */ `
const MARK = { ok: "\u{1F7E2}", assumed: "\u{1F535}", warn: "\u{1F7E1}", error: "\u{1F534}" };
const KIND_LABEL = {
  declares: "Declaration",
  contributes: "Write",
  requires: "Read",
  uses: "Undetermined",
};

function baseName(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function revealLine(line, column) {
  if (line) vscodeApi.postMessage({ command: "reveal", line: line, column: column });
}
function revealAt(file, line, column) {
  if (line) vscodeApi.postMessage({ command: "reveal", file: file, line: line, column: column });
}

function flattenExpr(node, prefix, isLast, isRoot, rows) {
  if (!node) return;
  let connector = "", nextPrefix = prefix;
  if (!isRoot) {
    connector = isLast ? "└── " : "├── ";
    nextPrefix = prefix + (isLast ? "    " : "│   ");
  }
  let extra = "";
  if (node.expected) extra += " (expected " + node.expected + ")";
  if (node.collides) extra += " (collides with " + node.collides + ")";
  if (node.assumed) extra += " (assumed: " + node.assumed + ")";
  rows.push({
    tree: prefix + connector + (node.label || "?"),
    unit: node.unit,
    mark: MARK[node.marker] || " ",
    extra: extra,
  });
  const kids = node.children || [];
  kids.forEach((c, i) => flattenExpr(c, nextPrefix, i === kids.length - 1, false, rows));
}

function renderExpression(node) {
  if (!node) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "(no expression at cursor)";
    return e;
  }
  const rows = [];
  flattenExpr(node, "", true, true, rows);
  const treeW = Math.max(...rows.map(r => r.tree.length), 0);
  const unitW = Math.max(...rows.map(r => (r.unit ? r.unit.length : 0)), 0);
  const lines = rows.map(r => {
    const treePad = " ".repeat(treeW - r.tree.length);
    const treeHtml = esc(r.tree + treePad);
    let midHtml;
    if (r.unit != null) {
      const unitPad = " ".repeat(unitW - r.unit.length);
      const dim = r.unit === "?" || r.unit === "-";
      const unbound = !dim && r.unit.length >= 4 && r.unit.substring(r.unit.length - 4) === " = ?";
      const unitHtml = dim
        ? '<span class="muted">' + esc(r.unit) + '</span>'
        : unbound
          ? esc(r.unit.substring(0, r.unit.length - 1)) + '<span class="muted">?</span>'
          : esc(r.unit);
      midHtml = " : " + unitHtml + unitPad;
    } else if (unitW > 0) {
      midHtml = " ".repeat(3 + unitW);
    } else {
      midHtml = "";
    }
    return treeHtml + midHtml + "  " + esc(r.mark + r.extra);
  });
  const div = document.createElement("div");
  div.className = "tree";
  div.innerHTML = lines.join("\\n");
  return div;
}

function renderDiagnostics(diags) {
  const wrap = document.createElement("div");
  if (!diags || !diags.length) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "(none)";
    wrap.appendChild(e);
    return wrap;
  }
  for (const d of diags) {
    const row = document.createElement("div");
    row.className = "diag clickable diag-" + d.severity;
    const glyph = d.severity === "error" ? "\u{1F534}"
      : d.severity === "warning" ? "\u{1F7E1}" : "\u{1F535}";
    row.textContent = glyph + " " + d.code + ": " + d.message;
    row.title = "Go to the diagnostic";
    row.addEventListener("click", () =>
      revealLine(d.line, d.column));
    wrap.appendChild(row);
  }
  return wrap;
}

function renderInteractions(rep) {
  const wrap = document.createElement("div");
  if (!rep || !rep.points || !rep.points.length) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "(none)";
    wrap.appendChild(e);
    return wrap;
  }
  const title = document.createElement("div");
  title.className = "scope-head";
  title.textContent = rep.symbol;
  wrap.appendChild(title);
  for (const c of rep.conflicts || []) {
    const row = document.createElement("div");
    row.className = "diag clickable diag-error";
    row.textContent = "\u{1F534} " + c.code + ": " + c.message;
    row.title = "Go to " + baseName(c.file) + ":" + c.line;
    row.addEventListener("click", () => revealAt(c.file, c.line, c.column));
    wrap.appendChild(row);
  }
  for (const kind of ["declares", "contributes", "requires", "uses"]) {
    const pts = rep.points.filter((p) => p.kind === kind);
    const head = document.createElement("div");
    head.className = "group-label";
    head.textContent = KIND_LABEL[kind];
    wrap.appendChild(head);
    const body = document.createElement("div");
    body.className = "group-body";
    if (!pts.length) {
      const none = document.createElement("div");
      none.className = "muted";
      none.textContent = "(none)";
      body.appendChild(none);
      wrap.appendChild(body);
      continue;
    }
    for (const p of pts) {
      const site = document.createElement("div");
      site.className = "site clickable";
      site.title = "Go to " + baseName(p.file) + ":" + p.line
        + (p.scope ? " [" + p.scope + "]" : "");
      site.addEventListener("click", () => revealAt(p.file, p.line, p.column));
      const head2 = document.createElement("div");
      const loc = document.createElement("span");
      loc.className = "site-loc";
      loc.textContent = baseName(p.file) + ":" + p.line;
      head2.appendChild(loc);
      if (kind !== "uses") {
        const unit = document.createElement("span");
        unit.className = (p.unit === "?" || p.unit === "-")
          ? "site-unit muted" : "site-unit";
        unit.textContent = p.unit;
        head2.appendChild(unit);
      }
      site.appendChild(head2);
      const snip = document.createElement("div");
      snip.className = "site-snip";
      snip.textContent = p.snippet;
      site.appendChild(snip);
      body.appendChild(site);
    }
    wrap.appendChild(body);
  }
  return wrap;
}

function renderActions(titles) {
  const wrap = document.createElement("div");
  if (!titles || !titles.length) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "(none)";
    wrap.appendChild(e);
    return wrap;
  }
  titles.forEach((title, i) => {
    const b = document.createElement("button");
    b.className = "panel-action";
    b.textContent = String(title).replace(/^DimFort:\\s*/, "");
    b.title = title;
    b.addEventListener("click", () => vscodeApi.postMessage({ command: "action", index: i }));
    wrap.appendChild(b);
  });
  return wrap;
}

function section(title, contentEl) {
  // The whole Cursor view collapses via the native VSCode chevron;
  // nested foldables would just be visual noise. Render each
  // subsection as a flat header + body — same heading style as the
  // legacy panel's <summary> for visual continuity.
  const wrap = document.createElement("div");
  wrap.className = "subsection";
  const head = document.createElement("div");
  head.className = "subsection-head";
  head.textContent = title;
  wrap.appendChild(head);
  const body = document.createElement("div");
  body.className = "subsection-body";
  body.appendChild(contentEl);
  wrap.appendChild(body);
  return wrap;
}

let lastPayload = null;
let lastActions = [];
let lastInteractions = null;
let isEmpty = false;
let emptyReason = "";

function repaint() {
  root.innerHTML = "";
  if (isEmpty) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = emptyReason || "(no active Fortran file)";
    root.appendChild(e);
    return;
  }
  if (!lastPayload) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "(waiting for cursor data)";
    root.appendChild(e);
    return;
  }
  root.appendChild(section("Expression",   renderExpression(lastPayload.expression)));
  root.appendChild(section("Diagnostics",  renderDiagnostics(lastPayload.diagnostics || [])));
  root.appendChild(section("Interactions", renderInteractions(lastInteractions)));
  root.appendChild(section("Actions",      renderActions(lastActions)));
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.kind === "data") {
    lastPayload = m.payload;
    lastActions = m.actions || [];
    lastInteractions = m.interactions || null;
    isEmpty = !!m.isEmpty;
    repaint();
  } else if (m.kind === "empty") {
    isEmpty = true;
    emptyReason = m.reason || "";
    lastPayload = null;
    repaint();
  }
});
repaint();
`;
  }

  protected extraStyles(): string {
    return `
  .diag { white-space: pre-wrap; margin: 0.15em 0; line-height: 1.3; }
  .group-label { color: var(--vscode-descriptionForeground); font-weight: 600;
    margin: 0.5em 0 0.15em; }
  .group-body { padding-left: 1.2em; }
  .site { margin: 0.1em 0 0.35em; }
  .site.clickable:hover { background: var(--vscode-list-hoverBackground); }
  .site-loc { color: var(--vscode-textLink-foreground); }
  .site-unit { color: var(--vscode-symbolIcon-unitForeground, var(--vscode-foreground));
    margin-left: 0.7em; }
  /* .site-unit + .muted (same single-class specificity); the later
     .site-unit rule would otherwise win — lift muted's specificity
     via a compound selector so Interactions unit cells dim correctly. */
  .site-unit.muted { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  .site-snip { opacity: 0.7; white-space: normal; }
  .subsection { margin: 0.2em 0 0.5em; }
  .subsection-head { font-weight: 600; text-transform: uppercase;
    font-size: 0.85em; letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground); margin-bottom: 0.3em; }
  /* Indent subsection bodies under the uppercase headers so
     EXPRESSION / DIAGNOSTICS / INTERACTIONS / ACTIONS visually own
     their content; previously rows were flush-left with the
     headers (multi-view refactor regression). */
  .subsection-body { padding-left: 1.2em; }
    `;
  }
}
