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
    this.item.backgroundColor = snap.wsStale
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    // Closest VSCode gives us to "dim the dashes": tint the whole item
    // muted when nothing has been computed yet. The "(File 92% · Project
    // –)" case keeps full color so 92% pops; only the all-empty state
    // dims, signalling "no data here yet" at a glance.
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

    // One combined table with File and Project as columns. Headers
    // carry the coverage %; rows are the four tiers. Not-yet-computed
    // scopes get italicised "–" so absence reads dim — the markdown
    // equivalent of the status-bar item's null-state dim.
    const fileHead = s.file
      ? `File ${s.file.coveragePct}%`
      : "_File –_";
    const projHead = s.workspace
      ? `Project ${s.workspace.coveragePct}%${s.wsStale ? " ⚠️" : ""}`
      : "_Project –_";
    md.appendMarkdown(`| | ${fileHead} | ${projHead} |\n`);
    md.appendMarkdown("|---|---|---|\n");
    const cell = (
      scope: { ok: number; warn: number; fire: number; unparsed: number } | null,
      field: "ok" | "warn" | "fire" | "unparsed",
    ): string => scope ? fmtLoc(scope[field]) : "_–_";
    md.appendMarkdown(
      `| 🟢 Verified | ${cell(s.file, "ok")} | ${cell(s.workspace, "ok")} |\n`,
    );
    md.appendMarkdown(
      `| 🟡 Unverified | ${cell(s.file, "warn")} | ${cell(s.workspace, "warn")} |\n`,
    );
    md.appendMarkdown(
      `| 🔴 Violation | ${cell(s.file, "fire")} | ${cell(s.workspace, "fire")} |\n`,
    );
    md.appendMarkdown(
      `| 🔵 Unparsed | ${cell(s.file, "unparsed")} | ${cell(s.workspace, "unparsed")} |\n\n`,
    );

    if (!s.workspace) {
      md.appendMarkdown(
        "_Project coverage not yet computed._ **Click to compute.**",
      );
    } else if (s.wsStale) {
      md.appendMarkdown(
        "⚠️ _Project numbers are stale — files changed since last "
        + "refresh._ **Click to refresh.**",
      );
    } else {
      md.appendMarkdown("_Click to refresh project coverage._");
    }
    return md;
  }
}

/** Format a line count with k-suffix when ≥1000 so tooltip stays readable. */
function fmtLoc(n: number): string {
  if (n < 1000) return `${n} LOC`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k LOC`;
  return `${Math.round(n / 1000)}k LOC`;
}
