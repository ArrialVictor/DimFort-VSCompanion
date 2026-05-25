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
interface PanelDiagnostic {
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
  line: number;
}
interface PanelInfo {
  expression: ExpressionNode | null;
  scopes: ScopeSection[];
  diagnostics?: PanelDiagnostic[];
  fileDiagnosticCounts?: { error: number; warning: number };
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
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.command === "reveal" && typeof msg.line === "number") {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const line = Math.max(0, msg.line - 1);
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
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
  .muted { color: var(--vscode-descriptionForeground); }
  .scope-head { font-weight: 600; margin-top: 0.6em; }
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

// Jump the editor's cursor to a 1-based line in the active file.
function revealLine(line) {
  if (line) vscodeApi.postMessage({ command: "reveal", line: line });
}

// Fold state, persisted across the per-cursor-move re-renders (and across
// panel hide/show + reload via vscode state). Default: open.
const foldState = (vscodeApi.getState && vscodeApi.getState()?.fold) || {};
function setFold(title, open) {
  foldState[title] = open;
  if (vscodeApi.setState) vscodeApi.setState({ fold: foldState });
}

// A foldable section: <details><summary>TITLE</summary> content </details>.
function section(title, contentEl) {
  const d = document.createElement("details");
  d.open = foldState[title] !== false;  // default open
  const s = document.createElement("summary");
  s.textContent = title;
  d.appendChild(s);
  d.appendChild(contentEl);
  d.addEventListener("toggle", () => setFold(title, d.open));
  return d;
}

// Action buttons for the code actions available at the cursor. Clicking
// posts the action index back to the provider, which applies it.
function renderActions(titles) {
  const wrap = document.createElement("div");
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

function renderDiagnostics(diags) {
  const wrap = document.createElement("div");
  for (const d of diags) {
    const row = document.createElement("div");
    row.className = "diag clickable diag-" + d.severity;
    const glyph = d.severity === "error" ? "🔴"
      : d.severity === "warning" ? "🟡" : "ℹ️";
    row.textContent = glyph + " " + d.code + ": " + d.message;
    row.title = "Go to line " + d.line;
    row.addEventListener("click", () => revealLine(d.line));
    wrap.appendChild(row);
  }
  return wrap;
}

function render(payload, actions) {
  root.innerHTML = "";

  // Order: Expression → Diagnostics → Actions → Scope. Volatile
  // (cursor-following) sections near the top, stable Scope lower; the
  // file-wide footer pins the bottom. Each section folds (<details>).

  // Expression.
  let exprContent;
  if (payload && payload.expression) {
    exprContent = renderExpression(payload.expression);
  } else {
    exprContent = document.createElement("div");
    exprContent.className = "empty";
    exprContent.textContent = "(no expression at cursor)";
  }
  root.appendChild(section("Expression", exprContent));

  // Diagnostics for the cursor line — only when the line has any.
  const diags = (payload && payload.diagnostics) || [];
  if (diags.length) {
    root.appendChild(section("Diagnostics", renderDiagnostics(diags)));
  }

  // Actions — code actions available at the cursor (Add @unit{} /
  // extract-to-PARAMETER). Only shown when there's at least one.
  const acts = actions || [];
  if (acts.length) {
    root.appendChild(section("Actions", renderActions(acts)));
  }

  // Scope — stacked enclosing scopes, outermost-first.
  const scopes = (payload && payload.scopes) || [];
  const scopeContent = document.createElement("div");
  if (scopes.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "(file level)";
    scopeContent.appendChild(e);
  } else {
    scopes.forEach((sc, i) => scopeContent.appendChild(renderScope(sc, i)));
  }
  root.appendChild(section("Scope", scopeContent));

  // Flat footer: whole-file diagnostic counts.
  root.appendChild(renderFooter((payload && payload.fileDiagnosticCounts) || {}));
}

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg.kind === "data") {
    render(msg.payload, msg.actions);
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
