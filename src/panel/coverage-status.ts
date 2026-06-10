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
    this.item.show();
  }

  /** Compact status-bar text. */
  private formatText(s: StatsSnapshot): string {
    if (s.wsRefreshing) return "$(sync~spin) DimFort: refreshing…";
    if (s.workspace === null) {
      // Never refreshed yet — nudge user to run the command.
      return s.file
        ? `$(graph) DimFort: file ${s.file.coveragePct}% / WS –`
        : "$(graph) DimFort: WS –";
    }
    const ws = s.workspace;
    const filePart = s.file
      ? `file ${s.file.coveragePct}% / `
      : "";
    return `$(graph) DimFort: ${filePart}WS ${ws.coveragePct}%`;
  }

  /** Markdown tooltip with the full breakdown. */
  private formatTooltip(s: StatsSnapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportThemeIcons = true;
    md.appendMarkdown("**DimFort coverage**\n\n");
    if (s.file) {
      md.appendMarkdown(`| File | ${s.file.coveragePct}% |\n`);
      md.appendMarkdown("|---|---|\n");
      md.appendMarkdown(`| 🟢 OK | ${s.file.ok} |\n`);
      md.appendMarkdown(`| 🟡 Warn | ${s.file.warn} |\n`);
      md.appendMarkdown(`| 🔴 Fire | ${s.file.fire} |\n`);
      md.appendMarkdown(`| 🔵 Unparsed | ${s.file.unparsed} |\n\n`);
    } else {
      md.appendMarkdown("_File coverage not yet computed._\n\n");
    }
    if (s.workspace) {
      md.appendMarkdown(`| Workspace | ${s.workspace.coveragePct}% |\n`);
      md.appendMarkdown("|---|---|\n");
      md.appendMarkdown(`| 🟢 OK | ${s.workspace.ok} |\n`);
      md.appendMarkdown(`| 🟡 Warn | ${s.workspace.warn} |\n`);
      md.appendMarkdown(`| 🔴 Fire | ${s.workspace.fire} |\n`);
      md.appendMarkdown(`| 🔵 Unparsed | ${s.workspace.unparsed} |\n\n`);
      if (s.wsStale) {
        md.appendMarkdown(
          "_Workspace numbers are stale — files have changed since the "
          + "last refresh._\n\n",
        );
      }
    } else {
      md.appendMarkdown(
        "_Workspace coverage not yet computed. "
        + "Click to run **DimFort: Refresh Workspace Coverage**._\n",
      );
    }
    md.appendMarkdown("\n_Click to refresh workspace coverage._");
    return md;
  }
}
