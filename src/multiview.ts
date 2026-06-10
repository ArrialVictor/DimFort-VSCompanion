/**
 * Multi-view panel POC (0.2.6 plan #10).
 *
 * Splits the Scope and Diagnostics sections of the main DimFort
 * side panel into independently-registered VSCode views inside the
 * `dimfort` activity-bar container. Goals of the experiment:
 *
 * - Confirm that each section can be collapsed, hidden, or dragged
 *   to the bottom panel / secondary sidebar **independently**, native
 *   to VSCode (no in-webview chrome required).
 * - Reuse the cursor-driven payload pipeline owned by
 *   `DimFortPanelProvider` so the new views don't pay an extra LSP
 *   round-trip — they subscribe to the same messages the main panel
 *   webview already receives.
 *
 * Scope-of-experiment limits:
 * - Only Scope + Diagnostics are split out. Expression, Interactions,
 *   Actions, Imports, Coverage-bar stay in the main `dimfort.panel`
 *   webview. If the UX feels right we lift the rest over in a
 *   follow-up.
 * - The main panel **still renders** its own Scope + Diagnostics
 *   sections so the user can compare side-by-side during the smoke
 *   walk. Production version would skip them in the main panel.
 * - State coupling: filter inputs and sort modes are NOT shared yet —
 *   the new views render unfiltered, sort by source line. The full
 *   refactor would broker shared state via the extension.
 */

import * as vscode from "vscode";
import { PanelSubscriber } from "./panel";

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

interface DataPayload {
  scopes?: ScopeSection[];
  diagnostics?: PanelDiagnostic[];
}

interface DataMsg {
  kind: "data";
  payload: DataPayload;
}

interface EmptyMsg {
  kind: "empty";
  reason?: string;
}

type RelayedMsg = DataMsg | EmptyMsg | { kind: string };

function isData(m: RelayedMsg): m is DataMsg { return m.kind === "data"; }
function isEmpty(m: RelayedMsg): m is EmptyMsg { return m.kind === "empty"; }


/**
 * Base class for a section-specific view provider.
 *
 * Subclasses pick the slice of the panel payload they care about and
 * supply the per-section HTML template. The base class owns the
 * webview lifecycle, message dispatch, and click-to-reveal handler.
 */
abstract class SectionViewProvider
  implements vscode.WebviewViewProvider, PanelSubscriber
{
  protected view?: vscode.WebviewView;
  protected lastPayload: DataPayload | null = null;
  protected isEmpty = false;
  protected emptyReason = "";

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.command === "reveal" && typeof msg.line === "number") {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const col = typeof msg.column === "number" ? Math.max(0, msg.column - 1) : 0;
        const pos = new vscode.Position(Math.max(0, msg.line - 1), col);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
        void vscode.window.showTextDocument(editor.document, editor.viewColumn);
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.repaint();
    });
    this.repaint();
  }

  onPanelMessage(msg: unknown): void {
    const m = msg as RelayedMsg;
    if (isData(m)) {
      this.lastPayload = m.payload;
      this.isEmpty = false;
      this.repaint();
    } else if (isEmpty(m)) {
      this.isEmpty = true;
      this.emptyReason = m.reason ?? "";
      this.lastPayload = null;
      this.repaint();
    }
  }

  protected repaint(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({
      kind: "render",
      payload: this.lastPayload,
      isEmpty: this.isEmpty,
      emptyReason: this.emptyReason,
    });
  }

  protected abstract sectionScript(): string;

  protected html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2);
    const csp =
      `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; margin: 0; padding: 0.4em 0.6em;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 1px 6px 1px 0; }
  .muted { color: var(--vscode-descriptionForeground); }
  .scope-head { font-weight: 600; margin-top: 0.4em; }
  .clickable { cursor: pointer; }
  .clickable:hover { text-decoration: underline; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .diag { margin: 0.2em 0; }
  .diag-error { color: var(--vscode-errorForeground); }
  .diag-warning { color: var(--vscode-editorWarning-foreground); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const root = document.getElementById("root");
function reveal(line, column) {
  vscodeApi.postMessage({ command: "reveal", line: line, column: column });
}
${this.sectionScript()}
window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.kind === "render") render(m.payload, m.isEmpty, m.emptyReason);
});
</script>
</body>
</html>`;
  }
}


/** Per-section view: Scope. */
export class DimFortScopeViewProvider extends SectionViewProvider {
  public static readonly viewType = "dimfort.scope";

  protected sectionScript(): string {
    return /* js */ `
function render(payload, isEmpty, emptyReason) {
  root.innerHTML = "";
  if (isEmpty) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = emptyReason || "(no active Fortran file)";
    root.appendChild(e);
    return;
  }
  if (!payload || !payload.scopes || payload.scopes.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "(no enclosing scope at cursor)";
    root.appendChild(e);
    return;
  }
  function titlecase(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
  payload.scopes.forEach((sc, depth) => {
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
    } else {
      const table = document.createElement("table");
      for (const v of vars) {
        const tr = document.createElement("tr");
        tr.className = "clickable";
        tr.title = "Go to declaration (line " + v.line + ")";
        tr.addEventListener("click", () => reveal(v.line));
        const mark = v.kind === "unannotated" ? "\u{1F7E1}"
          : v.kind === "error" ? "\u{1F534}" : "\u{1F7E2}";
        const unitText = v.unit || "?";
        const cells = [
          ["line", String(v.line)],
          ["name", v.name],
          ["unit", unitText],
          ["mark", mark],
        ];
        for (const [cls, txt] of cells) {
          const td = document.createElement("td");
          td.className = cls;
          if (cls === "unit" && (txt === "?" || txt === "-")) {
            td.classList.add("muted");
          }
          td.textContent = txt;
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      wrap.appendChild(table);
    }
    root.appendChild(wrap);
  });
}
`;
  }
}


/** Per-section view: Diagnostics. */
export class DimFortDiagnosticsViewProvider extends SectionViewProvider {
  public static readonly viewType = "dimfort.diagnostics";

  protected sectionScript(): string {
    return /* js */ `
function render(payload, isEmpty, emptyReason) {
  root.innerHTML = "";
  if (isEmpty) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = emptyReason || "(no active Fortran file)";
    root.appendChild(e);
    return;
  }
  const diags = (payload && payload.diagnostics) || [];
  if (diags.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "(no diagnostics on this line)";
    root.appendChild(e);
    return;
  }
  for (const d of diags) {
    const row = document.createElement("div");
    row.className = "diag clickable diag-" + d.severity;
    const glyph = d.severity === "error" ? "\u{1F534}"
      : d.severity === "warning" ? "\u{1F7E1}" : "\u{1F535}";
    row.textContent = glyph + " " + d.code + ": " + d.message;
    row.title = "Go to the diagnostic";
    row.addEventListener("click", () => reveal(d.line));
    root.appendChild(row);
  }
}
`;
  }
}
