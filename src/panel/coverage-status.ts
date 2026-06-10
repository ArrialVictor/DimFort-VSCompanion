/**
 * Coverage stats as a true VSCode status-bar footer.
 *
 * Replaces the in-webview footer that lived at the bottom of the
 * legacy single-view panel. Native status-bar item:
 *
 * - Always visible at the bottom of the window (across all editors,
 *   even when the side panel is hidden).
 * - Compact text: workspace coverage %, with tier counts.
 * - Hover tooltip carries the full per-file + workspace breakdown.
 * - Click triggers ``DimFort: Refresh Workspace Coverage``.
 * - Warning-tinted background while the workspace numbers are stale.
 * - Sync-spinner glyph while a refresh is in flight.
 *
 * Zero Chromium-frame cost — pure native chrome.
 */
import * as vscode from "vscode";

import type { CoverageStatsProvider, StatsSnapshot } from "../stats";


export class CoverageStatusFooter implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly statsProvider: CoverageStatsProvider) {
    // Right-aligned, priority 50 — sits left of the editor mode / line:col
    // (those run priorities ~ -100..0) so we don't push core indicators.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 50,
    );
    this.item.command = "dimfort.refreshWorkspace";
    this.disposables.push(this.item);
    this.disposables.push(
      this.statsProvider.onDidChange(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );
    this.refresh();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  private refresh(): void {
    const active = vscode.window.activeTextEditor;
    const isFortran = active?.document.languageId === "fortran";
    if (!isFortran) {
      this.item.hide();
      return;
    }
    const snap = this.statsProvider.snapshot(active!.document.uri.toString());
    this.item.text = this.formatText(snap);
    this.item.tooltip = this.formatTooltip(snap);
    // Background tint was too loud for a stale signal — staleness is
    // informational, not a real warning. The $(warning) codicon next
    // to "Project" carries the at-a-glance message; tooltip italics
    // dim the affected numbers; that's enough.
    this.item.backgroundColor = undefined;
    this.item.color = (snap.file === null && snap.workspace === null)
      ? new vscode.ThemeColor("descriptionForeground")
      : undefined;
    this.item.show();
  }

  /** Compact status-bar text. */
  private formatText(s: StatsSnapshot): string {
    if (s.wsRefreshing) return "$(sync~spin) DimFort: refreshing…";
    if (s.workspace === null) {
      return s.file
        ? `DimFort: File ${s.file.coveragePct}% · Project –`
        : "DimFort: Project –";
    }
    const ws = s.workspace;
    const filePart = s.file
      ? `File ${s.file.coveragePct}% · `
      : "";
    // Codicon prefix when stale: gives an at-a-glance "this number may
    // be old" signal in addition to the warning background tint
    // (which can be theme-subtle). Together they cover users on dark
    // themes where the warning background blends in.
    // Codicon attaches directly to "Project" — staleness targets the
    // project number specifically, not "DimFort coverage overall", so
    // anchor the warning right where it applies. Also still tints the
    // whole item's background as a glance-level backup.
    const projectWarning = s.wsStale ? "$(warning) " : "";
    return `DimFort: ${filePart}${projectWarning}Project ${ws.coveragePct}%`;
  }

  /** Markdown tooltip with the full breakdown. */
  private formatTooltip(s: StatsSnapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportThemeIcons = true;
    md.appendMarkdown("**DimFort coverage**\n\n");

    // One combined table. Headers stay clean ("File" / "Project"); the
    // % moves to its own "Coverage" row so it reads as a metric like
    // every tier row below. Project column dims via italics when stale.
    // ``&nbsp;`` padding around values widens the column-gutter — VSCode
    // markdown tables don't expose cell padding directly, so we pad the
    // content. Triple non-breaking spaces sit visibly without growing
    // the table unreasonably.
    const projDim = s.workspace !== null && s.wsStale;
    const dim = (txt: string): string => projDim ? `_${txt}_` : txt;
    const pad = (value: string): string => `&nbsp;&nbsp;&nbsp;${value}&nbsp;&nbsp;&nbsp;`;
    // Four columns: bullet | label | File | Project. Splitting the
    // bullet into its own column means "Coverage" (no bullet) and the
    // four tier rows all share the same label-column start position,
    // instead of "Coverage" hanging left of the bulleted rows.
    // Center-align numeric columns; headers and body share the rule.
    md.appendMarkdown("|  |  | File | Project |\n");
    md.appendMarkdown("|---|---|:---:|:---:|\n");
    const filePct = s.file ? `${s.file.coveragePct}%` : "_–_";
    const projPct = s.workspace ? dim(`${s.workspace.coveragePct}%`) : "_–_";
    md.appendMarkdown(`|  | Coverage | ${pad(filePct)} | ${pad(projPct)} |\n`);
    const cell = (
      scope: { ok: number; warn: number; fire: number; unparsed: number } | null,
      field: "ok" | "warn" | "fire" | "unparsed",
      stale: boolean,
    ): string => {
      if (scope === null) return "_–_";
      const text = fmtCount(scope[field]);
      return stale ? `_${text}_` : text;
    };
    md.appendMarkdown(
      `| 🟢 | Verified | ${pad(cell(s.file, "ok", false))} | ${pad(cell(s.workspace, "ok", projDim))} |\n`,
    );
    md.appendMarkdown(
      `| 🟡 | Unverified | ${pad(cell(s.file, "warn", false))} | ${pad(cell(s.workspace, "warn", projDim))} |\n`,
    );
    md.appendMarkdown(
      `| 🔴 | Violation | ${pad(cell(s.file, "fire", false))} | ${pad(cell(s.workspace, "fire", projDim))} |\n`,
    );
    md.appendMarkdown(
      `| 🔵 | Unparsed | ${pad(cell(s.file, "unparsed", false))} | ${pad(cell(s.workspace, "unparsed", projDim))} |\n\n`,
    );

    if (!s.workspace) {
      md.appendMarkdown(
        "_Project coverage not yet computed._ **Click to compute.**",
      );
    } else if (s.wsStale) {
      // Short two-line prompt so the card stays narrow.
      md.appendMarkdown(
        "_Files changed since last refresh._\n\n"
        + "**Click to refresh.**",
      );
    } else {
      md.appendMarkdown("_Click to refresh project coverage._");
    }
    return md;
  }
}

/** Format a line count with k-suffix when ≥1000 so tooltip stays readable. */
function fmtCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
