/**
 * Base class for each section view in the multi-view DimFort panel.
 *
 * Owns:
 * - Webview lifecycle (``resolveWebviewView``).
 * - Generic ``reveal`` click handler so any row a section renders with
 *   ``vscodeApi.postMessage({command: "reveal", line, column?, file?})``
 *   jumps the editor to that position. Cross-file ``file`` is supported
 *   for interactions-style rows that may target a different document.
 * - HTML scaffold + shared CSS pulled from VSCode theme variables.
 * - Subscriber wiring: the coordinator calls ``onData`` / ``onEmpty`` /
 *   ``onStats`` / ``onSortModes`` and the base class re-broadcasts to
 *   the webview after queueing or rendering.
 *
 * Subclasses provide:
 * - ``viewType`` (static) — must match a ``contributes.views`` id.
 * - ``sectionScript()`` — the per-view JS that listens for ``"render"``
 *   messages and rebuilds the section's DOM. Receives ``state`` already
 *   sliced to what the section cares about.
 * - Optional overrides for ``onData`` / ``onEmpty`` / ``onStats`` /
 *   ``onSortModes`` when the default broadcast isn't enough.
 */
import * as vscode from "vscode";

import type {
  PanelPayload,
  SortMode,
} from "./types";


/** A subscriber the ``PanelCoordinator`` broadcasts to. */
export interface PanelSubscriber {
  onData(payload: PanelPayload): void;
  onEmpty(reason: string): void;
  onStats(snapshot: unknown): void;
  onSortModes(modes: { scope: SortMode; imports: SortMode }): void;
}


export abstract class SectionView
  implements vscode.WebviewViewProvider, PanelSubscriber
{
  protected view?: vscode.WebviewView;
  /** Last payload received before the webview was resolved, replayed on resolve. */
  private pending: { kind: string; [k: string]: unknown }[] = [];

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.command === "reveal" && typeof msg.line === "number") {
        await this.handleReveal(msg);
      } else {
        this.onCustomMessage(msg);
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.flushPending();
    });
    this.flushPending();
  }

  /** Hook for subclass-specific webview messages beyond ``reveal``. */
  protected onCustomMessage(_msg: unknown): void { /* default no-op */ }

  private async handleReveal(msg: {
    line: number; column?: number; file?: string;
    endLine?: number; endColumn?: number;
  }): Promise<void> {
    let editor = vscode.window.activeTextEditor;
    if (typeof msg.file === "string" && msg.file) {
      try {
        const doc = await vscode.workspace.openTextDocument(msg.file);
        editor = await vscode.window.showTextDocument(doc);
      } catch {
        // Fall back to the active editor when the path can't be opened.
      }
    }
    if (!editor) return;
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
  }

  // ---------------------------------------------------------------------
  // Coordinator → view broadcast
  // ---------------------------------------------------------------------

  onData(payload: PanelPayload): void {
    this.post({ kind: "data", ...payload, isEmpty: false });
  }

  onEmpty(reason: string): void {
    this.post({ kind: "empty", reason, isEmpty: true });
  }

  onStats(snapshot: unknown): void {
    this.post({ kind: "stats", stats: snapshot });
  }

  onSortModes(modes: { scope: SortMode; imports: SortMode }): void {
    this.post({ kind: "sortModes", scope: modes.scope, imports: modes.imports });
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  protected post(msg: Record<string, unknown> & { kind: string }): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    } else {
      this.pending.push(msg);
    }
  }

  private flushPending(): void {
    if (!this.view) return;
    const queued = this.pending;
    this.pending = [];
    for (const msg of queued) {
      void this.view.webview.postMessage(msg);
    }
  }

  // ---------------------------------------------------------------------
  // HTML scaffold
  // ---------------------------------------------------------------------

  /** Per-section render script — see ``cursor-view.ts`` for the
   *  canonical example.
   */
  protected abstract sectionScript(): string;

  /** Optional extra CSS appended to the shared baseline. */
  protected extraStyles(): string { return ""; }

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
  td { padding: 1px 6px 1px 0; vertical-align: top; }
  .muted { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  td.muted { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  .scope-head { font-weight: 600; margin-top: 0.4em; }
  .clickable { cursor: pointer; }
  .clickable:hover { text-decoration: underline; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .tree { white-space: pre; }
  .diag { margin: 0.2em 0; }
  .diag-error   { color: var(--vscode-errorForeground); }
  .diag-warning { color: var(--vscode-editorWarning-foreground); }
  .diag-info    { color: var(--vscode-editorInfo-foreground); }
  .diag-hint    { color: var(--vscode-editorInfo-foreground); }
  .panel-action {
    display: block; width: 100%; margin: 0.15em 0;
    padding: 0.25em 0.45em; text-align: left;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    font: inherit; cursor: pointer;
  }
  .panel-action:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  .filter-input { width: 100%; box-sizing: border-box; margin: 0 0 0.4em;
    padding: 0.25em 0.45em; font: inherit;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    background: var(--vscode-input-background, transparent);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 3px;
  }
  ${this.extraStyles()}
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const root = document.getElementById("root");
function getState() { return (vscodeApi.getState && vscodeApi.getState()) || {}; }
function patchState(p) { if (vscodeApi.setState) vscodeApi.setState({ ...getState(), ...p }); }
function reveal(line, column, file) {
  vscodeApi.postMessage({ command: "reveal", line: line, column: column, file: file });
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;",
}[c])); }
${this.sectionScript()}
</script>
</body>
</html>`;
  }
}
