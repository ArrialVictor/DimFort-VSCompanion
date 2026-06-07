import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

// Wire-format mirror of the server's dimfort/coverageStats response.
// See DimFort/docs/design/future/coverage-visualization.md §8.2.
interface StatsRow {
  uri: string;
  ok: number;
  warn: number;
  fire: number;
  unparsed: number;
  out: number;
  coverage_pct: number;
}
interface StatsTotal {
  ok: number;
  warn: number;
  fire: number;
  unparsed: number;
  out: number;
  coverage_pct: number;
}
interface StatsResponse {
  scope: "file" | "workspace";
  uri?: string;
  files: StatsRow[];
  total: StatsTotal;
  // Present on workspace scope; True if the cached aggregate is
  // out of date or a background refresh is in flight.
  ws_stale?: boolean;
}

export type WorkspaceStatsMode = "disabled" | "manual" | "automatic";

// Companion-side rendering shape consumed by the panel webview footer.
// Fields use camelCase to match the surrounding TS style; the snake_case
// `coverage_pct` from the server is renamed on the boundary.
export interface FileCoverage {
  ok: number;
  warn: number;
  fire: number;
  unparsed: number;
  coveragePct: number;
}
export interface WorkspaceCoverage {
  ok: number;
  warn: number;
  fire: number;
  unparsed: number;
  coveragePct: number;
}
export interface StatsSnapshot {
  file: FileCoverage | null;
  workspace: WorkspaceCoverage | null;
  wsStale: boolean;
  // Tells the renderer which "no data" affordance to show for the
  // WS segment: disabled → "—" (suppressed), manual → "?" (click
  // to compute), automatic → "—" (transient until next refresh).
  mode: WorkspaceStatsMode;
}

// Workspace-scope refresh debounce. The server already debounces
// `didChange` at ~400 ms before re-checking, and the diagnostic-change
// signal fires every time a fresh result is published — i.e. up to
// ~2.5×/s during active typing. Without a companion-side debounce on
// the workspace-scoped stats call, every keystroke session would
// re-aggregate the whole workset. Spec §8.3.3.
const WS_DEBOUNCE_MS = 2000;

/**
 * Drives the panel stats bar. Owns:
 *   - File-scope stats cache keyed by URI (refreshed live on diagnostic change).
 *   - Workspace-scope stats cache (refresh strategy depends on mode).
 *   - The `wsStale` flag that lets the panel render the WS segment in a
 *     muted foreground when the cached aggregate is out of date.
 *
 * Three modes for workspace stats, controlled by the
 * `dimfort.coverage.workspace_stats` setting:
 *
 *   - **disabled**: never request workspace data. WS segment shows "—".
 *   - **manual** *(default)*: request only when explicitly triggered
 *     (palette command or click on the WS segment). Marks workspace
 *     stale on every diagnostic-change signal but does not auto-fetch.
 *   - **automatic**: request on every diagnostic-change signal,
 *     2 s debounce. Bar updates live.
 *
 * File-scope is always live regardless of the mode setting; it's
 * cheap and the user always wants to know what their cursor is on.
 *
 * Fires `onDidChange` whenever any state shifts; the panel
 * subscribes and re-renders its footer.
 */
