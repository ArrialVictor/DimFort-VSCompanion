import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { CoverageStatsProvider, StatsSnapshot } from "./stats";

// VSCode's tab-switch can briefly leave activeTextEditor undefined
// before settling on the new editor. An "empty" post during that
// window flashes the panel to "no Fortran file active" mid-switch.
// Delaying the empty post by this much lets the transition resolve;
// a real update during the delay cancels the empty.
const EMPTY_POST_DELAY_MS = 200;

// Wire-format mirror of the server's dimfort/panelInfo response.
// See DimFort/docs/design/panel-info.md.
interface ExpressionNode {
  label: string;
  unit: string | null;
  marker: "ok" | "warn" | "error";
  // The formal unit this node was expected to satisfy, only set on a
  // call-argument row whose actual dimensionally differs from the
  // formal. Renderers append `(expected <expected>)` to the row.
  expected: string | null;
  // Sibling-arg partner list for an H020 (polymorphic call-site
  // unification failure) row, e.g. "arg 2" or "arg 1, arg 3". When
  // set, the renderer appends `(collides with <collides>)` to the
  // row tail — parallel to `(expected …)` but using the spec's
  // distinct wording for the polymorphism conflict path. Null on
  // every non-H020 row. Server omits the field on pre-0.2.3.1
  // payloads; treat absent as null.
  collides?: string | null;
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
  // Separate timer for "empty" posts so tab-switches don't flash the
  // panel to the empty state during VSCode's brief
  // activeTextEditor-is-undefined transition. Real Fortran content
  // always posts immediately; only the empty state is delayed.
  private emptyTimer?: ReturnType<typeof setTimeout>;
  private requestSeq = 0;
  // Code actions available at the current cursor, kept so the panel's
  // Actions buttons can apply them by index when clicked.
  private actions: vscode.CodeAction[] = [];
  private actionDoc?: vscode.TextDocument;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly statsProvider: CoverageStatsProvider,
  ) {
    // Stats changes drive a footer-only re-render: when the workspace
    // refetch lands, or the active-file stats refresh after a
    // diagnostic-change signal, push the new snapshot to the webview
    // so the bar updates without doing a full panel rebuild.
    this.statsProvider.onDidChange(() => this.postStats());
  }

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

  /**
   * Schedule an "empty" message to land after a short delay rather
   * than posting it immediately.
   *
   * VSCode's tab-switch goes through a brief window where
   * ``activeTextEditor`` is undefined or the new editor's language
   * hasn't resolved yet; an immediate empty post during that window
   * makes the panel flash to "no Fortran file active" between every
   * tab switch. Delaying lets the transition settle: if a real
   * Fortran-content ``update()`` arrives before the timer fires,
   * the empty post is cancelled.
   */
  private scheduleEmptyPost(reason: string): void {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = undefined;
      // Re-check at fire time: another update may have settled on a
      // valid Fortran editor in the meantime.
      const editor = vscode.window.activeTextEditor;
      const stillEmpty =
        !editor ||
        editor.document.languageId !== "fortran" ||
        !this.client;
      if (stillEmpty) {
        this.post({ kind: "empty", reason });
      }
    }, EMPTY_POST_DELAY_MS);
  }

  private async update(): Promise<void> {
    if (!this.view || !this.view.visible) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "fortran") {
      this.scheduleEmptyPost("no Fortran file active");
      return;
    }
    if (!this.client) {
      this.scheduleEmptyPost("DimFort server not running");
      return;
    }
    // Real content path: cancel any pending empty post — VSCode has
    // settled on a Fortran editor with a live client.
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = undefined;
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
      stats: this.statsProvider.snapshot(editor.document.uri.toString()),
    });
  }

  /** Push the current stats snapshot as a footer-only update. */
  private postStats(): void {
    if (!this.view || !this.view.visible) return;
    const active = vscode.window.activeTextEditor;
    const uri = active?.document.languageId === "fortran"
      ? active.document.uri.toString()
      : undefined;
    this.post({ kind: "stats", stats: this.statsProvider.snapshot(uri) });
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
  .diag { white-space: pre-wrap; margin: 0.15em 0; line-height: 1.3; }
  .diag-error { color: var(--vscode-editorError-foreground, var(--vscode-errorForeground)); }
  .diag-warning { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  .diag-info, .diag-hint { color: var(--vscode-editorInfo-foreground, var(--vscode-descriptionForeground)); }
  .muted { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  /* td.unit (one type + one class) has higher specificity than .muted
     (one class), so its colour would otherwise win on a td that has
     both classes. Match it with a type+class selector so muted applies. */
  td.muted { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
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
  /* WS segment in a more-muted foreground when the workspace
     coverage may not reflect current state — pre-first-refresh,
     during an in-flight refresh, or after edits since the last
     refresh. Cleared when fresh post-refresh stats land. */
  .ws-stale { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
              font-style: italic; }
  .section-body { padding-left: 0.8em; }
  .group-label { color: var(--vscode-descriptionForeground); font-weight: 600;
            margin: 0.5em 0 0.15em; }
  .group-body { padding-left: 1.2em; }
  .site { margin: 0.1em 0 0.35em; }
  .site.clickable:hover { background: var(--vscode-list-hoverBackground); }
  .site-loc { color: var(--vscode-textLink-foreground); }
  .site-unit { color: var(--vscode-symbolIcon-unitForeground, var(--vscode-foreground));
            margin-left: 0.7em; }
  /* .site-unit + .muted (same single-class specificity); the later rule
     would win and override muted, so a compound selector lifts the
     specificity so muted takes effect on Interactions unit cells. */
  .site-unit.muted { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  .site-snip { opacity: 0.7; white-space: normal; }
</style>
</head>
<body>
<div id="root"><span class="empty">DimFort panel — move the cursor over Fortran code.</span></div>
<script nonce="${nonce}">
const MARK = { ok: "🟢", assumed: "🔵", warn: "🟡", error: "🔴" };
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

// Coverage stats bar — per-file + workspace coverage %, with raw red /
// yellow tier counts in parentheses. See spec §8.3.1.
//
// W / E diagnostic counts are deliberately not shown here — VSCode's
// own status bar already surfaces them, and reusing the circle
// glyphs for two different referents (line-tier state vs. fired-event
// counts) was the original notation conflict that motivated this
// design.
//
// Collapses to "File: —  ·  WS: —" when the snapshot has nothing
// for the active file and no workspace data yet (snapshot fields are
// all null) — rather than rendering "0% (🟡 0 🔴 0)", which would
// read as "everything is broken."
function renderFooter(stats) {
  const f = document.createElement("div");
  f.className = "footer";
  if (!stats) {
    f.textContent = "File: —  ·  WS: —";
    return f;
  }
  // File segment: always live (cheap), shows "—" only when there's
  // no active Fortran file.
  const fileSpan = document.createElement("span");
  fileSpan.textContent = stats.file
    ? "File: " + stats.file.coveragePct + "% (🟡 " + stats.file.warn + " 🔴 " + stats.file.fire + ")"
    : "File: —";
  f.appendChild(fileSpan);

  // WS segment: manual-only since 0.2.5. The user triggers a
  // refresh via the "DimFort: Refresh Workspace Coverage" palette
  // command; the bar is purely a display surface with no click
  // handler. Three render states:
  //
  //   no refresh yet (workspace === null)  → "WS: –" (em-dash placeholder)
  //   refresh in flight                    → "WS: computing…" (dimmed)
  //   have data                            → "WS: <pct>% (🟡 N 🔴 M)"
  //                                          dimmed when wsStale is set
  //                                          (files edited since the last
  //                                          successful refresh).
  f.appendChild(document.createTextNode("  ·  "));
  const wsSpan = document.createElement("span");
  const ws = stats.workspace;

  if (stats.wsRefreshing) {
    wsSpan.textContent = "WS: computing…";
    wsSpan.classList.add("ws-stale");
    wsSpan.title = "Workspace coverage refresh in progress";
  } else if (!ws) {
    wsSpan.textContent = "WS: –";
    wsSpan.classList.add("ws-stale");
    wsSpan.title =
      "Run 'DimFort: Refresh Workspace Coverage' to compute";
  } else {
    wsSpan.textContent =
      "WS: " + ws.coveragePct + "% (🟡 " + ws.warn + " 🔴 " + ws.fire + ")";
    if (stats.wsStale) {
      wsSpan.classList.add("ws-stale");
      wsSpan.title =
        "Files have changed since this refresh — run "
        + "'DimFort: Refresh Workspace Coverage' to update";
    } else {
      wsSpan.title = "Last refresh result";
    }
  }
  f.appendChild(wsSpan);
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
  // Row tail: '(expected …)' on call-arg / assignment-RHS mismatches,
  // '(collides with …)' on H020 polymorphic-call-site conflicts,
  // '(assumed: <reason>)' on @unit_assume rows. May apply together in
  // principle; concatenate with separating space.
  let extra = "";
  if (node.expected) extra += " (expected " + node.expected + ")";
  if (node.collides) extra += " (collides with " + node.collides + ")";
  if (node.assumed) extra += " (assumed: " + node.assumed + ")";
  rows.push({
    tree: prefix + connector + (node.label ?? "?"),
    unit: node.unit,                       // may be null (statements)
    mark: MARK[node.marker] || " ",
    extra: extra,
  });
  const kids = node.children || [];
  kids.forEach((c, i) => flattenExpr(c, nextPrefix, i === kids.length - 1, false, rows));
}

function renderExpression(node) {
  const rows = [];
  flattenExpr(node, "", true, true, rows);
  const treeW = Math.max(...rows.map(r => r.tree.length), 0);
  const unitW = Math.max(...rows.map(r => (r.unit ? r.unit.length : 0)), 0);
  // Build HTML rather than plain text so the absence glyphs ('?' = unknown,
  // '-' = structural-no-unit) can be wrapped in <span class="muted"> and
  // visually demoted, while real units stay full-weight. .tree carries
  // a pre white-space rule so newlines render as line breaks.
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
  // innerHTML so the <span class="muted"> wrappers for absence glyphs
  // take effect. .tree has white-space: pre so the joined newlines
  // still render as line breaks.
  div.innerHTML = lines.join("\\n");
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
    // factors (hPa → 100×kg·m⁻¹·s⁻²) and derived expansions (Pa →
    // kg·m⁻¹·s⁻²) are visible without cluttering base-SI rows (m → m).
    const normText =
      v.unitNormalized && v.unitNormalized !== v.unit ? v.unitNormalized : "";
    const unitText = v.unit ?? "?";
    const cells = [
      ["line", String(v.line)],
      ["name", v.name],
      ["unit", unitText],
      ["normalized", normText],
      ["mark", mark],
    ];
    for (const [cls, txt] of cells) {
      const td = document.createElement("td");
      let className = cls === "line" ? "line clickable" : cls;
      // Dim absence-of-information glyphs ('?' = unknown, '-' =
      // structural-no-unit) so real units pop visually.
      if (cls === "unit" && (txt === "?" || txt === "-")) {
        className += " muted";
      }
      td.className = className;
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
let importsFilterValue = getState().importsFilter || "";
function renderImportsList(container) {
  container.innerHTML = "";
  const q = importsFilterValue.trim().toLowerCase();
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
      ? '(no imports match "' + importsFilterValue + '")'
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
      // as a missing annotation) → render the structural-no-unit glyph
      // "-", not "?" (which would wrongly imply we don't know).
      // Unannotated declarations get "?" (unknown).
      const unitText = im.unit
        ?? (im.callable && im.kind === "annotated" ? "-" : "?");
      const cells = [
        ["name", im.callable ? im.name + (im.signature ?? "()") : im.name],
        ["unit", unitText],
        ["normalized", normText],
        ["mark", mark],
      ];
      for (const [cls, txt] of cells) {
        const td = document.createElement("td");
        let className = cls;
        // Dim absence-of-information glyphs ('?' = unknown, '-' =
        // structural-no-unit) so real units pop visually.
        if (cls === "unit" && (txt === "?" || txt === "-")) {
          className += " muted";
        }
        td.className = className;
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
  uses: "Undetermined",
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
        // Dim absence-of-information glyphs so real units pop, the same
        // way Scope / Imports / Expression sections do.
        unit.className = (p.unit === "?" || p.unit === "-")
          ? "site-unit muted" : "site-unit";
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

  // Scope — stacked enclosing scopes, outermost-first, with a client-side
  // name/unit filter.
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
    filter.placeholder = "Filter variables by name or unit…";
    filter.value = scopeFilterValue;
    const list = document.createElement("div");
    filter.addEventListener("input", () => {
      scopeFilterValue = filter.value;
      patchState({ scopeFilter: scopeFilterValue });
      renderScopeList(list);
    });
    scopeContent.appendChild(filter);
    scopeContent.appendChild(list);
    renderScopeList(list);
  }
  root.appendChild(section("Scope", scopeContent));

  // Imports — variables + procedures a 'use' clause brings into scope,
  // grouped by source module. Sits below Scope (both answer "what's
  // usable here"); has its own name/unit/module filter, mirroring Scope.
  currentImports = (payload && payload.imports) || [];
  const importsContent = document.createElement("div");
  const importsList = document.createElement("div");
  if (currentImports.length) {
    const ifilter = document.createElement("input");
    ifilter.type = "search";
    ifilter.className = "scope-filter";
    ifilter.placeholder = "Filter imports by name, unit, or module…";
    ifilter.value = importsFilterValue;
    ifilter.addEventListener("input", () => {
      importsFilterValue = ifilter.value;
      patchState({ importsFilter: importsFilterValue });
      renderImportsList(importsList);
    });
    importsContent.appendChild(ifilter);
  }
  importsContent.appendChild(importsList);
  renderImportsList(importsList);
  root.appendChild(section("Imports", importsContent));

  // Coverage stats bar — drawn last so it pins the panel's bottom edge.
  root.appendChild(renderFooter(lastStats));
}

// Cached message state. Kept so a stats-only update can re-render the
// footer without losing the rest of the panel, and so a stats arrival
// during the empty state stays buffered for the next data update.
let lastPayload = null, lastActions = [], lastInteractions = null, lastStats = null;
let isEmpty = true, emptyReason = "";

function repaint() {
  if (isEmpty) {
    root.innerHTML = "";
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = emptyReason || "";
    root.appendChild(e);
    return;
  }
  render(lastPayload, lastActions, lastInteractions);
}

window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg.kind === "data") {
    lastPayload = msg.payload;
    lastActions = msg.actions;
    lastInteractions = msg.interactions;
    if (msg.stats !== undefined) lastStats = msg.stats;
    isEmpty = false;
    repaint();
  } else if (msg.kind === "stats") {
    lastStats = msg.stats;
    // Only the footer changed — but render() rebuilds the whole panel
    // off cached state, which is fast (no DOM measurement, no
    // network), so the simplest path is a full repaint. Skipped
    // entirely while the panel is in its empty state.
    if (!isEmpty) repaint();
  } else if (msg.kind === "empty") {
    isEmpty = true;
    emptyReason = msg.reason || "";
    repaint();
  }
});
</script>
</body>
</html>`;
  }
}
