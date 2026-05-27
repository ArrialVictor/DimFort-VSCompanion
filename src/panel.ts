import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

// Wire-format mirror of the server's dimfort/panelInfo response.
// See DimFort/docs/design/panel-info.md.
interface ExpressionNode {
  label: string;
  unit: string | null;
  marker: "ok" | "warn" | "error";
  ruleId: string | null;
  children: ExpressionNode[];
}
interface ScopeVar {
  name: string;
  unit: string | null;
  unitNormalized: string | null;
  line: number;
  kind: "annotated" | "unannotated" | "error";
}
interface ScopeSection {
  name: string;
  kind: string;
  vars: ScopeVar[];
}
interface ImportVar {
  name: string;
  unit: string | null;
  unitNormalized: string | null;
  module: string;
  kind: "annotated" | "unannotated";
  file?: string; // source-declaration file (cross-file); absent = this file
  line: number;
  column: number;
}
interface PanelDiagnostic {
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
  line: number;
}
interface PanelInfo {
  expression: ExpressionNode | null;
  scopes: ScopeSection[];
  imports?: ImportVar[];
  diagnostics?: PanelDiagnostic[];
  fileDiagnosticCounts?: { error: number; warning: number };
}

// Wire-format mirror of the server's dimfort/interactions response.
// See DimFort/docs/design/interaction-points.md.
interface InteractionPoint {
  file: string;
  line: number;
  column: number;
  scope: string | null;
  kind: "declares" | "contributes" | "requires" | "uses";
  unit: string; // rendered unit, or "?" when unknown
  snippet: string;
}
interface InteractionConflict {
  code: string;
  message: string;
  file: string;
  line: number;
  column: number;
  site: InteractionPoint;
  reference: InteractionPoint;
}
interface InteractionsReport {
  symbol: string;
  points: InteractionPoint[];
  conflicts: InteractionConflict[];
  hasConflict: boolean;
}

/**
 * WebviewView provider for the DimFort side panel. Mirrors the Neovim
 * panel: an expression-tree section and stacked enclosing-scope
 * declaration tables, cursor-following with a debounce.
 *
 * The provider doesn't own the LanguageClient — the extension hands it
 * in via setClient() on each (re)build, since the client is recreated
 * whenever a setting changes.
 */
