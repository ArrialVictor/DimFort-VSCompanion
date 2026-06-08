import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

// Wire-format mirror of the server's dimfort/coverageStats response.
// File-scope is served live by the read-only stats endpoint;
// workspace-scope is populated only by the explicit
// `dimfort.checkWorkspace` command (see
// `DimFort/docs/design/future/coverage-visualization.md` §13.2).
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
}

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
  // ``workspace`` is null until the user runs the refresh command for
  // the first time. Render as "–" in that case.
  workspace: WorkspaceCoverage | null;
  // True when at least one file's diagnostics changed since the last
  // successful workspace refresh. Panel renders the WS numbers dimmed
  // so the user knows they may not reflect the current state.
  wsStale: boolean;
  // True while a workspace refresh request is in flight. Panel can
  // show a "computing..." indicator and dim the panel for the duration.
  wsRefreshing: boolean;
}

/**
 * Drives the panel stats bar. Owns:
 *   - File-scope stats cache keyed by URI (refreshed live on diagnostic change).
 *   - Workspace-scope stats cache (populated only by explicit refresh).
 *   - The ``wsStale`` flag that marks the workspace numbers as
 *     "may no longer reflect current state" after edits.
 *   - The ``wsRefreshing`` flag that drives the in-progress UI.
 *
 * Workspace stats are *manual-only* — the auto-refresh machinery the
 * 0.2.4 bar shipped with proved to be the wrong UX at scale and was
 * gutted in 0.2.5. The user triggers refreshes explicitly via the
 * "DimFort: Refresh Workspace Coverage" command.
 *
 * Fires ``onDidChange`` whenever any state shifts; the panel
 * subscribes and re-renders its footer.
 */
export class CoverageStatsProvider implements vscode.Disposable {
  private client: LanguageClient | undefined;
  private readonly fileStats = new Map<string, FileCoverage>();
  private workspace: WorkspaceCoverage | null = null;
  private wsStale = false;
  private wsRefreshing = false;
  private fileRequestSeq = new Map<string, number>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(this.handleDiagChange.bind(this)),
      vscode.window.onDidChangeActiveTextEditor(() => {
        // Active editor changed: emit so the bar shows the new file's
        // numbers (or "–" if we haven't fetched them yet). Then fetch.
        this.emitter.fire();
        void this.refreshActiveFile();
      }),
    );
  }

  setClient(client: LanguageClient | undefined): void {
    this.client = client;
    this.fileStats.clear();
    this.workspace = null;
    this.wsStale = false;
    this.wsRefreshing = false;
    this.emitter.fire();
    if (client) {
      // File-scope is always live; fetch on connect so the bar
      // populates without waiting for the first edit. Workspace-scope
      // is intentionally not fetched — it waits for the user's
      // explicit refresh command.
      void this.refreshActiveFile();
      // Async workspace check (server 0.2.5+): the executeCommand
      // returns an ack immediately and the actual coverage payload
      // arrives later via this notification. The handler updates the
      // workspace snapshot and clears the in-flight flag.
      this.disposables.push(
        client.onNotification(
          "dimfort/workspaceCheckCompleted",
          (params: StatsResponse | { failed: true }) => {
            this.handleWorkspaceCheckCompleted(params);
          },
        ),
      );
    }
  }

  private handleWorkspaceCheckCompleted(
    params: StatsResponse | { failed: true },
  ): void {
    this.wsRefreshing = false;
    if ("failed" in params) {
      // Server-side worker crashed or no workspace index. Keep the
      // prior payload visible (just unstick the spinner).
      this.emitter.fire();
      return;
    }
    this.workspace = {
      ok: params.total.ok,
      warn: params.total.warn,
      fire: params.total.fire,
      unparsed: params.total.unparsed,
      coveragePct: params.total.coverage_pct,
    };
    this.wsStale = false;
    this.emitter.fire();
  }

  snapshot(uri: string | undefined): StatsSnapshot {
    return {
      file: uri ? this.fileStats.get(uri) ?? null : null,
      workspace: this.workspace,
      wsStale: this.wsStale,
      wsRefreshing: this.wsRefreshing,
    };
  }

  /**
   * Trigger a workspace coverage refresh.
   *
   * Sends ``workspace/executeCommand`` with the server-side command
   * id ``dimfort.checkWorkspace``. Since DimFort 0.2.5, the server
   * spawns a daemon worker and the executeCommand returns an ack
   * immediately. The fresh aggregate arrives later via
   * ``dimfort/workspaceCheckCompleted`` (see
   * ``handleWorkspaceCheckCompleted``).
   *
   * Called from the palette command. Bar click is intentionally NOT
   * wired to this; the bar is purely a display surface.
   */
  async refreshWorkspace(): Promise<void> {
    if (!this.client) return;
    if (this.wsRefreshing) return;  // already in flight
    this.wsRefreshing = true;
    this.emitter.fire();
    let ack: { started: boolean; reason?: string } | null = null;
    try {
      ack = await this.client.sendRequest<{ started: boolean; reason?: string }>(
        "workspace/executeCommand",
        {
          command: "dimfort.checkWorkspace",
          arguments: [],
        },
      );
    } catch {
      // Swallow LSP errors silently — the bar staying on its old
      // state is better UX than a popup.
    }
    if (!ack || !ack.started) {
      // Server refused to start (already in flight, or no index).
      // Clear the spinner; nothing further to wait for.
      this.wsRefreshing = false;
      this.emitter.fire();
    }
    // ``wsRefreshing`` stays true until the
    // ``dimfort/workspaceCheckCompleted`` notification arrives and
    // ``handleWorkspaceCheckCompleted`` clears it.
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
    // Workspace-scope: only mark stale once we've ever had a workspace
    // snapshot. Pre-first-refresh, the WS segment shows "–" anyway —
    // setting wsStale wouldn't change the render.
    if (this.workspace !== null && !this.wsStale) {
      this.wsStale = true;
      this.emitter.fire();
    }
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

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
