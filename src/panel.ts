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
interface PanelInfo {
  expression: ExpressionNode | null;
  scopes: ScopeSection[];
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

  constructor(private readonly extensionUri: vscode.Uri) {}

  setClient(client: LanguageClient | undefined): void {
    this.client = client;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
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
    this.post({ kind: "data", payload: result });
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
  body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    padding: 8px;
  }
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
  .muted { color: var(--vscode-descriptionForeground); }
  .scope-head { font-weight: 600; margin-top: 0.6em; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 0.7em 0; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
<div id="root"><span class="empty">DimFort panel — move the cursor over Fortran code.</span></div>
<script nonce="${nonce}">
const MARK = { ok: "🟢", warn: "🟡", error: "🔴" };
const root = document.getElementById("root");

function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));
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
    const mark =
      v.kind === "unannotated" ? "🟡" : v.kind === "error" ? "🔴" : "🟢";
    // Show the input unit as written; append the normalized base-SI form
    // when it differs, so scale factors (hPa = 100×kg/(m·s²)) and derived
    // expansions (Pa = kg/(m·s²)) are visible instead of hidden.
    let unitText = v.unit ?? "(none)";
    if (v.unitNormalized && v.unitNormalized !== v.unit) {
      unitText = v.unit + " = " + v.unitNormalized;
    }
    const cells = [
      ["line", String(v.line)],
      ["name", v.name],
      ["unit", unitText],
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
  wrap.appendChild(table);
  return wrap;
}

function render(payload) {
  root.innerHTML = "";
  // Expression section.
  const exprHead = document.createElement("h2");
  exprHead.textContent = "Expression";
  root.appendChild(exprHead);
  if (payload && payload.expression) {
    root.appendChild(renderExpression(payload.expression));
  } else {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "(no expression at cursor)";
    root.appendChild(e);
  }
  root.appendChild(document.createElement("hr"));
  // Scope sections, stacked outermost-first.
  const scopes = (payload && payload.scopes) || [];
  if (scopes.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Scope: (file level)";
    root.appendChild(e);
  } else {
    scopes.forEach((sc, i) => root.appendChild(renderScope(sc, i)));
  }
}

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg.kind === "data") {
    render(msg.payload);
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