export class DimFortPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dimfort.panel";

  private view?: vscode.WebviewView;
  private client?: LanguageClient;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private requestSeq = 0;
  // Code actions available at the current cursor, kept so the panel's
  // Actions buttons can apply them by index when clicked.
  private actions: vscode.CodeAction[] = [];
  private actionDoc?: vscode.TextDocument;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setClient(client: LanguageClient | undefined): void {
    this.client = client;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    // Click-to-navigate: a row in the panel posts {command:"reveal", line}
    // → move the active editor's cursor to that 1-based line and reveal it.
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.command === "reveal" && typeof msg.line === "number") {
        // An interactions row may target a *different* file than the active
        // editor (a symbol's uses span files) — open it first when ``file``
        // is given. Other rows omit it and act on the active editor.
        let editor = vscode.window.activeTextEditor;
        if (typeof msg.file === "string" && msg.file) {
          try {
            const doc = await vscode.workspace.openTextDocument(msg.file);
            editor = await vscode.window.showTextDocument(doc);
          } catch {
            // Fall back to the active editor if the path can't be opened.
          }
        }
        if (!editor) return;
        // 1-based wire coords → 0-based editor coords. Default column 0
        // (scope-var rows send line only); diagnostics send the exact
        // span, so select start→end rather than just placing the cursor.
        const startCol = typeof msg.column === "number" ? Math.max(0, msg.column - 1) : 0;
        const start = new vscode.Position(Math.max(0, msg.line - 1), startCol);
        const end = (typeof msg.endLine === "number" && typeof msg.endColumn === "number")
          ? new vscode.Position(Math.max(0, msg.endLine - 1), Math.max(0, msg.endColumn - 1))
          : start;
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(
          new vscode.Range(start, end),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
        void vscode.window.showTextDocument(editor.document, editor.viewColumn);
      } else if (msg?.command === "action" && typeof msg.index === "number") {
        void this.applyAction(msg.index);
      }
    });
    // Render whatever the cursor is on as soon as the view appears.
    this.scheduleUpdate(0);
    view.onDidChangeVisibility(() => {
      if (view.visible) this.scheduleUpdate(0);
    });
  }

  /** Debounced refresh driven by cursor moves. */
  scheduleUpdate(delayMs: number): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.update(), delayMs);
  }

  private async update(): Promise<void> {
    if (!this.view || !this.view.visible) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "fortran") {
      this.post({ kind: "empty", reason: "no Fortran file active" });
      return;
    }
    if (!this.client) {
      this.post({ kind: "empty", reason: "DimFort server not running" });
      return;
    }
    const pos = editor.selection.active;
    const params = {
      textDocument: { uri: editor.document.uri.toString() },
      position: { line: pos.line, character: pos.character },
    };
    const seq = ++this.requestSeq;
    let result: PanelInfo | null = null;
    try {
      result = await this.client.sendRequest<PanelInfo | null>(
        "dimfort/panelInfo",
        params,
      );
    } catch {
      // Server not ready / request failed — leave the last content.
      return;
    }
    // Drop stale responses if the cursor moved again meanwhile.
    if (seq !== this.requestSeq) return;

    // Cross-site interactions for the symbol under the cursor. Same params
    // (the server resolves the identifier at the position). Best-effort:
    // a failure just omits the section.
    let interactions: InteractionsReport | null = null;
    try {
      interactions = await this.client.sendRequest<InteractionsReport | null>(
        "dimfort/interactions",
        params,
      );
    } catch {
      interactions = null;
    }
    if (seq !== this.requestSeq) return;

    // Code actions available at the cursor — so the Actions section shows
    // exactly what the lightbulb would (Add @unit{} / extract-to-PARAMETER)
    // and the buttons can apply them. Filter to DimFort's own.
    let actions: vscode.CodeAction[] = [];
    try {
      const range = new vscode.Range(pos, pos);
      const got = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider", editor.document.uri, range,
      );
      actions = (got || []).filter(
        (a) =>
          a &&
          (a.command?.command?.startsWith("dimfort.") ||
            /@?unit|PARAMETER/i.test(a.title)),
      );
    } catch {
      actions = [];
    }
    if (seq !== this.requestSeq) return;
    this.actions = actions;
    this.actionDoc = editor.document;
    this.post({
      kind: "data",
      payload: result,
      actions: actions.map((a) => a.title),
      interactions,
    });
  }

  /** Apply the code action the panel's button at ``index`` stands for. */
  private async applyAction(index: number): Promise<void> {
    const a = this.actions[index];
    if (!a) return;
    // Re-focus the document the action targets (the panel click stole focus).
    if (this.actionDoc) {
      await vscode.window.showTextDocument(this.actionDoc, { preserveFocus: false });
    }
    if (a.edit) await vscode.workspace.applyEdit(a.edit);
    if (a.command) {
      await vscode.commands.executeCommand(
        a.command.command, ...(a.command.arguments ?? []),
      );
    }
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2);
    const csp =
      `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}';`;
    // Rendering happens in the webview script: it receives PanelInfo
    // messages and builds the DOM. Styling uses VSCode theme variables
    // so the panel matches the user's colour scheme.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    padding: 8px;
    box-sizing: border-box;
    /* Flex column so the footer can be pushed to the panel's bottom edge
       regardless of how little content is above it. */
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }
  #root { display: flex; flex-direction: column; flex: 1 1 auto; }
  h2 {
    font-size: 1em;
    font-weight: 600;
    margin: 0.4em 0 0.3em;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tree, table { white-space: pre; font-variant-ligatures: none; }
  table { border-collapse: collapse; }
  td { padding: 0 0.6em 0 0; vertical-align: top; }
  td.line { color: var(--vscode-descriptionForeground); text-align: right; }
  td.unit { color: var(--vscode-symbolIcon-unitForeground, var(--vscode-foreground)); }
  td.normalized { color: var(--vscode-descriptionForeground); }
  .diag { white-space: normal; margin: 0.15em 0; line-height: 1.3; }
  .diag-error { color: var(--vscode-editorError-foreground, var(--vscode-errorForeground)); }
  .diag-warning { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  .diag-info, .diag-hint { color: var(--vscode-editorInfo-foreground, var(--vscode-descriptionForeground)); }
  .muted { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  .scope-head { font-weight: 600; margin-top: 0.6em; }
  .scope-filter { width: 100%; box-sizing: border-box; margin: 0.1em 0 0.5em;
            padding: 0.25em 0.45em; font-family: inherit; font-size: 0.95em;
            color: var(--vscode-input-foreground, var(--vscode-foreground));
            background: var(--vscode-input-background, transparent);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 3px; }
  .scope-filter::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 0.7em 0; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  details { margin: 0.2em 0 0.5em; }
  summary { cursor: pointer; font-weight: 600; text-transform: uppercase;
            font-size: 0.85em; letter-spacing: 0.04em;
            color: var(--vscode-descriptionForeground); margin-bottom: 0.3em; }
  .clickable { cursor: pointer; }
  .clickable:hover { text-decoration: underline; }
  tr.clickable:hover td { background: var(--vscode-list-hoverBackground); }
  td.line.clickable { color: var(--vscode-textLink-foreground); }
  button.panel-action { margin: 0.15em 0.3em 0.15em 0; font-size: 0.9em;
            padding: 0.2em 0.7em; cursor: pointer;
            background: var(--vscode-button-secondaryBackground, transparent);
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  button.panel-action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .footer { margin-top: auto; padding: 0.4em 0 0.1em;
            border-top: 1px solid var(--vscode-panel-border);
            color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .section-body { padding-left: 0.8em; }
  .group-label { color: var(--vscode-descriptionForeground); font-weight: 600;
            margin: 0.5em 0 0.15em; }
  .group-body { padding-left: 1.2em; }
  .site { margin: 0.1em 0 0.35em; }
  .site.clickable:hover { background: var(--vscode-list-hoverBackground); }
  .site-loc { color: var(--vscode-textLink-foreground); }
  .site-unit { color: var(--vscode-symbolIcon-unitForeground, var(--vscode-foreground));
            margin-left: 0.7em; }
  .site-snip { opacity: 0.7; white-space: normal; }
</style>
</head>
<body>
<div id="root"><span class="empty">DimFort panel — move the cursor over Fortran code.</span></div>
<script nonce="${nonce}">
const MARK = { ok: "🟢", warn: "🟡", error: "🔴" };
const root = document.getElementById("root");
const vscodeApi = acquireVsCodeApi();

function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));
}

// Jump the editor's cursor to a 1-based (line[, column[, end]]) location
// in the active file; an end selects the span (used for diagnostics).
function revealLine(line, column, endLine, endColumn) {
  if (line) {
    vscodeApi.postMessage({
      command: "reveal", line: line, column: column,
      endLine: endLine, endColumn: endColumn,
    });
  }
}

// Like revealLine but for a possibly-different file (interactions span files).
function revealAt(file, line, column) {
  if (line) {
    vscodeApi.postMessage({ command: "reveal", file: file, line: line, column: column });
  }
}

function baseName(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

// Persisted webview state (across per-cursor-move re-renders, panel
// hide/show, and reload). Merge-patch so fold + active-tab coexist.
function getState() { return (vscodeApi.getState && vscodeApi.getState()) || {}; }
function patchState(p) { if (vscodeApi.setState) vscodeApi.setState({ ...getState(), ...p }); }

// Fold state. Default: open.
const foldState = getState().fold || {};
function setFold(title, open) {
  foldState[title] = open;
  patchState({ fold: foldState });
}

// A foldable section: <details><summary>TITLE</summary> content </details>.
function section(title, contentEl) {
  const d = document.createElement("details");
  d.open = foldState[title] !== false;  // default open
  const s = document.createElement("summary");
  s.textContent = title;
  d.appendChild(s);
  const body = document.createElement("div");
  body.className = "section-body";
  body.appendChild(contentEl);
  d.appendChild(body);
  d.addEventListener("toggle", () => setFold(title, d.open));
  return d;
}

// Action buttons for the code actions available at the cursor. Clicking
// posts the action index back to the provider, which applies it.
function renderActions(titles) {
  const wrap = document.createElement("div");
  if (!titles.length) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "(none)";
    wrap.appendChild(e);
    return wrap;
  }
  titles.forEach((title, i) => {
    const b = document.createElement("button");
    b.className = "panel-action";
    b.textContent = title.replace(/^DimFort:\\s*/, "");
    b.title = title;
    b.addEventListener("click", () => vscodeApi.postMessage({ command: "action", index: i }));
    wrap.appendChild(b);
  });
  return wrap;
}

// Flat footer: whole-file diagnostic counts.
function renderFooter(counts) {
  const f = document.createElement("div");
  f.className = "footer";
  f.textContent = "File: 🔴 " + (counts.error || 0) + "   🟡 " + (counts.warning || 0);
  return f;
}

// Flatten the expression tree into rows with tree-drawing prefixes,
// then align the unit column + markers like the Neovim panel.
function flattenExpr(node, prefix, isLast, isRoot, rows) {
  if (!node) return;
  let connector = "", nextPrefix = prefix;
  if (!isRoot) {
    connector = isLast ? "└── " : "├── ";
    nextPrefix = prefix + (isLast ? "    " : "│   ");
  }
  rows.push({
    tree: prefix + connector + (node.label ?? "?"),
    unit: node.unit,                       // may be null (statements)
    mark: MARK[node.marker] || " ",
    rule: node.ruleId ? " (" + node.ruleId + ")" : "",
  });
  const kids = node.children || [];
  kids.forEach((c, i) => flattenExpr(c, nextPrefix, i === kids.length - 1, false, rows));
}

function renderExpression(node) {
  const rows = [];
  flattenExpr(node, "", true, true, rows);
  const treeW = Math.max(...rows.map(r => r.tree.length), 0);
  const unitW = Math.max(...rows.map(r => (r.unit ? r.unit.length : 0)), 0);
  const lines = rows.map(r => {
    const treePad = " ".repeat(treeW - r.tree.length);
    let mid;
    if (r.unit != null) {
      mid = " : " + r.unit + " ".repeat(unitW - r.unit.length);
    } else if (unitW > 0) {
      mid = " ".repeat(3 + unitW);
    } else {
      mid = "";
    }
    return esc(r.tree + treePad + mid + "  " + r.mark + r.rule);
  });
  const div = document.createElement("div");
  div.className = "tree";
  div.textContent = lines.join("\\n");
  return div;
}

function titlecase(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function renderScope(sc, depth) {
  const wrap = document.createElement("div");
  wrap.style.marginLeft = (depth * 12) + "px";
  const head = document.createElement("div");
  head.className = "scope-head";
  head.textContent = titlecase(sc.kind) + ": " + sc.name;
  wrap.appendChild(head);
  const vars = sc.vars || [];
  if (vars.length === 0) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "  (no declarations)";
    wrap.appendChild(e);
    return wrap;
  }
  const table = document.createElement("table");
  for (const v of vars) {
    const tr = document.createElement("tr");
    // Click the row → jump to the variable's declaration line.
    tr.className = "clickable";
    tr.title = "Go to declaration (line " + v.line + ")";
    tr.addEventListener("click", () => revealLine(v.line));
    const mark =
      v.kind === "unannotated" ? "🟡" : v.kind === "error" ? "🔴" : "🟢";
    // Input unit as written in its own column; the normalized base-SI form
    // in a second, table-aligned column — only when it differs, so scale
    // factors (hPa → 100×kg/(m·s²)) and derived expansions (Pa →
    // kg/(m·s²)) are visible without cluttering base-SI rows (m → m).
    const normText =
      v.unitNormalized && v.unitNormalized !== v.unit ? v.unitNormalized : "";
    const cells = [
      ["line", String(v.line)],
      ["name", v.name],
      ["unit", v.unit ?? "(none)"],
      ["normalized", normText],
      ["mark", mark],
    ];
    for (const [cls, txt] of cells) {
      const td = document.createElement("td");
      td.className = cls === "line" ? "line clickable" : cls;
      td.textContent = txt;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

// Imports: variables + procedures a 'use' clause brings into scope,
// grouped by source module. Each row navigates (cross-file) to where the
// imported symbol — and its @unit{} — is declared. currentImports holds
// the latest payload's imports so the shared filter re-renders without a
// server round-trip (same as the Scope section).
let currentImports = [];
function renderImportsList(container) {
  container.innerHTML = "";
  const q = scopeFilterValue.trim().toLowerCase();
  const imports = q
    ? currentImports.filter((im) =>
        im.name.toLowerCase().includes(q) ||
        (im.unit && im.unit.toLowerCase().includes(q)) ||
        (im.module && im.module.toLowerCase().includes(q)))
    : currentImports;
  if (!imports.length) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = q && currentImports.length
      ? '(no imports match "' + scopeFilterValue + '")'
      : "(none)";
    container.appendChild(e);
    return;
  }
  const byModule = {};
  for (const im of imports) {
    (byModule[im.module] = byModule[im.module] || []).push(im);
  }
  for (const mod of Object.keys(byModule)) {
    const head = document.createElement("div");
    head.className = "scope-head";
    head.textContent = "from " + mod;
    container.appendChild(head);
    // Indent the module's items under its header so the grouping reads
    // as a tree (the "tabulation" of the module's content).
    const table = document.createElement("table");
    table.style.marginLeft = "14px";
    for (const im of byModule[mod]) {
      const tr = document.createElement("tr");
      tr.className = "clickable";
      tr.title = "Go to declaration"
        + (im.file ? " (" + baseName(im.file) + ":" + im.line + ")" : "");
      tr.addEventListener("click", () =>
        im.file ? revealAt(im.file, im.line, im.column)
                : revealLine(im.line, im.column));
      const mark = im.kind === "unannotated" ? "🟡" : "🟢";
      const normText =
        im.unitNormalized && im.unitNormalized !== im.unit ? im.unitNormalized : "";
      // A callable (imported function/subroutine) reads as name(). A
      // subroutine has no return value (callable + no unit + not flagged
      // as a missing annotation) → show "—", not "(none)", which would
      // wrongly imply an un-annotated declaration.
      const unitText = im.unit
        ?? (im.callable && im.kind === "annotated" ? "—" : "(none)");
      const cells = [
        ["name", im.callable ? im.name + "()" : im.name],
        ["unit", unitText],
        ["normalized", normText],
        ["mark", mark],
      ];
      for (const [cls, txt] of cells) {
        const td = document.createElement("td");
        td.className = cls;
        td.textContent = txt;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    container.appendChild(table);
  }
}

// Client-side Scope filter. currentScopes holds the latest payload's
// scopes so re-filtering on keystroke needs no round-trip to the server;
// the query persists (getState) across the per-cursor-move re-renders.
let currentScopes = [];
let scopeFilterValue = getState().scopeFilter || "";

// Populate the container with the scope sections, keeping only variables
// whose name or unit matches the active filter (case-insensitive). Scopes
// with no surviving variables are hidden while a filter is active.
function renderScopeList(container) {
  container.innerHTML = "";
  const q = scopeFilterValue.trim().toLowerCase();
  let shown = 0;
  currentScopes.forEach((sc, i) => {
    const all = sc.vars || [];
    const vars = q
      ? all.filter((v) =>
          v.name.toLowerCase().includes(q) ||
          (v.unit && v.unit.toLowerCase().includes(q)))
      : all;
    if (q && vars.length === 0) { return; }  // hide non-matching scopes
    shown += vars.length;
    container.appendChild(renderScope({ ...sc, vars: vars }, i));
  });
  if (q && shown === 0) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = '(no variables match "' + scopeFilterValue + '")';
    container.appendChild(e);
  }
}

function renderDiagnostics(diags) {
  const wrap = document.createElement("div");
  if (!diags.length) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "(none)";
    wrap.appendChild(e);
    return wrap;
  }
  for (const d of diags) {
    const row = document.createElement("div");
    row.className = "diag clickable diag-" + d.severity;
    // Info/hint use the blue circle so the whole severity family is the same
    // coloured-circle vocabulary (🔴 error / 🟡 warning / 🔵 info) — reusable
    // for any future informational diagnostic, not just P001.
    const glyph = d.severity === "error" ? "🔴"
      : d.severity === "warning" ? "🟡" : "🔵";
    row.textContent = glyph + " " + d.code + ": " + d.message;
    row.title = "Go to the diagnostic";
    row.addEventListener("click", () => revealLine(d.line, d.column, d.endLine, d.endColumn));
    wrap.appendChild(row);
  }
  return wrap;
}

// Interactions: the symbol under the cursor, its use-sites grouped by the
// constraint each places on its unit, and any X001 conflict. Mirrors the
// 'dimfort interactions' CLI. Rows navigate cross-file.
const KIND_LABEL = {
  declares: "Declaration",
  contributes: "Write",
  requires: "Read",
  uses: "Undetermined read",
};
function renderInteractions(rep) {
  const wrap = document.createElement("div");

  // No symbol at the cursor → placeholder (the section stays present).
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

  // Conflicts first — the headline.
  for (const c of rep.conflicts || []) {
    const row = document.createElement("div");
    row.className = "diag clickable diag-error";
    row.textContent = "🔴 " + c.code + ": " + c.message;
    row.title = "Go to " + baseName(c.file) + ":" + c.line;
    row.addEventListener("click", () => revealAt(c.file, c.line, c.column));
    wrap.appendChild(row);
  }

  // All four groups, always present (empty ones show "(none)") so the
  // structure is stable as the cursor moves. Italic labels set the
  // delimiters apart from the site rows.
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
      // Two lines per site: (location  unit) then the dimmed statement.
      const site = document.createElement("div");
      site.className = "site clickable";
      site.title = "Go to " + baseName(p.file) + ":" + p.line
        + (p.scope ? " [" + p.scope + "]" : "");
      site.addEventListener("click", () => revealAt(p.file, p.line, p.column));

      const head = document.createElement("div");
      const loc = document.createElement("span");
      loc.className = "site-loc";
      loc.textContent = baseName(p.file) + ":" + p.line;
      head.appendChild(loc);
      // The Undetermined group has no derived unit by definition — the group
      // label already says so, so don't repeat a "?" on every row.
      if (kind !== "uses") {
        const unit = document.createElement("span");
        unit.className = "site-unit";
        unit.textContent = p.unit;
        head.appendChild(unit);
      }
      site.appendChild(head);

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

function render(payload, actions, interactions) {
  root.innerHTML = "";

  // Order: Expression → Diagnostics → Interactions → Actions → Scope.
  // Volatile (cursor-following) sections near the top, stable Scope lower;
  // the file-wide footer pins the bottom. Each section folds (<details>).

  // Expression.
  let exprContent;
  if (payload && payload.expression) {
    exprContent = renderExpression(payload.expression);
  } else {
    exprContent = document.createElement("div");
    exprContent.className = "muted";
    exprContent.textContent = "(none)";
  }
  root.appendChild(section("Expression", exprContent));

  // Diagnostics for the cursor line — always present (placeholder when
  // the line is clean) so the section doesn't pop in/out.
  const diags = (payload && payload.diagnostics) || [];
  root.appendChild(section("Diagnostics", renderDiagnostics(diags)));

  // Interactions — cross-site unit constraints for the symbol at the cursor.
  // Always present (so it doesn't pop in/out as the cursor moves); shows a
  // placeholder when the cursor isn't on a symbol with cross-site uses.
  root.appendChild(section("Interactions", renderInteractions(interactions)));

  // Actions — code actions available at the cursor (Add @unit{} /
  // extract-to-PARAMETER). Always present (placeholder when none).
  const acts = actions || [];
  root.appendChild(section("Actions", renderActions(acts)));

  // Imports list element — built here so the Scope filter (below) can
  // re-render it too: one query narrows both "what's usable here" views.
  currentImports = (payload && payload.imports) || [];
  const importsList = document.createElement("div");
  renderImportsList(importsList);

  // Scope — stacked enclosing scopes, outermost-first, with a client-side
  // name/unit filter that narrows BOTH Scope and Imports.
  const scopes = (payload && payload.scopes) || [];
  currentScopes = scopes;
  const scopeContent = document.createElement("div");
  if (scopes.length === 0) {
    const e = document.createElement("div");
    e.className = "muted";
    e.textContent = "(file level)";
    scopeContent.appendChild(e);
  } else {
    const filter = document.createElement("input");
    filter.type = "search";
    filter.className = "scope-filter";
    filter.placeholder = "Filter scope & imports by name or unit…";
    filter.value = scopeFilterValue;
    const list = document.createElement("div");
    filter.addEventListener("input", () => {
      scopeFilterValue = filter.value;
      patchState({ scopeFilter: scopeFilterValue });
      renderScopeList(list);
      renderImportsList(importsList);  // shared filter
    });
    scopeContent.appendChild(filter);
    scopeContent.appendChild(list);
    renderScopeList(list);
  }
  root.appendChild(section("Scope", scopeContent));

  // Imports — variables + procedures a 'use' clause brings into scope,
  // grouped by source module. Sits below Scope (both answer "what's
  // usable here") and shares its filter.
  root.appendChild(section("Imports", importsList));

  // Flat footer: whole-file diagnostic counts.
  root.appendChild(renderFooter((payload && payload.fileDiagnosticCounts) || {}));
}

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg.kind === "data") {
    render(msg.payload, msg.actions, msg.interactions);
  } else if (msg.kind === "empty") {
    root.innerHTML = "";
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = msg.reason || "";
    root.appendChild(e);
  }
});
</script>
</body>
</html>`;
  }
}