export class CoverageStatsProvider implements vscode.Disposable {
  private client: LanguageClient | undefined;
  private readonly fileStats = new Map<string, FileCoverage>();
  private workspace: WorkspaceCoverage | null = null;
  private wsStale = false;
  private mode: WorkspaceStatsMode = "manual";
  private wsDebounceTimer: NodeJS.Timeout | undefined;
  private wsRequestSeq = 0;
  private fileRequestSeq = new Map<string, number>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.mode = this.readModeFromConfig();
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(this.handleDiagChange.bind(this)),
      vscode.window.onDidChangeActiveTextEditor(() => {
        // Active editor changed: emit so the bar shows the new file's
        // numbers (or "—" if we haven't fetched them yet). Then fetch.
        this.emitter.fire();
        void this.refreshActiveFile();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("dimfort.coverage.workspace_stats")) {
          this.applyMode(this.readModeFromConfig());
        }
      }),
    );
  }

  setClient(client: LanguageClient | undefined): void {
    this.client = client;
    this.fileStats.clear();
    this.workspace = null;
    this.wsStale = false;
    this.emitter.fire();
    if (client) {
      // File-scope is always live; fetch on connect so the bar
      // populates without waiting for the first edit.
      void this.refreshActiveFile();
      // Workspace-scope: kick off only in automatic mode. Manual
      // and disabled wait for explicit user action (or never).
      if (this.mode === "automatic") {
        this.scheduleWorkspaceRefresh();
      }
    }
  }

  snapshot(uri: string | undefined): StatsSnapshot {
    return {
      file: uri ? this.fileStats.get(uri) ?? null : null,
      workspace: this.workspace,
      wsStale: this.wsStale,
      mode: this.mode,
    };
  }

  /**
   * Trigger an immediate workspace-scope refresh, bypassing the
   * mode setting. Called from the palette command + WS-segment
   * click handler. In `disabled` mode this still respects the
   * user's opt-out and no-ops.
   */
  forceWorkspaceRefresh(): void {
    if (this.mode === "disabled") return;
    void this.refreshWorkspace(/* force */ true);
  }

  private readModeFromConfig(): WorkspaceStatsMode {
    const raw = vscode.workspace
      .getConfiguration("dimfort")
      .get<string>("coverage.workspace_stats", "manual");
    if (raw === "disabled" || raw === "manual" || raw === "automatic") {
      return raw;
    }
    return "manual";
  }

  private applyMode(next: WorkspaceStatsMode): void {
    if (next === this.mode) return;
    const previous = this.mode;
    this.mode = next;
    if (next === "disabled") {
      // Clear any in-flight refresh timer; suppress the WS segment.
      if (this.wsDebounceTimer) {
        clearTimeout(this.wsDebounceTimer);
        this.wsDebounceTimer = undefined;
      }
      this.workspace = null;
      this.wsStale = false;
    } else if (next === "automatic" && previous !== "automatic") {
      // Just turned on live updates — kick off a refresh so the
      // user sees data without waiting for the next edit.
      this.scheduleWorkspaceRefresh();
    }
    // Manual mode: leave existing workspace data in place; user
    // controls when to refresh via command / click.
    this.emitter.fire();
  }

  private handleDiagChange(event: vscode.DiagnosticChangeEvent): void {
    // File-scope: refresh stats for affected URIs we care about (active
    // editor first; cached entries for other URIs are dropped so the
    // next request for them refetches).
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    let activeAffected = false;
    for (const uri of event.uris) {
      const s = uri.toString();
      if (s === active) {
        activeAffected = true;
      } else if (this.fileStats.has(s)) {
        this.fileStats.delete(s);
      }
    }
    if (activeAffected && active) {
      void this.refreshFile(active);
    }
    // Workspace-scope:
    //   - disabled: no-op.
    //   - manual: mark stale so the bar shows the cached value as
    //     dim, but don't auto-fetch — the user controls when.
    //   - automatic: mark stale + schedule a debounced refetch.
    if (this.mode === "disabled") {
      return;
    }
    this.wsStale = true;
    if (this.mode === "automatic") {
      this.scheduleWorkspaceRefresh();
    }
    this.emitter.fire();
  }

  private async refreshActiveFile(): Promise<void> {
    const active = vscode.window.activeTextEditor;
    if (!active || active.document.languageId !== "fortran") return;
    await this.refreshFile(active.document.uri.toString());
  }

  private async refreshFile(uri: string): Promise<void> {
    if (!this.client) return;
    const seq = (this.fileRequestSeq.get(uri) ?? 0) + 1;
    this.fileRequestSeq.set(uri, seq);
    let resp: StatsResponse;
    try {
      resp = await this.client.sendRequest<StatsResponse>(
        "dimfort/coverageStats",
        { uri },
      );
    } catch {
      return;
    }
    // Drop stale responses: a later request for the same URI may have
    // started while this one was in flight.
    if ((this.fileRequestSeq.get(uri) ?? 0) !== seq) return;
    if (resp.files.length === 0) {
      this.fileStats.delete(uri);
    } else {
      const r = resp.files[0];
      this.fileStats.set(uri, {
        ok: r.ok, warn: r.warn, fire: r.fire, unparsed: r.unparsed,
        coveragePct: r.coverage_pct,
      });
    }
    this.emitter.fire();
  }

  private scheduleWorkspaceRefresh(): void {
    if (this.wsDebounceTimer) clearTimeout(this.wsDebounceTimer);
    this.wsDebounceTimer = setTimeout(() => {
      this.wsDebounceTimer = undefined;
      void this.refreshWorkspace();
    }, WS_DEBOUNCE_MS);
  }

  private async refreshWorkspace(force = false): Promise<void> {
    if (!this.client) return;
    if (this.mode === "disabled") return;
    const seq = ++this.wsRequestSeq;
    let resp: StatsResponse;
    try {
      resp = await this.client.sendRequest<StatsResponse>(
        "dimfort/coverageStats",
        force ? { force_refresh: true } : {},
      );
    } catch {
      return;
    }
    if (seq !== this.wsRequestSeq) return;
    this.workspace = {
      ok: resp.total.ok, warn: resp.total.warn, fire: resp.total.fire,
      unparsed: resp.total.unparsed, coveragePct: resp.total.coverage_pct,
    };
    // Trust the server's stale flag when present (post-0.2.4 servers);
    // older servers omit the field, so default to false on absence.
    this.wsStale = resp.ws_stale ?? false;
    this.emitter.fire();
  }

  dispose(): void {
    if (this.wsDebounceTimer) clearTimeout(this.wsDebounceTimer);
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
